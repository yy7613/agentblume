import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AesGcmSecretCipher } from '../security/aes-gcm-secret-cipher';
import { createMcpServerConfig } from '../../domain/mcp/mcp-server';
import { InMemoryMcpServerRepository } from './in-memory-mcp-server-repository';
import { mcpServerRepositoryContract } from './mcp-server-repository.contract';
import { openSqliteDatabase, type SqliteDatabase, type SqliteDatabaseSource } from './sqlite-database';
import { SqliteMcpServerRepository } from './sqlite-mcp-server-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

/** 鍵ファイルを作らない揮発鍵を使う（テストが利用者のホームを汚さない）。 */
function sqliteRepo(source: SqliteDatabaseSource = ':memory:'): SqliteMcpServerRepository {
  return new SqliteMcpServerRepository(source, AesGcmSecretCipher.ephemeral());
}

function storedJson(database: SqliteDatabase, name: string): string {
  return String(database.handle.prepare(`SELECT config_json FROM mcp_servers WHERE name=?`).get(name)!['config_json']);
}

describe.each([
  ['in-memory', () => ({ repo: new InMemoryMcpServerRepository(), close: () => {} })],
  ['sqlite', () => { const repo = sqliteRepo(); return { repo, close: () => repo.close() }; }],
])('%s MCP server repository', (_name, make) => {
  it('共有契約を満たす', async () => {
    const { repo, close } = make();
    try { await mcpServerRepositoryContract(repo); } finally { close(); }
  });
});

describe('SqliteMcpServerRepository', () => {
  it('replaceAll が失敗したら既存設定を巻き戻す（部分適用しない）', async () => {
    const repo = sqliteRepo();
    try {
      const keep = createMcpServerConfig({ scope, name: 'keep', transport: { kind: 'stdio', command: 'node', args: [], env: {} }, updatedAt: '2026-07-26T00:00:00.000Z' });
      await repo.save(keep);

      // 直列化不能な値を仕込んで挿入途中で失敗させる（JSON.stringify が投げる）。
      const broken = { ...keep, name: 'broken', updatedAt: 0n as unknown as string };
      await expect(repo.replaceAll(scope, [broken])).rejects.toThrow();

      expect((await repo.list(scope)).map((item) => item.name)).toEqual(['keep']);
    } finally { repo.close(); }
  });

  describe('秘密値の封緘', () => {
    it('DBファイルの生バイトに env / headers の平文が現れない', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agentblume-mcp-'));
      const path = join(directory, 'test.db');
      const database = openSqliteDatabase(path);
      const repo = sqliteRepo(database);
      try {
        await repo.save(createMcpServerConfig({
          scope, name: 'github', updatedAt: '2026-07-28T00:00:00.000Z',
          transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { GITHUB_TOKEN: 'ghp_plaintextsecretvalue' } },
        }));
        await repo.save(createMcpServerConfig({
          scope, name: 'remote', updatedAt: '2026-07-28T00:00:00.000Z',
          transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer plaintextbearervalue' } },
        }));
        // 未チェックポイントのWALに平文が残っていないかも見たいので、閉じてから生バイトを読む。
        database.close();

        const bytes = readFileSync(path).toString('latin1');
        expect(bytes).not.toContain('ghp_plaintextsecretvalue');
        expect(bytes).not.toContain('plaintextbearervalue');
        // 秘密でないもの（キー名）は読める＝列ごと暗号化したのではなく値だけを封緘している。
        expect(bytes).toContain('GITHUB_TOKEN');
        expect(bytes).toContain('aes-256-gcm');
      } finally {
        try { database.close(); } catch { /* 二重closeは無視 */ }
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('封緘した値は開封して往復する', async () => {
      const repo = sqliteRepo();
      try {
        const config = createMcpServerConfig({
          scope, name: 'github', updatedAt: '2026-07-28T00:00:00.000Z',
          transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: 'ghp_secret', LOG: 'debug' } },
        });
        await repo.save(config);
        expect(await repo.find(scope, 'github')).toEqual(config);
      } finally { repo.close(); }
    });

    it('v36以前に平文で保存された行は読めて、次の保存で封緘される（マイグレーション不要）', async () => {
      const database = openSqliteDatabase();
      const repo = sqliteRepo(database);
      try {
        // 旧形式（値が素の文字列）を直接書き込む。
        const legacy = {
          scope, name: 'legacy', disabled: false, updatedAt: '2026-07-01T00:00:00.000Z',
          transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'legacy-plaintext' } },
        };
        database.handle.prepare(`INSERT INTO mcp_servers (tenant_id, workspace_id, name, updated_at, config_json) VALUES (?, ?, ?, ?, ?)`)
          .run(scope.tenantId, scope.workspaceId, 'legacy', legacy.updatedAt, JSON.stringify(legacy));

        const loaded = await repo.find(scope, 'legacy');
        expect(loaded?.transport).toMatchObject({ env: { TOKEN: 'legacy-plaintext' } });
        expect(storedJson(database, 'legacy')).toContain('legacy-plaintext');

        // 読めたものをそのまま保存し直すと封緘される。
        await repo.save(loaded!);
        expect(storedJson(database, 'legacy')).not.toContain('legacy-plaintext');
        expect(storedJson(database, 'legacy')).toContain('aes-256-gcm');
        expect((await repo.find(scope, 'legacy'))?.transport).toMatchObject({ env: { TOKEN: 'legacy-plaintext' } });
      } finally { database.close(); }
    });

    describe('resealLegacySecrets（起動時の一括封緘）', () => {
      /** 旧形式（値が素の文字列）の行を直接書き込む。 */
      function seedLegacy(database: SqliteDatabase, name: string, transport: unknown): void {
        const row = { scope, name, disabled: false, updatedAt: '2026-07-01T00:00:00.000Z', transport };
        database.handle.prepare(`INSERT INTO mcp_servers (tenant_id, workspace_id, name, updated_at, config_json) VALUES (?, ?, ?, ?, ?)`)
          .run(scope.tenantId, scope.workspaceId, name, row.updatedAt, JSON.stringify(row));
      }

      it('編集されていない平文の行も封緘し、値は保たれる', async () => {
        const database = openSqliteDatabase();
        const repo = sqliteRepo(database);
        try {
          seedLegacy(database, 'a', { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'plain-a' } });
          seedLegacy(database, 'b', { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer plain-b' } });

          expect(await repo.resealLegacySecrets()).toBe(2);
          expect(storedJson(database, 'a')).not.toContain('plain-a');
          expect(storedJson(database, 'b')).not.toContain('plain-b');
          expect((await repo.find(scope, 'a'))?.transport).toMatchObject({ env: { TOKEN: 'plain-a' } });
          expect((await repo.find(scope, 'b'))?.transport).toMatchObject({ headers: { Authorization: 'Bearer plain-b' } });
        } finally { database.close(); }
      });

      it('べき等（封緘済みの行は触らない）', async () => {
        const database = openSqliteDatabase();
        const repo = sqliteRepo(database);
        try {
          seedLegacy(database, 'a', { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'plain-a' } });
          expect(await repo.resealLegacySecrets()).toBe(1);
          const after = storedJson(database, 'a');
          expect(await repo.resealLegacySecrets()).toBe(0);
          // IVは毎回変わるので、再封緘されていれば本文も変わる＝変わらないことが「触っていない」証拠。
          expect(storedJson(database, 'a')).toBe(after);
        } finally { database.close(); }
      });

      it('秘密を持たない行と壊れた行があっても止まらない', async () => {
        const database = openSqliteDatabase();
        const repo = sqliteRepo(database);
        try {
          seedLegacy(database, 'noenv', { kind: 'stdio', command: 'node', args: [], env: {} });
          database.handle.prepare(`INSERT INTO mcp_servers (tenant_id, workspace_id, name, updated_at, config_json) VALUES (?, ?, ?, ?, ?)`)
            .run(scope.tenantId, scope.workspaceId, 'broken', '2026-07-01T00:00:00.000Z', 'not json');
          seedLegacy(database, 'zz', { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'plain-z' } });

          expect(await repo.resealLegacySecrets()).toBe(1);
          expect(storedJson(database, 'zz')).not.toContain('plain-z');
        } finally { database.close(); }
      });
    });
  });
});

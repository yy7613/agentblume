/**
 * 監査ログ台帳の契約テスト（InMemory と SQLite が同じ振る舞いをする）。
 *
 * スコープ境界・並び順（新しい順）・フィルタ・保持期限の削除を両実装で確かめる。
 * 並び順は「拒否 → 再試行 → 成功」を後から読むために効くので、同一時刻でも崩れないことを見る。
 */
import { describe, expect, it } from 'vitest';
import type { AuditSink } from '../../application/security/audit';
import { createAuditEntry, type AuditLogRepository } from '../../domain/security/audit';
import { InMemoryAuditLogRepository } from './in-memory-audit-log-repository';
import { SqliteAuditLogRepository } from './sqlite-audit-log-repository';

const scope = { tenantId: 'acme', workspaceId: 'ops' };
const other = { tenantId: 'globex', workspaceId: 'main' };

type Repo = AuditLogRepository & AuditSink;

async function seed(repo: Repo): Promise<void> {
  await repo.record(createAuditEntry({ at: '2026-07-01T00:00:00.000Z', subject: 'alice', scope, action: 'delete', resource: { kind: 'tool', id: 'scores' }, outcome: 'denied', detail: { reason: 'nope' } }));
  await repo.record(createAuditEntry({ at: '2026-07-02T00:00:00.000Z', subject: 'bob', scope, action: 'approve', resource: { kind: 'promotion', id: 'p1' }, outcome: 'succeeded' }));
  await repo.record(createAuditEntry({ at: '2026-07-03T00:00:00.000Z', subject: 'alice', scope, action: 'operate', resource: { kind: 'workspace' }, outcome: 'succeeded' }));
  // 別テナントの行は一切見えてはいけない。
  await repo.record(createAuditEntry({ at: '2026-07-03T00:00:00.000Z', subject: 'mallory', scope: other, action: 'delete', resource: { kind: 'tool', id: 'theirs' }, outcome: 'succeeded' }));
}

function contract(name: string, create: () => Repo): void {
  describe(name, () => {
    it('新しい順に返し、他テナントは混ざらない', async () => {
      const repo = create();
      await seed(repo);
      const entries = await repo.list(scope);
      expect(entries.map((entry) => entry.at)).toEqual(['2026-07-03T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
      expect(entries.some((entry) => entry.subject === 'mallory')).toBe(false);
      expect(await repo.list(other)).toHaveLength(1);
    });

    it('同一時刻でも記録した順が保たれる（後から書いたものが先頭）', async () => {
      const repo = create();
      for (const subject of ['first', 'second', 'third']) {
        await repo.record(createAuditEntry({ at: '2026-07-05T00:00:00.000Z', subject, scope, action: 'read', resource: { kind: 'tool' }, outcome: 'succeeded' }));
      }
      expect((await repo.list(scope)).map((entry) => entry.subject)).toEqual(['third', 'second', 'first']);
    });

    it('subject / action / outcome / resourceKind / 期間 / 件数で絞れる', async () => {
      const repo = create();
      await seed(repo);
      expect((await repo.list(scope, { subject: 'alice' })).map((entry) => entry.action)).toEqual(['operate', 'delete']);
      expect(await repo.list(scope, { action: 'approve' })).toHaveLength(1);
      expect(await repo.list(scope, { outcome: 'denied' })).toHaveLength(1);
      expect(await repo.list(scope, { resourceKind: 'promotion' })).toHaveLength(1);
      expect((await repo.list(scope, { from: '2026-07-02T00:00:00.000Z' })).map((entry) => entry.subject)).toEqual(['alice', 'bob']);
      expect((await repo.list(scope, { to: '2026-07-01T23:59:59.999Z' })).map((entry) => entry.subject)).toEqual(['alice']);
      expect(await repo.list(scope, { limit: 2 })).toHaveLength(2);
    });

    it('detail を含めて往復する', async () => {
      const repo = create();
      await seed(repo);
      const denied = (await repo.list(scope, { outcome: 'denied' }))[0];
      expect(denied?.detail).toEqual({ reason: 'nope' });
    });

    it('保持期限で古い行だけ消え、他テナントには触らない', async () => {
      const repo = create();
      await seed(repo);
      expect(await repo.deleteBefore(scope, '2026-07-02T00:00:00.000Z')).toBe(2);
      expect((await repo.list(scope)).map((entry) => entry.at)).toEqual(['2026-07-03T00:00:00.000Z']);
      expect(await repo.list(other)).toHaveLength(1);
      expect(await repo.deleteBefore(scope, '2020-01-01T00:00:00.000Z')).toBe(0);
    });
  });
}

contract('InMemoryAuditLogRepository', () => new InMemoryAuditLogRepository());
contract('SqliteAuditLogRepository', () => new SqliteAuditLogRepository(':memory:'));

/**
 * **ソースに生のNULバイトを埋めない**という回帰。
 *
 * `in-memory-audit-log-repository.ts` のスコープ鍵の区切りが U+0000 そのもので書かれていた。
 * gitはNULを含むファイルをバイナリと判定するため、`git diff` も `git show` も中身を出さず、
 * **このファイルの変更が静かにレビューの対象外になっていた**（挙動には現れないので気づけない）。
 * 意図（テナントIDに現れない文字で区切る）はエスケープ表記で同じように書ける。
 */
describe('ソースの健全性', () => {
  it('src 配下のTypeScriptに生のNULバイトが無い（gitがバイナリ扱いしない）', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if ((await readFile(path, 'utf8')).includes(String.fromCharCode(0))) offenders.push(path);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});

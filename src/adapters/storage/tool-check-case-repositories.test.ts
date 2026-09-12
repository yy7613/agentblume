import { describe, expect, it } from 'vitest';
import { ToolCheckValidationError } from '../../domain/tool-check/errors';
import { InMemoryToolCheckCaseRepository } from './in-memory-tool-check-case-repository';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteToolCheckCaseRepository } from './sqlite-tool-check-case-repository';
import { toolCheckCaseRepositoryContract } from './tool-check-case-repository.contract';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe.each([
  ['in-memory', () => ({ repo: new InMemoryToolCheckCaseRepository(), close: () => {} })],
  ['sqlite', () => { const repo = new SqliteToolCheckCaseRepository(); return { repo, close: () => repo.close() }; }],
])('%s tool check case repository', (_name, make) => {
  it('共有契約を満たす（保存・上書き・並び・絞り込み・スコープ分離・削除）', async () => {
    const { repo, close } = make();
    try { await toolCheckCaseRepositoryContract(repo); } finally { close(); }
  });
});

describe('SqliteToolCheckCaseRepository', () => {
  it('共有ハンドルで開いたDBの tool_check_cases テーブルへ書き、列（tool_id / updated_at）を絞り込み用に出す', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteToolCheckCaseRepository(database);
    try {
      await repo.save({ scope, id: 'c1', toolId: 'sales', name: 'n', arguments: {}, expectations: {}, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T03:00:00.000Z' });
      const row = database.handle.prepare(`SELECT tool_id, updated_at FROM tool_check_cases WHERE id=?`).get('c1');
      expect(row).toMatchObject({ tool_id: 'sales', updated_at: '2026-09-12T03:00:00.000Z' });
    } finally { database.close(); }
  });

  it('境界: 同じ id を別ワークスペースへ保存しても衝突せず、それぞれのスコープで読める（複合主キー）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteToolCheckCaseRepository(database);
    try {
      const base = { id: 'shared', toolId: 'sales', name: 'n', arguments: {}, expectations: {}, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' };
      await repo.save({ ...base, scope });
      await repo.save({ ...base, scope: { tenantId: 'tenant', workspaceId: 'other' }, name: 'other' });
      expect((await repo.find(scope, 'shared'))?.name).toBe('n');
      expect((await repo.find({ tenantId: 'tenant', workspaceId: 'other' }, 'shared'))?.name).toBe('other');
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM tool_check_cases`).get()).toMatchObject({ n: 2 });
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json は読み出し時に ToolCheckValidationError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteToolCheckCaseRepository(database);
    try {
      database.handle.prepare(`INSERT INTO tool_check_cases (tenant_id, workspace_id, id, tool_id, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'sales', '2026-09-12T00:00:00.000Z', JSON.stringify({ id: 'broken' }));
      await expect(repo.find(scope, 'broken')).rejects.toThrow(ToolCheckValidationError);
      await expect(repo.list(scope)).rejects.toThrow(ToolCheckValidationError);
    } finally { database.close(); }
  });
});

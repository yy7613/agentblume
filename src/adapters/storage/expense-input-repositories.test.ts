/**
 * 経費精算の規程のヒアリングのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `expense-input-repository.contract.ts`。ここでは SQLite にしか無い性質（一覧用の列・壊れた行の扱い）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { expensePolicyHearingRepositoryContract } from './expense-input-repository.contract';
import { fixtureHearings, scope, V9_AT } from './expense-v9.fixtures';
import { InMemoryExpensePolicyHearingRepository } from './in-memory-expense-input-repositories';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteExpensePolicyHearingRepository } from './sqlite-expense-input-repositories';

describe('規程のヒアリングのリポジトリ', () => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await expensePolicyHearingRepositoryContract(new InMemoryExpensePolicyHearingRepository());
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = new SqliteExpensePolicyHearingRepository();
    try { await expensePolicyHearingRepositoryContract(repo); } finally { repo.close(); }
  });
});

describe('SQLite 固有の性質（ヒアリング）', () => {
  it('一覧用の列（状態・作成・更新日時）を出す', async () => {
    const database = openSqliteDatabase();
    const hearings = new SqliteExpensePolicyHearingRepository(database);
    try {
      for (const hearing of fixtureHearings()) await hearings.save(hearing);
      expect(database.handle.prepare(`SELECT id, status, created_at, updated_at FROM expense_policy_hearings ORDER BY id`).all()).toEqual([
        { id: 'hearing-open', status: 'open', created_at: V9_AT, updated_at: V9_AT },
        { id: 'hearing-proposed', status: 'proposed', created_at: V9_AT, updated_at: '2026-09-15T02:00:00.000Z' },
      ]);
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json（形が違う・JSON でない）は読み出し時に ExpenseDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const hearings = new SqliteExpensePolicyHearingRepository(database);
    try {
      const insert = database.handle.prepare(`INSERT INTO expense_policy_hearings (tenant_id, workspace_id, id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      insert.run(scope.tenantId, scope.workspaceId, 'broken', 'open', V9_AT, V9_AT, JSON.stringify({ id: 'broken' }));
      insert.run(scope.tenantId, scope.workspaceId, 'not-json', 'cancelled', V9_AT, V9_AT, 'not json');
      await expect(hearings.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(hearings.findById(scope, 'not-json')).rejects.toThrow('record_json is not valid JSON');
      await expect(hearings.list(scope, { status: 'open', limit: 10 })).rejects.toThrow(ExpenseDomainError);
    } finally { database.close(); }
  });
});

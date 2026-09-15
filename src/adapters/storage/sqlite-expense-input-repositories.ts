/**
 * adapters層: 経費精算の規程のヒアリング（docs/21 §20.2.11 / §20.8。UC9）の SQLite 永続化（テーブルは `expense-v9-migrations.ts`）。
 *
 * 本体は `record_json`（文書モードの原文 50,000 字まで含む）で、一覧の絞り込みと並びに使う状態・更新日時だけを列へ出す。
 * 並び順は `domain/expense/repositories.ts` の doc コメントが正本で、InMemory 実装と同じ結果になる（共有契約テスト）。
 */
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpensePolicyHearing, HearingStatus } from '../../domain/expense/policy-hearing';
import type { ExpensePolicyHearingRepository } from '../../domain/expense/repositories';
import { deserializeExpensePolicyHearing, serializeExpensePolicyHearing } from '../../domain/expense/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function parse(value: unknown): ExpensePolicyHearing {
  let raw: unknown;
  try { raw = JSON.parse(String(value)); } catch { throw new ExpenseDomainError('expense policy hearing: record_json is not valid JSON'); }
  return deserializeExpensePolicyHearing(raw);
}

export class SqliteExpensePolicyHearingRepository extends SqliteRepositoryBase implements ExpensePolicyHearingRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(hearing: ExpensePolicyHearing): Promise<void> {
    this.db.prepare(
      `INSERT INTO expense_policy_hearings (tenant_id, workspace_id, id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at, record_json=excluded.record_json`,
    ).run(hearing.tenant.tenantId, hearing.tenant.workspaceId, hearing.id, hearing.status, hearing.createdAt, hearing.updatedAt, JSON.stringify(serializeExpensePolicyHearing(hearing)));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpensePolicyHearing | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_policy_hearings WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json']);
  }

  async list(scope: TenantScope, options?: { readonly status?: HearingStatus; readonly limit?: number }): Promise<readonly ExpensePolicyHearing[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    let sql = `SELECT record_json FROM expense_policy_hearings WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json']));
  }
}

/**
 * adapters層: 経費精算のワークスペースに 1 つの設定（組織・振込元・カード・運賃。docs/21 §20.8）の SQLite 永続化。
 *
 * `expense_settings` の kind ごとに 1 行。版を増やさずに設定の種類を足せるよう 1 表にまとめている（`domain/expense/settings.ts`）。
 * 未保存なら null（既定値を返して `saved: false` を付けるのは application の `settings-store.ts`。ここで勝手に作らない）。
 * 復元は `deserializeExpenseSettings` を通し、壊れた行は `ExpenseDomainError` にする。
 */
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseSettingsRepository } from '../../domain/expense/repositories';
import { deserializeExpenseSettings, serializeExpenseSettings } from '../../domain/expense/serialization';
import { isExpenseSettingsKind, type ExpenseSettingsKind, type ExpenseSettingsOf } from '../../domain/expense/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

/** 型の外から来た kind（API の値など）を表へ書く前に止める。 */
export function assertExpenseSettingsKind(kind: unknown): asserts kind is ExpenseSettingsKind {
  if (!isExpenseSettingsKind(kind)) throw new ExpenseDomainError(`expense settings: unknown kind: ${String(kind)}`);
}

export class SqliteExpenseSettingsRepository extends SqliteRepositoryBase implements ExpenseSettingsRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async get<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K): Promise<ExpenseSettingsOf<K> | null> {
    assertExpenseSettingsKind(kind);
    const row = this.db.prepare(`SELECT record_json FROM expense_settings WHERE tenant_id=? AND workspace_id=? AND kind=?`).get(scope.tenantId, scope.workspaceId, kind);
    if (row === undefined) return null;
    let raw: unknown;
    try { raw = JSON.parse(String(row['record_json'])); } catch { throw new ExpenseDomainError(`expense settings (${kind}): record_json is not valid JSON`); }
    return deserializeExpenseSettings(kind, raw);
  }

  async save<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K, value: ExpenseSettingsOf<K>): Promise<void> {
    assertExpenseSettingsKind(kind);
    this.db.prepare(
      `INSERT INTO expense_settings (tenant_id, workspace_id, kind, updated_at, record_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, kind) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json`,
    ).run(scope.tenantId, scope.workspaceId, kind, value.updatedAt, JSON.stringify(serializeExpenseSettings(kind, value)));
  }
}

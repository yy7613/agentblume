/**
 * adapters層: 経費精算のワークスペースに 1 つの設定の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 保存も読み出しも `structuredClone` する（SQLite 実装は JSON を経由するので挙動を揃える）。未知の kind は SQLite と同じく拒否する。
 */
import type { ExpenseSettingsRepository } from '../../domain/expense/repositories';
import type { ExpenseSettingsKind, ExpenseSettingsOf } from '../../domain/expense/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { assertExpenseSettingsKind } from './sqlite-expense-settings-repository';

function key(scope: TenantScope, kind: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${kind}`; }

export class InMemoryExpenseSettingsRepository implements ExpenseSettingsRepository {
  private readonly store = new Map<string, unknown>();

  async get<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K): Promise<ExpenseSettingsOf<K> | null> {
    assertExpenseSettingsKind(kind);
    const value = this.store.get(key(scope, kind));
    return value === undefined ? null : structuredClone(value) as ExpenseSettingsOf<K>;
  }

  async save<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K, value: ExpenseSettingsOf<K>): Promise<void> {
    assertExpenseSettingsKind(kind);
    this.store.set(key(scope, kind), structuredClone(value));
  }
}

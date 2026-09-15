/**
 * adapters層: 経費精算の規程のヒアリングの InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 保存も読み出しも `structuredClone` する（SQLite 実装は JSON を経由するので挙動を揃える）。並びは SQLite の ORDER BY と同じ。
 */
import type { ExpensePolicyHearing, HearingStatus } from '../../domain/expense/policy-hearing';
import type { ExpensePolicyHearingRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class InMemoryExpensePolicyHearingRepository implements ExpensePolicyHearingRepository {
  private readonly store = new Map<string, ExpensePolicyHearing>();

  async save(hearing: ExpensePolicyHearing): Promise<void> {
    this.store.set(key(hearing.tenant, hearing.id), structuredClone(hearing));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpensePolicyHearing | null> {
    const hearing = this.store.get(key(scope, id));
    return hearing === undefined ? null : structuredClone(hearing);
  }

  async list(scope: TenantScope, options?: { readonly status?: HearingStatus; readonly limit?: number }): Promise<readonly ExpensePolicyHearing[]> {
    const matched = [...this.store.values()]
      .filter((hearing) => hearing.tenant.tenantId === scope.tenantId && hearing.tenant.workspaceId === scope.workspaceId
        && (options?.status === undefined || hearing.status === options.status))
      // updatedAt 降順 → id 昇順。
      .sort((left, right) => compareText(right.updatedAt, left.updatedAt) || compareText(left.id, right.id));
    const limited = options?.limit === undefined ? matched : matched.slice(0, options.limit);
    return limited.map((hearing) => structuredClone(hearing));
  }
}

import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ToolCheckCase } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckCaseListOptions, ToolCheckCaseRepository } from '../../domain/tool-check/tool-check-case-repository';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }
function inScope(item: ToolCheckCase, scope: TenantScope): boolean {
  return item.scope.tenantId === scope.tenantId && item.scope.workspaceId === scope.workspaceId;
}

/** 新しい定義が先（updatedAt 降順）。同時刻は id 昇順で安定させる（SQLite 実装と同じ順）。 */
export function compareToolCheckCases(left: ToolCheckCase, right: ToolCheckCase): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export class InMemoryToolCheckCaseRepository implements ToolCheckCaseRepository {
  private readonly store = new Map<string, ToolCheckCase>();

  async save(item: ToolCheckCase): Promise<void> {
    this.store.set(key(item.scope, item.id), structuredClone(item));
  }

  async find(scope: TenantScope, id: string): Promise<ToolCheckCase | null> {
    const item = this.store.get(key(scope, id));
    return item === undefined ? null : structuredClone(item);
  }

  async list(scope: TenantScope, options?: ToolCheckCaseListOptions): Promise<readonly ToolCheckCase[]> {
    return [...this.store.values()]
      .filter((item) => inScope(item, scope) && (options?.toolId === undefined || item.toolId === options.toolId))
      .sort(compareToolCheckCases)
      .map((item) => structuredClone(item));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }
}

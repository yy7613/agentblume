import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { DataSource } from '../../domain/data-source/data-source';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }

export class InMemoryDataSourceRepository implements DataSourceRepository {
  private readonly sources = new Map<string, DataSource>();
  private readonly contents = new Map<string, string>();

  async save(source: DataSource, fileContent?: string): Promise<void> {
    const entryKey = key(source.tenant, source.id);
    this.sources.set(entryKey, structuredClone(source));
    if (source.kind === 'file' && fileContent !== undefined) this.contents.set(entryKey, fileContent);
  }

  async list(scope: TenantScope): Promise<readonly DataSource[]> {
    return [...this.sources.values()]
      .filter((source) => source.tenant.tenantId === scope.tenantId && source.tenant.workspaceId === scope.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((source) => structuredClone(source));
  }

  async find(scope: TenantScope, id: string): Promise<DataSource | null> {
    const source = this.sources.get(key(scope, id));
    return source === undefined ? null : structuredClone(source);
  }

  async readFile(scope: TenantScope, id: string): Promise<{ readonly source: DataSource; readonly content: string } | null> {
    const entryKey = key(scope, id);
    const source = this.sources.get(entryKey);
    const content = this.contents.get(entryKey);
    if (source === undefined || source.kind !== 'file' || content === undefined) return null;
    return { source: structuredClone(source), content };
  }

  async delete(scope: TenantScope, id: string): Promise<void> {
    const entryKey = key(scope, id);
    this.sources.delete(entryKey);
    this.contents.delete(entryKey);
  }
}

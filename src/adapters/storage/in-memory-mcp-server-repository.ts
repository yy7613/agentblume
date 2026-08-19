import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';

function key(scope: TenantScope, name: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${name}`; }
function inScope(config: McpServerConfig, scope: TenantScope): boolean {
  return config.scope.tenantId === scope.tenantId && config.scope.workspaceId === scope.workspaceId;
}

export class InMemoryMcpServerRepository implements McpServerRepository {
  private readonly store = new Map<string, McpServerConfig>();

  async save(config: McpServerConfig): Promise<void> {
    this.store.set(key(config.scope, config.name), structuredClone(config));
  }

  async find(scope: TenantScope, name: string): Promise<McpServerConfig | null> {
    const config = this.store.get(key(scope, name));
    return config === undefined ? null : structuredClone(config);
  }

  async list(scope: TenantScope): Promise<readonly McpServerConfig[]> {
    return [...this.store.values()]
      .filter((config) => inScope(config, scope))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((config) => structuredClone(config));
  }

  async delete(scope: TenantScope, name: string): Promise<boolean> {
    return this.store.delete(key(scope, name));
  }

  async replaceAll(scope: TenantScope, configs: readonly McpServerConfig[]): Promise<void> {
    for (const [entryKey, config] of [...this.store.entries()]) {
      if (inScope(config, scope)) this.store.delete(entryKey);
    }
    for (const config of configs) this.store.set(key(config.scope, config.name), structuredClone(config));
  }
}

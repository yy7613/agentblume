import { DatabaseSync } from 'node:sqlite';
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { deserializeMcpServerConfig, serializeMcpServerConfig } from '../../domain/mcp/serialization';
import type { TenantScope } from '../../domain/tool/ids';

const SQL = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  updated_at TEXT NOT NULL, config_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, name)
);
`;

function fromJson(value: unknown): McpServerConfig { return deserializeMcpServerConfig(JSON.parse(String(value))); }

/** MCPサーバー設定のSQLite永続化。設定は版を持たず (scope, name) で upsert する。 */
export class SqliteMcpServerRepository implements McpServerRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(SQL); }
  close(): void { this.db.close(); }

  async save(config: McpServerConfig): Promise<void> { this.insert(config); }

  async find(scope: TenantScope, name: string): Promise<McpServerConfig | null> {
    const row = this.db.prepare(`SELECT config_json FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).get(scope.tenantId, scope.workspaceId, name);
    return row === undefined ? null : fromJson(row['config_json']);
  }

  async list(scope: TenantScope): Promise<readonly McpServerConfig[]> {
    return this.db.prepare(`SELECT config_json FROM mcp_servers WHERE tenant_id=? AND workspace_id=? ORDER BY name`)
      .all(scope.tenantId, scope.workspaceId)
      .map((row) => fromJson(row['config_json']));
  }

  async delete(scope: TenantScope, name: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).get(scope.tenantId, scope.workspaceId, name);
    if (existing === undefined) return false;
    this.db.prepare(`DELETE FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).run(scope.tenantId, scope.workspaceId, name);
    return true;
  }

  /** スコープ内を原子的に置き換える。途中で失敗しても設定が半端に消えないようトランザクションで囲う。 */
  async replaceAll(scope: TenantScope, configs: readonly McpServerConfig[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM mcp_servers WHERE tenant_id=? AND workspace_id=?`).run(scope.tenantId, scope.workspaceId);
      for (const config of configs) this.insert(config);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insert(config: McpServerConfig): void {
    this.db.prepare(
      `INSERT INTO mcp_servers (tenant_id, workspace_id, name, updated_at, config_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, name) DO UPDATE SET updated_at=excluded.updated_at, config_json=excluded.config_json`,
    ).run(config.scope.tenantId, config.scope.workspaceId, config.name, config.updatedAt, JSON.stringify(serializeMcpServerConfig(config)));
  }
}

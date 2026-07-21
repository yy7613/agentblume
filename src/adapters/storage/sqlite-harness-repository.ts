import { DatabaseSync } from 'node:sqlite';
import type { AgentHarness } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository, HarnessSummary } from '../../domain/harness/harness-repository';
import { HarnessVersionConflictError } from '../../domain/harness/errors';
import { deserializeAgentHarness, serializeAgentHarness } from '../../domain/harness/serialization';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_harnesses (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  );`;
function fromJson(value: unknown): AgentHarness { return deserializeAgentHarness(JSON.parse(String(value))); }

export class SqliteAgentHarnessRepository implements AgentHarnessRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(CREATE_TABLE);
    // 既存DB向けmigration: deleted列が無ければ追加する（論理削除, docs §10）。
    const columns = this.db.prepare(`PRAGMA table_info(agent_harnesses)`).all();
    if (!columns.some((column) => String(column['name']) === 'deleted')) {
      this.db.exec(`ALTER TABLE agent_harnesses ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    }
  }
  close(): void { this.db.close(); }
  async save(harness: AgentHarness): Promise<void> {
    const { tenant, internalId, version } = harness.metadata;
    try { this.db.prepare(`INSERT INTO agent_harnesses (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeAgentHarness(harness))); }
    catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new HarnessVersionConflictError(`Harness version already exists: ${internalId}@${version.toString()}`); throw error; }
  }
  // findVersionはdeletedを見ない: checkpointが保持するpinned internalId+versionからのresumeやtraceを、
  // 論理削除後も参照できるようにするため（docs/14-agent-harness-builder.md §10）。
  async findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<AgentHarness | null> {
    const row = this.db.prepare(`SELECT definition_json FROM agent_harnesses WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND version = ?`).get(scope.tenantId, scope.workspaceId, internalId, version.toString());
    return row === undefined ? null : fromJson(row['definition_json']);
  }
  async findLatest(scope: TenantScope, internalId: string): Promise<AgentHarness | null> {
    const row = this.db.prepare(`SELECT definition_json FROM agent_harnesses WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0 ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, internalId);
    return row === undefined ? null : fromJson(row['definition_json']);
  }
  async listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major, minor, patch FROM agent_harnesses WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0 ORDER BY major, minor, patch`).all(scope.tenantId, scope.workspaceId, internalId).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<HarnessSummary[]> {
    const rows = this.db.prepare(`SELECT a.definition_json FROM agent_harnesses a WHERE a.tenant_id = ? AND a.workspace_id = ? AND a.deleted = 0 AND a.version = (SELECT b.version FROM agent_harnesses b WHERE b.tenant_id = a.tenant_id AND b.workspace_id = a.workspace_id AND b.internal_id = a.internal_id AND b.deleted = 0 ORDER BY b.major DESC, b.minor DESC, b.patch DESC LIMIT 1) ORDER BY a.internal_id`).all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => { const item = fromJson(row['definition_json']); return { internalId: item.metadata.internalId, displayName: item.metadata.displayName, publishName: item.metadata.publishName, latestVersion: item.metadata.version, pattern: item.pattern, state: item.metadata.state }; });
  }
  async delete(scope: TenantScope, internalId: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM agent_harnesses WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, internalId);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE agent_harnesses SET deleted = 1 WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ?`).run(scope.tenantId, scope.workspaceId, internalId);
    return true;
  }
}

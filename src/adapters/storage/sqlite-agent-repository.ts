import { DatabaseSync } from 'node:sqlite';
import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import { AgentVersionConflictError } from '../../domain/agent/errors';
import { deserializeAgent, serializeAgent } from '../../domain/agent/serialization';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { PublishState } from '../../domain/tool/metadata';
import { AgentNotFoundError } from '../../domain/agent/errors';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agents (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  );
`;

function fromJson(value: unknown): Agent { return deserializeAgent(JSON.parse(String(value))); }

export class SqliteAgentRepository implements AgentRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(CREATE_TABLE); }
  close(): void { this.db.close(); }

  async save(agent: Agent): Promise<void> {
    const { tenant, internalId, version } = agent.metadata;
    try {
      this.db.prepare(`INSERT INTO agents (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeAgent(agent)));
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AgentVersionConflictError(`Agent version already exists: ${internalId}@${version.toString()}`);
      }
      throw error;
    }
  }

  async updateState(scope: TenantScope, internalId: string, version: SemVer, state: PublishState): Promise<Agent> {
    const current = await this.findVersion(scope, internalId, version);
    if (current === null) throw new AgentNotFoundError(`Agent not found: ${internalId}@${version.toString()}`);
    const serialized = serializeAgent(current);
    const updated = deserializeAgent({ ...serialized, metadata: { ...serialized.metadata, state } });
    this.db.prepare(`UPDATE agents SET definition_json = ? WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND version = ?`)
      .run(JSON.stringify(serializeAgent(updated)), scope.tenantId, scope.workspaceId, internalId, version.toString());
    return updated;
  }

  async findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Agent | null> {
    const row = this.db.prepare(`SELECT definition_json FROM agents WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND version = ?`)
      .get(scope.tenantId, scope.workspaceId, internalId, version.toString());
    return row === undefined ? null : fromJson(row['definition_json']);
  }

  async findLatest(scope: TenantScope, internalId: string): Promise<Agent | null> {
    const row = this.db.prepare(`SELECT definition_json FROM agents WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`)
      .get(scope.tenantId, scope.workspaceId, internalId);
    return row === undefined ? null : fromJson(row['definition_json']);
  }

  async listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]> {
    return this.db.prepare(`SELECT major, minor, patch FROM agents WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? ORDER BY major, minor, patch`)
      .all(scope.tenantId, scope.workspaceId, internalId)
      .map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch'])));
  }

  async list(scope: TenantScope): Promise<AgentSummary[]> {
    const rows = this.db.prepare(`SELECT a.definition_json FROM agents a WHERE a.tenant_id = ? AND a.workspace_id = ? AND a.version = (SELECT b.version FROM agents b WHERE b.tenant_id = a.tenant_id AND b.workspace_id = a.workspace_id AND b.internal_id = a.internal_id ORDER BY b.major DESC, b.minor DESC, b.patch DESC LIMIT 1) ORDER BY a.internal_id`)
      .all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => {
      const agent = fromJson(row['definition_json']);
      return {
        internalId: agent.metadata.internalId,
        displayName: agent.metadata.displayName,
        publishName: agent.metadata.publishName,
        latestVersion: agent.metadata.version,
        kind: agent.kind,
        state: agent.metadata.state,
      };
    });
  }
}

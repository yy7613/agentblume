import { DatabaseSync } from 'node:sqlite';
import type { TenantScope } from '../../domain/tool/ids';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { MemoryProposal, MemoryProposalState } from '../../domain/memory/memory-proposal';
import { deserializeMemoryProposal, serializeMemoryProposal, type SerializedMemoryProposal } from '../../domain/memory/serialization';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_proposals (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope_created
    ON memory_proposals (tenant_id, workspace_id, created_at DESC);
`;

const fromJson = (value: unknown): MemoryProposal => deserializeMemoryProposal(JSON.parse(String(value)) as SerializedMemoryProposal);

export class SqliteMemoryProposalRepository implements MemoryProposalRepository {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(CREATE_TABLE_SQL);
  }

  close(): void { this.db.close(); }

  async save(proposal: MemoryProposal): Promise<void> {
    this.db.prepare(
      `INSERT INTO memory_proposals (tenant_id, workspace_id, id, state, created_at, definition_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET state=excluded.state, definition_json=excluded.definition_json`,
    ).run(proposal.tenant.tenantId, proposal.tenant.workspaceId, proposal.id, proposal.state, proposal.createdAt, JSON.stringify(serializeMemoryProposal(proposal)));
  }

  async find(scope: TenantScope, id: string): Promise<MemoryProposal | null> {
    const row = this.db.prepare(`SELECT definition_json FROM memory_proposals WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : fromJson(row['definition_json']);
  }

  async list(scope: TenantScope, state?: MemoryProposalState): Promise<MemoryProposal[]> {
    const rows = state === undefined
      ? this.db.prepare(`SELECT definition_json FROM memory_proposals WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId)
      : this.db.prepare(`SELECT definition_json FROM memory_proposals WHERE tenant_id=? AND workspace_id=? AND state=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId, state);
    return rows.map((row) => fromJson(row['definition_json']));
  }
}

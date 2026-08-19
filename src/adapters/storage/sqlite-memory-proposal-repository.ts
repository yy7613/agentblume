import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { MemoryProposal, MemoryProposalState } from '../../domain/memory/memory-proposal';
import { deserializeMemoryProposal, serializeMemoryProposal, type SerializedMemoryProposal } from '../../domain/memory/serialization';

const fromJson = (value: unknown): MemoryProposal => deserializeMemoryProposal(JSON.parse(String(value)) as SerializedMemoryProposal);

export class SqliteMemoryProposalRepository extends SqliteRepositoryBase implements MemoryProposalRepository {

  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }


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

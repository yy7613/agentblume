import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { TenantScope } from '../../domain/tool/ids';
import type { AgentSession } from '../../domain/session/agent-session';
import { deserializeAgentSession } from '../../domain/session/serialization';
import type { AgentSessionRepository } from '../../domain/session/session-repository';

export class SqliteAgentSessionRepository extends SqliteRepositoryBase implements AgentSessionRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(session: AgentSession): Promise<void> {
    this.db.prepare(`INSERT INTO agent_sessions (tenant_id, workspace_id, session_id, status, expires_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, workspace_id, session_id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at, record_json=excluded.record_json`).run(session.scope.tenantId, session.scope.workspaceId, session.id, session.status, session.expiresAt, JSON.stringify(session));
  }
  async find(scope: TenantScope, sessionId: string): Promise<AgentSession | null> {
    const row = this.db.prepare(`SELECT record_json FROM agent_sessions WHERE tenant_id=? AND workspace_id=? AND session_id=?`).get(scope.tenantId, scope.workspaceId, sessionId);
    return row === undefined ? null : deserializeAgentSession(JSON.parse(String(row['record_json'])));
  }
  async listExpired(now: string, limit: number): Promise<readonly AgentSession[]> {
    const rows = this.db.prepare(`SELECT record_json FROM agent_sessions WHERE status='active' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`).all(now, Math.max(1, limit));
    return rows.map((row) => deserializeAgentSession(JSON.parse(String(row['record_json']))));
  }
}

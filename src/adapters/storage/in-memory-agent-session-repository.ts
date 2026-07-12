import type { TenantScope } from '../../domain/tool/ids';
import type { AgentSession } from '../../domain/session/agent-session';
import type { AgentSessionRepository } from '../../domain/session/session-repository';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }

export class InMemoryAgentSessionRepository implements AgentSessionRepository {
  private readonly records = new Map<string, AgentSession>();

  async save(session: AgentSession): Promise<void> { this.records.set(key(session.scope, session.id), structuredClone(session)); }
  async find(scope: TenantScope, sessionId: string): Promise<AgentSession | null> {
    const value = this.records.get(key(scope, sessionId));
    return value === undefined ? null : structuredClone(value);
  }
  async listExpired(now: string, limit: number): Promise<readonly AgentSession[]> {
    return [...this.records.values()].filter((session) => session.status === 'active' && session.expiresAt <= now).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, Math.max(1, limit)).map((session) => structuredClone(session));
  }
}

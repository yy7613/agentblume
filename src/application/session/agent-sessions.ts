import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { AgentId } from '../../domain/agent/ids';
import { closeAgentSession, createAgentSession, expireAgentSession, type AgentSession } from '../../domain/session/agent-session';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError } from '../../domain/session/errors';
import type { SessionId } from '../../domain/session/ids';
import type { AgentSessionRepository } from '../../domain/session/session-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';

const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export class CreateAgentSessionUseCase {
  constructor(private readonly sessions: AgentSessionRepository, private readonly agents: AgentRepository, private readonly now: () => Date = () => new Date(), private readonly makeId: () => string = randomUUID) {}
  async execute(input: { readonly scope: TenantScope; readonly agentId: AgentId; readonly version?: SemVer }): Promise<AgentSession> {
    const agent = input.version === undefined ? await this.agents.findLatest(input.scope, input.agentId) : await this.agents.findVersion(input.scope, input.agentId, input.version);
    if (agent === null) throw new AgentNotFoundError(`CreateAgentSession: agent not found: ${input.agentId}`);
    const now = this.now();
    const session = createAgentSession({ id: this.makeId(), scope: input.scope, rootAgent: { internalId: agent.metadata.internalId, version: agent.metadata.version.toString() }, createdAt: now.toISOString(), lastAccessedAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString() });
    await this.sessions.save(session);
    return session;
  }
}

export class QueryAgentSessionUseCase {
  constructor(private readonly sessions: AgentSessionRepository, private readonly now: () => Date = () => new Date()) {}
  async get(scope: TenantScope, sessionId: SessionId): Promise<AgentSession> {
    const session = await this.sessions.find(scope, sessionId);
    if (session === null) throw new AgentSessionNotFoundError(`agent session not found: ${sessionId}`);
    if (session.status === 'closed') throw new AgentSessionClosedError(`agent session is closed: ${sessionId}`);
    if (session.status === 'expired' || session.expiresAt <= this.now().toISOString()) {
      if (session.status === 'active') await this.sessions.save(expireAgentSession(session));
      throw new AgentSessionExpiredError(`agent session is expired: ${sessionId}`);
    }
    return session;
  }
  async close(scope: TenantScope, sessionId: SessionId): Promise<AgentSession> {
    const session = await this.get(scope, sessionId);
    const closed = closeAgentSession(session, this.now().toISOString());
    await this.sessions.save(closed);
    return closed;
  }
}

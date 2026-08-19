import type { AgentId } from '../../domain/agent/ids';
import type { AgentSession } from '../../domain/session/agent-session';
import { SessionArtifactNotFoundError } from '../../domain/session/errors';
import type { SessionArtifactId, SessionId } from '../../domain/session/ids';
import type { SessionArtifact, SessionArtifactDescriptor } from '../../domain/session/session-artifact';
import { toArtifactDescriptor } from '../../domain/session/session-artifact';
import type { SessionArtifactRepository } from '../../domain/session/session-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { QueryAgentSessionUseCase } from './agent-sessions';

export class QuerySessionArtifactsUseCase {
  constructor(private readonly sessions: QueryAgentSessionUseCase, private readonly artifacts: SessionArtifactRepository) {}
  async list(scope: TenantScope, sessionId: SessionId): Promise<readonly SessionArtifactDescriptor[]> {
    await this.sessions.get(scope, sessionId);
    return (await this.artifacts.list(scope, sessionId)).map((artifact) => toArtifactDescriptor(artifact));
  }
  async get(scope: TenantScope, sessionId: SessionId, artifactId: SessionArtifactId, limit = 100, offset = 0, section?: 'nodes' | 'edges'): Promise<{ readonly artifact: SessionArtifactDescriptor; readonly payload: unknown }> {
    await this.sessions.get(scope, sessionId);
    const result = await this.artifacts.read(scope, sessionId, artifactId, { limit, offset, ...(section === undefined ? {} : { section }) });
    if (result === null) throw new SessionArtifactNotFoundError(`session artifact not found: ${artifactId}`);
    return { artifact: toArtifactDescriptor(result.artifact, preview(result.payload)), payload: bounded(result.payload) };
  }
  async delete(scope: TenantScope, sessionId: SessionId, artifactId: SessionArtifactId): Promise<void> {
    await this.sessions.get(scope, sessionId);
    const existing = await this.artifacts.read(scope, sessionId, artifactId, { limit: 1 });
    if (existing === null) throw new SessionArtifactNotFoundError(`session artifact not found: ${artifactId}`);
    await this.artifacts.delete(scope, sessionId, artifactId);
  }
}

export function preview(payload: unknown): unknown {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) {
    const value = payload as { schema?: unknown; rows: unknown[] };
    return { ...(value.schema === undefined ? {} : { schema: value.schema }), rows: value.rows.slice(0, 10) };
  }
  return payload;
}

function bounded(payload: unknown): unknown {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) return payload;
  const serialized = JSON.stringify(payload) ?? 'null';
  return serialized.length > 65_536 ? { truncated: true, preview: serialized.slice(0, 65_536) } : payload;
}

export function assertSessionMatchesAgent(session: AgentSession, agent: { readonly internalId: AgentId; readonly version: string }): void {
  if (session.rootAgent.internalId !== agent.internalId || session.rootAgent.version !== agent.version) throw new Error('session root Agent does not match requested Agent version');
}

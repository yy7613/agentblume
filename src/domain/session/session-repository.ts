import type { TenantScope } from '../tool/ids';
import type { AgentSession } from './agent-session';
import type { SessionArtifactId, SessionId } from './ids';
import type { SessionArtifact } from './session-artifact';

/** Artifact payloadの範囲読み取り指定。table Artifactはrow offset/limitを解釈する。 */
export interface SessionArtifactReadOptions {
  readonly offset?: number;
  readonly limit?: number;
  /** graph Artifactで返すrecord種別。未指定はedge。 */
  readonly section?: 'nodes' | 'edges';
}

export interface AgentSessionRepository {
  save(session: AgentSession): Promise<void>;
  find(scope: TenantScope, sessionId: SessionId): Promise<AgentSession | null>;
  listExpired(now: string, limit: number): Promise<readonly AgentSession[]>;
}

export interface SessionArtifactRepository {
  save(artifact: SessionArtifact, payload: unknown, idempotencyKey: string): Promise<void>;
  find(scope: TenantScope, sessionId: SessionId, artifactId: SessionArtifactId): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null>;
  read(scope: TenantScope, sessionId: SessionId, artifactId: SessionArtifactId, options: SessionArtifactReadOptions): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null>;
  findByIdempotencyKey(scope: TenantScope, sessionId: SessionId, idempotencyKey: string): Promise<SessionArtifact | null>;
  list(scope: TenantScope, sessionId: SessionId): Promise<readonly SessionArtifact[]>;
  delete(scope: TenantScope, sessionId: SessionId, artifactId: SessionArtifactId): Promise<void>;
  usage(scope: TenantScope, sessionId: SessionId): Promise<{ readonly count: number; readonly bytes: number }>;
}

import type { TenantScope } from '../tool/ids';
import type { AgentSession } from './agent-session';
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
  find(scope: TenantScope, sessionId: string): Promise<AgentSession | null>;
  listExpired(now: string, limit: number): Promise<readonly AgentSession[]>;
}

export interface SessionArtifactRepository {
  save(artifact: SessionArtifact, payload: unknown, idempotencyKey: string): Promise<void>;
  find(scope: TenantScope, sessionId: string, artifactId: string): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null>;
  read(scope: TenantScope, sessionId: string, artifactId: string, options: SessionArtifactReadOptions): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null>;
  findByIdempotencyKey(scope: TenantScope, sessionId: string, idempotencyKey: string): Promise<SessionArtifact | null>;
  list(scope: TenantScope, sessionId: string): Promise<readonly SessionArtifact[]>;
  delete(scope: TenantScope, sessionId: string, artifactId: string): Promise<void>;
  usage(scope: TenantScope, sessionId: string): Promise<{ readonly count: number; readonly bytes: number }>;
}

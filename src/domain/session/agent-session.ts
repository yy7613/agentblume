import type { TenantScope } from '../tool/ids';
import { SessionDomainError } from './errors';

export type AgentSessionStatus = 'active' | 'closed' | 'expired';

export interface SessionQuota {
  readonly maxBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxArtifacts: number;
}

export const DEFAULT_SESSION_QUOTA: SessionQuota = {
  maxBytes: 1_073_741_824,
  maxArtifactBytes: 268_435_456,
  maxArtifacts: 1_000,
};

export interface AgentSession {
  readonly id: string;
  readonly scope: TenantScope;
  readonly rootAgent: { readonly internalId: string; readonly version: string };
  readonly status: AgentSessionStatus;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly expiresAt: string;
  readonly quota: SessionQuota;
  readonly closedAt?: string;
}

export function createAgentSession(input: Omit<AgentSession, 'status' | 'quota'> & { readonly quota?: SessionQuota }): AgentSession {
  assertNonEmpty(input.id, 'id');
  assertNonEmpty(input.scope.tenantId, 'scope.tenantId');
  assertNonEmpty(input.scope.workspaceId, 'scope.workspaceId');
  assertNonEmpty(input.rootAgent.internalId, 'rootAgent.internalId');
  assertNonEmpty(input.rootAgent.version, 'rootAgent.version');
  if (input.expiresAt <= input.createdAt) throw new SessionDomainError('session expiresAt must be after createdAt');
  const quota = input.quota ?? DEFAULT_SESSION_QUOTA;
  if (!Number.isSafeInteger(quota.maxBytes) || quota.maxBytes <= 0 || !Number.isSafeInteger(quota.maxArtifactBytes) || quota.maxArtifactBytes <= 0 || !Number.isSafeInteger(quota.maxArtifacts) || quota.maxArtifacts <= 0 || quota.maxArtifactBytes > quota.maxBytes) throw new SessionDomainError('invalid session quota');
  return { ...input, scope: { ...input.scope }, rootAgent: { ...input.rootAgent }, status: 'active', quota: { ...quota } };
}

export function closeAgentSession(session: AgentSession, closedAt: string): AgentSession {
  if (session.status !== 'active') throw new SessionDomainError(`cannot close session in state ${session.status}`);
  return { ...session, status: 'closed', closedAt };
}

export function expireAgentSession(session: AgentSession): AgentSession {
  if (session.status !== 'active') return session;
  return { ...session, status: 'expired' };
}

export function touchAgentSession(session: AgentSession, now: string): AgentSession {
  if (session.status !== 'active') throw new SessionDomainError(`cannot touch session in state ${session.status}`);
  return { ...session, lastAccessedAt: now };
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw new SessionDomainError(`${field} must be non-empty`);
}

import { describe, expect, it } from 'vitest';
import { closeAgentSession, createAgentSession, expireAgentSession, touchAgentSession } from './agent-session';
import { SessionDomainError } from './errors';

const base = { id: 's', scope: { tenantId: 't', workspaceId: 'w' }, rootAgent: { internalId: 'a', version: '1.0.0' }, createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' };

describe('AgentSession', () => {
  it('creates an immutable active session with defaults', () => {
    const session = createAgentSession(base);
    expect(session).toMatchObject({ status: 'active', quota: { maxArtifacts: 1000 } });
    expect(session.scope).not.toBe(base.scope);
  });
  it('rejects invalid identifiers, time ranges and quota', () => {
    expect(() => createAgentSession({ ...base, id: '' })).toThrow(SessionDomainError);
    expect(() => createAgentSession({ ...base, expiresAt: base.createdAt })).toThrow(/expiresAt/);
    expect(() => createAgentSession({ ...base, quota: { maxBytes: 1, maxArtifactBytes: 2, maxArtifacts: 1 } })).toThrow(/quota/);
  });
  it('closes, expires and touches only active sessions', () => {
    const active = createAgentSession(base);
    expect(touchAgentSession(active, '2026-07-11T01:00:00.000Z').lastAccessedAt).toContain('01:00');
    const closed = closeAgentSession(active, '2026-07-11T02:00:00.000Z');
    expect(closed.status).toBe('closed');
    expect(() => closeAgentSession(closed, '2026-07-11T03:00:00.000Z')).toThrow(SessionDomainError);
    expect(() => touchAgentSession(closed, '2026-07-11T03:00:00.000Z')).toThrow(SessionDomainError);
    expect(expireAgentSession(active).status).toBe('expired');
    expect(expireAgentSession(closed)).toBe(closed);
  });
});

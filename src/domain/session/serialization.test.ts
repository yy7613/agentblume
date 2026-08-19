import { describe, expect, it } from 'vitest';
import { closeAgentSession, createAgentSession } from './agent-session';
import { createSessionArtifact } from './session-artifact';
import { SessionDomainError } from './errors';
import { deserializeAgentSession, deserializeSessionArtifact } from './serialization';

const scope = { tenantId: 't', workspaceId: 'w' };
const session = createAgentSession({ id: 's', scope, rootAgent: { internalId: 'a', version: '1.0.0' }, createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' });
const minimalArtifact = createSessionArtifact({ id: 'a', scope, sessionId: 's', name: 'data', kind: 'json', revision: 1, contentType: 'application/json', sizeBytes: 12, checksum: 'sum', origin: { runId: 'r', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'c', sinkNodeId: 'sink' }, createdAt: '2026-07-11T01:00:00.000Z', expiresAt: session.expiresAt });
const fullArtifact = createSessionArtifact({
  ...minimalArtifact,
  kind: 'table',
  contentType: 'application/x-ndjson',
  schema: { columns: [{ name: 'id', type: 'number', nullable: false }] },
  counts: { rows: 3 },
  origin: { ...minimalArtifact.origin, agentId: 'agent' },
});

function roundTrip(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }

describe('deserializeAgentSession', () => {
  it('JSON往復した正当なレコードを復元する(active / closed)', () => {
    expect(deserializeAgentSession(roundTrip(session))).toEqual(session);
    const closed = closeAgentSession(session, '2026-07-11T02:00:00.000Z');
    expect(deserializeAgentSession(roundTrip(closed))).toEqual(closed);
  });

  it('未知フィールドは読み飛ばして復元する(前方互換)', () => {
    expect(deserializeAgentSession({ ...roundTrip(session) as object, futureField: true })).toEqual(session);
  });

  it('構造不正は SessionDomainError で拒否する', () => {
    const record = roundTrip(session) as Record<string, unknown>;
    expect(() => deserializeAgentSession(null)).toThrow(SessionDomainError);
    expect(() => deserializeAgentSession({ ...record, id: undefined })).toThrow(/deserializeAgentSession: id/);
    expect(() => deserializeAgentSession({ ...record, status: 'paused' })).toThrow(/deserializeAgentSession: status/);
    expect(() => deserializeAgentSession({ ...record, quota: { maxBytes: 'lots' } })).toThrow(SessionDomainError);
    expect(() => deserializeAgentSession({ ...record, closedAt: 42 })).toThrow(/deserializeAgentSession: closedAt/);
  });
});

describe('deserializeSessionArtifact', () => {
  it('JSON往復した正当なレコードを復元する(optional 有無の両方)', () => {
    expect(deserializeSessionArtifact(roundTrip(minimalArtifact))).toEqual(minimalArtifact);
    expect(deserializeSessionArtifact(roundTrip(fullArtifact))).toEqual(fullArtifact);
  });

  it('未知フィールドは読み飛ばして復元する(前方互換)', () => {
    expect(deserializeSessionArtifact({ ...roundTrip(fullArtifact) as object, futureField: 'x' })).toEqual(fullArtifact);
  });

  it('構造不正は SessionDomainError で拒否する', () => {
    const record = roundTrip(fullArtifact) as Record<string, unknown>;
    expect(() => deserializeSessionArtifact(null)).toThrow(SessionDomainError);
    expect(() => deserializeSessionArtifact({ ...record, kind: 'video' })).toThrow(/deserializeSessionArtifact: kind/);
    expect(() => deserializeSessionArtifact({ ...record, revision: 'first' })).toThrow(/deserializeSessionArtifact: revision/);
    expect(() => deserializeSessionArtifact({ ...record, origin: undefined })).toThrow(/deserializeSessionArtifact: origin/);
    expect(() => deserializeSessionArtifact({ ...record, schema: { columns: [{ name: 'id' }] } })).toThrow(SessionDomainError);
  });

  it('構造は正しくてもドメイン不変条件に反するレコードは拒否する', () => {
    const record = roundTrip(fullArtifact) as Record<string, unknown>;
    expect(() => deserializeSessionArtifact({ ...record, revision: 0 })).toThrow(/revision must be positive/);
    expect(() => deserializeSessionArtifact({ ...record, expiresAt: '2020-01-01T00:00:00.000Z' })).toThrow(SessionDomainError);
  });
});

import { describe, expect, it } from 'vitest';
import { createSessionArtifact, toArtifactDescriptor } from './session-artifact';
import { SessionDomainError } from './errors';

const base = { id: 'a', scope: { tenantId: 't', workspaceId: 'w' }, sessionId: 's', name: 'data', kind: 'table' as const, revision: 1, contentType: 'application/json', sizeBytes: 1, checksum: 'sum', origin: { runId: 'r', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'c', sinkNodeId: 'sink' }, createdAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' };

describe('SessionArtifact', () => {
  it('creates a defensive copy and exposes only a safe descriptor', () => {
    const artifact = createSessionArtifact(base);
    const descriptor = toArtifactDescriptor(artifact, { rows: [] });
    expect(descriptor).toMatchObject({ id: 'a', preview: { rows: [] } });
    expect(descriptor).not.toHaveProperty('scope');
    expect(descriptor).not.toHaveProperty('origin');
  });
  it('rejects invalid kind, revision, size and lifecycle values', () => {
    expect(() => createSessionArtifact({ ...base, kind: 'other' as never })).toThrow(SessionDomainError);
    expect(() => createSessionArtifact({ ...base, revision: 0 })).toThrow(SessionDomainError);
    expect(() => createSessionArtifact({ ...base, sizeBytes: -1 })).toThrow(SessionDomainError);
    expect(() => createSessionArtifact({ ...base, expiresAt: base.createdAt })).toThrow(SessionDomainError);
  });
});

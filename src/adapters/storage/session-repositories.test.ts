import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession } from '../../domain/session/agent-session';
import { createSessionArtifact } from '../../domain/session/session-artifact';
import { InMemoryAgentSessionRepository } from './in-memory-agent-session-repository';
import { InMemorySessionArtifactRepository } from './in-memory-session-artifact-repository';
import { SqliteAgentSessionRepository } from './sqlite-agent-session-repository';
import { SqliteSessionArtifactRepository } from './sqlite-session-artifact-repository';

const scope = { tenantId: 't', workspaceId: 'w' };
const session = createAgentSession({ id: 's', scope, rootAgent: { internalId: 'a', version: '1.0.0' }, createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' });
const artifact = createSessionArtifact({ id: 'a', scope, sessionId: 's', name: 'data', kind: 'json', revision: 1, contentType: 'application/json', sizeBytes: 12, checksum: 'sum', origin: { runId: 'r', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'c', sinkNodeId: 'sink' }, createdAt: '2026-07-11T01:00:00.000Z', expiresAt: session.expiresAt });

describe.each([
  ['in-memory', () => ({ sessions: new InMemoryAgentSessionRepository(), artifacts: new InMemorySessionArtifactRepository(), close: () => {} })],
  ['sqlite', () => { const sessions = new SqliteAgentSessionRepository(); const artifacts = new SqliteSessionArtifactRepository(); return { sessions, artifacts, close: () => { sessions.close(); artifacts.close(); } }; }],
])('%s session repositories', (_name, make) => {
  it('round-trips scoped sessions and artifacts with idempotency and usage', async () => {
    const { sessions, artifacts, close } = make();
    try {
      await sessions.save(session);
      expect(await sessions.find(scope, 's')).toMatchObject({ rootAgent: { internalId: 'a' } });
      expect(await sessions.find({ tenantId: 'other', workspaceId: 'w' }, 's')).toBeNull();
      expect(await sessions.listExpired('2026-07-13T00:00:00.000Z', 5)).toHaveLength(1);
      await artifacts.save(artifact, { ok: true }, 'idem');
      expect(await artifacts.findByIdempotencyKey(scope, 's', 'idem')).toMatchObject({ id: 'a' });
      expect(await artifacts.find(scope, 's', 'a')).toMatchObject({ payload: { ok: true } });
      expect(await artifacts.read(scope, 's', 'a', { offset: 1, limit: 1 })).toMatchObject({ payload: { ok: true } });
      expect(await artifacts.usage(scope, 's')).toEqual({ count: 1, bytes: 12 });
      await artifacts.delete(scope, 's', 'a');
      expect(await artifacts.list(scope, 's')).toEqual([]);
    } finally { close(); }
  });
});

describe('SqliteSessionArtifactRepository payload storage', () => {
  it('keeps the payload outside the SQLite catalog and removes its file when deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentblume-artifact-test-'));
    const artifacts = new SqliteSessionArtifactRepository(':memory:', root);
    try {
      const tableArtifact = createSessionArtifact({ ...artifact, kind: 'table', contentType: 'application/x-ndjson', sizeBytes: 100, checksum: 'table-sum' });
      await expect(artifacts.save(tableArtifact, { rows: [] }, 'invalid-table')).rejects.toThrow(/schema and rows/);
      await artifacts.save(tableArtifact, { schema: { columns: [{ name: 'id', type: 'number', nullable: false }] }, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 'payload-file');
      const names = await readdir(root, { recursive: true });
      expect(names.some((name) => String(name).endsWith('.jsonl'))).toBe(true);
      expect(await artifacts.read(scope, 's', 'a', { offset: 1, limit: 1 })).toMatchObject({ payload: { rows: [{ id: 2 }], page: { offset: 1, limit: 1, nextOffset: 2 } } });
      const replacement = createSessionArtifact({ ...tableArtifact, revision: 2, checksum: 'replacement-sum' });
      await artifacts.save(replacement, { schema: { columns: [{ name: 'id', type: 'number', nullable: false }] }, rows: [{ id: 2 }] }, 'replacement-file');
      expect(await artifacts.find(scope, 's', 'a')).toMatchObject({ payload: { rows: [{ id: 2 }] } });
      expect(await artifacts.find(scope, 's', 'missing')).toBeNull();
      expect(await artifacts.read(scope, 's', 'missing', { limit: 1 })).toBeNull();
      expect(await artifacts.findByIdempotencyKey(scope, 's', 'missing')).toBeNull();
      await artifacts.delete(scope, 's', 'a');
      await artifacts.delete(scope, 's', 'missing');
      expect((await readdir(root, { recursive: true })).some((name) => String(name).endsWith('.jsonl'))).toBe(false);
    } finally {
      artifacts.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

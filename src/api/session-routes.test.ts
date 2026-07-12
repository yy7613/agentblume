import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createApp, type App } from '../composition/root';
import { createSessionArtifact } from '../domain/session/session-artifact';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const apps: App[] = [];
afterEach(async () => { while (apps.length > 0) { const app = apps.pop() as App; app.close(); } });

async function setup() {
  const app = createApp({ profile: 'test' }); apps.push(app);
  await app.saveAgent.execute({ scope, internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', owner: 'owner', kind: 'normal', systemPrompt: 'help', tools: [] });
  const server = buildServer(app);
  return { app, server };
}

describe('agent session routes', () => {
  it('creates, lists and closes a scoped Agent session', async () => {
    const { server } = await setup();
    const created = await server.inject({ method: 'POST', url: '/agent-sessions', payload: { scope, agent: { internalId: 'agent', version: '1.0.0' } } });
    expect(created.statusCode).toBe(201);
    const session = (created.json() as { session: { id: string; status: string } }).session;
    expect(session.status).toBe('active');
    const loaded = await server.inject({ method: 'GET', url: `/agent-sessions/${session.id}?tenantId=tenant&workspaceId=workspace` });
    expect(loaded.statusCode).toBe(200);
    const closed = await server.inject({ method: 'POST', url: `/agent-sessions/${session.id}/close`, payload: { scope } });
    expect((closed.json() as { session: { status: string } }).session.status).toBe('closed');
  });

  it('keeps artifacts within the owning session scope', async () => {
    const { app, server } = await setup();
    const created = await server.inject({ method: 'POST', url: '/agent-sessions', payload: { scope, agent: { internalId: 'agent', version: '1.0.0' } } });
    const session = (created.json() as { session: { id: string; expiresAt: string } }).session;
    const artifact = createSessionArtifact({ id: 'artifact', scope, sessionId: session.id, name: 'result', kind: 'json', revision: 1, contentType: 'application/json', sizeBytes: 12, checksum: 'hash', origin: { runId: 'run', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'call', sinkNodeId: 'sink' }, createdAt: '2026-07-11T00:00:00.000Z', expiresAt: session.expiresAt });
    await app.sessionArtifactRepo.save(artifact, { ok: true }, 'idem');
    const list = await server.inject({ method: 'GET', url: `/agent-sessions/${session.id}/artifacts?tenantId=tenant&workspaceId=workspace` });
    expect((list.json() as { artifacts: { id: string }[] }).artifacts).toEqual([expect.objectContaining({ id: 'artifact' })]);
    const other = await server.inject({ method: 'GET', url: `/agent-sessions/${session.id}/artifacts?tenantId=other&workspaceId=workspace` });
    expect(other.statusCode).toBe(404);
  });

  it('reads bounded artifacts, deletes them, and validates session versions', async () => {
    const { app, server } = await setup();
    const invalid = await server.inject({ method: 'POST', url: '/agent-sessions', payload: { scope, agent: { internalId: 'agent', version: 'bad' } } });
    expect(invalid.statusCode).toBe(400);
    const created = await server.inject({ method: 'POST', url: '/agent-sessions', payload: { scope, agent: { internalId: 'agent' } } });
    const session = (created.json() as { session: { id: string; expiresAt: string } }).session;
    const artifact = createSessionArtifact({ id: 'rows', scope, sessionId: session.id, name: 'rows', kind: 'table', revision: 1, contentType: 'application/json', sizeBytes: 30, checksum: 'hash', origin: { runId: 'run', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'call', sinkNodeId: 'sink' }, createdAt: '2026-07-11T00:00:00.000Z', expiresAt: session.expiresAt });
    await app.sessionArtifactRepo.save(artifact, { rows: [{ id: 1 }, { id: 2 }] }, 'rows-idem');
    const read = await server.inject({ method: 'GET', url: `/agent-sessions/${session.id}/artifacts/rows?tenantId=tenant&workspaceId=workspace&limit=1&offset=1` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ artifact: { id: 'rows' }, payload: { rows: [{ id: 2 }], page: { offset: 1 } } });
    const deleted = await server.inject({ method: 'DELETE', url: `/agent-sessions/${session.id}/artifacts/rows?tenantId=tenant&workspaceId=workspace` });
    expect(deleted.statusCode).toBe(204);
    const missing = await server.inject({ method: 'GET', url: `/agent-sessions/${session.id}/artifacts/rows?tenantId=tenant&workspaceId=workspace` });
    expect(missing.statusCode).toBe(404);
  });
});

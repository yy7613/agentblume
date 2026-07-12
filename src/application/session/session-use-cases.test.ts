import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryAgentSessionRepository } from '../../adapters/storage/in-memory-agent-session-repository';
import { InMemorySessionArtifactRepository } from '../../adapters/storage/in-memory-session-artifact-repository';
import { createAgent } from '../../domain/agent/agent';
import { SemVer } from '../../domain/tool/semver';
import { createSessionArtifact } from '../../domain/session/session-artifact';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError, SessionArtifactNotFoundError } from '../../domain/session/errors';
import { CreateAgentSessionUseCase, QueryAgentSessionUseCase } from './agent-sessions';
import { assertSessionMatchesAgent, preview, QuerySessionArtifactsUseCase } from './session-artifacts';

const scope = { tenantId: 't', workspaceId: 'w' };
const now = () => new Date('2026-07-11T00:00:00.000Z');
async function agentRepo() {
  const repo = new InMemoryAgentRepository();
  await repo.save(createAgent({ metadata: { internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', version: SemVer.of(1, 0, 0), owner: 'o', state: 'draft', tenant: scope }, kind: 'normal', systemPrompt: 'help', skills: [], tools: [], agents: [] }));
  return repo;
}

describe('session use cases', () => {
  it('creates, gets and closes a session fixed to an Agent version', async () => {
    const sessions = new InMemoryAgentSessionRepository();
    const create = new CreateAgentSessionUseCase(sessions, await agentRepo(), now, () => 'session');
    const query = new QueryAgentSessionUseCase(sessions, now);
    const session = await create.execute({ scope, agentId: 'agent' });
    expect(session).toMatchObject({ id: 'session', rootAgent: { version: '1.0.0' } });
    expect(await query.get(scope, 'session')).toMatchObject({ status: 'active' });
    expect(await query.close(scope, 'session')).toMatchObject({ status: 'closed' });
    await expect(query.get(scope, 'session')).rejects.toBeInstanceOf(AgentSessionClosedError);
    await expect(query.get(scope, 'missing')).rejects.toBeInstanceOf(AgentSessionNotFoundError);
  });

  it('expires sessions and provides bounded artifact reads', async () => {
    const sessions = new InMemoryAgentSessionRepository();
    const repo = await agentRepo();
    const create = new CreateAgentSessionUseCase(sessions, repo, now, () => 'session');
    const session = await create.execute({ scope, agentId: 'agent' });
    const artifacts = new InMemorySessionArtifactRepository();
    const query = new QuerySessionArtifactsUseCase(new QueryAgentSessionUseCase(sessions, now), artifacts);
    const artifact = createSessionArtifact({ id: 'artifact', scope, sessionId: session.id, name: 'rows', kind: 'table', revision: 1, contentType: 'application/json', sizeBytes: 50, checksum: 'sum', origin: { runId: 'run', toolId: 'tool', toolVersion: '1', toolCallId: 'call', sinkNodeId: 'sink' }, createdAt: session.createdAt, expiresAt: session.expiresAt });
    await artifacts.save(artifact, { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 'id');
    expect(await query.list(scope, session.id)).toHaveLength(1);
    expect(await query.get(scope, session.id, 'artifact', 2)).toMatchObject({ payload: { rows: [{ id: 1 }, { id: 2 }] } });
    expect(await query.get(scope, session.id, 'artifact', 2, 1)).toMatchObject({ payload: { rows: [{ id: 2 }, { id: 3 }], page: { offset: 1, limit: 2 } } });
    await query.delete(scope, session.id, 'artifact');
    await expect(query.get(scope, session.id, 'artifact')).rejects.toBeInstanceOf(SessionArtifactNotFoundError);
    const expiredQuery = new QueryAgentSessionUseCase(sessions, () => new Date('2026-07-13T00:00:00.000Z'));
    await expect(expiredQuery.get(scope, session.id)).rejects.toBeInstanceOf(AgentSessionExpiredError);
  });

  it('bounds non-table payloads and protects artifact operations with the root Agent session', async () => {
    const sessions = new InMemoryAgentSessionRepository();
    const create = new CreateAgentSessionUseCase(sessions, await agentRepo(), now, () => 'session');
    const session = await create.execute({ scope, agentId: 'agent' });
    const artifacts = new InMemorySessionArtifactRepository();
    const query = new QuerySessionArtifactsUseCase(new QueryAgentSessionUseCase(sessions, now), artifacts);
    const artifact = createSessionArtifact({ id: 'json', scope, sessionId: session.id, name: 'document', kind: 'json', revision: 1, contentType: 'application/json', sizeBytes: 70_000, checksum: 'sum', origin: { runId: 'run', toolId: 'tool', toolVersion: '1', toolCallId: 'call', sinkNodeId: 'sink' }, createdAt: session.createdAt, expiresAt: session.expiresAt });
    await artifacts.save(artifact, 'x'.repeat(70_000), 'json-idem');
    expect(preview({ value: true })).toEqual({ value: true });
    expect(await query.get(scope, session.id, 'json')).toMatchObject({ payload: { truncated: true } });
    expect(() => assertSessionMatchesAgent(session, { internalId: 'other', version: '1.0.0' })).toThrow(/does not match/);
    expect(() => assertSessionMatchesAgent(session, session.rootAgent)).not.toThrow();
  });
});

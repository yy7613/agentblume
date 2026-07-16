import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('harness routes', () => {
  let app: App; let server: FastifyInstance; let model: ScriptedModelProvider;
  beforeEach(async () => {
    model = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app);
    for (const id of ['writer', 'reviewer', 'publisher']) {
      const response = await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: id, workingName: id, displayName: id, publishName: id, owner: 'owner', kind: 'normal', systemPrompt: `You are ${id}.`, tools: [] } });
      expect(response.statusCode).toBe(201);
    }
  });
  afterEach(async () => { await server.close(); app.close(); });
  function body(overrides: Record<string, unknown> = {}) {
    return {
      scope, internalId: 'content-review', workingName: 'Content review', displayName: 'Content review', publishName: 'content_review', owner: 'owner', pattern: 'sequential',
      slots: ['writer', 'reviewer', 'publisher'].map((id) => ({ id, label: id, purpose: `${id} work`, assignment: { internalId: id, version: '1.0.0' } })),
      topology: { pattern: 'sequential', orderedSlotIds: ['writer', 'reviewer', 'publisher'], contextMode: 'full-conversation' },
      ...overrides,
    };
  }
  it('Harnessをversion保存・取得・Draft検証できる', async () => {
    const validation = await server.inject({ method: 'POST', url: '/harness-drafts/validate', payload: body() });
    expect(validation.statusCode).toBe(200); expect(validation.json().validation).toEqual({ valid: true, issues: [] });
    const saved = await server.inject({ method: 'POST', url: '/harnesses', payload: body() });
    expect(saved.statusCode).toBe(201); expect(saved.json().harness.metadata.version).toBe('1.0.0');
    const listed = await server.inject({ method: 'GET', url: '/harnesses', query: scope });
    expect(listed.json().harnesses).toMatchObject([{ internalId: 'content-review', pattern: 'sequential', latestVersion: '1.0.0' }]);
    const compiled = await server.inject({ method: 'POST', url: '/harness-drafts/compile', payload: body() });
    expect(compiled.json().executable.nodes).toHaveLength(5);
  });
  it('Sequential Harness Runはslot順のchild Runとroot eventを保存する', async () => {
    await server.inject({ method: 'POST', url: '/harnesses', payload: body() });
    model.enqueue(
      { message: { role: 'assistant', content: 'draft' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'reviewed' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'published' }, finishReason: 'stop' },
    );
    const started = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'content-review', version: '1.0.0' }, message: 'Write a launch note.', mode: 'preview' } });
    expect(started.statusCode).toBe(200); const run = started.json().run;
    expect(run.status).toBe('succeeded'); expect(run.response).toBe('published');
    expect(run.events.filter((event: { kind: string }) => event.kind === 'participant_completed')).toHaveLength(3);
    const events = await server.inject({ method: 'GET', url: `/harness-runs/${run.runId}/events`, query: scope });
    expect(events.json().events.map((event: { kind: string }) => event.kind)).toContain('harness_completed');
    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests[1])).toContain('writer: draft');
  });
  it('Concurrent collectは決定的なslot順で集約する', async () => {
    const concurrent = body({ internalId: 'panel', pattern: 'concurrent', topology: { pattern: 'concurrent', participantSlotIds: ['writer', 'reviewer', 'publisher'], aggregation: 'collect' } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: concurrent });
    model.enqueue(
      { message: { role: 'assistant', content: 'writer view' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'reviewer view' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'publisher view' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'panel' }, message: 'Assess this.', mode: 'preview' } });
    expect(response.json().run.response).toMatch(/## writer[\s\S]*## reviewer[\s\S]*## publisher/);
  });
  it('Harness全体のmodel round予算をslot間で共有して上限を超える開始を止める', async () => {
    const constrained = body({ policies: {
      budget: { maxDurationMs: 120_000, maxParticipantRuns: 20, maxModelRounds: 2, maxToolCalls: 100, maxParallelism: 4 },
      context: 'task-only', planning: { enabled: false, requireApproval: false }, memory: { wikiIds: [], sessionWorkspace: true },
      approvals: { mode: 'inherit-agent' }, failure: { mode: 'fail-fast' },
    } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: constrained });
    model.enqueue(
      { message: { role: 'assistant', content: 'draft' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'reviewed' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'content-review' }, message: 'Write a launch note.', mode: 'preview' } });
    const run = response.json().run;
    expect(run).toMatchObject({ status: 'failed', failure: { code: 'HARNESS_RUN', message: expect.stringContaining('model-round budget exhausted') } });
    expect(model.requests).toHaveLength(2);
    expect(run.events.filter((event: { kind: string }) => event.kind === 'participant_completed')).toHaveLength(2);
  });
});

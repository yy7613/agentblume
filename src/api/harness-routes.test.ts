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
  it('Agent-as-ToolsはCoordinatorが割り当てた専門Agentへ委譲して最終応答を返す', async () => {
    const harness = body({ internalId: 'coordinator', pattern: 'agent-as-tools', topology: { pattern: 'agent-as-tools', coordinatorSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'] } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue(
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'delegate-review', name: 'ask_reviewer', arguments: { message: 'Review the draft.' } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'review note' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'coordinator final' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'coordinator' }, message: 'Write a launch note.', mode: 'preview' } });
    expect(response.json().run).toMatchObject({ status: 'succeeded', response: 'coordinator final' });
    expect(model.requests).toHaveLength(3);
    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toContain('ask_reviewer');
  });
  it('Handoffは許可済みtransitionだけを辿って次の担当Agentへ引き継ぐ', async () => {
    const harness = body({ internalId: 'handoff-review', pattern: 'handoff', topology: { pattern: 'handoff', startSlotId: 'writer', transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'review is required' }], autonomous: true } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue(
      { message: { role: 'assistant', content: 'Draft is ready. [[handoff:reviewer]]' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Reviewed final' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'handoff-review' }, message: 'Prepare the copy.', mode: 'preview' } });
    const run = response.json().run;
    expect(run).toMatchObject({ status: 'succeeded', response: 'Reviewed final' });
    expect(run.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'handoff_requested', message: 'writer -> reviewer' })]));
  });
  it('非自律Handoffはcheckpointへ会話を保存し、同じRunを次のユーザー入力で再開する', async () => {
    const harness = body({ internalId: 'interactive-handoff', pattern: 'handoff', topology: { pattern: 'handoff', startSlotId: 'writer', transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'review is needed' }], autonomous: false } });
    expect((await server.inject({ method: 'POST', url: '/harnesses', payload: harness })).statusCode).toBe(201);
    model.enqueue(
      { message: { role: 'assistant', content: 'Which launch audience should I address?' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Here is the enterprise launch note.' }, finishReason: 'stop' },
    );
    const started = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'interactive-handoff' }, message: 'Prepare a launch note.', mode: 'preview' } });
    expect(started.statusCode).toBe(200);
    const waiting = started.json().run;
    expect(waiting).toMatchObject({ status: 'waiting-input', response: 'Which launch audience should I address?', checkpoint: { kind: 'handoff-input', activeSlotId: 'writer' } });
    expect(waiting.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'input_requested' }), expect.objectContaining({ kind: 'checkpoint_saved' })]));
    const wrongResponse = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/responses`, payload: { scope, response: { kind: 'approval', decision: 'approve' } } });
    expect(wrongResponse.statusCode).toBe(422);
    expect(wrongResponse.json().error).toMatchObject({ code: 'HARNESS_RUN', message: expect.stringContaining('waiting for conversation input') });
    const resumed = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/responses`, payload: { scope, response: { kind: 'input', message: 'Enterprise administrators.' } } });
    const resumedRun = resumed.json().run;
    expect(resumedRun).toMatchObject({ status: 'waiting-input', response: 'Here is the enterprise launch note.', checkpoint: { kind: 'handoff-input', activeSlotId: 'writer' } });
    expect(resumedRun.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'harness_resumed' })]));
    expect(JSON.stringify(model.requests[1])).toContain('Which launch audience should I address?');
    const cancelled = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/cancel`, payload: { scope } });
    expect(cancelled.json().run.status).toBe('cancelled');
    expect(cancelled.json().run.checkpoint).toBeUndefined();
    const afterCancel = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/responses`, payload: { scope, response: { kind: 'input', message: 'Continue.' } } });
    expect(afterCancel.statusCode).toBe(422);
  });
  it('Group Chatはround上限まで指定順に発話し、最後の発話を返す', async () => {
    const harness = body({ internalId: 'group-review', pattern: 'group-chat', topology: { pattern: 'group-chat', participantSlotIds: ['writer', 'reviewer'], selector: 'fixed-order', maxRounds: 2 } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue(
      { message: { role: 'assistant', content: 'Writer proposal' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Reviewer refinement' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'group-review' }, message: 'Discuss the copy.', mode: 'preview' } });
    const run = response.json().run;
    expect(run).toMatchObject({ status: 'succeeded', response: 'Reviewer refinement' });
    expect(run.events.filter((event: { kind: string }) => event.kind === 'speaker_selected')).toHaveLength(2);
  });
  it('MagenticはManagerのdelegateとfinal protocolを解釈して終了する', async () => {
    const harness = body({ internalId: 'magentic-review', pattern: 'magentic', topology: { pattern: 'magentic', managerSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'], maxRounds: 2, maxStalls: 1, maxResets: 1, requirePlanSignoff: false } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue(
      { message: { role: 'assistant', content: '[[delegate:reviewer]] Check factual accuracy.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Facts verified.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '[[final]] Ready to publish.' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'magentic-review' }, message: 'Create a trustworthy announcement.', mode: 'preview' } });
    const run = response.json().run;
    expect(run).toMatchObject({ status: 'succeeded', response: 'Ready to publish.' });
    expect(run.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'plan_created' }), expect.objectContaining({ kind: 'progress_updated', slotId: 'reviewer' })]));
  });
  it('Magenticの計画は人手承認checkpointで停止し、修正依頼と承認を経て再開する', async () => {
    const harness = body({ internalId: 'approved-magentic', pattern: 'magentic', topology: { pattern: 'magentic', managerSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'], maxRounds: 2, maxStalls: 1, maxResets: 1, requirePlanSignoff: true } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue(
      { message: { role: 'assistant', content: '[[delegate:reviewer]] Verify the first proposal.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '[[delegate:publisher]] Use the reviewer feedback and prepare the release.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Release copy is ready.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '[[final]] Approved announcement.' }, finishReason: 'stop' },
    );
    const started = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'approved-magentic' }, message: 'Create the announcement.', mode: 'preview' } });
    const firstPlan = started.json().run;
    expect(firstPlan).toMatchObject({ status: 'waiting-approval', checkpoint: { kind: 'magentic-approval', selectedSlotId: 'reviewer' } });
    expect(firstPlan.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'approval_requested' })]));
    const revised = await server.inject({ method: 'POST', url: `/harness-runs/${firstPlan.runId}/responses`, payload: { scope, response: { kind: 'approval', decision: 'revise', feedback: 'Use the latest legal guidance.' } } });
    const revisedPlan = revised.json().run;
    expect(revisedPlan).toMatchObject({ status: 'waiting-approval', checkpoint: { kind: 'magentic-approval', selectedSlotId: 'publisher' } });
    const approved = await server.inject({ method: 'POST', url: `/harness-runs/${firstPlan.runId}/responses`, payload: { scope, response: { kind: 'approval', decision: 'approve' } } });
    const completed = approved.json().run;
    expect(completed).toMatchObject({ status: 'succeeded', response: 'Approved announcement.' });
    expect(completed.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'plan_revised', message: 'Use the latest legal guidance.' }), expect.objectContaining({ kind: 'harness_resumed' })]));
  });
  it('Magentic計画の却下はcheckpointを破棄してcancelledにし、その後の再開を拒否する', async () => {
    const harness = body({ internalId: 'rejected-magentic', pattern: 'magentic', topology: { pattern: 'magentic', managerSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'], maxRounds: 2, maxStalls: 1, maxResets: 1, requirePlanSignoff: true } });
    await server.inject({ method: 'POST', url: '/harnesses', payload: harness });
    model.enqueue({ message: { role: 'assistant', content: '[[delegate:reviewer]] Check the proposal.' }, finishReason: 'stop' });
    const started = await server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'rejected-magentic' }, message: 'Create an announcement.', mode: 'preview' } });
    const waiting = started.json().run;
    const rejected = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/responses`, payload: { scope, response: { kind: 'approval', decision: 'reject', feedback: 'Do not proceed without legal review.' } } });
    expect(rejected.json().run).toMatchObject({ status: 'cancelled' });
    expect(rejected.json().run.checkpoint).toBeUndefined();
    expect(rejected.json().run.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'harness_cancelled', message: 'Do not proceed without legal review.' })]));
    const afterReject = await server.inject({ method: 'POST', url: `/harness-runs/${waiting.runId}/responses`, payload: { scope, response: { kind: 'approval', decision: 'approve' } } });
    expect(afterReject.statusCode).toBe(422);
  });
});

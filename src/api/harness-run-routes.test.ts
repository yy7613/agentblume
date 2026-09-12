import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelProviderError, type ModelCapability, type ModelCompletion, type ModelCompletionRequest, type ModelProviderPort } from '../application/model/model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

interface PendingCompletion { readonly request: ModelCompletionRequest; readonly signal: AbortSignal | undefined; release(content: string): void; }

/**
 * 呼び出し側が release するまでモデル応答を返さない偽物。cancel の途中経過を HTTP 越しに観測するために、
 * 参加者を「実行中」のまま止めておく。abort されれば本物の provider と同じく失敗する。
 */
class BlockingModelProvider implements ModelProviderPort {
  readonly pending: PendingCompletion[] = [];
  private readonly waiters: Array<() => void> = [];
  capabilities(): readonly ModelCapability[] { return ['chat', 'tool-calling', 'structured-output', 'vision']; }
  complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new ModelProviderError('blocking request aborted'));
      if (signal?.aborted === true) { fail(); return; }
      signal?.addEventListener('abort', fail, { once: true });
      this.pending.push({ request, signal, release: (content) => { signal?.removeEventListener('abort', fail); resolve({ message: { role: 'assistant', content }, finishReason: 'stop' }); } });
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }
  /** count 回目のモデル呼び出しが始まるまで待つ。 */
  async calls(count: number): Promise<void> { while (this.pending.length < count) await new Promise<void>((wake) => this.waiters.push(wake)); }
}

describe('harness run routes: cancel', () => {
  let app: App; let server: FastifyInstance; let model: BlockingModelProvider;

  beforeEach(async () => {
    model = new BlockingModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app);
    for (const id of ['writer', 'reviewer']) {
      const response = await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: id, workingName: id, displayName: id, publishName: id, owner: 'owner', kind: 'normal', systemPrompt: `You are ${id}.`, tools: [] } });
      expect(response.statusCode).toBe(201);
    }
    const saved = await server.inject({ method: 'POST', url: '/harnesses', payload: {
      scope, internalId: 'content-review', workingName: 'Content review', displayName: 'Content review', publishName: 'content_review', owner: 'owner', pattern: 'sequential',
      slots: ['writer', 'reviewer'].map((id) => ({ id, label: id, purpose: `${id} work`, assignment: { internalId: id, version: '1.0.0' } })),
      topology: { pattern: 'sequential', orderedSlotIds: ['writer', 'reviewer'], contextMode: 'previous-response' },
    } });
    expect(saved.statusCode).toBe(201);
  });
  afterEach(async () => { await server.close(); app.close(); });

  function start() { return server.inject({ method: 'POST', url: '/harness-runs', payload: { scope, harness: { internalId: 'content-review' }, message: 'Write a launch note.', mode: 'preview' } }); }
  function cancel(runId: string) { return server.inject({ method: 'POST', url: `/harness-runs/${runId}/cancel`, payload: { scope } }); }
  async function runningRunId(): Promise<string> {
    const listed = await server.inject({ method: 'GET', url: '/harness-runs', query: { ...scope, status: 'running' } });
    expect(listed.statusCode).toBe(200);
    const runId: unknown = listed.json().runs[0]?.runId;
    expect(typeof runId).toBe('string');
    return runId as string;
  }

  it('実行中の Run: 200 cancelled で参加者が止まり、2人目は呼ばれず、開始側の応答も cancelled で確定する', async () => {
    const started = start();
    await model.calls(1);
    const runId = await runningRunId();

    const cancelled = await cancel(runId);

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({ runId, status: 'cancelled' });
    expect(model.pending[0]?.signal?.aborted).toBe(true);
    const response = await started;
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ runId, status: 'cancelled' });
    expect(model.pending).toHaveLength(1);

    const fetched = await server.inject({ method: 'GET', url: `/harness-runs/${runId}`, query: scope });
    const run = fetched.json().run;
    expect(run.status).toBe('cancelled');
    expect(run.response).toBeUndefined();
    expect(run.events.filter((event: { kind: string }) => event.kind === 'harness_cancelled')).toHaveLength(1);
    expect(run.events.map((event: { kind: string }) => event.kind)).not.toContain('harness_completed');
    expect(run.events.filter((event: { kind: string }) => event.kind === 'participant_started')).toHaveLength(1);
  });

  it('二重 cancel は冪等: 2回目も 200 で同じ記録を返し、イベントは増えない', async () => {
    const started = start();
    await model.calls(1);
    const runId = await runningRunId();
    const first = await cancel(runId);
    await started;

    const second = await cancel(runId);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('succeeded の Run への cancel は 200 で記録を変えない', async () => {
    const started = start();
    await model.calls(1); model.pending[0]!.release('draft');
    await model.calls(2); model.pending[1]!.release('reviewed');
    const done = (await started).json().run;
    expect(done).toMatchObject({ status: 'succeeded', response: 'reviewed' });

    const unchanged = await cancel(done.runId);

    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().run).toEqual(done);
    const fetched = await server.inject({ method: 'GET', url: `/harness-runs/${done.runId}`, query: scope });
    expect(fetched.json().run).toEqual(done);
  });

  it('cancel 済みの Run への応答は 422 HARNESS_RUN で、メッセージに現在の状態を含む', async () => {
    const started = start();
    await model.calls(1);
    const runId = await runningRunId();
    await cancel(runId);
    await started;

    const resumed = await server.inject({ method: 'POST', url: `/harness-runs/${runId}/responses`, payload: { scope, response: { kind: 'input', message: 'Continue.' } } });

    expect(resumed.statusCode).toBe(422);
    expect(resumed.json().error).toMatchObject({ code: 'HARNESS_RUN', message: `Harness run '${runId}' is not waiting for interaction (status: cancelled)` });
    expect(model.pending).toHaveLength(1);
  });

  it('未知の Run への cancel は 404 HARNESS_RUN_NOT_FOUND', async () => {
    const response = await cancel('missing-run');
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'HARNESS_RUN_NOT_FOUND' });
  });
});

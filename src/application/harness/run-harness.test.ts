import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAgentHarnessRepository } from '../../adapters/storage/in-memory-harness-repository';
import { InMemoryHarnessRunRepository } from '../../adapters/storage/in-memory-harness-run-repository';
import { createAgentHarness, DEFAULT_HARNESS_POLICIES, type HarnessPattern, type HarnessTopology } from '../../domain/harness/agent-harness';
import { HarnessRunCancelledError, HarnessRunError, HarnessRunNotFoundError } from '../../domain/harness/errors';
import { cancelHarnessRun } from '../../domain/harness/harness-run';
import { SemVer } from '../../domain/tool/semver';
import { RunFailedError } from '../agent/errors';
import type { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import { RunHarnessUseCase } from './run-harness';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.parse('1.0.0');

interface PendingParticipant { readonly agentId: string; readonly signal: AbortSignal | undefined; release(response: string): void; }

/**
 * 参加者（RunAgentPreviewUseCase.executeSaved）の偽物。呼び出し側が release するまで応答を返さない。
 * honourSignal（既定）なら abort で本物と同じく RunFailedError になり、false なら signal を無視して走り続ける。
 */
function fakeParticipants(options: { readonly honourSignal?: boolean; readonly failWith?: string } = {}) {
  const pending: PendingParticipant[] = [];
  const waiters: Array<() => void> = [];
  let counter = 0;
  const executeSaved = vi.fn((input: { readonly agentId: string }, signal?: AbortSignal) => new Promise<{ runId: string; response: string }>((resolve, reject) => {
    const runId = `child-${++counter}`;
    if (options.failWith !== undefined) { reject(new RunFailedError(runId, new Error(options.failWith))); return; }
    const fail = () => reject(new RunFailedError(runId, signal?.reason));
    if (options.honourSignal !== false) {
      if (signal?.aborted === true) { fail(); return; }
      signal?.addEventListener('abort', fail, { once: true });
    }
    pending.push({ agentId: input.agentId, signal, release: (response) => { signal?.removeEventListener('abort', fail); resolve({ runId, response }); } });
    waiters.splice(0).forEach((wake) => wake());
  }));
  /** count 人目の参加者が呼び出されるまで待つ。 */
  const started = async (count: number): Promise<void> => { while (pending.length < count) await new Promise<void>((wake) => waiters.push(wake)); };
  return { executeSaved, pending, started, agents: { executeSaved } as unknown as RunAgentPreviewUseCase };
}

function harnessOf(internalId: string, pattern: HarnessPattern, slotIds: readonly string[], topology: HarnessTopology, budget: Partial<typeof DEFAULT_HARNESS_POLICIES.budget> = {}) {
  return createAgentHarness({
    metadata: { internalId, workingName: internalId, displayName: internalId, publishName: internalId.replace(/-/g, '_'), version, owner: 'owner', state: 'published', tenant: scope },
    pattern,
    slots: slotIds.map((id) => ({ id, label: id, purpose: `${id} work`, assignment: { internalId: id, version } })),
    topology,
    policies: { ...DEFAULT_HARNESS_POLICIES, budget: { ...DEFAULT_HARNESS_POLICIES.budget, ...budget } },
  });
}

describe('RunHarnessUseCase interactive checkpoint guards', () => {
  let nowMs: number;
  let executeSaved: ReturnType<typeof vi.fn>;
  let runs: InMemoryHarnessRunRepository;
  let usecase: RunHarnessUseCase;

  beforeEach(async () => {
    nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    executeSaved = vi.fn().mockResolvedValue({ runId: 'child-1', response: 'Which audience should I address?' });
    const harnesses = new InMemoryAgentHarnessRepository();
    runs = new InMemoryHarnessRunRepository();
    await harnesses.save(createAgentHarness({
      metadata: { internalId: 'interactive-handoff', workingName: 'Interactive handoff', displayName: 'Interactive handoff', publishName: 'interactive_handoff', version, owner: 'owner', state: 'published', tenant: scope },
      pattern: 'handoff',
      slots: [
        { id: 'writer', label: 'Writer', purpose: 'Ask and draft', assignment: { internalId: 'writer', version } },
        { id: 'reviewer', label: 'Reviewer', purpose: 'Review work', assignment: { internalId: 'reviewer', version } },
      ],
      topology: { pattern: 'handoff', startSlotId: 'writer', transitions: [{ fromSlotId: 'writer', toSlotId: 'reviewer', condition: 'review is necessary' }], autonomous: false },
    }));
    await harnesses.save(harnessOf('approval-magentic', 'magentic', ['writer', 'reviewer', 'publisher'], { pattern: 'magentic', managerSlotId: 'writer', participantSlotIds: ['reviewer', 'publisher'], maxRounds: 2, maxStalls: 1, maxResets: 1, requirePlanSignoff: true }));
    usecase = new RunHarnessUseCase(harnesses, runs, { executeSaved } as unknown as RunAgentPreviewUseCase, () => 'harness-run-1', () => new Date(nowMs));
  });

  async function waitingRun() {
    return usecase.execute({ scope, harnessId: 'interactive-handoff', message: 'Prepare the announcement.', mode: 'preview' });
  }

  it('rejects an approval response for a Handoff input checkpoint without changing the checkpoint', async () => {
    const waiting = await waitingRun();

    await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'approval', decision: 'approve' } })).rejects.toThrow('waiting for conversation input');

    const stored = await runs.find(scope, waiting.runId);
    expect(stored).toMatchObject({ status: 'waiting-input', checkpoint: { kind: 'handoff-input', activeSlotId: 'writer' } });
    expect(executeSaved).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired checkpoint before starting another participant run', async () => {
    const waiting = await waitingRun();
    nowMs += 24 * 60 * 60 * 1_000;

    await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'input', message: 'Enterprise administrators.' } })).rejects.toThrow('checkpoint expired');

    const stored = await runs.find(scope, waiting.runId);
    expect(stored).toMatchObject({ status: 'waiting-input', checkpoint: { kind: 'handoff-input' } });
    expect(executeSaved).toHaveBeenCalledTimes(1);
  });

  describe('cancel（待機中・終端・未知の Run）', () => {
    it('waiting-input の Run を cancel すると参加者を実行せず cancelled になり、checkpoint は破棄される', async () => {
      const waiting = await waitingRun();
      executeSaved.mockClear();

      const cancelled = await usecase.cancel(scope, waiting.runId);

      expect(cancelled).toMatchObject({ status: 'cancelled', completedAt: new Date(nowMs).toISOString() });
      expect(cancelled.checkpoint).toBeUndefined();
      expect(cancelled.events.at(-1)).toMatchObject({ kind: 'harness_cancelled', message: 'Cancelled by user' });
      expect(executeSaved).not.toHaveBeenCalled();
      expect(await runs.find(scope, waiting.runId)).toEqual(cancelled);
    });

    it('waiting-approval の Run を cancel すると承認待ちの参加者を実行せず cancelled になる', async () => {
      executeSaved.mockResolvedValueOnce({ runId: 'child-manager', response: '[[delegate:reviewer]] Check the draft.' });
      const waiting = await usecase.execute({ scope, harnessId: 'approval-magentic', message: 'Create the announcement.', mode: 'preview' });
      expect(waiting).toMatchObject({ status: 'waiting-approval', checkpoint: { kind: 'magentic-approval', selectedSlotId: 'reviewer' } });
      executeSaved.mockClear();

      const cancelled = await usecase.cancel(scope, waiting.runId);

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.checkpoint).toBeUndefined();
      expect(executeSaved).not.toHaveBeenCalled();
      await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'approval', decision: 'approve' } })).rejects.toThrow(`Harness run '${waiting.runId}' is not waiting for interaction (status: cancelled)`);
      expect(executeSaved).not.toHaveBeenCalled();
    });

    it('二重 cancel は冪等: 2回目はイベントを足さず、同じレコードを返す', async () => {
      const waiting = await waitingRun();
      const first = await usecase.cancel(scope, waiting.runId);
      nowMs += 60_000;

      const second = await usecase.cancel(scope, waiting.runId);

      expect(second).toEqual(first);
      expect(second.events.filter((event) => event.kind === 'harness_cancelled')).toHaveLength(1);
      expect(await runs.find(scope, waiting.runId)).toEqual(first);
    });

    it('cancel 済みの Run は再開できず、メッセージに現在の状態を含む', async () => {
      const waiting = await waitingRun();
      await usecase.cancel(scope, waiting.runId);
      executeSaved.mockClear();

      await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'input', message: 'Continue.' } })).rejects.toThrow(`Harness run '${waiting.runId}' is not waiting for interaction (status: cancelled)`);

      expect(executeSaved).not.toHaveBeenCalled();
      expect((await runs.find(scope, waiting.runId))?.status).toBe('cancelled');
    });

    it('resume の読み取り直後に cancel が確定していれば、参加者を走らせずに拒む（waiting-* → running も compare-and-set）', async () => {
      const waiting = await waitingRun();
      executeSaved.mockClear();
      const original = runs.find.bind(runs);
      vi.spyOn(runs, 'find').mockImplementationOnce(async (findScope, runId) => {
        const record = await original(findScope, runId);
        await runs.save(cancelHarnessRun(record!, new Date(nowMs).toISOString()));
        return record;
      });

      await expect(usecase.resume({ scope, runId: waiting.runId, response: { kind: 'input', message: 'Continue.' } })).rejects.toThrow('is not waiting for interaction (status: cancelled)');

      expect(executeSaved).not.toHaveBeenCalled();
      expect((await runs.find(scope, waiting.runId))?.status).toBe('cancelled');
    });

    it('未知の Run への cancel は HarnessRunNotFoundError', async () => {
      await expect(usecase.cancel(scope, 'missing-run')).rejects.toBeInstanceOf(HarnessRunNotFoundError);
      await expect(usecase.cancel({ tenantId: 'other', workspaceId: 'workspace' }, (await waitingRun()).runId)).rejects.toBeInstanceOf(HarnessRunNotFoundError);
    });
  });
});

describe('RunHarnessUseCase cancel（実行中の Run を止める）', () => {
  const nowMs = Date.parse('2026-07-17T00:00:00.000Z');
  let harnesses: InMemoryAgentHarnessRepository;
  let runs: InMemoryHarnessRunRepository;
  let ids: number;

  beforeEach(async () => {
    harnesses = new InMemoryAgentHarnessRepository();
    runs = new InMemoryHarnessRunRepository();
    ids = 0;
    await harnesses.save(harnessOf('sequential-pair', 'sequential', ['writer', 'reviewer'], { pattern: 'sequential', orderedSlotIds: ['writer', 'reviewer'], contextMode: 'previous-response' }));
    await harnesses.save(harnessOf('concurrent-pair', 'concurrent', ['writer', 'reviewer'], { pattern: 'concurrent', participantSlotIds: ['writer', 'reviewer'], aggregation: 'collect' }));
    await harnesses.save(harnessOf('short-budget', 'sequential', ['writer', 'reviewer'], { pattern: 'sequential', orderedSlotIds: ['writer', 'reviewer'], contextMode: 'previous-response' }, { maxDurationMs: 1_000 }));
  });
  afterEach(() => { vi.useRealTimers(); });

  function build(fake: ReturnType<typeof fakeParticipants>): RunHarnessUseCase {
    return new RunHarnessUseCase(harnesses, runs, fake.agents, () => `harness-run-${++ids}`, () => new Date(nowMs));
  }
  const input = (harnessId: string) => ({ scope, harnessId, message: 'Write the launch note.', mode: 'preview' as const });

  it('sequential の1人目が実行中に cancel すると、その参加者は abort され、2人目は呼ばれず、cancelled で確定する', async () => {
    const fake = fakeParticipants();
    const usecase = build(fake);
    const start = usecase.execute(input('sequential-pair'));
    await fake.started(1);
    expect(usecase.inFlightRunCount()).toBe(1);

    const cancelled = await usecase.cancel(scope, 'harness-run-1');

    expect(cancelled.status).toBe('cancelled');
    expect(fake.pending[0]?.signal?.aborted).toBe(true);
    expect(fake.pending[0]?.signal?.reason).toBeInstanceOf(HarnessRunCancelledError);
    // start の Promise は reject せず、確定した cancelled レコードで resolve する。
    const result = await start;
    expect(result.status).toBe('cancelled');
    expect(fake.executeSaved).toHaveBeenCalledTimes(1);
    expect(fake.executeSaved.mock.calls[0]?.[0]).toMatchObject({ agentId: 'writer' });
    expect(usecase.inFlightRunCount()).toBe(0);
    // 保存済みは cancel() が確定した内容のまま: worker の遅いイベント（participant_failed など）は紛れ込まない。
    const stored = await runs.find(scope, 'harness-run-1');
    expect(result).toEqual(stored);
    expect(stored).toMatchObject({ status: 'cancelled', completedAt: new Date(nowMs).toISOString() });
    expect(stored?.response).toBeUndefined();
    expect(stored?.events.map((event) => event.kind)).toEqual(['harness_started', 'participant_started', 'harness_cancelled']);
    expect(stored?.events.at(-1)).toMatchObject({ kind: 'harness_cancelled', message: 'Cancelled by user' });
  });

  it('signal を無視する参加者が cancel 後に成功を返しても、compare-and-set が上書きを拒み cancelled のまま残る', async () => {
    const fake = fakeParticipants({ honourSignal: false });
    const usecase = build(fake);
    const start = usecase.execute(input('sequential-pair'));
    await fake.started(1);
    await usecase.cancel(scope, 'harness-run-1');

    fake.pending[0]!.release('late draft');
    const result = await start;

    expect(result.status).toBe('cancelled');
    expect(fake.executeSaved).toHaveBeenCalledTimes(1);
    const stored = await runs.find(scope, 'harness-run-1');
    expect(stored?.status).toBe('cancelled');
    expect(stored?.response).toBeUndefined();
    expect(stored?.events.map((event) => event.kind)).toEqual(['harness_started', 'participant_started', 'harness_cancelled']);
    expect(usecase.inFlightRunCount()).toBe(0);
  });

  it('concurrent は実行中の全参加者が同時に abort される', async () => {
    const fake = fakeParticipants();
    const usecase = build(fake);
    const start = usecase.execute(input('concurrent-pair'));
    await fake.started(2);

    const cancelled = await usecase.cancel(scope, 'harness-run-1');

    expect(cancelled.status).toBe('cancelled');
    expect(fake.pending.map((participant) => participant.signal?.aborted)).toEqual([true, true]);
    expect(fake.pending.every((participant) => participant.signal?.reason instanceof HarnessRunCancelledError)).toBe(true);
    const result = await start;
    expect(result.status).toBe('cancelled');
    expect(fake.executeSaved).toHaveBeenCalledTimes(2);
    expect((await runs.find(scope, 'harness-run-1'))?.status).toBe('cancelled');
    expect(usecase.inFlightRunCount()).toBe(0);
  });

  it('cancel が別経路で保存済みになった後の worker イベントは保存されず、実行中の参加者も止まる', async () => {
    const fake = fakeParticipants({ honourSignal: false });
    const usecase = build(fake);
    const start = usecase.execute(input('sequential-pair'));
    await fake.started(1);
    // このプロセスの cancel() を通さず保存済み行だけを cancelled にする（別プロセスからの cancel を模す）。
    const external = cancelHarnessRun((await runs.find(scope, 'harness-run-1'))!, '2026-07-17T00:00:05.000Z');
    await runs.save(external);

    fake.pending[0]!.release('draft');
    const result = await start;

    // 保存済みレコードをそのまま結果にし、メモリ上のコピー（participant_completed 以降）は書き戻さない。
    expect(result).toEqual(external);
    expect(await runs.find(scope, 'harness-run-1')).toEqual(external);
    expect(fake.pending[0]?.signal?.aborted).toBe(true);
    expect(fake.pending[0]?.signal?.reason).toBeInstanceOf(HarnessRunCancelledError);
    expect(fake.executeSaved).toHaveBeenCalledTimes(1);
    expect(usecase.inFlightRunCount()).toBe(0);
  });

  describe('終端・未知の Run への cancel', () => {
    it('succeeded の Run への cancel は記録を変えず、イベントも足さない', async () => {
      const fake = fakeParticipants();
      const usecase = build(fake);
      const start = usecase.execute(input('sequential-pair'));
      await fake.started(1); fake.pending[0]!.release('draft');
      await fake.started(2); fake.pending[1]!.release('reviewed');
      const done = await start;
      expect(done).toMatchObject({ status: 'succeeded', response: 'reviewed' });

      const unchanged = await usecase.cancel(scope, 'harness-run-1');

      expect(unchanged).toEqual(done);
      expect(await runs.find(scope, 'harness-run-1')).toEqual(done);
    });

    it('failed の Run への cancel は記録を変えず、イベントも足さない', async () => {
      const fake = fakeParticipants({ failWith: 'model exploded' });
      const usecase = build(fake);
      const failed = await usecase.execute(input('sequential-pair'));
      expect(failed).toMatchObject({ status: 'failed', failure: { message: expect.stringContaining('model exploded') } });

      const unchanged = await usecase.cancel(scope, 'harness-run-1');

      expect(unchanged).toEqual(failed);
      expect(await runs.find(scope, 'harness-run-1')).toEqual(failed);
    });

    it('未知の Run への cancel は HarnessRunNotFoundError', async () => {
      await expect(build(fakeParticipants()).cancel(scope, 'missing-run')).rejects.toBeInstanceOf(HarnessRunNotFoundError);
    });
  });

  describe('abort の理由を区別する（利用者の cancel ではない中断は failed）', () => {
    it('時間予算の超過は failed（予算メッセージ）であり、cancelled ではない', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fake = fakeParticipants();
      const usecase = build(fake);
      const start = usecase.execute(input('short-budget'));
      await fake.started(1);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await start;

      expect(result.status).toBe('failed');
      expect(result.failure).toEqual({ code: 'HARNESS_RUN', message: 'Harness duration budget exceeded: 1000ms' });
      expect(fake.pending[0]?.signal?.reason).toBeInstanceOf(HarnessRunError);
      expect(fake.pending[0]?.signal?.reason).not.toBeInstanceOf(HarnessRunCancelledError);
      expect(result.events.map((event) => event.kind)).toContain('harness_failed');
      expect(result.events.map((event) => event.kind)).not.toContain('harness_cancelled');
      expect((await runs.find(scope, 'harness-run-1'))?.status).toBe('failed');
      expect(usecase.inFlightRunCount()).toBe(0);
    });

    it('クライアント切断（start の signal）は failed であり、利用者の cancel とは区別される', async () => {
      const fake = fakeParticipants();
      const usecase = build(fake);
      const client = new AbortController();
      const start = usecase.execute(input('sequential-pair'), client.signal);
      await fake.started(1);

      client.abort();
      const result = await start;

      expect(result.status).toBe('failed');
      expect(result.failure?.message).toContain('aborted');
      expect(fake.pending[0]?.signal?.reason).not.toBeInstanceOf(HarnessRunCancelledError);
      expect(result.events.map((event) => event.kind)).not.toContain('harness_cancelled');
      expect(fake.executeSaved).toHaveBeenCalledTimes(1);
      expect((await runs.find(scope, 'harness-run-1'))?.status).toBe('failed');
      expect(usecase.inFlightRunCount()).toBe(0);
    });
  });
});

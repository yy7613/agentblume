import { describe, expect, it, vi } from 'vitest';
import type { RunFactoryUseCase } from '../../application/factory/run-factory';
import { InProcessFactoryWorker } from './in-process-factory-worker';

const tick = async (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
/** `execute(scope, runId, signal)` だけを持つ最小のRunFactory差し替え。 */
const runner = (execute: unknown): RunFactoryUseCase => ({ execute } as unknown as RunFactoryUseCase);
const scope = { tenantId: 't', workspaceId: 'w' };

describe('InProcessFactoryWorker', () => {
  it('重複enqueueを1回だけ逐次実行する', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const worker = new InProcessFactoryWorker(runner(execute));
    worker.enqueue(scope, 'run'); worker.enqueue(scope, 'run'); await tick(); await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    worker.shutdown();
  });

  it('active実行をcancelするとAbortSignalを中断する', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_scope: unknown, _id: string, value: AbortSignal) => {
      signal = value;
      await new Promise<void>((resolve) => { value.addEventListener('abort', () => { resolve(); }, { once: true }); });
    });
    const worker = new InProcessFactoryWorker(runner(execute));
    worker.enqueue(scope, 'run'); await tick(); worker.cancel(scope, 'run'); await tick();
    expect(signal?.aborted).toBe(true);
    worker.shutdown();
  });

  it('runnerが失敗してもキューの処理を続ける', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const worker = new InProcessFactoryWorker(runner(execute));
    worker.enqueue(scope, 'first'); worker.enqueue(scope, 'second');
    await tick(); await tick(); await tick();
    expect(execute).toHaveBeenCalledTimes(2);
    worker.shutdown();
  });

  it('握り潰した失敗をloggerへ残す（無音だと「キューは回っているのに何も進まない」が見えない）', async () => {
    const warns: { message: string; context?: Record<string, unknown> }[] = [];
    const logger = { info: () => {}, warn: (message: string, context?: Record<string, unknown>) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
    const execute = vi.fn().mockRejectedValue(new Error('run record could not be saved'));
    const worker = new InProcessFactoryWorker(runner(execute), logger);
    worker.enqueue(scope, 'run');
    await tick(); await tick();
    expect(warns).toEqual([{ message: 'factory run ended with an unhandled error', context: { runId: 'run', reason: 'run record could not be saved' } }]);
    worker.shutdown();
  });

  describe('drainInFlight（shutdown猶予）', () => {
    it('実行中が無ければ即trueで返る', async () => {
      const worker = new InProcessFactoryWorker(runner(vi.fn()));
      await expect(worker.drainInFlight(5_000)).resolves.toBe(true);
    });

    it('猶予内に終わるRunは中断せず待つ', async () => {
      let signal: AbortSignal | undefined;
      const execute = vi.fn(async (_scope: unknown, _id: string, value: AbortSignal) => {
        signal = value;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      });
      const worker = new InProcessFactoryWorker(runner(execute));
      worker.enqueue(scope, 'run'); await tick();
      await expect(worker.drainInFlight(5_000)).resolves.toBe(true);
      expect(signal?.aborted).toBe(false);
    });

    it('猶予を超えたRunはabortする', async () => {
      let signal: AbortSignal | undefined;
      const execute = vi.fn(async (_scope: unknown, _id: string, value: AbortSignal) => {
        signal = value;
        await new Promise<void>((resolve) => { value.addEventListener('abort', () => { resolve(); }, { once: true }); });
      });
      const worker = new InProcessFactoryWorker(runner(execute));
      worker.enqueue(scope, 'run'); await tick();
      await expect(worker.drainInFlight(5)).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    });

    it('待機中は新規enqueueを受け付けず、未実行のキューも実行しない', async () => {
      const execute = vi.fn(async (_scope: unknown, _id: string) => { await new Promise((resolve) => { setTimeout(resolve, 10); }); });
      const worker = new InProcessFactoryWorker(runner(execute));
      worker.enqueue(scope, 'first'); worker.enqueue(scope, 'second'); await tick();
      const drained = worker.drainInFlight(5_000);
      worker.enqueue(scope, 'third');
      await expect(drained).resolves.toBe(true);
      await tick();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe('first');
    });
  });
});

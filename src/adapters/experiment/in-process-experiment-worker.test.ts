import { describe, expect, it, vi } from 'vitest';
import type { RunExperimentUseCase } from '../../application/evaluation/run-experiment';
import { InProcessExperimentWorker } from './in-process-experiment-worker';

const tick = async () => new Promise((resolve) => setTimeout(resolve, 0));
describe('InProcessExperimentWorker', () => {
  it('重複enqueueを1回だけ逐次実行する', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const worker = new InProcessExperimentWorker({ execute } as unknown as RunExperimentUseCase);
    const scope = { tenantId: 't', workspaceId: 'w' };
    worker.enqueue(scope, 'exp'); worker.enqueue(scope, 'exp'); await tick(); await tick();
    expect(execute).toHaveBeenCalledTimes(1); worker.shutdown();
  });
  it('active実行をcancelするとAbortSignalを中断する', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_scope, _id, value: AbortSignal) => { signal = value; await new Promise<void>((resolve) => value.addEventListener('abort', () => resolve(), { once: true })); });
    const worker = new InProcessExperimentWorker({ execute } as unknown as RunExperimentUseCase);
    const scope = { tenantId: 't', workspaceId: 'w' }; worker.enqueue(scope, 'exp'); await tick(); worker.cancel(scope, 'exp'); await tick();
    expect(signal?.aborted).toBe(true); worker.shutdown();
  });

  describe('drainInFlight（shutdown猶予）', () => {
    const scope = { tenantId: 't', workspaceId: 'w' };

    it('実行中が無ければ即trueで返る', async () => {
      const worker = new InProcessExperimentWorker({ execute: vi.fn() } as unknown as RunExperimentUseCase);
      await expect(worker.drainInFlight(5_000)).resolves.toBe(true);
    });

    it('猶予内に終わるジョブは中断せず待つ', async () => {
      let signal: AbortSignal | undefined;
      const execute = vi.fn(async (_scope, _id, value: AbortSignal) => { signal = value; await new Promise((resolve) => setTimeout(resolve, 10)); });
      const worker = new InProcessExperimentWorker({ execute } as unknown as RunExperimentUseCase);
      worker.enqueue(scope, 'exp'); await tick();
      await expect(worker.drainInFlight(5_000)).resolves.toBe(true);
      expect(signal?.aborted).toBe(false);
    });

    it('猶予を超えたジョブはabortする', async () => {
      let signal: AbortSignal | undefined;
      const execute = vi.fn(async (_scope, _id, value: AbortSignal) => { signal = value; await new Promise<void>((resolve) => value.addEventListener('abort', () => resolve(), { once: true })); });
      const worker = new InProcessExperimentWorker({ execute } as unknown as RunExperimentUseCase);
      worker.enqueue(scope, 'exp'); await tick();
      await expect(worker.drainInFlight(5)).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    });

    it('待機中は新規enqueueを受け付けず、未実行のキューも実行しない', async () => {
      const execute = vi.fn(async (_scope: unknown, _id: string) => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const worker = new InProcessExperimentWorker({ execute } as unknown as RunExperimentUseCase);
      worker.enqueue(scope, 'first'); worker.enqueue(scope, 'second'); await tick();
      const drained = worker.drainInFlight(5_000);
      worker.enqueue(scope, 'third');
      await expect(drained).resolves.toBe(true);
      await tick();
      // 実行されたのは猶予に入った時点で実行中だった 'first' だけ。
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe('first');
    });
  });
});

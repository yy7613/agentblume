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
});

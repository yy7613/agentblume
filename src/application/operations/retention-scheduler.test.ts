import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryOperationsRepository } from '../../adapters/storage/in-memory-operations-repository';
import { InMemoryRunRepository } from '../../adapters/storage/in-memory-run-repository';
import { succeedRun, startRun, type RunRecord } from '../../domain/run/run';
import type { RunRetentionResult } from '../../domain/run/run-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { LoggerPort } from './logger';
import { RetentionUseCase } from './retention';
import { RetentionScheduler } from './retention-scheduler';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const other: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
const NOW = new Date('2026-07-28T09:00:00.000Z');
const DAY = 86_400_000;

interface Recorded { readonly level: 'info' | 'warn' | 'error'; readonly message: string; readonly context?: Record<string, unknown> }

function recordingLogger(): LoggerPort & { readonly lines: Recorded[] } {
  const lines: Recorded[] = [];
  const push = (level: Recorded['level']) => (message: string, context?: Record<string, unknown>): void => {
    lines.push({ level, message, ...(context === undefined ? {} : { context: { ...context } }) });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

/** `startedAt` が古い、payload を持つ完了済みRun。 */
function oldRun(runId: string, tenant: TenantScope, daysAgo: number): RunRecord {
  const startedAt = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  return succeedRun(startRun({ runId, scope: tenant, mode: 'preview', tool: { internalId: 'tool', version: '1.0.0' }, startedAt }), {
    response: 'sensitive', trace: [{ sequence: 1, kind: 'model-response', content: 'trace' }], usage: {},
    completedAt: startedAt,
  });
}

describe('RetentionUseCase.applyAll', () => {
  it('runsを持つ全スコープへ適用し、合計を返す', async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(oldRun('a', scope, 400));
    await runs.save(oldRun('b', other, 400));
    const useCase = new RetentionUseCase(runs, new InMemoryOperationsRepository(), () => NOW);

    const result = await useCase.applyAll();

    expect(result).toMatchObject({ scopes: 2, failures: 0, deleted: 2 });
    await expect(runs.find(scope, 'a')).resolves.toBeNull();
    await expect(runs.find(other, 'b')).resolves.toBeNull();
  });

  it('Runがまだ無いスコープも `always` で対象にできる（重複しても1回だけ）', async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(oldRun('a', scope, 400));
    const useCase = new RetentionUseCase(runs, new InMemoryOperationsRepository(), () => NOW);

    await expect(useCase.applyAll([scope, other])).resolves.toMatchObject({ scopes: 2, failures: 0 });
  });

  it('1スコープが失敗しても残りを掃除し、理由をログへ残す', async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(oldRun('a', scope, 400));
    await runs.save(oldRun('b', other, 400));
    const applyRetention = runs.applyRetention.bind(runs);
    runs.applyRetention = async (target, options): Promise<RunRetentionResult> => {
      if (target.tenantId === 'tenant') throw new Error('db is locked');
      return applyRetention(target, options);
    };
    const logger = recordingLogger();
    const useCase = new RetentionUseCase(runs, new InMemoryOperationsRepository(), () => NOW, logger);

    const result = await useCase.applyAll();

    expect(result).toMatchObject({ scopes: 1, failures: 1, deleted: 1 });
    await expect(runs.find(other, 'b')).resolves.toBeNull();
    expect(logger.lines).toEqual([{ level: 'warn', message: 'retention failed for one scope', context: { scope: 'tenant workspace', reason: 'db is locked' } }]);
  });
});

describe('RetentionScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function scheduler(intervalMs: number, applyAll: () => Promise<unknown>, logger?: LoggerPort): RetentionScheduler {
    const retention = { applyAll } as unknown as RetentionUseCase;
    return new RetentionScheduler(retention, { intervalMs, scopes: [scope], ...(logger === undefined ? {} : { logger }) });
  }

  it('起動直後には走らず、1インターバル経過してから走る', async () => {
    const applyAll = vi.fn().mockResolvedValue({ scopes: 1, failures: 0, payloadRedacted: 0, traceRedacted: 0, deleted: 4, feedbackDeleted: 0, aggregateBucketsDeleted: 0 });
    const target = scheduler(DAY, applyAll);

    expect(target.start()).toBe(true);
    expect(applyAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(applyAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(applyAll).toHaveBeenCalledTimes(1);
    expect(applyAll).toHaveBeenCalledWith([scope]);

    await vi.advanceTimersByTimeAsync(DAY);
    expect(applyAll).toHaveBeenCalledTimes(2);
    target.stop();
  });

  it('削除件数をinfoログへ出す', async () => {
    const logger = recordingLogger();
    const target = scheduler(DAY, async () => ({ scopes: 1, failures: 0, payloadRedacted: 1, traceRedacted: 2, deleted: 3, feedbackDeleted: 4, aggregateBucketsDeleted: 5 }), logger);
    target.start();

    await vi.advanceTimersByTimeAsync(DAY);

    expect(logger.lines).toEqual([{ level: 'info', message: 'retention sweep completed', context: { scopes: 1, failures: 0, payloadRedacted: 1, traceRedacted: 2, deleted: 3, feedbackDeleted: 4, aggregateBucketsDeleted: 5 } }]);
    target.stop();
  });

  it('intervalMs=0 は無効（タイマーを登録しない）', async () => {
    const applyAll = vi.fn();
    const target = scheduler(0, applyAll);

    expect(target.start()).toBe(false);
    expect(target.running).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY * 10);
    expect(applyAll).not.toHaveBeenCalled();
  });

  it('二重startでもタイマーは1本だけ', async () => {
    const applyAll = vi.fn().mockResolvedValue({ scopes: 0, failures: 0, payloadRedacted: 0, traceRedacted: 0, deleted: 0, feedbackDeleted: 0, aggregateBucketsDeleted: 0 });
    const target = scheduler(DAY, applyAll);
    target.start(); target.start();

    await vi.advanceTimersByTimeAsync(DAY);

    expect(applyAll).toHaveBeenCalledTimes(1);
    target.stop();
  });

  it('失敗しても次のインターバルで再実行する（プロセスは落とさない）', async () => {
    const logger = recordingLogger();
    const applyAll = vi.fn().mockRejectedValueOnce(new Error('db is locked')).mockResolvedValue({ scopes: 1, failures: 0, payloadRedacted: 0, traceRedacted: 0, deleted: 0, feedbackDeleted: 0, aggregateBucketsDeleted: 0 });
    const target = scheduler(DAY, applyAll, logger);
    target.start();

    await vi.advanceTimersByTimeAsync(DAY);
    expect(logger.lines).toEqual([{ level: 'error', message: 'retention sweep failed', context: { reason: 'db is locked' } }]);

    await vi.advanceTimersByTimeAsync(DAY);
    expect(applyAll).toHaveBeenCalledTimes(2);
    expect(logger.lines.at(-1)).toMatchObject({ level: 'info', message: 'retention sweep completed' });
    target.stop();
  });

  it('前回の掃除が終わる前に次のインターバルが来ても二重に走らせない', async () => {
    let release: (() => void) | undefined;
    const applyAll = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { scopes: 1, failures: 0, payloadRedacted: 0, traceRedacted: 0, deleted: 0, feedbackDeleted: 0, aggregateBucketsDeleted: 0 };
    });
    const target = scheduler(DAY, applyAll);
    target.start();

    await vi.advanceTimersByTimeAsync(DAY);
    expect(applyAll).toHaveBeenCalledTimes(1);
    // 掃除が終わらないまま次のインターバルが来ても相乗りする。
    await vi.advanceTimersByTimeAsync(DAY);
    expect(applyAll).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(applyAll).toHaveBeenCalledTimes(2);
    target.stop();
    release?.();
  });

  it('stopでタイマーが止まる（shutdown経路）。未起動のstopは何もしない', async () => {
    const applyAll = vi.fn().mockResolvedValue({ scopes: 0, failures: 0, payloadRedacted: 0, traceRedacted: 0, deleted: 0, feedbackDeleted: 0, aggregateBucketsDeleted: 0 });
    const target = scheduler(DAY, applyAll);
    expect(() => { target.stop(); }).not.toThrow();

    target.start();
    expect(target.running).toBe(true);
    target.stop();
    expect(target.running).toBe(false);

    await vi.advanceTimersByTimeAsync(DAY * 3);
    expect(applyAll).not.toHaveBeenCalled();
  });
});

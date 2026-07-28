/**
 * 「握り潰すが無音にはしない」境界の回帰テスト。
 *
 * 観測系の失敗をAgent実行へ伝播させない方針は維持したまま、`LoggerPort` へ痕跡が残ることを確かめる。
 * ログが消えると、メトリクスが1件も保存されていないような障害が再び不可視になる。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryOperationsRepository } from '../../adapters/storage/in-memory-operations-repository';
import { InMemoryRunRepository } from '../../adapters/storage/in-memory-run-repository';
import { FeedbackValidationError } from '../../domain/operations/errors';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { startRun, succeedRun, type RunRecord } from '../../domain/run/run';
import { RunNotFoundError } from '../../domain/run/errors';
import { SubmitRunFeedbackUseCase } from './feedback';
import type { LoggerPort } from './logger';
import type { PricingPort } from './pricing';
import { estimateRunCost, recordRunMetricSafely } from './run-observability';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

interface Recorded { readonly message: string; readonly context?: Record<string, unknown> }
function fakeLogger(): LoggerPort & { readonly warns: Recorded[] } {
  const warns: Recorded[] = [];
  return { warns, info: () => {}, warn: (message, context) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
}

function completedRun(runId = 'run-1'): RunRecord {
  const started = startRun({ runId, scope, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-28T08:00:00.000Z' });
  return succeedRun(started, {
    response: 'ok', trace: [], usage: { totalTokens: 3 },
    latency: { totalMs: 10, modelMs: 8, toolMs: 2 }, completedAt: '2026-07-28T08:00:01.000Z',
  });
}

describe('estimateRunCost', () => {
  const model = { provider: 'lm-studio', model: 'local', modelConfigHash: 'h' };

  it('価格表の失敗はundefinedに落とすが、理由をwarnへ残す', async () => {
    const logger = fakeLogger();
    const pricing: PricingPort = { findPrice: async () => { throw new Error('catalog is broken'); } };

    await expect(estimateRunCost(pricing, model, { promptTokens: 10 }, '2026-07-28T08:00:00.000Z', logger)).resolves.toBeUndefined();

    expect(logger.warns).toEqual([{ message: 'run cost estimation failed', context: { provider: 'lm-studio', model: 'local', reason: 'catalog is broken' } }]);
  });

  it('価格が見つからないのは障害ではないのでログを出さない', async () => {
    const logger = fakeLogger();
    const pricing: PricingPort = { findPrice: async () => null };

    await expect(estimateRunCost(pricing, model, { promptTokens: 10 }, '2026-07-28T08:00:00.000Z', logger)).resolves.toBeUndefined();

    expect(logger.warns).toEqual([]);
  });
});

describe('recordRunMetricSafely', () => {
  it('集計保存の失敗を握り潰しつつ、warnへ残す', async () => {
    const logger = fakeLogger();
    const operations = { recordRunMetric: async () => { throw new Error('db is locked'); } } as unknown as OperationsRepository;

    await expect(recordRunMetricSafely(operations, completedRun(), logger)).resolves.toBeUndefined();

    expect(logger.warns).toEqual([{ message: 'run metric was not recorded', context: { runId: 'run-1', reason: 'db is locked' } }]);
  });

  it('成功時はログを出さない', async () => {
    const logger = fakeLogger();
    await recordRunMetricSafely(new InMemoryOperationsRepository(), completedRun(), logger);
    expect(logger.warns).toEqual([]);
  });
});

describe('SubmitRunFeedbackUseCase', () => {
  async function seed(): Promise<InMemoryRunRepository> {
    const runs = new InMemoryRunRepository();
    await runs.save(completedRun());
    return runs;
  }

  it('集計の失敗ではフィードバック本体を落とさず、warnへ残す', async () => {
    const logger = fakeLogger();
    const operations = new InMemoryOperationsRepository();
    operations.recordFeedbackMetric = async (): Promise<never> => { throw new Error('db is locked'); };
    const useCase = new SubmitRunFeedbackUseCase(await seed(), operations, () => 'feedback-1', () => new Date('2026-07-28T09:00:00.000Z'), logger);

    const feedback = await useCase.execute({ scope, runId: 'run-1', thumb: 'up', issueTags: [] });

    expect(feedback).toMatchObject({ id: 'feedback-1', runId: 'run-1', thumb: 'up' });
    await expect(operations.findFeedback(scope, 'run-1')).resolves.toMatchObject({ id: 'feedback-1' });
    expect(logger.warns).toEqual([{ message: 'feedback metric was not recorded', context: { runId: 'run-1', reason: 'db is locked' } }]);
  });

  it('集計が成功すればログを出さない', async () => {
    const logger = fakeLogger();
    const useCase = new SubmitRunFeedbackUseCase(await seed(), new InMemoryOperationsRepository(), () => 'feedback-1', () => new Date('2026-07-28T09:00:00.000Z'), logger);
    await useCase.execute({ scope, runId: 'run-1', thumb: 'down', issueTags: ['slow', 'slow', ' '] });
    expect(logger.warns).toEqual([]);
  });

  it('未存在Run・版なしRunは業務エラーとして弾く（握り潰さない）', async () => {
    const runs = await seed();
    await runs.save(startRun({ runId: 'run-tool', scope, mode: 'preview', tool: { internalId: 'tool', version: '1.0.0' }, startedAt: '2026-07-28T08:00:00.000Z' }));
    const useCase = new SubmitRunFeedbackUseCase(runs, new InMemoryOperationsRepository());
    await expect(useCase.execute({ scope, runId: 'missing', thumb: 'up', issueTags: [] })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(useCase.execute({ scope, runId: 'run-tool', thumb: 'up', issueTags: [] })).rejects.toBeInstanceOf(FeedbackValidationError);
  });
});

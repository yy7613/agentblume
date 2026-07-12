import { describe, expect, it } from 'vitest';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { QueryOperationsStatusUseCase } from './query-operations-status';

describe('QueryOperationsStatusUseCase', () => {
  it('日次pointと全期間p50/p95、失敗率、feedback率を算出する', async () => {
    const metrics = [{ scope: { tenantId: 't', workspaceId: 'w' }, bucketStart: '2026-07-09T00:00:00.000Z', runCount: 4, failureCount: 1, latencySamples: [10, 20, 30, 100], totalTokens: 400, estimatedCost: 0.04, pricedRunCount: 3, feedbackCount: 2 }, { scope: { tenantId: 't', workspaceId: 'w' }, bucketStart: '2026-07-10T00:00:00.000Z', runCount: 1, failureCount: 0, latencySamples: [40], totalTokens: 100, estimatedCost: 0.01, pricedRunCount: 1, feedbackCount: 1 }];
    const repo = { listDailyMetrics: async () => metrics } as unknown as OperationsRepository;
    const result = await new QueryOperationsStatusUseCase(repo, () => new Date('2026-07-10T12:00:00.000Z')).execute({ tenantId: 't', workspaceId: 'w' }, 2);
    expect(result.from).toBe('2026-07-09T00:00:00.000Z');
    expect(result.summary).toEqual({ runCount: 5, failureRate: 0.2, p50LatencyMs: 30, p95LatencyMs: 100, totalTokens: 500, estimatedCost: 0.05, pricedRunCount: 4, feedbackRate: 0.6 });
    expect(result.points[0]).toMatchObject({ p50LatencyMs: 20, p95LatencyMs: 100, failureRate: 0.25, feedbackRate: 0.5 });
  });

  it('Runが無い期間は全指標を0として返す', async () => {
    const repo = { listDailyMetrics: async () => [] } as unknown as OperationsRepository;
    const result = await new QueryOperationsStatusUseCase(repo, () => new Date('2026-07-10T12:00:00.000Z')).execute({ tenantId: 't', workspaceId: 'w' });
    expect(result.summary).toEqual({ runCount: 0, failureRate: 0, p50LatencyMs: 0, p95LatencyMs: 0, totalTokens: 0, estimatedCost: 0, pricedRunCount: 0, feedbackRate: 0 });
    expect(result.points).toEqual([]);
  });
});

import { expect } from 'vitest';
import type { OperationsRepository } from '../../domain/operations/operations-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

export async function operationsRepositoryContract(repo: OperationsRepository): Promise<void> {
  const feedback = { id: 'feedback-1', scope, runId: 'run-1', agent: { internalId: 'agent-1', version: '1.0.0' }, thumb: 'down' as const, rating: 2, comment: 'incorrect', issueTags: ['incorrect'], createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z' };
  await repo.saveFeedback(feedback);
  await expect(repo.findFeedback(scope, 'run-1')).resolves.toEqual(feedback);
  await expect(repo.findFeedback({ tenantId: 'other', workspaceId: 'workspace' }, 'run-1')).resolves.toBeNull();

  await repo.recordRunMetric({ scope, recordedAt: '2026-07-01T10:00:00.000Z', status: 'succeeded', purpose: 'interactive', latencyMs: 10, totalTokens: 12, estimatedCost: 0.2 });
  await repo.recordRunMetric({ scope, recordedAt: '2026-07-01T11:00:00.000Z', status: 'failed', latencyMs: 30 });
  await repo.recordFeedbackMetric(scope, '2026-07-01T12:00:00.000Z');
  await expect(repo.listDailyMetrics(scope)).resolves.toEqual([expect.objectContaining({ bucketStart: '2026-07-01T00:00:00.000Z', runCount: 2, failureCount: 1, latencySamples: [10, 30], totalTokens: 12, estimatedCost: 0.2, pricedRunCount: 1, feedbackCount: 1 })]);

  const policy = { scope, payloadDays: 7, traceDays: 3, aggregateDays: 90, auditDays: 400, updatedAt: '2026-07-02T00:00:00.000Z' };
  await repo.saveRetentionPolicy(policy);
  await expect(repo.getRetentionPolicy(scope)).resolves.toEqual(policy);
  await expect(repo.deleteFeedbackBefore(scope, '2026-07-02T00:00:00.000Z')).resolves.toBe(1);
  await expect(repo.deleteMetricsBefore(scope, '2026-07-02T00:00:00.000Z')).resolves.toBe(1);
}


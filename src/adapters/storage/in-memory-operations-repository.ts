import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { utcDayStart, type OperationsDailyMetric, type RetentionPolicy, type RunFeedback, type RunMetricSample } from '../../domain/operations/operations';
import { deserializeDailyMetric, deserializeFeedback, deserializeRetentionPolicy, serializeDailyMetric, serializeFeedback, serializeRetentionPolicy } from '../../domain/operations/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';

const scopeKey = (scope: TenantScope): string => `${scope.tenantId}\u0000${scope.workspaceId}`;
const feedbackKey = (scope: TenantScope, runId: string): string => `${scopeKey(scope)}\u0000${runId}`;
const metricKey = (scope: TenantScope, bucketStart: string): string => `${scopeKey(scope)}\u0000${bucketStart}`;

export class InMemoryOperationsRepository implements OperationsRepository {
  private readonly feedback = new Map<string, RunFeedback>();
  private readonly metrics = new Map<string, OperationsDailyMetric>();
  private readonly policies = new Map<string, RetentionPolicy>();

  async saveFeedback(record: RunFeedback): Promise<void> { this.feedback.set(feedbackKey(record.scope, record.runId), serializeFeedback(record)); }
  async findFeedback(scope: TenantScope, runId: string): Promise<RunFeedback | null> {
    const record = this.feedback.get(feedbackKey(scope, runId));
    return record === undefined ? null : deserializeFeedback(record);
  }

  async recordRunMetric(sample: RunMetricSample): Promise<void> {
    const bucketStart = utcDayStart(sample.recordedAt);
    const key = metricKey(sample.scope, bucketStart);
    const current = this.metrics.get(key) ?? emptyMetric(sample.scope, bucketStart);
    this.metrics.set(key, serializeDailyMetric({
      ...current,
      runCount: current.runCount + 1,
      failureCount: current.failureCount + (sample.status === 'failed' ? 1 : 0),
      latencySamples: [...current.latencySamples, sample.latencyMs],
      totalTokens: current.totalTokens + (sample.totalTokens ?? 0),
      estimatedCost: current.estimatedCost + (sample.estimatedCost ?? 0),
      pricedRunCount: current.pricedRunCount + (sample.estimatedCost === undefined ? 0 : 1),
    }));
  }

  async recordFeedbackMetric(scope: TenantScope, recordedAt: string): Promise<void> {
    const bucketStart = utcDayStart(recordedAt);
    const key = metricKey(scope, bucketStart);
    const current = this.metrics.get(key) ?? emptyMetric(scope, bucketStart);
    this.metrics.set(key, serializeDailyMetric({ ...current, feedbackCount: current.feedbackCount + 1 }));
  }

  async listDailyMetrics(scope: TenantScope, from?: string): Promise<OperationsDailyMetric[]> {
    return [...this.metrics.values()]
      .filter((metric) => metric.scope.tenantId === scope.tenantId && metric.scope.workspaceId === scope.workspaceId && (from === undefined || metric.bucketStart >= from))
      .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
      .map(deserializeDailyMetric);
  }

  async getRetentionPolicy(scope: TenantScope): Promise<RetentionPolicy | null> {
    const policy = this.policies.get(scopeKey(scope));
    return policy === undefined ? null : deserializeRetentionPolicy(policy);
  }
  async saveRetentionPolicy(policy: RetentionPolicy): Promise<void> { this.policies.set(scopeKey(policy.scope), serializeRetentionPolicy(policy)); }

  async deleteFeedbackBefore(scope: TenantScope, before: string): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.feedback) {
      if (record.scope.tenantId === scope.tenantId && record.scope.workspaceId === scope.workspaceId && record.updatedAt <= before) {
        this.feedback.delete(key); deleted += 1;
      }
    }
    return deleted;
  }

  async deleteMetricsBefore(scope: TenantScope, before: string): Promise<number> {
    let deleted = 0;
    for (const [key, metric] of this.metrics) {
      if (metric.scope.tenantId === scope.tenantId && metric.scope.workspaceId === scope.workspaceId && metric.bucketStart <= before) {
        this.metrics.delete(key); deleted += 1;
      }
    }
    return deleted;
  }
}

function emptyMetric(scope: TenantScope, bucketStart: string): OperationsDailyMetric {
  return { scope: { ...scope }, bucketStart, runCount: 0, failureCount: 0, latencySamples: [], totalTokens: 0, estimatedCost: 0, pricedRunCount: 0, feedbackCount: 0 };
}

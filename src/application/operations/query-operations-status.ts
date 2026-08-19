import type { OperationsDailyMetric } from '../../domain/operations/operations';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface OperationsMetricPoint {
  readonly bucketStart: string;
  readonly runCount: number;
  readonly failureRate: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly totalTokens: number;
  readonly estimatedCost: number;
  readonly pricedRunCount: number;
  readonly feedbackRate: number;
}
export interface OperationsStatus {
  readonly from: string;
  readonly to: string;
  readonly summary: Omit<OperationsMetricPoint, 'bucketStart'>;
  readonly points: readonly OperationsMetricPoint[];
}

export class QueryOperationsStatusUseCase {
  constructor(private readonly operations: OperationsRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(scope: TenantScope, days = 30): Promise<OperationsStatus> {
    const to = this.now();
    const fromDate = new Date(to.getTime() - Math.max(0, days - 1) * 86_400_000);
    const from = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())).toISOString();
    const metrics = await this.operations.listDailyMetrics(scope, from);
    return { from, to: to.toISOString(), summary: summarize(metrics), points: metrics.map(toPoint) };
  }
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
function ratio(value: number, total: number): number { return total === 0 ? 0 : value / total; }
function toPoint(metric: OperationsDailyMetric): OperationsMetricPoint {
  return { bucketStart: metric.bucketStart, runCount: metric.runCount, failureRate: ratio(metric.failureCount, metric.runCount), p50LatencyMs: percentile(metric.latencySamples, 0.5), p95LatencyMs: percentile(metric.latencySamples, 0.95), totalTokens: metric.totalTokens, estimatedCost: metric.estimatedCost, pricedRunCount: metric.pricedRunCount, feedbackRate: ratio(metric.feedbackCount, metric.runCount) };
}
function summarize(metrics: readonly OperationsDailyMetric[]): Omit<OperationsMetricPoint, 'bucketStart'> {
  const combined = metrics.reduce((all, metric) => ({ runCount: all.runCount + metric.runCount, failureCount: all.failureCount + metric.failureCount, latencySamples: [...all.latencySamples, ...metric.latencySamples], totalTokens: all.totalTokens + metric.totalTokens, estimatedCost: all.estimatedCost + metric.estimatedCost, pricedRunCount: all.pricedRunCount + metric.pricedRunCount, feedbackCount: all.feedbackCount + metric.feedbackCount }), { runCount: 0, failureCount: 0, latencySamples: [] as number[], totalTokens: 0, estimatedCost: 0, pricedRunCount: 0, feedbackCount: 0 });
  return { runCount: combined.runCount, failureRate: ratio(combined.failureCount, combined.runCount), p50LatencyMs: percentile(combined.latencySamples, 0.5), p95LatencyMs: percentile(combined.latencySamples, 0.95), totalTokens: combined.totalTokens, estimatedCost: combined.estimatedCost, pricedRunCount: combined.pricedRunCount, feedbackRate: ratio(combined.feedbackCount, combined.runCount) };
}


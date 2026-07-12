import type { RunPurpose, RunStatus } from '../run/run';
import type { TenantScope } from '../tool/ids';

export type FeedbackThumb = 'up' | 'down';

export interface RunFeedback {
  readonly id: string;
  readonly scope: TenantScope;
  readonly runId: string;
  readonly agent: { readonly internalId: string; readonly version: string };
  readonly thumb: FeedbackThumb;
  readonly rating?: number;
  readonly comment?: string;
  readonly issueTags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunMetricSample {
  readonly scope: TenantScope;
  readonly recordedAt: string;
  readonly status: RunStatus;
  readonly purpose?: RunPurpose;
  readonly latencyMs: number;
  readonly totalTokens?: number;
  readonly estimatedCost?: number;
}

/** payloadを含まず、Runを逆引きできない日次集計。 */
export interface OperationsDailyMetric {
  readonly scope: TenantScope;
  readonly bucketStart: string;
  readonly runCount: number;
  readonly failureCount: number;
  readonly latencySamples: readonly number[];
  readonly totalTokens: number;
  readonly estimatedCost: number;
  readonly pricedRunCount: number;
  readonly feedbackCount: number;
}

export interface RetentionPolicy {
  readonly scope: TenantScope;
  readonly payloadDays: number;
  readonly traceDays: number;
  readonly aggregateDays: number;
  readonly updatedAt: string;
}

export const DEFAULT_RETENTION_DAYS = {
  payload: 30,
  trace: 14,
  aggregate: 365,
} as const;

export function utcDayStart(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid metric timestamp: ${value}`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}


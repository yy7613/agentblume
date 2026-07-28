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
  /**
   * 監査ログを残す日数。
   *
   * trace（14日）より**ずっと長い**のが既定。監査ログが答える問いは
   * 「先月あの設定を変えたのは誰か」であり、実行トレースと同じ寿命では用を成さない。
   * 保持期間を短くして即適用すれば消せてしまう点は payload/trace と同じなので、
   * 保持期限の変更そのものを監査対象にしてある（`PUT /operations/retention`）。
   */
  readonly auditDays: number;
  readonly updatedAt: string;
}

export const DEFAULT_RETENTION_DAYS = {
  payload: 30,
  trace: 14,
  aggregate: 365,
  audit: 365,
} as const;

export function utcDayStart(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid metric timestamp: ${value}`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}


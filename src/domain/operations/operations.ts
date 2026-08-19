import type { AgentId } from '../agent/ids';
import type { RunId } from '../run/ids';
import type { RunPurpose, RunStatus } from '../run/run';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../tool/ids';
import type { RunFeedbackId } from './ids';

export type FeedbackThumb = 'up' | 'down';

export interface RunFeedback {
  readonly id: RunFeedbackId;
  readonly scope: TenantScope;
  readonly runId: RunId;
  readonly agent: { readonly internalId: AgentId; readonly version: string };
  readonly thumb: FeedbackThumb;
  readonly rating?: number;
  readonly comment?: string;
  readonly issueTags: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface RunMetricSample {
  readonly scope: TenantScope;
  readonly recordedAt: IsoDateTime;
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
   * 監査ログを残す日数。**`MINIMUM_AUDIT_RETENTION_DAYS` 未満は受け付けない**。
   *
   * trace（14日）より**ずっと長い**のが既定。監査ログが答える問いは
   * 「先月あの設定を変えたのは誰か」であり、実行トレースと同じ寿命では用を成さない。
   */
  readonly auditDays: number;
  readonly updatedAt: IsoDateTime;
}

export const DEFAULT_RETENTION_DAYS = {
  payload: 30,
  trace: 14,
  aggregate: 365,
  audit: 365,
} as const;

/**
 * `auditDays` の下限（日）。**0 を許してはいけない**。
 *
 * 「保持期限の変更そのものを監査対象にしてあるから短縮しても足跡は残る」は成り立たない。
 * `PUT /operations/retention` の監査行は変更**時刻**で書かれるので、直後に
 * `POST /operations/retention/apply` を打てば `deleteBefore(now - 0日)` がその行ごと消す
 * （実測: 残るのは適用操作の1行だけで、何を何に変えたかは台帳から消える）。
 * 下限を設けると「消せるようになるまで下限日数ぶん待つ」必要が生まれ、その間に
 * 変更の記録が確実に読まれる。30日は「月次の点検で必ず目に入る」長さとして選んだ。
 *
 * 併せて `PUT /operations/retention` は**変更後の値を監査 detail へ載せる**。
 * 短縮の意図そのものが記録に残るので、下限まで待って消しても痕跡は残る。
 */
export const MINIMUM_AUDIT_RETENTION_DAYS = 30;

export function utcDayStart(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid metric timestamp: ${value}`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}


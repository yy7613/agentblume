import { DEFAULT_RETENTION_DAYS, type RetentionPolicy } from '../../domain/operations/operations';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import type { RunRepository, RunRetentionResult } from '../../domain/run/run-repository';
import type { AuditLogRepository } from '../../domain/security/audit';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import { describeError, type LoggerPort } from './logger';

export interface RetentionApplyResult extends RunRetentionResult { readonly feedbackDeleted: number; readonly aggregateBucketsDeleted: number; readonly auditDeleted: number }

/** 全スコープ一括適用の合計。定期実行のログへそのまま載せる。 */
export interface RetentionSweepResult extends RetentionApplyResult {
  /** 実際に適用できたスコープ数。 */
  readonly scopes: number;
  /** 適用に失敗したスコープ数（1スコープの失敗で残りを止めない）。 */
  readonly failures: number;
}

export class RetentionUseCase {
  constructor(
    private readonly runs: RunRepository,
    private readonly operations: OperationsRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: LoggerPort,
    /**
     * 監査ログの台帳。**省略できる**のは、監査を持たない配線（埋め込み・古いテスト）でも
     * 保持期限は動くべきだから。渡されていなければ監査の掃除だけ行わない。
     */
    private readonly auditLog?: AuditLogRepository,
  ) {}

  async get(scope: TenantScope): Promise<RetentionPolicy> {
    return await this.operations.getRetentionPolicy(scope) ?? { scope: { ...scope }, payloadDays: DEFAULT_RETENTION_DAYS.payload, traceDays: DEFAULT_RETENTION_DAYS.trace, aggregateDays: DEFAULT_RETENTION_DAYS.aggregate, auditDays: DEFAULT_RETENTION_DAYS.audit, updatedAt: this.now().toISOString() };
  }
  async save(input: Omit<RetentionPolicy, 'updatedAt'>): Promise<RetentionPolicy> {
    const policy = { ...input, scope: { ...input.scope }, updatedAt: this.now().toISOString() };
    await this.operations.saveRetentionPolicy(policy); return policy;
  }
  async apply(scope: TenantScope): Promise<RetentionApplyResult> {
    const policy = await this.get(scope); const now = this.now().getTime();
    const cutoff = (days: number): string => new Date(now - days * 86_400_000).toISOString();
    const payloadBefore = cutoff(policy.payloadDays); const traceBefore = cutoff(policy.traceDays);
    const deleteBefore = payloadBefore < traceBefore ? payloadBefore : traceBefore;
    const runResult = this.runs.applyRetention === undefined ? { payloadRedacted: 0, traceRedacted: 0, deleted: 0 } : await this.runs.applyRetention(scope, { payloadBefore, traceBefore, deleteBefore });
    const feedbackDeleted = await this.operations.deleteFeedbackBefore(scope, payloadBefore);
    const aggregateBucketsDeleted = await this.operations.deleteMetricsBefore(scope, cutoff(policy.aggregateDays));
    const auditDeleted = this.auditLog === undefined ? 0 : await this.auditLog.deleteBefore(scope, cutoff(policy.auditDays));
    return { ...runResult, feedbackDeleted, aggregateBucketsDeleted, auditDeleted };
  }

  /**
   * 保存されている全スコープへ順に `apply` する（定期実行の入口）。
   *
   * 対象スコープは `runs` から引く。retentionが本当に抑えたいのは**無制限に増える `runs`** であり、
   * feedback / 日次集計は必ずRunの後に生まれるので、Runを1件でも持ったスコープを見れば漏れない。
   * ただし「全Runを削除し切ったあとに残る集計だけのスコープ」は列挙できなくなるため、
   * 設定済みの既定スコープを `always` として渡せるようにしてある（composition が起動スコープを渡す）。
   *
   * 1スコープの失敗で残りを止めない。定期実行は「次回もう一度走る」のが前提で、
   * 1つの壊れたスコープのために他のスコープが永久に掃除されないほうが有害である。
   */
  async applyAll(always: readonly TenantScope[] = []): Promise<RetentionSweepResult> {
    const targets = new Map<string, TenantScope>();
    for (const scope of always) targets.set(tenantKey(scope), { ...scope });
    for (const scope of await this.runs.listScopes()) targets.set(tenantKey(scope), { ...scope });

    let scopes = 0; let failures = 0;
    let payloadRedacted = 0; let traceRedacted = 0; let deleted = 0; let feedbackDeleted = 0; let aggregateBucketsDeleted = 0; let auditDeleted = 0;
    for (const scope of targets.values()) {
      try {
        const result = await this.apply(scope);
        scopes += 1;
        payloadRedacted += result.payloadRedacted; traceRedacted += result.traceRedacted; deleted += result.deleted;
        feedbackDeleted += result.feedbackDeleted; aggregateBucketsDeleted += result.aggregateBucketsDeleted; auditDeleted += result.auditDeleted;
      } catch (error) {
        failures += 1;
        this.logger?.warn('retention failed for one scope', { scope: tenantKey(scope), reason: describeError(error) });
      }
    }
    return { scopes, failures, payloadRedacted, traceRedacted, deleted, feedbackDeleted, aggregateBucketsDeleted, auditDeleted };
  }
}

import { DEFAULT_RETENTION_DAYS, type RetentionPolicy } from '../../domain/operations/operations';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import type { RunRepository, RunRetentionResult } from '../../domain/run/run-repository';
import type { TenantScope } from '../../domain/tool/ids';

export interface RetentionApplyResult extends RunRetentionResult { readonly feedbackDeleted: number; readonly aggregateBucketsDeleted: number }

export class RetentionUseCase {
  constructor(private readonly runs: RunRepository, private readonly operations: OperationsRepository, private readonly now: () => Date = () => new Date()) {}

  async get(scope: TenantScope): Promise<RetentionPolicy> {
    return await this.operations.getRetentionPolicy(scope) ?? { scope: { ...scope }, payloadDays: DEFAULT_RETENTION_DAYS.payload, traceDays: DEFAULT_RETENTION_DAYS.trace, aggregateDays: DEFAULT_RETENTION_DAYS.aggregate, updatedAt: this.now().toISOString() };
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
    return { ...runResult, feedbackDeleted, aggregateBucketsDeleted };
  }
}

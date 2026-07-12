import type { TenantScope } from '../tool/ids';
import type { OperationsDailyMetric, RetentionPolicy, RunFeedback, RunMetricSample } from './operations';

export interface OperationsRepository {
  saveFeedback(record: RunFeedback): Promise<void>;
  findFeedback(scope: TenantScope, runId: string): Promise<RunFeedback | null>;
  recordRunMetric(sample: RunMetricSample): Promise<void>;
  recordFeedbackMetric(scope: TenantScope, recordedAt: string): Promise<void>;
  listDailyMetrics(scope: TenantScope, from?: string): Promise<OperationsDailyMetric[]>;
  getRetentionPolicy(scope: TenantScope): Promise<RetentionPolicy | null>;
  saveRetentionPolicy(policy: RetentionPolicy): Promise<void>;
  deleteFeedbackBefore(scope: TenantScope, before: string): Promise<number>;
  deleteMetricsBefore(scope: TenantScope, before: string): Promise<number>;
}


import type { AgentId } from '../agent/ids';
import type { TenantScope } from '../shared/tenant-scope';
import type { SemVer } from '../tool/semver';
import type { ExperimentId, GatePolicyId, GateReportId, PromotionRequestId } from './ids';
import type { GatePolicy, GateReport, PromotionRequest } from './quality-gate';

export interface GatePolicySummary { readonly internalId: GatePolicyId; readonly displayName: string; readonly publishName: string; readonly latestVersion: SemVer; readonly state: GatePolicy['metadata']['state']; readonly ruleCount: number }
export interface QualityGateRepository {
  savePolicy(policy: GatePolicy): Promise<void>;
  findPolicyVersion(scope: TenantScope, internalId: GatePolicyId, version: SemVer): Promise<GatePolicy | null>;
  findLatestPolicy(scope: TenantScope, internalId: GatePolicyId): Promise<GatePolicy | null>;
  listPolicyVersions(scope: TenantScope, internalId: GatePolicyId): Promise<SemVer[]>;
  listPolicies(scope: TenantScope): Promise<GatePolicySummary[]>;
  /** 論理削除。listPolicies/findLatestPolicyからは除外し、listPolicyVersionsは空配列を返す。findPolicyVersionは削除後も既存versionを返し続ける。戻り値は削除前に存在したか。 */
  deletePolicy(scope: TenantScope, internalId: GatePolicyId): Promise<boolean>;
  saveReport(report: GateReport): Promise<void>;
  findReport(scope: TenantScope, id: GateReportId): Promise<GateReport | null>;
  listReports(scope: TenantScope, candidateExperimentId?: ExperimentId): Promise<GateReport[]>;
  createPromotion(request: PromotionRequest): Promise<void>;
  updatePromotion(request: PromotionRequest): Promise<void>;
  findPromotion(scope: TenantScope, id: PromotionRequestId): Promise<PromotionRequest | null>;
  listPromotions(scope: TenantScope, agentId?: AgentId): Promise<PromotionRequest[]>;
}

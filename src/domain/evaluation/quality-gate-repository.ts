import type { TenantScope } from '../tool/ids';
import type { SemVer } from '../tool/semver';
import type { GatePolicy, GateReport, PromotionRequest } from './quality-gate';

export interface GatePolicySummary { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: SemVer; readonly state: GatePolicy['metadata']['state']; readonly ruleCount: number }
export interface QualityGateRepository {
  savePolicy(policy: GatePolicy): Promise<void>;
  findPolicyVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<GatePolicy | null>;
  findLatestPolicy(scope: TenantScope, internalId: string): Promise<GatePolicy | null>;
  listPolicyVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  listPolicies(scope: TenantScope): Promise<GatePolicySummary[]>;
  saveReport(report: GateReport): Promise<void>;
  findReport(scope: TenantScope, id: string): Promise<GateReport | null>;
  listReports(scope: TenantScope, candidateExperimentId?: string): Promise<GateReport[]>;
  createPromotion(request: PromotionRequest): Promise<void>;
  updatePromotion(request: PromotionRequest): Promise<void>;
  findPromotion(scope: TenantScope, id: string): Promise<PromotionRequest | null>;
  listPromotions(scope: TenantScope, agentId?: string): Promise<PromotionRequest[]>;
}

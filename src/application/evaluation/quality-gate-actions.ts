import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { AgentId } from '../../domain/agent/ids';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { EvaluationDomainError, ExperimentNotFoundError, QualityGateConflictError, QualityGateNotFoundError } from '../../domain/evaluation/errors';
import type { ExperimentId, GatePolicyId, GateReportId, PromotionRequestId } from '../../domain/evaluation/ids';
import { compareExperiments, createGatePolicy, createPromotionRequest, decidePromotion, evaluateGate, type ExperimentComparison, type GatePolicy, type GateReport, type GateRule, type PromotionRequest } from '../../domain/evaluation/quality-gate';
import type { GatePolicySummary, QualityGateRepository } from '../../domain/evaluation/quality-gate-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';

const nextVersion = (versions: readonly SemVer[], bump: 'major' | 'minor' | 'patch'): SemVer => versions.length === 0 ? SemVer.of(1, 0, 0) : versions.reduce((max, value) => value.compare(max) > 0 ? value : max).bump(bump);
export interface SaveGatePolicyInput { readonly scope: TenantScope; readonly internalId: GatePolicyId; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string; readonly rules: readonly GateRule[]; readonly reportTtlHours?: number; readonly bump?: 'major' | 'minor' | 'patch'; readonly state?: PublishState }

export class SaveGatePolicyUseCase {
  constructor(private readonly repo: QualityGateRepository) {}
  async execute(input: SaveGatePolicyInput): Promise<GatePolicy> {
    const policy = createGatePolicy({ metadata: { internalId: input.internalId, workingName: input.workingName, displayName: input.displayName, publishName: input.publishName, version: nextVersion(await this.repo.listPolicyVersions(input.scope, input.internalId), input.bump ?? 'patch'), owner: input.owner, state: input.state ?? 'draft', tenant: input.scope }, rules: input.rules, reportTtlHours: input.reportTtlHours ?? 168 });
    await this.repo.savePolicy(policy); return policy;
  }
}

export class QueryQualityGatesUseCase {
  constructor(private readonly repo: QualityGateRepository) {}
  listPolicies(scope: TenantScope): Promise<GatePolicySummary[]> { return this.repo.listPolicies(scope); }
  policyVersions(scope: TenantScope, id: GatePolicyId): Promise<SemVer[]> { return this.repo.listPolicyVersions(scope, id); }
  async getPolicy(scope: TenantScope, id: GatePolicyId, version?: SemVer): Promise<GatePolicy> { const value = version === undefined ? await this.repo.findLatestPolicy(scope, id) : await this.repo.findPolicyVersion(scope, id, version); if (value === null) throw new QualityGateNotFoundError(`Gate policy not found: ${id}${version === undefined ? '' : `@${version.toString()}`}`); return value; }
  listReports(scope: TenantScope, candidateExperimentId?: ExperimentId): Promise<GateReport[]> { return this.repo.listReports(scope, candidateExperimentId); }
  async getReport(scope: TenantScope, id: GateReportId): Promise<GateReport> { const value = await this.repo.findReport(scope, id); if (value === null) throw new QualityGateNotFoundError(`Gate report not found: ${id}`); return value; }
  listPromotions(scope: TenantScope, agentId?: AgentId): Promise<PromotionRequest[]> { return this.repo.listPromotions(scope, agentId); }
  async getPromotion(scope: TenantScope, id: PromotionRequestId): Promise<PromotionRequest> { const value = await this.repo.findPromotion(scope, id); if (value === null) throw new QualityGateNotFoundError(`Promotion request not found: ${id}`); return value; }
}

/** 保存済みGate policyの論理削除。repository.deletePolicy が false(未存在/削除済み)なら QualityGateNotFoundError。 */
export class DeleteGatePolicyUseCase {
  constructor(private readonly repo: QualityGateRepository) {}
  async execute(scope: TenantScope, internalId: GatePolicyId): Promise<void> {
    const existed = await this.repo.deletePolicy(scope, internalId);
    if (!existed) throw new QualityGateNotFoundError(`DeleteGatePolicy: policy not found: ${internalId}`);
  }
}

export class CompareExperimentsUseCase {
  constructor(private readonly experiments: ExperimentRepository) {}
  async execute(scope: TenantScope, baselineExperimentId: ExperimentId, candidateExperimentId: ExperimentId): Promise<ExperimentComparison> {
    const baseline = await this.experiments.find(scope, baselineExperimentId); const candidate = await this.experiments.find(scope, candidateExperimentId);
    if (baseline === null) throw new ExperimentNotFoundError(`Experiment not found: ${baselineExperimentId}`); if (candidate === null) throw new ExperimentNotFoundError(`Experiment not found: ${candidateExperimentId}`);
    return compareExperiments(baseline, await this.experiments.listCaseResults(scope, baseline.id), candidate, await this.experiments.listCaseResults(scope, candidate.id));
  }
}

export interface EvaluateQualityGateInput { readonly scope: TenantScope; readonly policy: { readonly id: GatePolicyId; readonly version: SemVer }; readonly candidateExperimentId: ExperimentId; readonly baselineExperimentId?: ExperimentId }
export class EvaluateQualityGateUseCase {
  constructor(private readonly gates: QualityGateRepository, private readonly experiments: ExperimentRepository, private readonly datasets: EvaluationDatasetRepository, private readonly makeId: () => string = randomUUID, private readonly now: () => Date = () => new Date(), private readonly profiles?: EvaluatorProfileRepository) {}
  async execute(input: EvaluateQualityGateInput): Promise<GateReport> {
    const policy = await this.gates.findPolicyVersion(input.scope, input.policy.id, input.policy.version); if (policy === null) throw new QualityGateNotFoundError(`Gate policy not found: ${input.policy.id}@${input.policy.version.toString()}`);
    const candidate = await this.experiments.find(input.scope, input.candidateExperimentId); if (candidate === null) throw new ExperimentNotFoundError(`Experiment not found: ${input.candidateExperimentId}`);
    const dataset = await this.datasets.findVersion(input.scope, candidate.dataset.id, candidate.dataset.version); if (dataset === null) throw new EvaluationDomainError(`EvaluateQualityGate: dataset not found: ${candidate.dataset.id}@${candidate.dataset.version.toString()}`);
    const baseline = input.baselineExperimentId === undefined ? undefined : await this.experiments.find(input.scope, input.baselineExperimentId);
    if (input.baselineExperimentId !== undefined && baseline === null) throw new ExperimentNotFoundError(`Experiment not found: ${input.baselineExperimentId}`);
    const profile = this.profiles === undefined ? null : await this.profiles.findVersion(input.scope, candidate.evaluatorProfile.id, candidate.evaluatorProfile.version);
    if (this.profiles !== undefined && profile === null) throw new EvaluationDomainError(`EvaluateQualityGate: evaluator profile not found: ${candidate.evaluatorProfile.id}@${candidate.evaluatorProfile.version.toString()}`);
    const requiredJudgeMetrics = profile?.metrics.filter((metric) => metric.kind === 'judge' && metric.required).map((metric) => metric.id) ?? [];
    const report = evaluateGate({ id: this.makeId(), policy, candidate, candidateResults: await this.experiments.listCaseResults(input.scope, candidate.id), dataset, ...(baseline !== undefined && baseline !== null ? { baseline, baselineResults: await this.experiments.listCaseResults(input.scope, baseline.id) } : {}), requiredJudgeMetrics, now: this.now().toISOString() });
    await this.gates.saveReport(report); return report;
  }
}

async function updateAgentState(agents: AgentRepository, scope: TenantScope, id: AgentId, version: SemVer, state: PublishState): Promise<void> {
  if (agents.updateState === undefined) throw new EvaluationDomainError('Promotion requires an AgentRepository that supports lifecycle state updates');
  await agents.updateState(scope, id, version, state);
}

export interface RequestPromotionInput { readonly scope: TenantScope; readonly agentId: AgentId; readonly version: SemVer; readonly gateReportId: GateReportId; readonly requestedBy: string }
export class RequestPromotionUseCase {
  constructor(private readonly gates: QualityGateRepository, private readonly experiments: ExperimentRepository, private readonly agents: AgentRepository, private readonly makeId: () => string = randomUUID, private readonly now: () => Date = () => new Date()) {}
  async execute(input: RequestPromotionInput): Promise<PromotionRequest> {
    const report = await this.gates.findReport(input.scope, input.gateReportId); if (report === null) throw new QualityGateNotFoundError(`Gate report not found: ${input.gateReportId}`);
    const now = this.now(); if (report.status !== 'pass') throw new EvaluationDomainError('RequestPromotion: gate report did not pass'); if (Date.parse(report.expiresAt) <= now.valueOf()) throw new EvaluationDomainError('RequestPromotion: gate report has expired');
    const experiment = await this.experiments.find(input.scope, report.candidateExperimentId); if (experiment === null) throw new ExperimentNotFoundError(`Experiment not found: ${report.candidateExperimentId}`);
    if (experiment.target.agentId !== input.agentId || experiment.target.version.compare(input.version) !== 0) throw new EvaluationDomainError('RequestPromotion: gate report candidate does not match the target agent version');
    const existing = await this.gates.listPromotions(input.scope, input.agentId); if (existing.some((request) => request.agent.version.compare(input.version) === 0 && request.status === 'pending')) throw new QualityGateConflictError(`Pending promotion request already exists for ${input.agentId}@${input.version.toString()}`);
    const agent = await this.agents.findVersion(input.scope, input.agentId, input.version); if (agent === null) throw new EvaluationDomainError(`RequestPromotion: agent not found: ${input.agentId}@${input.version.toString()}`); if (agent.metadata.state !== 'draft') throw new EvaluationDomainError(`RequestPromotion: agent must be draft, but is ${agent.metadata.state}`);
    const request = createPromotionRequest({ id: this.makeId(), scope: input.scope, agent: { id: input.agentId, version: input.version }, gateReportId: report.id, status: 'pending', requestedBy: input.requestedBy, requestedAt: now.toISOString() });
    await updateAgentState(this.agents, input.scope, input.agentId, input.version, 'in-review'); await this.gates.createPromotion(request); return request;
  }
}

export interface DecidePromotionInput { readonly scope: TenantScope; readonly requestId: PromotionRequestId; readonly decision: 'approved' | 'rejected'; readonly decidedBy: string; readonly reason?: string }
export class DecidePromotionUseCase {
  constructor(private readonly gates: QualityGateRepository, private readonly agents: AgentRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(input: DecidePromotionInput): Promise<PromotionRequest> {
    const current = await this.gates.findPromotion(input.scope, input.requestId); if (current === null) throw new QualityGateNotFoundError(`Promotion request not found: ${input.requestId}`);
    const agent = await this.agents.findVersion(input.scope, current.agent.id, current.agent.version); if (agent === null) throw new EvaluationDomainError(`DecidePromotion: agent not found: ${current.agent.id}@${current.agent.version.toString()}`); if (agent.metadata.state !== 'in-review') throw new EvaluationDomainError(`DecidePromotion: agent must be in-review, but is ${agent.metadata.state}`);
    const decided = decidePromotion(current, input.decision, input.decidedBy, this.now().toISOString(), input.reason);
    await updateAgentState(this.agents, input.scope, current.agent.id, current.agent.version, input.decision === 'approved' ? 'published' : 'draft'); await this.gates.updatePromotion(decided); return decided;
  }
}

export class QualityGateExitCodeUseCase {
  constructor(private readonly gates: QualityGateRepository, private readonly experiments: ExperimentRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(scope: TenantScope, experimentId: ExperimentId): Promise<0 | 1 | 2> {
    if ((await this.experiments.find(scope, experimentId)) === null) return 2;
    const report = (await this.gates.listReports(scope, experimentId))[0]; if (report === undefined || Date.parse(report.expiresAt) <= this.now().valueOf()) return 2;
    return report.status === 'pass' ? 0 : 1;
  }
}

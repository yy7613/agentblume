import { z } from 'zod';
import { PUBLISH_STATES, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { createGatePolicy, createGateReport, createPromotionRequest, type GatePolicy, type GateReport, type GateRule, type PromotionRequest } from './quality-gate';
import { EvaluationDomainError } from './errors';

interface SerializedMetadata { readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly version: string; readonly owner: string; readonly state: PublishState; readonly tenant: { readonly tenantId: string; readonly workspaceId: string } }
export interface SerializedGatePolicy { readonly metadata: SerializedMetadata; readonly rules: readonly GateRule[]; readonly reportTtlHours: number }
export interface SerializedGateReport { readonly id: string; readonly scope: { readonly tenantId: string; readonly workspaceId: string }; readonly policy: { readonly id: string; readonly version: string }; readonly baselineExperimentId?: string; readonly candidateExperimentId: string; readonly status: 'pass' | 'fail'; readonly ruleResults: GateReport['ruleResults']; readonly createdAt: string; readonly expiresAt: string }
export interface SerializedPromotionRequest { readonly id: string; readonly scope: { readonly tenantId: string; readonly workspaceId: string }; readonly agent: { readonly id: string; readonly version: string }; readonly gateReportId: string; readonly status: PromotionRequest['status']; readonly requestedBy: string; readonly requestedAt: string; readonly decidedBy?: string; readonly decidedAt?: string; readonly reason?: string }

const metadataSchema = z.object({ internalId: z.string(), workingName: z.string(), displayName: z.string(), publishName: z.string(), version: z.string(), owner: z.string(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]), tenant: z.object({ tenantId: z.string(), workspaceId: z.string() }) });
const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('metric-threshold'), metric: z.string(), operator: z.enum(['gte', 'lte']), threshold: z.number() }),
  z.object({ id: z.string(), kind: z.literal('max-regression'), metric: z.string(), maxRegression: z.number() }),
  z.object({ id: z.string(), kind: z.literal('required-case-pass'), tags: z.array(z.string()) }),
]);
const policySchema = z.object({ metadata: metadataSchema, rules: z.array(ruleSchema), reportTtlHours: z.number() });
const reportSchema = z.object({ id: z.string(), scope: z.object({ tenantId: z.string(), workspaceId: z.string() }), policy: z.object({ id: z.string(), version: z.string() }), baselineExperimentId: z.string().optional(), candidateExperimentId: z.string(), status: z.enum(['pass', 'fail']), ruleResults: z.array(z.object({ ruleId: z.string(), passed: z.boolean(), observed: z.number().optional(), message: z.string() })), createdAt: z.string(), expiresAt: z.string() });
const promotionSchema = z.object({ id: z.string(), scope: z.object({ tenantId: z.string(), workspaceId: z.string() }), agent: z.object({ id: z.string(), version: z.string() }), gateReportId: z.string(), status: z.enum(['pending', 'approved', 'rejected']), requestedBy: z.string(), requestedAt: z.string(), decidedBy: z.string().optional(), decidedAt: z.string().optional(), reason: z.string().optional() });
function parse<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> { const parsed = schema.safeParse(value); if (!parsed.success) throw new EvaluationDomainError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`); return parsed.data; }

export function serializeGatePolicy(policy: GatePolicy): SerializedGatePolicy { return { metadata: { ...policy.metadata, version: policy.metadata.version.toString(), tenant: { ...policy.metadata.tenant } }, rules: policy.rules.map((rule) => ({ ...rule, ...(rule.kind === 'required-case-pass' ? { tags: [...rule.tags] } : {}) })), reportTtlHours: policy.reportTtlHours }; }
export function deserializeGatePolicy(value: unknown): GatePolicy { const data = parse(policySchema, value, 'deserializeGatePolicy'); return createGatePolicy({ metadata: { ...data.metadata, version: SemVer.parse(data.metadata.version), tenant: { ...data.metadata.tenant } }, rules: data.rules, reportTtlHours: data.reportTtlHours }); }
export function serializeGateReport(report: GateReport): SerializedGateReport { return { ...report, scope: { ...report.scope }, policy: { id: report.policy.id, version: report.policy.version.toString() }, ruleResults: report.ruleResults.map((result) => ({ ...result })) }; }
export function deserializeGateReport(value: unknown): GateReport { const data = parse(reportSchema, value, 'deserializeGateReport'); return createGateReport({ ...data, scope: { ...data.scope }, policy: { id: data.policy.id, version: SemVer.parse(data.policy.version) }, ruleResults: data.ruleResults }); }
export function serializePromotionRequest(request: PromotionRequest): SerializedPromotionRequest { return { ...request, scope: { ...request.scope }, agent: { id: request.agent.id, version: request.agent.version.toString() } }; }
export function deserializePromotionRequest(value: unknown): PromotionRequest { const data = parse(promotionSchema, value, 'deserializePromotionRequest'); return createPromotionRequest({ ...data, scope: { ...data.scope }, agent: { id: data.agent.id, version: SemVer.parse(data.agent.version) } }); }

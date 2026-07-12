import { z } from 'zod';
import { SemVer } from '../tool/semver';
import { createExperiment, createExperimentCaseResult, EXPERIMENT_CASE_STATUSES, EXPERIMENT_STATUSES, type Experiment, type ExperimentCaseResult } from './experiment';
import { EvaluationDomainError } from './errors';

export interface SerializedExperiment extends Omit<Experiment, 'target' | 'dataset' | 'evaluatorProfile'> {
  readonly target: { readonly agentId: string; readonly version: string };
  readonly dataset: { readonly id: string; readonly version: string };
  readonly evaluatorProfile: { readonly id: string; readonly version: string };
}
export type SerializedExperimentCaseResult = Omit<ExperimentCaseResult, 'judgeEvaluations'> & {
  readonly judgeEvaluations?: readonly { readonly scorer: 'llm-as-judge'; readonly metricId: string; readonly rubric: { readonly id: string; readonly version: string }; readonly required: boolean; readonly model: Experiment['snapshot']; readonly status: 'succeeded' | 'failed'; readonly score?: number; readonly reason?: string; readonly error?: { readonly code: string; readonly message: string } }[];
};

const scopeSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });
const snapshotSchema = z.object({ provider: z.string(), model: z.string(), modelConfigHash: z.string(), sourceRevision: z.string().optional() });
const experimentSchema = z.object({
  id: z.string(), scope: scopeSchema, target: z.object({ agentId: z.string(), version: z.string() }), dataset: z.object({ id: z.string(), version: z.string() }), evaluatorProfile: z.object({ id: z.string(), version: z.string() }),
  repetitions: z.number(), status: z.enum(EXPERIMENT_STATUSES), snapshot: snapshotSchema, progress: z.object({ completed: z.number(), total: z.number() }), createdAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(), error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const scoreSchema = z.object({ metric: z.string(), score: z.number(), reason: z.string().optional() });
const resultSchema = z.object({
  experimentId: z.string(), scope: scopeSchema, caseId: z.string(), caseKind: z.enum(['turn', 'scenario']), repetition: z.number(), status: z.enum(EXPERIMENT_CASE_STATUSES), runIds: z.array(z.string()), output: z.string().optional(), scores: z.array(scoreSchema), latencyMs: z.number(), usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional(), totalTokens: z.number().optional() }), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  judgeEvaluations: z.array(z.object({ scorer: z.literal('llm-as-judge'), metricId: z.string(), rubric: z.object({ id: z.string(), version: z.string() }), required: z.boolean(), model: snapshotSchema, status: z.enum(['succeeded', 'failed']), score: z.number().optional(), reason: z.string().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() })).optional(),
});
const issues = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

export function serializeExperiment(value: Experiment): SerializedExperiment { return { ...structuredClone(value), target: { ...value.target, version: value.target.version.toString() }, dataset: { ...value.dataset, version: value.dataset.version.toString() }, evaluatorProfile: { ...value.evaluatorProfile, version: value.evaluatorProfile.version.toString() } }; }
export function deserializeExperiment(value: unknown): Experiment { const parsed = experimentSchema.safeParse(value); if (!parsed.success) throw new EvaluationDomainError(`deserializeExperiment: ${issues(parsed.error)}`); return createExperiment({ ...parsed.data, target: { agentId: parsed.data.target.agentId, version: SemVer.parse(parsed.data.target.version) }, dataset: { id: parsed.data.dataset.id, version: SemVer.parse(parsed.data.dataset.version) }, evaluatorProfile: { id: parsed.data.evaluatorProfile.id, version: SemVer.parse(parsed.data.evaluatorProfile.version) } }); }
export function serializeExperimentCaseResult(value: ExperimentCaseResult): SerializedExperimentCaseResult {
  const { judgeEvaluations, ...base } = value;
  return { ...structuredClone(base), ...(judgeEvaluations !== undefined ? { judgeEvaluations: judgeEvaluations.map((record) => ({ ...record, rubric: { id: record.rubric.id, version: record.rubric.version.toString() }, model: { ...record.model }, ...(record.error !== undefined ? { error: { ...record.error } } : {}) })) } : {}) };
}
export function deserializeExperimentCaseResult(value: unknown): ExperimentCaseResult {
  const parsed = resultSchema.safeParse(value); if (!parsed.success) throw new EvaluationDomainError(`deserializeExperimentCaseResult: ${issues(parsed.error)}`);
  const { judgeEvaluations, ...base } = parsed.data;
  return createExperimentCaseResult({ ...base, ...(judgeEvaluations !== undefined ? { judgeEvaluations: judgeEvaluations.map((record) => ({ ...record, rubric: { id: record.rubric.id, version: SemVer.parse(record.rubric.version) }, model: { ...record.model } })) } : {}) });
}

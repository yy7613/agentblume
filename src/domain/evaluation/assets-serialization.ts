import { z } from 'zod';
import { PUBLISH_STATES, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { EVALUATION_CASE_SOURCES, createEvaluationDataset, type EvaluationCase, type EvaluationCaseSource, type EvaluationDataset } from './evaluation-dataset';
import { CODE_SCORERS, createEvaluatorProfile, type CodeScorer, type EvaluatorProfile } from './evaluator-profile';
import { JUDGE_REFERENCE_POLICIES, createJudgeRubric, type JudgeRubric } from './judge-rubric';
import { EvaluationDomainError } from './errors';

interface SerializedMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: string;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: { readonly tenantId: string; readonly workspaceId: string };
}

export type SerializedEvaluationCase =
  | { readonly id: string; readonly kind: 'turn'; readonly input: string; readonly reference?: string; readonly expectedTools?: readonly string[]; readonly tags: readonly string[]; readonly source: EvaluationCaseSource }
  | { readonly id: string; readonly kind: 'scenario'; readonly scenario: { readonly id: string; readonly version: string }; readonly tags: readonly string[]; readonly source: EvaluationCaseSource };

export interface SerializedEvaluationDataset {
  readonly metadata: SerializedMetadata;
  readonly cases: readonly SerializedEvaluationCase[];
}

export interface SerializedEvaluatorProfile {
  readonly metadata: SerializedMetadata;
  readonly metrics: readonly (
    | { readonly id: string; readonly kind: 'code'; readonly weight: number; readonly required: boolean; readonly scorer: CodeScorer }
    | { readonly id: string; readonly kind: 'judge'; readonly weight: number; readonly required: boolean; readonly rubric: { readonly id: string; readonly version: string } }
  )[];
}

export interface SerializedJudgeRubric {
  readonly metadata: SerializedMetadata;
  readonly instructions: string;
  readonly criteria: readonly { readonly id: string; readonly label: string; readonly description: string; readonly weight: number; readonly levels: readonly { readonly score: number; readonly label: string; readonly description: string }[] }[];
  readonly referencePolicy: JudgeRubric['referencePolicy'];
  readonly reasonRequired: true;
}

const metadataSchema = z.object({
  internalId: z.string(), workingName: z.string(), displayName: z.string(), publishName: z.string(), version: z.string(), owner: z.string(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]), tenant: z.object({ tenantId: z.string(), workspaceId: z.string() }),
});
const caseSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('turn'), input: z.string(), reference: z.string().optional(), expectedTools: z.array(z.string()).optional(), tags: z.array(z.string()), source: z.enum(EVALUATION_CASE_SOURCES) }),
  z.object({ id: z.string(), kind: z.literal('scenario'), scenario: z.object({ id: z.string(), version: z.string() }), tags: z.array(z.string()), source: z.enum(EVALUATION_CASE_SOURCES) }),
]);
const datasetSchema = z.object({ metadata: metadataSchema, cases: z.array(caseSchema) });
const profileSchema = z.object({
  metadata: metadataSchema,
  metrics: z.array(z.discriminatedUnion('kind', [
    z.object({ id: z.string(), kind: z.literal('code'), weight: z.number(), required: z.boolean(), scorer: z.enum(CODE_SCORERS) }),
    z.object({ id: z.string(), kind: z.literal('judge'), weight: z.number(), required: z.boolean(), rubric: z.object({ id: z.string(), version: z.string() }) }),
  ])),
});
const rubricSchema = z.object({
  metadata: metadataSchema, instructions: z.string(), referencePolicy: z.enum(JUDGE_REFERENCE_POLICIES), reasonRequired: z.literal(true),
  criteria: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), weight: z.number(), levels: z.array(z.object({ score: z.number(), label: z.string(), description: z.string() })) })),
});

function issues(error: z.ZodError): string { return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '); }
const serializeMetadata = (metadata: EvaluationDataset['metadata']): SerializedMetadata => ({ ...metadata, version: metadata.version.toString(), tenant: { ...metadata.tenant } });

export function serializeEvaluationCase(entry: EvaluationCase): SerializedEvaluationCase {
  if (entry.kind === 'turn') return { id: entry.id, kind: 'turn', input: entry.input, ...(entry.reference !== undefined ? { reference: entry.reference } : {}), ...(entry.expectedTools !== undefined ? { expectedTools: [...entry.expectedTools] } : {}), tags: [...entry.tags], source: entry.source };
  return { id: entry.id, kind: 'scenario', scenario: { id: entry.scenario.id, version: entry.scenario.version.toString() }, tags: [...entry.tags], source: entry.source };
}

export function deserializeEvaluationCase(entry: SerializedEvaluationCase): EvaluationCase {
  if (entry.kind === 'turn') return { id: entry.id, kind: 'turn', input: entry.input, ...(entry.reference !== undefined ? { reference: entry.reference } : {}), ...(entry.expectedTools !== undefined ? { expectedTools: [...entry.expectedTools] } : {}), tags: [...entry.tags], source: entry.source };
  return { id: entry.id, kind: 'scenario', scenario: { id: entry.scenario.id, version: SemVer.parse(entry.scenario.version) }, tags: [...entry.tags], source: entry.source };
}

export function deserializeEvaluationCases(value: unknown): readonly EvaluationCase[] {
  const parsed = z.array(caseSchema).safeParse(value);
  if (!parsed.success) throw new EvaluationDomainError(`deserializeEvaluationCases: ${issues(parsed.error)}`);
  return parsed.data.map((entry) => deserializeEvaluationCase(entry as SerializedEvaluationCase));
}

export function serializeEvaluationDataset(dataset: EvaluationDataset): SerializedEvaluationDataset {
  return { metadata: serializeMetadata(dataset.metadata), cases: dataset.cases.map(serializeEvaluationCase) };
}

export function deserializeEvaluationDataset(value: unknown): EvaluationDataset {
  const parsed = datasetSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationDomainError(`deserializeEvaluationDataset: ${issues(parsed.error)}`);
  return createEvaluationDataset({ metadata: { ...parsed.data.metadata, version: SemVer.parse(parsed.data.metadata.version), tenant: { ...parsed.data.metadata.tenant } }, cases: parsed.data.cases.map((entry) => deserializeEvaluationCase(entry as SerializedEvaluationCase)) });
}

export function serializeEvaluatorProfile(profile: EvaluatorProfile): SerializedEvaluatorProfile {
  return { metadata: serializeMetadata(profile.metadata), metrics: profile.metrics.map((metric) => metric.kind === 'code' ? { ...metric } : { ...metric, rubric: { id: metric.rubric.id, version: metric.rubric.version.toString() } }) };
}

export function deserializeEvaluatorProfile(value: unknown): EvaluatorProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationDomainError(`deserializeEvaluatorProfile: ${issues(parsed.error)}`);
  return createEvaluatorProfile({ metadata: { ...parsed.data.metadata, version: SemVer.parse(parsed.data.metadata.version), tenant: { ...parsed.data.metadata.tenant } }, metrics: parsed.data.metrics.map((metric) => metric.kind === 'code' ? metric : { ...metric, rubric: { id: metric.rubric.id, version: SemVer.parse(metric.rubric.version) } }) });
}

export function serializeJudgeRubric(rubric: JudgeRubric): SerializedJudgeRubric {
  return { metadata: serializeMetadata(rubric.metadata), instructions: rubric.instructions, criteria: rubric.criteria.map((criterion) => ({ ...criterion, levels: criterion.levels.map((level) => ({ ...level })) })), referencePolicy: rubric.referencePolicy, reasonRequired: true };
}

export function deserializeJudgeRubric(value: unknown): JudgeRubric {
  const parsed = rubricSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationDomainError(`deserializeJudgeRubric: ${issues(parsed.error)}`);
  return createJudgeRubric({ metadata: { ...parsed.data.metadata, version: SemVer.parse(parsed.data.metadata.version), tenant: { ...parsed.data.metadata.tenant } }, instructions: parsed.data.instructions, criteria: parsed.data.criteria, referencePolicy: parsed.data.referencePolicy, reasonRequired: true });
}

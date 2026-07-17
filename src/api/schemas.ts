/**
 * api層: リクエスト Zod スキーマ（v4 実装契約 §3）
 *
 * - graph は構造だけ検証する（config の中身は各ノードの validateConfig に委ねる）。
 * - version 文字列の SemVer 妥当性はルート側で `SemVer.parse` を try し、
 *   失敗を BadRequestError へ変換する（本ファイルでは文字列としてのみ受ける）。
 */
import { z } from 'zod';
import { PUBLISH_STATES, SIDE_EFFECTS } from '../domain/tool/metadata';
import type { PublishState, SideEffect } from '../domain/tool/metadata';
import { AGENT_KINDS } from '../domain/agent/agent';
import { STRUCTURED_OUTPUT_TYPES } from '../domain/agent/structured-output';
import { HARNESS_PATTERNS } from '../domain/harness/agent-harness';
import { PERSONA_ARCHETYPES, PERSONA_LANGUAGES, PERSONA_LEVELS, PERSONA_VERBOSITIES } from '../domain/validation/persona';
import { SURVEY_QUESTION_KINDS } from '../domain/validation/survey';
import { CODE_SCORERS } from '../domain/evaluation/evaluator-profile';
import { EVALUATION_CASE_SOURCES } from '../domain/evaluation/evaluation-dataset';
import { JUDGE_REFERENCE_POLICIES } from '../domain/evaluation/judge-rubric';

/** テナントスコープ（tenantId / workspaceId 非空）。 */
export const tenantScopeSchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
});

/** ToolGraph の構造検証（config は unknown のまま通す）。 */
export const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      config: z.unknown(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      toInput: z.number().optional(),
    }),
  ),
});

/** Schema（列定義）の構造検証。 */
const dataSchemaSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['string', 'number', 'boolean', 'date', 'null', 'unknown']),
      nullable: z.boolean(),
    }),
  ),
});

/** POST /tools の body（§4）。 */
export const saveToolBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1),
  workingName: z.string().min(1),
  displayName: z.string().min(1),
  publishName: z.string().min(1),
  owner: z.string().min(1),
  sideEffect: z.enum(SIDE_EFFECTS as [SideEffect, ...SideEffect[]]),
  graph: graphSchema,
  inputSchema: dataSchemaSchema.optional(),
  outputSchema: dataSchemaSchema.optional(),
  agentTool: z.object({ name: z.string().min(1).max(64), description: z.string().min(1).max(2_000) }).optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

const agentToolRefSchema = z.object({
  internalId: z.string().min(1),
  version: z.string().min(1),
});

const agentSubAgentRefSchema = z.object({
  internalId: z.string().min(1),
  version: z.string().min(1),
  usage: z.string().min(1),
});

const structuredOutputSchema = z.object({
  name: z.string().min(1).max(64),
  fields: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(STRUCTURED_OUTPUT_TYPES),
    required: z.boolean(),
    description: z.string().optional(),
  })).min(1),
});

/** POST /agents の body。Tool参照は保存済みversionへ固定する。 */
export const saveAgentBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1),
  workingName: z.string().min(1),
  displayName: z.string().min(1),
  publishName: z.string().min(1),
  owner: z.string().min(1),
  kind: z.enum(AGENT_KINDS),
  systemPrompt: z.string().min(1),
  skills: z.array(agentToolRefSchema).default([]),
  tools: z.array(agentToolRefSchema),
  agents: z.array(agentSubAgentRefSchema).default([]),
  wikis: z.array(z.object({ wikiId: z.string().min(1) })).default([]),
  output: structuredOutputSchema.optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

/** 未保存Agent向けprompt生成。 */
export const agentDraftPromptBodySchema = z.object({
  scope: tenantScopeSchema,
  displayName: z.string().min(1),
  kind: z.enum(AGENT_KINDS),
  skills: z.array(agentToolRefSchema).default([]),
  tools: z.array(agentToolRefSchema),
  agents: z.array(agentSubAgentRefSchema).default([]),
  output: structuredOutputSchema.optional(),
});

/** 保存済みAgent向けprompt生成。 */
export const agentPromptBodySchema = z.object({
  scope: tenantScopeSchema,
  version: z.string().optional(),
});

const skillFieldsSchema = {
  responsibility: z.string().min(1),
  activationCondition: z.string().min(1),
  inputDescription: z.string().min(1),
  outputDescription: z.string().min(1),
  tools: z.array(agentToolRefSchema),
} as const;

export const saveSkillBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1),
  publishName: z.string().min(1), owner: z.string().min(1), ...skillFieldsSchema,
  instructions: z.string().min(1),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});
export const skillDraftPromptBodySchema = z.object({ scope: tenantScopeSchema, displayName: z.string().min(1), ...skillFieldsSchema });
export const skillPromptBodySchema = z.object({ scope: tenantScopeSchema, version: z.string().optional() });

/** POST /tools/:id/infer-schema・/preview の body。 */
export const previewBodySchema = z.object({
  scope: tenantScopeSchema,
  version: z.string().optional(),
  rowLimit: z.number().int().min(1).max(10000).optional(),
});

/** 未保存 graph のスキーマ点検 body。 */
export const draftInspectBodySchema = z.object({
  graph: graphSchema,
  scope: tenantScopeSchema.optional(),
});

/** 未保存 graph のプレビュー body。 */
export const draftPreviewBodySchema = z.object({
  graph: graphSchema,
  scope: tenantScopeSchema.optional(),
  rowLimit: z.number().int().min(1).max(10000).optional(),
});

const runBaseSchema = {
  scope: tenantScopeSchema,
  message: z.string().min(1),
  mode: z.enum(['preview', 'test']).default('preview'),
} as const;

const imageAttachmentSchema = z.object({
  name: z.string().min(1).max(200),
  // SVGと外部URLを除外する。データURLに限定してサーバーが意図せず外部へアクセスしないようにする。
  dataUrl: z.string().max(4_200_000).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
});

const harnessSlotSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), purpose: z.string().min(1),
  assignment: z.object({ internalId: z.string().min(1), version: z.string().min(1) }),
});
const harnessTopologySchema = z.discriminatedUnion('pattern', [
  z.object({ pattern: z.literal('agent-as-tools'), coordinatorSlotId: z.string().min(1), participantSlotIds: z.array(z.string().min(1)).min(1) }),
  z.object({ pattern: z.literal('sequential'), orderedSlotIds: z.array(z.string().min(1)).min(2), contextMode: z.enum(['full-conversation', 'previous-response']) }),
  z.object({ pattern: z.literal('concurrent'), participantSlotIds: z.array(z.string().min(1)).min(2), aggregation: z.enum(['collect', 'vote', 'agent']), aggregatorSlotId: z.string().min(1).optional() }),
  z.object({ pattern: z.literal('handoff'), startSlotId: z.string().min(1), transitions: z.array(z.object({ fromSlotId: z.string().min(1), toSlotId: z.string().min(1), condition: z.string().min(1) })).min(1), autonomous: z.boolean().default(false) }),
  z.object({ pattern: z.literal('group-chat'), participantSlotIds: z.array(z.string().min(1)).min(2), selector: z.enum(['round-robin', 'fixed-order', 'agent']), managerSlotId: z.string().min(1).optional(), maxRounds: z.number().int().min(1).max(100) }),
  z.object({ pattern: z.literal('magentic'), managerSlotId: z.string().min(1), participantSlotIds: z.array(z.string().min(1)).min(2), maxRounds: z.number().int().min(1).max(100), maxStalls: z.number().int().min(0).max(100), maxResets: z.number().int().min(0).max(100), requirePlanSignoff: z.boolean().default(false) }),
]);
const harnessPoliciesSchema = z.object({
  budget: z.object({ maxDurationMs: z.number().int().min(1_000).max(3_600_000), maxParticipantRuns: z.number().int().min(1).max(100), maxModelRounds: z.number().int().min(1).max(200), maxToolCalls: z.number().int().min(1).max(500), maxParallelism: z.number().int().min(1).max(32) }),
  context: z.enum(['task-only', 'previous-response', 'full-conversation']),
  planning: z.object({ enabled: z.boolean(), requireApproval: z.boolean() }),
  memory: z.object({ wikiIds: z.array(z.string().min(1)), sessionWorkspace: z.boolean() }),
  approvals: z.object({ mode: z.enum(['inherit-agent', 'always', 'disabled-in-preview']) }),
  failure: z.object({ mode: z.enum(['fail-fast', 'collect', 'continue-with-error']) }),
});

/** POST /harnesses と Harness Draft 検証の共通DTO。Agent参照は保存時にSemVer固定される。 */
export const saveHarnessBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1), publishName: z.string().min(1), owner: z.string().min(1),
  pattern: z.enum(HARNESS_PATTERNS), slots: z.array(harnessSlotSchema).min(1), topology: harnessTopologySchema,
  policies: harnessPoliciesSchema.optional(), output: z.object({ format: z.literal('text') }).optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
}).superRefine((value, context) => {
  if (value.pattern !== value.topology.pattern) context.addIssue({ code: 'custom', path: ['topology', 'pattern'], message: 'topology.pattern must match pattern' });
});

export const harnessListQuerySchema = tenantScopeSchema;
export const runHarnessBodySchema = z.object({
  scope: tenantScopeSchema,
  harness: z.object({ internalId: z.string().min(1), version: z.string().min(1).optional() }),
  message: z.string().min(1), mode: z.enum(['preview', 'test']).default('preview'),
});
export const resumeHarnessRunBodySchema = z.object({
  scope: tenantScopeSchema,
  response: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('input'), message: z.string().min(1) }),
    z.object({ kind: z.literal('approval'), decision: z.enum(['approve', 'revise', 'reject']), feedback: z.string().min(1).optional() }),
  ]),
});
export const cancelHarnessRunBodySchema = z.object({ scope: tenantScopeSchema });
export const harnessRunQuerySchema = tenantScopeSchema;
export const harnessRunListQuerySchema = tenantScopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'waiting-input', 'waiting-approval', 'cancelled']).optional(),
});

/** POST /runs: inline Tool previewまたは保存済みAgent preview。 */
export const runAgentBodySchema = z.union([z.object({
  ...runBaseSchema,
  tool: z.object({
    internalId: z.string().min(1),
    version: z.string().optional(),
  }),
  systemPrompt: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  images: z.array(imageAttachmentSchema).max(2).optional(),
}), z.object({
  ...runBaseSchema,
  agent: z.object({
    internalId: z.string().min(1),
    version: z.string().optional(),
  }),
  /** 手動アタッチする Wiki ページ id（指定時のみ最小注入する・v21 M1）。 */
  memoryPageIds: z.array(z.string().min(1)).optional(),
  sessionId: z.string().min(1).optional(),
  images: z.array(imageAttachmentSchema).max(2).optional(),
})]);

export const createAgentSessionBodySchema = z.object({
  scope: tenantScopeSchema,
  agent: z.object({ internalId: z.string().min(1), version: z.string().optional() }),
});

/** ローカルLLMに分析nodeの設定案だけを依頼する。 */
export const analysisSuggestionBodySchema = z.object({
  scope: tenantScopeSchema.optional(), graph: graphSchema, nodeId: z.string().min(1), intent: z.string().min(1).max(2_000),
});
export const closeAgentSessionBodySchema = z.object({ scope: tenantScopeSchema });
export const sessionScopeQuerySchema = tenantScopeSchema;
export const sessionArtifactQuerySchema = tenantScopeSchema.extend({ limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(1_000_000).optional(), section: z.enum(['nodes', 'edges']).optional() });

export const runListQuerySchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['running', 'succeeded', 'failed']).optional(),
});

export const runTraceQuerySchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
});

/** POST /personas の body（v16 §5）。 */
export const savePersonaBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1),
  publishName: z.string().min(1), owner: z.string().min(1),
  archetype: z.enum(PERSONA_ARCHETYPES),
  knowledgeLevel: z.enum(PERSONA_LEVELS),
  patience: z.enum(PERSONA_LEVELS),
  tone: z.string().min(1),
  verbosity: z.enum(PERSONA_VERBOSITIES),
  language: z.enum(PERSONA_LANGUAGES),
  extraInstructions: z.string().optional(),
  promptOverride: z.string().optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

const surveyQuestionSchema = z.object({
  id: z.string().min(1),
  textJa: z.string().min(1),
  textEn: z.string().min(1),
  kind: z.enum(SURVEY_QUESTION_KINDS),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** POST /scenarios の body（対象Agent・Personaはversion固定参照。整合はユースケース側で検証）。 */
export const saveScenarioBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1),
  publishName: z.string().min(1), owner: z.string().min(1),
  target: z.object({ agentId: z.string().min(1), version: z.string().min(1) }),
  persona: z.object({ personaId: z.string().min(1), version: z.string().min(1) }).optional(),
  pseudoUser: z.object({ agentId: z.string().min(1), version: z.string().min(1) }).optional(),
  goal: z.string().min(1),
  context: z.string().optional(),
  maxUserTurns: z.number().int(),
  expectedTools: z.array(z.string()).optional(),
  survey: z.array(surveyQuestionSchema),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

/** POST /scenarios/:id/run の body。 */
export const runScenarioBodySchema = z.object({
  scope: tenantScopeSchema,
  version: z.string().optional(),
  mode: z.enum(['preview', 'test']).default('preview'),
});

/** GET /scenario-runs の query。 */
export const scenarioRunListQuerySchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  scenarioId: z.string().optional(),
});

/** GET /tools/:id 系の query（version は任意文字列、妥当性はルート側）。 */
export const versionQuerySchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  version: z.string().optional(),
});

export const scopeQuerySchema = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
});

/** GET /agents のクエリ（任意で kind フィルタ）。 */
export const agentListQuerySchema = scopeQuerySchema.extend({
  kind: z.enum(AGENT_KINDS).optional(),
});

/** POST /evaluations の body（v20）。 */
export const evaluateBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  input: z.string().min(1),
  output: z.string().min(1),
  reference: z.string().optional(),
});

/** POST /wiki の body（v21・長期記憶 M1）。id 省略で新規、既存 id で改訂。 */
export const saveWikiBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  wikiId: z.string().min(1).optional(),
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  body: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
});

/** GET /wiki のクエリ（q 省略で全件、limit 既定 10）。 */
export const wikiSearchQuerySchema = scopeQuerySchema.extend({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  wikiId: z.string().min(1).optional(),
});
/** データソース: file本文はAPI上限5MiBに加え、JSON文字列の上限を早期に絞る。 */
export const dataSourceListQuerySchema = scopeQuerySchema;
export const saveFileDataSourceBodySchema = z.object({
  scope: tenantScopeSchema,
  name: z.string().min(1).max(255),
  format: z.enum(['csv', 'json']),
  content: z.string().min(1).max(5 * 1024 * 1024),
});
export const registerDatabaseDataSourceBodySchema = z.object({
  scope: tenantScopeSchema,
  name: z.string().min(1).max(255),
  connectionId: z.string().min(1).max(128),
  defaultSchema: z.string().min(1).max(128).optional(),
});

/** 検索結果の明示取得。キーはbodyに含めず、backend環境変数でのみ解決する。 */
export const webSearchFetchBodySchema = z.object({
  scope: tenantScopeSchema,
  provider: z.enum(['tavily', 'tinyfish', 'google-custom-search']),
  query: z.string().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(10).optional(),
  includeDomains: z.array(z.string().min(1).max(253)).max(10).optional(),
});
export const databaseConnectionTestBodySchema = z.object({ scope: tenantScopeSchema });

export const saveWikiSpaceBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

/** POST /memory/reflect の body（v21・長期記憶 M2）。 */
export const reflectRunBodySchema = z.object({
  scope: tenantScopeSchema,
  input: z.string().min(1),
  output: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  targetSkillId: z.string().min(1).optional(),
  existingWikiPageId: z.string().min(1).optional(),
  targetWikiId: z.string().min(1).optional(),
});

/** GET /memory/proposals のクエリ（state 省略で全件）。 */
export const proposalListQuerySchema = scopeQuerySchema.extend({
  state: z.enum(['draft', 'approved', 'rejected']).optional(),
});

/** 記憶提案の承認・却下・スコープ限定操作の body。 */
export const proposalDecisionBodySchema = z.object({ scope: tenantScopeSchema });

/** POST /personas/:id/register-agent の body（v18）。 */
export const registerPseudoUserAgentBodySchema = z.object({
  scope: tenantScopeSchema,
  personaVersion: z.string().min(1).optional(),
  agentInternalId: z.string().min(1).optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  promptOverride: z.string().min(1).optional(),
});

const evaluationCaseSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1), kind: z.literal('turn'), input: z.string().min(1), reference: z.string().optional(),
    expectedTools: z.array(z.string()).optional(), tags: z.array(z.string()), source: z.enum(EVALUATION_CASE_SOURCES).default('manual'),
  }),
  z.object({
    id: z.string().min(1), kind: z.literal('scenario'), scenario: z.object({ id: z.string().min(1), version: z.string().min(1) }),
    tags: z.array(z.string()), source: z.enum(EVALUATION_CASE_SOURCES).default('manual'),
  }),
]);

export const saveEvaluationDatasetBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1), publishName: z.string().min(1), owner: z.string().min(1),
  cases: z.array(evaluationCaseSchema).min(1), bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

export const importEvaluationDatasetBodySchema = z.object({
  scope: tenantScopeSchema,
  format: z.enum(['json', 'csv']),
  content: z.string().min(1),
});

export const evaluationDatasetExportQuerySchema = versionQuerySchema.extend({ format: z.enum(['json', 'csv']).default('json') });

export const saveEvaluatorProfileBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1), publishName: z.string().min(1), owner: z.string().min(1),
  metrics: z.array(z.discriminatedUnion('kind', [
    z.object({ id: z.string().min(1), kind: z.literal('code'), weight: z.number().positive(), required: z.boolean(), scorer: z.enum(CODE_SCORERS) }),
    z.object({ id: z.string().min(1), kind: z.literal('judge'), weight: z.number().positive(), required: z.boolean(), rubric: z.object({ id: z.string().min(1), version: z.string().min(1) }) }),
  ])).min(1),
  bump: z.enum(['major', 'minor', 'patch']).optional(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

export const saveJudgeRubricBodySchema = z.object({
  scope: tenantScopeSchema,
  internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1), publishName: z.string().min(1), owner: z.string().min(1), instructions: z.string().min(1),
  criteria: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().min(1), weight: z.number().positive(), levels: z.array(z.object({ score: z.number().min(0).max(1), label: z.string().min(1), description: z.string().min(1) })).min(2) })).min(1),
  referencePolicy: z.enum(JUDGE_REFERENCE_POLICIES), bump: z.enum(['major', 'minor', 'patch']).optional(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

export const createExperimentBodySchema = z.object({
  scope: tenantScopeSchema,
  target: z.object({ agentId: z.string().min(1), version: z.string().min(1) }),
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  evaluatorProfile: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  repetitions: z.number().int().min(1).max(10).optional(),
});

export const experimentListQuerySchema = scopeQuerySchema.extend({ status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).optional() });
export const experimentActionBodySchema = z.object({ scope: tenantScopeSchema });

const gateRuleSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('metric-threshold'), metric: z.string().min(1), operator: z.enum(['gte', 'lte']), threshold: z.number().finite() }),
  z.object({ id: z.string().min(1), kind: z.literal('max-regression'), metric: z.string().min(1), maxRegression: z.number().finite().nonnegative() }),
  z.object({ id: z.string().min(1), kind: z.literal('required-case-pass'), tags: z.array(z.string().min(1)).default([]) }),
]);
export const saveGatePolicyBodySchema = z.object({
  scope: tenantScopeSchema, internalId: z.string().min(1), workingName: z.string().min(1), displayName: z.string().min(1), publishName: z.string().min(1), owner: z.string().min(1),
  rules: z.array(gateRuleSchema).min(1), reportTtlHours: z.number().int().min(1).max(2160).optional(), bump: z.enum(['major', 'minor', 'patch']).optional(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});
export const experimentComparisonBodySchema = z.object({ scope: tenantScopeSchema, baselineExperimentId: z.string().min(1), candidateExperimentId: z.string().min(1) });
export const evaluateGateBodySchema = z.object({ scope: tenantScopeSchema, policy: z.object({ id: z.string().min(1), version: z.string().min(1) }), candidateExperimentId: z.string().min(1), baselineExperimentId: z.string().min(1).optional() });
export const gateReportListQuerySchema = scopeQuerySchema.extend({ candidateExperimentId: z.string().min(1).optional() });
export const promotionListQuerySchema = scopeQuerySchema.extend({ agentId: z.string().min(1).optional() });
export const requestPromotionBodySchema = z.object({ scope: tenantScopeSchema, gateReportId: z.string().min(1), requestedBy: z.string().min(1) });
export const decidePromotionBodySchema = z.object({ scope: tenantScopeSchema, decidedBy: z.string().min(1), reason: z.string().optional() });

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
import { AGENT_KINDS, AGENT_MAX_MCP_SERVERS, AGENT_MCP_SERVER_NAME_MAX_LENGTH } from '../domain/agent/agent';
import { STRUCTURED_OUTPUT_TYPES } from '../domain/agent/structured-output';
import { HARNESS_PATTERNS } from '../domain/harness/agent-harness';
import { FACTORY_PROMPT_STRATEGIES } from '../domain/factory/factory-run';
import { PERSONA_ARCHETYPES, PERSONA_LANGUAGES, PERSONA_LEVELS, PERSONA_VERBOSITIES } from '../domain/validation/persona';
import { SURVEY_QUESTION_KINDS } from '../domain/validation/survey';
import { CODE_SCORERS } from '../domain/evaluation/evaluator-profile';
import { EVALUATION_CASE_SOURCES } from '../domain/evaluation/evaluation-dataset';
import { JUDGE_REFERENCE_POLICIES, JUDGE_TRACE_POLICIES } from '../domain/evaluation/judge-rubric';
import { MODEL_BASE_URL_MAX_LENGTH, MODEL_ID_MAX_LENGTH, MODEL_SLOT_NAMES, isHttpBaseUrl } from '../domain/model-settings/model-settings';
import { ACCOUNT_CATEGORIES, TAX_SIDES } from '../domain/journal/chart-of-accounts';
import { JOURNAL_CSV_PRESET_IDS } from '../domain/journal/csv-presets';
import {
  DIRECTIONS, DOCUMENT_KINDS, DOCUMENT_PAYLOAD_MAX_BYTES, DOCUMENT_SOURCE_TYPES, DOCUMENT_STATUSES,
  EXTRACTION_METHODS, INVOICE_STATUSES, PAYMENT_METHODS, type JsonValue,
} from '../domain/journal/document';
import { DECIDED_BY, ENTRY_STATUSES } from '../domain/journal/entry';
import { AMOUNT_SPEC_KEYWORDS, CONDITION_OPS, ENTRY_SIDES, RULE_MODES, RULE_ORIGINS } from '../domain/journal/rule';
import { JOURNAL_EXPORT_FORMATS } from '../application/journal/export-presets';
import {
  EXTRACT_IMAGE_MAX_CHARS as JOURNAL_EXTRACT_IMAGE_MAX_CHARS,
  EXTRACT_MAX_IMAGES as JOURNAL_EXTRACT_MAX_IMAGES,
  EXTRACT_TEXT_MAX_CHARS as JOURNAL_EXTRACT_TEXT_MAX_CHARS,
} from '../application/journal/extract-document';

/**
 * テナントスコープ。**サーバーはこの値を読まない**。
 *
 * ## なぜ「受け取るが無視する」のか
 *
 * 以前はこの値がテナント境界そのものだった（クライアントの自己申告）。今はスコープの唯一の
 * 供給源が認証済み `Principal`（`scopeOf(request)`・`src/api/authentication.ts`）で、
 * ここに書かれた値はどのルートからも参照されない。
 *
 * 「不一致なら403」ではなく「無視」を選んだ理由:
 *
 * - **安全性は同じ**。どちらもクライアントの申告を権威にしない。403 が増やすのは
 *   セキュリティではなく、クライアント側が自分のテナントIDを知っている必要という制約だけ。
 * - 403 にすると全クライアントが「送信前に自分のPrincipalを知る」必要が生まれ、
 *   起動直後（セッション取得前）や設定変更直後のタブが一斉に403で死ぬ経路ができる。
 * - 既存クライアント（UIの10画面・外部スクリプト）は送り続けても壊れない。
 *
 * 値の形だけは従来どおり検証する（空文字は打ち間違いなので400のまま）。
 * 新しいクライアントは**送らなくてよい**ので、両フィールドとも任意にした。
 */
export const tenantScopeSchema = z.object({
  tenantId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

/**
 * ToolGraph の構造検証（config は unknown のまま通す）。
 *
 * - `position` は編集UIのキャンバス座標。省略可（旧クライアント互換）で、実行には影響しない。
 * - nodes/edges の要素数は上限を設ける（巨大グラフでの検証・実行コストを入口で断つ）。
 */
export const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      config: z.unknown(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
  ).max(200),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      toInput: z.number().optional(),
    }),
  ).max(400),
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

/** 単一Agent実行のランタイムハーネス設定（Agent単位のopt-in）。 */
const agentRuntimeHarnessSchema = z.object({
  fileMemory: z.boolean(),
  todoProvider: z.boolean(),
  compaction: z.boolean(),
  webSearch: z.boolean(),
  toolApproval: z.boolean(),
  functionInvocation: z.boolean(),
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
  // MCPサーバー名の参照（実在検証は実行時。保存時は形と件数だけを縛る）。
  mcpServers: z.array(z.string().min(1).max(AGENT_MCP_SERVER_NAME_MAX_LENGTH)).max(AGENT_MAX_MCP_SERVERS).default([]),
  harness: agentRuntimeHarnessSchema.optional(),
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
  /** 直前までの会話履歴（Chatのマルチターン用）。system直後へ注入される。 */
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).max(40).optional(),
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

export const runListQuerySchema = tenantScopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'waiting-approval']).optional(),
});

/** POST /runs/:runId/resume: toolApproval で停止した単一エージェントRunの承認結果。 */
export const resumeRunBodySchema = z.object({
  scope: tenantScopeSchema,
  decision: z.enum(['approve', 'reject']),
  feedback: z.string().max(2_000).optional(),
});

export const runTraceQuerySchema = tenantScopeSchema;

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
export const scenarioRunListQuerySchema = tenantScopeSchema.extend({
  scenarioId: z.string().optional(),
});

/** GET /tools/:id 系の query（version は任意文字列、妥当性はルート側）。 */
export const versionQuerySchema = tenantScopeSchema.extend({
  version: z.string().optional(),
});

/** スコープだけを受けるクエリ。中身は `tenantScopeSchema` と同じで、どちらも読まれない。 */
export const scopeQuerySchema = tenantScopeSchema;

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
  referencePolicy: z.enum(JUDGE_REFERENCE_POLICIES), tracePolicy: z.enum(JUDGE_TRACE_POLICIES).optional(), bump: z.enum(['major', 'minor', 'patch']).optional(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

export const createExperimentBodySchema = z.object({
  scope: tenantScopeSchema,
  target: z.object({ agentId: z.string().min(1), version: z.string().min(1) }),
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  evaluatorProfile: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  repetitions: z.number().int().min(1).max(10).optional(),
  judgeSamples: z.number().int().min(1).max(5).optional(),
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
/**
 * 昇格の申請・決定。
 *
 * `requestedBy` / `decidedBy` は**受理するが読まない**。以前はクライアントが自由に名乗れたため、
 * 「reviewer が承認した」という監査証跡を誰でも作れた。いまは `Principal.subject` を使う。
 * 受理を続ける理由は `tenantScopeSchema` と同じ（既存クライアントを400で止めない）。
 */
export const requestPromotionBodySchema = z.object({ scope: tenantScopeSchema, gateReportId: z.string().min(1), requestedBy: z.string().min(1).optional() });
export const decidePromotionBodySchema = z.object({ scope: tenantScopeSchema, decidedBy: z.string().min(1).optional(), reason: z.string().optional() });

/** POST /factory-runs の body（v33・Agent Factory M1 / docs/16-agent-factory.md §9）。options省略時はサーバー側既定を補完する。
 * `targets` / `budget` は指定する場合フィールド全体を渡す（`Partial<FactoryOptions>` はトップレベルのみ部分適用）。 */
const factoryOptionsInputSchema = z.object({
  maxIterations: z.number().int().min(1).max(10).optional(),
  personaCount: z.number().int().min(1).max(5).optional(),
  scenarioCount: z.number().int().min(1).max(10).optional(),
  requirePlanApproval: z.boolean().optional(),
  // 強化モード（baseAgent指定）でのみ効く。省略時はサーバー既定の 'preserve'（既存プロンプトを保つ）。
  promptStrategy: z.enum(FACTORY_PROMPT_STRATEGIES).optional(),
  targets: z.object({ minGoalAchievedRate: z.number().min(0).max(1), minAvgSatisfaction: z.number().min(1).max(5) }).optional(),
  budget: z.object({
    maxDurationMs: z.number().int().min(1_000),
    maxRoleCalls: z.number().int().min(1),
    maxScenarioRuns: z.number().int().min(1),
    maxRepairAttempts: z.number().int().min(0),
    maxProposalsPerIteration: z.number().int().min(0),
  }).optional(),
});
export const factoryRunBodySchema = z.object({
  scope: tenantScopeSchema,
  goal: z.object({
    goal: z.string().min(1),
    targetUsers: z.string().min(1).optional(),
    constraints: z.string().min(1).optional(),
    language: z.enum(['ja', 'en']),
  }),
  /** 強化対象の既存Agent（省略時は0→1生成モード）。`version` 省略時は最新版を起点にする。 */
  baseAgent: z.object({ internalId: z.string().min(1), version: z.string().min(1).optional() }).optional(),
  // 強化モードは既存Agentのプロンプト改善だけでも成立するため0件を許す。生成モードは下の refine で1件必須。
  dataSourceIds: z.array(z.string().min(1)).max(5).default([]),
  options: factoryOptionsInputSchema.optional(),
}).refine((body) => body.baseAgent !== undefined || body.dataSourceIds.length >= 1, {
  path: ['dataSourceIds'],
  message: 'dataSourceIds must contain at least 1 entry unless baseAgent is specified',
});
export const factoryRunListQuerySchema = scopeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['queued', 'running', 'waiting-approval', 'succeeded', 'failed', 'cancelled']).optional(),
});
export const factoryRunQuerySchema = scopeQuerySchema;
export const resumeFactoryRunBodySchema = z.object({
  scope: tenantScopeSchema,
  response: z.object({
    kind: z.literal('plan-approval'),
    decision: z.enum(['approve', 'revise', 'reject']),
    feedback: z.string().min(1).optional(),
  }),
});
export const cancelFactoryRunBodySchema = z.object({ scope: tenantScopeSchema });
/** POST /factory-runs/:runId/retry の body。失敗Runを同じ入力で再実行するだけなので scope のみ受け取る。 */
export const retryFactoryRunBodySchema = z.object({ scope: tenantScopeSchema });

/**
 * MCPクライアント: 外部MCPサーバー接続設定。
 *
 * transport は kind による判別union。`args` / `env` / `headers` は省略時に既定値へ落とし、
 * 標準 `mcpServers` JSON の「書かなければ空」という意味論に合わせる。
 */
const mcpStringRecordSchema = z.record(z.string(), z.string());
export const mcpTransportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: mcpStringRecordSchema.default({}),
    cwd: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().min(1),
    headers: mcpStringRecordSchema.default({}),
  }),
]);
export const mcpServerListQuerySchema = scopeQuerySchema;
export const saveMcpServerBodySchema = z.object({
  scope: tenantScopeSchema,
  server: z.object({
    name: z.string().min(1).max(64),
    transport: mcpTransportSchema,
    disabled: z.boolean().optional(),
  }),
});
/**
 * PUT /mcp-servers の body。`mcpServers` は標準ドキュメントの mcpServers 部をそのまま受ける。
 * 個々のエントリ構造の検証はドメイン（parseMcpServersDocument）が一手に担うため、
 * ここでは「オブジェクトであること」だけを見る（検証規則を二重管理しない）。
 */
export const replaceMcpServersBodySchema = z.object({
  scope: tenantScopeSchema,
  mcpServers: z.record(z.string(), z.unknown()),
});
export const testMcpServerBodySchema = z.object({ scope: tenantScopeSchema });

/**
 * モデル設定（v34）: main / judge のモデル切替。
 *
 * apiKey は **write-only の平文**（応答には決して含めない）。
 *   文字列 → 保存時に封緘 / 省略 → 既存のキーを維持 / 空文字・null → クリア。
 * スロット自体を null にすると設定を消して env 既定へ戻す。
 * `provider/model` 形式の検証はドメインが一手に担うが、**baseUrl は入口で必ず縛る**
 * （http(s) 限定・資格情報埋め込み禁止。保存経路以外でも同じ検証を通すため）。
 */
const modelBaseUrlSchema = z.string().min(1).max(MODEL_BASE_URL_MAX_LENGTH)
  .refine(isHttpBaseUrl, { message: 'must be an http(s) URL without embedded credentials' });
/** source ごとに baseUrl の要否が違うので判別unionにする（openai-compatible は必須）。 */
const modelSlotSettingsInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('registry'),
    model: z.string().min(1).max(MODEL_ID_MAX_LENGTH),
    apiKey: z.string().max(4096).nullable().optional(),
  }),
  z.object({
    source: z.literal('openai-compatible'),
    baseUrl: modelBaseUrlSchema,
    model: z.string().min(1).max(MODEL_ID_MAX_LENGTH),
    apiKey: z.string().max(4096).nullable().optional(),
  }),
]);
export const modelSettingsQuerySchema = scopeQuerySchema;
export const saveModelSettingsBodySchema = z.object({
  scope: tenantScopeSchema,
  main: modelSlotSettingsInputSchema.nullable().optional(),
  judge: modelSlotSettingsInputSchema.nullable().optional(),
});
export const testModelSettingsBodySchema = z.object({
  scope: tenantScopeSchema,
  slot: z.enum(MODEL_SLOT_NAMES),
  candidate: modelSlotSettingsInputSchema.optional(),
});
/**
 * OpenAI互換エンドポイントのモデル一覧（**POST**）。
 *
 * 保存済みキーを使い得る操作なので、GET（単純リクエスト）では受けない。
 * JSON body を要求することで `<img src=...>` / form 送信からは呼べなくなる（CSRF緩和）。
 * **apiKey は受け取らない**。保存済みキーを使いたい場合は slot を指定する
 * （実際に使うのは保存済み baseUrl と一致する宛先のときだけ）。
 */
export const openAiCompatibleModelsBodySchema = z.object({
  scope: tenantScopeSchema,
  baseUrl: modelBaseUrlSchema,
  slot: z.enum(MODEL_SLOT_NAMES).optional(),
});

// ---------------------------------------------------------------------------
// ツール検証（Tool Check）
// 引数・期待値は JSON セル（string / number / boolean / null）に限る（Agent の function calling が
// 渡せる値と同じ集合）。境界値（件数上限・文字数）はドメイン createToolCheckCase が正本で、
// ここでは形だけを検証する。
// ---------------------------------------------------------------------------
export const jsonCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const toolCheckExpectationsSchema = z.object({
  rowCount: z.object({ op: z.enum(['eq', 'gte', 'lte']), value: z.number() }).optional(),
  columns: z.array(z.string()).optional(),
  cells: z.array(z.object({ column: z.string(), op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains']), value: jsonCellSchema, mode: z.enum(['any', 'all']) })).optional(),
  maxDurationMs: z.number().optional(),
  outcome: z.enum(['success', 'error']).optional(),
});
export const runToolCheckBodySchema = z.object({
  scope: tenantScopeSchema,
  toolId: z.string().min(1),
  version: z.string().optional(),
  arguments: z.record(z.string(), jsonCellSchema),
  expectations: toolCheckExpectationsSchema.optional(),
  rowLimit: z.number().int().min(0).max(10000).optional(),
});
export const saveToolCheckCaseBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  toolId: z.string().min(1),
  toolVersion: z.string().optional(),
  name: z.string(),
  arguments: z.record(z.string(), jsonCellSchema),
  expectations: toolCheckExpectationsSchema,
});
export const toolCheckCaseListQuerySchema = scopeQuerySchema.extend({ toolId: z.string().min(1).optional() });
export const toolCheckCaseActionBodySchema = z.object({ scope: tenantScopeSchema });
export const runAllToolCheckCasesBodySchema = z.object({ scope: tenantScopeSchema, toolId: z.string().min(1).optional() });
/** LLM によるケース提案。perCategory の 1〜5 はここが正本（ユースケースは既定 2 を補うだけ）。 */
export const suggestToolCheckCasesBodySchema = z.object({
  scope: tenantScopeSchema,
  toolId: z.string().min(1),
  version: z.string().optional(),
  perCategory: z.number().int().min(1).max(5).optional(),
  focus: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// 仕訳（journal。docs/20-journal.md §9）
//
// 列挙はすべて domain から import する（api に書き写すと、種別や税区分を足したときに
// 「ドメインは受け付けるのに API が 400 を返す」というずれが静かに生まれる）。
// 値の不変条件（日付の実在・貸借一致・科目 id の一意性…）は domain の create* が正本で、
// ここは**形**だけを見る。金額・日付を `z.number()` / `z.string()` のまま通すのはそのため。
// ---------------------------------------------------------------------------

/**
 * facts の `extra` とルール条件の値（任意の JSON）。
 *
 * **domain の `JsonValue` として型付けする**。`z.ZodType<unknown>` にすると、パース結果が
 * `unknown` のまま `DocumentFacts.extra` や `RuleCondition.value` へ流れて型が合わなくなる
 * （実行時の検証は同じでも、境界で型が消えるとルート側が `as` だらけになる）。
 */
const journalJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(journalJsonValueSchema), z.record(z.string(), journalJsonValueSchema),
])) as z.ZodType<JsonValue>;

const journalTaxRateSchema = z.union([z.literal(10), z.literal(8), z.literal(0)]);

/** 正規化済み事実（§2.2）。 */
export const journalFactsSchema = z.object({
  direction: z.enum(DIRECTIONS).optional(),
  issuerName: z.string().optional(),
  recipientName: z.string().optional(),
  registrationNumber: z.string().optional(),
  issueDate: z.string().optional(),
  transactionDate: z.string().optional(),
  dueDate: z.string().optional(),
  grandTotal: z.number().optional(),
  totalsByRate: z.array(z.object({
    rate: journalTaxRateSchema, taxableAmount: z.number(), taxAmount: z.number().optional(), amountIncludesTax: z.boolean(),
  })).max(10).optional(),
  lines: z.array(z.object({
    description: z.string(), quantity: z.number().optional(), unitPrice: z.number().optional(),
    amount: z.number(), taxRate: journalTaxRateSchema.optional(), reducedRateMark: z.boolean().optional(),
  })).max(500).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  accountHint: z.string().optional(),
  description: z.string().optional(),
  descriptionNorm: z.string().optional(),
  counterpartyHint: z.string().optional(),
  extra: z.record(z.string(), journalJsonValueSchema).optional(),
});

/**
 * 証憑本体。`dataUrl`（画像）と `text`（原文）は domain と同じ 8 MiB を上限にする
 * （domain の検証にも同じ上限があるが、巨大な本文を JSON パース後まで運ばずに入口で断つ）。
 */
export const journalDocumentSourceSchema = z.object({
  type: z.enum(DOCUMENT_SOURCE_TYPES),
  fileName: z.string().max(255).optional(),
  mime: z.string().max(255).optional(),
  dataUrl: z.string().max(DOCUMENT_PAYLOAD_MAX_BYTES).optional(),
  text: z.string().max(DOCUMENT_PAYLOAD_MAX_BYTES).optional(),
  row: z.record(z.string(), z.string()).optional(),
  preset: z.string().max(64).optional(),
});

export const journalExtractionSchema = z.object({
  method: z.enum(EXTRACTION_METHODS),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  confidence: z.number().optional(),
  warnings: z.array(z.string()),
  fieldEvidence: z.record(z.string(), z.object({ sourceText: z.string().optional(), confidence: z.number() })).optional(),
});

/* 科目マスタ -------------------------------------------------------------- */

export const journalAccountSchema = z.object({
  id: z.string().min(1), code: z.string().optional(), name: z.string().min(1),
  category: z.enum(ACCOUNT_CATEGORIES), defaultTaxCode: z.string().optional(),
  aliases: z.array(z.string()), enabled: z.boolean(), sortOrder: z.number(), note: z.string().optional(),
});
export const journalDimensionSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  values: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), enabled: z.boolean() })).max(1000),
});
export const journalTaxCategorySchema = z.object({
  code: z.string().min(1), name: z.string().min(1), side: z.enum(TAX_SIDES),
  rate: z.number().optional(), deductionRate: z.number().optional(), enabled: z.boolean(),
  mapping: z.object({ yayoi: z.string().optional(), freee: z.string().optional(), mf: z.string().optional() }).optional(),
});

export const journalChartQuerySchema = scopeQuerySchema;
export const saveJournalChartBodySchema = z.object({
  scope: tenantScopeSchema,
  accounts: z.array(journalAccountSchema).max(2000),
  dimensions: z.array(journalDimensionSchema).max(50),
  taxCategories: z.array(journalTaxCategorySchema).max(200),
});
export const journalChartActionBodySchema = z.object({ scope: tenantScopeSchema });
/** 科目 CSV の本文はデータソースと同じ 5 MiB を上限にする。 */
export const journalChartImportBodySchema = z.object({
  scope: tenantScopeSchema,
  content: z.string().min(1).max(5 * 1024 * 1024),
});

/* ルール ------------------------------------------------------------------ */

export const journalConditionSchema = z.object({
  field: z.string().min(1), op: z.enum(CONDITION_OPS), value: journalJsonValueSchema.optional(),
});
const journalAmountSpecSchema = z.union([
  z.enum(AMOUNT_SPEC_KEYWORDS),
  z.object({ fixed: z.number() }),
  z.object({ ratio: z.number() }),
]);
export const journalOutcomeLineSchema = z.object({
  side: z.enum(ENTRY_SIDES),
  accountId: z.string().min(1),
  dimensionValues: z.record(z.string(), z.string()).optional(),
  taxCode: z.string().min(1),
  amount: journalAmountSpecSchema,
  partnerFrom: z.union([z.literal('issuerName'), z.literal('counterpartyHint'), z.object({ fixed: z.string() })]).optional(),
});
export const journalRuleDraftSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean(),
  mode: z.enum(RULE_MODES),
  priority: z.number(),
  scope: z.object({
    documentKinds: z.array(z.enum(DOCUMENT_KINDS)).optional(),
    direction: z.enum(DIRECTIONS).optional(),
    accountHints: z.array(z.string()).max(50).optional(),
  }),
  conditions: z.array(journalConditionSchema).max(50),
  outcome: z.object({
    lines: z.array(journalOutcomeLineSchema).min(1).max(100),
    descriptionTemplate: z.string().optional(),
    invoiceStatus: z.union([z.enum(INVOICE_STATUSES), z.literal('auto')]).optional(),
  }),
  askIf: z.array(z.object({
    conditions: z.array(journalConditionSchema).max(50), questionId: z.string().min(1), prompt: z.string().min(1),
  })).max(20),
  requiredFacts: z.array(z.string().min(1)).max(50),
  provenance: z.object({
    origin: z.enum(RULE_ORIGINS), hearingId: z.string().optional(), exampleDocumentIds: z.array(z.string()).max(100),
  }).optional(),
});

export const journalRuleListQuerySchema = scopeQuerySchema;
export const saveJournalRuleBodySchema = z.object({ scope: tenantScopeSchema, rule: journalRuleDraftSchema });
export const journalRuleTestBodySchema = z.object({
  scope: tenantScopeSchema,
  rule: journalRuleDraftSchema,
  documentIds: z.array(z.string().min(1)).max(200),
});

/* 文書 -------------------------------------------------------------------- */

export const journalDocumentListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(0).max(1000).optional(),
});
export const journalDocumentActionQuerySchema = scopeQuerySchema;
export const saveJournalDocumentBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  kind: z.enum(DOCUMENT_KINDS),
  source: journalDocumentSourceSchema,
  facts: journalFactsSchema,
  extraction: journalExtractionSchema.optional(),
});
/** CSV 本文はデータソース・科目 CSV と同じ 5 MiB。 */
export const journalImportCsvBodySchema = z.object({
  scope: tenantScopeSchema,
  preset: z.enum(JOURNAL_CSV_PRESET_IDS).optional(),
  content: z.string().min(1).max(5 * 1024 * 1024),
  fileName: z.string().max(255).optional(),
  accountHint: z.string().max(255).optional(),
  columnMapping: z.object({
    date: z.string().min(1), description: z.string().min(1),
    withdrawal: z.string().optional(), deposit: z.string().optional(), amount: z.string().optional(),
    balance: z.string().optional(), detail: z.string().optional(),
  }).optional(),
});
export const journalJudgeBodySchema = z.object({
  scope: tenantScopeSchema,
  documentIds: z.array(z.string().min(1)).max(1000).optional(),
});

/* 仕訳 -------------------------------------------------------------------- */

export const journalEntryLineSchema = z.object({
  side: z.enum(ENTRY_SIDES),
  accountId: z.string().min(1),
  /** 応答では確定時の名称を返すが、保存ではマスタから写し直すので受け取っても使わない。 */
  accountName: z.string().optional(),
  dimensionValues: z.record(z.string(), z.string()).optional(),
  taxCode: z.string().min(1),
  amount: z.number(),
  taxAmount: z.number().optional(),
  partner: z.string().optional(),
});
export const journalEntryListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(ENTRY_STATUSES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  documentId: z.string().min(1).optional(),
});
export const saveJournalEntryBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  ruleId: z.string().min(1).optional(),
  date: z.string().min(1),
  lines: z.array(journalEntryLineSchema).min(1).max(100),
  description: z.string(),
  invoiceStatus: z.enum(INVOICE_STATUSES),
  registrationNumber: z.string().optional(),
  item: z.string().optional(),
  tags: z.array(z.string()).max(50).optional(),
  decidedBy: z.enum(DECIDED_BY).optional(),
});
export const journalEntryActionBodySchema = z.object({ scope: tenantScopeSchema });

/**
 * 仕訳 CSV の出力。`markExported` はクエリなので文字列で受ける
 * （`z.coerce.boolean()` は `'false'` を true にするため使わない）。
 */
export const journalExportQuerySchema = scopeQuerySchema.extend({
  format: z.enum(JOURNAL_EXPORT_FORMATS).optional(),
  status: z.enum(ENTRY_STATUSES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  markExported: z.enum(['true', 'false']).optional(),
});

/* 帳票の LLM 読取（フェーズ 2。docs/20 §6） -------------------------------- */

/**
 * 画像はチャット添付と同じ上限（data URL で 4,200,000 文字）。**SVG と外部 URL は受けない**
 * （サーバーが意図せず外へ取りに行かないため。UI は長辺 2000px の JPEG へ縮小して送る）。
 * 保存はしないので `source` ではなく画像とテキストだけを受け取る。
 */
export const extractJournalDocumentBodySchema = z.object({
  scope: tenantScopeSchema,
  images: z.array(z.string().max(JOURNAL_EXTRACT_IMAGE_MAX_CHARS).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).max(JOURNAL_EXTRACT_MAX_IMAGES).optional(),
  text: z.string().max(JOURNAL_EXTRACT_TEXT_MAX_CHARS).optional(),
  fileName: z.string().max(255).optional(),
  hintKind: z.enum(DOCUMENT_KINDS).optional(),
});

/* ヒアリング（Stage 2。docs/20 §7） ---------------------------------------- */

/** 仕訳の草案（`saveJournalEntryBodySchema` から scope と保存用の id を除いた形）。 */
export const journalEntryDraftSchema = z.object({
  date: z.string().min(1),
  lines: z.array(journalEntryLineSchema).min(1).max(100),
  description: z.string(),
  invoiceStatus: z.enum(INVOICE_STATUSES),
  registrationNumber: z.string().optional(),
  item: z.string().optional(),
  tags: z.array(z.string()).max(50).optional(),
});

export const journalHearingListQuerySchema = scopeQuerySchema.extend({
  documentId: z.string().min(1).optional(),
});
export const journalHearingActionQuerySchema = scopeQuerySchema;
export const startJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  documentId: z.string().min(1),
});
export const answerJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  answers: z.array(z.object({ questionId: z.string().min(1), value: journalJsonValueSchema })).min(1).max(10),
});
/**
 * 受け入れ。`register*` は**利用者が明示的に選んだ id だけ**を並べる
 * （提案に載っていても選ばれなければマスタへ入らない。モデルが科目体系を勝手に増やせない要）。
 */
export const acceptJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  registerAccountIds: z.array(z.string().min(1)).max(10).optional(),
  registerDimensionValueIds: z.array(z.string().min(1)).max(10).optional(),
  registerTaxCodes: z.array(z.string().min(1)).max(5).optional(),
  rule: journalRuleDraftSchema.optional(),
  entry: journalEntryDraftSchema.optional(),
});
export const journalHearingActionBodySchema = z.object({ scope: tenantScopeSchema });

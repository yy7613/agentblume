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
import { PERSONA_ARCHETYPES, PERSONA_LANGUAGES, PERSONA_LEVELS, PERSONA_VERBOSITIES } from '../domain/validation/persona';
import { SURVEY_QUESTION_KINDS } from '../domain/validation/survey';

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
});

/** 未保存 graph のプレビュー body。 */
export const draftPreviewBodySchema = z.object({
  graph: graphSchema,
  rowLimit: z.number().int().min(1).max(10000).optional(),
});

const runBaseSchema = {
  scope: tenantScopeSchema,
  message: z.string().min(1),
  mode: z.enum(['preview', 'test']).default('preview'),
} as const;

/** POST /runs: inline Tool previewまたは保存済みAgent preview。 */
export const runAgentBodySchema = z.union([z.object({
  ...runBaseSchema,
  tool: z.object({
    internalId: z.string().min(1),
    version: z.string().optional(),
  }),
  systemPrompt: z.string().min(1),
}), z.object({
  ...runBaseSchema,
  agent: z.object({
    internalId: z.string().min(1),
    version: z.string().optional(),
  }),
  /** 手動アタッチする Wiki ページ id（指定時のみ最小注入する・v21 M1）。 */
  memoryPageIds: z.array(z.string().min(1)).optional(),
})]);

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
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  body: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
});

/** GET /wiki のクエリ（q 省略で全件、limit 既定 10）。 */
export const wikiSearchQuerySchema = scopeQuerySchema.extend({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** POST /memory/reflect の body（v21・長期記憶 M2）。 */
export const reflectRunBodySchema = z.object({
  scope: tenantScopeSchema,
  input: z.string().min(1),
  output: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  targetSkillId: z.string().min(1).optional(),
  existingWikiPageId: z.string().min(1).optional(),
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

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
  tools: z.array(agentToolRefSchema),
  output: structuredOutputSchema.optional(),
  bump: z.enum(['major', 'minor', 'patch']).optional(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]).optional(),
});

/** 未保存Agent向けprompt生成。 */
export const agentDraftPromptBodySchema = z.object({
  scope: tenantScopeSchema,
  displayName: z.string().min(1),
  kind: z.enum(AGENT_KINDS),
  tools: z.array(agentToolRefSchema),
  output: structuredOutputSchema.optional(),
});

/** 保存済みAgent向けprompt生成。 */
export const agentPromptBodySchema = z.object({
  scope: tenantScopeSchema,
  version: z.string().optional(),
});

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

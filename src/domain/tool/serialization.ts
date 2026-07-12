/**
 * ドメイン: Tool の直列化 / 復元（v2 実装契約 §8）
 *
 * serializeTool は Tool を JSON.stringify 可能な素のオブジェクトへ変換する
 * （SemVer→string 等）。deserializeTool は Zod で構造検証したのち
 * SemVer.parse → createTool を通す（不正→ToolValidationError）。
 *
 * config 値は JSON 直列化可能前提（Date 型 config 値の永続化は v2 範囲外）。
 */
import { z } from 'zod';
import type { DataType, Schema } from '../data/types';
import type { ToolGraph } from '../etl/graph';
import { ToolValidationError } from './errors';
import { PUBLISH_STATES, SIDE_EFFECTS } from './metadata';
import type { PublishState, SideEffect } from './metadata';
import { SemVer } from './semver';
import { createTool } from './tool';
import type { AgentToolContract, Tool } from './tool';

/** 永続化用の素データ表現。 */
export interface SerializedTool {
  metadata: {
    internalId: string;
    workingName: string;
    displayName: string;
    publishName: string;
    version: string;
    owner: string;
    state: PublishState;
    tenant: { tenantId: string; workspaceId: string };
  };
  sideEffect: SideEffect;
  graph: ToolGraph; // config: unknown は JSON そのまま
  inputSchema?: Schema;
  outputSchema?: Schema;
  agentTool?: AgentToolContract;
}

const dataTypeSchema: z.ZodType<DataType> = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'null',
  'unknown',
]);

const schemaSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      type: dataTypeSchema,
      nullable: z.boolean(),
    }),
  ),
});

const graphSchema = z.object({
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

const serializedToolSchema = z.object({
  metadata: z.object({
    internalId: z.string(),
    workingName: z.string(),
    displayName: z.string(),
    publishName: z.string(),
    version: z.string(),
    owner: z.string(),
    state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]),
    tenant: z.object({
      tenantId: z.string(),
      workspaceId: z.string(),
    }),
  }),
  sideEffect: z.enum(SIDE_EFFECTS as [SideEffect, ...SideEffect[]]),
  graph: graphSchema,
  inputSchema: schemaSchema.optional(),
  outputSchema: schemaSchema.optional(),
  agentTool: z.object({ name: z.string(), description: z.string() }).optional(),
});

/** Tool を JSON.stringify 可能な素のオブジェクトへ直列化する。 */
export function serializeTool(tool: Tool): SerializedTool {
  const { metadata } = tool;
  const data: SerializedTool = {
    metadata: {
      internalId: metadata.internalId,
      workingName: metadata.workingName,
      displayName: metadata.displayName,
      publishName: metadata.publishName,
      version: metadata.version.toString(),
      owner: metadata.owner,
      state: metadata.state,
      tenant: {
        tenantId: metadata.tenant.tenantId,
        workspaceId: metadata.tenant.workspaceId,
      },
    },
    sideEffect: tool.sideEffect,
    graph: {
      nodes: tool.graph.nodes.map((n) => ({ id: n.id, type: n.type, config: n.config })),
      edges: tool.graph.edges.map((e) =>
        e.toInput === undefined
          ? { from: e.from, to: e.to }
          : { from: e.from, to: e.to, toInput: e.toInput },
      ),
    },
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.agentTool !== undefined ? { agentTool: { ...tool.agentTool } } : {}),
  };
  return data;
}

/**
 * 素データを検証して Tool へ復元する。
 * Zod で SerializedTool を検証 → SemVer.parse → createTool。不正→ToolValidationError。
 */
export function deserializeTool(data: unknown): Tool {
  const parsed = serializedToolSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    throw new ToolValidationError(`deserializeTool: invalid SerializedTool: ${issues}`);
  }
  const value = parsed.data;

  // SemVer.parse は不正時に ToolValidationError を投げる。
  const version = SemVer.parse(value.metadata.version);

  return createTool({
    metadata: {
      internalId: value.metadata.internalId,
      workingName: value.metadata.workingName,
      displayName: value.metadata.displayName,
      publishName: value.metadata.publishName,
      version,
      owner: value.metadata.owner,
      state: value.metadata.state,
      tenant: {
        tenantId: value.metadata.tenant.tenantId,
        workspaceId: value.metadata.tenant.workspaceId,
      },
    },
    sideEffect: value.sideEffect,
    graph: value.graph,
    ...(value.inputSchema !== undefined ? { inputSchema: value.inputSchema } : {}),
    ...(value.outputSchema !== undefined ? { outputSchema: value.outputSchema } : {}),
    ...(value.agentTool !== undefined ? { agentTool: value.agentTool } : {}),
  });
}

/**
 * ドメイン: Tool 集約 + createTool ファクトリ（v2 実装契約 §7）
 *
 * Tool は「ETL グラフ + メタデータ + スキーマ」を束ねる集約。
 * createTool は不変条件を検査し（違反→ToolValidationError）、入力を複製して
 * 外部変更の影響を受けない readonly な Tool を返す。
 */
import type { Schema } from '../data/types';
import type { ToolGraph } from '../etl/graph';
import { assertNonEmpty } from '../shared/assert';
import { ToolValidationError } from './errors';
import type { TenantScope } from './ids';
import { isPublishState, isSideEffect } from './metadata';
import type { SideEffect, ToolMetadata } from './metadata';
import { SemVer } from './semver';

/** Agent/LLM に公開する Tool Calling 契約。未指定時は metadata から後方互換に導出する。 */
export interface AgentToolContract {
  readonly name: string;
  readonly description: string;
}

/** ETL グラフとメタデータを束ねる Tool 集約。 */
export interface Tool {
  readonly metadata: ToolMetadata;
  readonly sideEffect: SideEffect;
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;
  readonly outputSchema?: Schema;
  readonly agentTool?: AgentToolContract;
}

/** createTool の入力。 */
export interface CreateToolProps {
  readonly metadata: ToolMetadata;
  readonly sideEffect: SideEffect;
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;
  readonly outputSchema?: Schema;
  readonly agentTool?: AgentToolContract;
}

/** 非空文字列でなければ ToolValidationError。 */
function assertNonEmptyString(value: unknown, field: string): void {
  assertNonEmpty(value, `createTool: ${field}`, (m) => new ToolValidationError(m), { trim: false });
}

/** Schema を深く複製する（列配列と各列を複製）。 */
function cloneSchema(schema: Schema): Schema {
  return { columns: schema.columns.map((col) => ({ ...col })) };
}

/** ToolGraph を深く複製する（config は unknown なので構造共有せず JSON 深複製）。 */
function cloneGraph(graph: ToolGraph): ToolGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      config: cloneConfig(node.config),
      // 編集UIの配置は実行に影響しないが、往復で失わないよう複製して保持する。
      ...(node.position === undefined ? {} : { position: { x: node.position.x, y: node.position.y } }),
    })),
    edges: graph.edges.map((edge) =>
      edge.toInput === undefined
        ? { from: edge.from, to: edge.to }
        : { from: edge.from, to: edge.to, toInput: edge.toInput },
    ),
  };
}

/** config 値（JSON 直列化可能前提）の深複製。 */
function cloneConfig(config: unknown): unknown {
  if (config === null || typeof config !== 'object') return config;
  // JSON 直列化可能前提（v2 §8）。構造共有を避けるため deep clone する。
  return structuredClone(config);
}

/**
 * Tool を検証・複製して生成する。
 *
 * 不変条件（違反→ToolValidationError）:
 * - internalId/workingName/displayName/publishName/owner が非空文字列
 * - tenant.tenantId/workspaceId 非空
 * - version が SemVer インスタンス
 * - state が PublishState / sideEffect が SideEffect
 * - graph が存在し nodes が配列
 * 返す Tool は入力を複製したもので、外部変更の影響を受けない。
 */
export function createTool(props: CreateToolProps): Tool {
  const { metadata, sideEffect, graph, inputSchema, outputSchema, agentTool } = props;

  if (metadata === null || typeof metadata !== 'object') {
    throw new ToolValidationError('createTool: metadata is required');
  }

  assertNonEmptyString(metadata.internalId, 'metadata.internalId');
  assertNonEmptyString(metadata.workingName, 'metadata.workingName');
  assertNonEmptyString(metadata.displayName, 'metadata.displayName');
  assertNonEmptyString(metadata.publishName, 'metadata.publishName');
  assertNonEmptyString(metadata.owner, 'metadata.owner');

  const tenant: TenantScope | undefined = metadata.tenant;
  if (tenant === null || typeof tenant !== 'object') {
    throw new ToolValidationError('createTool: metadata.tenant is required');
  }
  assertNonEmptyString(tenant.tenantId, 'metadata.tenant.tenantId');
  assertNonEmptyString(tenant.workspaceId, 'metadata.tenant.workspaceId');

  if (!(metadata.version instanceof SemVer)) {
    throw new ToolValidationError('createTool: metadata.version must be a SemVer instance');
  }

  if (!isPublishState(metadata.state)) {
    throw new ToolValidationError(`createTool: invalid state: ${String(metadata.state)}`);
  }

  if (!isSideEffect(sideEffect)) {
    throw new ToolValidationError(`createTool: invalid sideEffect: ${String(sideEffect)}`);
  }

  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
    throw new ToolValidationError('createTool: graph with a nodes array is required');
  }
  if (!Array.isArray(graph.edges)) {
    throw new ToolValidationError('createTool: graph.edges must be an array');
  }
  if (agentTool !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentTool.name)) throw new ToolValidationError('createTool: agentTool.name must be a valid function name');
    assertNonEmptyString(agentTool.description, 'agentTool.description');
  }

  // 全て検証済み。入力を複製して外部変更の影響を受けない Tool を返す。
  const clonedMetadata: ToolMetadata = {
    internalId: metadata.internalId,
    workingName: metadata.workingName,
    displayName: metadata.displayName,
    publishName: metadata.publishName,
    version: metadata.version, // SemVer はイミュータブル
    owner: metadata.owner,
    state: metadata.state,
    tenant: { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId },
  };

  const tool: Tool = {
    metadata: clonedMetadata,
    sideEffect,
    graph: cloneGraph(graph),
    ...(inputSchema !== undefined ? { inputSchema: cloneSchema(inputSchema) } : {}),
    ...(outputSchema !== undefined ? { outputSchema: cloneSchema(outputSchema) } : {}),
    ...(agentTool !== undefined ? { agentTool: { name: agentTool.name, description: agentTool.description } } : {}),
  };

  return tool;
}

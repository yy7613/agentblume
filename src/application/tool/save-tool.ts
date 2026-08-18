/**
 * アプリ層: SaveToolUseCase（v2 実装契約 §10）
 *
 * 手順:
 * 1. 保存前グラフ検証: `engine.propagateSchemas(input.graph)`。
 *    `hasErrors === true` → ToolValidationError（検証済み構成のみ保存する）。
 *    GraphError 等の例外はそのまま伝播。
 * 2. バージョン決定: `repo.listVersions` が空 → 1.0.0、
 *    非空 → 最大バージョンを `bump(input.bump ?? 'patch')`。
 * 3. `createTool` で Tool 生成（state 既定 'draft'）。
 * 4. `repo.save(tool)`。
 * 5. `return tool`。
 */
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { FILTER_OPS, operatorBindingsOf } from '../../domain/etl/nodes/filter';
import type { OperatorBindingSite } from '../../domain/etl/nodes/filter';
import { ToolValidationError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { PublishState, SideEffect } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { AgentToolContract, Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { EtlEngine } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';

/** SaveToolUseCase の入力。 */
export interface SaveToolInput {
  readonly scope: TenantScope;
  readonly internalId: ToolId;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly sideEffect: SideEffect;
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;
  readonly outputSchema?: Schema;
  readonly agentTool?: AgentToolContract;
  /** バージョン繰り上げ部位。既定 'patch'。初回保存では無視され 1.0.0。 */
  readonly bump?: 'major' | 'minor' | 'patch';
  /** 公開状態。既定 'draft'。 */
  readonly state?: PublishState;
}

/** Tool を検証・採番して保存するユースケース。 */
export class SaveToolUseCase {
  constructor(
    private readonly repo: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
  ) {}

  async execute(input: SaveToolInput): Promise<Tool> {
    const requiresSessionWrite = hasSessionStorageSink(input.graph);
    if (requiresSessionWrite && input.sideEffect === 'read-only') {
      throw new ToolValidationError('SaveTool: workspace output requires sideEffect session-write or stronger');
    }
    validateAgentInputBindings(input.graph, input.inputSchema);
    // 1. 保存前グラフ検証（GraphError 等はそのまま伝播）。
    const executableGraph = this.resolveDataSources === undefined
      ? input.graph
      : await this.resolveDataSources.execute(input.scope, input.graph);
    const propagation = this.engine.propagateSchemas(executableGraph);
    if (propagation.hasErrors) {
      const messages = Object.values(propagation.nodes)
        .flatMap((node) =>
          node.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => `${node.nodeId}: ${issue.message}`),
        )
        .join('; ');
      throw new ToolValidationError(`SaveTool: graph validation failed: ${messages}`);
    }

    // 2. バージョン決定。
    const versions = await this.repo.listVersions(input.scope, input.internalId);
    const version =
      versions.length === 0
        ? SemVer.of(1, 0, 0)
        : maxVersion(versions).bump(input.bump ?? 'patch');

    // 3. Tool 生成（state 既定 'draft'）。
    const tool = createTool({
      metadata: {
        internalId: input.internalId,
        workingName: input.workingName,
        displayName: input.displayName,
        publishName: input.publishName,
        version,
        owner: input.owner,
        state: input.state ?? 'draft',
        tenant: input.scope,
      },
      sideEffect: input.sideEffect,
      graph: input.graph,
      ...(input.inputSchema !== undefined ? { inputSchema: input.inputSchema } : {}),
      ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
      ...(input.agentTool !== undefined ? { agentTool: input.agentTool } : {}),
    });

    // 4. 保存。
    await this.repo.save(tool);

    // 5. 生成した Tool を返す。
    return tool;
  }
}

/**
 * ツールのグラフが、セッションへ成果物を書き込む終端（workspace-output / graph-output /
 * chart-output、または agent-output の overflow=store-and-reference）を持つかどうか。
 * これらの終端を持つToolは最低 session-write の sideEffect を要求する。
 */
function hasSessionStorageSink(graph: ToolGraph): boolean {
  return graph.nodes.some((node) =>
    node.type === 'workspace-output' || node.type === 'graph-output' || node.type === 'chart-output'
    || (node.type === 'agent-output' && (node.config as { overflow?: unknown }).overflow === 'store-and-reference'));
}

/**
 * filter config（旧形式のフラットな1条件 / 新形式の `{ conditions, combine }`）から
 * `valueBinding: { source:'agent-input', field }` を集める。実行時（`graphWithArguments`）が
 * 差し替える対象と同じ集合を返す。
 */
function agentInputBindingsOf(config: unknown): { readonly source: 'agent-input'; readonly field: string }[] {
  const conditions = (config as { conditions?: unknown } | null)?.conditions;
  const sources = Array.isArray(conditions) ? conditions : [config];
  return sources
    .map((condition) => (condition as { valueBinding?: { source?: unknown; field?: unknown } } | null)?.valueBinding)
    .filter((binding): binding is { source: 'agent-input'; field: string } => binding?.source === 'agent-input' && typeof binding.field === 'string');
}

/**
 * filter ノードの Agent 引数バインド（valueBinding / opBinding）を宣言済み inputSchema と照合する。
 * - どちらのバインドがあっても inputSchema の宣言が必須で、参照 field は列として存在すること。
 * - opBinding の field は string 型の引数であること（演算子は inputSchema 上 string で受け取る契約）。
 * - 同一 field を複数条件がバインドする場合、全条件の allowed に共通する演算子が少なくとも1つ残ること
 *   （積集合が空だと Agent はどの演算子も渡せない）。
 * エラーメッセージの英文は UI 側の日本語化が文字列一致で依存するため変更しないこと。
 */
function validateAgentInputBindings(graph: ToolGraph, inputSchema: Schema | undefined): void {
  const configs = graph.nodes
    .filter((node) => node.type === 'filter')
    .map((node) => node.config);
  const valueBindings = configs.flatMap((config) => agentInputBindingsOf(config));
  const operatorSites = configs.flatMap((config) => operatorBindingsOf(config));
  if (valueBindings.length === 0 && operatorSites.length === 0) return;
  if (inputSchema === undefined) throw new ToolValidationError('SaveTool: Agent input bindings require an inputSchema');
  for (const binding of valueBindings) {
    if (!inputSchema.columns.some((column) => column.name === binding.field)) {
      throw new ToolValidationError(`SaveTool: Agent input binding references unknown field '${binding.field}'`);
    }
  }
  const sitesByField = new Map<string, OperatorBindingSite[]>();
  for (const site of operatorSites) {
    const sites = sitesByField.get(site.field);
    if (sites === undefined) sitesByField.set(site.field, [site]);
    else sites.push(site);
  }
  for (const [field, sites] of sitesByField) {
    const column = inputSchema.columns.find((candidate) => candidate.name === field);
    if (column === undefined) {
      throw new ToolValidationError(`SaveTool: Agent input binding references unknown field '${field}'`);
    }
    if (column.type !== 'string') {
      throw new ToolValidationError(`SaveTool: operator binding for argument '${field}' requires a string argument, but it is declared as '${column.type}'`);
    }
    if (!FILTER_OPS.some((op) => sites.every((site) => site.allowed.includes(op)))) {
      throw new ToolValidationError(`SaveTool: operator binding for argument '${field}' has no operator that every condition allows`);
    }
  }
}

/** SemVer 配列の最大値を返す（呼び出し側で非空を保証）。 */
function maxVersion(versions: readonly SemVer[]): SemVer {
  let max = versions[0] as SemVer;
  for (const v of versions) {
    if (v.compare(max) > 0) max = v;
  }
  return max;
}

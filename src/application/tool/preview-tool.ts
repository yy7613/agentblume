/**
 * アプリ層: PreviewToolUseCase（v3 実装契約 §2）
 *
 * 保存済み Tool を取得して EtlEngine に委譲する。
 * - `inspect`: スキーマ点検（実行なし）= `engine.propagateSchemas(tool.graph)`。
 * - `preview`: プレビュー実行（行数制限つき）= `engine.preview(tool.graph, { rowLimit })`。
 *
 * 取得は `options.version` 指定時 `repo.findVersion`、無指定時 `repo.findLatest`。
 * `null` → ToolNotFoundError。
 */
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { EtlEngine } from '../etl/engine';
import type { PropagationResult, PreviewResult } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';

/** inspect / preview 共通のオプション。 */
export interface PreviewToolOptions {
  /** 対象バージョン。省略時 latest。 */
  readonly version?: SemVer;
  /** engine.preview へ委譲する行数上限（既定は engine 側の 100）。 */
  readonly rowLimit?: number;
}

/** inspect の結果（対象 Tool + スキーマ伝播結果）。 */
export interface ToolInspection {
  readonly tool: Tool;
  readonly propagation: PropagationResult;
}

/** preview の結果（対象 Tool + プレビュー実行結果）。 */
export interface ToolPreview {
  readonly tool: Tool;
  readonly result: PreviewResult;
}

/** 保存済み Tool のスキーマ点検・プレビュー実行ユースケース。 */
export class PreviewToolUseCase {
  constructor(
    private readonly repo: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
  ) {}

  /** 保存済み Tool のスキーマ点検（実行なし）。未存在→ToolNotFoundError。 */
  async inspect(
    scope: TenantScope,
    internalId: ToolId,
    options?: PreviewToolOptions,
  ): Promise<ToolInspection> {
    const tool = await this.load(scope, internalId, options?.version);
    const graph = this.resolveDataSources === undefined ? tool.graph : await this.resolveDataSources.execute(scope, tool.graph);
    return { tool, propagation: this.engine.propagateSchemas(graph) };
  }

  /** 保存済み Tool のプレビュー実行（行数制限つき）。未存在→ToolNotFoundError。 */
  async preview(
    scope: TenantScope,
    internalId: ToolId,
    options?: PreviewToolOptions,
  ): Promise<ToolPreview> {
    const tool = await this.load(scope, internalId, options?.version);
    const graph = this.resolveDataSources === undefined ? tool.graph : await this.resolveDataSources.execute(scope, tool.graph);
    const result =
      options?.rowLimit !== undefined
        ? this.engine.preview(graph, { rowLimit: options.rowLimit })
        : this.engine.preview(graph);
    return { tool, result };
  }

  /** version 指定時 findVersion、無指定時 findLatest。null → ToolNotFoundError。 */
  private async load(scope: TenantScope, internalId: ToolId, version?: SemVer): Promise<Tool> {
    const tool =
      version !== undefined
        ? await this.repo.findVersion(scope, internalId, version)
        : await this.repo.findLatest(scope, internalId);
    if (tool === null) {
      const at = version !== undefined ? `@${version.toString()}` : '';
      throw new ToolNotFoundError(
        `PreviewTool: tool not found: ${internalId}${at} (tenant ${scope.tenantId}/${scope.workspaceId})`,
      );
    }
    return tool;
  }
}

/**
 * 未保存の ToolGraph を検査・プレビューする非永続ユースケース。
 * repository や Tool version には触れず、Tool Builder の編集ループ専用とする。
 */
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';

export interface DraftPreviewOptions {
  readonly rowLimit?: number;
}

export class DraftToolUseCase {
  constructor(private readonly engine: EtlEngine, private readonly resolveDataSources?: ResolveDataSourceGraphUseCase) {}

  async inspect(graph: ToolGraph, scope?: TenantScope): Promise<PropagationResult> {
    const executableGraph = this.resolveDataSources === undefined || scope === undefined ? graph : await this.resolveDataSources.execute(scope, graph);
    return this.engine.propagateSchemas(executableGraph);
  }

  async preview(graph: ToolGraph, options?: DraftPreviewOptions, scope?: TenantScope): Promise<PreviewResult> {
    const executableGraph = this.resolveDataSources === undefined || scope === undefined ? graph : await this.resolveDataSources.execute(scope, graph);
    return options?.rowLimit === undefined
      ? this.engine.preview(executableGraph)
      : this.engine.preview(executableGraph, { rowLimit: options.rowLimit });
  }
}

/**
 * 未保存の ToolGraph を検査・プレビューする非永続ユースケース。
 * repository や Tool version には触れず、Tool Builder の編集ループ専用とする。
 */
import type { ToolGraph } from '../../domain/etl/graph';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';

export interface DraftPreviewOptions {
  readonly rowLimit?: number;
}

export class DraftToolUseCase {
  constructor(private readonly engine: EtlEngine) {}

  inspect(graph: ToolGraph): PropagationResult {
    return this.engine.propagateSchemas(graph);
  }

  preview(graph: ToolGraph, options?: DraftPreviewOptions): PreviewResult {
    return options?.rowLimit === undefined
      ? this.engine.preview(graph)
      : this.engine.preview(graph, { rowLimit: options.rowLimit });
  }
}

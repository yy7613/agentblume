/**
 * 未保存の ToolGraph を検査・プレビューする非永続ユースケース。
 * repository や Tool version には触れず、Tool Builder の編集ループ専用とする。
 */
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { ResolveAiJudgmentsUseCase } from './resolve-ai-judgments';

export interface DraftPreviewOptions {
  /** 表示用スナップショットの行数（engine.preview の rowLimit）。計算は常に全行で行われる。 */
  readonly rowLimit?: number;
}

export class DraftToolUseCase {
  /**
   * `resolveAiJudgments` は `preview` だけが使う。`inspect` はスキーマ点検で行を作らないので、
   * モデルを呼ぶ必要が無い（点検のたびに LLM が走るのは編集ループの邪魔になる）。
   */
  constructor(
    private readonly engine: EtlEngine,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
    private readonly resolveAiJudgments?: ResolveAiJudgmentsUseCase,
  ) {}

  async inspect(graph: ToolGraph, scope?: TenantScope): Promise<PropagationResult> {
    const executableGraph = this.resolveDataSources === undefined || scope === undefined ? graph : await this.resolveDataSources.execute(scope, graph);
    return this.engine.propagateSchemas(executableGraph);
  }

  async preview(graph: ToolGraph, options?: DraftPreviewOptions, scope?: TenantScope): Promise<PreviewResult> {
    const withSources = this.resolveDataSources === undefined || scope === undefined ? graph : await this.resolveDataSources.execute(scope, graph);
    // データソース解決の**後**に AI 判定を解く（判定は上流の行を実際に計算してから問う）。
    const executableGraph = this.resolveAiJudgments === undefined ? withSources : await this.resolveAiJudgments.execute(withSources);
    return options?.rowLimit === undefined
      ? this.engine.preview(executableGraph)
      : this.engine.preview(executableGraph, { rowLimit: options.rowLimit });
  }
}

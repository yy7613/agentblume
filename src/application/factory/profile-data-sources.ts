/**
 * application層: Agent Factory Stage 0 データプロファイル（v33 実装契約 §3 / docs/16-agent-factory.md §4 Stage 0）。
 *
 * 決定的・LLM不使用。`dataSourceId` を1ノードグラフ（`csv-source` / `json-source`）へ包み、既存の
 * `ResolveDataSourceGraphUseCase`（opaque dataSourceIdの展開）と `EtlEngine`（スキーマ推論 + プレビュー）
 * を再利用して `DataProfile` を作る。データベースdata sourceのプロファイルはM1の対象外（後続スライス）。
 */
import type { EtlEngine } from '../etl/engine';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/tool/ids';
import type { DataSourceId } from '../../domain/data-source/ids';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';

export interface ColumnProfile {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface DataProfile {
  readonly dataSourceId: DataSourceId;
  readonly name: string;
  readonly kind: 'file' | 'database';
  /** file dataSourceのファイル形式（M2 ToolSmithがsourceノード種別を選ぶために使う）。database未対応のため常に'file'時のみ設定。 */
  readonly format?: 'csv' | 'json';
  readonly columns: readonly ColumnProfile[];
  readonly sampleRowCount: number;
  readonly sampleRows: readonly Record<string, unknown>[];
}

/** Stage 0 が疑似ユーザー/Plannerへ提示するサンプル行の上限（docs/16 §4 Stage 0）。 */
const SAMPLE_ROW_LIMIT = 20;
const SOURCE_NODE_ID = 'src';

export class ProfileDataSourcesUseCase {
  constructor(
    private readonly dataSources: DataSourceRepository,
    private readonly resolveGraph: ResolveDataSourceGraphUseCase,
    private readonly engine: EtlEngine,
  ) {}

  async execute(scope: TenantScope, dataSourceId: DataSourceId): Promise<DataProfile> {
    const source = await this.dataSources.find(scope, dataSourceId);
    if (source === null) throw new FactoryValidationError(`ProfileDataSources: data source not found: ${dataSourceId}`);
    if (source.kind === 'database') throw new FactoryValidationError('ProfileDataSources: database data source profiling is not supported yet');

    const graph: ToolGraph = {
      nodes: [{ id: SOURCE_NODE_ID, type: source.format === 'csv' ? 'csv-source' : 'json-source', config: { dataSourceId } }],
      edges: [],
    };
    const resolved = await this.resolveGraph.execute(scope, graph);
    const propagation = this.engine.propagateSchemas(resolved);
    const inference = propagation.nodes[SOURCE_NODE_ID];
    if (inference === undefined) throw new FactoryValidationError(`ProfileDataSources: failed to infer schema for data source: ${dataSourceId}`);

    const preview = this.engine.preview(resolved, { rowLimit: SAMPLE_ROW_LIMIT });
    const sampleRows = (preview.nodes[SOURCE_NODE_ID]?.table.rows ?? []).map((row) => ({ ...row }) as Record<string, unknown>);

    return {
      dataSourceId,
      name: source.name,
      kind: source.kind,
      format: source.format,
      columns: inference.schema.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })),
      sampleRowCount: sampleRows.length,
      sampleRows,
    };
  }

  async executeAll(scope: TenantScope, dataSourceIds: readonly DataSourceId[]): Promise<DataProfile[]> {
    const profiles: DataProfile[] = [];
    for (const dataSourceId of dataSourceIds) profiles.push(await this.execute(scope, dataSourceId));
    return profiles;
  }
}

/**
 * application層: Agent Factory Stage 0 データプロファイル（v33 実装契約 §3 / docs/16-agent-factory.md §4 Stage 0）。
 *
 * 決定的・LLM不使用。`dataSourceId` を1ノードグラフ（`csv-source` / `json-source`）へ包み、既存の
 * `ResolveDataSourceGraphUseCase`（opaque dataSourceIdの展開）と `EtlEngine`（スキーマ推論 + プレビュー）
 * を再利用して `DataProfile` を作る。データベースdata sourceのプロファイルはM1の対象外（後続スライス）。
 */
import type { EtlEngine } from '../etl/engine';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { DataSourceId } from '../../domain/data-source/ids';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';
import { FactoryValidationError } from '../../domain/factory/errors';
import { parsePeriodLabel, type PeriodGranularity } from '../../domain/etl/nodes/parse-period';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { throwIfAborted } from './abort';

export interface ColumnProfile {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

/**
 * 期間ラベルが入っている文字列列の要約（e-Stat の `時点` のような列）。
 *
 * 1 つの列に「1975年10月」（月）・「2024年1-3月期」（四半期）・「2024年」（暦年）・「2024年度」（年度）が
 * 混ざっていることが実データでは普通にある。文字列のままでは完全一致しか引けず、粒度の違う行を混ぜて
 * 集計してしまうため、Planner/ToolSmith には「この列は期間で、粒度が混在している」ことを明示して
 * `parse-period` → 粒度で絞る → 開始日で範囲指定、という定石へ誘導する。
 */
export interface PeriodColumnProfile {
  readonly column: string;
  /** 粒度ごとの出現行数（0 件の粒度はキーごと出さない）。 */
  readonly granularities: Readonly<Partial<Record<PeriodGranularity, number>>>;
  /** 解釈できた開始日の最小 / 最大（ISO 日付。1 件も解釈できなければ未設定）。 */
  readonly minStart?: string;
  readonly maxStart?: string;
  /** 粒度が 2 種類以上混ざっているか（true なら粒度フィルタ無しの集計は誤る）。 */
  readonly mixed: boolean;
}

/**
 * 値の種類が少ない文字列列の要約（47 都道府県 + 全国 のような列）。
 *
 * 「どんな値を渡せばよいか」をモデルが知らないと、`2015年12月31日` のような存在しない値で
 * 0 行を引いて、そのまま記憶から数字を答えてしまう。列挙できる列は全値を見せる。
 */
export interface CategoricalColumnProfile {
  readonly column: string;
  readonly distinctCount: number;
  /** 実際の値（最大 `MAX_CATEGORICAL_VALUES` 件。決定的な出現順）。 */
  readonly values: readonly string[];
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
  /** データソース全体の行数（サンプル件数ではない）。Tool が既定呼び出しで何行返しうるかの判断材料。 */
  readonly rowCount: number;
  /** 期間ラベル列（`parsePeriodLabel` が全行の ≥90% を解釈できた文字列列）。 */
  readonly periodColumns: readonly PeriodColumnProfile[];
  /** 低カーディナリティ文字列列（distinct が `MAX_CATEGORICAL_VALUES` 以下）。 */
  readonly categoricalColumns: readonly CategoricalColumnProfile[];
}

/** Stage 0 が疑似ユーザー/Plannerへ提示するサンプル行の上限（docs/16 §4 Stage 0）。 */
const SAMPLE_ROW_LIMIT = 20;
const SOURCE_NODE_ID = 'src';

/** 期間ラベル列と判定する、非nullの値のうち解釈できた割合の下限。 */
export const PERIOD_COLUMN_PARSE_RATIO = 0.9;

/** 値を列挙する低カーディナリティ列の distinct 上限（これを超えたら列挙しない）。 */
export const MAX_CATEGORICAL_VALUES = 60;

/** 空セル（null / undefined / 空文字）は「値なし」として分母から外す。 */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * 1 列が期間ラベル列かを決定的に判定する（`parse-period` ノードと同じ `parsePeriodLabel` を使う）。
 * 解釈できた割合が `PERIOD_COLUMN_PARSE_RATIO` 未満、または値が 1 つも無い列は期間列とみなさない。
 */
export function detectPeriodColumn(column: string, rows: readonly Record<string, unknown>[]): PeriodColumnProfile | undefined {
  let present = 0;
  let parsed = 0;
  const granularities: Partial<Record<PeriodGranularity, number>> = {};
  let min: Date | undefined;
  let max: Date | undefined;
  for (const row of rows) {
    const value = row[column];
    if (isBlank(value)) continue;
    present += 1;
    const period = parsePeriodLabel(value);
    if (period.start === null || period.granularity === 'unknown') continue;
    parsed += 1;
    granularities[period.granularity] = (granularities[period.granularity] ?? 0) + 1;
    if (min === undefined || period.start < min) min = period.start;
    if (max === undefined || period.start > max) max = period.start;
  }
  if (present === 0 || parsed / present < PERIOD_COLUMN_PARSE_RATIO) return undefined;
  return {
    column,
    granularities,
    ...(min === undefined ? {} : { minStart: min.toISOString().slice(0, 10) }),
    ...(max === undefined ? {} : { maxStart: max.toISOString().slice(0, 10) }),
    mixed: Object.keys(granularities).length > 1,
  };
}

/** 1 列の distinct 値を数え、`MAX_CATEGORICAL_VALUES` 以下なら値ごと返す（超過したら undefined）。 */
export function detectCategoricalColumn(column: string, rows: readonly Record<string, unknown>[]): CategoricalColumnProfile | undefined {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (isBlank(value)) continue;
    values.add(String(value));
    if (values.size > MAX_CATEGORICAL_VALUES) return undefined;
  }
  if (values.size === 0) return undefined;
  return { column, distinctCount: values.size, values: [...values] };
}

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
    // 期間列・低カーディナリティ列の判定はサンプル20行では足りない（年次と月次の混在は末尾に出る）ので、
    // プレビューが既に計算済みの全行（`fullOutput`）を走査する。追加の実行コストは掛からない。
    const allRows = preview.fullOutput.rows as readonly Record<string, unknown>[];
    const columns = inference.schema.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable }));
    const stringColumns = columns.filter((column) => column.type === 'string' || column.type === 'unknown');

    const periodColumns = stringColumns
      .map((column) => detectPeriodColumn(column.name, allRows))
      .filter((profile): profile is PeriodColumnProfile => profile !== undefined);
    const categoricalColumns = stringColumns
      .map((column) => detectCategoricalColumn(column.name, allRows))
      .filter((profile): profile is CategoricalColumnProfile => profile !== undefined);

    return {
      dataSourceId,
      name: source.name,
      kind: source.kind,
      format: source.format,
      columns,
      sampleRowCount: sampleRows.length,
      sampleRows,
      rowCount: preview.nodes[SOURCE_NODE_ID]?.rowCount ?? allRows.length,
      periodColumns,
      categoricalColumns,
    };
  }

  /** 複数 data source を順にプロファイルする。`signal` は data source の合間で確認する（1件のプロファイルは中断できない同期処理）。 */
  async executeAll(scope: TenantScope, dataSourceIds: readonly DataSourceId[], signal?: AbortSignal): Promise<DataProfile[]> {
    const profiles: DataProfile[] = [];
    for (const dataSourceId of dataSourceIds) {
      throwIfAborted(signal);
      profiles.push(await this.execute(scope, dataSourceId));
    }
    return profiles;
  }
}

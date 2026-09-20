import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import { validateToolSpec, type ToolSpec } from '../../domain/factory/tool-spec';
import type { Tool } from '../../domain/tool/tool';
import { validateToolArguments } from '../agent/tool-schema';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { graphWithArguments } from '../tool/tool-execution';
import {
  COMPILED_EXTRA_TRANSFORM_TYPES,
  RETURNED_COLUMNS_PREFIX_EN,
  RETURNED_COLUMNS_PREFIX_JA,
  columnsAfterJoinAndCompute,
  compileToolSpec,
  toolSpecContextOf,
  withExpression,
  withoutComputation,
  type CompiledTool,
} from './compile-tool-spec';
import {
  agentToolArgumentsOf,
  describeGraphShapeViolations,
  describeJoinDesignViolations,
  describeToolSemanticViolations,
} from './generate-agent-assets';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';

const scope = { tenantId: 't', workspaceId: 'w' };

/** e-Stat 風の全国系列（1 つの時点列に月・四半期・暦年・年度が混ざる）。 */
const NATIONAL_CSV = [
  '時点,地域,人口,注記',
  '2023年1月,全国,12450,',
  '2023年2月,全国,12440,',
  '2023年1-3月期,全国,12445,',
  '2023年,全国,12430,',
  '2023年度,全国,12420,概数',
  '2022年,全国,12520,',
  '2022年1月,全国,12530,',
].join('\n');

/** 地域別の表（4 地域 × 月次/年次）。 */
const REGION_CSV = [
  '時点,地域コード,地域,就業者数,注記',
  '2023年,01000,北海道,2500,',
  '2023年,13000,東京都,7000,',
  '2023年,27000,大阪府,4300,',
  '2023年,40000,福岡県,2600,',
  '2023年5月,01000,北海道,2450,暫定値',
  '2023年5月,13000,東京都,6900,暫定値',
  '2023年5月,27000,大阪府,4250,暫定値',
  '2023年5月,40000,福岡県,2550,暫定値',
  '2022年,01000,北海道,2480,',
  '2022年,13000,東京都,6950,',
  '2022年,27000,大阪府,4280,',
  '2022年,40000,福岡県,2580,',
].join('\n');

/** 結合できる 3 ソース（どれも `時点, 地域コード, 地域, 値, 注記` の同じ形）。 */
function joinableCsv(values: readonly number[]): string {
  return [
    '時点,地域コード,地域,値,注記',
    `2023年,01000,北海道,${values[0]},`,
    `2023年,13000,東京都,${values[1]},`,
    `2022年,01000,北海道,${values[2]},`,
    `2022年,13000,東京都,${values[3]},`,
  ].join('\n');
}

const WAGE_CSV = joinableCsv([280, 380, 275, 372]);
const HOURS_CSV = joinableCsv([150, 158, 151, 159]);
const PRICE_CSV = joinableCsv([98, 103, 97, 101]);

interface Harness {
  readonly engine: EtlEngine;
  readonly resolver: ResolveDataSourceGraphUseCase;
  readonly profiles: DataProfile[];
}

async function setup(sources: readonly { readonly id: string; readonly name: string; readonly csv: string }[]): Promise<Harness> {
  const dataSources = new InMemoryDataSourceRepository();
  for (const source of sources) {
    await dataSources.save(
      { id: source.id, tenant: scope, name: source.name, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: source.csv.length, createdAt: '', updatedAt: '' },
      source.csv,
    );
  }
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  const profiles = await profiler.executeAll(scope, sources.map((source) => source.id));
  return { engine, resolver, profiles };
}

const nationalPlan: FactoryToolPlan = {
  key: 'population_trend',
  displayName: '人口の推移',
  purpose: '全国の人口を、指定した粒度と期間で新しい順に返す。',
  dataSourceId: 'ds-national',
  sideEffect: 'read-only',
};

const regionPlan: FactoryToolPlan = {
  key: 'employment_by_region',
  displayName: '地域別の就業者数',
  purpose: '地域別の就業者数を、指定した粒度・地域・期間で返す。',
  dataSourceId: 'ds-region',
  sideEffect: 'read-only',
};

const joinPlan: FactoryToolPlan = {
  key: 'wage_hours_price',
  displayName: '賃金・労働時間・物価',
  purpose: '同じ時点・同じ地域の賃金と労働時間と物価を1つの表で返す。',
  dataSourceId: 'ds-wage',
  sideEffect: 'read-only',
  additionalDataSourceIds: ['ds-hours', 'ds-price'],
};

function baseSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    version: 1,
    categoryFilters: [],
    computations: [],
    output: { columns: [], sort: 'latest-first', limit: 20 },
    ...overrides,
  };
}

/** 引数を束縛して実エンジンで走らせ、終端 `agent-output` の行を返す。 */
async function runTool(harness: Harness, compiled: CompiledTool, args: Record<string, unknown> = {}): Promise<Row[]> {
  const row = compiled.inputSchema === undefined ? undefined : validateToolArguments(compiled.inputSchema, args as never);
  const graph: ToolGraph = row === undefined
    ? compiled.graph
    : graphWithArguments({ graph: compiled.graph, inputSchema: compiled.inputSchema } as unknown as Tool, row);
  const preview = harness.engine.preview(await harness.resolver.execute(scope, graph));
  return [...(preview.nodes['out']?.table.rows ?? [])] as Row[];
}

/** 構造検査・意味検査・引数なし（= 必須引数だけの）呼び出しの溢れガードをまとめて掛ける。 */
async function assertPassesExistingChecks(
  harness: Harness,
  compiled: CompiledTool,
  plan: FactoryToolPlan,
  defaultArgs: Record<string, unknown> = {},
): Promise<void> {
  const profile = harness.profiles.find((candidate) => candidate.dataSourceId === plan.dataSourceId)!;
  const additionalProfiles = (plan.additionalDataSourceIds ?? []).map((id) => harness.profiles.find((candidate) => candidate.dataSourceId === id)!);
  const sources = [profile, ...additionalProfiles].map((candidate) => ({
    dataSourceId: candidate.dataSourceId,
    sourceType: candidate.format === 'json' ? 'json-source' : 'csv-source',
  }));

  expect(describeGraphShapeViolations(compiled.graph, { sources, extraTransformTypes: COMPILED_EXTRA_TRANSFORM_TYPES })).toBeUndefined();
  expect(describeJoinDesignViolations(compiled.graph, profile, additionalProfiles)).toBeUndefined();

  const resolved = await harness.resolver.execute(scope, compiled.graph);
  const propagation = harness.engine.propagateSchemas(resolved);
  expect(propagation.hasErrors).toBe(false);
  const preview = harness.engine.preview(resolved);
  expect(describeToolSemanticViolations({
    graph: compiled.graph,
    profile,
    additionalProfiles,
    toolPlan: plan,
    inputSchema: compiled.inputSchema,
    propagation,
    preview,
  })).toBeUndefined();

  // 引数を省略した（必須引数だけの）呼び出しで終端が溢れないこと。溢れると1回目のツール呼び出しで必ず失敗する。
  const sink = compiled.graph.nodes.find((node) => node.type === 'agent-output')!;
  const maxRows = (sink.config as { maxRows: number }).maxRows;
  const rows = await runTool(harness, compiled, defaultArgs);
  expect(rows.length).toBeLessThanOrEqual(maxRows);

  // 宣言した引数はすべて filter から参照されていること（未使用引数は保存検証が拒否する）。
  expect(agentToolArgumentsOf(compiled.graph)).toEqual(compiled.inputSchema);
}

describe('toolSpecContextOf / columnsAfterJoinAndCompute', () => {
  it('正常: プロファイルから列・期間・カテゴリ・結合キー候補を組み立てる', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const context = toolSpecContextOf(nationalPlan, harness.profiles);
    expect(context.hasAdditionalSources).toBe(false);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.columns.map((column) => column.name)).toEqual(['時点', '地域', '人口', '注記']);
    expect(context.sources[0]?.periodColumns).toEqual([{ column: '時点', granularities: ['month', 'quarter', 'year', 'fiscal-year'] }]);
    expect(context.sources[0]?.categoricalColumns.map((column) => column.column)).toContain('地域');
    expect(context.joinKeyCandidates).toEqual([]);
  });

  it('正常: 結合するときは、このツールが読むソース同士の結合キー候補だけを渡す', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
      { id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV },
    ]);
    const context = toolSpecContextOf(joinPlan, harness.profiles);
    expect(context.sources.map((source) => source.dataSourceId)).toEqual(['ds-wage', 'ds-hours', 'ds-price']);
    expect(context.hasAdditionalSources).toBe(true);
    expect(context.joinKeyCandidates).toEqual(['時点', '地域コード', '地域']);
  });

  it('正常: 結合後・計算後の列一覧は右側の同名列へ _2 / _3 を付ける', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    const spec = baseSpec({
      join: { keys: ['時点', '地域コード'], mode: 'inner' },
      period: { column: '時点', granularity: 'year', range: false },
      computations: [{ outputColumn: '時給', intent: '賃金を労働時間で割る' }],
    });
    expect(columnsAfterJoinAndCompute(spec, joinPlan, harness.profiles))
      .toEqual(['時点', '地域コード', '地域', '値', '注記', '値_2', '値_3', 'periodStart', 'periodGranularity', '時給']);
  });

  it('例外: 計画のデータソースにプロファイルが無ければ FactoryValidationError', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    expect(() => compileToolSpec(baseSpec({ output: { columns: [], sort: 'none', limit: 5 } }), regionPlan, harness.profiles))
      .toThrow(FactoryValidationError);
  });
});

describe('compileToolSpec — 単一ソース（粒度の混在）', () => {
  const spec = baseSpec({
    period: { column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true },
    output: { columns: [], sort: 'latest-first', limit: 20 },
  });

  it('正常: spec が検証を通り、コンパイル結果が既存の構造検査・意味検査・溢れガードを通る', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    expect(validateToolSpec(spec, toolSpecContextOf(nationalPlan, harness.profiles))).toEqual([]);
    const compiled = compileToolSpec(spec, nationalPlan, harness.profiles);
    await assertPassesExistingChecks(harness, compiled, nationalPlan, { granularity: 'month' });
  });

  it('正常: ノード id とつながりが契約どおり（src → period → 粒度 → 範囲 → sort → limit → select → out、args は未接続）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(spec, nationalPlan, harness.profiles);
    expect(compiled.graph.nodes.map((node) => node.id))
      .toEqual(['src_1', 'period', 'f_granularity', 'f_range', 'sort', 'limit', 'select', 'out', 'args']);
    expect(compiled.graph.edges).toEqual([
      { from: 'src_1', to: 'period' },
      { from: 'period', to: 'f_granularity' },
      { from: 'f_granularity', to: 'f_range' },
      { from: 'f_range', to: 'sort' },
      { from: 'sort', to: 'limit' },
      { from: 'limit', to: 'select' },
      { from: 'select', to: 'out' },
    ]);
    expect(compiled.agentTool.name).toBe('population_trend');
  });

  it('正常: granularity は必須引数で、月次と年次を同じツールで引き分けられる', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(spec, nationalPlan, harness.profiles);
    expect(compiled.inputSchema?.columns).toEqual([
      { name: 'granularity', type: 'string', nullable: false },
      { name: 'period_from', type: 'date', nullable: true },
      { name: 'period_to', type: 'date', nullable: true },
    ]);

    const monthly = await runTool(harness, compiled, { granularity: 'month' });
    expect(monthly.map((row) => row['時点'])).toEqual(['2023年2月', '2023年1月', '2022年1月']);
    const yearly = await runTool(harness, compiled, { granularity: 'year' });
    expect(yearly.map((row) => row['時点'])).toEqual(['2023年', '2022年']);
    const fiscal = await runTool(harness, compiled, { granularity: 'fiscal-year' });
    expect(fiscal.map((row) => row['時点'])).toEqual(['2023年度']);
  });

  it('異常: 必須の granularity を省いた呼び出しは実行前に弾かれる（月次と年次が混ざらない）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(spec, nationalPlan, harness.profiles);
    expect(() => validateToolArguments(compiled.inputSchema, {})).toThrow(/required argument missing: granularity/);
  });

  it('正常: 期間の範囲引数は ISO 日付で絞る（片側だけ・両方省略も効く）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(spec, nationalPlan, harness.profiles);
    expect(await runTool(harness, compiled, { granularity: 'month', period_from: '2023-01-01' }))
      .toEqual([expect.objectContaining({ 時点: '2023年2月' }), expect.objectContaining({ 時点: '2023年1月' })]);
    expect((await runTool(harness, compiled, { granularity: 'month', period_to: '2022-12-31' })).map((row) => row['時点'])).toEqual(['2022年1月']);
    expect((await runTool(harness, compiled, { granularity: 'month' })).map((row) => row['時点'])).toHaveLength(3);
  });

  it('境界: oldest-first を選ぶと開始日の昇順になる（従来どおり limit は先頭から残す）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const oldest = compileToolSpec(baseSpec({
      period: { column: '時点', granularity: 'month', range: false },
      output: { columns: [], sort: 'oldest-first', limit: 20 },
    }), nationalPlan, harness.profiles);
    expect((await runTool(harness, oldest)).map((row) => row['時点'])).toEqual(['2022年1月', '2023年1月', '2023年2月']);
  });

  it('境界: 引数が1つも無い spec では agent-input を置かず inputSchema も付けない', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(baseSpec({
      period: { column: '時点', granularity: 'year', range: false },
      output: { columns: [], sort: 'latest-first', limit: 5 },
    }), nationalPlan, harness.profiles);
    expect(compiled.inputSchema).toBeUndefined();
    expect(compiled.graph.nodes.some((node) => node.type === 'agent-input')).toBe(false);
    await assertPassesExistingChecks(harness, compiled, nationalPlan);
  });

  it('境界: select は注記列と期間ラベル列と値の列を、output.columns が挙げていなくても残す', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const compiled = compileToolSpec(baseSpec({
      period: { column: '時点', granularity: 'month', range: false },
      output: { columns: ['地域'], sort: 'latest-first', limit: 5 },
    }), nationalPlan, harness.profiles);
    const select = compiled.graph.nodes.find((node) => node.id === 'select');
    expect((select?.config as { columns: string[] }).columns).toEqual(['時点', '地域', '人口', '注記']);
  });

  it('境界: 同じ入力を2回コンパイルすると完全に同じ結果になる（決定的）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    expect(compileToolSpec(spec, nationalPlan, harness.profiles)).toEqual(compileToolSpec(spec, nationalPlan, harness.profiles));
  });
});

describe('compileToolSpec — 地域別の表（カテゴリ引数）', () => {
  const spec = baseSpec({
    period: { column: '時点', granularity: 'argument', defaultGranularity: 'year', range: true },
    categoryFilters: [{ column: '地域', argument: 'region', multi: true }],
    output: { columns: ['時点', '地域', '就業者数'], sort: 'latest-first', limit: 20 },
  });

  it('正常: spec が検証を通り、コンパイル結果が既存の検査をすべて通る', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    expect(validateToolSpec(spec, toolSpecContextOf(regionPlan, harness.profiles))).toEqual([]);
    const compiled = compileToolSpec(spec, regionPlan, harness.profiles);
    await assertPassesExistingChecks(harness, compiled, regionPlan, { granularity: 'year' });
  });

  it('正常: multi: true なら「東京都,大阪府」で複数の地域を1回の呼び出しで返す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const compiled = compileToolSpec(spec, regionPlan, harness.profiles);
    const rows = await runTool(harness, compiled, { granularity: 'year', region: '東京都,大阪府' });
    expect(rows).toHaveLength(4);
    expect([...new Set(rows.map((row) => row['地域']))].sort()).toEqual(['大阪府', '東京都']);
    expect(rows.map((row) => row['時点'])).toEqual(['2023年', '2023年', '2022年', '2022年']);
  });

  it('境界: カテゴリ引数を省略すると全地域が返る（対象ごとに呼び分けなくてよい）', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const compiled = compileToolSpec(spec, regionPlan, harness.profiles);
    const rows = await runTool(harness, compiled, { granularity: 'year' });
    expect([...new Set(rows.map((row) => row['地域']))]).toHaveLength(4);
  });

  it('正常: カテゴリ条件は in・caseInsensitive で、設計時サンプルはプロファイルの実在値', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const compiled = compileToolSpec(spec, regionPlan, harness.profiles);
    const filter = compiled.graph.nodes.find((node) => node.id === 'f_category');
    expect(filter?.config).toEqual({
      conditions: [{
        column: '地域',
        op: 'in',
        values: ['北海道', '東京都'],
        valueBinding: { source: 'agent-input', field: 'region' },
        caseInsensitive: true,
      }],
      combine: 'and',
    });
  });

  it('境界: 範囲引数と粒度とカテゴリを同時に渡しても絞り込みが積み上がる', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const compiled = compileToolSpec(spec, regionPlan, harness.profiles);
    const rows = await runTool(harness, compiled, { granularity: 'year', region: '東京都', period_from: '2023-01-01' });
    expect(rows).toEqual([expect.objectContaining({ 時点: '2023年', 地域: '東京都', 就業者数: 7000 })]);
  });
});

describe('compileToolSpec — 3 ソースの結合', () => {
  const spec = baseSpec({
    join: { keys: ['時点', '地域コード'], mode: 'inner' },
    period: { column: '時点', granularity: 'year', range: false },
    categoryFilters: [{ column: '地域', argument: 'region', multi: true }],
    output: { columns: ['時点', '地域', '値', '値_2', '値_3'], sort: 'latest-first', limit: 20 },
  });

  async function joined(): Promise<Harness> {
    return setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
  }

  it('正常: 枝ごとに select してから join を左から連ね、parse-period は最後の join の後に1回だけ置く', async () => {
    const harness = await joined();
    expect(validateToolSpec(spec, toolSpecContextOf(joinPlan, harness.profiles))).toEqual([]);
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    expect(compiled.graph.nodes.map((node) => node.id)).toEqual([
      'src_1', 'src_2', 'src_3', 'sel_1', 'sel_2', 'sel_3', 'join_1', 'join_2',
      'period', 'f_granularity', 'f_category', 'sort', 'limit', 'select', 'out', 'args',
    ]);
    expect(compiled.graph.edges.filter((edge) => edge.to.startsWith('join_'))).toEqual([
      { from: 'sel_1', to: 'join_1', toInput: 0 },
      { from: 'sel_2', to: 'join_1', toInput: 1 },
      { from: 'join_1', to: 'join_2', toInput: 0 },
      { from: 'sel_3', to: 'join_2', toInput: 1 },
    ]);
    expect(compiled.graph.nodes.find((node) => node.id === 'join_1')?.config).toEqual({
      mode: 'inner',
      keys: [{ left: '時点', right: '時点' }, { left: '地域コード', right: '地域コード' }],
      rightSuffix: '_2',
    });
    expect(compiled.graph.nodes.find((node) => node.id === 'join_2')?.config).toMatchObject({ rightSuffix: '_3' });
    expect((compiled.graph.nodes.find((node) => node.id === 'sel_2')?.config as { columns: string[] }).columns)
      .toEqual(['時点', '地域コード', '値']);
  });

  it('正常: 結合したツールが既存の検査をすべて通り、3 ソースの値が1行に並ぶ', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    await assertPassesExistingChecks(harness, compiled, joinPlan);
    const rows = await runTool(harness, compiled, { region: '東京都' });
    expect(rows).toEqual([
      { 時点: '2023年', 地域: '東京都', 値: 380, 注記: null, 値_2: 158, 値_3: 103 },
      { 時点: '2022年', 地域: '東京都', 値: 372, 注記: null, 値_2: 159, 値_3: 101 },
    ]);
  });

  it('境界: 結合しても行は増えない（キーが左右で1行を決める）', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    const preview = harness.engine.preview(await harness.resolver.execute(scope, compiled.graph));
    expect(preview.nodes['join_1']?.rowCount).toBe(4);
    expect(preview.nodes['join_2']?.rowCount).toBe(4);
  });
});

describe('compileToolSpec — 計算列', () => {
  const spec = baseSpec({
    join: { keys: ['時点', '地域コード'], mode: 'inner' },
    period: { column: '時点', granularity: 'year', range: false },
    computations: [{ outputColumn: '時給', intent: '賃金を労働時間で割る' }],
    output: { columns: ['時点', '地域', '値', '値_2', '時給'], sort: 'latest-first', limit: 20 },
  });

  async function joined(): Promise<Harness> {
    return setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
  }

  it('正常: 計算列ごとに calculate ノードを置き、その id を calculateNodeIds で返す', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    expect(compiled.calculateNodeIds).toEqual(['calc_1']);
    expect(compiled.graph.nodes.find((node) => node.id === 'calc_1')?.config)
      .toEqual({ outputColumn: '時給', expression: '', onError: 'null' });
  });

  it('例外: 式が空のままのグラフは中間生成物で、スキーマ伝播が error を出す', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    const propagation = harness.engine.propagateSchemas(await harness.resolver.execute(scope, compiled.graph));
    expect(propagation.hasErrors).toBe(true);
    expect(propagation.nodes['calc_1']?.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('正常: withExpression で式を入れると実エンジンで走り、既存の検査も通る', async () => {
    const harness = await joined();
    const filled = withExpression(compileToolSpec(spec, joinPlan, harness.profiles), 0, '[値] / [値_2]');
    await assertPassesExistingChecks(harness, filled, joinPlan);
    const rows = await runTool(harness, filled);
    expect(rows[0]).toMatchObject({ 時点: '2023年', 地域: '北海道' });
    expect(rows[0]?.['時給']).toBeCloseTo(280 / 150, 6);
    expect(rows).toHaveLength(4);
  });

  it('正常: withoutComputation で計算列を落とすと、そのままでも走るグラフになる', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    const dropped = withoutComputation(compiled, 0);
    expect(dropped.calculateNodeIds).toEqual([]);
    expect(dropped.graph.nodes.some((node) => node.id === 'calc_1')).toBe(false);
    expect(dropped.graph.edges).toContainEqual({ from: 'f_granularity', to: 'sort' });
    expect((dropped.graph.nodes.find((node) => node.id === 'select')?.config as { columns: string[] }).columns).not.toContain('時給');
    expect(dropped.agentTool.description).not.toContain('時給');
    await assertPassesExistingChecks(harness, dropped, joinPlan);
    expect((await runTool(harness, dropped))[0]).not.toHaveProperty('時給');
  });

  it('境界: 範囲外の index では withExpression / withoutComputation は何も変えない', async () => {
    const harness = await joined();
    const compiled = compileToolSpec(spec, joinPlan, harness.profiles);
    expect(withExpression(compiled, 5, 'x')).toBe(compiled);
    expect(withoutComputation(compiled, 5)).toBe(compiled);
  });

  it('境界: 計算列が2本あるとき、真ん中を落としても残りの式はそのまま動く', async () => {
    const harness = await joined();
    const two = compileToolSpec(baseSpec({
      join: { keys: ['時点', '地域コード'], mode: 'inner' },
      period: { column: '時点', granularity: 'year', range: false },
      computations: [
        { outputColumn: '時給', intent: '賃金を労働時間で割る' },
        { outputColumn: '実質賃金', intent: '賃金を物価指数で割る' },
      ],
      output: { columns: [], sort: 'latest-first', limit: 20 },
    }), joinPlan, harness.profiles);
    const filled = withExpression(withExpression(two, 0, '[値] / [値_2]'), 1, '[値] / [値_3]');
    const dropped = withoutComputation(filled, 0);
    expect(dropped.calculateNodeIds).toEqual(['calc_2']);
    expect(dropped.graph.edges).toContainEqual({ from: 'f_granularity', to: 'calc_2' });
    const rows = await runTool(harness, dropped);
    expect(rows[0]).not.toHaveProperty('時給');
    expect(rows[0]?.['実質賃金']).toBeCloseTo(280 / 98, 6);
  });
});

describe('compileToolSpec — 説明文', () => {
  const spec = baseSpec({
    period: { column: '時点', granularity: 'argument', defaultGranularity: 'year', range: true },
    categoryFilters: [{ column: '地域', argument: 'region', multi: true }],
    output: { columns: ['時点', '地域', '就業者数'], sort: 'latest-first', limit: 20 },
  });

  it('正常: 日本語では引数の形式・実在値の例・既定の粒度・データの範囲・返す列が入る', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const description = compileToolSpec(spec, regionPlan, harness.profiles, { language: 'ja' }).agentTool.description;
    expect(description).toContain(regionPlan.purpose);
    expect(description).toContain('対象データ: 地域別就業者数（期間 2022-01-01 〜 2023-05-01、粒度は year / month）');
    expect(description).toContain('granularity（必須・文字列）');
    expect(description).toContain('迷ったら year');
    expect(description).toContain('カンマ区切りで複数まとめて渡せる（例: 北海道,東京都）');
    expect(description).toContain('period_from（任意・日付）');
    expect(description).toContain('ISO 形式 YYYY-MM-DD（例: 2022-01-01）');
    expect(description).toContain(`${RETURNED_COLUMNS_PREFIX_JA}時点, 地域, 就業者数, 注記`);
    expect(description).toContain('並び: 期間の新しい順に最大 20 行。');
  });

  it('正常: 英語でも同じ材料（形式・例・既定・範囲）が入る', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const description = compileToolSpec(spec, regionPlan, harness.profiles, { language: 'en' }).agentTool.description;
    expect(description).toContain('Data: 地域別就業者数 (periods from 2022-01-01 to 2023-05-01; granularities: year, month)');
    expect(description).toContain('granularity (required, string)');
    expect(description).toContain('When in doubt use year');
    expect(description).toContain('comma-separated list (for example 北海道,東京都)');
    expect(description).toContain('ISO format YYYY-MM-DD (for example 2022-01-01)');
    expect(description).toContain(`${RETURNED_COLUMNS_PREFIX_EN}時点, 地域, 就業者数, 注記`);
    expect(description).toContain('Order: most recent period first, at most 20 rows.');
  });

  it('境界: 引数が無いツールでは「引数なし」と書く', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const noArguments = baseSpec({ period: { column: '時点', granularity: 'year', range: false }, output: { columns: [], sort: 'latest-first', limit: 5 } });
    expect(compileToolSpec(noArguments, nationalPlan, harness.profiles, { language: 'ja' }).agentTool.description).toContain('引数: なし');
    expect(compileToolSpec(noArguments, nationalPlan, harness.profiles, { language: 'en' }).agentTool.description).toContain('Arguments: none');
  });
});

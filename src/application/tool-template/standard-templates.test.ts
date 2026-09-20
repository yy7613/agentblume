/**
 * 同梱の標準テンプレート（`templates/tools/*.json`）を、e-Stat 風の固定データに対して
 * **実エンジンで実体化 → 検査 → 引数を束縛して実行**し、返る値まで確かめる。
 *
 * ノードの実際の config や出力列がテンプレートの想定と違えば、ここが落ちる（= テンプレート側を直す）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsToolTemplateCatalog } from '../../adapters/templates/fs-tool-template-catalog';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import {
  instantiateTemplate,
  validateSlotValues,
  withPendingExpression,
  type InstantiatedTemplate,
  type TemplateSlotValues,
} from '../../domain/tool-template/instantiate';
import {
  TOOL_TEMPLATE_DIRECTIVES,
  TOOL_TEMPLATE_SLOT_KINDS,
  type ToolTemplate,
} from '../../domain/tool-template/template';
import type { Tool } from '../../domain/tool/tool';
import { validateToolArguments } from '../agent/tool-schema';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { ProfileDataSourcesUseCase, type DataProfile } from '../factory/profile-data-sources';
import { graphWithArguments } from '../tool/tool-execution';
import { templateContextOf } from './template-context';
import { validateInstantiatedTemplate } from './validate-instantiated';

const scope = { tenantId: 't', workspaceId: 'w' };
const TEMPLATE_DIRECTORY = join(process.cwd(), 'templates', 'tools');

// ── e-Stat 風の固定データ ─────────────────────────────────────────────────────────

/** 1 つの時点列に月・四半期・暦年・年度が混ざり、地域コードつきの 4 地域を持つ表。 */
const REGION_CSV = [
  '時点,地域コード,地域,人口,注記',
  '2023年,01000,北海道,5200,',
  '2023年,13000,東京都,14000,',
  '2023年,27000,大阪府,8800,',
  '2023年,40000,福岡県,5100,',
  '2022年,01000,北海道,5250,',
  '2022年,13000,東京都,13900,',
  '2022年,27000,大阪府,8830,',
  '2022年,40000,福岡県,5110,',
  '2023年1月,01000,北海道,5210,速報',
  '2023年1-3月期,13000,東京都,13950,',
  '2023年度,13000,東京都,14010,',
].join('\n');

/** 欠けの無い月次（前年同月比を数えられるよう 14 か月 × 2 地域）。 */
const MONTHLY_CSV = [
  '時点,地域,売上',
  ...Array.from({ length: 14 }, (_unused, index) => {
    const year = index < 12 ? 2022 : 2023;
    const month = index < 12 ? index + 1 : index - 11;
    return [`${year}年${month}月,北海道,${100 + (10 * index)}`, `${year}年${month}月,東京都,${200 + (20 * index)}`];
  }).flat(),
].join('\n');

/** 同じ形（時点・地域コード・地域・値・注記）で結合できる 3 つの表。 */
function joinableCsv(values: readonly number[]): string {
  return [
    '時点,地域コード,地域,値,注記',
    `2023年,01000,北海道,${values[0]},`,
    `2023年,13000,東京都,${values[1]},`,
    `2022年,01000,北海道,${values[2]},`,
    `2022年,13000,東京都,${values[3]},`,
  ].join('\n');
}

const WAGE_CSV = joinableCsv([300, 400, 280, 390]);
const HOURS_CSV = joinableCsv([150, 160, 140, 156]);
const PRICE_CSV = joinableCsv([100, 105, 98, 102]);

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
  return { engine, resolver, profiles: await profiler.executeAll(scope, sources.map((source) => source.id)) };
}

let cachedTemplates: Promise<readonly ToolTemplate[]> | undefined;

async function shippedTemplates(): Promise<readonly ToolTemplate[]> {
  cachedTemplates ??= (async () => {
    const catalog = await new FsToolTemplateCatalog({ directories: [TEMPLATE_DIRECTORY], registry: createDefaultRegistry() }).list();
    expect(catalog.invalid).toEqual([]);
    return catalog.templates;
  })();
  return cachedTemplates;
}

async function templateById(id: string): Promise<ToolTemplate> {
  const template = (await shippedTemplates()).find((candidate) => candidate.id === id);
  if (template === undefined) throw new Error(`templates/tools does not ship a template with id '${id}'`);
  return template;
}

/** スロット値を検証してから実体化する（テンプレートが自分の検証を通ることも一緒に確かめる）。 */
function build(template: ToolTemplate, harness: Harness, dataSourceIds: readonly string[], values: TemplateSlotValues, toolName: string): InstantiatedTemplate {
  const context = templateContextOf({ dataSourceIds }, harness.profiles);
  expect(validateSlotValues(template, values, context)).toEqual([]);
  return instantiateTemplate(template, values, context, { toolName, language: 'ja' });
}

/** スキーマ伝播 + 設計時プレビュー（実データ）に掛ける。 */
async function assertPassesEngineValidation(harness: Harness, instantiated: InstantiatedTemplate): Promise<void> {
  expect(await validateInstantiatedTemplate(harness.engine, instantiated, (graph) => harness.resolver.execute(scope, graph))).toEqual([]);
}

/** 引数を束縛して実エンジンで走らせ、終端 `agent-output` の行を返す。 */
async function run(harness: Harness, instantiated: InstantiatedTemplate, args: Record<string, unknown> = {}): Promise<Row[]> {
  const row = instantiated.inputSchema === undefined ? undefined : validateToolArguments(instantiated.inputSchema, args as never);
  const graph: ToolGraph = row === undefined
    ? instantiated.graph
    : graphWithArguments({ graph: instantiated.graph, inputSchema: instantiated.inputSchema } as unknown as Tool, row);
  const preview = harness.engine.preview(await harness.resolver.execute(scope, graph));
  return [...(preview.nodes['out']?.table.rows ?? [])] as Row[];
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

// ── 同梱テンプレートの一覧 ────────────────────────────────────────────────────────

describe('同梱の標準テンプレート', () => {
  it('正常: 契約 §6 の全件が読み込め、id が重複しない', async () => {
    const ids = (await shippedTemplates()).map((template) => template.id).sort();
    expect(ids).toEqual([
      'category-ranking',
      'correlation-of-two-sources',
      'custom-computation',
      'join-side-by-side',
      'join-three-side-by-side',
      'latest-values',
      'period-change',
      'period-series',
      'period-statistics',
      'ratio-of-two-sources',
    ]);
  });

  it('正常: 実装の申し送り（implementationNotes）は残っていない', async () => {
    for (const template of await shippedTemplates()) {
      expect(template.implementationNotes, `${template.id} still carries implementationNotes`).toBeUndefined();
    }
  });

  it('正常: どのテンプレートも csv / json のどちらのデータソースでも使える形で source ノードを書いている', async () => {
    for (const template of await shippedTemplates()) {
      const sourceNodes = template.nodes.filter((node) => (node.config as { dataSourceId?: unknown } | null)?.dataSourceId !== undefined);
      expect(sourceNodes.length, template.id).toBeGreaterThan(0);
      for (const node of sourceNodes) {
        expect(node.type, `${template.id}/${node.id}`).toEqual({ $sourceType: expect.any(String) });
      }
    }
  });
});

// ── 1 ソースのテンプレート ────────────────────────────────────────────────────────

describe('period-series', () => {
  const values: TemplateSlotValues = {
    source: 'ds-region',
    periodColumn: '時点',
    valueColumns: ['人口'],
    categoryColumn: '地域',
    defaultGranularity: 'year',
    limit: 20,
  };

  it('正常: 粒度と地域と期間で絞り、新しい順に実データの値を返す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-series'), harness, ['ds-region'], values, 'population_series');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', categories: '東京都,北海道', period_from: null, period_to: null });
    expect(rows.map((row) => [row['時点'], row['地域'], row['人口']])).toEqual([
      ['2023年', '北海道', 5200],
      ['2023年', '東京都', 14000],
      ['2022年', '北海道', 5250],
      ['2022年', '東京都', 13900],
    ]);
  });

  it('境界: 期間の下限を渡すと、その日以降に始まる期間だけが残る', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-series'), harness, ['ds-region'], values, 'population_series');
    const rows = await run(harness, instantiated, { granularity: 'year', categories: null, period_from: '2023-01-01', period_to: null });
    expect(new Set(rows.map((row) => row['時点']))).toEqual(new Set(['2023年']));
    expect(rows).toHaveLength(4);
  });

  it('正常: 粒度を月次にすると月の行だけが返る（年次と混ざらない）', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-series'), harness, ['ds-region'], values, 'population_series');
    const rows = await run(harness, instantiated, { granularity: 'month', categories: null, period_from: null, period_to: null });
    expect(rows.map((row) => row['時点'])).toEqual(['2023年1月']);
  });

  it('正常: カテゴリ列を選ばなければ、その絞り込みノードも引数も無くなる', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-series'), harness, ['ds-region'], { ...values, categoryColumn: undefined }, 'population_series');
    expect(instantiated.graph.nodes.map((node) => node.id)).not.toContain('f_category');
    expect(instantiated.inputSchema?.columns.map((column) => column.name)).toEqual(['granularity', 'period_from', 'period_to']);
    await assertPassesEngineValidation(harness, instantiated);
    expect(await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null })).toHaveLength(8);
  });
});

describe('latest-values', () => {
  it('正常: 最新の期間から順に、指定した件数だけ返す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('latest-values'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域', defaultGranularity: 'year', limit: 4,
    }, 'latest_population');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', categories: null });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row['時点']))).toEqual(new Set(['2023年']));
    expect(instantiated.inputSchema?.columns.map((column) => column.name)).toEqual(['granularity', 'categories']);
  });
});

describe('category-ranking', () => {
  it('正常: 1 つの期間について、値の大きい順に地域が並ぶ', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('category-ranking'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', categoryColumn: '地域', valueColumn: '人口', defaultGranularity: 'year', direction: 'desc', limit: 3,
    }, 'population_ranking');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', period: '2023-01-01' });
    expect(rows.map((row) => row['地域'])).toEqual(['東京都', '大阪府', '北海道']);
    expect(rows[0]?.['人口']).toBe(14000);
  });

  it('正常: 小さい順を選ぶと逆の順位になる', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('category-ranking'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', categoryColumn: '地域', valueColumn: '人口', defaultGranularity: 'year', direction: 'asc', limit: 2,
    }, 'population_ranking');
    const rows = await run(harness, instantiated, { granularity: 'year', period: '2023-01-01' });
    expect(rows.map((row) => row['地域'])).toEqual(['福岡県', '北海道']);
  });
});

describe('period-statistics', () => {
  it('正常: 地域ごとの件数・平均・最小・中央値・最大・合計を実データから返す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-statistics'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域', defaultGranularity: 'year', limit: 60,
    }, 'population_statistics');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', categories: null, period_from: null, period_to: null });
    const hokkaido = rows.find((row) => row['地域'] === '北海道');
    expect(hokkaido?.['column']).toBe('人口');
    expect(hokkaido?.['valid-count']).toBe(2);
    expect(hokkaido?.['mean']).toBe(5225);
    expect(hokkaido?.['min']).toBe(5200);
    expect(hokkaido?.['max']).toBe(5250);
    expect(hokkaido?.['sum']).toBe(10450);
    expect(rows).toHaveLength(4);
  });

  it('正常: カテゴリ列を選ばなければ全体の 1 行だけになる', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('period-statistics'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', valueColumns: ['人口'], defaultGranularity: 'year', limit: 60,
    }, 'population_statistics');
    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['valid-count']).toBe(8);
  });
});

describe('period-change', () => {
  const values: TemplateSlotValues = {
    source: 'ds-monthly',
    periodColumn: '時点',
    valueColumns: ['売上'],
    categoryColumn: '地域',
    lag: '12',
    limit: 30,
  };

  it('正常: 前年同月比の増減と増減率を、実データの値どおりに返す', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    const instantiated = build(await templateById('period-change'), harness, ['ds-monthly'], values, 'sales_change');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { period_from: null, period_to: null, categories: null });
    const january = rows.find((row) => row['地域'] === '北海道' && isoOf(row['bucketStart']) === '2023-01-01');
    expect(january?.['series']).toBe('売上');
    expect(january?.['value']).toBe(220);
    expect(january?.['delta']).toBe(120);
    expect(january?.['percentChange']).toBeCloseTo(1.2, 10);
    // 最初の 12 か月は比べる相手が無いので null（0 にはしない）。
    const first = rows.find((row) => row['地域'] === '北海道' && isoOf(row['bucketStart']) === '2022-01-01');
    expect(first?.['delta']).toBeNull();
  });

  it('正常: 新しい月から順に並ぶ（bucketStart の降順）', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    const instantiated = build(await templateById('period-change'), harness, ['ds-monthly'], values, 'sales_change');
    const rows = await run(harness, instantiated, { period_from: null, period_to: null, categories: null });
    expect(isoOf(rows[0]?.['bucketStart'])).toBe('2023-02-01');
    expect(isoOf(rows[rows.length - 1]?.['bucketStart'])).toBe('2022-01-01');
  });

  it('境界: 期間の範囲を渡すと bucketStart で絞られる', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    const instantiated = build(await templateById('period-change'), harness, ['ds-monthly'], values, 'sales_change');
    const rows = await run(harness, instantiated, { period_from: '2023-01-01', period_to: null, categories: null });
    expect(new Set(rows.map((row) => isoOf(row['bucketStart'])))).toEqual(new Set(['2023-01-01', '2023-02-01']));
  });

  it('正常: 前月比（lag=1）を選ぶと 1 か月前との差になる', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    const instantiated = build(await templateById('period-change'), harness, ['ds-monthly'], { ...values, lag: '1' }, 'sales_change');
    const rows = await run(harness, instantiated, { period_from: null, period_to: null, categories: null });
    const february = rows.find((row) => row['地域'] === '東京都' && isoOf(row['bucketStart']) === '2023-02-01');
    expect(february?.['delta']).toBe(20);
  });
});

describe('custom-computation', () => {
  it('正常: 意図文を待つ calculate ノードが 1 つ残り、式を入れると実データで計算される', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    const instantiated = build(await templateById('custom-computation'), harness, ['ds-region'], {
      source: 'ds-region', periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域',
      outputColumn: '人口（万人）', computationIntent: '人口を 1000 で割って万人単位にする',
      defaultGranularity: 'year', limit: 10,
    }, 'population_custom');

    expect(instantiated.pendingExpressions).toEqual([{ nodeId: 'calc', intent: '人口を 1000 で割って万人単位にする' }]);
    // 式が空のままのグラフは中間生成物なので、検証はその旨を返す。
    const pendingProblems = await validateInstantiatedTemplate(harness.engine, instantiated, (graph) => harness.resolver.execute(scope, graph));
    expect(pendingProblems[0]?.message).toContain('still has an empty expression');

    const filled = withPendingExpression(instantiated, 'calc', '[人口] / 1000');
    await assertPassesEngineValidation(harness, filled);

    const rows = await run(harness, filled, { granularity: 'year', categories: '東京都', period_from: null, period_to: null });
    expect(rows[0]?.['人口（万人）']).toBe(14);
    expect(rows[0]?.['人口']).toBe(14000);
  });
});

// ── 複数ソースのテンプレート ──────────────────────────────────────────────────────

const JOIN_SOURCES = [
  { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
  { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
  { id: 'ds-price', name: '物価', csv: PRICE_CSV },
];

describe('join-side-by-side', () => {
  it('正常: 同じ時点・同じ地域の 2 つの値が 1 行に並び、同名の列には _2 が付く', async () => {
    const harness = await setup(JOIN_SOURCES.slice(0, 2));
    const instantiated = build(await templateById('join-side-by-side'), harness, ['ds-wage', 'ds-hours'], {
      primarySource: 'ds-wage', secondarySource: 'ds-hours', joinKeys: ['時点', '地域コード'],
      periodColumn: '時点', primaryValues: ['値'], secondaryValues: ['値'], defaultGranularity: 'year', limit: 10,
    }, 'wage_and_hours');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(4);
    const tokyo2023 = rows.find((row) => row['地域'] === '東京都' && row['時点'] === '2023年');
    expect(tokyo2023?.['値']).toBe(400);
    expect(tokyo2023?.['値_2']).toBe(160);
    expect(isoOf(rows[0]?.['periodStart'])).toBe('2023-01-01');
  });
});

describe('join-three-side-by-side', () => {
  it('正常: 3 つの値が 1 行に並び、同名の列に _2 / _3 が付く', async () => {
    const harness = await setup(JOIN_SOURCES);
    const instantiated = build(await templateById('join-three-side-by-side'), harness, ['ds-wage', 'ds-hours', 'ds-price'], {
      primarySource: 'ds-wage', secondSource: 'ds-hours', thirdSource: 'ds-price', joinKeys: ['時点', '地域コード'],
      periodColumn: '時点', primaryValues: ['値'], secondValues: ['値'], thirdValues: ['値'], defaultGranularity: 'year', limit: 10,
    }, 'wage_hours_price');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(4);
    const tokyo2023 = rows.find((row) => row['地域'] === '東京都' && row['時点'] === '2023年');
    expect([tokyo2023?.['値'], tokyo2023?.['値_2'], tokyo2023?.['値_3']]).toEqual([400, 160, 105]);
  });
});

describe('ratio-of-two-sources', () => {
  const values: TemplateSlotValues = {
    numeratorSource: 'ds-wage', denominatorSource: 'ds-hours', joinKeys: ['時点', '地域コード'],
    periodColumn: '時点', numerator: '値', denominator: '値', ratioColumn: '時間当たり賃金',
    scale: '1', defaultGranularity: 'year', limit: 10,
  };

  it('正常: 分子 ÷ 分母 を固定の式で計算し、両方の値と一緒に返す', async () => {
    const harness = await setup(JOIN_SOURCES.slice(0, 2));
    const instantiated = build(await templateById('ratio-of-two-sources'), harness, ['ds-wage', 'ds-hours'], values, 'wage_per_hour');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    const tokyo2023 = rows.find((row) => row['地域'] === '東京都' && row['時点'] === '2023年');
    expect(tokyo2023?.['時間当たり賃金']).toBe(2.5);
    const hokkaido2023 = rows.find((row) => row['地域'] === '北海道' && row['時点'] === '2023年');
    expect(hokkaido2023?.['時間当たり賃金']).toBe(2);
  });

  it('正常: 倍率 100 を選ぶと百分率になる（式は join 後の suffix 付き列を参照する）', async () => {
    const harness = await setup(JOIN_SOURCES.slice(0, 2));
    const instantiated = build(await templateById('ratio-of-two-sources'), harness, ['ds-wage', 'ds-hours'], { ...values, scale: '100' }, 'wage_per_hour');
    const expression = (instantiated.graph.nodes.find((node) => node.id === 'ratio')?.config as { expression?: unknown }).expression;
    expect(expression).toBe('[値] / [値_2] * 100');

    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows.find((row) => row['地域'] === '東京都' && row['時点'] === '2023年')?.['時間当たり賃金']).toBe(250);
  });

  it('異常: ほぼ空の「注記」は両方の表で値が一致していても結合キーに選べない（選ぶと空の行が黙って落ちる。e-Stat 実測）', async () => {
    // 1 行だけ「速報」が入った e-Stat の形。空でない値は完全に重なるので、空を見ない判定だとキー候補に挙がってしまう。
    const withNote = (csv: string): string => csv.replace(/(2023年,13000,東京都,\d+),/u, '$1,速報');
    const harness = await setup([{ id: 'ds-wage', name: '賃金', csv: withNote(WAGE_CSV) }, { id: 'ds-hours', name: '労働時間', csv: withNote(HOURS_CSV) }]);
    const context = templateContextOf({ dataSourceIds: ['ds-wage', 'ds-hours'] }, harness.profiles);
    const template = await templateById('ratio-of-two-sources');

    const problems = validateSlotValues(template, { ...values, joinKeys: ['時点', '注記'] }, context);
    expect(problems.map((problem) => problem.slot)).toEqual(['joinKeys']);
    expect(problems[0]?.message).toContain('choose from 時点, 地域コード, 地域');

    // 候補どおりに選べば全行が残る（注記が空の行も落ちない）。
    const rows = await run(harness, build(template, harness, ['ds-wage', 'ds-hours'], values, 'wage_per_hour'), { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(4);
  });
});

describe('correlation-of-two-sources', () => {
  it('正常: 結合して揃えた 2 つの値の相関係数を 1 行で返す', async () => {
    const harness = await setup(JOIN_SOURCES.slice(0, 2));
    const instantiated = build(await templateById('correlation-of-two-sources'), harness, ['ds-wage', 'ds-hours'], {
      sourceA: 'ds-wage', sourceB: 'ds-hours', joinKeys: ['時点', '地域コード'],
      periodColumn: '時点', valueA: '値', valueB: '値', defaultGranularity: 'year', method: 'pearson',
    }, 'wage_hours_correlation');
    await assertPassesEngineValidation(harness, instantiated);

    const rows = await run(harness, instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['columnX']).toBe('値');
    expect(rows[0]?.['columnY']).toBe('値_2');
    expect(rows[0]?.['pairCount']).toBe(4);
    expect(rows[0]?.['method']).toBe('pearson');
    expect(rows[0]?.['coefficient']).toBeGreaterThan(0.9);
  });

  it('境界: 組が minPairs に満たなければ係数は null になる（0 にはしない）', async () => {
    const harness = await setup(JOIN_SOURCES.slice(0, 2));
    const instantiated = build(await templateById('correlation-of-two-sources'), harness, ['ds-wage', 'ds-hours'], {
      sourceA: 'ds-wage', sourceB: 'ds-hours', joinKeys: ['時点', '地域コード'],
      periodColumn: '時点', valueA: '値', valueB: '値', defaultGranularity: 'year', method: 'pearson',
    }, 'wage_hours_correlation');
    const rows = await run(harness, instantiated, { granularity: 'year', period_from: '2023-01-01', period_to: '2023-01-01' });
    expect(rows[0]?.['pairCount']).toBe(2);
    expect(rows[0]?.['coefficient']).toBeNull();
  });
});

// ── JSON Schema（エディタ補完用の写し） ───────────────────────────────────────────

describe('templates/tools/tool-template.schema.json', () => {
  it('正常: 妥当な JSON で、draft-07 の schema として最低限の形を持つ', async () => {
    const text = await readFile(join(TEMPLATE_DIRECTORY, 'tool-template.schema.json'), 'utf8');
    const schema = JSON.parse(text) as Record<string, unknown>;
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema['type']).toBe('object');
    expect(Object.keys(schema['properties'] as object)).toContain('slots');
  });

  it('正常: zod が知っているスロットの種類を過不足なく列挙している', async () => {
    const schema = JSON.parse(await readFile(join(TEMPLATE_DIRECTORY, 'tool-template.schema.json'), 'utf8')) as Record<string, unknown>;
    const definitions = schema['definitions'] as Record<string, Record<string, unknown>>;
    const kinds = ((definitions['slot']?.['properties'] as Record<string, { enum?: string[] }>)['kind']?.enum ?? []).slice().sort();
    expect(kinds).toEqual([...TOOL_TEMPLATE_SLOT_KINDS].sort());

    // 種類ごとに 1 つずつ oneOf の枝がある（補完がその種類の追加フィールドを出せる）。
    const branches = (definitions['slot']?.['oneOf'] as { properties?: { kind?: { const?: string } } }[]).map((branch) => branch.properties?.kind?.const);
    expect(branches.slice().sort()).toEqual([...TOOL_TEMPLATE_SLOT_KINDS].sort());
  });

  it('正常: zod が知っている置換ディレクティブを過不足なく定義している', async () => {
    const schema = JSON.parse(await readFile(join(TEMPLATE_DIRECTORY, 'tool-template.schema.json'), 'utf8')) as Record<string, unknown>;
    const definitions = schema['definitions'] as Record<string, Record<string, unknown>>;
    const defined = Object.keys(definitions)
      .filter((name) => name.startsWith('directive') && name !== 'directive')
      .map((name) => Object.keys(definitions[name]!['properties'] as object)[0]);
    expect(defined.slice().sort()).toEqual([...TOOL_TEMPLATE_DIRECTIVES].sort());

    const union = (definitions['directive']?.['oneOf'] as { $ref?: string }[]).map((branch) => branch.$ref);
    expect(union).toHaveLength(TOOL_TEMPLATE_DIRECTIVES.length);
  });
});

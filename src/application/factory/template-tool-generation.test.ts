/**
 * テンプレート経路（v43 §4 / ADR-0049）のオーケストレーションを、**同梱の実テンプレート**と
 * **実エンジン**で確かめる。
 *
 * 作り物のテンプレートで固めると「同梱テンプレートが壊れても Factory のテストは緑」になるので、
 * カタログはリポジトリの `templates/tools` をそのまま読む。成功したツールは保存形のグラフを
 * 実データで走らせ、**返る値まで**見る（構成が正しいだけでなく答えが出ることを確かめる）。
 */
import { join } from 'node:path';
import { bundledPrompts } from '../../test-support/prompts';
import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { FsToolTemplateCatalog } from '../../adapters/templates/fs-tool-template-catalog';
import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { FactoryAbortedError } from '../../domain/factory/errors';
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import type { InstantiatedTemplate } from '../../domain/tool-template/instantiate';
import type { Tool } from '../../domain/tool/tool';
import { validateToolArguments } from '../agent/tool-schema';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import type { ModelCompletion } from '../model/model-provider';
import { EMPTY_TOOL_TEMPLATE_CATALOG, type ToolTemplateCatalogPort } from '../tool-template/catalog-port';
import { SuggestCalculateExpressionUseCase } from '../tool/suggest-calculate-expression';
import { graphWithArguments } from '../tool/tool-execution';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';
import { TemplateToolGeneration, describeSlots, templateTransformTypes } from './template-tool-generation';
import type { TemplateToolResult } from './template-tool-port';

const scope = { tenantId: 't', workspaceId: 'w' };
const goal: FactoryGoalInput = { goal: '売上の前年同月比と、地域ごとの指標を答えられるようにしたい。', language: 'ja' };
const TEMPLATE_DIRECTORY = join(process.cwd(), 'templates', 'tools');

// ── e-Stat 風の固定データ ─────────────────────────────────────────────────────────

/** 欠けの無い月次（前年同月比を数えられるよう 14 か月 × 2 地域）。 */
const MONTHLY_CSV = [
  '時点,地域,売上',
  ...Array.from({ length: 14 }, (_unused, index) => {
    const year = index < 12 ? 2022 : 2023;
    const month = index < 12 ? index + 1 : index - 11;
    return [`${year}年${month}月,北海道,${100 + (10 * index)}`, `${year}年${month}月,東京都,${200 + (20 * index)}`];
  }).flat(),
].join('\n');

/** 年次・地域別（計算列のテンプレート用）。 */
const REGION_CSV = [
  '時点,地域,人口',
  '2023年,北海道,5200',
  '2023年,東京都,14000',
  '2022年,北海道,5250',
  '2022年,東京都,13900',
].join('\n');

/** 同じ形（時点・地域コード・地域・値・注記）で結合できる表。 */
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

// ── Tool 計画 ─────────────────────────────────────────────────────────────────────

const monthlyPlan: FactoryToolPlan = {
  key: 'sales_change',
  displayName: '売上の前年同月比',
  purpose: '地域別の売上について、前年同月比の増減と増減率を返す。',
  argumentSummary: '期間の範囲と地域で絞れること。',
  dataSourceId: 'ds-monthly',
  sideEffect: 'read-only',
};

const regionPlan: FactoryToolPlan = {
  key: 'population_custom',
  displayName: '人口の加工値',
  purpose: '地域別の人口を万人単位に直した列と一緒に返す。',
  dataSourceId: 'ds-region',
  sideEffect: 'read-only',
};

const joinPlan: FactoryToolPlan = {
  key: 'wage_per_hour',
  displayName: '時間当たり賃金',
  purpose: '同じ時点・同じ地域の賃金を労働時間で割った時間当たり賃金を返す。',
  dataSourceId: 'ds-wage',
  sideEffect: 'read-only',
  additionalDataSourceIds: ['ds-hours'],
};

// ── ハーネス ──────────────────────────────────────────────────────────────────────

interface Harness {
  readonly engine: EtlEngine;
  readonly resolver: ResolveDataSourceGraphUseCase;
  readonly profiles: DataProfile[];
  /** `select-template` / `fill-slots` の台本。 */
  readonly tasks: ScriptedModelProvider;
  /** 式の提案（v41）の台本。順序を独立させるため別インスタンスにする。 */
  readonly expressions: ScriptedModelProvider;
  readonly roleCalls: () => number;
  readonly events: string[];
  generate(plan: FactoryToolPlan, options?: { readonly signal?: AbortSignal; readonly toolName?: string }): Promise<TemplateToolResult>;
}

async function setup(
  sources: readonly { readonly id: string; readonly name: string; readonly csv: string }[],
  options?: { readonly expressionAssistant?: 'on' | 'off'; readonly catalog?: ToolTemplateCatalogPort },
): Promise<Harness> {
  const dataSources = new InMemoryDataSourceRepository();
  for (const source of sources) {
    await dataSources.save(
      { id: source.id, tenant: scope, name: source.name, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: source.csv.length, createdAt: '', updatedAt: '' },
      source.csv,
    );
  }
  const registry = createDefaultRegistry();
  const engine = new EtlEngine(registry);
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  const profiles = await profiler.executeAll(scope, sources.map((source) => source.id));

  const tasks = new ScriptedModelProvider();
  const expressions = new ScriptedModelProvider();
  const mode = options?.expressionAssistant ?? 'on';
  const assistant = new SuggestCalculateExpressionUseCase(engine, expressions, () => mode === 'on', bundledPrompts());
  const catalog = options?.catalog ?? new FsToolTemplateCatalog({ directories: [TEMPLATE_DIRECTORY], registry });
  const templates = new TemplateToolGeneration(tasks, engine, catalog, assistant, resolver, bundledPrompts());

  let roleCalls = 0;
  const events: string[] = [];
  return {
    engine, resolver, profiles, tasks, expressions, events,
    roleCalls: () => roleCalls,
    generate: (plan, request) => templates.generate({
      scope, plan, profiles, goal,
      toolName: request?.toolName ?? plan.key,
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
      onRoleCall: () => { roleCalls += 1; },
      onEvent: (note) => events.push(note),
    }),
  };
}

function json(value: unknown): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify(value) }, finishReason: 'stop' };
}

function selected(templateId: string, reason = 'purpose に合うから'): ModelCompletion {
  return json({ templateId, reason });
}

/** 式提案の応答（`outputColumn` は計算列の名前をそのまま返させる）。 */
function expressionJson(outputColumn: string, expression: string): ModelCompletion {
  return json({ expression, outputColumn, rationale: ['列の割り算です'], warnings: [] });
}

/** 引数を束縛して実エンジンで走らせ、終端 `agent-output` の行を返す。 */
async function runTool(harness: Harness, instantiated: InstantiatedTemplate, args: Record<string, unknown> = {}): Promise<Row[]> {
  const row = instantiated.inputSchema === undefined ? undefined : validateToolArguments(instantiated.inputSchema, args as never);
  const graph: ToolGraph = row === undefined
    ? instantiated.graph
    : graphWithArguments({ graph: instantiated.graph, inputSchema: instantiated.inputSchema } as unknown as Tool, row);
  const preview = harness.engine.preview(await harness.resolver.execute(scope, graph));
  return [...(preview.nodes['out']?.table.rows ?? [])] as Row[];
}

function expectOk(result: TemplateToolResult): Extract<TemplateToolResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

function expectFailed(result: TemplateToolResult): Extract<TemplateToolResult, { ok: false }> {
  if (result.ok) throw new Error('expected the template path to give up');
  return result;
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

// ---------------------------------------------------------------------------

describe('TemplateToolGeneration — 1 ソース', () => {
  it('正常: period-change を選んでスロットを埋めると、前年同月比を計算するツールが実データで動く', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(
      selected('period-change'),
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: '地域', lag: '12', limit: 30 }),
    );

    const result = expectOk(await harness.generate(monthlyPlan));
    expect(result.template).toEqual({ id: 'period-change', version: '1.1.0' });
    expect(result.instantiated.agentTool.name).toBe('sales_change');

    // 値まで確かめる: 2023年1月の北海道は 220、前年同月 100 に対し delta 120 / +120%。
    const rows = await runTool(harness, result.instantiated, { period_from: null, period_to: null, categories: null });
    const january = rows.find((row) => row['地域'] === '北海道' && isoOf(row['bucketStart']) === '2023-01-01');
    expect(january?.['value']).toBe(220);
    expect(january?.['delta']).toBe(120);
    expect(january?.['percentChange']).toBeCloseTo(1.2, 10);
  });

  it('正常: 注記にテンプレート・版・埋めたスロットが決定的な書式で載る', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(
      selected('period-change'),
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: '地域', lag: '12', limit: 30 }),
    );

    const result = expectOk(await harness.generate(monthlyPlan));
    expect(result.notes).toEqual([
      'template: period-change@1.1.0',
      'slots: periodColumn=時点, valueColumns=[売上], categoryColumn=地域, lag=12, limit=30',
    ]);
  });

  it('正常: モデル呼び出しは「選ぶ」「埋める」の 2 回だけ（意図文が無ければ式は頼まない）', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(
      selected('period-change'),
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: null, lag: '12', limit: 30 }),
    );

    expectOk(await harness.generate(monthlyPlan));
    expect(harness.roleCalls()).toBe(2);
    expect(harness.tasks.requests).toHaveLength(2);
    expect(harness.expressions.requests).toHaveLength(0);
  });

  it('正常: custom-computation は意図文を式提案へ渡し、書けた式でツールが動く（呼び出しは 3 回）', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    harness.tasks.enqueue(
      selected('custom-computation'),
      json({
        periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域',
        outputColumn: '人口（万人）', computationIntent: '人口を 1000 で割って万人単位にする',
        defaultGranularity: 'year', limit: 10,
      }),
    );
    harness.expressions.enqueue(expressionJson('人口（万人）', '[人口] / 1000'));

    const result = expectOk(await harness.generate(regionPlan));
    expect(result.instantiated.pendingExpressions).toEqual([]);
    expect(harness.roleCalls()).toBe(3);

    const rows = await runTool(harness, result.instantiated, { granularity: 'year', categories: '東京都', period_from: null, period_to: null });
    expect(rows[0]?.['人口（万人）']).toBe(14);
    expect(rows[0]?.['人口']).toBe(14000);
  });

  it('異常: 式を書けなければ（辞退）そのツールのテンプレート経路を失敗にする', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }]);
    harness.tasks.enqueue(
      selected('custom-computation'),
      json({
        periodColumn: '時点', valueColumns: ['人口'], categoryColumn: null,
        outputColumn: '加工値', computationIntent: '人口を 1000 で割る',
        defaultGranularity: 'year', limit: 10,
      }),
    );
    // 空の式 = 辞退。
    harness.expressions.enqueue(expressionJson('加工値', '   '));

    const failed = expectFailed(await harness.generate(regionPlan));
    expect(failed.template?.id).toBe('custom-computation');
    expect(failed.attempted).toBe(true);
    expect(failed.reason).toContain('could not be written');
  });

  it('異常: 式提案が使えない配線では、意図文を持つテンプレートは諦めて次の経路へ渡す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '人口', csv: REGION_CSV }], { expressionAssistant: 'off' });
    harness.tasks.enqueue(
      selected('custom-computation'),
      json({
        periodColumn: '時点', valueColumns: ['人口'], categoryColumn: null,
        outputColumn: '加工値', computationIntent: '人口を 1000 で割る',
        defaultGranularity: 'year', limit: 10,
      }),
    );

    const failed = expectFailed(await harness.generate(regionPlan));
    expect(failed.reason).toContain('expression assistant is not available');
    expect(harness.expressions.requests).toHaveLength(0);
  });

  it('境界: "none" を選んだら何も作らず、段階的生成へ渡す（スロットは訊かない）', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(selected('none', 'どのテンプレートも目的に合わない'));

    const failed = expectFailed(await harness.generate(monthlyPlan));
    expect(failed.template).toBeUndefined();
    expect(failed.attempted).toBe(true);
    expect(failed.reason).toContain('どのテンプレートも目的に合わない');
    expect(harness.tasks.requests).toHaveLength(1);
  });

  it('異常: スロットの違反はランナーが 1 回差し戻し、直れば同じツールが完成する', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(
      selected('period-change'),
      // 1 回目: 存在しない列。`validateSlotValues` の違反としてそのまま差し戻る。
      json({ periodColumn: '時点', valueColumns: ['存在しない列'], categoryColumn: null, lag: '12', limit: 30 }),
      json({ periodColumn: '時点', valueColumns: ['売上'], categoryColumn: null, lag: '12', limit: 30 }),
    );

    const result = expectOk(await harness.generate(monthlyPlan));
    expect(result.slots['valueColumns']).toEqual(['売上']);
    // 差し戻しはランナーの中（タスクの再試行）なので、注記の `repaired` は付かない。
    expect(result.notes).not.toContain('repaired: fill-slots');
    expect(harness.roleCalls()).toBe(3);
    // やり直しの依頼には、直すべき違反がそのまま入っている。
    const repair = harness.tasks.requests[2]?.messages.at(-1)?.content ?? '';
    expect(repair).toContain('存在しない列');
  });

  it('異常: スロットを 2 回とも埋められなければ、理由つきで諦める', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    harness.tasks.enqueue(
      selected('period-change'),
      json({ periodColumn: '時点', valueColumns: ['無い列 A'], categoryColumn: null, lag: '12', limit: 30 }),
      json({ periodColumn: '時点', valueColumns: ['無い列 B'], categoryColumn: null, lag: '12', limit: 30 }),
    );

    const failed = expectFailed(await harness.generate(monthlyPlan));
    expect(failed.template?.id).toBe('period-change');
    expect(failed.reason).toContain('無い列 B');
  });

  it('境界: 当てはまるテンプレートが 1 つも無ければ、モデルを一度も呼ばない', async () => {
    // 期間ラベル列が無いデータは、どの同梱テンプレートも必須スロットを埋められない。
    const harness = await setup([{ id: 'ds-flat', name: '明細', csv: 'id,amount\n1,100\n2,200' }]);
    const failed = expectFailed(await harness.generate({ ...monthlyPlan, dataSourceId: 'ds-flat' }));

    expect(failed.attempted).toBe(false);
    expect(failed.reason).toContain('no tool template fits');
    expect(harness.tasks.requests).toHaveLength(0);
    expect(harness.roleCalls()).toBe(0);
  });

  it('境界: テンプレートが 1 つも置かれていない配線でも、例外にせず次の経路へ渡す', async () => {
    const empty: ToolTemplateCatalogPort = { list: async () => EMPTY_TOOL_TEMPLATE_CATALOG };
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }], { catalog: empty });

    const failed = expectFailed(await harness.generate(monthlyPlan));
    expect(failed.reason).toBe('no tool templates are available');
    expect(failed.attempted).toBe(false);
  });

  it('例外: 中断（cancel）はフォールバックへ丸めず FactoryAbortedError で抜ける', async () => {
    const harness = await setup([{ id: 'ds-monthly', name: '月次売上', csv: MONTHLY_CSV }]);
    const controller = new AbortController();
    controller.abort(new FactoryAbortedError('Cancelled by user'));

    await expect(harness.generate(monthlyPlan, { signal: controller.signal })).rejects.toBeInstanceOf(FactoryAbortedError);
    expect(harness.tasks.requests).toHaveLength(0);
  });
});

describe('TemplateToolGeneration — 結合するツール', () => {
  const sources = [
    { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
    { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
  ];
  const slots = {
    joinKeys: ['時点', '地域コード'], periodColumn: '時点', numerator: '値', denominator: '値',
    ratioColumn: '時間当たり賃金', scale: '1', defaultGranularity: 'year', limit: 10,
  };

  it('正常: ratio-of-two-sources で 2 ソースを結合し、比の列の値まで正しい', async () => {
    const harness = await setup(sources);
    harness.tasks.enqueue(selected('ratio-of-two-sources'), json(slots));

    const result = expectOk(await harness.generate(joinPlan));
    // dataSource スロットは訊かず、計画の順（主 → 追加）で決定的に割り当てる。
    expect(result.slots['numeratorSource']).toBe('ds-wage');
    expect(result.slots['denominatorSource']).toBe('ds-hours');
    expect(harness.roleCalls()).toBe(2);

    const rows = await runTool(harness, result.instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows.find((row) => row['地域'] === '東京都' && row['時点'] === '2023年')?.['時間当たり賃金']).toBe(2.5);
    expect(rows.find((row) => row['地域'] === '北海道' && row['時点'] === '2023年')?.['時間当たり賃金']).toBe(2);
  });

  it('異常: 結合キーが足りず行が増えた違反は、結合キーのスロットへ 1 回差し戻して直る', async () => {
    const harness = await setup(sources);
    harness.tasks.enqueue(
      selected('join-side-by-side'),
      // 地域コードだけで結ぶと、同じ地域の 2 年ぶんが総当たりになって行が増える。
      json({ joinKeys: ['地域コード'], periodColumn: '時点', primaryValues: ['値'], secondaryValues: ['値'], defaultGranularity: 'year', limit: 10 }),
      json({ joinKeys: ['時点', '地域コード'], periodColumn: '時点', primaryValues: ['値'], secondaryValues: ['値'], defaultGranularity: 'year', limit: 10 }),
    );

    const result = expectOk(await harness.generate(joinPlan));
    expect(result.slots['joinKeys']).toEqual(['時点', '地域コード']);
    // 検査の違反で差し戻したので、注記に repaired が残る。
    expect(result.notes).toContain('repaired: fill-slots');
    expect(harness.events.some((note) => note.includes('re-running fill-slots for template join-side-by-side'))).toBe(true);
    // やり直しの依頼には、どのスロットを直すかと違反の文言が入っている。
    const repair = JSON.stringify(harness.tasks.requests[2]?.messages ?? []);
    expect(repair).toContain('joinKeys');
    expect(repair).toContain('rows multiplied');

    const rows = await runTool(harness, result.instantiated, { granularity: 'year', period_from: null, period_to: null });
    expect(rows).toHaveLength(4);
  });

  it('異常: 差し戻しても検査を通らなければ、理由（検査の種類つき）を添えて諦める', async () => {
    const harness = await setup(sources);
    harness.tasks.enqueue(
      selected('join-side-by-side'),
      json({ joinKeys: ['地域コード'], periodColumn: '時点', primaryValues: ['値'], secondaryValues: ['値'], defaultGranularity: 'year', limit: 10 }),
      json({ joinKeys: ['地域コード'], periodColumn: '時点', primaryValues: ['値'], secondaryValues: ['値'], defaultGranularity: 'year', limit: 10 }),
    );

    const failed = expectFailed(await harness.generate(joinPlan));
    expect(failed.template?.id).toBe('join-side-by-side');
    expect(failed.reason).toContain('semantic:');
    expect(failed.reason).toContain('rows multiplied');
    // 差し戻しは 1 回だけ（選ぶ 1 + 埋める 2）。
    expect(harness.roleCalls()).toBe(3);
  });
});

describe('テンプレート経路の小さな部品', () => {
  it('正常: 形の検査へ渡す変換種別は、そのグラフが実際に使っている種別だけ（source と入出力は外す）', () => {
    const graph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: {} },
        { id: 'a', type: 'time-series-analysis', config: {} },
        { id: 'b', type: 'sort', config: {} },
        { id: 'args', type: 'agent-input', config: {} },
        { id: 'out', type: 'agent-output', config: {} },
      ],
      edges: [],
    };
    expect(templateTransformTypes(graph)).toEqual(['time-series-analysis', 'sort']);
  });

  it('境界: 埋めなかったスロットは注記に出さない（空欄を並べない）', () => {
    const template = {
      slots: [
        { kind: 'dataSource', name: 'source' },
        { kind: 'column', name: 'periodColumn' },
        { kind: 'column', name: 'categoryColumn' },
        { kind: 'column', name: 'valueColumns' },
      ],
    } as unknown as Parameters<typeof describeSlots>[0];
    expect(describeSlots(template, { source: 'ds-1', periodColumn: '時点', valueColumns: ['売上', '客数'] }))
      .toBe('periodColumn=時点, valueColumns=[売上, 客数]');
  });
});

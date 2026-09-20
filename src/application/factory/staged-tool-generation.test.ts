import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { FactoryAbortedError } from '../../domain/factory/errors';
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import type { Tool } from '../../domain/tool/tool';
import { validateToolArguments } from '../agent/tool-schema';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import type { ModelCompletion } from '../model/model-provider';
import { SuggestCalculateExpressionUseCase } from '../tool/suggest-calculate-expression';
import { graphWithArguments } from '../tool/tool-execution';
import type { CompiledTool } from './compile-tool-spec';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';
import { StagedToolGeneration, routeViolation } from './staged-tool-generation';
import type { StagedToolResult } from './staged-tool-port';

const scope = { tenantId: 't', workspaceId: 'w' };
const goal: FactoryGoalInput = { goal: '人口の推移を月次でも年次でも答えられるようにしたい。', language: 'ja' };

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
  '2022年,01000,北海道,2480,',
  '2022年,13000,東京都,6950,',
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

interface Harness {
  readonly engine: EtlEngine;
  readonly resolver: ResolveDataSourceGraphUseCase;
  readonly profiles: DataProfile[];
  /** 設計タスク（decide-*）の台本。 */
  readonly tasks: ScriptedModelProvider;
  /** 式の提案（write-expression）の台本。別インスタンスにして順序を独立させる。 */
  readonly expressions: ScriptedModelProvider;
  readonly staged: StagedToolGeneration;
  readonly roleCalls: () => number;
  readonly events: string[];
  generate(plan: FactoryToolPlan, options?: { readonly signal?: AbortSignal; readonly maxRepairAttempts?: number }): Promise<StagedToolResult>;
}

async function setup(
  sources: readonly { readonly id: string; readonly name: string; readonly csv: string }[],
  options?: { readonly expressionAssistant?: 'on' | 'off' | 'absent' },
): Promise<Harness> {
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

  const tasks = new ScriptedModelProvider();
  const expressions = new ScriptedModelProvider();
  const mode = options?.expressionAssistant ?? 'on';
  const assistant = mode === 'absent'
    ? undefined
    : new SuggestCalculateExpressionUseCase(engine, expressions, () => mode === 'on');
  const staged = new StagedToolGeneration(tasks, engine, assistant, resolver);

  let roleCalls = 0;
  const events: string[] = [];
  return {
    engine, resolver, profiles, tasks, expressions, staged, events,
    roleCalls: () => roleCalls,
    generate: (plan, request) => staged.generate({
      scope, plan, profiles, goal,
      ...(request?.maxRepairAttempts === undefined ? {} : { maxRepairAttempts: request.maxRepairAttempts }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
      onRoleCall: () => { roleCalls += 1; },
      onEvent: (note) => events.push(note),
    }),
  };
}

function json(value: unknown): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify(value) }, finishReason: 'stop' };
}

/** 式提案の応答（`outputColumn` は計算列の名前をそのまま返させる）。 */
function expressionJson(outputColumn: string, expression: string): ModelCompletion {
  return json({ expression, outputColumn, rationale: ['列どうしの割り算です'], warnings: [] });
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

function expectOk(result: StagedToolResult): Extract<StagedToolResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

// ---------------------------------------------------------------------------

describe('StagedToolGeneration — 単一ソース', () => {
  it('正常: 絞り込み・計算列・出力を決めて組み立て、式を埋めたツールが実エンジンで動く', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '人口を1000で割った値' }] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
    );
    harness.expressions.enqueue(expressionJson('人口指数', '[人口] / 1000'));

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.spec.period).toEqual({ column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true });
    expect(result.spec.computations).toEqual([{ outputColumn: '人口指数', intent: '人口を1000で割った値' }]);
    // 計算列のノードには式が入っている（空のままなら実行できない）。
    const calculate = result.compiled.graph.nodes.find((node) => node.id === 'calc_1');
    expect((calculate?.config as { expression: string }).expression).toBe('[人口] / 1000');

    const rows = await runTool(harness, result.compiled, { granularity: 'month' });
    expect(rows.map((row) => row['時点'])).toEqual(['2023年2月', '2023年1月', '2022年1月']);
    expect(rows[0]?.['人口指数']).toBeCloseTo(12.44);
  });

  it('正常: `granularity` を引数にしたツールは月次でも年次でも呼べる', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'argument', defaultGranularity: 'year', range: true }, categoryFilters: [] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.compiled.inputSchema?.columns[0]).toEqual({ name: 'granularity', type: 'string', nullable: false });
    expect((await runTool(harness, result.compiled, { granularity: 'month' })).map((row) => row['時点'])).toEqual(['2023年2月', '2023年1月', '2022年1月']);
    expect((await runTool(harness, result.compiled, { granularity: 'year' })).map((row) => row['時点'])).toEqual(['2023年', '2022年']);
  });

  it('正常: 計算列が0件なら式のタスクは走らず、注記にも出ない', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.notes).toEqual(['staged: decide-filters, decide-computations, decide-output']);
    expect(harness.expressions.requests).toHaveLength(0);
    expect(harness.roleCalls()).toBe(3);
  });

  it('正常: onRoleCall はモデル呼び出しごとに1回呼ばれる（計算列1つなら4回）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '人口を1000で割った値' }] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );
    harness.expressions.enqueue(expressionJson('人口指数', '[人口] / 1000'));

    const result = expectOk(await harness.generate(nationalPlan));
    // decide-filters + decide-computations + decide-output + write-expression（1往復）。
    expect(harness.roleCalls()).toBe(4);
    expect(result.notes[0]).toBe('staged: decide-filters, decide-computations, decide-output, write-expression×1');
  });
});

describe('StagedToolGeneration — 複数カテゴリ・結合', () => {
  it('正常: カテゴリ引数は `in` で束縛され、1回の呼び出しで複数地域を引ける', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'argument', defaultGranularity: 'year', range: true }, categoryFilters: [{ column: '地域', argument: 'regions', multi: true }] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
    );

    const result = expectOk(await harness.generate(regionPlan));
    const filter = result.compiled.graph.nodes.find((node) => node.id === 'f_category');
    expect((filter?.config as { conditions: { op: string }[] }).conditions[0]?.op).toBe('in');

    const rows = await runTool(harness, result.compiled, { granularity: 'year', regions: '東京都,大阪府' });
    expect(rows.map((row) => row['地域'])).toEqual(['東京都', '大阪府', '東京都']);
  });

  it('正常: 3ソースの結合は共有キーで組み、どのソースの値も同じ行に並ぶ', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    harness.tasks.enqueue(
      json({ keys: ['時点', '地域コード'], mode: 'inner' }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '時給', intent: '賃金を労働時間で割る' }] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
    );
    harness.expressions.enqueue(expressionJson('時給', '[値] / [値_2]'));

    const result = expectOk(await harness.generate(joinPlan));
    expect(result.spec.join).toEqual({ keys: ['時点', '地域コード'], mode: 'inner' });
    expect(result.notes[0]).toBe('staged: decide-join, decide-filters, decide-computations, decide-output, write-expression×1');

    const rows = await runTool(harness, result.compiled);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ 時点: '2023年', 値: 280, 値_2: 150, 値_3: 98 });
    expect(rows[0]?.['時給']).toBeCloseTo(280 / 150);
  });

  it('異常: 結合キーが足りず行が増えたら decide-join だけを理由つきでやり直す', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    harness.tasks.enqueue(
      json({ keys: ['時点'], mode: 'inner' }), // 時点だけでは地域が総当たりになる
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
      json({ keys: ['時点', '地域コード'], mode: 'inner' }), // 差し戻し後
    );

    const result = expectOk(await harness.generate(joinPlan));
    expect(result.spec.join?.keys).toEqual(['時点', '地域コード']);
    expect(result.notes).toContain('repaired: decide-join');
    // 差し戻しは「行が増えた」という検査の文言をそのまま担当タスクへ渡す。
    const feedback = harness.tasks.requests.at(-1)?.messages.map((message) => String(message.content)).join('\n') ?? '';
    expect(feedback).toContain('rows multiplied');
    expect(harness.events.some((note) => note.startsWith('re-running decide-join:'))).toBe(true);
  });

  it('異常: やり直しても直らない結合は ok:false で返す（タスクの差し戻しは1回まで）', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    harness.tasks.enqueue(
      json({ keys: ['時点'], mode: 'inner' }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
      json({ keys: ['時点'], mode: 'inner' }), // 同じ答えを返す
    );

    const result = await harness.generate(joinPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('rows multiplied');
    expect(result.spec?.join?.keys).toEqual(['時点']);
    // 2 回目の decide-join のあとは、もうやり直さない（3 回目の台本は消費されない）。
    expect(harness.tasks.requests).toHaveLength(5);
  });

  it('境界: コンパイルの予算（maxRepairAttempts + 1 回）を使い切ったら差し戻さずに諦める', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    harness.tasks.enqueue(
      json({ keys: ['時点'], mode: 'inner' }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
    );

    const result = await harness.generate(joinPlan, { maxRepairAttempts: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^gave up after 1 compilations: semantic: /);
    expect(harness.tasks.requests).toHaveLength(4); // やり直しのモデル呼び出しは足さない
  });
});

describe('StagedToolGeneration — spec の検証と差し戻し', () => {
  it('異常: 仕様の違反（カテゴリ引数が単一値）は決めたタスクへ理由つきで差し戻す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [{ column: '地域', argument: 'region', multi: false }] }),
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [{ column: '地域', argument: 'region', multi: true }] }),
    );

    const result = expectOk(await harness.generate(regionPlan));
    expect(result.spec.categoryFilters).toEqual([{ column: '地域', argument: 'region', multi: true }]);
    expect(result.notes).toContain('repaired: decide-filters');
    const feedback = harness.tasks.requests.at(-1)?.messages.map((message) => String(message.content)).join('\n') ?? '';
    expect(feedback).toContain('multi: false');
  });

  it('異常: 差し戻しても同じ違反を返すタスクには2回目を頼まず ok:false で返す', async () => {
    const harness = await setup([{ id: 'ds-region', name: '地域別就業者数', csv: REGION_CSV }]);
    const bad = json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [{ column: '地域', argument: 'region', multi: false }] });
    harness.tasks.enqueue(
      bad,
      json({ computations: [] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
      bad,
    );

    const result = await harness.generate(regionPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('every responsible task was already re-run once');
    expect(result.reason).toContain('decide-filters');
    expect(harness.tasks.requests).toHaveLength(4);
  });

  it('例外: タスクが2回とも読めない応答を返したら ok:false へ畳む（例外は投げない）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      { message: { role: 'assistant', content: 'not json' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'still not json' }, finishReason: 'stop' },
    );

    const result = await harness.generate(nationalPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('decide-filters');
  });
});

describe('StagedToolGeneration — 式が書けないとき', () => {
  it('異常: 式を辞退されたらその計算列だけ落とし、ツールは作る', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '地域名の文字数を数える' }] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );
    // 空の式 = この電卓では表せない、という辞退（実機で観測された形）。
    harness.expressions.enqueue(json({ expression: '', outputColumn: '人口指数', rationale: [], warnings: ['文字数を数える関数がありません'] }));

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.compiled.graph.nodes.some((node) => node.type === 'calculate')).toBe(false);
    expect(result.spec.computations).toEqual([]);
    expect(result.notes.some((note) => note.startsWith('dropped computation: 人口指数 ('))).toBe(true);
    expect(harness.events.some((note) => note.startsWith('dropped computation: 人口指数 ('))).toBe(true);
    // 落としても行は返る（ツール全体を落とさない）。
    expect(await runTool(harness, result.compiled)).toHaveLength(2);
  });

  it('異常: 式の提案が使えない構成では計算列を全て落とす（モデルも呼ばない）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }], { expressionAssistant: 'off' });
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '人口を1000で割った値' }, { outputColumn: '人口比', intent: '人口を100で割った値' }] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.compiled.calculateNodeIds).toEqual([]);
    expect(result.notes.filter((note) => note.startsWith('dropped computation:'))).toHaveLength(2);
    expect(harness.expressions.requests).toHaveLength(0);
    // 式のタスクは1回も走っていないので注記にも出ない。
    expect(result.notes[0]).toBe('staged: decide-filters, decide-computations, decide-output');
  });

  it('境界: 式の提案そのものが注入されていなくても計算列を落として続行する', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }], { expressionAssistant: 'absent' });
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '人口を1000で割った値' }] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.compiled.calculateNodeIds).toEqual([]);
    expect(result.notes.some((note) => note.includes('not available'))).toBe(true);
  });

  it('異常: 2つのうち片方の式だけが書けないときは、書けた方を残す', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ computations: [{ outputColumn: '人口指数', intent: '人口を1000で割った値' }, { outputColumn: '人口比', intent: '地域名の文字数' }] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );
    harness.expressions.enqueue(
      expressionJson('人口指数', '[人口] / 1000'),
      json({ expression: '', outputColumn: '人口比', rationale: [], warnings: ['表せません'] }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.spec.computations.map((computation) => computation.outputColumn)).toEqual(['人口指数']);
    const rows = await runTool(harness, result.compiled);
    expect(rows[0]?.['人口指数']).toBeCloseTo(12.43);
    expect(rows[0]?.['人口比']).toBeUndefined();
  });
});

describe('StagedToolGeneration — 中断と設定不足', () => {
  it('例外: 中断（abort）は ok:false へ畳まず FactoryAbortedError で抜ける', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const controller = new AbortController();
    controller.abort();
    await expect(harness.generate(nationalPlan, { signal: controller.signal })).rejects.toBeInstanceOf(FactoryAbortedError);
    expect(harness.tasks.requests).toHaveLength(0);
  });

  it('境界: データソース解決が注入されていなければ、モデルを呼ぶ前に ok:false を返す', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const staged = new StagedToolGeneration(harness.tasks, harness.engine, undefined, undefined);
    const result = await staged.generate({
      scope, plan: nationalPlan, profiles: harness.profiles, goal,
      onRoleCall: () => { throw new Error('must not call the model'); },
      onEvent: () => undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('data source resolver');
  });

  it('例外: 計画のデータソースにプロファイルが無ければ ok:false（例外にしない）', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    const result = await harness.generate(regionPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ds-region');
  });
});

describe('routeViolation（検査の違反 → 担当タスクの対応表・v42 §6）', () => {
  const spec = { version: 1, categoryFilters: [], computations: [], output: { columns: [], sort: 'none', limit: 10 } } as const;
  const joined = { ...spec, join: { keys: ['時点'], mode: 'inner' } } as const;

  it('正常: 引数なし呼び出しの溢れは decide-output（limit）へ戻す', () => {
    expect(routeViolation({ kind: 'overflow', message: 'calling this tool with no arguments returns 500 rows' }, spec)).toBe('decide-output');
  });

  it('正常: 結合の違反は decide-join へ戻す', () => {
    expect(routeViolation({ kind: 'semantic', message: `the 'join' node 'join_1' produced 8 rows` }, joined)).toBe('decide-join');
  });

  it('境界: 結合していないツールの意味違反は差し戻さない（コンパイラのバグ）', () => {
    expect(routeViolation({ kind: 'semantic', message: `the 'join' node 'join_1' produced 8 rows` }, spec)).toBeUndefined();
    expect(routeViolation({ kind: 'semantic', message: 'the rows this tool returns do not contain the period column' }, joined)).toBeUndefined();
  });

  it('境界: 形・結合の設計・スキーマ伝播の違反は差し戻さない', () => {
    expect(routeViolation({ kind: 'shape', message: 'tool graph shape is invalid' }, spec)).toBeUndefined();
    expect(routeViolation({ kind: 'join-design', message: 'joined tool design is wrong' }, joined)).toBeUndefined();
    expect(routeViolation({ kind: 'propagation', message: 'graph validation failed' }, spec)).toBeUndefined();
  });
});

describe('StagedToolGeneration — 複数タスクへの差し戻し', () => {
  it('異常: 違反が2つのタスクにまたがるときは、それぞれを1回ずつやり直す', async () => {
    const harness = await setup([{ id: 'ds-national', name: '全国人口', csv: NATIONAL_CSV }]);
    harness.tasks.enqueue(
      // 粒度が混ざる列なのに期間を扱わない（decide-filters の違反）。
      json({ period: null, categoryFilters: [] }),
      json({ computations: [] }),
      // 期間が無いのに「新しい順」を選ぶ（decide-output の違反）。
      json({ columns: [], sort: 'latest-first', limit: 10 }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      json({ columns: [], sort: 'latest-first', limit: 10 }),
    );

    const result = expectOk(await harness.generate(nationalPlan));
    expect(result.spec.period?.granularity).toBe('year');
    expect(result.notes).toContain('repaired: decide-filters, decide-output');
    expect(harness.events).toHaveLength(2);
    expect(harness.events[0]).toContain('re-running decide-filters: the period column');
    expect(harness.events[1]).toContain("re-running decide-output: output.sort is 'latest-first'");
  });

  it('異常: 計算列の名前が結合後の列とぶつかったら decide-computations をやり直す', async () => {
    const harness = await setup([
      { id: 'ds-wage', name: '賃金', csv: WAGE_CSV },
      { id: 'ds-hours', name: '労働時間', csv: HOURS_CSV },
      { id: 'ds-price', name: '物価', csv: PRICE_CSV },
    ]);
    harness.tasks.enqueue(
      json({ keys: ['時点', '地域コード'], mode: 'inner' }),
      json({ period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] }),
      // 値_2 は結合で右側の「値」に付く名前なので、計算列の名前としては使えない。
      json({ computations: [{ outputColumn: '値_2', intent: '賃金を労働時間で割る' }] }),
      json({ columns: [], sort: 'latest-first', limit: 20 }),
      json({ computations: [] }),
    );

    const result = expectOk(await harness.generate(joinPlan));
    expect(result.spec.computations).toEqual([]);
    expect(result.notes).toContain('repaired: decide-computations');
    expect(harness.events[0]).toContain('re-running decide-computations:');
  });
});

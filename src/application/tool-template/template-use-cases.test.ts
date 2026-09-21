/**
 * ツールテンプレートを「人が」使う 3 つのユースケース（一覧・候補・実体化）のテスト。
 *
 * 候補と実体化は**同梱の本物のテンプレート**（`templates/tools/period-series.json` と
 * `ratio-of-two-sources.json` / `custom-computation.json`）を実カタログから読んで使う。
 * 作り物のテンプレートで通しても、ファイルの側が壊れていることに気づけないため。
 * 一覧の `invalid` だけは、壊れたファイルを置かずに済むようポートのスタブで確かめる。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsToolTemplateCatalog } from '../../adapters/templates/fs-tool-template-catalog';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { ProfileDataSourcesUseCase } from '../factory/profile-data-sources';
import { EMPTY_TOOL_TEMPLATE_CATALOG, type ToolTemplateCatalog, type ToolTemplateCatalogPort } from './catalog-port';
import {
  InstantiateToolTemplateUseCase,
  ListToolTemplatesUseCase,
  MAX_CANDIDATE_EXAMPLES,
  TemplateSlotCandidatesUseCase,
  ToolTemplateNotFoundError,
  ToolTemplateSlotsError,
  type SlotCandidatesView,
} from './template-use-cases';
import { ToolTemplateError } from '../../domain/tool-template/template';

const scope = { tenantId: 't', workspaceId: 'w' };
const TEMPLATE_DIRECTORY = join(process.cwd(), 'templates', 'tools');

/** 1 つの時点列に月・年が混ざり、地域つきの表（e-Stat 風）。 */
const REGION_CSV = [
  '時点,地域コード,地域,人口,注記',
  '2023年,01000,北海道,5200,',
  '2023年,13000,東京都,14000,',
  '2022年,01000,北海道,5250,',
  '2022年,13000,東京都,13900,',
  '2023年5月,13000,東京都,13950,速報',
].join('\n');

/** 同じ時点・同じ地域コードで結合できる、別の指標の表。 */
const WORKERS_CSV = [
  '時点,地域コード,地域,就業者数,注記',
  '2023年,01000,北海道,2500,',
  '2023年,13000,東京都,7000,',
  '2022年,01000,北海道,2480,',
  '2022年,13000,東京都,6950,',
].join('\n');

interface Harness {
  readonly list: ListToolTemplatesUseCase;
  readonly candidates: TemplateSlotCandidatesUseCase;
  readonly instantiate: InstantiateToolTemplateUseCase;
}

async function harnessWith(sources: readonly { readonly id: string; readonly name: string; readonly csv: string }[], catalog?: ToolTemplateCatalogPort): Promise<Harness> {
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
  const templates = catalog ?? new FsToolTemplateCatalog({ directories: [TEMPLATE_DIRECTORY], registry });
  return {
    list: new ListToolTemplatesUseCase(templates),
    candidates: new TemplateSlotCandidatesUseCase(templates, profiler),
    instantiate: new InstantiateToolTemplateUseCase(templates, profiler, engine, resolver),
  };
}

/** 1 ソース（人口）だけの土台。 */
const singleSource = () => harnessWith([{ id: 'ds-population', name: '人口', csv: REGION_CSV }]);
/** 2 ソース（人口・就業者数）の土台（結合キー候補が付く）。 */
const twoSources = () => harnessWith([
  { id: 'ds-population', name: '人口', csv: REGION_CSV },
  { id: 'ds-workers', name: '就業者数', csv: WORKERS_CSV },
]);

/** 違反を持つ例外だけを取り出す（型を絞って `slots` を読めるようにする）。 */
async function slotsErrorOf(promise: Promise<unknown>): Promise<ToolTemplateSlotsError> {
  const caught = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(caught).toBeInstanceOf(ToolTemplateSlotsError);
  return caught as ToolTemplateSlotsError;
}

function candidateOf(candidates: readonly SlotCandidatesView[], slot: string): SlotCandidatesView {
  const found = candidates.find((candidate) => candidate.slot === slot);
  if (found === undefined) throw new Error(`no candidates for slot '${slot}'`);
  return found;
}

/** `templates/tools` を読まないスタブ（一覧の invalid 表示を確かめるため）。 */
function stubCatalog(catalog: ToolTemplateCatalog): ToolTemplateCatalogPort {
  return { list: async () => catalog };
}

describe('ListToolTemplatesUseCase', () => {
  it('正常: 同梱テンプレートを、スロット宣言つきの要約として返す（ノード・エッジは出さない）', async () => {
    const { list } = await singleSource();
    const view = await list.execute();
    const series = view.templates.find((template) => template.id === 'period-series');
    expect(series).toBeDefined();
    expect(series?.title.ja).toBe('時系列の取り出し');
    expect(series?.whenToUse.ja.length).toBeGreaterThan(0);
    expect(series?.sources).toEqual({ min: 1, max: 1 });
    expect(series).not.toHaveProperty('nodes');
    expect(series).not.toHaveProperty('edges');
    const periodColumn = series?.slots.find((slot) => slot.name === 'periodColumn');
    expect(periodColumn).toMatchObject({ kind: 'column', role: 'period', source: 'source', optional: false });
    expect(series?.slots.find((slot) => slot.name === 'categoryColumn')?.optional).toBe(true);
  });

  it('正常: choice / number / text の既定値と範囲を載せる（画面の初期値になる）', async () => {
    const { list } = await singleSource();
    const view = await list.execute();
    const ratio = view.templates.find((template) => template.id === 'ratio-of-two-sources');
    expect(ratio?.slots.find((slot) => slot.name === 'scale')).toMatchObject({ kind: 'choice', default: '1' });
    expect(ratio?.slots.find((slot) => slot.name === 'scale')?.options?.[1]?.label.ja).toContain('百分率');
    expect(ratio?.slots.find((slot) => slot.name === 'limit')).toMatchObject({ kind: 'number', min: 1, max: 100, integer: true, default: 24 });
    expect(ratio?.slots.find((slot) => slot.name === 'ratioColumn')).toMatchObject({ kind: 'text', maxLength: 40, default: '比率' });
  });

  it('異常: 読めなかったファイルは理由と直し方つきで invalid に並ぶ（一覧は落ちない）', async () => {
    const invalid = { file: 'broken.json', problems: ["id 'Broken!' does not match …; rename it to lowercase letters"] };
    const stub = new ListToolTemplatesUseCase(stubCatalog({ templates: [], invalid: [invalid] }));
    await expect(stub.execute()).resolves.toEqual({ templates: [], invalid: [invalid] });
  });

  it('境界: 置き場所が 1 つも無ければ空の一覧（機能が無効なだけで、エラーにしない）', async () => {
    const empty = new ListToolTemplatesUseCase(stubCatalog(EMPTY_TOOL_TEMPLATE_CATALOG));
    await expect(empty.execute()).resolves.toEqual({ templates: [], invalid: [] });
  });
});

describe('TemplateSlotCandidatesUseCase', () => {
  it('正常: データソースの候補は id と表示名を持つ', async () => {
    const { candidates } = await singleSource();
    const result = await candidates.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'] });
    expect(result).toMatchObject({ templateId: 'period-series', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(candidateOf(result.candidates, 'source').options).toEqual([{ value: 'ds-population', name: '人口' }]);
  });

  it('正常: 列の候補は型を持ち、カテゴリ列には実在値の例と総数が付く', async () => {
    const { candidates } = await singleSource();
    const result = await candidates.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'] });
    expect(candidateOf(result.candidates, 'valueColumns').options).toEqual([{ value: '人口', type: 'number' }]);
    const category = candidateOf(result.candidates, 'categoryColumn').options?.find((option) => option.value === '地域');
    expect(category?.examples).toEqual(['北海道', '東京都']);
    expect(category?.distinctCount).toBe(2);
    expect(category?.examples?.length).toBeLessThanOrEqual(MAX_CANDIDATE_EXAMPLES);
  });

  it('正常: 期間列の候補は粒度ごとの行数と、解釈できた開始日の最小・最大を持つ', async () => {
    const { candidates } = await singleSource();
    const result = await candidates.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'] });
    const period = candidateOf(result.candidates, 'periodColumn').options?.find((option) => option.value === '時点');
    expect(period?.granularities).toEqual({ year: 4, month: 1 });
    expect(period).toMatchObject({ minStart: '2022-01-01', maxStart: '2023-05-01' });
  });

  it('正常: 依存するスロット（どのデータソースの列か）を変えると、列の候補もそのソースのものへ変わる', async () => {
    const { candidates } = await twoSources();
    const ask = async (numeratorSource: string, denominatorSource: string): Promise<readonly string[]> => {
      const result = await candidates.execute({
        scope, templateId: 'ratio-of-two-sources', dataSourceIds: ['ds-population', 'ds-workers'],
        values: { numeratorSource, denominatorSource },
      });
      return (candidateOf(result.candidates, 'numerator').options ?? []).map((option) => option.value);
    };
    expect(await ask('ds-workers', 'ds-population')).toEqual(['就業者数']);
    expect(await ask('ds-population', 'ds-workers')).toEqual(['人口']);
  });

  it('正常: 粒度の選択肢は、選んだ期間列にデータが在る粒度だけになる', async () => {
    const { candidates } = await singleSource();
    const result = await candidates.execute({
      scope, templateId: 'period-series', dataSourceIds: ['ds-population'],
      values: { source: 'ds-population', periodColumn: '時点' },
    });
    expect(candidateOf(result.candidates, 'defaultGranularity').options?.map((option) => option.value)).toEqual(['year', 'month']);
  });

  it('正常: joinKeys の候補は値の重なりと、キー全部を使ったときの一意性を持つ', async () => {
    const { candidates } = await twoSources();
    const result = await candidates.execute({
      scope, templateId: 'ratio-of-two-sources', dataSourceIds: ['ds-population', 'ds-workers'],
      values: { numeratorSource: 'ds-workers', denominatorSource: 'ds-population' },
    });
    const keys = candidateOf(result.candidates, 'joinKeys');
    expect(keys.options?.map((option) => option.value)).toEqual(expect.arrayContaining(['時点', '地域コード', '地域']));
    const period = keys.options?.find((option) => option.value === '時点');
    expect(period?.overlap).toBeGreaterThan(0);
    expect(period).toMatchObject({ uniqueLeft: expect.any(Boolean), uniqueRight: expect.any(Boolean) });
  });

  it('正常: choice の固定選択肢は日英ラベルを持つ（画面がそのまま出せる）', async () => {
    const { candidates } = await twoSources();
    const result = await candidates.execute({
      scope, templateId: 'ratio-of-two-sources', dataSourceIds: ['ds-population', 'ds-workers'],
    });
    expect(candidateOf(result.candidates, 'scale').options?.[1]).toMatchObject({ value: '100', label: { ja: '百分率（×100）' } });
  });

  it('境界: number は範囲、text / intent は自由記述として返る（選択肢は出さない）', async () => {
    const { candidates } = await harnessWith([{ id: 'ds-population', name: '人口', csv: REGION_CSV }]);
    const result = await candidates.execute({ scope, templateId: 'custom-computation', dataSourceIds: ['ds-population'] });
    expect(candidateOf(result.candidates, 'limit')).toEqual({ slot: 'limit', kind: 'number', range: { min: 1, max: 100 } });
    expect(candidateOf(result.candidates, 'outputColumn')).toEqual({ slot: 'outputColumn', kind: 'text', freeText: true });
    expect(candidateOf(result.candidates, 'computationIntent')).toEqual({ slot: 'computationIntent', kind: 'intent', freeText: true });
  });

  it('異常: 知らないテンプレート id は、使える id を挙げて not found', async () => {
    const { candidates } = await singleSource();
    await expect(candidates.execute({ scope, templateId: 'no-such-template', dataSourceIds: ['ds-population'] }))
      .rejects.toThrow(ToolTemplateNotFoundError);
    await expect(candidates.execute({ scope, templateId: 'no-such-template', dataSourceIds: ['ds-population'] }))
      .rejects.toThrow(/period-series/);
  });

  it('異常: データソースの数がテンプレートの読む数と違えば、いくつ選べばよいかを言って止める', async () => {
    const { candidates } = await twoSources();
    const failure = candidates.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population', 'ds-workers'] });
    await expect(failure).rejects.toThrow(ToolTemplateError);
    await expect(failure).rejects.toThrow(/exactly 1 data source/);
  });
});

describe('InstantiateToolTemplateUseCase', () => {
  const seriesValues = { source: 'ds-population', periodColumn: '時点', valueColumns: ['人口'], categoryColumn: '地域', defaultGranularity: 'year', limit: 12 };

  it('正常: 実体化したグラフ・引数スキーマ・Agent Tool 契約を返す（保存はしない）', async () => {
    const { instantiate } = await singleSource();
    const result = await instantiate.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'], values: seriesValues, language: 'ja', toolName: 'population_series' });
    expect(result.template).toEqual({ id: 'period-series', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(result.graph.nodes.map((node) => node.type)).toEqual(expect.arrayContaining(['csv-source', 'parse-period', 'filter', 'sort', 'limit', 'agent-output', 'agent-input']));
    expect(result.inputSchema?.columns.map((column) => column.name)).toEqual(['granularity', 'period_from', 'period_to', 'categories']);
    expect(result.agentTool.description).toContain('人口');
    expect(result.pendingExpressions).toEqual([]);
  });

  it('正常: 渡した toolName が agentTool.name に入る', async () => {
    const { instantiate } = await singleSource();
    const named = await instantiate.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'], values: seriesValues, language: 'ja', toolName: 'population_series' });
    expect(named.agentTool.name).toBe('population_series');
  });

  it('正常: 説明文の言語は language に従う', async () => {
    const { instantiate } = await singleSource();
    const english = await instantiate.execute({ scope, templateId: 'period-series', dataSourceIds: ['ds-population'], values: seriesValues, language: 'en', toolName: 'population_series' });
    expect(english.agentTool.description).toContain('Returns the series of');
  });

  it('正常: 任意スロットを空にすると、そのノードと引数が消えて前後が繋がる', async () => {
    const { instantiate } = await singleSource();
    const result = await instantiate.execute({
      scope, templateId: 'period-series', dataSourceIds: ['ds-population'],
      values: { ...seriesValues, categoryColumn: undefined }, language: 'ja', toolName: 'population_series',
    });
    expect(result.inputSchema?.columns.map((column) => column.name)).not.toContain('categories');
    expect(result.graph.nodes.map((node) => node.id)).not.toContain('f_category');
  });

  it('正常: 式を AI に書かせるテンプレートは、式が空のまま pendingExpressions つきで返る', async () => {
    const { instantiate } = await singleSource();
    const result = await instantiate.execute({
      scope, templateId: 'custom-computation', dataSourceIds: ['ds-population'],
      values: { source: 'ds-population', periodColumn: '時点', valueColumns: ['人口'], outputColumn: '一人当たり', computationIntent: '人口を千で割る', defaultGranularity: 'year', limit: 12 },
      language: 'ja', toolName: 'population_per_capita',
    });
    expect(result.pendingExpressions).toEqual([{ nodeId: 'calc', intent: '人口を千で割る' }]);
    expect(result.graph.nodes.find((node) => node.id === 'calc')?.config).toMatchObject({ expression: '' });
  });

  it('異常: 選べない列を選んだら、そのスロット名つきの違反で止まる', async () => {
    const { instantiate } = await singleSource();
    const failure = instantiate.execute({
      scope, templateId: 'period-series', dataSourceIds: ['ds-population'],
      values: { ...seriesValues, valueColumns: ['世帯数'] }, language: 'ja', toolName: 'population_series',
    });
    await expect(failure).rejects.toThrow(ToolTemplateSlotsError);
    const error = await slotsErrorOf(failure);
    expect(error.slots).toEqual([{ slot: 'valueColumns', message: expect.stringContaining('世帯数') }]);
    expect(error.slots[0]?.message).toContain('choose one of');
  });

  it('異常: 必須スロットが空なら、そのスロットへ「何を選べばよいか」を返す', async () => {
    const { instantiate } = await singleSource();
    const error = await slotsErrorOf(instantiate.execute({
      scope, templateId: 'period-series', dataSourceIds: ['ds-population'],
      values: { source: 'ds-population', valueColumns: ['人口'], defaultGranularity: 'year' }, language: 'ja', toolName: 'population_series',
    }));
    expect(error.slots.map((problem) => problem.slot)).toContain('periodColumn');
  });

  it('異常: 違反は 1 度に全部返す（1 つ直すたびに往復させない）', async () => {
    const { instantiate } = await singleSource();
    const error = await slotsErrorOf(instantiate.execute({
      scope, templateId: 'period-series', dataSourceIds: ['ds-population'],
      values: { source: 'ds-population', periodColumn: '人口', valueColumns: ['地域'], defaultGranularity: 'year' }, language: 'ja', toolName: 'population_series',
    }));
    expect(error.slots.map((problem) => problem.slot)).toEqual(expect.arrayContaining(['periodColumn', 'valueColumns']));
  });

  it('例外: 知らないテンプレート id は not found（実体化の前に止める）', async () => {
    const { instantiate } = await singleSource();
    await expect(instantiate.execute({ scope, templateId: 'nope', dataSourceIds: ['ds-population'], values: {}, language: 'ja', toolName: 'population_series' }))
      .rejects.toThrow(ToolTemplateNotFoundError);
  });

  it('例外: ソース数が足りなければ、いくつ選べばよいかを言って止める', async () => {
    const { instantiate } = await twoSources();
    await expect(instantiate.execute({ scope, templateId: 'ratio-of-two-sources', dataSourceIds: ['ds-population'], values: {}, language: 'ja', toolName: 'ratio_tool' }))
      .rejects.toThrow(/exactly 2 data source/);
  });
});

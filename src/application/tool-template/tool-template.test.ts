import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { NodeRegistry } from '../../domain/etl/registry';
import type { InstantiatedTemplate } from '../../domain/tool-template/instantiate';
import { parseToolTemplate, type ToolTemplate } from '../../domain/tool-template/template';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { ProfileDataSourcesUseCase, type DataProfile } from '../factory/profile-data-sources';
import { checkTemplateAgainstRegistry } from './check-template';
import { templateContextOf } from './template-context';
import { validateInstantiatedTemplate } from './validate-instantiated';

const scope = { tenantId: 't', workspaceId: 'w' };

const REGION_CSV = [
  '時点,地域コード,地域,人口,注記',
  '2023年,01000,北海道,5200,',
  '2023年,13000,東京都,14000,',
  '2022年,01000,北海道,5250,',
  '2022年,13000,東京都,13900,',
  '2023年5月,13000,東京都,13950,速報',
].join('\n');

const OTHER_CSV = [
  '時点,地域コード,地域,就業者数,注記',
  '2023年,01000,北海道,2500,',
  '2023年,13000,東京都,7000,',
  '2022年,01000,北海道,2480,',
  '2022年,13000,東京都,6950,',
].join('\n');

async function profilesOf(sources: readonly { readonly id: string; readonly csv: string }[]): Promise<{ profiles: DataProfile[]; engine: EtlEngine; resolver: ResolveDataSourceGraphUseCase }> {
  const dataSources = new InMemoryDataSourceRepository();
  for (const source of sources) {
    await dataSources.save(
      { id: source.id, tenant: scope, name: source.id, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: source.csv.length, createdAt: '', updatedAt: '' },
      source.csv,
    );
  }
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  return { profiles: await profiler.executeAll(scope, sources.map((source) => source.id)), engine, resolver };
}

describe('templateContextOf', () => {
  it('正常: プロファイルから列・期間列（実測範囲つき）・カテゴリ列・形式を写す', async () => {
    const { profiles } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const context = templateContextOf({ dataSourceIds: ['ds-a'] }, profiles);
    const source = context.sources[0]!;
    expect(source.format).toBe('csv');
    expect(source.columns.map((column) => column.name)).toEqual(['時点', '地域コード', '地域', '人口', '注記']);
    expect(source.periodColumns[0]).toMatchObject({ column: '時点', minStart: '2022-01-01', maxStart: '2023-05-01' });
    expect(source.periodColumns[0]?.granularities).toEqual(expect.arrayContaining(['year', 'month']));
    expect(source.categoricalColumns.map((column) => column.column)).toContain('地域');
  });

  it('正常: このツールが読むソース同士の結合候補だけを持ち込む', async () => {
    const { profiles } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }, { id: 'ds-b', csv: OTHER_CSV }]);
    const both = templateContextOf({ dataSourceIds: ['ds-a', 'ds-b'] }, profiles);
    expect(both.joinCandidates).toHaveLength(1);
    expect(both.joinCandidates[0]?.keys).toEqual(expect.arrayContaining(['時点', '地域コード', '地域']));

    const single = templateContextOf({ dataSourceIds: ['ds-a'] }, profiles);
    expect(single.joinCandidates).toEqual([]);
  });

  it('正常: ソースの順は計画の並び（主 → 追加）のまま', async () => {
    const { profiles } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }, { id: 'ds-b', csv: OTHER_CSV }]);
    expect(templateContextOf({ dataSourceIds: ['ds-b', 'ds-a'] }, profiles).sources.map((source) => source.dataSourceId)).toEqual(['ds-b', 'ds-a']);
  });

  it('異常: プロファイルの無い dataSourceId は落とす（候補 0 件 = 適用不可になる）', async () => {
    const { profiles } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    expect(templateContextOf({ dataSourceIds: ['ds-a', 'ds-missing'] }, profiles).sources).toHaveLength(1);
  });
});

function templateWith(nodes: readonly unknown[], edges: readonly unknown[]): ToolTemplate {
  const parsed = parseToolTemplate({
    formatVersion: 1,
    id: 'check-me',
    version: '1.0.0',
    title: { ja: 'a', en: 'a' },
    summary: { ja: 'a', en: 'a' },
    whenToUse: { ja: ['a'], en: ['a'] },
    tags: [],
    sources: { min: 1, max: 1 },
    slots: [{ name: 'source', kind: 'dataSource', label: { ja: 'a', en: 'a' } }],
    arguments: [],
    nodes,
    edges,
    description: { ja: 'a', en: 'a' },
  });
  if (!parsed.ok) throw new Error(`fixture is invalid: ${parsed.problems.join(' / ')}`);
  return parsed.template;
}

describe('checkTemplateAgainstRegistry', () => {
  const registry = createDefaultRegistry();

  it('正常: 登録済みのノード種別だけを使うテンプレートは問題なし', () => {
    const template = templateWith(
      [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      [{ from: 'src', to: 'out' }],
    );
    expect(checkTemplateAgainstRegistry(template, registry)).toEqual([]);
  });

  it('正常: 一括 ToolSmith の許可リストに無い種別（calculate・分析ノード）も使ってよい', () => {
    const template = templateWith(
      [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'calc', type: 'calculate', config: { outputColumn: 'x', expression: '1 + 1' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      [{ from: 'src', to: 'calc' }, { from: 'calc', to: 'out' }],
    );
    expect(checkTemplateAgainstRegistry(template, registry)).toEqual([]);
  });

  it('異常: 登録されていないノード種別は、使える種別を挙げて差し戻す', () => {
    const template = templateWith(
      [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'weird', type: 'teleport', config: {} },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      [{ from: 'src', to: 'weird' }, { from: 'weird', to: 'out' }],
    );
    const problems = checkTemplateAgainstRegistry(template, registry);
    expect(problems[0]).toContain("node 'weird' has type 'teleport'");
    expect(problems[0]).toContain('use one of');
  });

  it('異常: agent-output 以外の sink は置けない（外へ書き出す終端を持ち込ませない）', () => {
    const sinkType = registry.types().find((type) => type !== 'agent-output' && registry.get(type).kind === 'sink');
    expect(sinkType, 'this build registers no other sink to test against').toBeDefined();
    const template = templateWith(
      [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'other', type: sinkType, config: {} },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      [{ from: 'src', to: 'other' }, { from: 'other', to: 'out' }],
    );
    expect(checkTemplateAgainstRegistry(template, registry).join('\n')).toContain('writes somewhere outside the tool');
  });

  it('例外: source ノードの種別が登録されていないビルドでは、固定の type を書くよう言う', () => {
    const empty = new NodeRegistry();
    const template = templateWith(
      [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      [{ from: 'src', to: 'out' }],
    );
    expect(checkTemplateAgainstRegistry(template, empty).join('\n')).toContain('csv-source and json-source is not registered');
  });
});

describe('validateInstantiatedTemplate', () => {
  function instantiatedWith(overrides: Partial<InstantiatedTemplate> = {}): InstantiatedTemplate {
    return {
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-a' } },
          { id: 'sel', type: 'select', config: { columns: ['人口'] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
      },
      agentTool: { name: 'check', description: 'x' },
      pendingExpressions: [],
      columnSlots: { 人口: 'valueColumn' },
      ...overrides,
    };
  }

  it('正常: 実データで伝播とプレビューを通れば問題なし', async () => {
    const { engine, resolver } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    expect(await validateInstantiatedTemplate(engine, instantiatedWith(), (graph) => resolver.execute(scope, graph))).toEqual([]);
  });

  it('異常: 無い列を参照していたら、その列を選んだスロットへ問題を戻す', async () => {
    const { engine, resolver } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const broken = instantiatedWith({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-a' } },
          { id: 'sel', type: 'select', config: { columns: ['世帯数'] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
      },
      columnSlots: { 世帯数: 'valueColumn' },
    });
    const problems = await validateInstantiatedTemplate(engine, broken, (graph) => resolver.execute(scope, graph));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.slot).toBe('valueColumn');
    expect(problems[0]?.message).toContain('column not found: 世帯数');
  });

  it('異常: 式が空の calculate（$intent 待ち）は、式を入れてから検証するよう言う', async () => {
    const { engine, resolver } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const pending = instantiatedWith({ pendingExpressions: [{ nodeId: 'calc', intent: '人口を 2 倍にする' }] });
    const problems = await validateInstantiatedTemplate(engine, pending, (graph) => resolver.execute(scope, graph));
    expect(problems[0]?.message).toContain('人口を 2 倍にする');
    expect(problems[0]?.message).toContain('write the formula into it');
  });

  it('異常: グラフの形が壊れていれば、ノードとエッジを直すよう言う', async () => {
    const { engine, resolver } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const broken = instantiatedWith({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-a' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [],
      },
    });
    const problems = await validateInstantiatedTemplate(engine, broken, (graph) => resolver.execute(scope, graph));
    expect(problems[0]?.message).toContain("fix the template's nodes and edges");
  });

  it('例外: データソースを読めなければ、存在と形式を確かめるよう言う（throw しない）', async () => {
    const { engine, resolver } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const missing = instantiatedWith({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-gone' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'out' }],
      },
    });
    const problems = await validateInstantiatedTemplate(engine, missing, (graph) => resolver.execute(scope, graph));
    expect(problems[0]?.message).toContain('cannot be read');
  });

  it('正常: resolveGraph を渡さなければ、既に展開済みのグラフとして扱う', async () => {
    const { engine } = await profilesOf([{ id: 'ds-a', csv: REGION_CSV }]);
    const inline = instantiatedWith({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { text: REGION_CSV } },
          { id: 'sel', type: 'select', config: { columns: ['人口'] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
      },
    });
    expect(await validateInstantiatedTemplate(engine, inline)).toEqual([]);
  });
});

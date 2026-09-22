import { describe, expect, it } from 'vitest';
import type { ToolGraph } from '../../domain/etl/graph';
import { canonicalNodeType, hasJoinKeyResolutionError, normalizeArgumentTypes, normalizeProposedGraph, sampleValuesFor, withSwappedJoinPorts } from './normalize-tool-graph';
import type { DataProfile } from './profile-data-sources';
import type { PropagationResult } from '../etl/engine';

/** 列挙済みの地域値を持つ主ソース（`in` の設計時サンプルの出どころ）。 */
const wageProfile: DataProfile = {
  dataSourceId: 'ds-wage', name: 'Wage', kind: 'file', format: 'csv',
  columns: [{ name: '時点', type: 'string', nullable: false }, { name: '地域', type: 'string', nullable: false }, { name: '賃金', type: 'number', nullable: true }],
  sampleRowCount: 1, sampleRows: [{ 時点: '2023年', 地域: '東京都', 賃金: 390000 }], rowCount: 4,
  periodColumns: [], categoricalColumns: [{ column: '地域', distinctCount: 3, values: ['北海道', '東京都', '大阪府'] }],
  joinCandidates: [],
};
const hoursProfile: DataProfile = {
  ...wageProfile, dataSourceId: 'ds-hours', name: 'Hours',
  columns: [{ name: '時点', type: 'string', nullable: false }, { name: '地域', type: 'string', nullable: false }, { name: '労働時間', type: 'number', nullable: true }],
  sampleRows: [{ 時点: '2023年', 地域: '東京都', 労働時間: 141 }], categoricalColumns: [],
};
const context = { primaryDataSourceId: 'ds-wage', profiles: [wageProfile, hoursProfile] };

/** 2ソースが join で合流するグラフ。`toInput` の書かれ方だけを差し替えられる。 */
function joinGraph(toInputs: readonly (number | undefined)[]): ToolGraph {
  return {
    nodes: [
      { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
      { id: 'hours', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
      { id: 'j', type: 'join', config: { mode: 'inner', keys: [{ left: '時点', right: '時点' }] } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [
      { from: 'wage', to: 'j', ...(toInputs[0] === undefined ? {} : { toInput: toInputs[0] }) },
      { from: 'hours', to: 'j', ...(toInputs[1] === undefined ? {} : { toInput: toInputs[1] }) },
      { from: 'j', to: 'out' },
    ],
  } as ToolGraph;
}

function filterGraph(config: unknown): ToolGraph {
  return {
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
      { id: 'f', type: 'filter', config },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [{ from: 'src', to: 'f' }, { from: 'f', to: 'out' }],
  } as ToolGraph;
}

/** 正規化後の filter ノードの config を取り出す。 */
function filterConfigOf(graph: ToolGraph): Record<string, unknown> {
  return graph.nodes.find((node) => node.id === 'f')?.config as Record<string, unknown>;
}

describe('normalizeProposedGraph（join のポート推測）', () => {
  it('異常: 片方のエッジに toInput が無ければ、残っているポートの反対を入れる（実測: [null, 1]）', () => {
    const result = normalizeProposedGraph(joinGraph([undefined, 1]), context);

    expect(result.graph.edges.filter((edge) => edge.to === 'j').map((edge) => edge.toInput)).toEqual([0, 1]);
    expect(result.changes[0]).toMatch(/join 'j': set "toInput": 0 on the edge from 'wage' \(it was null\)/);
  });

  it('異常: 両方に toInput が無ければ、主データソースの枝を左（0）に置く', () => {
    const result = normalizeProposedGraph(joinGraph([undefined, undefined]), context);

    const ports = new Map(result.graph.edges.filter((edge) => edge.to === 'j').map((edge) => [edge.from, edge.toInput] as const));
    expect(ports.get('wage')).toBe(0);
    expect(ports.get('hours')).toBe(1);
  });

  it('異常: 主データソースが右側に書かれていても、その枝を左（0）へ寄せる', () => {
    const reversed = normalizeProposedGraph({ ...joinGraph([undefined, undefined]), edges: [
      { from: 'hours', to: 'j' }, { from: 'wage', to: 'j' }, { from: 'j', to: 'out' },
    ] } as ToolGraph, context);

    const ports = new Map(reversed.graph.edges.filter((edge) => edge.to === 'j').map((edge) => [edge.from, edge.toInput] as const));
    expect(ports.get('wage')).toBe(0);
    expect(ports.get('hours')).toBe(1);
  });

  it('異常: 2本が同じポートを持っていたら2本目を空いている側へ直す', () => {
    const result = normalizeProposedGraph(joinGraph([0, 0]), context);

    expect(result.graph.edges.filter((edge) => edge.to === 'j').map((edge) => edge.toInput)).toEqual([0, 1]);
    expect(result.changes.join(' ')).toMatch(/set "toInput": 1 on the edge from 'hours' \(it was 0\)/);
  });

  it('正常(回帰固定): 0/1 が正しく書かれていれば従来どおり触らない（左右の意味を勝手に変えない）', () => {
    const graph = joinGraph([1, 0]);
    const result = normalizeProposedGraph(graph, context);

    expect(result.graph).toBe(graph);
    expect(result.changes).toEqual([]);
  });

  it('境界: 入力が2本でない join は構造検査に委ねて触らない', () => {
    const single = { ...joinGraph([undefined, undefined]), edges: [{ from: 'wage', to: 'j' }, { from: 'j', to: 'out' }] } as ToolGraph;

    expect(normalizeProposedGraph(single, context).changes).toEqual([]);
  });

  it('境界: 二度掛けても結果が変わらない（冪等）', () => {
    const once = normalizeProposedGraph(joinGraph([undefined, undefined]), context);
    const twice = normalizeProposedGraph(once.graph, context);

    expect(twice.graph).toEqual(once.graph);
    expect(twice.changes).toEqual([]);
  });
});

describe('withSwappedJoinPorts / hasJoinKeyResolutionError（推測が逆だったときの救済）', () => {
  it('正常: join の左右を入れ替えたグラフを返す', () => {
    const swapped = withSwappedJoinPorts(normalizeProposedGraph(joinGraph([undefined, undefined]), context).graph);

    const ports = new Map((swapped?.edges ?? []).filter((edge) => edge.to === 'j').map((edge) => [edge.from, edge.toInput] as const));
    expect(ports.get('wage')).toBe(1);
    expect(ports.get('hours')).toBe(0);
  });

  it('境界: join が無いグラフでは undefined（入れ替えるものが無い）', () => {
    expect(withSwappedJoinPorts(filterGraph({ column: '地域', op: 'eq', value: '東京都' }))).toBeUndefined();
  });

  it('正常: キー列が見つからない伝播結果だけを「入れ替えを試す価値あり」と判定する', () => {
    const withIssue = (message: string): PropagationResult => ({
      order: ['j'], terminalId: 'j', hasErrors: true,
      nodes: { j: { nodeId: 'j', schema: { columns: [] }, state: 'mismatch', issues: [{ severity: 'error', message }] } },
    });

    expect(hasJoinKeyResolutionError(withIssue('join: right key column not found: 地域コード'))).toBe(true);
    expect(hasJoinKeyResolutionError(withIssue('join: left key column not found: 時点'))).toBe(true);
    expect(hasJoinKeyResolutionError(withIssue('select: column not found: x'))).toBe(false);
  });
});

describe('normalizeProposedGraph（in / notIn の values）', () => {
  it('異常: values が無く value に文字列があれば、実行時と同じ区切りで values へ移す', () => {
    const result = normalizeProposedGraph(filterGraph({ column: '地域', op: 'in', value: '東京都、大阪府, 北海道' }), context);

    expect(filterConfigOf(result.graph)['values']).toEqual(['東京都', '大阪府', '北海道']);
    expect(result.changes[0]).toMatch(/moved the 'in' condition value .* into a 'values' list/);
  });

  it('異常: value が配列なら、そのまま values へ移す', () => {
    const result = normalizeProposedGraph(filterGraph({ column: '地域', op: 'notIn', value: ['東京都', '大阪府'] }), context);

    expect(filterConfigOf(result.graph)['values']).toEqual(['東京都', '大阪府']);
  });

  it('異常: 引数バインドされた in 条件に値が無ければ、プロファイルの実在値を最大2件だけ種にする', () => {
    const result = normalizeProposedGraph(
      filterGraph({ column: '地域', op: 'in', valueBinding: { source: 'agent-input', field: 'regions' } }),
      context,
    );

    expect(filterConfigOf(result.graph)['values']).toEqual(['北海道', '東京都']);
    expect(result.changes[0]).toMatch(/seeded the bound 'in' condition on '地域' with real sample values/);
  });

  it('異常: 列挙値が無ければサンプル行から拾う（値は決して作らない）', () => {
    const noCategorical = { ...context, profiles: [hoursProfile] };
    const seeded = normalizeProposedGraph(filterGraph({ column: '地域', op: 'in', valueBinding: { source: 'agent-input', field: 'r' } }), noCategorical);
    expect(filterConfigOf(seeded.graph)['values']).toEqual(['東京都']);

    const unknownColumn = normalizeProposedGraph(filterGraph({ column: '未知の列', op: 'in', valueBinding: { source: 'agent-input', field: 'r' } }), noCategorical);
    expect(filterConfigOf(unknownColumn.graph)['values']).toBeUndefined();
    // 値は作らない。記録されるのは（バインドがあるのに宣言が無いので）agent-input の合成だけ。
    expect(unknownColumn.changes.filter((change) => change.includes('seeded'))).toEqual([]);
  });

  it('異常: 引数バインドされた eq 条件の value が空なら、実在値の先頭 1 件を種にする（実測: 設計アシスタントが value "" を置き、画面のプレビューが 0 行になった）', () => {
    const result = normalizeProposedGraph(
      filterGraph({ column: '地域', op: 'eq', value: '', valueBinding: { source: 'agent-input', field: 'region' } }),
      context,
    );

    expect(filterConfigOf(result.graph)['value']).toBe('北海道');
    expect(result.changes[0]).toMatch(/seeded the bound 'eq' condition on '地域' with the real sample value "北海道"/);
  });

  it('従来どおり: バインドされた eq 条件に value が入っていれば触らない。バインドの無い eq の空 value にも値を作らない', () => {
    const kept = normalizeProposedGraph(filterGraph({ column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'region' } }), context);
    expect(filterConfigOf(kept.graph)['value']).toBe('東京都');
    expect(kept.changes.filter((change) => change.includes('seeded'))).toEqual([]);

    const unbound = normalizeProposedGraph(filterGraph({ column: '地域', op: 'eq', value: '' }), context);
    expect(filterConfigOf(unbound.graph)['value']).toBe('');
  });

  it('異常: parse-period が足す periodStart への束縛条件（gte / lte）は、プロファイルの期間の範囲を種にする（実測: 日付引数のツールでプレビューが 0 行）', () => {
    const withPeriods = { ...context, profiles: [{ ...wageProfile, periodColumns: [{ column: '時点', granularities: { year: 4 }, minStart: '2020-01-01', maxStart: '2023-01-01', mixed: false }] }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
        { id: 'period', type: 'parse-period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity' } },
        { id: 'range', type: 'filter', config: { combine: 'and', conditions: [
          { column: 'periodStart', op: 'gte', valueBinding: { source: 'agent-input', field: 'period_from' } },
          { column: 'periodStart', op: 'lte', valueBinding: { source: 'agent-input', field: 'period_to' } },
        ] } },
      ],
      edges: [{ from: 'src', to: 'period' }, { from: 'period', to: 'range' }],
    } as unknown as ToolGraph;
    const result = normalizeProposedGraph(graph, withPeriods);
    const conditions = (result.graph.nodes.find((node) => node.id === 'range')?.config as { conditions: { value?: unknown }[] }).conditions;
    expect(conditions[0]?.value).toBe('2020-01-01');
    expect(conditions[1]?.value).toBe('2023-01-01');
    expect(result.changes.join(' ')).toContain("earliest period start 2020-01-01");
    expect(result.changes.join(' ')).toContain("latest period start 2023-01-01");
  });

  it('従来どおり: periodStart への束縛でも、プロファイルに期間の範囲が無ければ何も置かない。parse-period の無いグラフでは periodStart を特別扱いしない（値は発明しない）', () => {
    const graph = (withPeriod: boolean): ToolGraph => ({
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
        ...(withPeriod ? [{ id: 'period', type: 'parse-period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity' } }] : []),
        { id: 'range', type: 'filter', config: { column: 'periodStart', op: 'gte', valueBinding: { source: 'agent-input', field: 'from' } } },
      ],
      edges: [],
    } as unknown as ToolGraph);
    const noRange = normalizeProposedGraph(graph(true), context);
    expect((noRange.graph.nodes.find((node) => node.id === 'range')?.config as { value?: unknown }).value).toBeUndefined();
    const noParse = normalizeProposedGraph(graph(false), { ...context, profiles: [{ ...wageProfile, periodColumns: [{ column: '時点', granularities: { year: 4 }, minStart: '2020-01-01', maxStart: '2023-01-01', mixed: false }] }] });
    expect((noParse.graph.nodes.find((node) => node.id === 'range')?.config as { value?: unknown }).value).toBeUndefined();
  });

  it('異常: valueBinding / opBinding の source の綴り違い（agent_input など）は agent-input に直す（実測: 差し戻し 1 回を使っていた）', () => {
    const result = normalizeProposedGraph(
      filterGraph({ column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent_input', field: 'region' }, opBinding: { source: 'input', field: 'cmp', allowed: ['eq'] } }),
      context,
    );
    const config = filterConfigOf(result.graph);
    expect(config['valueBinding']).toEqual({ source: 'agent-input', field: 'region' });
    expect(config['opBinding']).toEqual({ source: 'agent-input', field: 'cmp', allowed: ['eq'] });
    expect(result.changes.join(' ')).toContain("rewrote valueBinding.source \"agent_input\" as 'agent-input'");
  });

  it('従来どおり: field の無い束縛や、既に agent-input の束縛には触らない', () => {
    const untouched = normalizeProposedGraph(filterGraph({ column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'region' } }), context);
    expect(untouched.changes.filter((change) => change.includes('rewrote valueBinding'))).toEqual([]);
    const noField = normalizeProposedGraph(filterGraph({ column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'input' } }), context);
    expect(filterConfigOf(noField.graph)['valueBinding']).toEqual({ source: 'input' });
  });

  it('従来どおり: isNull / notNull の束縛条件と、実在値が分からない列には何も置かない（種を置くのは単一値の束縛条件だけ）', () => {
    const valueless = normalizeProposedGraph(filterGraph({ column: '地域', op: 'isNull', valueBinding: { source: 'agent-input', field: 'r' } }), context);
    expect(filterConfigOf(valueless.graph)['value']).toBeUndefined();

    const unknown = normalizeProposedGraph(filterGraph({ column: '未知の列', op: 'eq', value: '', valueBinding: { source: 'agent-input', field: 'r' } }), context);
    expect(filterConfigOf(unknown.graph)['value']).toBe('');
  });

  it('境界: バインドされていない静的な in 条件には値を作らない（修復ループへ委ねる）', () => {
    const result = normalizeProposedGraph(filterGraph({ column: '地域', op: 'in' }), context);

    expect(filterConfigOf(result.graph)['values']).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it('正常(回帰固定): values が既にあれば従来どおり触らない', () => {
    const graph = filterGraph({ column: '地域', op: 'in', values: ['京都府'] });

    expect(normalizeProposedGraph(graph, context).changes).toEqual([]);
    expect(filterConfigOf(normalizeProposedGraph(graph, context).graph)['values']).toEqual(['京都府']);
  });

  it('境界: conditions 配列の中の in 条件も同じ規則で直す', () => {
    const result = normalizeProposedGraph(filterGraph({ conditions: [{ column: '地域', op: 'in', value: '東京都,大阪府' }], combine: 'and' }), context);

    const conditions = filterConfigOf(result.graph)['conditions'] as Record<string, unknown>[];
    expect(conditions[0]?.['values']).toEqual(['東京都', '大阪府']);
  });
});

describe('normalizeProposedGraph（filter config の別名・演算子のゆれ）', () => {
  it('異常: operator / field といった別名キーを正規のキーへ直す', () => {
    const result = normalizeProposedGraph(filterGraph({ field: '地域', operator: 'eq', value: '東京都' }), context);

    expect(filterConfigOf(result.graph)).toMatchObject({ column: '地域', op: 'eq', value: '東京都' });
    expect(result.changes.join(' ')).toMatch(/renamed condition key 'field' to 'column'/);
    expect(result.changes.join(' ')).toMatch(/renamed condition key 'operator' to 'op'/);
  });

  it('異常: 演算子の別表記（=, >=, includes, IN）を正規の演算子へ直す', () => {
    const cases: readonly [unknown, string][] = [['=', 'eq'], ['!=', 'neq'], ['>=', 'gte'], ['<=', 'lte'], ['>', 'gt'], ['<', 'lt'], ['includes', 'contains'], ['IN', 'in'], ['equals', 'eq']];

    for (const [written, expected] of cases) {
      const result = normalizeProposedGraph(filterGraph({ column: '地域', op: written, value: 'x' }), context);
      expect(filterConfigOf(result.graph)['op']).toBe(expected);
    }
  });

  it('異常: 1条件を別名のキーで包んでいたら conditions として読む', () => {
    for (const wrapper of ['condition', 'filters', 'where', 'criteria']) {
      const result = normalizeProposedGraph(filterGraph({ [wrapper]: [{ column: '地域', op: 'eq', value: '東京都' }], combine: 'and' }), context);
      const conditions = filterConfigOf(result.graph)['conditions'] as Record<string, unknown>[];
      expect(conditions?.[0]).toMatchObject({ column: '地域', op: 'eq' });
      expect(result.changes.join(' ')).toContain(`read the '${wrapper}' key as 'conditions'`);
    }
  });

  it('境界: 既に conditions があるときは、別名のキーを conditions として読み替えない', () => {
    const result = normalizeProposedGraph(filterGraph({ conditions: [{ column: '地域', op: 'eq', value: 'x' }], where: 'ignored' }), context);

    expect(filterConfigOf(result.graph)['where']).toBe('ignored');
    expect(result.changes).toEqual([]);
  });

  it('例外: 認識できない崩れ方は触らず、修復ループへ流す', () => {
    const graph = filterGraph({ someUnknownShape: { nested: true } });

    expect(normalizeProposedGraph(graph, context).changes).toEqual([]);
    expect(filterConfigOf(normalizeProposedGraph(graph, context).graph)).toEqual({ someUnknownShape: { nested: true } });
  });

  it('例外: filter 以外のノード・config が非オブジェクトのノードは触らない（意味を変えない）', () => {
    const graph = { ...filterGraph(null), nodes: [{ id: 'sel', type: 'select', config: { columns: ['地域'] } }] } as ToolGraph;

    expect(normalizeProposedGraph(graph, context)).toMatchObject({ graph, changes: [] });
  });
});

describe('sampleValuesFor（値は拾うだけで作らない）', () => {
  it('正常: 列挙済みの値を優先し、無ければサンプル行から拾う', () => {
    expect(sampleValuesFor('地域', [wageProfile])).toEqual(['北海道', '東京都', '大阪府']);
    expect(sampleValuesFor('地域', [hoursProfile])).toEqual(['東京都']);
  });

  it('例外: 列名が空・どこにも無い列は空配列', () => {
    expect(sampleValuesFor('', [wageProfile])).toEqual([]);
    expect(sampleValuesFor('未知の列', [wageProfile, hoursProfile])).toEqual([]);
  });
});

// ─── ADR-0047 第5ラウンド: 試行ごとに違う書き間違い ───────────────────────────────────
describe('canonicalNodeType（ノード種別の綴りゆれ）', () => {
  const known = ['csv-source', 'json-source', 'agent-input', 'agent-output', 'parse-period', 'filter', 'join'];

  it('正常: 下線・空白・camelCase・大文字の違いを正規の種別へ寄せる', () => {
    expect(canonicalNodeType('parse_period', known)).toBe('parse-period');
    expect(canonicalNodeType('parsePeriod', known)).toBe('parse-period');
    expect(canonicalNodeType('Parse-Period', known)).toBe('parse-period');
    expect(canonicalNodeType('csv_source', known)).toBe('csv-source');
    expect(canonicalNodeType('agent_output', known)).toBe('agent-output');
    expect(canonicalNodeType('agentInput', known)).toBe('agent-input');
  });

  it('境界: 既に正規の綴りなら undefined（直すものが無い）', () => {
    expect(canonicalNodeType('parse-period', known)).toBeUndefined();
    expect(canonicalNodeType('filter', known)).toBeUndefined();
  });

  it('異常: 語彙に無い種別・寄せ先が複数ある場合は直さない（推測で別のノードにしない）', () => {
    expect(canonicalNodeType('union', known)).toBeUndefined();
    expect(canonicalNodeType('lookup', known)).toBeUndefined();
    expect(canonicalNodeType('a_b', ['a-b', 'a b'])).toBeUndefined();
  });

  it('正常: 許可語彙の外へは寄せない（寄せた先で構造検査に落ちるだけ）', () => {
    const graph = {
      nodes: [{ id: 'u', type: 'union_all', config: {} }, { id: 'p', type: 'parse_period', config: { column: '時点' } }],
      edges: [],
    } as unknown as ToolGraph;

    const result = normalizeProposedGraph(graph, context);

    expect(result.graph.nodes.map((node) => node.type)).toEqual(['union_all', 'parse-period']);
    expect(result.changes.join(' ')).toContain("rewrote the node type 'parse_period' as 'parse-period'");
  });

  it('境界: 二度掛けても変わらない（冪等）', () => {
    const once = normalizeProposedGraph({ nodes: [{ id: 'p', type: 'parse_period', config: { column: '時点' } }], edges: [] } as unknown as ToolGraph, context);
    expect(normalizeProposedGraph(once.graph, context).changes).toEqual([]);
  });
});

describe('normalizeProposedGraph（source の dataSourceId の欠落・写し間違い）', () => {
  const sourceGraph = (ids: readonly unknown[]): ToolGraph => ({
    nodes: [
      ...ids.map((dataSourceId, index) => ({ id: `s${index}`, type: 'csv-source', config: { dataSourceId } })),
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [],
  } as unknown as ToolGraph);
  const idsOf = (graph: ToolGraph): unknown[] => graph.nodes
    .filter((node) => node.type === 'csv-source')
    .map((node) => (node.config as { dataSourceId?: unknown }).dataSourceId);

  it('異常: 全ソースの id が null なら、計画の並び（主ソース先頭）で埋める（実測 P3 attempt 1）', () => {
    const result = normalizeProposedGraph(sourceGraph([null, null]), context);

    expect(idsOf(result.graph)).toEqual(['ds-wage', 'ds-hours']);
    expect(result.changes.join(' ')).toContain('filled in the missing data source id "ds-wage"');
  });

  it('正常: 単一ソース計画では、欠けている id を常に主ソースで埋める', () => {
    const single = { ...context, profiles: [wageProfile], dataSourceIds: ['ds-wage'] };

    expect(idsOf(normalizeProposedGraph(sourceGraph([undefined]), single).graph)).toEqual(['ds-wage']);
  });

  it('境界: 一部だけ正しく書かれていれば、残りの計画idを残りのノードへ埋める', () => {
    const result = normalizeProposedGraph(sourceGraph(['ds-hours', null]), context);

    expect(idsOf(result.graph)).toEqual(['ds-hours', 'ds-wage']);
  });

  it('異常: 計画idの ≤3 編集距離の写し間違いは直す（Planner と同じ規則）', () => {
    const result = normalizeProposedGraph(sourceGraph(['ds-wag', 'ds-hours']), context);

    expect(idsOf(result.graph)).toEqual(['ds-wage', 'ds-hours']);
    expect(result.changes.join(' ')).toContain('corrected the data source id "ds-wag" to "ds-wage"');
  });

  it('例外: 写し間違いとも言えない別idは上書きしない（別の表を勝手に読ませない）', () => {
    const result = normalizeProposedGraph(sourceGraph(['totally-different-source', null]), context);

    expect(idsOf(result.graph)).toEqual(['totally-different-source', null]);
    expect(result.changes).toEqual([]);
  });

  it('境界: source の数が計画のソース数と合わなければ埋めない（どのノードがどれか決まらない）', () => {
    const result = normalizeProposedGraph(sourceGraph([null, null, null]), context);

    expect(idsOf(result.graph)).toEqual([null, null, null]);
    expect(result.changes).toEqual([]);
  });

  it('正常(回帰固定): 正しく書かれていれば従来どおり触らない', () => {
    const graph = sourceGraph(['ds-wage', 'ds-hours']);

    expect(normalizeProposedGraph(graph, context).changes).toEqual([]);
  });
});

describe('normalizeProposedGraph（agent-input の形と合成）', () => {
  const argsNode = (config: unknown): ToolGraph => ({
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
      { id: 'args', type: 'agent-input', config },
    ],
    edges: [],
  } as unknown as ToolGraph);
  const configOf = (graph: ToolGraph, id = 'args'): Record<string, unknown> =>
    graph.nodes.find((node) => node.id === id)?.config as Record<string, unknown>;

  it('異常: schema の中に書かれた sample を外へ出す（実測 P2 attempt 2）', () => {
    const columns = [{ name: 'region', type: 'string', nullable: true }];
    const result = normalizeProposedGraph(argsNode({ schema: { columns, sample: { region: '東京都' } } }), context);

    expect(configOf(result.graph)['sample']).toEqual({ region: '東京都' });
    expect(configOf(result.graph)['schema']).toEqual({ columns });
    expect(result.changes.join(' ')).toContain("moved 'sample' out of 'schema'");
  });

  it('異常: sample が丸ごと無ければ空オブジェクトを置く（全引数が省略可能なので有効）', () => {
    const result = normalizeProposedGraph(argsNode({ schema: { columns: [{ name: 'region', type: 'string', nullable: true }] } }), context);

    expect(configOf(result.graph)['sample']).toEqual({});
    expect(result.changes.join(' ')).toContain("added the missing 'sample' object");
  });

  it('異常: バインドがあるのに宣言ノードが無ければ、バインドから合成する（実測 P2 attempt 1）', () => {
    const graph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
        { id: 'f', type: 'filter', config: { conditions: [
          { column: '地域', op: 'in', values: ['東京都', '大阪府'], valueBinding: { source: 'agent-input', field: 'regions' } },
          { column: '賃金', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'min_wage' } },
          { column: '賃金', op: 'gte', value: 100, opBinding: { source: 'agent-input', field: 'wage_op', allowed: ['gte', 'lte'] } },
        ] } },
      ],
      edges: [{ from: 'src', to: 'f' }],
    } as unknown as ToolGraph;

    const result = normalizeProposedGraph(graph, context);

    const declaration = result.graph.nodes.find((node) => node.type === 'agent-input');
    expect((declaration?.config as { schema: { columns: unknown[] } }).schema.columns).toEqual([
      // `in` の引数はカンマ区切りの文字列、opBinding も文字列、それ以外は列型から。
      { name: 'regions', type: 'string', nullable: true },
      { name: 'min_wage', type: 'number', nullable: true },
      { name: 'wage_op', type: 'string', nullable: true },
    ]);
    expect((declaration?.config as { sample: Record<string, unknown> }).sample).toEqual({ regions: '東京都,大阪府', min_wage: 100 });
    expect(result.changes.join(' ')).toMatch(/added the missing 'agent-input' node/);
  });

  it('境界: 宣言ノードが既にあれば合成しない。バインドが無ければ何もしない', () => {
    const withDeclaration = normalizeProposedGraph(argsNode({ schema: { columns: [] }, sample: {} }), context);
    expect(withDeclaration.graph.nodes.filter((node) => node.type === 'agent-input')).toHaveLength(1);

    const noBindings = normalizeProposedGraph({
      nodes: [{ id: 'f', type: 'filter', config: { column: '地域', op: 'eq', value: '東京都' } }], edges: [],
    } as unknown as ToolGraph, context);
    expect(noBindings.graph.nodes.some((node) => node.type === 'agent-input')).toBe(false);
  });

  it('境界: 合成した宣言ノードのidは既存と衝突しない', () => {
    const graph = {
      nodes: [
        { id: 'args', type: 'select', config: { columns: ['地域'] } },
        { id: 'f', type: 'filter', config: { column: '地域', op: 'eq', value: 'x', valueBinding: { source: 'agent-input', field: 'region' } } },
      ],
      edges: [],
    } as unknown as ToolGraph;

    const result = normalizeProposedGraph(graph, context);

    expect(result.graph.nodes.find((node) => node.type === 'agent-input')?.id).toBe('args-2');
  });

  it('境界: 二度掛けても宣言は1つのまま（冪等）', () => {
    const graph = {
      nodes: [{ id: 'f', type: 'filter', config: { column: '地域', op: 'eq', value: 'x', valueBinding: { source: 'agent-input', field: 'region' } } }],
      edges: [],
    } as unknown as ToolGraph;
    const once = normalizeProposedGraph(graph, context);

    const twice = normalizeProposedGraph(once.graph, context);
    expect(twice.graph.nodes.filter((node) => node.type === 'agent-input')).toHaveLength(1);
    expect(twice.changes).toEqual([]);
  });
});

describe('normalizeProposedGraph（agent-output の書き忘れた必須項目）', () => {
  const outGraph = (config: unknown): ToolGraph => ({
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-wage' } },
      { id: 'out', type: 'agent-output', config },
    ],
    edges: [{ from: 'src', to: 'out' }],
  } as unknown as ToolGraph);
  const outConfig = (graph: ToolGraph): Record<string, unknown> => graph.nodes.find((node) => node.id === 'out')?.config as Record<string, unknown>;

  it('異常: maxRows / maxBytes / overflow を書き忘れた agent-output は既定で埋める（実測: 設計アシスタントが毎回 1 回目で落ちていた）', () => {
    const result = normalizeProposedGraph(outGraph({ shape: 'rows', format: 'json' }), context);

    expect(outConfig(result.graph)).toEqual({ shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' });
    expect(result.changes.join(' ')).toContain("agent-output 'out': filled the missing maxRows, maxBytes, overflow");
  });

  it('従来どおり: 書いてある項目は変えない（maxRows 10 はそのまま）。全部揃っていれば changes に何も残さない', () => {
    const partial = normalizeProposedGraph(outGraph({ shape: 'rows', format: 'json', maxRows: 10 }), context);
    expect(outConfig(partial.graph)['maxRows']).toBe(10);
    expect(outConfig(partial.graph)['overflow']).toBe('error');

    const full = { shape: 'summary', format: 'markdown-table', maxRows: 5, maxBytes: 2048, overflow: 'store-and-reference' };
    const complete = normalizeProposedGraph(outGraph(full), context);
    expect(outConfig(complete.graph)).toEqual(full);
    expect(complete.changes.filter((change) => change.includes('agent-output'))).toEqual([]);
  });

  it('境界: config が無い agent-output も既定 5 項目で埋める', () => {
    const result = normalizeProposedGraph(outGraph(undefined), context);
    expect(outConfig(result.graph)).toEqual({ shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' });
  });
});

describe('normalizeArgumentTypes（伝播後の列型で引数の宣言型を直す）', () => {
  /** periodStart(date) / 賃金(number) / 地域(string) を持つ伝播結果。 */
  function propagationWith(): PropagationResult {
    const schema = { columns: [
      { name: '地域', type: 'string' as const, nullable: false },
      { name: '賃金', type: 'number' as const, nullable: true },
      { name: 'periodStart', type: 'date' as const, nullable: true },
    ] };
    return {
      order: ['f', 'out'], terminalId: 'out', hasErrors: false,
      nodes: {
        f: { nodeId: 'f', schema, state: 'confirmed', issues: [] },
        out: { nodeId: 'out', schema, state: 'confirmed', issues: [] },
      },
    };
  }
  function graphWith(conditions: readonly unknown[], columns: readonly unknown[]): ToolGraph {
    return {
      nodes: [
        { id: 'f', type: 'filter', config: { conditions, combine: 'and' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns }, sample: {} } },
      ],
      edges: [],
    } as unknown as ToolGraph;
  }
  const declaredColumns = (graph: ToolGraph): unknown =>
    (graph.nodes.find((node) => node.type === 'agent-input')?.config as { schema: { columns: unknown } }).schema.columns;

  it('異常: date 列の gte/lte にバインドした引数を date 型へ直す（実測 P3 attempt 3）', () => {
    const changes: string[] = [];
    const graph = graphWith(
      [
        { column: 'periodStart', op: 'gte', value: '2020-01-01', valueBinding: { source: 'agent-input', field: 'period_from' } },
        { column: 'periodStart', op: 'lte', value: '2024-01-01', valueBinding: { source: 'agent-input', field: 'period_to' } },
      ],
      [{ name: 'period_from', type: 'string', nullable: true }, { name: 'period_to', type: 'string', nullable: true }],
    );

    const result = normalizeArgumentTypes(graph, propagationWith(), changes);

    expect(declaredColumns(result)).toEqual([
      { name: 'period_from', type: 'date', nullable: true },
      { name: 'period_to', type: 'date', nullable: true },
    ]);
    expect(changes[0]).toContain('declared argument \'period_from\' as "type": "date"');
  });

  it('正常: number 列にバインドした引数は number へ直す', () => {
    const changes: string[] = [];
    const graph = graphWith(
      [{ column: '賃金', op: 'gte', value: 1, valueBinding: { source: 'agent-input', field: 'min_wage' } }],
      [{ name: 'min_wage', type: 'string', nullable: true }],
    );

    expect(declaredColumns(normalizeArgumentTypes(graph, propagationWith(), changes))).toEqual([{ name: 'min_wage', type: 'number', nullable: true }]);
  });

  it('境界: in にバインドした引数と opBinding の引数は string のまま', () => {
    const changes: string[] = [];
    const graph = graphWith(
      [
        { column: '賃金', op: 'in', values: [1], valueBinding: { source: 'agent-input', field: 'wages' } },
        { column: 'periodStart', op: 'gte', value: '2020-01-01', opBinding: { source: 'agent-input', field: 'period_op', allowed: ['gte', 'lte'] } },
      ],
      [{ name: 'wages', type: 'string', nullable: true }, { name: 'period_op', type: 'string', nullable: true }],
    );

    expect(normalizeArgumentTypes(graph, propagationWith(), changes)).toBe(graph);
    expect(changes).toEqual([]);
  });

  it('異常: 型の違う複数の列にバインドされた引数は触らない（意味検査へ委ねる）', () => {
    const changes: string[] = [];
    const graph = graphWith(
      [
        { column: 'periodStart', op: 'gte', value: '2020-01-01', valueBinding: { source: 'agent-input', field: 'mixed' } },
        { column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'mixed' } },
      ],
      [{ name: 'mixed', type: 'string', nullable: true }],
    );

    expect(normalizeArgumentTypes(graph, propagationWith(), changes)).toBe(graph);
  });

  it('例外: 宣言ノードが無い・二度掛けは何もしない（冪等）', () => {
    const changes: string[] = [];
    const bare = { nodes: [{ id: 'f', type: 'filter', config: {} }], edges: [] } as unknown as ToolGraph;
    expect(normalizeArgumentTypes(bare, propagationWith(), changes)).toBe(bare);

    const graph = graphWith(
      [{ column: 'periodStart', op: 'gte', value: '2020-01-01', valueBinding: { source: 'agent-input', field: 'from' } }],
      [{ name: 'from', type: 'string', nullable: true }],
    );
    const once = normalizeArgumentTypes(graph, propagationWith(), changes);
    const twiceChanges: string[] = [];
    expect(normalizeArgumentTypes(once, propagationWith(), twiceChanges)).toBe(once);
    expect(twiceChanges).toEqual([]);
  });
});

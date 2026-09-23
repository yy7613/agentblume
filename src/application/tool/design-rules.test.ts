import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { ToolGraph } from '../../domain/etl/graph';
import { EtlEngine } from '../etl/engine';
import type { DataProfile } from '../factory/profile-data-sources';
import {
  describeDesignProblems,
  describeJoinDesignViolations,
  emptyPreviewProblem,
  missingGranularityFilter,
  sortsOnPeriodLabel,
} from './design-rules';

const engine = new EtlEngine(createDefaultRegistry());
const OUTPUT_CONFIG = { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' };

const profile = (overrides: Partial<DataProfile> = {}): DataProfile => ({
  dataSourceId: 'ds-a', name: '人口', kind: 'file', format: 'csv',
  columns: [{ name: '地域コード', type: 'string', nullable: false }, { name: '時点', type: 'string', nullable: false }],
  sampleRowCount: 0, sampleRows: [], rowCount: 0,
  periodColumns: [{ column: '時点', granularities: { year: 1 }, minStart: '2025-01-01', maxStart: '2025-01-01', mixed: false }],
  categoricalColumns: [], joinCandidates: [],
  ...overrides,
});

/** 左右 2 本の json-source を `keys` で結ぶグラフ。`parseBefore` なら左の枝で parse-period を走らせる。 */
function joinGraph(keys: readonly string[], parseBefore = false): ToolGraph {
  const left = [{ 地域コード: '13', 時点: '2025年', 注記: '', 値: 1 }];
  const right = [{ 地域コード: '13', 時点: '2025年', 注記: '', 人口: 2 }];
  return {
    nodes: [
      { id: 'l', type: 'json-source', config: { rows: left } },
      { id: 'r', type: 'json-source', config: { rows: right } },
      ...(parseBefore ? [{ id: 'pp', type: 'parse-period', config: { column: '時点' } }] : []),
      { id: 'jn', type: 'join', config: { mode: 'inner', keys } },
      { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG },
    ],
    edges: [
      ...(parseBefore ? [{ from: 'l', to: 'pp' }, { from: 'pp', to: 'jn', toInput: 0 }] : [{ from: 'l', to: 'jn', toInput: 0 }]),
      { from: 'r', to: 'jn', toInput: 1 },
      { from: 'jn', to: 'out' },
    ],
  };
}

function linear(nodes: ToolGraph['nodes']): ToolGraph {
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })) };
}

describe('describeJoinDesignViolations（Factory と設計アシスタントで共有する結合の設計の規則）', () => {
  it('正常: 結合が無いグラフは何も言わない', () => {
    expect(describeJoinDesignViolations(linear([{ id: 's', type: 'json-source', config: { rows: [] } }, { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG }]), profile())).toBeUndefined();
  });

  it('異常: プロファイルが無くても、結合より前の parse-period は指摘する', () => {
    expect(describeJoinDesignViolations(joinGraph(['地域コード', '時点'], true), undefined)).toBe(
      "joined tool design is wrong: 'parse-period' node 'pp' sits on a branch BEFORE the join. Move it after the last join (the period label column survives the join as a key), so that 'periodStart' exists once instead of once per branch",
    );
  });

  it('境界: 結合候補が無いとき、外させるのは注記だけ（並んだ正しいキーは残させる）', () => {
    const message = describeJoinDesignViolations(joinGraph(['地域コード', '注記']), profile());
    expect(message).toContain("joins on '注記', which is free-text");
    expect(message).toContain("Remove '注記' from \"keys\"");
    expect(message).not.toContain("'地域コード', which");
    expect(message).not.toContain("Remove '注記', '地域コード'");
  });

  it('境界(回帰固定): 結合候補が無く注記キーも無ければ、従来どおりキーについては何も言わない', () => {
    expect(describeJoinDesignViolations(joinGraph(['地域コード', '時点']), profile())).toBeUndefined();
  });

  it('異常: 結合候補があれば、候補に無いキーは従来どおり指摘する', () => {
    const withCandidates = profile({ joinCandidates: [{ leftDataSourceId: 'ds-a', rightDataSourceId: 'ds-b', keys: ['地域コード'], overlap: { 地域コード: 1 }, uniqueLeft: true, uniqueRight: true }] });
    const message = describeJoinDesignViolations(joinGraph(['地域コード', '時点']), withCandidates);
    expect(message).toContain("joins on '時点', which the data profile did not list as a shared key");
  });
});

describe('設計アシスタントの意味の規則（純関数）', () => {
  it('異常: 期間ラベルの文字列列で並べ替えると指摘する', () => {
    const graph = linear([
      { id: 's', type: 'json-source', config: { rows: [{ 時点: '2025年9月' }] } },
      { id: 'sort-1', type: 'sort', config: { keys: [{ column: '時点', direction: 'desc' }] } },
      { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG },
    ]);
    expect(sortsOnPeriodLabel(graph, engine.propagateSchemas(graph), [profile()])).toEqual([expect.stringContaining("node 'sort-1': sorting on '時点' orders the period LABELS as text")]);
  });

  it('境界: 同じ名前でも上流で文字列でない列（数値の 時点）は並べ替えてよい', () => {
    const graph = linear([
      { id: 's', type: 'json-source', config: { rows: [{ 時点: 2025 }] } },
      { id: 'sort-1', type: 'sort', config: { keys: [{ column: '時点', direction: 'desc' }] } },
      { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG },
    ]);
    expect(sortsOnPeriodLabel(graph, engine.propagateSchemas(graph), [profile()])).toEqual([]);
  });

  it('正常: 粒度の混在する期間列でも、粒度の filter があれば何も言わない', () => {
    const mixed = profile({ periodColumns: [{ column: '時点', granularities: { month: 1, year: 1 }, minStart: '2025-01-01', maxStart: '2025-12-01', mixed: true }] });
    const graph = linear([
      { id: 's', type: 'json-source', config: { rows: [] } },
      { id: 'pp', type: 'parse-period', config: { column: '時点' } },
      { id: 'f', type: 'filter', config: { column: 'periodGranularity', op: 'eq', value: 'year' } },
    ]);
    expect(missingGranularityFilter(graph, [mixed])).toEqual([]);
    expect(missingGranularityFilter({ nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) }, [mixed])).toEqual([expect.stringContaining("the period column '時点' mixes granularities")]);
  });

  it('境界: プレビューに行があれば空振りの指摘は無く、0 行なら指摘する', () => {
    const rows = linear([{ id: 's', type: 'json-source', config: { rows: [{ a: 1 }] } }, { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG }]);
    expect(emptyPreviewProblem(rows, engine.preview(rows, { rowLimit: 5 }))).toBeUndefined();
    const empty = linear([
      { id: 's', type: 'json-source', config: { rows: [{ a: 1 }] } },
      { id: 'f', type: 'filter', config: { column: 'a', op: 'eq', value: 2 } },
      { id: 'out', type: 'agent-output', config: OUTPUT_CONFIG },
    ]);
    expect(emptyPreviewProblem(empty, engine.preview(empty, { rowLimit: 5 }))).toBe(
      'the design-time preview returned 0 rows, so the tool shows nothing on the canvas; use design-time values that exist in the data (see the profiles) so that the preview has rows',
    );
  });

  it('正常: 結合の設計は hard に入り、主ソースはグラフが最初に参照するデータソースのプロファイル', () => {
    const graph = joinGraph(['地域コード', '注記']);
    const propagation = engine.propagateSchemas(graph);
    const preview = engine.preview(graph, { rowLimit: 5, retainTables: true });
    const result = describeDesignProblems({ graph, executable: graph, propagation, preview, profiles: [profile()], dataSourceIds: ['ds-a'] });
    expect(result.soft).toEqual([]);
    expect(result.hard).toEqual([
      "joined tool design is wrong: the 'join' node 'jn' joins on '注記', which is free-text (a note/remark column): rows whose notes differ are silently dropped. Remove '注記' from \"keys\" and join only on the columns joinCandidates lists",
    ]);
  });
});

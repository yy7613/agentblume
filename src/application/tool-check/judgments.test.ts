/**
 * `extractJudgments` のテスト。
 *
 * 実行直前に注入される `config.resolved.verdicts`（キーは `aiJudgeItemKey`）を直接書いたグラフを
 * 本物の EtlEngine で走らせ、「ノードの入力行 + 判定列 + 理由列」の表が組み上がることを確かめる。
 * 判定の解決そのもの（モデル呼び出し）は resolve-ai-judgments.test.ts の担当。
 */
import { describe, expect, it } from 'vitest';
import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { aiJudgeItemKey, type AiJudgeVerdict } from '../../domain/etl/nodes/ai-judge';
import { EtlEngine } from '../etl/engine';
import { extractJudgments } from './judgments';

const AGENT_OUTPUT = { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } as const;

const rows: readonly Row[] = [
  { id: 'E1', amount: 12000, note: '交通費' },
  { id: 'E2', amount: 500, note: '会議費' },
];

const engine = (): EtlEngine => new EtlEngine(createDefaultRegistry());

/** 行の内容キー（解決器が使うのと同じ計算）で判定を作る。既定の columns は入力の全列。 */
function verdictsFor(entries: readonly [Row, AiJudgeVerdict][], columns: readonly string[] = ['id', 'amount', 'note']): Record<string, AiJudgeVerdict> {
  const verdicts: Record<string, AiJudgeVerdict> = {};
  for (const [row, verdict] of entries) verdicts[aiJudgeItemKey(row, columns)] = verdict;
  return verdicts;
}

/** `json-source → ai-judge → agent-output`。ai-judge の設定だけ差し替える。 */
function graphOf(judge: Record<string, unknown>, source: readonly Row[] = rows): ToolGraph {
  return {
    nodes: [
      { id: 'source', type: 'json-source', config: { rows: source } },
      { id: 'judge', type: 'ai-judge', config: { question: 'これは経費として妥当ですか？', ...judge } },
      { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
    ],
    edges: [{ from: 'source', to: 'judge' }, { from: 'judge', to: 'out' }],
  };
}

const resolvedFlag = {
  resolved: { verdicts: verdictsFor([
    [rows[0] as Row, { value: 'yes', reason: '規程の範囲内' }],
    [rows[1] as Row, { value: 'no', reason: '領収書が無い' }],
  ]) },
};

describe('extractJudgments', () => {
  describe('正常', () => {
    it('ノードの入力行に判定列と理由列を足した表を返す（列の並びは入力 → 判定 → 理由）', () => {
      const tables = extractJudgments(engine(), graphOf(resolvedFlag));
      expect(tables).toHaveLength(1);
      const judgment = tables[0]!;
      expect(judgment.nodeId).toBe('judge');
      expect(judgment.verdictColumn).toBe('aiVerdict');
      expect(judgment.reasonColumn).toBe('aiReason');
      expect(judgment.table.schema.columns).toEqual([
        { name: 'id', type: 'string', nullable: false },
        { name: 'amount', type: 'number', nullable: false },
        { name: 'note', type: 'string', nullable: false },
        { name: 'aiVerdict', type: 'string', nullable: false },
        { name: 'aiReason', type: 'string', nullable: true },
      ]);
      expect(judgment.table.rows).toEqual([
        { id: 'E1', amount: 12000, note: '交通費', aiVerdict: 'yes', aiReason: '規程の範囲内' },
        { id: 'E2', amount: 500, note: '会議費', aiVerdict: 'no', aiReason: '領収書が無い' },
      ]);
    });

    it('設定の outputColumn / reasonColumn をそのまま列名に使う', () => {
      const tables = extractJudgments(engine(), graphOf({ ...resolvedFlag, outputColumn: 'verdict', reasonColumn: 'why' }));
      expect(tables[0]?.verdictColumn).toBe('verdict');
      expect(tables[0]?.reasonColumn).toBe('why');
      expect(tables[0]?.table.rows[0]).toMatchObject({ verdict: 'yes', why: '規程の範囲内' });
    });

    it('理由列を出さない設定（reasonColumn: null）でも検証用に aiReason を出す', () => {
      const tables = extractJudgments(engine(), graphOf({ ...resolvedFlag, reasonColumn: null }));
      expect(tables[0]?.reasonColumn).toBe('aiReason');
      expect(tables[0]?.table.schema.columns.map((column) => column.name)).toEqual(['id', 'amount', 'note', 'aiVerdict', 'aiReason']);
      expect(tables[0]?.table.rows[1]).toMatchObject({ aiVerdict: 'no', aiReason: '領収書が無い' });
    });

    it.each(['keep', 'exclude'] as const)('action %s で終端から行が消えても、判定表には入力の全行が残る', (action) => {
      const graph = graphOf({ ...resolvedFlag, action, matchValues: ['yes'] });
      const tables = extractJudgments(engine(), graph);
      expect(tables[0]?.table.rows.map((row) => row['id'])).toEqual(['E1', 'E2']);
      expect(tables[0]?.table.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'no']);
      // 終端（agent-output）では 1 行に減っている＝判定表は終端ではなく入力を見ている。
      expect(engine().preview(graph, { rowLimit: 0 }).fullOutput.rows).toHaveLength(1);
    });

    it('columns を絞った設定では、その列だけで作ったキーの判定を引く', () => {
      const verdicts = verdictsFor([[rows[0] as Row, { value: 'yes', reason: 'id だけで判定' }], [rows[1] as Row, { value: 'no', reason: 'id だけで判定' }]], ['id']);
      const tables = extractJudgments(engine(), graphOf({ columns: ['id'], resolved: { verdicts } }));
      expect(tables[0]?.table.rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'no']);
    });

    it('Date セルは ISO 文字列としてキーになる（解決器と同じ同一視）', () => {
      const dated: readonly Row[] = [{ id: 'E1', at: new Date('2026-01-05T00:00:00.000Z') }];
      const verdicts = verdictsFor([[dated[0] as Row, { value: 'yes', reason: '日付つき' }]], ['id', 'at']);
      const tables = extractJudgments(engine(), graphOf({ resolved: { verdicts } }, dated));
      expect(tables[0]?.table.rows[0]).toMatchObject({ aiVerdict: 'yes', aiReason: '日付つき' });
    });
  });

  describe('境界', () => {
    it('判定の無い行は unclear と定型の理由で埋める（黙って落とさない）', () => {
      const verdicts = verdictsFor([[rows[0] as Row, { value: 'yes', reason: '規程の範囲内' }]]);
      const tables = extractJudgments(engine(), graphOf({ resolved: { verdicts } }));
      expect(tables[0]?.table.rows[1]).toMatchObject({ id: 'E2', aiVerdict: 'unclear', aiReason: 'no verdict was returned for this row' });
    });

    it('判定列が入力の列と同名なら列を増やさず値を上書きする（keep / exclude では衝突が許される）', () => {
      const tables = extractJudgments(engine(), graphOf({ ...resolvedFlag, action: 'keep', matchValues: ['yes'], outputColumn: 'note', reasonColumn: 'id' }));
      expect(tables[0]?.table.schema.columns.map((column) => column.name)).toEqual(['id', 'amount', 'note']);
      expect(tables[0]?.table.rows[0]).toEqual({ id: '規程の範囲内', amount: 12000, note: 'yes' });
    });

    it('0 行の入力では空の判定表を返す（表自体は出す）', () => {
      const tables = extractJudgments(engine(), graphOf({ resolved: { verdicts: {} } }, []));
      expect(tables).toHaveLength(1);
      expect(tables[0]?.table.rows).toEqual([]);
    });

    it('連鎖した ai-judge: 2 つ目の判定表には 1 つ目の判定列が入力として含まれる', () => {
      const first = verdictsFor([
        [rows[0] as Row, { value: 'yes', reason: '規程の範囲内' }],
        [rows[1] as Row, { value: 'no', reason: '領収書が無い' }],
      ]);
      // 2 つ目の入力は 1 つ目の出力（判定列・理由列つき）なので、キーもその全列で作る。
      const afterFirst: readonly Row[] = [
        { ...rows[0], aiVerdict: 'yes', aiReason: '規程の範囲内' },
        { ...rows[1], aiVerdict: 'no', aiReason: '領収書が無い' },
      ];
      const secondColumns = ['id', 'amount', 'note', 'aiVerdict', 'aiReason'];
      const second = verdictsFor([
        [afterFirst[0] as Row, { value: '旅費', reason: '移動の実費' }],
        [afterFirst[1] as Row, { value: '会議費', reason: '打合せ' }],
      ], secondColumns);
      const graph: ToolGraph = {
        nodes: [
          { id: 'source', type: 'json-source', config: { rows } },
          { id: 'judge', type: 'ai-judge', config: { question: 'これは経費として妥当ですか？', resolved: { verdicts: first } } },
          { id: 'classify', type: 'ai-judge', config: { question: 'どの科目ですか？', categories: [{ name: '旅費' }, { name: '会議費' }], outputColumn: 'category', reasonColumn: 'categoryReason', resolved: { verdicts: second } } },
          { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
        ],
        edges: [{ from: 'source', to: 'judge' }, { from: 'judge', to: 'classify' }, { from: 'classify', to: 'out' }],
      };
      const tables = extractJudgments(engine(), graph);
      expect(tables.map((table) => table.nodeId)).toEqual(['judge', 'classify']);
      expect(tables[1]?.table.schema.columns.map((column) => column.name)).toEqual(['id', 'amount', 'note', 'aiVerdict', 'aiReason', 'category', 'categoryReason']);
      expect(tables[1]?.table.rows[0]).toEqual({ id: 'E1', amount: 12000, note: '交通費', aiVerdict: 'yes', aiReason: '規程の範囲内', category: '旅費', categoryReason: '移動の実費' });
      expect(tables[0]?.table.schema.columns.map((column) => column.name)).toEqual(['id', 'amount', 'note', 'aiVerdict', 'aiReason']);
    });
  });

  describe('異常: 判定表を作れないノードは飛ばす', () => {
    it('ai-judge が無いグラフは空配列', () => {
      const graph: ToolGraph = {
        nodes: [{ id: 'source', type: 'json-source', config: { rows } }, { id: 'out', type: 'agent-output', config: AGENT_OUTPUT }],
        edges: [{ from: 'source', to: 'out' }],
      };
      expect(extractJudgments(engine(), graph)).toEqual([]);
    });

    it('判定が注入されていないノードは含めない（解決器を通していないグラフ）', () => {
      expect(extractJudgments(engine(), graphOf({}))).toEqual([]);
    });

    it('設定が壊れているノードは含めない（実行時に ai-judge 自身が同じ不備を報告する）', () => {
      expect(extractJudgments(engine(), graphOf({ ...resolvedFlag, outputColumn: '' }))).toEqual([]);
    });

    it('上流の無い ai-judge は含めない', () => {
      const graph: ToolGraph = {
        nodes: [{ id: 'judge', type: 'ai-judge', config: { question: 'x', ...resolvedFlag } }],
        edges: [],
      };
      expect(extractJudgments(engine(), graph)).toEqual([]);
    });

    it('解決済みと未解決が混ざっていれば、解決済みのノードだけを返す', () => {
      const graph: ToolGraph = {
        nodes: [
          { id: 'source', type: 'json-source', config: { rows } },
          { id: 'judge', type: 'ai-judge', config: { question: 'これは経費として妥当ですか？', ...resolvedFlag } },
          { id: 'later', type: 'ai-judge', config: { question: 'まだ解いていない', outputColumn: 'second', reasonColumn: 'secondReason' } },
          { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
        ],
        edges: [{ from: 'source', to: 'judge' }, { from: 'judge', to: 'later' }, { from: 'later', to: 'out' }],
      };
      expect(extractJudgments(engine(), graph).map((table) => table.nodeId)).toEqual(['judge']);
    });
  });

  it('例外: 上流ノードの実行が失敗したら握り潰さず伝播する（ノード id 付きの EtlError）', () => {
    const graph: ToolGraph = {
      nodes: [
        { id: 'source', type: 'json-source', config: { rows } },
        { id: 'narrow', type: 'limit', config: { count: -1 } },
        { id: 'judge', type: 'ai-judge', config: { question: 'q', ...resolvedFlag } },
        { id: 'out', type: 'agent-output', config: AGENT_OUTPUT },
      ],
      edges: [{ from: 'source', to: 'narrow' }, { from: 'narrow', to: 'judge' }, { from: 'judge', to: 'out' }],
    };
    expect(() => extractJudgments(engine(), graph)).toThrowError(expect.objectContaining({ nodeId: 'narrow' }));
  });
});

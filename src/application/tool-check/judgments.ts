/**
 * アプリ層: ツール検証が見る「AI 判定ノードの判定結果」。
 *
 * `ai-judge` の判定は実行直前に `config.resolved.verdicts`（行内容キー → 判定）として注入される。
 * ここでは注入済みグラフから、各 ai-judge ノードについて **入力行 + 判定列 + 理由列** の表を組み立てる。
 * action が keep / exclude で終端から行が消えていても、判定そのものは行ごとに検証できる。
 *
 * 上流の行は祖先サブグラフを実行し直して得る（解決器と同じ計算。決定的で、判定はキャッシュ済み）。
 */
import type { Row, Table } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { AI_JUDGE_TYPE, AI_JUDGE_UNCLEAR, aiJudgeColumns, aiJudgeItemKey, aiJudgeNode, type AiJudgeVerdict } from '../../domain/etl/nodes/ai-judge';
import type { EtlEngine } from '../etl/engine';
import { ancestorSubgraph } from '../tool/resolve-ai-judgments';

/** 1 つの ai-judge ノードの判定結果表。 */
export interface ToolCheckJudgmentTable {
  readonly nodeId: string;
  /** 判定値が入る列名（設定の outputColumn）。 */
  readonly verdictColumn: string;
  /** 理由が入る列名（設定で理由列を省いていても検証用には出す）。 */
  readonly reasonColumn: string;
  /** 入力行 + 判定列 + 理由列（全行）。 */
  readonly table: Table;
}

const DEFAULT_REASON_COLUMN = 'aiReason';
const NO_VERDICT: AiJudgeVerdict = { value: AI_JUDGE_UNCLEAR, reason: 'no verdict was returned for this row' };

/** 注入済みグラフの ai-judge ノードごとに判定結果表を組み立てる。未解決のノードは含めない。 */
export function extractJudgments(engine: EtlEngine, judged: ToolGraph): readonly ToolCheckJudgmentTable[] {
  const tables: ToolCheckJudgmentTable[] = [];
  for (const node of judged.nodes) {
    if (node.type !== AI_JUDGE_TYPE) continue;
    let config;
    try { config = aiJudgeNode.validateConfig(node.config); } catch { continue; }
    if (config.resolved === undefined) continue;
    const upstreamId = judged.edges.find((edge) => edge.to === node.id)?.from;
    if (upstreamId === undefined) continue;
    const upstream = engine.preview(ancestorSubgraph(judged, upstreamId), { rowLimit: 0 }).fullOutput;
    const columns = aiJudgeColumns(upstream.schema, config);
    const verdictColumn = config.outputColumn;
    const reasonColumn = config.reasonColumn ?? DEFAULT_REASON_COLUMN;
    const rows: Row[] = upstream.rows.map((row) => {
      const verdict = config.resolved?.verdicts[aiJudgeItemKey(row, columns)] ?? NO_VERDICT;
      return { ...row, [verdictColumn]: verdict.value, [reasonColumn]: verdict.reason };
    });
    const names = new Set(upstream.schema.columns.map((column) => column.name));
    const schema = {
      columns: [
        ...upstream.schema.columns,
        ...(names.has(verdictColumn) ? [] : [{ name: verdictColumn, type: 'string' as const, nullable: false }]),
        ...(names.has(reasonColumn) ? [] : [{ name: reasonColumn, type: 'string' as const, nullable: true }]),
      ],
    };
    tables.push({ nodeId: node.id, verdictColumn, reasonColumn, table: { schema, rows } });
  }
  return tables;
}

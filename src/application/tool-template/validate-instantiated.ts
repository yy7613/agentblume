/**
 * application層: 実体化したテンプレートを、手で組んだ Tool と**同じ検査**に掛ける
 * （v43 実装契約 §3）。テンプレート経路だけの抜け道を作らないための関門。
 *
 * 2 段階で見る:
 *  1. スキーマ伝播（`propagateSchemas`）— 列の存在・型・config の形。
 *  2. 設計時プレビュー（`preview`）— 実データで 1 回走らせる。引数は実体化が作った
 *     `agent-input` の見本（`sample`）のまま走るので、「設計時は通るのに呼ぶと落ちる」を先に潰せる。
 *
 * 問題は、分かるものだけ**スロットへ戻す**（「列 X が無い」→ X を選んだスロット）。
 * どのスロットを選び直せばよいかが分かれば、`fill-slots` は 1 回の差し戻しで直せる。
 */
import type { ToolGraph } from '../../domain/etl/graph';
import type { InstantiatedTemplate } from '../../domain/tool-template/instantiate';
import type { EtlEngine } from '../etl/engine';

/** 検証の問題 1 件。`slot` が付いていれば、そのスロットの選び直しで直る。 */
export interface InstantiatedTemplateProblem {
  readonly message: string;
  readonly slot?: string;
}

/** 設計時プレビューで読む行数（表示用スナップショット。実行は常に全行）。 */
const PREVIEW_ROW_LIMIT = 20;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 問題文に出てくる列名から、その列を選んだスロットを引き当てる（長い名前から順に見る）。 */
function slotFor(message: string, columnSlots: Readonly<Record<string, string>>): string | undefined {
  const names = Object.keys(columnSlots).sort((a, b) => b.length - a.length);
  const hit = names.find((name) => name !== '' && message.includes(name));
  return hit === undefined ? undefined : columnSlots[hit];
}

/**
 * 実体化の結果を検証する。
 *
 * @param engine ETL エンジン。
 * @param instantiated 実体化の結果。`pendingExpressions` が残っている（式が空の calculate がある）
 *   グラフは**まだ検証できない**中間生成物なので、その旨を 1 件の問題として返す。
 * @param resolveGraph データソース id を実データへ展開する関数（既に展開済みなら省略できる）。
 */
export async function validateInstantiatedTemplate(
  engine: EtlEngine,
  instantiated: InstantiatedTemplate,
  resolveGraph?: (graph: ToolGraph) => Promise<ToolGraph>,
): Promise<InstantiatedTemplateProblem[]> {
  if (instantiated.pendingExpressions.length > 0) {
    return instantiated.pendingExpressions.map((entry) => ({
      message: `the calculate node '${entry.nodeId}' still has an empty expression ("${entry.intent}"); write the formula into it before validating (the expression suggester fills it)`,
    }));
  }

  let graph = instantiated.graph;
  if (resolveGraph !== undefined) {
    try {
      graph = await resolveGraph(instantiated.graph);
    } catch (error) {
      return [{ message: `the data sources of this tool cannot be read: ${describe(error)}; check that every data source still exists and has the format the template expects` }];
    }
  }

  const problems: InstantiatedTemplateProblem[] = [];
  const attach = (message: string): InstantiatedTemplateProblem => {
    const slot = slotFor(message, instantiated.columnSlots);
    return slot === undefined ? { message } : { message, slot };
  };

  let propagation;
  try {
    propagation = engine.propagateSchemas(graph);
  } catch (error) {
    return [attach(`the tool graph is not valid: ${describe(error)}; fix the template's nodes and edges`)];
  }
  for (const inference of Object.values(propagation.nodes)) {
    for (const issue of inference.issues) {
      if (issue.severity !== 'error') continue;
      problems.push(attach(`node '${inference.nodeId}': ${issue.message}`));
    }
  }
  if (problems.length > 0) return problems;

  try {
    engine.preview(graph, { rowLimit: PREVIEW_ROW_LIMIT });
  } catch (error) {
    problems.push(attach(`the design-time preview failed: ${describe(error)}; pick different slot values, or narrow the tool so the preview stays inside the row limits`));
  }
  return problems;
}

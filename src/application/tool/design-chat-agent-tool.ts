/**
 * 応用: 設計アシスタントの `set-agent-tool`（Tool Calling 契約の説明文と名前。v49 §4 / v50 R2）。
 *
 * **グラフの操作ではない**ので domain の `GraphOperation` には足さず、モデルの応答の中で並べて受け取り、
 * ここで検査して当てる。グラフの操作はそのまま `applyGraphOperations` へ回す。
 */
import type { GraphOperation } from '../../domain/etl/graph-edit';
import { FUNCTION_NAME_PATTERN, isFunctionName } from '../../domain/shared/function-name';
import type { DesignChatAgentTool } from './design-chat-prompt';
/** 説明文の長さの上限（契約 §4。これを超える説明は、そもそもエージェントが読み切らない）。 */
const MAX_AGENT_TOOL_DESCRIPTION = 4_000;
/** 変更一覧の要約へ載せる説明文の先頭（契約 §3）。 */
const AGENT_TOOL_SUMMARY_CHARS = 80;
/** `changes[].nodeId` の固定値（契約 §3）。強調するノードは無いので、キャンバスの id とは衝突しない名前にする。 */
const AGENT_TOOL_NODE_ID = 'agent-tool';

/**
 * `set-agent-tool` を当てた記録（契約 §3）。グラフの操作ではないので `GraphChange` には混ぜず、
 * 同じ形（`op` / `nodeId` / `summary`）を持たせて一覧では並べて出せるようにする。
 */
export interface AgentToolChange {
  readonly op: 'set-agent-tool';
  readonly nodeId: typeof AGENT_TOOL_NODE_ID;
  readonly summary: string;
}

/**
 * `set-agent-tool`（契約 §4）。**グラフの操作ではない**ので domain の `GraphOperation` には足さず、
 * ここで並べて受け取り、当てる先だけを分ける。
 */
export interface AgentToolOperation {
  readonly op: 'set-agent-tool';
  readonly description?: string;
  readonly name?: string;
}

/** モデルが返す操作 1 件（グラフの操作 5 種 + `set-agent-tool`）。 */
export type DesignChatOperation = GraphOperation | AgentToolOperation;

/**
 * `set-agent-tool` の検査（契約 §4）。文面は `GraphEditError` の流儀に揃える:
 * **何番目の操作の何が悪いか**と**直し方**を 1 文に入れ、差し戻しの材料にできるようにする。
 * 通れば undefined。
 */
function agentToolViolation(index: number, operation: AgentToolOperation): string | undefined {
  const head = `operation ${index + 1} ('set-agent-tool')`;
  const description = operation.description;
  if (description === undefined || description.trim() === '') {
    return `${head}: the tool description is missing. Set "description" to the text the agent reads before it calls this tool (1 to ${MAX_AGENT_TOOL_DESCRIPTION} characters): the format of every argument, the exact spelling of the values it may pass, what the data covers and the columns that come back.`;
  }
  if (description.length > MAX_AGENT_TOOL_DESCRIPTION) {
    return `${head}: the tool description is ${description.length} characters, which is longer than the limit of ${MAX_AGENT_TOOL_DESCRIPTION}. Shorten it to at most ${MAX_AGENT_TOOL_DESCRIPTION} characters, keeping the format of the arguments, the values the agent may pass and the columns that come back.`;
  }
  if (operation.name !== undefined && !isFunctionName(operation.name)) {
    return `${head}: the tool name ${JSON.stringify(operation.name)} does not match ${FUNCTION_NAME_PATTERN.source}. Use letters, digits, '_' and '-' only (for example "population_top"), or leave "name" out to keep the current name.`;
  }
  return undefined;
}

/** 操作を当てた後の契約。`name` を書かない操作は、いまの名前をそのまま残す（説明文だけの更新）。 */
function applyAgentTool(current: DesignChatAgentTool | undefined, operation: AgentToolOperation): DesignChatAgentTool {
  const name = operation.name ?? current?.name;
  return { ...(name === undefined || name === '' ? {} : { name }), description: operation.description ?? '' };
}

/** 一覧に出す 1 行（契約 §3）。文面で条件分岐させないよう、必ず同じ書き出しにする。 */
function agentToolSummary(applied: DesignChatAgentTool, operation: AgentToolOperation): string {
  const description = applied.description ?? '';
  const head = description.length <= AGENT_TOOL_SUMMARY_CHARS ? description : `${description.slice(0, AGENT_TOOL_SUMMARY_CHARS)}...`;
  return `set the tool description for the agent (${head})${operation.name === undefined ? '' : `, and the name '${operation.name}'`}`;
}

/**
 * 応答の操作を、グラフの操作と `set-agent-tool` に分け、後者を検査して当てる。
 * 説明文の検査はデータを要らない決定的な検査なので、グラフを当てる前に済ませる（最初の違反で止める）。
 * `agentTool` は `set-agent-tool` を 1 件でも当てたときだけ付く。
 */
export function splitAgentToolOperations(
  operations: readonly DesignChatOperation[],
  current: DesignChatAgentTool | undefined,
):
  | { readonly ok: true; readonly graphOperations: readonly GraphOperation[]; readonly agentTool?: DesignChatAgentTool; readonly changes: readonly AgentToolChange[] }
  | { readonly ok: false; readonly problem: string } {
  const graphOperations: GraphOperation[] = [];
  let agentTool = current;
  const changes: AgentToolChange[] = [];
  for (const [index, operation] of operations.entries()) {
    if (operation.op !== 'set-agent-tool') { graphOperations.push(operation); continue; }
    const violation = agentToolViolation(index, operation);
    if (violation !== undefined) return { ok: false, problem: violation };
    agentTool = applyAgentTool(agentTool, operation);
    changes.push({ op: 'set-agent-tool', nodeId: AGENT_TOOL_NODE_ID, summary: agentToolSummary(agentTool, operation) });
  }
  return { ok: true, graphOperations, changes, ...(changes.length === 0 || agentTool === undefined ? {} : { agentTool }) };
}

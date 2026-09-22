/**
 * 応用: ツール作成画面の設計アシスタント（v47 実装契約 §6 / ADR-0051）。
 *
 * 自由な文章の指示を、いまのキャンバスに対する**編集操作**へ変えて当てる。
 * 流れは式提案（ADR-0046）と同じ「提案 → 検分 → 1 回だけ差し戻し」:
 *
 *   材料を集める → モデルに操作を書かせる → 決定的に適用（`applyGraphOperations`）
 *   → 既存の正規化（`normalizeProposedGraph`）→ スキーマ伝播 → 設計時プレビュー
 *   → どこかで落ちたら理由を添えて 1 回だけ出し直させる → それでも通らなければ**グラフは変えない**。
 *
 * 保存はしない。返すのはキャンバスへ展開する編集後のグラフで、保存は従来の「バージョンを保存」。
 */
import { z } from 'zod';
import type { Schema } from '../../domain/data/types';
import type { DataSourceId } from '../../domain/data-source/ids';
import { GraphEditError, applyGraphOperations, canonicalizeOperationIds, type GraphChange, type GraphOperation } from '../../domain/etl/graph-edit';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { QueryDataSourcesUseCase } from '../data-source/manage-data-sources';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';
import type { DataProfile, ProfileDataSourcesUseCase } from '../factory/profile-data-sources';
import { normalizeProposedGraph } from '../factory/normalize-tool-graph';
import { ModelProviderError, type ModelCompletionRequest, type ModelProviderPort, type ModelUsage } from '../model/model-provider';
import type { PromptCatalogPort } from '../prompt/prompt-catalog-port';
import {
  DESIGN_CHAT_PROMPT,
  DESIGN_CHAT_SUMMARY_MAX_CHARS,
  buildDesignChatCompactRequest,
  buildDesignChatRepairRequest,
  buildDesignChatRequest,
  buildDesignChatShortenRequest,
  limitTranscript,
  type DesignChatAgentTool,
  type DesignChatCompactTurn,
  type DesignChatDataSource,
  type DesignChatProfile,
  type DesignChatRepairFeedback,
  type DesignChatTurn,
} from './design-chat-prompt';
import { DATA_SOURCE_NODE_TYPES, DESIGN_NODE_TYPES } from './node-catalog';
import { diagnoseEmptyResult, noMatchText } from './empty-result-diagnosis';

export type { DesignChatAgentTool, DesignChatCompactTurn, DesignChatTurn } from './design-chat-prompt';

/** 材料として終端から読む行数（契約 §6-1）。列の顔つきが分かれば足り、これ以上は文脈を食う。 */
const CONTEXT_PREVIEW_ROWS = 5;
/** 検分の設計時プレビューで読む行数（表示用スナップショット。計算は常に全行）。 */
const CHECK_PREVIEW_ROWS = 20;
/** プロンプトへ載せるプロファイルの上限（契約 §6-1: グラフが参照するソース + 先頭 6 件まで）。 */
const MAX_PROFILES = 6;
/** プロファイル 1 件あたりの標本行（ToolSmith と同じ 3 行）。 */
const PROFILE_SAMPLE_ROWS = 3;
/** 1 ターンで受け付ける操作の数（これを超える提案は「書き直し」であって差分ではない）。 */
const MAX_OPERATIONS = 40;
/** エージェントへ公開する function 名の形（`createTool` の `agentTool.name` と同じ規則）。 */
const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 説明文の長さの上限（契約 §4。これを超える説明は、そもそもエージェントが読み切らない）。 */
const MAX_AGENT_TOOL_DESCRIPTION = 4_000;
/** 変更一覧の要約へ載せる説明文の先頭（契約 §3）。 */
const AGENT_TOOL_SUMMARY_CHARS = 80;
/** `changes[].nodeId` の固定値（契約 §3）。強調するノードは無いので、キャンバスの id とは衝突しない名前にする。 */
const AGENT_TOOL_NODE_ID = 'agent-tool';

export interface DesignToolChatInput {
  readonly scope: TenantScope;
  /** いまのキャンバス（`position` つき）。 */
  readonly graph: ToolGraph;
  /** `agent-input` の宣言。省略すればグラフの `agent-input` から読む。 */
  readonly inputSchema?: Schema;
  readonly instruction: string;
  /** 直近の会話（古い順）。`DESIGN_CHAT_MAX_TURNS` を超えた分はここで落とす。 */
  readonly transcript?: readonly DesignChatTurn[];
  /** 画面が畳んだ古い会話（v49 §3）。材料として会話の前に置く。 */
  readonly transcriptSummary?: string;
  /** いまの Tool Calling 契約（v49 §3）。`set-agent-tool` はこれを土台に書き換える。 */
  readonly agentTool?: DesignChatAgentTool;
}

/**
 * `set-agent-tool` を当てた記録（契約 §3）。グラフの操作ではないので `GraphChange` には混ぜず、
 * 同じ形（`op` / `nodeId` / `summary`）を持たせて一覧では並べて出せるようにする。
 */
export interface AgentToolChange {
  readonly op: 'set-agent-tool';
  readonly nodeId: typeof AGENT_TOOL_NODE_ID;
  readonly summary: string;
}

/** 変更一覧 1 件（グラフの変更か、Tool Calling 契約の変更か）。 */
export type DesignChatChange = GraphChange | AgentToolChange;

/**
 * 直前の呼び出しの消費（v49 §3）。**モデルが数えた実数**だけを載せ、推定はしない。
 * 取れなかった項目は省く（画面は取れたものだけで比率かトークン数を出す）。
 */
export interface DesignChatUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly contextWindow?: number;
}

export interface DesignToolChatResult {
  /** 人が読む説明（指示と同じ言語）。 */
  readonly message: string;
  /** 編集後のグラフ。変更が無い / 適用できなかったときは無い（キャンバスは変えない）。 */
  readonly graph?: ToolGraph;
  /** 更新後の Tool Calling 契約。`set-agent-tool` を適用したときだけ。 */
  readonly agentTool?: DesignChatAgentTool;
  /** 直前の呼び出しの消費（差し戻したときは 2 回目）。どの項目も取れなければ無い。 */
  readonly usage?: DesignChatUsage;
  readonly changes: readonly DesignChatChange[];
  /** 1 回差し戻したか。 */
  readonly repaired: boolean;
  /**
   * 差し戻したときの、1 回目の失敗理由（英語の原文）。文（`prompts/tool/design-chat.md`）を運用者が調整する材料で、
   * 画面には出さない（成功した応答に赤枠は要らない）。差し戻していなければ無い。
   */
  readonly repairedFrom?: readonly string[];
  /** 適用できなかった理由（英語の原文。画面が既存の日本語化経路へ通す）。 */
  readonly problems: readonly string[];
  /**
   * 適用はしたが気を付けてほしい点（英語の原文）。意味の検査の「柔らかい問題」— 差し戻し 1 回で直らなければ
   * 止めずに適用し、ここで伝える（例: 粒度が混在する期間列に粒度の filter が無い）。
   */
  readonly warnings: readonly string[];
  readonly promptTemplateVersion: string;
}

/** 会話の圧縮 1 回分の材料（v49 §3.1）。畳むターンは画面が選ぶ（直近 4 ターンは残す）。 */
export interface DesignChatCompactInput {
  readonly scope: TenantScope;
  /** 前回までの要約（あれば新しい要約へ畳み込む。画面は返ってきた要約で**置き換える**）。 */
  readonly previousSummary?: string;
  readonly turns: readonly DesignChatCompactTurn[];
  readonly language: 'ja' | 'en';
}

export interface DesignChatCompactResult {
  /** 次のターンの材料になる覚え書き。 */
  readonly summary: string;
  /** 直前の呼び出しの消費（1 ターンの応答と同じ形）。 */
  readonly usage?: DesignChatUsage;
}

/**
 * 検分の結果。落ちたときは「どの段で・何が」を差し戻しへそのまま渡す。
 * `graph` が無いのは「キャンバスを触らない応答」（説明文だけを更新したとき）。
 */
type Attempt =
  | {
    readonly ok: true;
    readonly graph?: ToolGraph;
    readonly agentTool?: DesignChatAgentTool;
    readonly applied: readonly DesignChatChange[];
    readonly warnings: readonly string[];
  }
  | { readonly ok: false; readonly stage: DesignChatRepairFeedback['stage']; readonly problems: readonly string[] };

/**
 * `set-agent-tool`（契約 §4）。**グラフの操作ではない**ので domain の `GraphOperation` には足さず、
 * ここで並べて受け取り、当てる先だけを分ける。
 */
interface AgentToolOperation {
  readonly op: 'set-agent-tool';
  readonly description?: string;
  readonly name?: string;
}

/** モデルが返す操作 1 件（グラフの操作 5 種 + `set-agent-tool`）。 */
type DesignChatOperation = GraphOperation | AgentToolOperation;

/** 集めた材料（欠けていても止めない。欠けた理由だけを `warnings` に残す）。 */
interface DesignContext {
  readonly schemasByNode: Readonly<Record<string, Schema>>;
  readonly terminalSample?: { readonly nodeId: string; readonly rows: readonly Record<string, unknown>[] };
  readonly dataSources: readonly DesignChatDataSource[];
  readonly profiles: readonly DesignChatProfile[];
  /** 正規化が `in` 条件の種に使う生のプロファイル（プロンプトには載せない形のまま持つ）。 */
  readonly rawProfiles: readonly DataProfile[];
  readonly warnings: readonly string[];
}

const operationSchema = z.object({
  op: z.enum(['add-node', 'remove-node', 'set-config', 'connect', 'disconnect', 'set-agent-tool']),
  id: z.string().optional(),
  type: z.string().optional(),
  config: z.unknown().optional(),
  after: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  toInput: z.number().optional(),
  /** `set-agent-tool` の 2 つ。中身の検査（長さ・名前の形）は当てる直前に行う。 */
  description: z.string().optional(),
  name: z.string().optional(),
});

/**
 * 応答の形だけを見る（中身の妥当性は `applyGraphOperations` と伝播・プレビューが見る）。
 * `message` の欠落は許す: 操作が正しければ、説明が無いことを理由に捨てる意味は無い。
 */
const responseSchema = z.object({
  message: z.string().default(''),
  operations: z.array(operationSchema).max(MAX_OPERATIONS).default([]),
});

/** 圧縮の応答。要約が欠けていても捨てずに空として読む（呼び手が 1 回だけ問い直す）。 */
const summarySchema = z.object({ summary: z.string().default('') });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** グラフが参照しているデータソース id（出現順・重複なし）。 */
/**
 * 検証を通るのに答えが間違う形を、差し戻しの理由にする（Factory の意味検査の縮小版）。
 *
 * - 期間ラベルの文字列列で並べ替える: '2025年9月' が '2025年12月' より後に来る（文字列順）。実測で
 *   「新しい順に」に対し 12B は `時点` をそのまま desc に並べた。parse-period → periodStart で並べさせる。
 * - 設計時プレビューが 0 行: 画面のプレビューが空になり、人には壊れて見える。どの条件が空振りしたか
 *   （`diagnoseEmptyResult`）を添えて、見本の値を実在する値に直させる。
 */
function describeSemanticProblems(graph: ToolGraph, executable: ToolGraph, propagation: PropagationResult, preview: PreviewResult, profiles: readonly DataProfile[]): { readonly hard: string[]; readonly soft: string[] } {
  // hard = 必ず間違う形（差し戻しても直らなければ適用しない）。soft = 指示によっては正しい形（「全行を」）なので、差し戻しは 1 回まで。
  const problems: string[] = [];
  const soft: string[] = [];
  const periodLabels = new Set(profiles.flatMap((profile) => (profile.periodColumns ?? []).map((column) => column.column)));
  for (const node of graph.nodes) {
    if (node.type !== 'sort' || !isRecord(node.config) || !Array.isArray(node.config['keys'])) continue;
    const upstream = graph.edges.find((edge) => edge.to === node.id)?.from;
    const inputSchema = upstream === undefined ? undefined : propagation.nodes[upstream]?.schema;
    for (const key of node.config['keys']) {
      const column = isRecord(key) && typeof key['column'] === 'string' ? key['column'] : undefined;
      if (column === undefined || !periodLabels.has(column)) continue;
      const type = inputSchema?.columns.find((candidate) => candidate.name === column)?.type;
      if (type !== undefined && type !== 'string') continue;
      problems.push(`node '${node.id}': sorting on '${column}' orders the period LABELS as text ('2025年9月' comes after '2025年12月'), not by time; add a parse-period node upstream (column "${column}") and sort on its start column "periodStart" instead`);
    }
  }
  // 粒度が混在する期間列を parse-period で開いたのに、粒度で絞る filter が無い: 月次と年次の行が混ざって集計や
  // 「新しい順」が狂う（ADR-0047 決定 4 と同じ規則）。実測で「年次に絞って」の指示が落ちた。
  const mixedLabels = new Set(profiles.flatMap((profile) => (profile.periodColumns ?? []).filter((column) => column.mixed).map((column) => column.column)));
  for (const node of graph.nodes) {
    if (node.type !== 'parse-period' || !isRecord(node.config)) continue;
    const source = typeof node.config['column'] === 'string' ? node.config['column'] : '';
    if (!mixedLabels.has(source)) continue;
    const granularityColumn = typeof node.config['granularityColumn'] === 'string' ? node.config['granularityColumn'] : 'periodGranularity';
    const filtered = graph.nodes.some((candidate) => candidate.type === 'filter' && JSON.stringify(candidate.config ?? {}).includes(JSON.stringify(granularityColumn)));
    if (filtered) continue;
    soft.push(`node '${node.id}': the period column '${source}' mixes granularities (monthly, quarterly, yearly and fiscal-year rows share it), but no filter narrows "${granularityColumn}" to one granularity; add a filter { "column": "${granularityColumn}", "op": "eq", "value": "<one of the granularities in the profile>" } right after the parse-period node so the rows are not mixed`);
  }
  const terminal = preview.nodes[preview.terminalId];
  if (terminal !== undefined && terminal.rowCount === 0) {
    const noMatch = preview.tables === undefined ? undefined : diagnoseEmptyResult({ graph: executable, tables: preview.tables });
    problems.push(noMatch === undefined
      ? 'the design-time preview returned 0 rows, so the tool shows nothing on the canvas; use design-time values that exist in the data (see the profiles) so that the preview has rows'
      : `the design-time preview returned 0 rows: ${noMatchText(noMatch)}; use design-time values that exist in the data so that the preview has rows`);
  }
  return { hard: problems, soft };
}

function referencedDataSourceIds(graph: ToolGraph): string[] {
  const found: string[] = [];
  for (const node of graph.nodes) {
    if (!DATA_SOURCE_NODE_TYPES.includes(node.type) || !isRecord(node.config)) continue;
    const id = node.config['dataSourceId'];
    if (typeof id === 'string' && id !== '' && !found.includes(id)) found.push(id);
  }
  return found;
}

/** グラフの `agent-input` が宣言している引数（本文で渡されなかったときの読み取り元）。 */
function inputSchemaOf(graph: ToolGraph): Schema | undefined {
  const declaration = graph.nodes.find((node) => node.type === 'agent-input');
  if (declaration === undefined || !isRecord(declaration.config)) return undefined;
  const schema = declaration.config['schema'];
  return isRecord(schema) && Array.isArray(schema['columns']) ? (schema as unknown as Schema) : undefined;
}

/** プロファイルをプロンプトへ載せる形へ写す（標本行は先頭数件だけ）。 */
function profileForPrompt(profile: DataProfile): DesignChatProfile {
  return {
    dataSourceId: profile.dataSourceId,
    name: profile.name,
    columns: profile.columns,
    rowCount: profile.rowCount,
    periodColumns: profile.periodColumns,
    categoricalColumns: profile.categoricalColumns,
    sampleRows: profile.sampleRows.slice(0, PROFILE_SAMPLE_ROWS),
  };
}

/**
 * 変えなかったノードの `position` を元のグラフから写す。
 *
 * 適用も正規化もノードを `{ ...node }` で作り直すので実際には残るが、経路が増えたときに
 * 黙って配置が失われないよう、最後に必ず写し直す（配置は人が組んだ情報で、復元できない）。
 */
function restorePositions(graph: ToolGraph, original: ToolGraph): ToolGraph {
  const positions = new Map(original.nodes.filter((node) => node.position !== undefined).map((node) => [node.id, node.position] as const));
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    if (position === undefined || node.position !== undefined) return node;
    changed = true;
    return { ...node, position } as GraphNode;
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}

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
  if (operation.name !== undefined && !AGENT_TOOL_NAME_PATTERN.test(operation.name)) {
    return `${head}: the tool name ${JSON.stringify(operation.name)} does not match ${AGENT_TOOL_NAME_PATTERN.source}. Use letters, digits, '_' and '-' only (for example "population_top"), or leave "name" out to keep the current name.`;
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

/** モデルが数えた実数だけを残す（負・小数・非数は「数えられていない」と同じ扱い）。 */
function tokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export class DesignToolChatUseCase {
  /**
   * `enabled` を関数で受ける理由は式提案と同じ。モデルは UI から切り替えられるので、
   * 起動時の env で固定すると設定とズレる。
   * 材料を集める依存（データソースの解決・プロファイル・一覧）はどれも任意で、
   * 欠けていればその材料だけを諦める（アシスタント自体は動く）。
   */
  constructor(
    private readonly engine: EtlEngine,
    private readonly model: ModelProviderPort,
    private readonly enabled: () => boolean | Promise<boolean>,
    /** 文の置き場所（v48）。版も文もここが正で、コードに定数は持たない。 */
    private readonly prompts: PromptCatalogPort,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
    private readonly profileDataSources?: ProfileDataSourcesUseCase,
    private readonly queryDataSources?: QueryDataSourcesUseCase,
  ) {}

  async available(): Promise<boolean> {
    return (await this.enabled()) && this.model.capabilities().includes('structured-output');
  }

  async execute(input: DesignToolChatInput, signal?: AbortSignal): Promise<DesignToolChatResult> {
    if (!(await this.available())) throw new ModelProviderError('design assistant is not configured');
    if (typeof input.instruction !== 'string' || input.instruction.trim() === '') {
      throw new ModelProviderError('design assistant requires an instruction');
    }

    const context = await this.gather(input, signal);
    const inputSchema = input.inputSchema ?? inputSchemaOf(input.graph);
    const request = buildDesignChatRequest(this.prompts, {
      instruction: input.instruction,
      graph: input.graph,
      schemasByNode: context.schemasByNode,
      ...(context.terminalSample === undefined ? {} : { terminalSample: context.terminalSample }),
      dataSources: context.dataSources,
      profiles: context.profiles,
      transcript: limitTranscript(input.transcript),
      ...(input.transcriptSummary === undefined ? {} : { transcriptSummary: input.transcriptSummary }),
      ...(input.agentTool === undefined ? {} : { agentTool: input.agentTool }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(context.warnings.length === 0 ? {} : { contextWarnings: context.warnings }),
    });

    let answer = await this.ask(request, signal);
    let parsed = parseResponse(answer.content);
    // 操作が無い応答は「質問への回答」か「聞き返し」。検分するものが無いので、そのまま返す（契約 §3）。
    if (parsed.operations.length === 0) return this.answer(await this.usageOf(answer), parsed.message, false, []);

    let attempt = await this.applyAndCheck(input, parsed.operations, context, false);
    if (attempt.ok) return this.applied(await this.usageOf(answer), parsed.message, attempt, input.graph, false);

    // 差し戻しは 1 回だけ（ADR-0046 と同じ。往復を重ねるより、人が指示を直す方が速い）。
    const repair = buildDesignChatRepairRequest(this.prompts, request, answer.content, { stage: attempt.stage, problems: attempt.problems });
    // 消費は**直前の呼び出し**のもの（契約 §3）。差し戻した回の値の方が、次のターンの目安に近い。
    answer = await this.ask(repair, signal);
    parsed = parseResponse(answer.content);
    if (parsed.operations.length === 0) return this.answer(await this.usageOf(answer), parsed.message, true, [], attempt.problems);

    // 2 回目は柔らかい問題を許す（差し戻しは 1 回まで。直らなければ警告つきで適用する）。
    const retried = await this.applyAndCheck(input, parsed.operations, context, true);
    if (retried.ok) return this.applied(await this.usageOf(answer), parsed.message, retried, input.graph, true, attempt.problems);
    // 2 回目も通らなかった: **元のグラフには触らず**、説明と理由だけ返す（HTTP は 200）。
    return this.answer(await this.usageOf(answer), parsed.message, true, retried.problems, attempt.problems);
  }

  /**
   * 会話の古いターンを、次のターンで読む覚え書きへ畳む（v49 §3.1）。
   *
   * 要約をモデルに書かせるのは、会話に散らばる**決定と意図**（「全国は除く」「地域は引数にする」）が
   * 機械的な切り詰めでは落ちるため。適用した変更の要約は正確な記録なので、材料として一緒に渡す。
   * ここではグラフを一切見ない（畳むのは会話であって、キャンバスではない）。
   */
  async compact(input: DesignChatCompactInput, signal?: AbortSignal): Promise<DesignChatCompactResult> {
    if (!(await this.available())) throw new ModelProviderError('design assistant is not configured');
    const request = buildDesignChatCompactRequest(this.prompts, {
      turns: input.turns,
      language: input.language,
      ...(input.previousSummary === undefined ? {} : { previousSummary: input.previousSummary }),
    });

    let answer = await this.ask(request, signal);
    let summary = parseSummary(answer.content);
    if (summary === '') {
      // 空の要約は会話を捨てるのと同じ（画面は要約で**置き換える**）。同じ材料でもう 1 回だけ聞く。
      answer = await this.ask(request, signal);
      summary = parseSummary(answer.content);
    } else if (summary.length > DESIGN_CHAT_SUMMARY_MAX_CHARS) {
      // 末尾を切らずに書き直させる: 切ると、最後に来がちな「未解決の質問」だけが落ちる。
      answer = await this.ask(buildDesignChatShortenRequest(this.prompts, request, answer.content), signal);
      const shortened = parseSummary(answer.content);
      // 2 回目が空でも、まだ長くても、得られた文をそのまま返す（長くても会話全体よりは短い）。
      if (shortened !== '') summary = shortened;
    }
    const usage = await this.usageOf(answer);
    return { summary, ...(usage === undefined ? {} : { usage }) };
  }

  private answer(usage: DesignChatUsage | undefined, message: string, repaired: boolean, problems: readonly string[], repairedFrom?: readonly string[]): DesignToolChatResult {
    return {
      message, changes: [], repaired, problems, warnings: [], promptTemplateVersion: this.promptVersion(),
      ...(usage === undefined ? {} : { usage }),
      ...(repairedFrom === undefined ? {} : { repairedFrom }),
    };
  }

  /**
   * 直前の呼び出しの消費（契約 §3）。モデルが数えた `usage` と、プロバイダが答える文脈の長さを合わせる。
   * どちらも best-effort で、取れない項目は載せない（推定はしない）。
   */
  private async usageOf(answer: { readonly usage?: ModelUsage }): Promise<DesignChatUsage | undefined> {
    const promptTokens = tokenCount(answer.usage?.promptTokens);
    const completionTokens = tokenCount(answer.usage?.completionTokens);
    const contextWindow = await this.contextWindow();
    const usage: DesignChatUsage = {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
    return Object.keys(usage).length === 0 ? undefined : usage;
  }

  /**
   * プロバイダが答える文脈の長さ。任意メソッドなので、持たないプロバイダでは何も起きない。
   * 実装が投げても比率が出ないだけなので、ここで飲み込む（1 ターンを落とす理由にはならない）。
   */
  private async contextWindow(): Promise<number | undefined> {
    if (this.model.contextWindow === undefined) return undefined;
    try {
      const value = await this.model.contextWindow();
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** 実行記録に残す版。ファイルの frontmatter が正（コードに定数は持たない）。 */
  private promptVersion(): string {
    return this.prompts.get(DESIGN_CHAT_PROMPT.id).version;
  }

  private applied(usage: DesignChatUsage | undefined, message: string, attempt: Extract<Attempt, { ok: true }>, original: ToolGraph, repaired: boolean, repairedFrom?: readonly string[]): DesignToolChatResult {
    return {
      message,
      // グラフを触らない応答（説明文だけの更新）ではキャンバスを返さない。
      ...(attempt.graph === undefined ? {} : { graph: restorePositions(attempt.graph, original) }),
      ...(attempt.agentTool === undefined ? {} : { agentTool: attempt.agentTool }),
      changes: attempt.applied,
      repaired,
      problems: [],
      warnings: attempt.warnings,
      promptTemplateVersion: this.promptVersion(),
      ...(usage === undefined ? {} : { usage }),
      ...(repairedFrom === undefined ? {} : { repairedFrom }),
    };
  }

  /**
   * 操作を当てて検分する（契約 §6-3 / v49 §4）。
   * 落ちた段（適用 / 伝播 / プレビュー）と理由をそのまま返し、差し戻しの材料にする。
   */
  private async applyAndCheck(input: DesignToolChatInput, operations: readonly DesignChatOperation[], context: DesignContext, tolerateSoft: boolean): Promise<Attempt> {
    // `set-agent-tool` はグラフの操作ではないので、当てる先ごとに分ける（domain はグラフだけを知る）。
    // 説明文の検査はデータを要らない決定的な検査なので、グラフを当てる前に済ませる。
    const graphOperations: GraphOperation[] = [];
    let agentTool = input.agentTool;
    const agentToolChanges: AgentToolChange[] = [];
    for (const [index, operation] of operations.entries()) {
      if (operation.op !== 'set-agent-tool') { graphOperations.push(operation); continue; }
      const violation = agentToolViolation(index, operation);
      if (violation !== undefined) return { ok: false, stage: 'apply', problems: [violation] };
      agentTool = applyAgentTool(agentTool, operation);
      agentToolChanges.push({ op: 'set-agent-tool', nodeId: AGENT_TOOL_NODE_ID, summary: agentToolSummary(agentTool, operation) });
    }
    const appliedAgentTool = agentToolChanges.length === 0 ? undefined : agentTool;

    if (graphOperations.length === 0) {
      // 説明文だけを直した応答。検分するグラフの変化が無いので、正規化も走らせない
      // （走らせると、指示と関係のない書き換えがキャンバスへ戻ってしまう）。
      return { ok: true, applied: agentToolChanges, warnings: [], ...(appliedAgentTool === undefined ? {} : { agentTool: appliedAgentTool }) };
    }

    // id の綴りの揺れ（`source-e_stat` と `source-e-stat`、`region_input_node` の `_`）は、実測（12B）で
    // 差し戻しても直らなかった機械的な書き間違い。適用の直前に決定的に揃える（ADR-0047 の正規化と同じ判断）。
    const canonical = canonicalizeOperationIds(graphOperations, input.graph.nodes.map((node) => node.id));
    let edited: { graph: ToolGraph; applied: readonly GraphChange[] };
    try {
      edited = applyGraphOperations(input.graph, canonical);
    } catch (error) {
      if (error instanceof GraphEditError) return { ok: false, stage: 'apply', problems: [error.message] };
      throw error;
    }

    // 機械的な書き間違い（`toInput` の欠落・型名の揺れ・`value`/`values`）は差し戻す前に直す（ADR-0047）。
    const dataSourceIds = referencedDataSourceIds(edited.graph);
    const normalized = normalizeProposedGraph(edited.graph, {
      primaryDataSourceId: dataSourceIds[0] ?? '',
      profiles: context.rawProfiles,
      dataSourceIds,
      knownNodeTypes: DESIGN_NODE_TYPES,
    });
    const graph = normalized.graph;

    let executable = graph;
    if (this.resolveDataSources !== undefined) {
      try {
        executable = await this.resolveDataSources.execute(input.scope, graph);
      } catch (error) {
        return { ok: false, stage: 'preview', problems: [`the data sources of this tool cannot be read: ${describe(error)}`] };
      }
    }

    let problems: string[];
    let propagation: PropagationResult;
    try {
      propagation = this.engine.propagateSchemas(executable);
      problems = Object.values(propagation.nodes).flatMap((inference) =>
        inference.issues.filter((issue) => issue.severity === 'error').map((issue) => `node '${inference.nodeId}': ${issue.message}`));
    } catch (error) {
      return { ok: false, stage: 'schema', problems: [`the tool graph is not valid: ${describe(error)}`] };
    }
    if (problems.length > 0) return { ok: false, stage: 'schema', problems };

    let preview: PreviewResult;
    try {
      // `agent-input` の見本がそのまま引数になるので、「設計時は通るのに呼ぶと落ちる」を先に潰せる。
      preview = this.engine.preview(executable, { rowLimit: CHECK_PREVIEW_ROWS, retainTables: true });
    } catch (error) {
      return { ok: false, stage: 'preview', problems: [`the design-time preview failed: ${describe(error)}`] };
    }

    // 検証は通るのに答えが間違う形（意味の検査）。実測で 12B が繰り返した 2 つだけを見る。
    const semantic = describeSemanticProblems(graph, executable, propagation, preview, context.rawProfiles);
    if (semantic.hard.length > 0) return { ok: false, stage: 'semantic', problems: [...semantic.hard, ...semantic.soft] };
    if (semantic.soft.length > 0 && !tolerateSoft) return { ok: false, stage: 'semantic', problems: semantic.soft };
    // 説明文の変更は一覧の最後に並べる（グラフの変更は操作の順、説明文はそのあと）。
    return {
      ok: true, graph, applied: [...edited.applied, ...agentToolChanges], warnings: semantic.soft,
      ...(appliedAgentTool === undefined ? {} : { agentTool: appliedAgentTool }),
    };
  }

  /**
   * 材料を集める（契約 §6-1）。
   *
   * 材料の失敗（データソースが読めない・プレビューが落ちる）は**止める理由にならない**:
   * 落ちているグラフを直してほしい、という指示こそ来るため。欠けた材料は外し、
   * 何が分からなかったかだけをモデルへ伝える。
   */
  private async gather(input: DesignToolChatInput, signal?: AbortSignal): Promise<DesignContext> {
    const warnings: string[] = [];
    const schemasByNode: Record<string, Schema> = {};
    let terminalSample: DesignContext['terminalSample'];

    let executable = input.graph;
    if (this.resolveDataSources !== undefined) {
      try {
        executable = await this.resolveDataSources.execute(input.scope, input.graph);
      } catch (error) {
        warnings.push(`the data sources of the current graph could not be read: ${describe(error)}`);
      }
    }
    try {
      const propagation = this.engine.propagateSchemas(executable);
      for (const [nodeId, inference] of Object.entries(propagation.nodes)) schemasByNode[nodeId] = inference.schema;
    } catch (error) {
      warnings.push(`the current graph has no column schemas yet: ${describe(error)}`);
    }
    try {
      const preview = this.engine.preview(executable, { rowLimit: CONTEXT_PREVIEW_ROWS });
      terminalSample = { nodeId: preview.terminalId, rows: preview.output.rows as readonly Record<string, unknown>[] };
    } catch (error) {
      warnings.push(`the current graph cannot be previewed: ${describe(error)}`);
    }

    const dataSources: DesignChatDataSource[] = [];
    if (this.queryDataSources !== undefined) {
      try {
        for (const source of await this.queryDataSources.list(input.scope)) {
          dataSources.push({
            dataSourceId: source.id,
            name: source.name,
            kind: source.kind,
            ...(source.kind === 'file' ? { format: source.format } : {}),
          });
        }
      } catch (error) {
        warnings.push(`the registered data sources could not be listed: ${describe(error)}`);
      }
    }

    // グラフが参照しているソースを先に、続けて一覧の先頭から埋めて上限まで（空のキャンバスから
    // 作るときは参照が 0 件なので、一覧側が「どんな列があるか」の唯一の材料になる）。
    const referenced = referencedDataSourceIds(input.graph);
    const listed = dataSources.filter((source) => source.kind === 'file').map((source) => source.dataSourceId);
    const wanted: string[] = [];
    for (const id of [...referenced, ...listed]) {
      if (!wanted.includes(id) && wanted.length < MAX_PROFILES) wanted.push(id);
    }

    const rawProfiles: DataProfile[] = [];
    if (this.profileDataSources !== undefined) {
      for (const dataSourceId of wanted) {
        if (signal?.aborted === true) break;
        try {
          rawProfiles.push(await this.profileDataSources.execute(input.scope, dataSourceId as DataSourceId));
        } catch (error) {
          warnings.push(`the data source '${dataSourceId}' could not be profiled: ${describe(error)}`);
        }
      }
    }

    return { schemasByNode, ...(terminalSample === undefined ? {} : { terminalSample }), dataSources, profiles: rawProfiles.map(profileForPrompt), rawProfiles, warnings };
  }

  /**
   * モデルへの 1 往復。中断はそのまま通し、それ以外の失敗は ModelProviderError に包む。
   * `usage` も一緒に返すのは、応答に載せるのが**直前の呼び出し**の消費だから（契約 §3.2）。
   */
  private async ask(request: ModelCompletionRequest, signal?: AbortSignal): Promise<{ readonly content: string; readonly usage?: ModelUsage }> {
    try {
      const completion = await this.model.complete(request, signal);
      return { content: completion.message.content ?? '', ...(completion.usage === undefined ? {} : { usage: completion.usage }) };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError(`design assistant could not reach the model: ${describe(error)}`, error);
    }
  }
}

/** JSON でない応答は差し戻さずに失敗させる（構造化出力の約束が守られていない）。 */
function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ModelProviderError('design assistant returned invalid JSON', error);
  }
}

function invalidResponse(error: z.ZodError): ModelProviderError {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return new ModelProviderError(`design assistant returned an invalid response: ${issues}`);
}

/** 圧縮の応答（`{ summary }`）を読む。要約が無い / 空白だけのときは空文字（呼び手が 1 回だけ問い直す）。 */
function parseSummary(content: string): string {
  const parsed = summarySchema.safeParse(parseJson(content));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data.summary.trim();
}

/** 応答を読む。形が違うのは差し戻さずに失敗させる（構造化出力の約束が守られていない）。 */
function parseResponse(content: string): { message: string; operations: readonly DesignChatOperation[] } {
  const parsed = responseSchema.safeParse(parseJson(content));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  // 各操作に要る項目の検査は domain（`applyGraphOperations`）と `agentToolViolation` が持つ。ここは形だけを見る。
  return { message: parsed.data.message, operations: parsed.data.operations as readonly DesignChatOperation[] };
}

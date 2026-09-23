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
 *
 * ここに置くのは材料集め・プロンプト・適用と検査の段取りだけ（v50 R2）。意味の検査の規則は `design-rules.ts`
 * （Factory と共有）、`set-agent-tool` は `design-chat-agent-tool.ts`、会話の圧縮は `design-chat-compact.ts`、
 * モデルとの 1 往復は `design-chat-model.ts`。
 */
import { z } from 'zod';
import type { Schema } from '../../domain/data/types';
import type { DataSourceId } from '../../domain/data-source/ids';
import { GraphEditError, applyGraphOperations, canonicalizeOperationIds, type GraphChange } from '../../domain/etl/graph-edit';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import { isRecord } from '../../domain/shared/assert';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { QueryDataSourcesUseCase } from '../data-source/manage-data-sources';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';
import type { DataProfile, ProfileDataSourcesUseCase } from '../factory/profile-data-sources';
import { normalizeProposedGraph } from '../factory/normalize-tool-graph';
import { ModelProviderError, type ModelProviderPort } from '../model/model-provider';
import type { PromptCatalogPort } from '../prompt/prompt-catalog-port';
import { splitAgentToolOperations, type AgentToolChange, type DesignChatOperation } from './design-chat-agent-tool';
import { compactDesignChat, type DesignChatCompactInput, type DesignChatCompactResult } from './design-chat-compact';
import { askDesignModel, describe, invalidResponse, parseJson, usageOf, type DesignChatUsage } from './design-chat-model';
import {
  DESIGN_CHAT_PROMPT,
  buildDesignChatRepairRequest,
  buildDesignChatRequest,
  limitTranscript,
  type DesignChatAgentTool,
  type DesignChatDataSource,
  type DesignChatProfile,
  type DesignChatRepairFeedback,
  type DesignChatTurn,
} from './design-chat-prompt';
import { describeDesignProblems } from './design-rules';
import { DATA_SOURCE_NODE_TYPES, DESIGN_NODE_TYPES } from './node-catalog';

export type { DesignChatAgentTool, DesignChatCompactTurn, DesignChatTurn } from './design-chat-prompt';
export type { AgentToolChange } from './design-chat-agent-tool';
export type { DesignChatCompactInput, DesignChatCompactResult } from './design-chat-compact';
export type { DesignChatUsage } from './design-chat-model';

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

/** 変更一覧 1 件（グラフの変更か、Tool Calling 契約の変更か）。 */
export type DesignChatChange = GraphChange | AgentToolChange;

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

/** グラフが参照しているデータソース id（出現順・重複なし）。 */
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

    let answer = await askDesignModel(this.model, request, signal);
    let parsed = parseResponse(answer.content);
    // 操作が無い応答は「質問への回答」か「聞き返し」。検分するものが無いので、そのまま返す（契約 §3）。
    if (parsed.operations.length === 0) return this.answer(await usageOf(this.model, answer), parsed.message, false, []);

    let attempt = await this.applyAndCheck(input, parsed.operations, context, false);
    if (attempt.ok) return this.applied(await usageOf(this.model, answer), parsed.message, attempt, input.graph, false);

    // 差し戻しは 1 回だけ（ADR-0046 と同じ。往復を重ねるより、人が指示を直す方が速い）。
    const repair = buildDesignChatRepairRequest(this.prompts, request, answer.content, { stage: attempt.stage, problems: attempt.problems });
    // 消費は**直前の呼び出し**のもの（契約 §3）。差し戻した回の値の方が、次のターンの目安に近い。
    answer = await askDesignModel(this.model, repair, signal);
    parsed = parseResponse(answer.content);
    if (parsed.operations.length === 0) return this.answer(await usageOf(this.model, answer), parsed.message, true, [], attempt.problems);

    // 2 回目は柔らかい問題を許す（差し戻しは 1 回まで。直らなければ警告つきで適用する）。
    const retried = await this.applyAndCheck(input, parsed.operations, context, true);
    if (retried.ok) return this.applied(await usageOf(this.model, answer), parsed.message, retried, input.graph, true, attempt.problems);
    // 2 回目も通らなかった: **元のグラフには触らず**、説明と理由だけ返す（HTTP は 200）。
    return this.answer(await usageOf(this.model, answer), parsed.message, true, retried.problems, attempt.problems);
  }

  /**
   * 会話の古いターンを、次のターンで読む覚え書きへ畳む（v49 §3.1）。中身は `design-chat-compact.ts`。
   * ここに残すのは、API と root の配線を変えないためと、使えるかどうかの判定を 1 ターンと揃えるため。
   */
  async compact(input: DesignChatCompactInput, signal?: AbortSignal): Promise<DesignChatCompactResult> {
    if (!(await this.available())) throw new ModelProviderError('design assistant is not configured');
    return compactDesignChat(this.model, this.prompts, input, signal);
  }

  private answer(usage: DesignChatUsage | undefined, message: string, repaired: boolean, problems: readonly string[], repairedFrom?: readonly string[]): DesignToolChatResult {
    return {
      message, changes: [], repaired, problems, warnings: [], promptTemplateVersion: this.promptVersion(),
      ...(usage === undefined ? {} : { usage }),
      ...(repairedFrom === undefined ? {} : { repairedFrom }),
    };
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
    const split = splitAgentToolOperations(operations, input.agentTool);
    if (!split.ok) return { ok: false, stage: 'apply', problems: [split.problem] };
    const { graphOperations, changes: agentToolChanges, agentTool: appliedAgentTool } = split;

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

    // 検証は通るのに答えが間違う形（意味の検査。規則は Factory と共有する `design-rules.ts`）。
    const semantic = describeDesignProblems({ graph, executable, propagation, preview, profiles: context.rawProfiles, dataSourceIds });
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
}

/** 応答を読む。形が違うのは差し戻さずに失敗させる（構造化出力の約束が守られていない）。 */
function parseResponse(content: string): { message: string; operations: readonly DesignChatOperation[] } {
  const parsed = responseSchema.safeParse(parseJson(content));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  // 各操作に要る項目の検査は domain（`applyGraphOperations`）と `design-chat-agent-tool.ts` が持つ。ここは形だけを見る。
  return { message: parsed.data.message, operations: parsed.data.operations as readonly DesignChatOperation[] };
}

/**
 * 応用層: 設計アシスタントのプロンプト（v47 実装契約 §4・§6 / ADR-0051 決定 5）。
 *
 * モデルは呼ばない純関数だけを置く（文面を単体で固定できるようにするため）。
 * 呼び出し・検分・差し戻し 1 回は `design-tool-chat.ts` が持つ。
 *
 * 信頼境界: system には**規則とカタログだけ**を置き、**指示文も会話も**
 * `<untrusted-data>` の中（`wrapUntrusted`）へ入れる。利用者の指示であっても、
 * そこにデータソースの値や過去の応答が混ざりうる以上、system 側の規則と同じ強さで
 * 扱ってはならない（ADR-0033 以来の規律を ADR-0051 決定 5 が再確認した）。
 */
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { ModelProviderError, type JsonSchemaObject, type ModelCompletionRequest, type ModelRequestMessage } from '../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../prompt/prompt-catalog-port';
import { wrapUntrusted } from '../factory/roles/untrusted';
import { nodeCatalogText } from './node-catalog';

/**
 * 文の置き場所（v48 / ADR-0052）。版（`design-chat/v3`）はファイルの frontmatter が正。
 * 差し戻しの見出しは段ごとに入れ替わるので、条件ではなく節を分けてコードで選ぶ。
 * ノードカタログは domain の正準リストから語彙を組むのでコードに残し、`{{nodeCatalog}}` で差し込む。
 */
export const DESIGN_CHAT_PROMPT: PromptSpec = {
  id: 'tool/design-chat',
  sections: ['system', 'repair.apply', 'repair.schema', 'repair.preview', 'repair.semantic', 'repair.instructions'],
};

/**
 * 会話の圧縮（v49 §3.1）の文。節は 2 つだけ:
 * `system`（何を残し何を落とすか）と `repair.shorten`（長すぎた要約を書き直させる）。
 */
export const DESIGN_CHAT_COMPACT_PROMPT: PromptSpec = {
  id: 'tool/design-chat-compact',
  sections: ['system', 'repair.shorten'],
};

/** モデルへ送る会話の上限（契約 §7: 画面も同じ数で切る）。古い順に落とす。 */
export const DESIGN_CHAT_MAX_TURNS = 12;

/**
 * 要約の長さの上限（v49 §3.1）。文にも検査にも同じ数を使うので、差し込み（`{{maxCharacters}}`）で
 * ファイルへ渡す（文とコードで別々の数を持つと、片方だけ直されたときに黙ってずれる）。
 */
export const DESIGN_CHAT_SUMMARY_MAX_CHARS = 800;

/** 会話 1 ターン（`role` と `content` だけ。変更一覧は送らない）。 */
export interface DesignChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * いまの Tool Calling 契約（v49 §3）。画面のメタデータそのもので、どちらの項目も未記入でありうる。
 *
 * 説明文はエージェントが呼ぶ前に読む唯一の文なので、材料として毎ターン見せる
 * （見せないと `set-agent-tool` が「いま何が書いてあるか」を知らないまま上書きすることになる）。
 */
export interface DesignChatAgentTool {
  readonly name?: string;
  readonly description?: string;
}

/** プロンプトに載せるデータソース 1 件（一覧用の最小の面）。 */
export interface DesignChatDataSource {
  readonly dataSourceId: string;
  readonly name: string;
  readonly kind: 'file' | 'database';
  readonly format?: 'csv' | 'json';
}

/** プロンプトに載せるプロファイル 1 件（列・型・期間列・カテゴリ列）。 */
export interface DesignChatProfile {
  readonly dataSourceId: string;
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
  readonly rowCount: number;
  readonly periodColumns: readonly unknown[];
  readonly categoricalColumns: readonly unknown[];
  readonly sampleRows: readonly Record<string, unknown>[];
}

export interface DesignChatPromptInput {
  readonly instruction: string;
  readonly graph: ToolGraph;
  /** nodeId → そのノードの出力列（スキーマ伝播が取れたノードだけ）。 */
  readonly schemasByNode: Readonly<Record<string, Schema>>;
  /** 終端の設計時プレビュー（取れなかったときは省略する。材料が欠けても止めない）。 */
  readonly terminalSample?: { readonly nodeId: string; readonly rows: readonly Record<string, unknown>[] };
  /** 登録済みデータソースの一覧（id・名前・形式）。 */
  readonly dataSources: readonly DesignChatDataSource[];
  /** グラフが参照するソース + 先頭数件のプロファイル。 */
  readonly profiles: readonly DesignChatProfile[];
  /** 画面が持つ直近の会話（古い順）。呼び手が既に上限へ切る。 */
  readonly transcript: readonly DesignChatTurn[];
  /** 畳んだ古い会話（画面が作る要約。payload では `earlierConversationSummary`）。 */
  readonly transcriptSummary?: string;
  /** いまの Tool Calling 契約（`set-agent-tool` が書き換える対象）。 */
  readonly agentTool?: DesignChatAgentTool;
  /** `agent-input` の宣言（本文で渡されたときだけ。無ければグラフから読む）。 */
  readonly inputSchema?: Schema;
  /** 材料を集める途中で落ちたこと（プレビューが通らない等）。モデルには「分からない」として伝える。 */
  readonly contextWarnings?: readonly string[];
}

/** 畳むターン 1 件（v49 §3.1）。適用した変更の要約も材料に入れる（何をしたかの正確な記録）。 */
export interface DesignChatCompactTurn {
  readonly user: string;
  readonly assistant?: string;
  readonly changes: readonly string[];
}

export interface DesignChatCompactPromptInput {
  /** 前回までの要約（あれば新しい要約へ畳み込ませる）。 */
  readonly previousSummary?: string;
  /** 畳む古いターン（古い順）。 */
  readonly turns: readonly DesignChatCompactTurn[];
  /** 要約を書く言語（画面が選ぶ。自由文ではないので材料に載せても指示にはならない）。 */
  readonly language: 'ja' | 'en';
}

/** 差し戻しの材料（1 回だけ）。 */
export interface DesignChatRepairFeedback {
  /** 適用・正規化・伝播・プレビューのどこで落ちたか。 */
  readonly stage: 'apply' | 'schema' | 'preview' | 'semantic';
  readonly problems: readonly string[];
}

const RESPONSE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'operations'],
  properties: {
    message: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['add-node', 'remove-node', 'set-config', 'connect', 'disconnect', 'set-agent-tool'] },
          id: { type: 'string' },
          type: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
          after: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          toInput: { type: 'number' },
          // `set-agent-tool` の 2 つ。strict なスキーマでは宣言しない項目は書けないので、ここに要る。
          description: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
};

/**
 * system プロンプト。規則は ADR-0047 で実測的に効いた言い回しを流用する
 * （期間列は parse-period、引数は agent-input + valueBinding、出力は sort + limit で縛る）。
 * ノードカタログだけはコードが持つ（domain の正準リストから語彙を組むため）。
 */
export function designChatSystemPrompt(prompts: PromptCatalogPort): string {
  return prompts.get(DESIGN_CHAT_PROMPT.id).render('system', { nodeCatalog: nodeCatalogText() });
}

/** 列の写し（判定に使う 3 つだけを渡す。内部表現をモデルへ見せない）。 */
function schemaForPrompt(schema: Schema | undefined): { readonly columns: readonly { name: string; type: string; nullable: boolean }[] } {
  const columns = Array.isArray(schema?.columns) ? schema.columns : [];
  return { columns: columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })) };
}

/** 会話を直近 `DESIGN_CHAT_MAX_TURNS` ターンへ切る（古い順を保ったまま末尾を残す）。 */
export function limitTranscript(transcript: readonly DesignChatTurn[] | undefined): readonly DesignChatTurn[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.slice(-DESIGN_CHAT_MAX_TURNS).map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * 未記入の項目を落とした Tool Calling 契約（空の名前・空の説明文は「無い」と同じ）。
 * 何も残らなければ undefined を返し、payload へは載せない（空のオブジェクトは文脈を食うだけ）。
 */
function agentToolForPrompt(agentTool: DesignChatAgentTool | undefined): DesignChatAgentTool | undefined {
  if (agentTool === undefined) return undefined;
  const name = typeof agentTool.name === 'string' && agentTool.name.trim() !== '' ? agentTool.name : undefined;
  const description = typeof agentTool.description === 'string' && agentTool.description.trim() !== '' ? agentTool.description : undefined;
  if (name === undefined && description === undefined) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) };
}

/** user メッセージの中身（すべて untrusted data）。 */
export function designChatPayload(prompts: PromptCatalogPort, input: DesignChatPromptInput): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [nodeId, schema] of Object.entries(input.schemasByNode)) schemas[nodeId] = schemaForPrompt(schema);
  const agentTool = agentToolForPrompt(input.agentTool);
  const summary = typeof input.transcriptSummary === 'string' && input.transcriptSummary.trim() !== '' ? input.transcriptSummary : undefined;
  return {
    promptTemplateVersion: prompts.get(DESIGN_CHAT_PROMPT.id).version,
    instruction: input.instruction,
    // 要約は会話の**前**に置く（古い順の並びをそのまま保つ）。中身は畳んだ会話なので、当然 untrusted。
    ...(summary === undefined ? {} : { earlierConversationSummary: summary }),
    transcript: limitTranscript(input.transcript),
    ...(agentTool === undefined ? {} : { agentTool }),
    graph: {
      // position は設計の判断に要らない情報で、文脈を食うだけなので落とす（返す側でも書かせない）。
      nodes: input.graph.nodes.map((node) => ({ id: node.id, type: node.type, config: node.config })),
      edges: input.graph.edges,
    },
    schemasByNode: schemas,
    ...(input.inputSchema === undefined ? {} : { inputSchema: schemaForPrompt(input.inputSchema) }),
    ...(input.terminalSample === undefined ? {} : { terminalSample: input.terminalSample }),
    dataSources: input.dataSources,
    profiles: input.profiles,
    ...(input.contextWarnings === undefined || input.contextWarnings.length === 0 ? {} : { unavailable: input.contextWarnings }),
  };
}

/** 初回の要求。temperature 0、strict な JSON スキーマ（式提案・ToolSmith と同じ流儀）。 */
export function buildDesignChatRequest(prompts: PromptCatalogPort, input: DesignChatPromptInput): ModelCompletionRequest {
  // 呼び手（ユースケース）でも弾くが、プロンプトだけを組む経路から空の指示が入るのも止める。
  if (typeof input.instruction !== 'string' || input.instruction.trim() === '') {
    throw new ModelProviderError('design assistant requires an instruction');
  }
  const messages: readonly ModelRequestMessage[] = [
    { role: 'system', content: designChatSystemPrompt(prompts) },
    { role: 'user', content: wrapUntrusted('tool-design-input', designChatPayload(prompts, input)) },
  ];
  return {
    messages,
    temperature: 0,
    responseFormat: { name: 'tool_design_operations', strict: true, schema: RESPONSE_SCHEMA },
  };
}

/** 差し戻しの本文。何が落ちたかと、「操作は元のグラフに対して書き直す」を必ず言う。 */
function repairContent(prompts: PromptCatalogPort, feedback: DesignChatRepairFeedback): string {
  const template = prompts.get(DESIGN_CHAT_PROMPT.id);
  return [
    template.render(`repair.${feedback.stage}`),
    JSON.stringify({ problems: feedback.problems }),
    template.render('repair.instructions'),
  ].join('\n');
}

const SUMMARY_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

/** 圧縮の材料（すべて untrusted data）。会話そのものなので、隔離の扱いは 1 ターンの payload と同じ。 */
export function designChatCompactPayload(input: DesignChatCompactPromptInput): Record<string, unknown> {
  const previousSummary = typeof input.previousSummary === 'string' && input.previousSummary.trim() !== '' ? input.previousSummary : undefined;
  return {
    language: input.language,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    turns: input.turns.map((turn) => ({
      user: turn.user,
      ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }),
      changes: turn.changes,
    })),
  };
}

/** 圧縮の初回の要求。temperature 0（同じ会話からは同じ覚え書きが出るべき）。 */
export function buildDesignChatCompactRequest(prompts: PromptCatalogPort, input: DesignChatCompactPromptInput): ModelCompletionRequest {
  return {
    messages: [
      { role: 'system', content: prompts.get(DESIGN_CHAT_COMPACT_PROMPT.id).render('system', { maxCharacters: DESIGN_CHAT_SUMMARY_MAX_CHARS }) },
      { role: 'user', content: wrapUntrusted('tool-design-compact-input', designChatCompactPayload(input)) },
    ],
    temperature: 0,
    responseFormat: { name: 'tool_design_conversation_summary', strict: true, schema: SUMMARY_SCHEMA },
  };
}

/**
 * 長すぎた要約の差し戻し（1 回だけ）。**末尾を切らずに書き直させる**のは、切ると
 * 「未解決の質問」のような最後に来る要点だけが落ちるため（v49 §3.1）。
 */
export function buildDesignChatShortenRequest(prompts: PromptCatalogPort, first: ModelCompletionRequest, assistantContent: string): ModelCompletionRequest {
  return {
    ...first,
    messages: [
      ...first.messages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: prompts.get(DESIGN_CHAT_COMPACT_PROMPT.id).render('repair.shorten', { maxCharacters: DESIGN_CHAT_SUMMARY_MAX_CHARS }) },
    ],
  };
}

/** 修復回の要求。初回の messages を先頭に保ち、assistant 応答と差し戻しの user メッセージを足す。 */
export function buildDesignChatRepairRequest(
  prompts: PromptCatalogPort,
  first: ModelCompletionRequest,
  assistantContent: string,
  feedback: DesignChatRepairFeedback,
): ModelCompletionRequest {
  return {
    ...first,
    messages: [
      ...first.messages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: repairContent(prompts, feedback) },
    ],
  };
}

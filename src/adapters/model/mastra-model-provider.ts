/**
 * adapters層: @mastra/core のモデルルーターに「通信」だけを委譲する ModelProviderPort 実装。
 *
 * ベンダー分岐（各プロバイダのwire形式・認証・エンドポイント）は Mastra の
 * registry / gateway 側に閉じ込め、本アダプタは
 *   ModelCompletionRequest ↔ AI SDK v2 (LanguageModelV2) の型変換
 *   ＋ 二段タイムアウト ＋ ModelProviderError への正規化
 * だけを担う。外部SDK(@mastra/*)への依存は本アダプタ内に隔離する（depcruise）。
 */
// env は @mastra/core の評価より前に確定させる必要がある。import は記述順に評価されるため
// この行は必ず '@mastra/core/*' より前に置く（並べ替え禁止。詳細は src/mastra-runtime-env.ts）。
import '../../mastra-runtime-env';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRouterLanguageModel, modelSupportsAttachments } from '@mastra/core/llm';
import {
  ModelProviderError,
  type JsonObject,
  type ModelCapability,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelContentPart,
  type ModelRequestMessage,
  type ModelToolCall,
  type ModelUsage,
  type ModelProviderPort,
} from '../../application/model/model-provider';

/** OpenAI互換のカスタムエンドポイント（LM Studio・vLLM 等）を直接指す設定。 */
export interface MastraOpenAiCompatibleModel {
  /** `'provider/model'` 形式。url 指定時 provider 部はラベルとしてのみ使われる。 */
  readonly id: string;
  readonly url?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MastraModelProviderOptions {
  /** `'openai/gpt-4o'` 形式の文字列、または OpenAI互換 `{ id, url, apiKey, headers }`。 */
  readonly model: string | MastraOpenAiCompatibleModel;
  /** 総時間の上限（ms）。推論モデルは長時間生成し続けるため、ハング検知は idleTimeoutMs が担う。 */
  readonly timeoutMs?: number;
  /** ストリームパートが1つも来ない状態が続いたら打ち切る（ms）。パート受信ごとにリセットする。 */
  readonly idleTimeoutMs?: number;
  /** 指定時のみ maxOutputTokens をリクエストへ含める（推論の暴走を抑える）。 */
  readonly maxTokens?: number;
  /** 既定の capabilities を上書きする。 */
  readonly capabilities?: readonly ModelCapability[];
}

// AI SDK v2 の型は @mastra/core の内部パス（dist/_types/**）にしか無いため、
// 公開クラスのシグネチャから引き出して深いimportを避ける。
type CallOptions = Parameters<ModelRouterLanguageModel['doStream']>[0];
type StreamResult = Awaited<ReturnType<ModelRouterLanguageModel['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
type PromptMessage = CallOptions['prompt'][number];
type UserContentPart = Extract<PromptMessage, { role: 'user' }>['content'][number];
type AssistantContentPart = Extract<PromptMessage, { role: 'assistant' }>['content'][number];
type ModelTool = NonNullable<CallOptions['tools']>[number];
type FinishPart = Extract<StreamPart, { type: 'finish' }>;

const DEFAULT_CAPABILITIES: readonly ModelCapability[] = ['chat', 'tool-calling', 'structured-output', 'vision'];
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_DETAIL_CHARS = 300;
/** `data:<mediaType>;base64,<payload>` のみ分解する（それ以外は URL としてそのまま渡す）。 */
const BASE64_DATA_URL = /^data:([^;,]+);base64,(.*)$/s;
/**
 * モデル名が空のときの文言。UI側のエラー変換に頼らず、これ単体で次の行動が分かる英文にする
 * （`'local/'` のような内部表現を見せた「'provider/model' 形式ではない」は原因が伝わらない）。
 */
const MODEL_NOT_CONFIGURED =
  'Model is not configured. Choose a model in model settings, or set the LM_STUDIO_MODEL environment variable.';
/**
 * ストリームに実質的な出力が1つも無かったときの文言。
 * 空SSE・即 `[DONE]`・プロキシの空応答を「空文字の成功」で確定させないための番人。
 */
const NO_COMPLETION_CHOICE = 'Model stream returned no completion choice';
/** 「モデルの出力」ではない制御パート。これしか来なければ応答が空だったと判定する。 */
const CONTROL_PART_TYPES: ReadonlySet<string> = new Set(['stream-start', 'response-metadata', 'finish', 'error', 'raw']);

interface RouterModelId {
  readonly providerId: string;
  readonly modelId: string;
}

// ---------------------------------------------------------------------------
// ワイヤ補正: Mastra が OpenAI互換プロバイダへ渡さない2つの設定を後付けする
//
// 調査結果（@mastra/core 1.50.x 同梱の @ai-sdk/openai-compatible 1.0.39）:
//  - `ModelRouterLanguageModel` のコンストラクタは `{id|providerId+modelId, url, apiKey, headers}`
//    だけを転記する**ホワイトリスト**で、`fetch` も `includeUsage` も受け付けない。
//  - Mastra は `createOpenAICompatible({name, apiKey, baseURL, headers, supportsStructuredOutputs})`
//    しか渡さないため、`stream_options.include_usage` が**常に送られない**
//    （= usageチャンクが来ない = ModelCompletion.usage が undefined = コスト集計が無言で消える）。
//  - `providerOptions` 経由の裏道も使えない。doStream は `{...args, stream:true, stream_options: …}`
//    の順で組むので、args へ差し込んだ `stream_options` は undefined で上書きされる。
//  - `responseFormat.strict` は AI SDK v2 の型自体に存在せず、openai-compatible の
//    `response_format.json_schema` にも `strict` は載らない。
//
// そこで「Mastra が解決した**内側のモデル**の config」に、そのライブラリ自身が読む設定
// （`includeUsage` / `transformRequestBody`）を後付けする。ワイヤ形式ではなく
// openai-compatible の公開オプションに乗るので、素のボディ改造より意図が明確に残る。
// 適用先は url 指定（= 必ず openai-compatible に落ちる経路）に限定する。登録簿モデルは
// ネイティブSDK（@ai-sdk/openai 等）へ解決され、include_usage も strict も既定で送られる。
// ---------------------------------------------------------------------------

/** 解決済みモデルが持つ config のうち、本アダプタが後付けする部分だけの視界。 */
interface TunableModelConfig {
  includeUsage?: boolean;
  transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/** 1回の complete() に紐づく補正指示。complete() は並行に走るのでインスタンス変数では持てない。 */
interface RequestTuning {
  /** `response_format.json_schema.strict` へ載せる値。responseFormat 未指定なら undefined。 */
  readonly strict: boolean | undefined;
}

const requestTuning = new AsyncLocalStorage<RequestTuning>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 送信直前のボディを補正する（openai-compatible の `transformRequestBody` フック）。
 * - `stream_options.include_usage`: ストリーム要求なら必ず付ける（usage欠落の根治）。
 * - `response_format.json_schema.strict`: Port の指定をワイヤへ戻す。
 * 想定と違う形をしていたら何もしない（素通し）。
 */
function tuneRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const tuned: Record<string, unknown> = { ...body };
  if (tuned['stream'] === true) tuned['stream_options'] = { include_usage: true };
  const strict = requestTuning.getStore()?.strict;
  const format = tuned['response_format'];
  if (strict !== undefined && isRecord(format) && format['type'] === 'json_schema' && isRecord(format['json_schema'])) {
    tuned['response_format'] = { ...format, json_schema: { ...format['json_schema'], strict } };
  }
  return tuned;
}

/**
 * Mastra が解決した内側のモデルへ補正を差し込む。
 * 形が想定と違う（Mastra の内部構造が変わった）場合は黙って諦める — その時は
 * 「include_usage がボディに入ること」を固定した単体テストが落ちて気付ける。
 */
function tuneResolvedModel<T>(model: T): T {
  const config = (model as { config?: unknown } | null)?.config;
  if (!isRecord(config)) return model;
  const tunable = config as TunableModelConfig;
  tunable.includeUsage = true;
  tunable.transformRequestBody = tuneRequestBody;
  return model;
}

/**
 * `resolveLanguageModel`（Mastra内部のモデル解決）をインスタンス単位で包み、
 * 解決されたモデルへ補正を差し込む。プロトタイプではなく**自身のプロパティ**を生やすので
 * 他の ModelRouterLanguageModel には影響しない。
 */
function withTunedModelResolution(router: ModelRouterLanguageModel): ModelRouterLanguageModel {
  type Resolve = (args: unknown) => Promise<unknown>;
  const holder = router as unknown as { resolveLanguageModel?: Resolve };
  const original = holder.resolveLanguageModel;
  if (typeof original !== 'function') return router;
  holder.resolveLanguageModel = async (args: unknown): Promise<unknown> => tuneResolvedModel(await original.call(router, args));
  return router;
}

interface ToolCallDraft {
  name?: string;
  /** ストリーム中は断片の連結、`tool-call` パート受信時は確定した全文で置き換える。 */
  args: string;
}

interface StreamState {
  readonly content: string[];
  /** tool call id をキーにした挿入順の下書き（AI SDK v2 は index ではなく id で束ねる）。 */
  readonly toolCalls: Map<string, ToolCallDraft>;
  finishReason: FinishPart['finishReason'] | undefined;
  usage: FinishPart['usage'] | undefined;
  error: unknown | undefined;
  /**
   * 制御パート以外（本文・推論・ツール）を1つでも受け取ったか。
   * `finish` パートは choice が1つも無くても必ず出るため、これが false のまま終わったら
   * 「空の成功」ではなく失敗として扱う。
   */
  received: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `'provider/model'` を最初の `/` で分解する。ネストしたIDは modelId 側に残す。
 *
 * モデル名だけが空（`''` / `'local/'`）のときは「未設定」として扱い、形式エラーではなく
 * 設定を促す文言で失敗させる。工場が付ける擬似接頭辞（`local/`）が利用者に見えると
 * 「何を直せばよいか」が伝わらないため。
 */
function splitModelId(id: string): RouterModelId {
  const trimmed = id.trim();
  if (trimmed === '') throw new ModelProviderError(MODEL_NOT_CONFIGURED);
  const slash = trimmed.indexOf('/');
  const providerId = slash > 0 ? trimmed.slice(0, slash) : '';
  const modelId = slash > 0 ? trimmed.slice(slash + 1).trim() : '';
  if (providerId !== '' && modelId === '') throw new ModelProviderError(MODEL_NOT_CONFIGURED);
  if (providerId === '' || modelId === '') {
    throw new ModelProviderError(`Model id must be in 'provider/model' form, but got '${trimmed}'`);
  }
  return { providerId, modelId };
}

function textOf(content: ModelRequestMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<ModelContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** 画像参照を AI SDK v2 の file パートへ写す。base64 data URL は mediaType を保って分解する。 */
function toFilePart(imageUrl: string): UserContentPart {
  const parsed = BASE64_DATA_URL.exec(imageUrl);
  if (parsed !== null) {
    return { type: 'file', mediaType: parsed[1] ?? 'image/*', data: parsed[2] ?? '' };
  }
  try {
    return { type: 'file', mediaType: 'image/*', data: new URL(imageUrl) };
  } catch (error) {
    throw new ModelProviderError('Model request contains an unsupported image reference', error);
  }
}

function toUserContent(content: ModelRequestMessage['content']): UserContentPart[] {
  if (content === null) return [{ type: 'text', text: '' }];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : toFilePart(part.imageUrl));
}

function toAssistantContent(message: ModelRequestMessage): AssistantContentPart[] {
  const parts: AssistantContentPart[] = [];
  const text = textOf(message.content);
  if (text !== '') parts.push({ type: 'text', text });
  for (const call of message.toolCalls ?? []) {
    parts.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.arguments });
  }
  return parts;
}

/**
 * ModelRequestMessage[] を AI SDK v2 の prompt へ写す。
 * tool結果パートは toolName が必須だが我々のPortは持たないため、
 * 直前までの assistant tool call から引き当てる（wire上は tool_call_id しか使われない）。
 */
function toPrompt(messages: readonly ModelRequestMessage[]): PromptMessage[] {
  const toolNames = new Map<string, string>();
  const prompt: PromptMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      prompt.push({ role: 'system', content: textOf(message.content) });
      continue;
    }
    if (message.role === 'user') {
      prompt.push({ role: 'user', content: toUserContent(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      prompt.push({ role: 'assistant', content: toAssistantContent(message) });
      continue;
    }
    const toolCallId = message.toolCallId ?? '';
    prompt.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? 'tool',
        output: { type: 'text', value: textOf(message.content) },
      }],
    });
  }
  return prompt;
}

function toTools(request: ModelCompletionRequest): Pick<CallOptions, 'tools' | 'toolChoice'> {
  const tools = request.tools;
  if (tools === undefined || tools.length === 0) return {};
  return {
    tools: tools.map((tool): ModelTool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
    toolChoice: { type: 'auto' },
  };
}

/**
 * AI SDK v2 の `responseFormat` には `strict` が無い（型にもワイヤ変換にも存在しない）。
 * Port の `strict` は送信直前のボディ補正（tuneRequestBody）で `json_schema.strict` へ戻す。
 */
function toResponseFormat(request: ModelCompletionRequest): Pick<CallOptions, 'responseFormat'> {
  const format = request.responseFormat;
  if (format === undefined) return {};
  return { responseFormat: { type: 'json', name: format.name, schema: format.schema } };
}

function finishReason(value: FinishPart['finishReason'] | undefined): ModelCompletion['finishReason'] {
  if (value === 'stop' || value === 'length') return value;
  if (value === 'tool-calls') return 'tool_calls';
  return 'unknown';
}

function toUsage(usage: FinishPart['usage'] | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const mapped: ModelUsage = {
    ...(typeof usage.inputTokens === 'number' ? { promptTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === 'number' ? { completionTokens: usage.outputTokens } : {}),
    ...(typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function createState(): StreamState {
  return { content: [], toolCalls: new Map(), finishReason: undefined, usage: undefined, error: undefined, received: false };
}

function draftOf(state: StreamState, id: string): ToolCallDraft {
  const existing = state.toolCalls.get(id);
  if (existing !== undefined) return existing;
  const draft: ToolCallDraft = { args: '' };
  state.toolCalls.set(id, draft);
  return draft;
}

/** 未知パート（reasoning・source・raw 等）は捨てる。蓄積するのは本文・ツール・終了情報だけ。 */
function applyPart(state: StreamState, part: StreamPart): void {
  // 内容を捨てるパートでも「モデルが何か出力した」事実だけは記録する（空ストリーム検知用）。
  if (!CONTROL_PART_TYPES.has(part.type)) state.received = true;
  switch (part.type) {
    case 'text-delta':
      if (part.delta !== '') state.content.push(part.delta);
      return;
    case 'tool-input-start':
      draftOf(state, part.id).name = part.toolName;
      return;
    case 'tool-input-delta':
      draftOf(state, part.id).args += part.delta;
      return;
    case 'tool-call': {
      const draft = draftOf(state, part.toolCallId);
      draft.name = part.toolName;
      // 断片の連結ではなく、プロバイダが確定させた全文を正とする。
      draft.args = part.input;
      return;
    }
    case 'finish':
      state.finishReason = part.finishReason;
      state.usage = part.usage;
      return;
    case 'error':
      if (state.error === undefined) state.error = part.error;
      return;
    default:
      return;
  }
}

function toToolCalls(state: StreamState): ModelToolCall[] {
  return [...state.toolCalls.entries()].map(([id, draft]) => {
    const name = draft.name;
    if (name === undefined || name === '') {
      throw new ModelProviderError('Model returned a tool call without a function name');
    }
    // 引数なしツールは arguments 断片が一度も来ないため、空文字は空オブジェクトとして扱う。
    const raw = draft.args.trim() === '' ? '{}' : draft.args;
    let args: unknown;
    try { args = JSON.parse(raw); }
    catch (error) { throw new ModelProviderError(`Model returned invalid arguments for tool '${name}'`, error); }
    if (!isJsonObject(args)) throw new ModelProviderError(`Model returned non-object arguments for tool '${name}'`);
    return { id, name, arguments: args };
  });
}

function toCompletion(state: StreamState): ModelCompletion {
  const toolCalls = toToolCalls(state);
  const usage = toUsage(state.usage);
  return {
    message: {
      role: 'assistant',
      content: state.content.length > 0 ? state.content.join('') : null,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    finishReason: finishReason(state.finishReason),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function detailOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.trim();
  if (text === '') return '';
  return `: ${text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text}`;
}

/**
 * abort されたら reject する番人。`doStream()` 呼び出しとストリーム読み取りの
 * **両方**を同じ番人と race させる（前者を守らないと、接続確立前に吊ったリクエストが
 * タイムアウトを踏んでも脱出できない）。
 */
function abortWatcher(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('Model stream aborted'));
    if (signal.aborted) { fail(); return; }
    signal.addEventListener('abort', fail, { once: true });
  });
  // race に負けた側の rejection が unhandled にならないようにする。
  void aborted.catch(() => {});
  return aborted;
}

/**
 * ストリームパートを読み進めながら state を積み上げる。
 * abort は transport 任せにせず読み取りと race させ、
 * ストリームが abort を尊重しない実装でも必ず脱出する。
 */
async function readStream(
  stream: ReadableStream<StreamPart>,
  aborted: Promise<never>,
  onPart: () => void,
): Promise<StreamState> {
  const reader = stream.getReader();
  const state = createState();
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      onPart();
      applyPart(state, result.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return state;
}

export class MastraModelProvider implements ModelProviderPort {
  private readonly spec: MastraOpenAiCompatibleModel;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly resolvedCapabilities: readonly ModelCapability[];
  /** apiKey / headers 値。エラー文へ混ざり込んだ場合の二重防御として伏せ字化に使う。 */
  private readonly secrets: readonly string[];
  /**
   * 設定は不変なのでルーターは1インスタンスを使い回す。
   * ModelRouterLanguageModel は解決済みモデル（OpenAI互換クライアント等）を
   * インスタンス内キャッシュへ溜めるため、毎回生成すると再構築が無駄になる。
   * 生成は初回 complete() まで遅らせ、モデルID不正で配線が落ちないようにする。
   */
  private router: ModelRouterLanguageModel | undefined;

  constructor(private readonly options: MastraModelProviderOptions) {
    this.spec = typeof options.model === 'string' ? { id: options.model } : options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.resolvedCapabilities = options.capabilities ?? this.registryCapabilities();
    this.secrets = [this.spec.apiKey, ...Object.values(this.spec.headers ?? {})]
      .filter((value): value is string => typeof value === 'string' && value.length >= 4);
  }

  capabilities(): readonly ModelCapability[] {
    return this.resolvedCapabilities;
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    const router = this.model();
    const controller = new AbortController();
    let timedOut: 'idle' | 'total' | undefined;
    const total = setTimeout(() => {
      if (timedOut === undefined) timedOut = 'total';
      controller.abort();
    }, this.timeoutMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => {
        if (timedOut === undefined) timedOut = 'idle';
        controller.abort();
      }, this.idleTimeoutMs);
    };
    const abort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    armIdle();
    const aborted = abortWatcher(controller.signal);
    try {
      const call = (): Promise<StreamResult> => router.doStream({
        prompt: toPrompt(request.messages),
        ...toTools(request),
        ...toResponseFormat(request),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(this.options.maxTokens !== undefined ? { maxOutputTokens: this.options.maxTokens } : {}),
        abortSignal: controller.signal,
      });
      // strict は AI SDK の CallOptions に無いので、送信直前のボディ補正（tuneRequestBody）へ
      // 非同期コンテキストで受け渡す。complete() は並行に走るためインスタンス変数では持てない。
      const tuning: RequestTuning = { strict: request.responseFormat?.strict };
      // doStream() 自体も abort と race させる（接続確立前に吊っても必ず脱出する）。
      const { stream } = await Promise.race([requestTuning.run(tuning, call), aborted]);
      const state = await readStream(stream, aborted, armIdle);
      // 認証解決失敗やプロバイダ側エラーは例外ではなく error パートで届く。
      if (state.error !== undefined) {
        throw new ModelProviderError(this.redact(`Model request failed${detailOf(state.error)}`), state.error);
      }
      // 空SSE・即[DONE]・プロキシの空応答は finish パートだけが届く。ここで止めないと
      // 「content が空文字の成功」として Run が succeeded で確定してしまう。
      if (!state.received) throw new ModelProviderError(NO_COMPLETION_CHOICE);
      return toCompletion(state);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (timedOut === 'idle') {
        throw new ModelProviderError(`Model request timed out: no output for ${this.idleTimeoutMs}ms`, error);
      }
      if (timedOut === 'total') {
        throw new ModelProviderError(`Model request timed out: exceeded total limit ${this.timeoutMs}ms`, error);
      }
      if (controller.signal.aborted) throw new ModelProviderError('Model request was aborted or timed out', error);
      throw new ModelProviderError(this.redact(`Model request failed${detailOf(error)}`), error);
    } finally {
      clearTimeout(total);
      if (idle !== undefined) clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
    }
  }

  private model(): ModelRouterLanguageModel {
    if (this.router !== undefined) return this.router;
    const { providerId, modelId } = splitModelId(this.spec.id);
    const router = new ModelRouterLanguageModel({
      providerId,
      modelId,
      ...(this.spec.url !== undefined ? { url: this.spec.url } : {}),
      ...(this.spec.apiKey !== undefined ? { apiKey: this.spec.apiKey } : {}),
      ...(this.spec.headers !== undefined ? { headers: { ...this.spec.headers } } : {}),
    });
    // url 指定は Mastra 内部で必ず openai-compatible へ落ちる経路。そこだけ補正を差し込む
    // （登録簿モデルはネイティブSDKへ解決され、include_usage も strict も既定で送られる）。
    this.router = this.spec.url === undefined ? router : withTunedModelResolution(router);
    return this.router;
  }

  /**
   * 既定の capabilities。バンドル登録簿（オフライン・fsのみ）が
   * 「そのモデルは添付非対応」と明示できるときだけ vision を落とす。
   * カスタムエンドポイント（url指定）は登録簿の対象外なので既定のままにする。
   */
  private registryCapabilities(): readonly ModelCapability[] {
    if (this.spec.url !== undefined) return DEFAULT_CAPABILITIES;
    if (modelSupportsAttachments(this.spec.id.trim()) !== false) return DEFAULT_CAPABILITIES;
    return DEFAULT_CAPABILITIES.filter((capability) => capability !== 'vision');
  }

  /** 第一防御は「設定値をメッセージへ入れない」こと。これはそれを取りこぼした場合の第二防御。 */
  private redact(message: string): string {
    let redacted = message;
    for (const secret of this.secrets) redacted = redacted.split(secret).join('***');
    return redacted;
  }
}

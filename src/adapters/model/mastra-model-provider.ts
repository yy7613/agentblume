/**
 * adapters層: @mastra/core のモデルルーターに「通信」だけを委譲する ModelProviderPort 実装。
 *
 * ベンダー分岐（各プロバイダのwire形式・認証・エンドポイント）は Mastra の
 * registry / gateway 側に閉じ込め、本アダプタは
 *   ModelCompletionRequest ↔ AI SDK v2 (LanguageModelV2) の型変換
 *   ＋ 二段タイムアウト ＋ ModelProviderError への正規化
 * だけを担う。外部SDK(@mastra/*)への依存は本アダプタ内に隔離する（depcruise）。
 */
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

// @mastra/core 同梱の posthog テレメトリを無効化する（オフラインファースト・外部送信抑止）。
process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true';
// モデル登録簿の動的取得（ネットワーク）も止める。恒久的にはプロセス起動時のenv（src/server.ts）で効かせる。
process.env['MASTRA_OFFLINE'] ??= '1';

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

interface RouterModelId {
  readonly providerId: string;
  readonly modelId: string;
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
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `'provider/model'` を最初の `/` で分解する。ネストしたIDは modelId 側に残す。 */
function splitModelId(id: string): RouterModelId {
  const trimmed = id.trim();
  const slash = trimmed.indexOf('/');
  const providerId = slash > 0 ? trimmed.slice(0, slash) : '';
  const modelId = slash > 0 ? trimmed.slice(slash + 1) : '';
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
  return { content: [], toolCalls: new Map(), finishReason: undefined, usage: undefined, error: undefined };
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
 * ストリームパートを読み進めながら state を積み上げる。
 * abort は transport 任せにせず読み取りと race させ、
 * ストリームが abort を尊重しない実装でも必ず脱出する。
 */
async function readStream(
  stream: ReadableStream<StreamPart>,
  signal: AbortSignal,
  onPart: () => void,
): Promise<StreamState> {
  const reader = stream.getReader();
  const state = createState();
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('Model stream aborted'));
    if (signal.aborted) { fail(); return; }
    signal.addEventListener('abort', fail, { once: true });
  });
  void aborted.catch(() => {});
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
    try {
      const { stream } = await router.doStream({
        prompt: toPrompt(request.messages),
        ...toTools(request),
        ...toResponseFormat(request),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(this.options.maxTokens !== undefined ? { maxOutputTokens: this.options.maxTokens } : {}),
        abortSignal: controller.signal,
      });
      const state = await readStream(stream, controller.signal, armIdle);
      // 認証解決失敗やプロバイダ側エラーは例外ではなく error パートで届く。
      if (state.error !== undefined) {
        throw new ModelProviderError(this.redact(`Model request failed${detailOf(state.error)}`), state.error);
      }
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
    this.router = new ModelRouterLanguageModel({
      providerId,
      modelId,
      ...(this.spec.url !== undefined ? { url: this.spec.url } : {}),
      ...(this.spec.apiKey !== undefined ? { apiKey: this.spec.apiKey } : {}),
      ...(this.spec.headers !== undefined ? { headers: { ...this.spec.headers } } : {}),
    });
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

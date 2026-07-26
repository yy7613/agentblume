import { z } from 'zod';
import {
  ModelProviderError,
  type JsonObject,
  type ModelCapability,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelRequestMessage,
  type ModelToolCall,
  type ModelProviderPort,
} from '../../application/model/model-provider';

export interface LmStudioModelProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  /** 総時間の上限（ms）。推論モデルは長時間生成し続けるため、ハング検知は idleTimeoutMs が担う。 */
  readonly timeoutMs?: number;
  /** 1バイトも出力が来ない状態が続いたら打ち切る（ms）。チャンク受信ごとにリセットする。 */
  readonly idleTimeoutMs?: number;
  /** 指定時のみ max_tokens をリクエストへ含める（推論の暴走を抑える）。 */
  readonly maxTokens?: number;
  readonly fetcher?: typeof fetch;
}

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

/** OpenAI互換 SSE の 1 チャンク。未知キー（reasoning_content 等）は zod が落とすので蓄積しない。 */
const chunkSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative().optional(),
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
  usage: usageSchema.nullable().optional(),
});

type StreamChunk = z.infer<typeof chunkSchema>;
type StreamUsage = z.infer<typeof usageSchema>;

interface ToolCallDraft {
  id?: string;
  name?: string;
  args: string;
}

interface StreamState {
  readonly content: string[];
  readonly toolCalls: Map<number, ToolCallDraft>;
  finishReason: string | null | undefined;
  usage: StreamUsage | undefined;
  received: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toOpenAiMessage(message: ModelRequestMessage): Record<string, unknown> {
  const content = Array.isArray(message.content)
    ? message.content.map((part) => part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: part.imageUrl } })
    : message.content;
  const common = { role: message.role, content };
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    return {
      ...common,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === 'tool') return { ...common, tool_call_id: message.toolCallId };
  return common;
}

function finishReason(value: string | null | undefined): ModelCompletion['finishReason'] {
  if (value === 'stop' || value === 'tool_calls' || value === 'length') return value;
  return 'unknown';
}

function createState(): StreamState {
  return { content: [], toolCalls: new Map(), finishReason: undefined, usage: undefined, received: false };
}

function applyChunk(state: StreamState, chunk: StreamChunk): void {
  if (chunk.usage !== undefined && chunk.usage !== null) state.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (choice === undefined) return;
  state.received = true;
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (delta === undefined) return;
  if (typeof delta.content === 'string' && delta.content !== '') state.content.push(delta.content);
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0;
    const draft = state.toolCalls.get(index) ?? { args: '' };
    if (call.id !== undefined) draft.id = call.id;
    if (call.function?.name !== undefined) draft.name = call.function.name;
    if (call.function?.arguments !== undefined) draft.args += call.function.arguments;
    state.toolCalls.set(index, draft);
  }
}

/** SSE の 1 行を処理する。`data: [DONE]` を読んだら true（ストリーム終端）。 */
function consumeLine(rawLine: string, state: StreamState): boolean {
  const line = rawLine.trim();
  if (line === '' || !line.startsWith('data:')) return false;
  const payload = line.slice('data:'.length).trim();
  if (payload === '[DONE]') return true;
  let json: unknown;
  try { json = JSON.parse(payload); }
  catch (error) { throw new ModelProviderError('LM Studio returned an invalid chat completion chunk', error); }
  const parsed = chunkSchema.safeParse(json);
  if (!parsed.success) throw new ModelProviderError('LM Studio returned an invalid chat completion');
  applyChunk(state, parsed.data);
  return false;
}

function toCompletion(state: StreamState): ModelCompletion {
  if (!state.received) throw new ModelProviderError('LM Studio returned no completion choice');
  const toolCalls: ModelToolCall[] = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, draft]) => {
      const name = draft.name;
      if (name === undefined || name === '') {
        throw new ModelProviderError('LM Studio returned a tool call without a function name');
      }
      // 引数なしツールは arguments 断片が一度も来ないため、空文字は空オブジェクトとして扱う。
      const raw = draft.args.trim() === '' ? '{}' : draft.args;
      let args: unknown;
      try { args = JSON.parse(raw); }
      catch (error) { throw new ModelProviderError(`LM Studio returned invalid arguments for tool '${name}'`, error); }
      if (!isJsonObject(args)) throw new ModelProviderError(`LM Studio returned non-object arguments for tool '${name}'`);
      return { id: draft.id ?? `call_${index}`, name, arguments: args };
    });
  const usage = state.usage;
  return {
    message: {
      role: 'assistant',
      content: state.content.length > 0 ? state.content.join('') : null,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    finishReason: finishReason(state.finishReason),
    ...(usage !== undefined ? {
      usage: {
        ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
        ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
        ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
      },
    } : {}),
  };
}

async function errorDetail(response: Response): Promise<string> {
  let text = '';
  try { text = (await response.text()).trim(); }
  catch { return ''; }
  if (text === '') return '';
  return `: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
}

/**
 * SSE を読み進めながら state を積み上げる。
 * abort は transport 任せにせず読み取りと race させ、body が abort を尊重しない実装でも必ず脱出する。
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onChunk: () => void,
): Promise<StreamState> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createState();
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('LM Studio stream aborted'));
    if (signal.aborted) { fail(); return; }
    signal.addEventListener('abort', fail, { once: true });
  });
  void aborted.catch(() => {});
  let buffer = '';
  let finished = false;
  try {
    while (!finished) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      onChunk();
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (consumeLine(line, state)) { finished = true; break; }
        newline = buffer.indexOf('\n');
      }
    }
    if (!finished) consumeLine(buffer + decoder.decode(), state);
  } finally {
    void reader.cancel().catch(() => {});
  }
  return state;
}

export class LmStudioModelProvider implements ModelProviderPort {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: LmStudioModelProviderOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  }

  capabilities(): readonly ModelCapability[] {
    return ['chat', 'tool-calling', 'structured-output', 'vision'];
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (this.options.model.trim() === '') {
      throw new ModelProviderError('LM Studio model is not configured (set LM_STUDIO_MODEL)');
    }
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
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey !== undefined ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toOpenAiMessage),
          ...(request.tools !== undefined && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
                tool_choice: 'auto',
              }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(this.options.maxTokens !== undefined ? { max_tokens: this.options.maxTokens } : {}),
          ...(request.responseFormat !== undefined ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.responseFormat.name,
                strict: request.responseFormat.strict,
                schema: request.responseFormat.schema,
              },
            },
          } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelProviderError(`LM Studio request failed with HTTP ${response.status}${await errorDetail(response)}`);
      }
      const body = response.body;
      if (body === null) throw new ModelProviderError('LM Studio returned no response body');
      return toCompletion(await readStream(body, controller.signal, armIdle));
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (timedOut === 'idle') {
        throw new ModelProviderError(`LM Studio request timed out: no output for ${this.idleTimeoutMs}ms`, error);
      }
      if (timedOut === 'total') {
        throw new ModelProviderError(`LM Studio request timed out: exceeded total limit ${this.timeoutMs}ms`, error);
      }
      if (controller.signal.aborted) throw new ModelProviderError('LM Studio request was aborted or timed out', error);
      throw new ModelProviderError('LM Studio request failed', error);
    } finally {
      clearTimeout(total);
      if (idle !== undefined) clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
    }
  }
}

import { z } from 'zod';
import {
  ModelProviderError,
  type JsonObject,
  type ModelCapability,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelMessage,
  type ModelRequestMessage,
  type ModelProviderPort,
} from '../../application/model/model-provider';

export interface LmStudioModelProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      role: z.literal('assistant').optional(),
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal('function').optional(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

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

export class LmStudioModelProvider implements ModelProviderPort {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LmStudioModelProviderOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  capabilities(): readonly ModelCapability[] {
    return ['chat', 'tool-calling', 'structured-output', 'vision'];
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (this.options.model.trim() === '') {
      throw new ModelProviderError('LM Studio model is not configured (set LM_STUDIO_MODEL)');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
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
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelProviderError(`LM Studio request failed with HTTP ${response.status}`);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new ModelProviderError('LM Studio returned an invalid chat completion');
      const choice = parsed.data.choices[0];
      if (choice === undefined) throw new ModelProviderError('LM Studio returned no completion choice');
      const toolCalls = choice.message.tool_calls?.map((call) => {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); }
        catch (error) { throw new ModelProviderError(`LM Studio returned invalid arguments for tool '${call.function.name}'`, error); }
        if (!isJsonObject(args)) throw new ModelProviderError(`LM Studio returned non-object arguments for tool '${call.function.name}'`);
        return { id: call.id, name: call.function.name, arguments: args };
      });
      const usage = parsed.data.usage;
      return {
        message: {
          role: 'assistant',
          content: choice.message.content ?? null,
          ...(toolCalls !== undefined ? { toolCalls } : {}),
        },
        finishReason: finishReason(choice.finish_reason),
        ...(usage !== undefined ? {
          usage: {
            ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
            ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
            ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
          },
        } : {}),
      };
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (controller.signal.aborted) throw new ModelProviderError('LM Studio request was aborted or timed out', error);
      throw new ModelProviderError('LM Studio request failed', error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

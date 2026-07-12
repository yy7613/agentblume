export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

export interface JsonSchemaProperty {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly JsonPrimitive[];
  readonly anyOf?: readonly JsonSchemaProperty[];
  readonly items?: JsonSchemaProperty;
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface JsonSchemaObject {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolCallId?: string;
}

export interface ModelCompletionRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly responseFormat?: {
    readonly name: string;
    readonly strict: boolean;
    readonly schema: JsonSchemaObject;
  };
}

export interface ModelUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelCompletion {
  readonly message: ModelMessage;
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';
  readonly usage?: ModelUsage;
}

export type ModelCapability = 'chat' | 'tool-calling' | 'structured-output';

export interface ModelProviderPort {
  complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion>;
  capabilities(): readonly ModelCapability[];
}

export class ModelProviderError extends Error {
  readonly code = 'MODEL_PROVIDER';

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

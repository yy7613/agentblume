import {
  ModelProviderError,
  type ModelCapability,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelProviderPort,
} from '../../application/model/model-provider';

export class ScriptedModelProvider implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  private readonly queue: ModelCompletion[] = [];

  capabilities(): readonly ModelCapability[] {
    return ['chat', 'tool-calling'];
  }

  enqueue(...completions: readonly ModelCompletion[]): void {
    this.queue.push(...completions);
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted === true) throw new ModelProviderError('scripted request aborted');
    this.requests.push(structuredClone(request));
    const completion = this.queue.shift();
    if (completion === undefined) throw new ModelProviderError('no scripted completion available');
    return structuredClone(completion);
  }
}

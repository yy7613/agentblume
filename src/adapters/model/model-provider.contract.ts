import { expect } from 'vitest';
import type { ModelProviderPort } from '../../application/model/model-provider';

export async function assertModelProviderContract(provider: ModelProviderPort): Promise<void> {
  expect(provider.capabilities()).toEqual(expect.arrayContaining(['chat', 'tool-calling', 'structured-output']));
  const completion = await provider.complete({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      name: 'echo',
      description: 'Echo input',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    }],
  });
  expect(completion.message.role).toBe('assistant');
}

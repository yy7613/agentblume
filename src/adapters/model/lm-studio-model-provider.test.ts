import { describe, expect, it, vi } from 'vitest';
import { ModelProviderError } from '../../application/model/model-provider';
import { assertModelProviderContract } from './model-provider.contract';
import { LmStudioModelProvider } from './lm-studio-model-provider';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LmStudioModelProvider', () => {
  it('OpenAI互換request/responseでcontractを満たす', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));
    const provider = new LmStudioModelProvider({ baseUrl: 'http://localhost:1234/v1/', model: 'local', apiKey: 'lm-studio', fetcher });
    await assertModelProviderContract(provider);
    expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'local', stream: false, tool_choice: 'auto' });
    expect(init.headers).toMatchObject({ authorization: 'Bearer lm-studio' });
  });

  it('tool_calls argumentsを共通objectへ変換する', async () => {
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://localhost:1234/v1', model: 'local',
      fetcher: vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'tool_calls', message: {
        content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":42}' } }],
      } }] })),
    });
    await expect(provider.complete({ messages: [] })).resolves.toMatchObject({
      finishReason: 'tool_calls', message: { toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 42 } }] },
    });
  });

  it('画像付き入力をOpenAI互換のimage_url content partへ変換する', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'stop', message: { content: 'seen' } }] }));
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'vision-model', fetcher });
    await provider.complete({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', imageUrl: 'data:image/png;base64,AA==' },
    ] }] });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(provider.capabilities()).toContain('vision');
    expect(body.messages[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ] });
  });

  it.each([
    [response({ error: 'offline' }, 503), /HTTP 503/],
    [response({ choices: [] }), /invalid/],
    [response({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'bad', arguments: '[' } }] } }] }), /invalid arguments/],
  ])('HTTP/protocol errorをModelProviderErrorへ変換する', async (mockResponse, message) => {
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: vi.fn().mockResolvedValue(mockResponse) });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({ message: expect.stringMatching(message) });
  });

  it('assistant/tool messages、temperature、未知finish reasonをwire変換する', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'content_filter', message: {} }] }));
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher });
    const result = await provider.complete({
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'echo', arguments: { value: 'x' } }] },
        { role: 'tool', content: '{"value":"x"}', toolCallId: 'c' },
      ],
      temperature: 0,
      responseFormat: {
        name: 'answer', strict: true,
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      },
    });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ temperature: 0, response_format: {
      type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', required: ['answer'], additionalProperties: false } },
    }, messages: [
      { role: 'assistant', tool_calls: [{ function: { arguments: '{"value":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c' },
    ] });
    expect(result).toMatchObject({ finishReason: 'unknown', message: { content: null } });
  });

  it('network failureと事前abortをModelProviderErrorへ変換する', async () => {
    const failed = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: vi.fn().mockRejectedValue(new Error('network')) });
    await expect(failed.complete({ messages: [] })).rejects.toMatchObject({ message: 'LM Studio request failed' });
    const controller = new AbortController(); controller.abort();
    await expect(failed.complete({ messages: [] }, controller.signal)).rejects.toMatchObject({ message: expect.stringContaining('aborted') });
  });

  it('model未設定は外部通信せず明示的に拒否する', async () => {
    const fetcher = vi.fn();
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: '', fetcher });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/LM_STUDIO_MODEL/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

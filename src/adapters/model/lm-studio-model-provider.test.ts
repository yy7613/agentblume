import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { assertModelProviderContract } from './model-provider.contract';
import { LmStudioModelProvider } from './lm-studio-model-provider';

type FetchMock = Mock<typeof fetch>;

const encoder = new TextEncoder();

/** SSE 1イベント分の文字列。 */
function event(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** content 断片だけを持つ delta チャンク。 */
function textChunk(content: string, finish: string | null = null): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function fetchMock(implementation: () => Promise<Response>): FetchMock {
  return vi.fn<typeof fetch>(implementation);
}

/** 呼び出しごとに新しい Response を返す（body は一度しか読めないため）。 */
function sseFetcher(chunks: readonly unknown[]): FetchMock {
  const events = chunks.map(event).join('');
  return fetchMock(() => Promise.resolve(rawResponse(`${events}data: [DONE]\n\n`)));
}

function requestBody(fetcher: FetchMock, call = 0): Record<string, unknown> {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** テストから任意のタイミングで断片を流せるストリーム。 */
function controlledStream(): { response: Response; push: (text: string) => void; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    // 打ち切り後は reader.cancel() で controller が閉じるため push は no-op に落とす。
    push: (text: string) => { try { controller?.enqueue(encoder.encode(text)); } catch { /* closed */ } },
    close: () => controller?.close(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LmStudioModelProvider', () => {
  it('OpenAI互換SSEでcontractを満たし、content断片とusageを組み立てる', async () => {
    const fetcher = sseFetcher([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'hel', reasoning_content: '長考' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
    const provider = new LmStudioModelProvider({ baseUrl: 'http://localhost:1234/v1/', model: 'local', apiKey: 'lm-studio', fetcher });

    await assertModelProviderContract(provider);

    expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    expect(requestBody(fetcher)).toMatchObject({
      model: 'local', stream: true, tool_choice: 'auto', stream_options: { include_usage: true },
    });
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer lm-studio' });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toEqual({
      message: { role: 'assistant', content: 'hello' },
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
  });

  it('tool_calls断片をindexで集約し、複数ツール並行も順序どおり復元する', async () => {
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://localhost:1234/v1', model: 'local',
      fetcher: sseFetcher([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call-2', type: 'function', function: { name: 'ping', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '42}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    });

    await expect(provider.complete({ messages: [] })).resolves.toEqual({
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-1', name: 'lookup', arguments: { id: 42 } },
          { id: 'call-2', name: 'ping', arguments: {} },
        ],
      },
    });
  });

  it('index/id省略のtool_callsも1件として扱う', async () => {
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://x/v1', model: 'm',
      fetcher: sseFetcher([
        { choices: [{ delta: { tool_calls: [{ function: { name: 'noop' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }] },
      ]),
    });

    await expect(provider.complete({ messages: [] })).resolves.toMatchObject({
      message: { toolCalls: [{ id: 'call_0', name: 'noop', arguments: { a: 1 } }] },
    });
  });

  it('コメント行・CRLF・[DONE]なしの終端を許容する', async () => {
    const body = `: keepalive\r\n${event(textChunk('a')).replace(/\n/g, '\r\n')}event: ping\r\n\r\ndata: ${JSON.stringify(textChunk('b', 'stop'))}`;
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.resolve(rawResponse(body))),
    });

    await expect(provider.complete({ messages: [] })).resolves.toMatchObject({ message: { content: 'ab' }, finishReason: 'stop' });
  });

  it('画像付き入力をOpenAI互換のimage_url content partへ変換する', async () => {
    const fetcher = sseFetcher([textChunk('seen', 'stop')]);
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'vision-model', fetcher });

    await provider.complete({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', imageUrl: 'data:image/png;base64,AA==' },
    ] }] });

    expect(provider.capabilities()).toContain('vision');
    expect(requestBody(fetcher)['messages']).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ] }]);
  });

  it('assistant/tool messages、temperature、未知finish reasonをwire変換する', async () => {
    const fetcher = sseFetcher([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }]);
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

    expect(requestBody(fetcher)).toMatchObject({ temperature: 0, response_format: {
      type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', required: ['answer'], additionalProperties: false } },
    }, messages: [
      { role: 'assistant', tool_calls: [{ function: { arguments: '{"value":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c' },
    ] });
    expect(result).toMatchObject({ finishReason: 'unknown', message: { content: null } });
  });

  it('maxTokens指定時のみ max_tokens をリクエストへ含める', async () => {
    const withLimit = sseFetcher([textChunk('x', 'stop')]);
    const withoutLimit = sseFetcher([textChunk('x', 'stop')]);

    await new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', maxTokens: 256, fetcher: withLimit }).complete({ messages: [] });
    await new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: withoutLimit }).complete({ messages: [] });

    expect(requestBody(withLimit)['max_tokens']).toBe(256);
    expect(Object.keys(requestBody(withoutLimit))).not.toContain('max_tokens');
  });

  it.each([
    ['HTTPエラーはstatusと本文を含める', () => new Response(JSON.stringify({ error: 'offline' }), { status: 503 }), /HTTP 503: \{"error":"offline"\}/],
    ['body無しの200を拒否する', () => new Response(null, { status: 200 }), /no response body/],
  ])('%s', async (_name, make, message) => {
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.resolve(make())) });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({ message: expect.stringMatching(message) });
  });

  it.each([
    ['data行がJSONでない', 'data: not-json\n\n', /invalid chat completion chunk/],
    ['chunk schemaに合わない', event({ choices: [{ delta: { content: 12 } }] }), /invalid chat completion/],
    ['choiceが1つも来ない', 'data: [DONE]\n\n', /no completion choice/],
    ['tool call名が無い', event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), /without a function name/],
    ['tool call引数が壊れている', event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'bad', arguments: '[' } }] } }] }), /invalid arguments/],
    ['tool call引数がobjectでない', event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'bad', arguments: '[1]' } }] } }] }), /non-object arguments/],
  ])('protocol error（%s）をModelProviderErrorへ変換する', async (_name, body, message) => {
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.resolve(rawResponse(body))),
    });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({ message: expect.stringMatching(message) });
  });

  it('network failureと事前abortをModelProviderErrorへ変換する', async () => {
    const failed = new LmStudioModelProvider({
      baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.reject(new Error('network'))),
    });

    await expect(failed.complete({ messages: [] })).rejects.toMatchObject({ message: 'LM Studio request failed' });
    const controller = new AbortController();
    controller.abort();
    await expect(failed.complete({ messages: [] }, controller.signal)).rejects.toMatchObject({ message: expect.stringContaining('aborted') });
  });

  it('stream読み取り中の外部abortを打ち切る', async () => {
    const stream = controlledStream();
    const provider = new LmStudioModelProvider({
      baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.resolve(stream.response)),
    });
    const controller = new AbortController();

    const pending = provider.complete({ messages: [] }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ message: 'LM Studio request was aborted or timed out' });
    stream.push(event(textChunk('partial')));
    await Promise.resolve();
    controller.abort();

    await assertion;
  });

  it('model未設定は外部通信せず明示的に拒否する', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: '', fetcher });

    await expect(provider.complete({ messages: [] })).rejects.toThrow(/LM_STUDIO_MODEL/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  /**
   * 文脈の長さ（v49 §4）。画面の消費比率のためだけに引く best-effort な問い合わせで、
   * 取れないこと自体は正常系（LM Studio 以外のサーバ・古い版・停止中）。
   */
  describe('contextWindow', () => {
    function jsonFetcher(body: unknown, status = 200): FetchMock {
      return fetchMock(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
    }

    it('正常: /v1 の隣の /api/v0/models/<id> を GET し、loaded_context_length を優先する', async () => {
      const fetcher = jsonFetcher({ loaded_context_length: 8192, max_context_length: 131072 });
      const provider = new LmStudioModelProvider({ baseUrl: 'http://localhost:1234/v1/', model: 'local', apiKey: 'lm-studio', fetcher });

      await expect(provider.contextWindow()).resolves.toBe(8192);
      expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/api/v0/models/local', expect.objectContaining({ method: 'GET' }));
      expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer lm-studio' });
    });

    it('正常: 載っている長さが無ければ max_context_length で代える', async () => {
      const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: jsonFetcher({ max_context_length: 131072 }) });
      await expect(provider.contextWindow()).resolves.toBe(131072);
    });

    it('正常: `/` を含むモデル id は 1 つのパス要素へ符号化する', async () => {
      const fetcher = jsonFetcher({ loaded_context_length: 4096 });
      await new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'google/gemma-4-12b', fetcher }).contextWindow();
      expect(fetcher.mock.calls[0]?.[0]).toBe('http://x/api/v0/models/google%2Fgemma-4-12b');
    });

    it.each([
      ['非数', { loaded_context_length: 'many', max_context_length: null }],
      ['0 や負', { loaded_context_length: 0, max_context_length: -1 }],
      ['小数', { loaded_context_length: 4096.5 }],
      ['項目が無い', { id: 'm' }],
      ['JSON ですらない', 'not json'],
    ])('異常: 応答が%sなら undefined（比率が出ないだけで、呼び出しは止めない）', async (_name, body) => {
      const fetcher = fetchMock(() => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })));
      await expect(new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher }).contextWindow()).resolves.toBeUndefined();
    });

    it.each([
      ['HTTP エラー', () => new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.resolve(new Response('nope', { status: 404 }))) })],
      ['通信の失敗', () => new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher: fetchMock(() => Promise.reject(new Error('ECONNREFUSED'))) })],
    ])('異常: %s は例外にせず undefined', async (_name, make) => {
      await expect(make().contextWindow()).resolves.toBeUndefined();
    });

    it.each([
      ['/v1 で終わらない baseUrl', { baseUrl: 'http://x/openai', model: 'm' }],
      ['モデル未設定', { baseUrl: 'http://x/v1', model: '' }],
    ])('境界: %s では問い合わせない（LM Studio の口だと分かるときだけ叩く）', async (_name, options) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(new LmStudioModelProvider({ ...options, fetcher }).contextWindow()).resolves.toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('境界: 60 秒は同じ答えを返し、超えたら引き直す', async () => {
      vi.useFakeTimers();
      const fetcher = jsonFetcher({ loaded_context_length: 4096 });
      const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher });

      await expect(provider.contextWindow()).resolves.toBe(4096);
      await vi.advanceTimersByTimeAsync(59_000);
      await expect(provider.contextWindow()).resolves.toBe(4096);
      expect(fetcher).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_001);
      await expect(provider.contextWindow()).resolves.toBe(4096);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('境界: 取れなかったことも 60 秒憶える（毎ターン引き直さない）', async () => {
      vi.useFakeTimers();
      const fetcher = fetchMock(() => Promise.reject(new Error('ECONNREFUSED')));
      const provider = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher });

      await expect(provider.contextWindow()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(59_000);
      await expect(provider.contextWindow()).resolves.toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('異常: 3 秒で応答が無ければ諦める（比率の表示のために 1 ターンを待たせない）', async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      }));
      const pending = new LmStudioModelProvider({ baseUrl: 'http://x/v1', model: 'm', fetcher }).contextWindow();

      await vi.advanceTimersByTimeAsync(3_001);
      await expect(pending).resolves.toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('出力が途絶えたらidleTimeoutMsで打ち切る（原因が分かるメッセージ）', async () => {
      vi.useFakeTimers();
      const stream = controlledStream();
      const provider = new LmStudioModelProvider({
        baseUrl: 'http://x/v1', model: 'm', timeoutMs: 600_000, idleTimeoutMs: 60_000,
        fetcher: fetchMock(() => Promise.resolve(stream.response)),
      });

      const pending = provider.complete({ messages: [] });
      const assertion = expect(pending).rejects.toMatchObject({
        message: 'LM Studio request timed out: no output for 60000ms',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      stream.push(event(textChunk('生成中')));
      await vi.advanceTimersByTimeAsync(60_001);

      await assertion;
    });

    it('チャンクが来続ける限りidleTimeoutMsを超えても継続する', async () => {
      vi.useFakeTimers();
      const stream = controlledStream();
      const provider = new LmStudioModelProvider({
        baseUrl: 'http://x/v1', model: 'm', timeoutMs: 600_000, idleTimeoutMs: 30_000,
        fetcher: fetchMock(() => Promise.resolve(stream.response)),
      });

      const pending = provider.complete({ messages: [] });
      for (let i = 0; i < 12; i += 1) {
        stream.push(event(textChunk('.')));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      stream.push(event(textChunk('done', 'stop')));
      stream.push('data: [DONE]\n\n');
      stream.close();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ message: { content: '............done' }, finishReason: 'stop' });
    });

    it('チャンクが来続けても総時間上限を超えたら打ち切る', async () => {
      vi.useFakeTimers();
      const stream = controlledStream();
      const provider = new LmStudioModelProvider({
        baseUrl: 'http://x/v1', model: 'm', timeoutMs: 50_000, idleTimeoutMs: 60_000,
        fetcher: fetchMock(() => Promise.resolve(stream.response)),
      });

      const pending = provider.complete({ messages: [] });
      const assertion = expect(pending).rejects.toMatchObject({
        message: 'LM Studio request timed out: exceeded total limit 50000ms',
      });
      for (let i = 0; i < 6; i += 1) {
        stream.push(event(textChunk('.')));
        await vi.advanceTimersByTimeAsync(10_000);
      }

      await assertion;
    });
  });
});

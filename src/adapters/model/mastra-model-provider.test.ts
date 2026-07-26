import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertModelProviderContract } from './model-provider.contract';
import { MastraModelProvider } from './mastra-model-provider';

/**
 * Mastra内部の fetch は差し替えできないため、OpenAI互換のフェイクサーバーを
 * node:http でローカルに立て、実ストリーミング経路（SSE）を通して検証する。
 */
interface FakeServer {
  /** OpenAI互換のベースURL（`/chat/completions` が付与される）。 */
  readonly url: string;
  readonly bodies: Record<string, unknown>[];
  readonly headers: IncomingHttpHeaders[];
}

type Route = (body: Record<string, unknown>, res: ServerResponse) => void;

const servers: Server[] = [];

async function startFake(route: Route): Promise<FakeServer> {
  const bodies: Record<string, unknown>[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      headers.push(req.headers);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      route(bodies[bodies.length - 1] as Record<string, unknown>, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, bodies, headers };
}

/** SSE で全チャンクを流し切って閉じる。 */
function sse(res: ServerResponse, chunks: readonly unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function fakeOf(chunks: readonly unknown[]): Promise<FakeServer> {
  return startFake((_body, res) => { sse(res, chunks); });
}

function textChunk(content: string, finish: string | null = null): unknown {
  return { id: 'cmpl-1', choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}

function toolChunk(call: unknown, finish: string | null = null): unknown {
  return { id: 'cmpl-1', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: finish }] };
}

/**
 * provider接頭辞は登録簿に無い 'local' を使う。
 * Mastraは routerId が登録簿に載っているとサンプリング指定を落とすため（下の専用テスト参照）。
 */
function provider(fake: FakeServer, overrides: Record<string, unknown> = {}): MastraModelProvider {
  return new MastraModelProvider({ model: { id: 'local/local-model', url: fake.url }, ...overrides });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('MastraModelProvider', () => {
  it('OpenAI互換ストリーミングでcontractを満たし、text-deltaとusageを組み立てる', async () => {
    const fake = await fakeOf([
      { id: 'cmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: { content: 'hel', reasoning_content: '長考' } }] },
      textChunk('lo', 'stop'),
      { id: 'cmpl-1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
    const model = provider(fake);

    await assertModelProviderContract(model);

    // reasoning_content 由来のパートは蓄積せず、本文だけを組み立てる。
    await expect(model.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toEqual({
      message: { role: 'assistant', content: 'hello' },
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
    expect(fake.bodies[1]).toMatchObject({ model: 'local-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('tool call の引数断片を結合し、ストリーム順にtoolCallsを復元する', async () => {
    const fake = await fakeOf([
      toolChunk({ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"id":' } }),
      toolChunk({ index: 0, function: { arguments: '42}' } }),
      toolChunk({ index: 1, id: 'call-2', function: { name: 'ping', arguments: '{"n":1}' } }),
      { id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    await expect(provider(fake).complete({ messages: [] })).resolves.toEqual({
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-1', name: 'lookup', arguments: { id: 42 } },
          { id: 'call-2', name: 'ping', arguments: { n: 1 } },
        ],
      },
    });
  });

  it('引数なしツール（空arguments）は空オブジェクトとして扱う', async () => {
    const fake = await fakeOf([
      toolChunk({ index: 0, id: 'call-0', function: { name: 'noop', arguments: '' } }, 'tool_calls'),
    ]);

    await expect(provider(fake).complete({ messages: [] })).resolves.toMatchObject({
      message: { toolCalls: [{ id: 'call-0', name: 'noop', arguments: {} }] },
    });
  });

  it('壊れたtool call引数をModelProviderErrorへ変換する', async () => {
    const fake = await fakeOf([
      toolChunk({ index: 0, id: 'call-0', function: { name: 'bad', arguments: '[1]' } }, 'tool_calls'),
    ]);

    await expect(provider(fake).complete({ messages: [] })).rejects.toMatchObject({
      name: 'ModelProviderError',
      message: "Model returned non-object arguments for tool 'bad'",
    });
  });

  it('途中で切れたtool call引数をModelProviderErrorへ変換する', async () => {
    const fake = await fakeOf([
      toolChunk({ index: 0, id: 'call-0', function: { name: 'lookup', arguments: '{"id":' } }, 'tool_calls'),
    ]);

    await expect(provider(fake).complete({ messages: [] })).rejects.toMatchObject({
      message: "Model returned invalid arguments for tool 'lookup'",
    });
  });

  it('system/user/assistant/tool・画像・tools・temperature・maxTokensをwire形式へ写す', async () => {
    const fake = await fakeOf([textChunk('ok', 'stop')]);

    await provider(fake, { maxTokens: 256 }).complete({
      messages: [
        // system/assistant/tool のマルチパート本文はテキスト連結で1本にまとめる。
        { role: 'system', content: [{ type: 'text', text: 'be ' }, { type: 'text', text: 'brief' }] },
        { role: 'user', content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', imageUrl: 'data:image/png;base64,AA==' },
        ] },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'echo', arguments: { value: 'x' } }] },
        { role: 'tool', content: '{"value":"x"}', toolCallId: 'c' },
      ],
      tools: [{
        name: 'echo',
        description: 'Echo input',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      }],
      temperature: 0,
    });

    expect(fake.bodies[0]).toMatchObject({
      model: 'local-model',
      temperature: 0,
      max_tokens: 256,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echo input', parameters: { type: 'object', required: ['value'] } } }],
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] },
        { role: 'tool', tool_call_id: 'c', content: '{"value":"x"}' },
      ],
    });
  });

  it('http(s)の画像URLはそのままimage_urlとして渡す', async () => {
    const fake = await fakeOf([textChunk('ok', 'stop')]);

    await provider(fake).complete({
      messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: 'https://example.test/a.png' }] }],
    });

    expect(fake.bodies[0]?.['messages']).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] },
    ]);
  });

  it('画像として解釈できない参照は外部通信前に拒否する', async () => {
    const fake = await fakeOf([textChunk('ok', 'stop')]);

    await expect(provider(fake).complete({
      messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: 'not a url' }] }],
    })).rejects.toMatchObject({ message: 'Model request contains an unsupported image reference' });
    expect(fake.bodies).toHaveLength(0);
  });

  it('structured outputをresponse_formatとしてリクエストへ渡す', async () => {
    const fake = await fakeOf([textChunk('{"answer":"42"}', 'stop')]);

    await provider(fake).complete({
      messages: [],
      responseFormat: {
        name: 'answer', strict: true,
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      },
    });

    expect(fake.bodies[0]?.['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      },
    });
  });

  it('登録簿が温度非対応と扱うモデルIDではMastraがtemperatureを落とす（既知の仕様）', async () => {
    const fake = await fakeOf([textChunk('x', 'stop')]);

    // 'lmstudio' は同梱登録簿に存在し、capabilities に載らないモデルは temperature 非対応と判定される。
    // カスタムURLを指していても routerId の接頭辞だけで判断されるため、接頭辞選びが挙動を左右する。
    await provider(fake, { model: { id: 'lmstudio/local-model', url: fake.url } })
      .complete({ messages: [], temperature: 0 });

    expect(Object.keys(fake.bodies[0] ?? {})).not.toContain('temperature');
  });

  it('maxTokens未指定なら max_tokens を送らない', async () => {
    const fake = await fakeOf([textChunk('x', 'stop')]);

    await provider(fake).complete({ messages: [] });

    expect(Object.keys(fake.bodies[0] ?? {})).not.toContain('max_tokens');
  });

  it('未知のfinish reasonをunknownへ丸める', async () => {
    const fake = await fakeOf([textChunk('x', 'content_filter')]);

    await expect(provider(fake).complete({ messages: [] })).resolves.toMatchObject({ finishReason: 'unknown' });
  });

  it('HTTPエラーを正規化し、apiKeyをメッセージへ漏らさない', async () => {
    const apiKey = 'sk-test-secret-value';
    const fake = await startFake((_body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Invalid credentials: ${apiKey}`, type: 'auth' } }));
    });

    const failure = await provider(fake, { model: { id: 'local/local-model', url: fake.url, apiKey } })
      .complete({ messages: [] }).catch((error: unknown) => error as Error);

    expect(fake.headers[0]?.authorization).toBe(`Bearer ${apiKey}`);
    expect(failure.message).toContain('Model request failed');
    expect(failure.message).not.toContain(apiKey);
    expect(failure.message).toContain('***');
  });

  it('カスタムヘッダを送り、その値もエラー文から伏せる', async () => {
    const secret = 'header-secret-value';
    const fake = await startFake((_body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `boom ${secret}`, type: 'server' } }));
    });

    const failure = await provider(fake, { model: { id: 'local/local-model', url: fake.url, headers: { 'x-tenant': secret } } })
      .complete({ messages: [] }).catch((error: unknown) => error as Error);

    expect(fake.headers[0]?.['x-tenant']).toBe(secret);
    expect(failure.message).not.toContain(secret);
  });

  it('ストリーム読み取り中の外部abortを打ち切る', async () => {
    const fake = await startFake((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(textChunk('partial'))}\n\n`);
    });
    const controller = new AbortController();

    const pending = provider(fake).complete({ messages: [] }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ message: 'Model request was aborted or timed out' });
    await sleep(80);
    controller.abort();

    await assertion;
  });

  it('モデルIDが provider/model 形式でなければ外部通信せず拒否する', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const model = new MastraModelProvider({ model: 'local-model' });

    await expect(model.complete({ messages: [] })).rejects.toMatchObject({
      message: "Model id must be in 'provider/model' form, but got 'local-model'",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('文字列モデルIDはバンドル登録簿だけで解決し、認証が無ければ通信前に失敗する', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('MASTRA_GATEWAY_API_KEY', undefined);
    const model = new MastraModelProvider({ model: 'openai/gpt-4o' });

    expect(model.capabilities()).toEqual(['chat', 'tool-calling', 'structured-output', 'vision']);
    await expect(model.complete({ messages: [] })).rejects.toMatchObject({
      message: expect.stringContaining('OPENAI_API_KEY') as unknown as string,
    });
    // models.dev 等への外部fetchは一切起きない（登録簿はバンドル済みJSON）。
    expect(fetcher).not.toHaveBeenCalled();
  });

  describe('capabilities', () => {
    it('options指定が最優先される', () => {
      expect(new MastraModelProvider({ model: 'openai/gpt-4o', capabilities: ['chat'] }).capabilities()).toEqual(['chat']);
    });

    it('登録簿が添付非対応と明示するモデルだけvisionを落とす', () => {
      expect(new MastraModelProvider({ model: 'openai/o3-mini' }).capabilities())
        .toEqual(['chat', 'tool-calling', 'structured-output']);
    });

    it('カスタムエンドポイントは登録簿の対象外なので既定のままにする', () => {
      expect(new MastraModelProvider({ model: { id: 'openai/o3-mini', url: 'http://127.0.0.1:1/v1' } }).capabilities())
        .toContain('vision');
    });
  });

  describe('timeout', () => {
    it('パートが途絶えたらidleTimeoutMsで打ち切る（原因が分かるメッセージ）', async () => {
      const fake = await startFake((_body, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
      });

      await expect(provider(fake, { timeoutMs: 10_000, idleTimeoutMs: 150 }).complete({ messages: [] }))
        .rejects.toMatchObject({ message: 'Model request timed out: no output for 150ms' });
    });

    it('パートが来続けても総時間上限を超えたら打ち切る', async () => {
      const fake = await startFake((_body, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const timer = setInterval(() => {
          try { res.write(`data: ${JSON.stringify(textChunk('.'))}\n\n`); } catch { /* closed */ }
        }, 20);
        res.on('close', () => clearInterval(timer));
      });

      await expect(provider(fake, { timeoutMs: 250, idleTimeoutMs: 10_000 }).complete({ messages: [] }))
        .rejects.toMatchObject({ message: 'Model request timed out: exceeded total limit 250ms' });
    });

    it('パートが来続ける限りidleTimeoutMsを超えても継続する', async () => {
      const fake = await startFake((_body, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let sent = 0;
        const timer = setInterval(() => {
          sent += 1;
          try {
            res.write(`data: ${JSON.stringify(textChunk('.', sent === 6 ? 'stop' : null))}\n\n`);
            if (sent === 6) { res.write('data: [DONE]\n\n'); res.end(); clearInterval(timer); }
          } catch { clearInterval(timer); }
        }, 25);
        res.on('close', () => clearInterval(timer));
      });

      await expect(provider(fake, { timeoutMs: 10_000, idleTimeoutMs: 120 }).complete({ messages: [] }))
        .resolves.toMatchObject({ message: { content: '......' }, finishReason: 'stop' });
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_WINDOW_TTL_MS, ContextWindowProbe, lmStudioModelInfoEndpoint, readLmStudioContextWindow } from './lm-studio-context-window';

function fetcherOf(body: unknown, status = 200): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('lmStudioModelInfoEndpoint', () => {
  it('正常: `…/v1` で終わる baseUrl から LM Studio 固有の /api/v0/models/<id> を組み、id の `/` は 1 つのパス要素へ符号化する', () => {
    expect(lmStudioModelInfoEndpoint('http://127.0.0.1:1234/v1', 'google/gemma-4-12b')).toBe('http://127.0.0.1:1234/api/v0/models/google%2Fgemma-4-12b');
  });

  it('境界: 末尾の `/` は取り除いてから判定する', () => {
    expect(lmStudioModelInfoEndpoint('http://127.0.0.1:1234/v1/', 'm')).toBe('http://127.0.0.1:1234/api/v0/models/m');
  });

  it('異常: `/v1` で終わらない baseUrl（LM Studio ではない）とモデル未設定では undefined', () => {
    expect(lmStudioModelInfoEndpoint('https://api.openai.com', 'gpt-4o')).toBeUndefined();
    expect(lmStudioModelInfoEndpoint('http://127.0.0.1:1234/v1', '  ')).toBeUndefined();
  });
});

describe('readLmStudioContextWindow', () => {
  const options = { baseUrl: 'http://x/v1', model: 'm' };

  it('正常: 載せたときの実際の長さ（loaded_context_length）を宣言上の上限より優先する', async () => {
    const { fetcher, calls } = fetcherOf({ loaded_context_length: 8192, max_context_length: 131072 });
    await expect(readLmStudioContextWindow({ ...options, fetcher })).resolves.toBe(8192);
    expect(calls).toEqual(['http://x/api/v0/models/m']);
  });

  it('正常: loaded が無ければ max_context_length で代える。apiKey があれば Bearer で送る', async () => {
    let headers: RequestInit['headers'];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => { headers = init?.headers; return new Response(JSON.stringify({ max_context_length: 4096 })); }) as typeof fetch;
    await expect(readLmStudioContextWindow({ ...options, apiKey: 'k', fetcher })).resolves.toBe(4096);
    expect(headers).toEqual({ authorization: 'Bearer k' });
  });

  it('異常: HTTP エラー・JSON でない本文・正の整数でない値は undefined（例外にしない = 取れないのは正常系）', async () => {
    await expect(readLmStudioContextWindow({ ...options, fetcher: fetcherOf({}, 404).fetcher })).resolves.toBeUndefined();
    await expect(readLmStudioContextWindow({ ...options, fetcher: fetcherOf('not json').fetcher })).resolves.toBeUndefined();
    await expect(readLmStudioContextWindow({ ...options, fetcher: fetcherOf({ loaded_context_length: '8192', max_context_length: 0 }).fetcher })).resolves.toBeUndefined();
    await expect(readLmStudioContextWindow({ ...options, fetcher: fetcherOf({ loaded_context_length: 1.5 }).fetcher })).resolves.toBeUndefined();
  });

  it('例外: fetch が投げても undefined で、LM Studio でない baseUrl では fetch を呼ばない', async () => {
    const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(readLmStudioContextWindow({ ...options, fetcher: throwing })).resolves.toBeUndefined();
    const spy = vi.fn();
    await expect(readLmStudioContextWindow({ baseUrl: 'https://api.openai.com', model: 'm', fetcher: spy as unknown as typeof fetch })).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ContextWindowProbe（成否とも 60 秒保持）', () => {
  it('正常: 保持時間内は問い合わせを繰り返さず、過ぎたら取り直す', async () => {
    let now = 0;
    const { fetcher, calls } = fetcherOf({ loaded_context_length: 8192 });
    const probe = new ContextWindowProbe({ baseUrl: 'http://x/v1', model: 'm', fetcher, now: () => now });
    await expect(probe.read()).resolves.toBe(8192);
    now = CONTEXT_WINDOW_TTL_MS - 1;
    await expect(probe.read()).resolves.toBe(8192);
    expect(calls).toHaveLength(1);
    now = CONTEXT_WINDOW_TTL_MS;
    await expect(probe.read()).resolves.toBe(8192);
    expect(calls).toHaveLength(2);
  });

  it('境界: 取れなかった結果（undefined）も保持し、毎回サーバを叩かない', async () => {
    const { fetcher, calls } = fetcherOf({}, 500);
    const probe = new ContextWindowProbe({ baseUrl: 'http://x/v1', model: 'm', fetcher, now: () => 0 });
    await expect(probe.read()).resolves.toBeUndefined();
    await expect(probe.read()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

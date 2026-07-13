import { describe, expect, it, vi } from 'vitest';
import { EnvironmentSearchProviderCatalog } from './environment-search-provider-catalog';

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }

describe('EnvironmentSearchProviderCatalog', () => {
  it('必要なenvが揃うproviderだけを安全な要約として公開する', () => {
    const catalog = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 't', GOOGLE_CUSTOM_SEARCH_API_KEY: 'g' });
    expect(catalog.list()).toEqual([{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }]);
  });

  it('TavilyとTinyFishの応答を共通行へ正規化し、キーを返さない', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ results: [{ title: 'T', url: 'https://t.example', content: 'snippet', score: 0.5 }] }))
      .mockResolvedValueOnce(response({ results: [{ title: 'F', url: 'https://f.example', snippet: 'fish', position: 1 }] }));
    const catalog = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 'tavily-secret', TINYFISH_API_KEY: 'tiny-secret' }, fetcher);
    await expect(catalog.search({ provider: 'tavily', query: 'query', maxResults: 2 })).resolves.toMatchObject([{ title: 'T', provider: 'tavily', score: 0.5 }]);
    await expect(catalog.search({ provider: 'tinyfish', query: 'query', maxResults: 2 })).resolves.toMatchObject([{ title: 'F', provider: 'tinyfish', score: 1 }]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer tavily-secret' }) });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('query=query');
    expect(JSON.stringify(catalog.list())).not.toContain('secret');
  });

  it('Google Custom Searchのdomain指定をURLへ変換し、不完全な結果を除外する', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ items: [
      { title: 'Guide', link: 'https://docs.example/guide' },
      { title: 'Missing URL' },
      null,
    ] }));
    const catalog = new EnvironmentSearchProviderCatalog({ GOOGLE_CUSTOM_SEARCH_API_KEY: 'key', GOOGLE_CUSTOM_SEARCH_ENGINE_ID: 'engine' }, fetcher);

    await expect(catalog.search({ provider: 'google-custom-search', query: 'agent ops', maxResults: 3, includeDomains: ['docs.example'] })).resolves.toMatchObject([
      { title: 'Guide', url: 'https://docs.example/guide', snippet: '', score: null, provider: 'google-custom-search' },
    ]);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('key')).toBe('key');
    expect(url.searchParams.get('cx')).toBe('engine');
    expect(url.searchParams.get('q')).toBe('agent ops');
    expect(url.searchParams.get('num')).toBe('3');
    expect(url.searchParams.get('siteSearch')).toBe('docs.example');
  });

  it('未設定キー、複数Google domain、異常なHTTP/JSON応答を拒否する', async () => {
    const missing = new EnvironmentSearchProviderCatalog({}, vi.fn());
    await expect(missing.search({ provider: 'tavily', query: 'q', maxResults: 1 })).rejects.toThrow('not configured');

    const catalog = new EnvironmentSearchProviderCatalog({ GOOGLE_CUSTOM_SEARCH_API_KEY: 'key', GOOGLE_CUSTOM_SEARCH_ENGINE_ID: 'engine' }, vi.fn());
    await expect(catalog.search({ provider: 'google-custom-search', query: 'q', maxResults: 1, includeDomains: ['one.example', 'two.example'] })).rejects.toThrow('one include domain');

    const failedHttp = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 'key' }, vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(failedHttp.search({ provider: 'tavily', query: 'q', maxResults: 1 })).rejects.toThrow('request failed (503)');

    const invalidJson = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 'key' }, vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    await expect(invalidJson.search({ provider: 'tavily', query: 'q', maxResults: 1 })).rejects.toThrow('invalid JSON');
  });

  it('全providerを公開し、TinyFishの上限・不完全結果・応答サイズ制限を守る', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ results: [
      { title: 'First', url: 'https://first.example', snippet: 'one' },
      { title: 'Second', url: 'https://second.example', snippet: 42, position: 'second' },
      { url: 'https://missing-title.example' },
    ] }));
    const catalog = new EnvironmentSearchProviderCatalog({
      TAVILY_API_KEY: 't', TINYFISH_API_KEY: 'f', GOOGLE_CUSTOM_SEARCH_API_KEY: 'g', GOOGLE_CUSTOM_SEARCH_ENGINE_ID: 'c',
    }, fetcher);
    expect(catalog.list().map((provider) => provider.id)).toEqual(['tavily', 'tinyfish', 'google-custom-search']);
    await expect(catalog.search({ provider: 'tinyfish', query: 'q', maxResults: 1 })).resolves.toMatchObject([
      { title: 'First', snippet: 'one', score: null },
    ]);

    const tooLarge = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 'key' }, vi.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } }),
    ));
    await expect(tooLarge.search({ provider: 'tavily', query: 'q', maxResults: 1 })).rejects.toThrow('too large');
  });

  it('空白だけのキーを無効扱いにし、domainなしGoogleと配列でない結果を扱う', async () => {
    expect(new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: '   ', TINYFISH_API_KEY: '' }).list()).toEqual([]);
    const googleFetcher = vi.fn().mockResolvedValue(response({ items: [] }));
    const google = new EnvironmentSearchProviderCatalog({ GOOGLE_CUSTOM_SEARCH_API_KEY: 'key', GOOGLE_CUSTOM_SEARCH_ENGINE_ID: 'engine' }, googleFetcher);
    await expect(google.search({ provider: 'google-custom-search', query: 'q', maxResults: 1 })).resolves.toEqual([]);
    expect(new URL(String(googleFetcher.mock.calls[0]?.[0])).searchParams.has('siteSearch')).toBe(false);

    const noResults = new EnvironmentSearchProviderCatalog({ TAVILY_API_KEY: 'key' }, vi.fn().mockResolvedValue(response({ results: {} })));
    await expect(noResults.search({ provider: 'tavily', query: 'q', maxResults: 1 })).resolves.toEqual([]);
  });
});

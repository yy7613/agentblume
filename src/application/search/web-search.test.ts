import { describe, expect, it, vi } from 'vitest';
import type { SearchProviderCatalog } from './search-provider';
import { WebSearchUseCase } from './web-search';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const catalog: SearchProviderCatalog = {
  list: () => [{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }],
  search: vi.fn(async (request) => [{ title: request.query, url: 'https://example.test', snippet: 'snippet', score: 0.9, provider: request.provider, retrievedAt: '2026-07-12T00:00:00.000Z' }]),
};

describe('WebSearchUseCase', () => {
  it('明示取得した行だけをscope付きTTLキャッシュから解決する', async () => {
    const search = new WebSearchUseCase(catalog, () => 'cache-1', () => new Date('2026-07-12T00:00:00.000Z'));
    const cached = await search.fetch(scope, { provider: 'tavily', query: '  agent ops  ', maxResults: 3, includeDomains: ['example.com'] });
    expect(cached).toMatchObject({ cacheKey: 'cache-1', query: 'agent ops', maxResults: 3, includeDomains: ['example.com'] });
    expect(search.resolve(scope, { cacheKey: 'cache-1', provider: 'tavily', query: 'agent ops', maxResults: 3, includeDomains: ['example.com'] })).toEqual(cached.rows);
    expect(() => search.resolve(scope, { cacheKey: 'cache-1', provider: 'tavily', query: 'other', maxResults: 3, includeDomains: ['example.com'] })).toThrow('does not match');
    expect(() => search.resolve({ tenantId: 'other', workspaceId: 'workspace' }, { cacheKey: 'cache-1', provider: 'tavily', query: 'agent ops', maxResults: 3, includeDomains: ['example.com'] })).toThrow('unavailable');
  });

  describe('キャッシュの上限とスイープ（メモリ枯渇の防止）', () => {
    /** 連番のcacheKeyと進む時計を持つ use case。 */
    function makeSearch(start = Date.parse('2026-07-12T00:00:00.000Z')) {
      let id = 0; let clock = start;
      const search = new WebSearchUseCase(catalog, () => `cache-${(id += 1)}`, () => new Date(clock));
      return { search, advance: (ms: number) => { clock += ms; } };
    }

    it('TTLを過ぎた項目は次の取得で掃除される（resolveされなくても残らない）', async () => {
      const { search, advance } = makeSearch();
      for (let i = 0; i < 5; i += 1) await search.fetch(scope, { provider: 'tavily', query: `q${i}` });
      expect(search.cachedCount).toBe(5);

      advance(16 * 60 * 1000); // TTL（15分）超過
      await search.fetch(scope, { provider: 'tavily', query: 'fresh' });
      expect(search.cachedCount).toBe(1);
    });

    it('件数上限を超えたら古い順に捨てる（上限なしに増えない）', async () => {
      const { search } = makeSearch();
      for (let i = 0; i < 520; i += 1) await search.fetch(scope, { provider: 'tavily', query: `q${i}` });
      expect(search.cachedCount).toBeLessThanOrEqual(500);
      // 最初期のキーは落ちているが、直近のものは引ける。
      expect(() => search.resolve(scope, { cacheKey: 'cache-1', provider: 'tavily', query: 'q0', maxResults: 5 })).toThrow('unavailable');
      expect(search.resolve(scope, { cacheKey: 'cache-520', provider: 'tavily', query: 'q519', maxResults: 5 })).toHaveLength(1);
    });
  });

  it('未設定providerと上限外の入力をfail closedにする', async () => {
    const search = new WebSearchUseCase(catalog);
    await expect(search.fetch(scope, { provider: 'google-custom-search', query: 'x' })).rejects.toThrow('not configured');
    await expect(search.fetch(scope, { provider: 'tavily', query: 'x', maxResults: 11 })).rejects.toThrow('1..10');
  });
});

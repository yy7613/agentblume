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

  it('未設定providerと上限外の入力をfail closedにする', async () => {
    const search = new WebSearchUseCase(catalog);
    await expect(search.fetch(scope, { provider: 'google-custom-search', query: 'x' })).rejects.toThrow('not configured');
    await expect(search.fetch(scope, { provider: 'tavily', query: 'x', maxResults: 11 })).rejects.toThrow('1..10');
  });
});

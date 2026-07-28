import { randomUUID } from 'node:crypto';
import type { Row } from '../../domain/data/types';
import type { TenantScope } from '../../domain/tool/ids';
import type { SearchProviderCatalog, SearchProviderId, SearchProviderSummary } from './search-provider';

const MAX_QUERY_LENGTH = 2_000;
const MAX_RESULTS = 10;
const CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * キャッシュに置く検索結果の最大件数。
 *
 * 以前は上限もスイープも無い `Map` だったため、**取得のたびに1件ずつ永久に積み上がった**
 * （`resolve` で期限切れに当たったときだけ1件消える）。1件あたり最大10件の検索結果本文なので、
 * 常用すればプロセスのメモリを食い潰す。TTL（15分）を過ぎたものは誰も使えないのだから、
 * 期限切れの掃除と件数上限の両方を入れる。
 */
const MAX_CACHE_ENTRIES = 500;

export class WebSearchValidationError extends Error {
  readonly code = 'WEB_SEARCH_VALIDATION';
  constructor(message: string) { super(message); this.name = 'WebSearchValidationError'; }
}

export interface CachedWebSearch {
  readonly cacheKey: string;
  readonly provider: SearchProviderId;
  readonly query: string;
  readonly maxResults: number;
  readonly includeDomains: readonly string[];
  readonly rows: readonly Row[];
  readonly retrievedAt: string;
  readonly expiresAt: string;
}

interface CacheEntry extends CachedWebSearch { readonly scope: TenantScope }

/** 明示取得された検索結果だけを保持し、Tool graphはopaqueなcacheKeyだけを参照する。 */
export class WebSearchUseCase {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly providers: SearchProviderCatalog,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listProviders(): readonly SearchProviderSummary[] { return this.providers.list(); }

  isConfigured(provider: string): provider is SearchProviderId {
    return ['tavily', 'tinyfish', 'google-custom-search'].includes(provider) && this.providers.list().some((item) => item.id === provider);
  }

  async fetch(scope: TenantScope, input: { readonly provider: SearchProviderId; readonly query: string; readonly maxResults?: number; readonly includeDomains?: readonly string[] }): Promise<CachedWebSearch> {
    const request = this.validate(input);
    if (!this.isConfigured(request.provider)) throw new WebSearchValidationError(`search provider is not configured: ${request.provider}`);
    const rows = await this.providers.search(request);
    const now = this.now();
    const entry: CacheEntry = {
      cacheKey: this.makeId(), scope, provider: request.provider, query: request.query,
      maxResults: request.maxResults, includeDomains: request.includeDomains ?? [], rows,
      retrievedAt: now.toISOString(), expiresAt: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    };
    this.entries.set(entry.cacheKey, entry);
    this.evict(now.getTime());
    return withoutScope(entry);
  }

  /**
   * 期限切れを掃除し、それでも上限を超えるなら**古い順**に捨てる。
   *
   * `Map` は挿入順を保つので、先頭が最も古い。上限に当たった利用者には
   * 「取得し直してください」という既存のエラー（`resolve` の cache unavailable）が出る。
   */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (new Date(entry.expiresAt).getTime() <= now) this.entries.delete(key);
    }
    if (this.entries.size <= MAX_CACHE_ENTRIES) return;
    for (const key of [...this.entries.keys()].slice(0, this.entries.size - MAX_CACHE_ENTRIES)) this.entries.delete(key);
  }

  /** 保持している件数（テスト・診断用）。 */
  get cachedCount(): number { return this.entries.size; }

  resolve(scope: TenantScope, input: { readonly cacheKey: string; readonly provider: string; readonly query: string; readonly maxResults: number; readonly includeDomains?: readonly string[] }): readonly Row[] {
    const entry = this.entries.get(input.cacheKey);
    if (entry === undefined || entry.scope.tenantId !== scope.tenantId || entry.scope.workspaceId !== scope.workspaceId) {
      throw new WebSearchValidationError('web search cache is unavailable; fetch results again');
    }
    if (new Date(entry.expiresAt).getTime() <= this.now().getTime()) {
      this.entries.delete(entry.cacheKey);
      throw new WebSearchValidationError('web search cache has expired; fetch results again');
    }
    if (!this.providers.list().some((provider) => provider.id === entry.provider)) {
      throw new WebSearchValidationError(`search provider is not configured: ${entry.provider}`);
    }
    if (entry.provider !== input.provider || entry.query !== input.query || entry.maxResults !== input.maxResults || !sameDomains(entry.includeDomains, input.includeDomains ?? [])) {
      throw new WebSearchValidationError('web search cache does not match the current node settings; fetch results again');
    }
    return entry.rows;
  }

  private validate(input: { readonly provider: SearchProviderId; readonly query: string; readonly maxResults?: number; readonly includeDomains?: readonly string[] }): { readonly provider: SearchProviderId; readonly query: string; readonly maxResults: number; readonly includeDomains?: readonly string[] } {
    const query = input.query.trim();
    if (!['tavily', 'tinyfish', 'google-custom-search'].includes(input.provider)) throw new WebSearchValidationError('unknown search provider');
    if (query === '' || query.length > MAX_QUERY_LENGTH) throw new WebSearchValidationError(`search query must be 1..${MAX_QUERY_LENGTH} characters`);
    const maxResults = input.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new WebSearchValidationError(`maxResults must be 1..${MAX_RESULTS}`);
    const includeDomains = input.includeDomains?.map((domain) => domain.trim()).filter(Boolean) ?? [];
    if (includeDomains.length > 10 || includeDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) {
      throw new WebSearchValidationError('includeDomains must contain at most 10 valid domain names');
    }
    return { provider: input.provider, query, maxResults, ...(includeDomains.length === 0 ? {} : { includeDomains }) };
  }
}

function sameDomains(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function withoutScope(entry: CacheEntry): CachedWebSearch {
  const { scope: _scope, ...value } = entry;
  return value;
}

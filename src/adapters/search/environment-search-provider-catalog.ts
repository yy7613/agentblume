import type { NormalizedSearchRow, SearchProviderCatalog, SearchProviderId, SearchProviderSummary, SearchRequest } from '../../application/search/search-provider';

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

/** envのキーが存在するproviderだけを公開し、HTTP詳細と認証をbackend adapterへ閉じ込める。 */
export class EnvironmentSearchProviderCatalog implements SearchProviderCatalog {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: FetchLike = fetch) {}

  list(): readonly SearchProviderSummary[] {
    const providers: SearchProviderSummary[] = [];
    if (hasValue(this.env['TAVILY_API_KEY'])) providers.push({ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true });
    if (hasValue(this.env['TINYFISH_API_KEY'])) providers.push({ id: 'tinyfish', label: 'TinyFish Search', supportsDomainFilter: true });
    if (hasValue(this.env['GOOGLE_CUSTOM_SEARCH_API_KEY']) && hasValue(this.env['GOOGLE_CUSTOM_SEARCH_ENGINE_ID'])) providers.push({ id: 'google-custom-search', label: 'Google Custom Search (legacy)', supportsDomainFilter: true });
    return providers;
  }

  async search(request: SearchRequest): Promise<readonly NormalizedSearchRow[]> {
    const retrievedAt = new Date().toISOString();
    switch (request.provider) {
      case 'tavily': return tavily(this.fetcher, required(this.env, 'TAVILY_API_KEY'), request, retrievedAt);
      case 'tinyfish': return tinyfish(this.fetcher, required(this.env, 'TINYFISH_API_KEY'), request, retrievedAt);
      case 'google-custom-search': return google(this.fetcher, required(this.env, 'GOOGLE_CUSTOM_SEARCH_API_KEY'), required(this.env, 'GOOGLE_CUSTOM_SEARCH_ENGINE_ID'), request, retrievedAt);
    }
  }
}

function hasValue(value: string | undefined): boolean { return value !== undefined && value.trim() !== ''; }
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!hasValue(value)) throw new Error('search provider is not configured');
  return value!;
}

async function readJson(fetcher: FetchLike, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`search provider request failed (${response.status})`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('search provider response is too large');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('search provider response is too large');
    const json: unknown = JSON.parse(body);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('search provider returned invalid JSON');
    return json as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}

async function tavily(fetcher: FetchLike, key: string, request: SearchRequest, retrievedAt: string): Promise<readonly NormalizedSearchRow[]> {
  const body = await readJson(fetcher, 'https://api.tavily.com/search', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: request.query, search_depth: 'basic', max_results: request.maxResults, include_answer: false, include_raw_content: false, include_domains: request.includeDomains ?? [] }),
  });
  return rowsFrom(body['results'], 'tavily', retrievedAt, (value) => ({ title: value['title'], url: value['url'], snippet: value['content'], score: value['score'] }));
}

async function tinyfish(fetcher: FetchLike, key: string, request: SearchRequest, retrievedAt: string): Promise<readonly NormalizedSearchRow[]> {
  const url = new URL('https://api.search.tinyfish.ai');
  url.searchParams.set('query', request.query);
  // TinyFishはページ単位のAPIのため、上限件数は受信配列を切り詰めて守る。
  const body = await readJson(fetcher, url.toString(), { headers: { 'X-API-Key': key } });
  return rowsFrom(body['results'], 'tinyfish', retrievedAt, (value) => ({ title: value['title'], url: value['url'], snippet: value['snippet'], score: typeof value['position'] === 'number' ? value['position'] : null })).slice(0, request.maxResults);
}

async function google(fetcher: FetchLike, key: string, engineId: string, request: SearchRequest, retrievedAt: string): Promise<readonly NormalizedSearchRow[]> {
  if ((request.includeDomains?.length ?? 0) > 1) throw new Error('Google Custom Search supports one include domain per request');
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', key); url.searchParams.set('cx', engineId); url.searchParams.set('q', request.query); url.searchParams.set('num', String(request.maxResults));
  if ((request.includeDomains?.length ?? 0) === 1) url.searchParams.set('siteSearch', request.includeDomains![0]!);
  const body = await readJson(fetcher, url.toString(), {});
  return rowsFrom(body['items'], 'google-custom-search', retrievedAt, (value) => ({ title: value['title'], url: value['link'], snippet: value['snippet'], score: null }));
}

function rowsFrom(value: unknown, provider: SearchProviderId, retrievedAt: string, map: (item: Record<string, unknown>) => { title: unknown; url: unknown; snippet: unknown; score: unknown }): NormalizedSearchRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const result = map(item as Record<string, unknown>);
    if (typeof result.title !== 'string' || typeof result.url !== 'string') return [];
    return [{ title: result.title, url: result.url, snippet: typeof result.snippet === 'string' ? result.snippet : '', score: typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : null, provider, retrievedAt }];
  });
}

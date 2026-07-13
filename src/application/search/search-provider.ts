import type { Row } from '../../domain/data/types';

export const SEARCH_PROVIDER_IDS = ['tavily', 'tinyfish', 'google-custom-search'] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

/** APIキーや接続情報を含まない、Tool Builderに返してよいprovider情報。 */
export interface SearchProviderSummary {
  readonly id: SearchProviderId;
  readonly label: string;
  readonly supportsDomainFilter: boolean;
}

export interface SearchRequest {
  readonly provider: SearchProviderId;
  readonly query: string;
  readonly maxResults: number;
  readonly includeDomains?: readonly string[];
}

/** provider固有の検索結果をETLへ渡す共通行へ正規化する。 */
export type NormalizedSearchRow = Row & {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly score: number | null;
  readonly provider: string;
  readonly retrievedAt: string;
};

export interface SearchProviderCatalog {
  list(): readonly SearchProviderSummary[];
  search(request: SearchRequest): Promise<readonly NormalizedSearchRow[]>;
}

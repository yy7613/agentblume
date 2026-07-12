/**
 * ドメイン: Wiki リポジトリ境界（v21 実装契約 §1.5 / ADR-0016）
 *
 * save は id で upsert（改訂は現在版を置換）。検索は v1 キーワード/タグ一致。
 * 埋め込み検索（M4）は将来 ModelProviderPort.embed を用いる別実装で拡張する。
 */
import type { TenantScope } from '../tool/ids';
import type { WikiPage, WikiPageSummary } from './wiki-page';
import type { WikiSpace, WikiSpaceSummary } from './wiki-space';

export interface WikiRepository {
  saveSpace(space: WikiSpace): Promise<void>;
  findSpace(scope: TenantScope, id: string): Promise<WikiSpace | null>;
  listSpaces(scope: TenantScope): Promise<WikiSpaceSummary[]>;
  save(page: WikiPage): Promise<void>;
  find(scope: TenantScope, id: string): Promise<WikiPage | null>;
  list(scope: TenantScope, wikiId?: string): Promise<WikiPageSummary[]>;
  /** query を空白分割し全語が title/body/tags のいずれかに部分一致するページ要約を updatedAt DESC で返す。 */
  search(scope: TenantScope, query: string, limit: number, wikiIds?: readonly string[]): Promise<WikiPageSummary[]>;
}

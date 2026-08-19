/**
 * ドメイン: Wiki リポジトリ境界（v21 実装契約 §1.5 / ADR-0016）
 *
 * save は id で upsert（改訂は現在版を置換）。検索は v1 キーワード/タグ一致。
 * 埋め込み検索（M4）は将来 ModelProviderPort.embed を用いる別実装で拡張する。
 */
import type { TenantScope } from '../tool/ids';
import type { WikiPageId, WikiSpaceId } from './ids';
import type { WikiPage, WikiPageSummary } from './wiki-page';
import type { WikiSpace, WikiSpaceSummary } from './wiki-space';

export interface WikiRepository {
  saveSpace(space: WikiSpace): Promise<void>;
  findSpace(scope: TenantScope, id: WikiSpaceId): Promise<WikiSpace | null>;
  listSpaces(scope: TenantScope): Promise<WikiSpaceSummary[]>;
  /** Wiki空間を削除する（配下のページは削除しない）。戻り値は削除前に存在したか。 */
  deleteSpace(scope: TenantScope, id: WikiSpaceId): Promise<boolean>;
  save(page: WikiPage): Promise<void>;
  find(scope: TenantScope, id: WikiPageId): Promise<WikiPage | null>;
  list(scope: TenantScope, wikiId?: WikiSpaceId): Promise<WikiPageSummary[]>;
  /** query を空白分割し全語が title/body/tags のいずれかに部分一致するページ要約を updatedAt DESC で返す。 */
  search(scope: TenantScope, query: string, limit: number, wikiIds?: readonly WikiSpaceId[]): Promise<WikiPageSummary[]>;
  /** Wikiページを削除する。Agent/Harnessには版がなく、findVersion的な保持は不要（即時に不可視化する）。戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, id: WikiPageId): Promise<boolean>;
}

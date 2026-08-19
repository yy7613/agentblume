/**
 * application層: Wiki 参照（v21 実装契約 §3 / ADR-0016 M1）
 */
import type { TenantScope } from '../../domain/tool/ids';
import { WikiPageNotFoundError } from '../../domain/memory/errors';
import type { WikiPageId, WikiSpaceId } from '../../domain/memory/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import type { WikiPage, WikiPageSummary } from '../../domain/memory/wiki-page';

export class QueryWikiUseCase {
  constructor(private readonly wiki: WikiRepository) {}

  async get(scope: TenantScope, id: WikiPageId): Promise<WikiPage> {
    const page = await this.wiki.find(scope, id);
    if (page === null) throw new WikiPageNotFoundError(`QueryWiki: wiki page not found: ${id}`);
    return page;
  }

  async list(scope: TenantScope, wikiId?: WikiSpaceId): Promise<WikiPageSummary[]> {
    return this.wiki.list(scope, wikiId);
  }

  /** query 空なら全件（updatedAt DESC）。 */
  async search(scope: TenantScope, query: string, limit = 10, wikiIds?: readonly WikiSpaceId[]): Promise<WikiPageSummary[]> {
    return this.wiki.search(scope, query, limit, wikiIds);
  }
}

/** 保存済みWikiページの削除。repository.delete が false なら WikiPageNotFoundError。 */
export class DeleteWikiPageUseCase {
  constructor(private readonly wiki: WikiRepository) {}
  async execute(scope: TenantScope, id: WikiPageId): Promise<void> {
    const existed = await this.wiki.delete(scope, id);
    if (!existed) throw new WikiPageNotFoundError(`DeleteWiki: wiki page not found: ${id}`);
  }
}

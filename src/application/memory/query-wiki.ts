/**
 * application層: Wiki 参照（v21 実装契約 §3 / ADR-0016 M1）
 */
import type { TenantScope } from '../../domain/tool/ids';
import { WikiPageNotFoundError } from '../../domain/memory/errors';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import type { WikiPage, WikiPageSummary } from '../../domain/memory/wiki-page';

export class QueryWikiUseCase {
  constructor(private readonly wiki: WikiRepository) {}

  async get(scope: TenantScope, id: string): Promise<WikiPage> {
    const page = await this.wiki.find(scope, id);
    if (page === null) throw new WikiPageNotFoundError(`QueryWiki: wiki page not found: ${id}`);
    return page;
  }

  async list(scope: TenantScope): Promise<WikiPageSummary[]> {
    return this.wiki.list(scope);
  }

  /** query 空なら全件（updatedAt DESC）。 */
  async search(scope: TenantScope, query: string, limit = 10): Promise<WikiPageSummary[]> {
    return this.wiki.search(scope, query, limit);
  }
}

import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { summarizeWikiPage, type WikiPage, type WikiPageSummary } from '../../domain/memory/wiki-page';
import { deserializeWikiPage, serializeWikiPage, type SerializedWikiPage } from '../../domain/memory/serialization';

const key = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;

/** ページが query の全語を title/body/tags のいずれかに含むか（大小無視）。 */
function matches(page: WikiPage, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${page.title}\n${page.body}\n${page.tags.join(' ')}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export class InMemoryWikiRepository implements WikiRepository {
  private readonly store = new Map<string, SerializedWikiPage>();

  async save(page: WikiPage): Promise<void> {
    this.store.set(key(page.tenant, page.id), serializeWikiPage(page));
  }

  async find(scope: TenantScope, id: string): Promise<WikiPage | null> {
    const value = this.store.get(key(scope, id));
    return value === undefined ? null : deserializeWikiPage(value);
  }

  async list(scope: TenantScope): Promise<WikiPageSummary[]> {
    return this.pages(scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summarizeWikiPage);
  }

  async search(scope: TenantScope, query: string, limit: number): Promise<WikiPageSummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return this.pages(scope)
      .filter((page) => matches(page, terms))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, limit))
      .map(summarizeWikiPage);
  }

  private pages(scope: TenantScope): WikiPage[] {
    return [...this.store.values()]
      .filter((value) => tenantKey(value.tenant) === tenantKey(scope))
      .map(deserializeWikiPage);
  }
}

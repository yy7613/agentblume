import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { effectiveWikiId, summarizeWikiPage, type WikiPage, type WikiPageSummary } from '../../domain/memory/wiki-page';
import { deserializeWikiPage, deserializeWikiSpace, serializeWikiPage, serializeWikiSpace, type SerializedWikiPage, type SerializedWikiSpace } from '../../domain/memory/serialization';
import { createWikiSpace, DEFAULT_WIKI_ID, summarizeWikiSpace, type WikiSpace, type WikiSpaceSummary } from '../../domain/memory/wiki-space';

const key = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;

/** ページが query の全語を title/body/tags のいずれかに含むか（大小無視）。 */
function matches(page: WikiPage, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${page.title}\n${page.body}\n${page.tags.join(' ')}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export class InMemoryWikiRepository implements WikiRepository {
  private readonly store = new Map<string, SerializedWikiPage>();
  private readonly spaces = new Map<string, SerializedWikiSpace>();

  async saveSpace(space: WikiSpace): Promise<void> { this.spaces.set(key(space.tenant, space.id), serializeWikiSpace(space)); }

  async findSpace(scope: TenantScope, id: string): Promise<WikiSpace | null> {
    const value = this.spaces.get(key(scope, id));
    return value === undefined ? null : deserializeWikiSpace(value);
  }

  async listSpaces(scope: TenantScope): Promise<WikiSpaceSummary[]> {
    return [...this.spaces.values()]
      .filter((value) => tenantKey(value.tenant) === tenantKey(scope))
      .map(deserializeWikiSpace)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeWikiSpace);
  }

  async deleteSpace(scope: TenantScope, id: string): Promise<boolean> {
    return this.spaces.delete(key(scope, id));
  }

  async save(page: WikiPage): Promise<void> {
    const wikiId = effectiveWikiId(page);
    if (wikiId === DEFAULT_WIKI_ID && await this.findSpace(page.tenant, wikiId) === null) {
      await this.saveSpace(createWikiSpace({ id: wikiId, tenant: page.tenant, name: 'Default Wiki', createdAt: page.updatedAt }));
    }
    this.store.set(key(page.tenant, page.id), serializeWikiPage(page));
  }

  async find(scope: TenantScope, id: string): Promise<WikiPage | null> {
    const value = this.store.get(key(scope, id));
    return value === undefined ? null : deserializeWikiPage(value);
  }

  async list(scope: TenantScope, wikiId?: string): Promise<WikiPageSummary[]> {
    return this.pages(scope).filter((page) => wikiId === undefined || effectiveWikiId(page) === wikiId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summarizeWikiPage);
  }

  async search(scope: TenantScope, query: string, limit: number, wikiIds?: readonly string[]): Promise<WikiPageSummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return this.pages(scope)
      .filter((page) => wikiIds === undefined || wikiIds.includes(effectiveWikiId(page)))
      .filter((page) => matches(page, terms))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, limit))
      .map(summarizeWikiPage);
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }

  private pages(scope: TenantScope): WikiPage[] {
    return [...this.store.values()]
      .filter((value) => tenantKey(value.tenant) === tenantKey(scope))
      .map(deserializeWikiPage);
  }
}

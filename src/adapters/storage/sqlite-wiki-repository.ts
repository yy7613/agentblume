import { DatabaseSync } from 'node:sqlite';
import type { TenantScope } from '../../domain/tool/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { effectiveWikiId, summarizeWikiPage, type WikiPage, type WikiPageSummary } from '../../domain/memory/wiki-page';
import { deserializeWikiPage, deserializeWikiSpace, serializeWikiPage, serializeWikiSpace, type SerializedWikiPage, type SerializedWikiSpace } from '../../domain/memory/serialization';
import { createWikiSpace, DEFAULT_WIKI_ID, summarizeWikiSpace, type WikiSpace, type WikiSpaceSummary } from '../../domain/memory/wiki-space';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS wiki_pages (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    wiki_id TEXT NOT NULL DEFAULT 'default',
    updated_at TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_updated
    ON wiki_pages (tenant_id, workspace_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS wiki_spaces (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  );
`;

const fromJson = (value: unknown): WikiPage => deserializeWikiPage(JSON.parse(String(value)) as SerializedWikiPage);

function matches(page: WikiPage, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${page.title}\n${page.body}\n${page.tags.join(' ')}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export class SqliteWikiRepository implements WikiRepository {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(CREATE_TABLE_SQL);
    const columns = this.db.prepare(`PRAGMA table_info(wiki_pages)`).all();
    if (!columns.some((column) => String(column['name']) === 'wiki_id')) {
      this.db.exec(`ALTER TABLE wiki_pages ADD COLUMN wiki_id TEXT NOT NULL DEFAULT 'default'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_wiki_updated ON wiki_pages (tenant_id, workspace_id, wiki_id, updated_at DESC)`);
  }

  close(): void { this.db.close(); }

  async saveSpace(space: WikiSpace): Promise<void> {
    this.db.prepare(
      `INSERT INTO wiki_spaces (tenant_id, workspace_id, id, updated_at, definition_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id,id) DO UPDATE SET updated_at=excluded.updated_at, definition_json=excluded.definition_json`,
    ).run(space.tenant.tenantId, space.tenant.workspaceId, space.id, space.updatedAt, JSON.stringify(serializeWikiSpace(space)));
  }

  async findSpace(scope: TenantScope, id: string): Promise<WikiSpace | null> {
    const row = this.db.prepare(`SELECT definition_json FROM wiki_spaces WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : deserializeWikiSpace(JSON.parse(String(row['definition_json'])) as SerializedWikiSpace);
  }

  async listSpaces(scope: TenantScope): Promise<WikiSpaceSummary[]> {
    return this.db.prepare(`SELECT definition_json FROM wiki_spaces WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC`).all(scope.tenantId, scope.workspaceId)
      .map((row) => deserializeWikiSpace(JSON.parse(String(row['definition_json'])) as SerializedWikiSpace))
      .map(summarizeWikiSpace);
  }

  async save(page: WikiPage): Promise<void> {
    const wikiId = effectiveWikiId(page);
    if (wikiId === DEFAULT_WIKI_ID && await this.findSpace(page.tenant, wikiId) === null) {
      await this.saveSpace(createWikiSpace({ id: wikiId, tenant: page.tenant, name: 'Default Wiki', createdAt: page.updatedAt }));
    }
    this.db.prepare(
      `INSERT INTO wiki_pages (tenant_id, workspace_id, id, wiki_id, updated_at, definition_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET wiki_id=excluded.wiki_id, updated_at=excluded.updated_at, definition_json=excluded.definition_json`,
    ).run(page.tenant.tenantId, page.tenant.workspaceId, page.id, wikiId, page.updatedAt, JSON.stringify(serializeWikiPage(page)));
  }

  async find(scope: TenantScope, id: string): Promise<WikiPage | null> {
    const row = this.db.prepare(`SELECT definition_json FROM wiki_pages WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : fromJson(row['definition_json']);
  }

  async list(scope: TenantScope, wikiId?: string): Promise<WikiPageSummary[]> {
    return this.pages(scope).filter((page) => wikiId === undefined || effectiveWikiId(page) === wikiId).map(summarizeWikiPage);
  }

  async search(scope: TenantScope, query: string, limit: number, wikiIds?: readonly string[]): Promise<WikiPageSummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return this.pages(scope).filter((page) => (wikiIds === undefined || wikiIds.includes(effectiveWikiId(page))) && matches(page, terms)).slice(0, Math.max(0, limit)).map(summarizeWikiPage);
  }

  private pages(scope: TenantScope): WikiPage[] {
    return this.db.prepare(`SELECT definition_json FROM wiki_pages WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC`)
      .all(scope.tenantId, scope.workspaceId)
      .map((row) => fromJson(row['definition_json']));
  }
}

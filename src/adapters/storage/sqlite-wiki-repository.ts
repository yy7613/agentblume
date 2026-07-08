import { DatabaseSync } from 'node:sqlite';
import type { TenantScope } from '../../domain/tool/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { summarizeWikiPage, type WikiPage, type WikiPageSummary } from '../../domain/memory/wiki-page';
import { deserializeWikiPage, serializeWikiPage, type SerializedWikiPage } from '../../domain/memory/serialization';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS wiki_pages (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_updated
    ON wiki_pages (tenant_id, workspace_id, updated_at DESC);
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
  }

  close(): void { this.db.close(); }

  async save(page: WikiPage): Promise<void> {
    this.db.prepare(
      `INSERT INTO wiki_pages (tenant_id, workspace_id, id, updated_at, definition_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET updated_at=excluded.updated_at, definition_json=excluded.definition_json`,
    ).run(page.tenant.tenantId, page.tenant.workspaceId, page.id, page.updatedAt, JSON.stringify(serializeWikiPage(page)));
  }

  async find(scope: TenantScope, id: string): Promise<WikiPage | null> {
    const row = this.db.prepare(`SELECT definition_json FROM wiki_pages WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : fromJson(row['definition_json']);
  }

  async list(scope: TenantScope): Promise<WikiPageSummary[]> {
    return this.pages(scope).map(summarizeWikiPage);
  }

  async search(scope: TenantScope, query: string, limit: number): Promise<WikiPageSummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return this.pages(scope).filter((page) => matches(page, terms)).slice(0, Math.max(0, limit)).map(summarizeWikiPage);
  }

  private pages(scope: TenantScope): WikiPage[] {
    return this.db.prepare(`SELECT definition_json FROM wiki_pages WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC`)
      .all(scope.tenantId, scope.workspaceId)
      .map((row) => fromJson(row['definition_json']));
  }
}

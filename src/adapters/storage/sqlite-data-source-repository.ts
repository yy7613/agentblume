import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { DataSource } from '../../domain/data-source/data-source';
import { deserializeDataSource } from '../../domain/data-source/serialization';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';

/** SQLiteはカタログとCSV/JSON本文をbackend側に保持する。DB資格情報は保存しない。 */
export class SqliteDataSourceRepository extends SqliteRepositoryBase implements DataSourceRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }

  async save(source: DataSource, fileContent?: string): Promise<void> {
    this.db.prepare(
      `INSERT INTO data_sources (tenant_id, workspace_id, id, updated_at, record_json, file_content) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json, file_content=excluded.file_content`,
    ).run(source.tenant.tenantId, source.tenant.workspaceId, source.id, source.updatedAt, JSON.stringify(source), source.kind === 'file' ? fileContent ?? null : null);
  }

  async list(scope: TenantScope): Promise<readonly DataSource[]> {
    return this.db.prepare(`SELECT record_json FROM data_sources WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC`)
      .all(scope.tenantId, scope.workspaceId)
      .map((row) => deserializeDataSource(JSON.parse(String(row['record_json']))));
  }

  async find(scope: TenantScope, id: string): Promise<DataSource | null> {
    const row = this.db.prepare(`SELECT record_json FROM data_sources WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : deserializeDataSource(JSON.parse(String(row['record_json'])));
  }

  async readFile(scope: TenantScope, id: string): Promise<{ readonly source: DataSource; readonly content: string } | null> {
    const row = this.db.prepare(`SELECT record_json, file_content FROM data_sources WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    if (row === undefined) return null;
    const source = deserializeDataSource(JSON.parse(String(row['record_json'])));
    const content = row['file_content'];
    return source.kind !== 'file' || typeof content !== 'string' ? null : { source, content };
  }

  async delete(scope: TenantScope, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM data_sources WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
  }
}

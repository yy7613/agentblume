/**
 * adapters層: ツール検証ケースの SQLite 永続化。ケースは版を持たず (scope, id) で upsert する。
 *
 * 本体は `record_json`（SerializedToolCheckCase）。絞り込みと並びに使う `tool_id` / `updated_at`
 * だけを列へ出す（テーブル定義は migrations.ts の version 4）。
 */
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { deserializeToolCheckCase, serializeToolCheckCase } from '../../domain/tool-check/serialization';
import type { ToolCheckCase } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckCaseListOptions, ToolCheckCaseRepository } from '../../domain/tool-check/tool-check-case-repository';

export class SqliteToolCheckCaseRepository extends SqliteRepositoryBase implements ToolCheckCaseRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }

  async save(item: ToolCheckCase): Promise<void> {
    this.db.prepare(
      `INSERT INTO tool_check_cases (tenant_id, workspace_id, id, tool_id, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET tool_id=excluded.tool_id, updated_at=excluded.updated_at, record_json=excluded.record_json`,
    ).run(item.scope.tenantId, item.scope.workspaceId, item.id, item.toolId, item.updatedAt, JSON.stringify(serializeToolCheckCase(item)));
  }

  async find(scope: TenantScope, id: string): Promise<ToolCheckCase | null> {
    const row = this.db.prepare(`SELECT record_json FROM tool_check_cases WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json']);
  }

  async list(scope: TenantScope, options?: ToolCheckCaseListOptions): Promise<readonly ToolCheckCase[]> {
    const rows = options?.toolId === undefined
      ? this.db.prepare(`SELECT record_json FROM tool_check_cases WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC, id ASC`).all(scope.tenantId, scope.workspaceId)
      : this.db.prepare(`SELECT record_json FROM tool_check_cases WHERE tenant_id=? AND workspace_id=? AND tool_id=? ORDER BY updated_at DESC, id ASC`).all(scope.tenantId, scope.workspaceId, options.toolId);
    return rows.map((row) => parse(row['record_json']));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM tool_check_cases WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
    return Number(result.changes) > 0;
  }
}

function parse(value: unknown): ToolCheckCase {
  return deserializeToolCheckCase(JSON.parse(String(value)));
}

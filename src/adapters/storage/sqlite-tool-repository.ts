/**
 * アダプタ: SQLite ToolRepository（v2 実装契約 §14）
 *
 * `node:sqlite` の DatabaseSync を用いる（実行フラグ --experimental-sqlite は
 * vitest.config.ts の poolOptions.forks.execArgv で付与済み）。
 * definition_json に serializeTool の JSON を保存し、取得時に deserializeTool で復元する。
 */
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { deserializeTool, serializeTool } from '../../domain/tool/serialization';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

/** definition_json 列（TEXT NOT NULL）から Tool を復元する。 */
function rowToTool(json: unknown): Tool {
  return deserializeTool(JSON.parse(String(json)));
}

/** SQLite（node:sqlite）による ToolRepository 実装。 */
export class SqliteToolRepository extends SqliteRepositoryBase implements ToolRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }

  async save(tool: Tool): Promise<void> {
    const data = serializeTool(tool);
    const { tenant, internalId, version } = tool.metadata;
    const stmt = this.db.prepare(
      `INSERT INTO tools
         (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      stmt.run(
        tenant.tenantId,
        tenant.workspaceId,
        internalId,
        version.toString(),
        version.major,
        version.minor,
        version.patch,
        JSON.stringify(data),
      );
    } catch (error) {
      // PK 重複（既存 (tenant, id, version) への再保存）→ VersionConflictError。
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new VersionConflictError(
          `save: version already exists: ${internalId}@${version.toString()}`,
        );
      }
      throw error;
    }
  }

  async findVersion(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool | null> {
    const row = this.db
      .prepare(
        `SELECT definition_json FROM tools
         WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND version = ?`,
      )
      .get(scope.tenantId, scope.workspaceId, internalId, version.toString());
    return row === undefined ? null : rowToTool(row['definition_json']);
  }

  async findLatest(scope: TenantScope, internalId: ToolId): Promise<Tool | null> {
    const row = this.db
      .prepare(
        `SELECT definition_json FROM tools
         WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0
         ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`,
      )
      .get(scope.tenantId, scope.workspaceId, internalId);
    return row === undefined ? null : rowToTool(row['definition_json']);
  }

  async listVersions(scope: TenantScope, internalId: ToolId): Promise<SemVer[]> {
    const rows = this.db
      .prepare(
        `SELECT major, minor, patch FROM tools
         WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0
         ORDER BY major ASC, minor ASC, patch ASC`,
      )
      .all(scope.tenantId, scope.workspaceId, internalId);
    return rows.map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch'])));
  }

  async list(scope: TenantScope): Promise<ToolSummary[]> {
    // internal_id ごとに (major, minor, patch) 最大の行を選ぶ（相関サブクエリで最新行を特定）。
    const rows = this.db
      .prepare(
        `SELECT t.definition_json FROM tools AS t
         WHERE t.tenant_id = ? AND t.workspace_id = ? AND t.deleted = 0
           AND t.version = (
             SELECT s.version FROM tools AS s
             WHERE s.tenant_id = t.tenant_id AND s.workspace_id = t.workspace_id
               AND s.internal_id = t.internal_id AND s.deleted = 0
             ORDER BY s.major DESC, s.minor DESC, s.patch DESC LIMIT 1
           )
         ORDER BY t.internal_id ASC`,
      )
      .all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => {
      const tool = rowToTool(row['definition_json']);
      return {
        internalId: tool.metadata.internalId,
        publishName: tool.metadata.publishName,
        displayName: tool.metadata.displayName,
        latestVersion: tool.metadata.version,
        state: tool.metadata.state,
        sideEffect: tool.sideEffect,
      };
    });
  }

  async delete(scope: TenantScope, internalId: ToolId): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM tools WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ? AND deleted = 0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, internalId);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE tools SET deleted = 1 WHERE tenant_id = ? AND workspace_id = ? AND internal_id = ?`).run(scope.tenantId, scope.workspaceId, internalId);
    return true;
  }
}

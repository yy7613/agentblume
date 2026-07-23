import { DatabaseSync } from 'node:sqlite';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository, ScenarioSummary } from '../../domain/validation/scenario-repository';
import { deserializeScenario, serializeScenario } from '../../domain/validation/serialization';
const TABLE = `CREATE TABLE IF NOT EXISTS scenarios (tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL, version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL, definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, workspace_id, internal_id, version));`;
const fromJson = (value: unknown): Scenario => deserializeScenario(JSON.parse(String(value)));
export class SqliteScenarioRepository implements ScenarioRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(TABLE);
    // 既存DB向けmigration: deleted列が無ければ追加する(論理削除)。
    const columns = this.db.prepare(`PRAGMA table_info(scenarios)`).all();
    if (!columns.some((column) => String(column['name']) === 'deleted')) {
      this.db.exec(`ALTER TABLE scenarios ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    }
  }
  close(): void { this.db.close(); }
  async save(scenario: Scenario): Promise<void> { const { tenant, internalId, version } = scenario.metadata; try { this.db.prepare(`INSERT INTO scenarios (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeScenario(scenario))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new VersionConflictError(`Scenario version already exists: ${internalId}@${version.toString()}`); throw error; } }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Scenario | null> { const row = this.db.prepare(`SELECT definition_json FROM scenarios WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<Scenario | null> { const row = this.db.prepare(`SELECT definition_json FROM scenarios WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM scenarios WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<ScenarioSummary[]> { return this.db.prepare(`SELECT s.definition_json FROM scenarios s WHERE s.tenant_id=? AND s.workspace_id=? AND s.deleted=0 AND s.version=(SELECT x.version FROM scenarios x WHERE x.tenant_id=s.tenant_id AND x.workspace_id=s.workspace_id AND x.internal_id=s.internal_id AND x.deleted=0 ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY s.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const scenario = fromJson(row['definition_json']); return { internalId: scenario.metadata.internalId, displayName: scenario.metadata.displayName, publishName: scenario.metadata.publishName, latestVersion: scenario.metadata.version, state: scenario.metadata.state }; }); }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM scenarios WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, id);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE scenarios SET deleted=1 WHERE tenant_id=? AND workspace_id=? AND internal_id=?`).run(scope.tenantId, scope.workspaceId, id);
    return true;
  }
}

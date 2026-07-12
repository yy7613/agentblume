import { DatabaseSync } from 'node:sqlite';
import { deserializeEvaluatorProfile, serializeEvaluatorProfile } from '../../domain/evaluation/assets-serialization';
import type { EvaluatorProfileRepository, EvaluatorProfileSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const TABLE = `CREATE TABLE IF NOT EXISTS evaluator_profiles (tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL, version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL, definition_json TEXT NOT NULL, PRIMARY KEY (tenant_id, workspace_id, internal_id, version));`;
const fromJson = (value: unknown): EvaluatorProfile => deserializeEvaluatorProfile(JSON.parse(String(value)));

export class SqliteEvaluatorProfileRepository implements EvaluatorProfileRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(TABLE); }
  close(): void { this.db.close(); }
  async save(profile: EvaluatorProfile): Promise<void> { const { tenant, internalId, version } = profile.metadata; try { this.db.prepare(`INSERT INTO evaluator_profiles (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeEvaluatorProfile(profile))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new EvaluationAssetVersionConflictError(`Evaluator profile version already exists: ${internalId}@${version.toString()}`); throw error; } }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<EvaluatorProfile | null> { const row = this.db.prepare(`SELECT definition_json FROM evaluator_profiles WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<EvaluatorProfile | null> { const row = this.db.prepare(`SELECT definition_json FROM evaluator_profiles WHERE tenant_id=? AND workspace_id=? AND internal_id=? ORDER BY major DESC,minor DESC,patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM evaluator_profiles WHERE tenant_id=? AND workspace_id=? AND internal_id=? ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<EvaluatorProfileSummary[]> { return this.db.prepare(`SELECT p.definition_json FROM evaluator_profiles p WHERE p.tenant_id=? AND p.workspace_id=? AND p.version=(SELECT x.version FROM evaluator_profiles x WHERE x.tenant_id=p.tenant_id AND x.workspace_id=p.workspace_id AND x.internal_id=p.internal_id ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY p.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const profile = fromJson(row['definition_json']); return { internalId: profile.metadata.internalId, displayName: profile.metadata.displayName, publishName: profile.metadata.publishName, latestVersion: profile.metadata.version, state: profile.metadata.state, metricCount: profile.metrics.length }; }); }
}

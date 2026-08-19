import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { deserializeEvaluationDataset, serializeEvaluationDataset } from '../../domain/evaluation/assets-serialization';
import type { EvaluationDatasetRepository, EvaluationDatasetSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import type { EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer } from '../../domain/tool/semver';

const fromJson = (value: unknown): EvaluationDataset => deserializeEvaluationDataset(JSON.parse(String(value)));

export class SqliteEvaluationDatasetRepository extends SqliteRepositoryBase implements EvaluationDatasetRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(dataset: EvaluationDataset): Promise<void> {
    const { tenant, internalId, version } = dataset.metadata;
    try { this.db.prepare(`INSERT INTO evaluation_datasets (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeEvaluationDataset(dataset))); }
    catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new EvaluationAssetVersionConflictError(`Evaluation dataset version already exists: ${internalId}@${version.toString()}`); throw error; }
  }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<EvaluationDataset | null> { const row = this.db.prepare(`SELECT definition_json FROM evaluation_datasets WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<EvaluationDataset | null> { const row = this.db.prepare(`SELECT definition_json FROM evaluation_datasets WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major DESC,minor DESC,patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM evaluation_datasets WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<EvaluationDatasetSummary[]> { return this.db.prepare(`SELECT d.definition_json FROM evaluation_datasets d WHERE d.tenant_id=? AND d.workspace_id=? AND d.deleted=0 AND d.version=(SELECT x.version FROM evaluation_datasets x WHERE x.tenant_id=d.tenant_id AND x.workspace_id=d.workspace_id AND x.internal_id=d.internal_id AND x.deleted=0 ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY d.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const dataset = fromJson(row['definition_json']); return { internalId: dataset.metadata.internalId, displayName: dataset.metadata.displayName, publishName: dataset.metadata.publishName, latestVersion: dataset.metadata.version, state: dataset.metadata.state, caseCount: dataset.cases.length }; }); }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM evaluation_datasets WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, id);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE evaluation_datasets SET deleted=1 WHERE tenant_id=? AND workspace_id=? AND internal_id=?`).run(scope.tenantId, scope.workspaceId, id);
    return true;
  }
}

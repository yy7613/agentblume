import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { deserializeJudgeRubric, serializeJudgeRubric } from '../../domain/evaluation/assets-serialization';
import type { JudgeRubricRepository, JudgeRubricSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import type { JudgeRubric } from '../../domain/evaluation/judge-rubric';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const fromJson = (value: unknown): JudgeRubric => deserializeJudgeRubric(JSON.parse(String(value)));
export class SqliteJudgeRubricRepository extends SqliteRepositoryBase implements JudgeRubricRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(rubric: JudgeRubric): Promise<void> { const { tenant, internalId, version } = rubric.metadata; try { this.db.prepare(`INSERT INTO judge_rubrics (tenant_id,workspace_id,internal_id,version,major,minor,patch,definition_json) VALUES (?,?,?,?,?,?,?,?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeJudgeRubric(rubric))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new EvaluationAssetVersionConflictError(`Judge rubric version already exists: ${internalId}@${version.toString()}`); throw error; } }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<JudgeRubric | null> { const row = this.db.prepare(`SELECT definition_json FROM judge_rubrics WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<JudgeRubric | null> { const row = this.db.prepare(`SELECT definition_json FROM judge_rubrics WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major DESC,minor DESC,patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM judge_rubrics WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<JudgeRubricSummary[]> { return this.db.prepare(`SELECT r.definition_json FROM judge_rubrics r WHERE r.tenant_id=? AND r.workspace_id=? AND r.deleted=0 AND r.version=(SELECT x.version FROM judge_rubrics x WHERE x.tenant_id=r.tenant_id AND x.workspace_id=r.workspace_id AND x.internal_id=r.internal_id AND x.deleted=0 ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY r.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const rubric = fromJson(row['definition_json']); return { internalId: rubric.metadata.internalId, displayName: rubric.metadata.displayName, publishName: rubric.metadata.publishName, latestVersion: rubric.metadata.version, state: rubric.metadata.state, criterionCount: rubric.criteria.length }; }); }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM judge_rubrics WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, id);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE judge_rubrics SET deleted=1 WHERE tenant_id=? AND workspace_id=? AND internal_id=?`).run(scope.tenantId, scope.workspaceId, id);
    return true;
  }
}

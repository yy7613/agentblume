import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository, SkillSummary } from '../../domain/skill/skill-repository';
import { SkillVersionConflictError } from '../../domain/skill/errors';
import { deserializeSkill, serializeSkill } from '../../domain/skill/serialization';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
const fromJson = (value: unknown): Skill => deserializeSkill(JSON.parse(String(value)));
export class SqliteSkillRepository extends SqliteRepositoryBase implements SkillRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(skill: Skill): Promise<void> { const { tenant, internalId, version } = skill.metadata; try { this.db.prepare(`INSERT INTO skills (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializeSkill(skill))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new SkillVersionConflictError(`Skill version already exists: ${internalId}@${version.toString()}`); throw error; } }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Skill | null> { const row = this.db.prepare(`SELECT definition_json FROM skills WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<Skill | null> { const row = this.db.prepare(`SELECT definition_json FROM skills WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM skills WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<SkillSummary[]> { return this.db.prepare(`SELECT s.definition_json FROM skills s WHERE s.tenant_id=? AND s.workspace_id=? AND s.deleted=0 AND s.version=(SELECT x.version FROM skills x WHERE x.tenant_id=s.tenant_id AND x.workspace_id=s.workspace_id AND x.internal_id=s.internal_id AND x.deleted=0 ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY s.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const skill = fromJson(row['definition_json']); return { internalId: skill.metadata.internalId, displayName: skill.metadata.displayName, publishName: skill.metadata.publishName, latestVersion: skill.metadata.version, state: skill.metadata.state }; }); }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM skills WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, id);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE skills SET deleted=1 WHERE tenant_id=? AND workspace_id=? AND internal_id=?`).run(scope.tenantId, scope.workspaceId, id);
    return true;
  }
}

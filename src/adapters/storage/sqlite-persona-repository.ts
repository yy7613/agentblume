import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { Persona } from '../../domain/validation/persona';
import type { PersonaRepository, PersonaSummary } from '../../domain/validation/persona-repository';
import { deserializePersona, serializePersona } from '../../domain/validation/serialization';
const fromJson = (value: unknown): Persona => deserializePersona(JSON.parse(String(value)));
export class SqlitePersonaRepository extends SqliteRepositoryBase implements PersonaRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(persona: Persona): Promise<void> { const { tenant, internalId, version } = persona.metadata; try { this.db.prepare(`INSERT INTO personas (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.tenantId, tenant.workspaceId, internalId, version.toString(), version.major, version.minor, version.patch, JSON.stringify(serializePersona(persona))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new VersionConflictError(`Persona version already exists: ${internalId}@${version.toString()}`); throw error; } }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Persona | null> { const row = this.db.prepare(`SELECT definition_json FROM personas WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND version=?`).get(scope.tenantId, scope.workspaceId, id, version.toString()); return row === undefined ? null : fromJson(row['definition_json']); }
  async findLatest(scope: TenantScope, id: string): Promise<Persona | null> { const row = this.db.prepare(`SELECT definition_json FROM personas WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : fromJson(row['definition_json']); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.db.prepare(`SELECT major,minor,patch FROM personas WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 ORDER BY major,minor,patch`).all(scope.tenantId, scope.workspaceId, id).map((row) => SemVer.of(Number(row['major']), Number(row['minor']), Number(row['patch']))); }
  async list(scope: TenantScope): Promise<PersonaSummary[]> { return this.db.prepare(`SELECT p.definition_json FROM personas p WHERE p.tenant_id=? AND p.workspace_id=? AND p.deleted=0 AND p.version=(SELECT x.version FROM personas x WHERE x.tenant_id=p.tenant_id AND x.workspace_id=p.workspace_id AND x.internal_id=p.internal_id AND x.deleted=0 ORDER BY x.major DESC,x.minor DESC,x.patch DESC LIMIT 1) ORDER BY p.internal_id`).all(scope.tenantId, scope.workspaceId).map((row) => { const persona = fromJson(row['definition_json']); return { internalId: persona.metadata.internalId, displayName: persona.metadata.displayName, publishName: persona.metadata.publishName, latestVersion: persona.metadata.version, archetype: persona.archetype, state: persona.metadata.state }; }); }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM personas WHERE tenant_id=? AND workspace_id=? AND internal_id=? AND deleted=0 LIMIT 1`).get(scope.tenantId, scope.workspaceId, id);
    if (existing === undefined) return false;
    this.db.prepare(`UPDATE personas SET deleted=1 WHERE tenant_id=? AND workspace_id=? AND internal_id=?`).run(scope.tenantId, scope.workspaceId, id);
    return true;
  }
}

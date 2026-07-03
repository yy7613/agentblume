import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository, SkillSummary } from '../../domain/skill/skill-repository';
import { SkillVersionConflictError } from '../../domain/skill/errors';
import { deserializeSkill, serializeSkill, type SerializedSkill } from '../../domain/skill/serialization';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
const key = (scope: TenantScope, id: string, version: string) => `${tenantKey(scope)} ${id} ${version}`;
export class InMemorySkillRepository implements SkillRepository {
  private readonly store = new Map<string, SerializedSkill>();
  async save(skill: Skill): Promise<void> { const value = serializeSkill(skill); const id = key(skill.metadata.tenant, skill.metadata.internalId, value.metadata.version); if (this.store.has(id)) throw new SkillVersionConflictError(`Skill version already exists: ${skill.metadata.internalId}@${value.metadata.version}`); this.store.set(id, value); }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Skill | null> { const value = this.store.get(key(scope, id, version.toString())); return value === undefined ? null : deserializeSkill(value); }
  async findLatest(scope: TenantScope, id: string): Promise<Skill | null> { const values = this.entries(scope, id); let latest: { version: SemVer; value: SerializedSkill } | undefined; for (const value of values) { const version = SemVer.parse(value.metadata.version); if (latest === undefined || version.compare(latest.version) > 0) latest = { version, value }; } return latest === undefined ? null : deserializeSkill(latest.value); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.entries(scope, id).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b)); }
  async list(scope: TenantScope): Promise<SkillSummary[]> { const latest = new Map<string, { version: SemVer; value: SerializedSkill }>(); for (const value of this.store.values()) { if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue; const version = SemVer.parse(value.metadata.version); const current = latest.get(value.metadata.internalId); if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value }); } return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({ internalId: value.metadata.internalId, displayName: value.metadata.displayName, publishName: value.metadata.publishName, latestVersion: version, state: value.metadata.state })); }
  private entries(scope: TenantScope, id: string): SerializedSkill[] { return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === id); }
}

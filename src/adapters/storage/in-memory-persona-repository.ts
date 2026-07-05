import { VersionConflictError } from '../../domain/tool/errors';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { Persona } from '../../domain/validation/persona';
import type { PersonaRepository, PersonaSummary } from '../../domain/validation/persona-repository';
import { deserializePersona, serializePersona, type SerializedPersona } from '../../domain/validation/serialization';
const key = (scope: TenantScope, id: string, version: string) => `${tenantKey(scope)} ${id} ${version}`;
export class InMemoryPersonaRepository implements PersonaRepository {
  private readonly store = new Map<string, SerializedPersona>();
  async save(persona: Persona): Promise<void> { const value = serializePersona(persona); const id = key(persona.metadata.tenant, persona.metadata.internalId, value.metadata.version); if (this.store.has(id)) throw new VersionConflictError(`Persona version already exists: ${persona.metadata.internalId}@${value.metadata.version}`); this.store.set(id, value); }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Persona | null> { const value = this.store.get(key(scope, id, version.toString())); return value === undefined ? null : deserializePersona(value); }
  async findLatest(scope: TenantScope, id: string): Promise<Persona | null> { const values = this.entries(scope, id); let latest: { version: SemVer; value: SerializedPersona } | undefined; for (const value of values) { const version = SemVer.parse(value.metadata.version); if (latest === undefined || version.compare(latest.version) > 0) latest = { version, value }; } return latest === undefined ? null : deserializePersona(latest.value); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.entries(scope, id).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b)); }
  async list(scope: TenantScope): Promise<PersonaSummary[]> { const latest = new Map<string, { version: SemVer; value: SerializedPersona }>(); for (const value of this.store.values()) { if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue; const version = SemVer.parse(value.metadata.version); const current = latest.get(value.metadata.internalId); if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value }); } return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({ internalId: value.metadata.internalId, displayName: value.metadata.displayName, publishName: value.metadata.publishName, latestVersion: version, archetype: value.archetype, state: value.metadata.state })); }
  private entries(scope: TenantScope, id: string): SerializedPersona[] { return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === id); }
}

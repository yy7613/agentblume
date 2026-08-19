import { VersionConflictError } from '../../domain/tool/errors';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer } from '../../domain/tool/semver';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository, ScenarioSummary } from '../../domain/validation/scenario-repository';
import { deserializeScenario, serializeScenario, type SerializedScenario } from '../../domain/validation/serialization';
const key = (scope: TenantScope, id: string, version: string) => `${tenantKey(scope)} ${id} ${version}`;
const idKey = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;
export class InMemoryScenarioRepository implements ScenarioRepository {
  private readonly store = new Map<string, SerializedScenario>();
  // 論理削除された internalId の集合(tenant単位)。findVersion はここを見ず、削除後も既存versionを返し続ける。
  private readonly deletedIds = new Set<string>();
  async save(scenario: Scenario): Promise<void> { const value = serializeScenario(scenario); const id = key(scenario.metadata.tenant, scenario.metadata.internalId, value.metadata.version); if (this.store.has(id)) throw new VersionConflictError(`Scenario version already exists: ${scenario.metadata.internalId}@${value.metadata.version}`); this.store.set(id, value); }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Scenario | null> { const value = this.store.get(key(scope, id, version.toString())); return value === undefined ? null : deserializeScenario(value); }
  async findLatest(scope: TenantScope, id: string): Promise<Scenario | null> { if (this.deletedIds.has(idKey(scope, id))) return null; const values = this.entries(scope, id); let latest: { version: SemVer; value: SerializedScenario } | undefined; for (const value of values) { const version = SemVer.parse(value.metadata.version); if (latest === undefined || version.compare(latest.version) > 0) latest = { version, value }; } return latest === undefined ? null : deserializeScenario(latest.value); }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { if (this.deletedIds.has(idKey(scope, id))) return []; return this.entries(scope, id).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b)); }
  async list(scope: TenantScope): Promise<ScenarioSummary[]> { const latest = new Map<string, { version: SemVer; value: SerializedScenario }>(); for (const value of this.store.values()) { if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue; if (this.deletedIds.has(idKey(scope, value.metadata.internalId))) continue; const version = SemVer.parse(value.metadata.version); const current = latest.get(value.metadata.internalId); if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value }); } return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({ internalId: value.metadata.internalId, displayName: value.metadata.displayName, publishName: value.metadata.publishName, latestVersion: version, state: value.metadata.state })); }
  async delete(scope: TenantScope, id: string): Promise<boolean> { const dkey = idKey(scope, id); if (this.deletedIds.has(dkey)) return false; if (this.entries(scope, id).length === 0) return false; this.deletedIds.add(dkey); return true; }
  private entries(scope: TenantScope, id: string): SerializedScenario[] { return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === id); }
}

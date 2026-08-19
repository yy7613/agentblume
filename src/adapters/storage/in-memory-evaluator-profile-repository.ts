import { deserializeEvaluatorProfile, serializeEvaluatorProfile, type SerializedEvaluatorProfile } from '../../domain/evaluation/assets-serialization';
import type { EvaluatorProfileRepository, EvaluatorProfileSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer } from '../../domain/tool/semver';

const key = (scope: TenantScope, id: string, version: string): string => `${tenantKey(scope)} ${id} ${version}`;
const idKey = (scope: TenantScope, id: string): string => `${tenantKey(scope)} ${id}`;

export class InMemoryEvaluatorProfileRepository implements EvaluatorProfileRepository {
  private readonly store = new Map<string, SerializedEvaluatorProfile>();
  private readonly deletedIds = new Set<string>();
  async save(profile: EvaluatorProfile): Promise<void> {
    const value = serializeEvaluatorProfile(profile);
    const id = key(profile.metadata.tenant, profile.metadata.internalId, value.metadata.version);
    if (this.store.has(id)) throw new EvaluationAssetVersionConflictError(`Evaluator profile version already exists: ${profile.metadata.internalId}@${value.metadata.version}`);
    this.store.set(id, value);
  }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<EvaluatorProfile | null> { const value = this.store.get(key(scope, id, version.toString())); return value === undefined ? null : deserializeEvaluatorProfile(value); }
  async findLatest(scope: TenantScope, id: string): Promise<EvaluatorProfile | null> {
    if (this.deletedIds.has(idKey(scope, id))) return null;
    const latest = this.entries(scope, id).reduce<{ version: SemVer; value: SerializedEvaluatorProfile } | undefined>((current, value) => { const version = SemVer.parse(value.metadata.version); return current === undefined || version.compare(current.version) > 0 ? { version, value } : current; }, undefined);
    return latest === undefined ? null : deserializeEvaluatorProfile(latest.value);
  }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> { if (this.deletedIds.has(idKey(scope, id))) return []; return this.entries(scope, id).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b)); }
  async list(scope: TenantScope): Promise<EvaluatorProfileSummary[]> {
    const latest = new Map<string, { version: SemVer; value: SerializedEvaluatorProfile }>();
    for (const value of this.store.values()) { if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue; if (this.deletedIds.has(idKey(scope, value.metadata.internalId))) continue; const version = SemVer.parse(value.metadata.version); const current = latest.get(value.metadata.internalId); if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value }); }
    return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({ internalId: value.metadata.internalId, displayName: value.metadata.displayName, publishName: value.metadata.publishName, latestVersion: version, state: value.metadata.state, metricCount: value.metrics.length }));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { const dkey = idKey(scope, id); if (this.deletedIds.has(dkey)) return false; if (this.entries(scope, id).length === 0) return false; this.deletedIds.add(dkey); return true; }
  private entries(scope: TenantScope, id: string): SerializedEvaluatorProfile[] { return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === id); }
}

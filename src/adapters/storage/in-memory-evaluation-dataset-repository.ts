import { deserializeEvaluationDataset, serializeEvaluationDataset, type SerializedEvaluationDataset } from '../../domain/evaluation/assets-serialization';
import type { EvaluationDatasetRepository, EvaluationDatasetSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import type { EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const key = (scope: TenantScope, id: string, version: string): string => `${tenantKey(scope)} ${id} ${version}`;
const idKey = (scope: TenantScope, id: string): string => `${tenantKey(scope)} ${id}`;

export class InMemoryEvaluationDatasetRepository implements EvaluationDatasetRepository {
  private readonly store = new Map<string, SerializedEvaluationDataset>();
  private readonly deletedIds = new Set<string>();

  async save(dataset: EvaluationDataset): Promise<void> {
    const value = serializeEvaluationDataset(dataset);
    const id = key(dataset.metadata.tenant, dataset.metadata.internalId, value.metadata.version);
    if (this.store.has(id)) throw new EvaluationAssetVersionConflictError(`Evaluation dataset version already exists: ${dataset.metadata.internalId}@${value.metadata.version}`);
    this.store.set(id, value);
  }

  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<EvaluationDataset | null> {
    const value = this.store.get(key(scope, id, version.toString()));
    return value === undefined ? null : deserializeEvaluationDataset(value);
  }

  async findLatest(scope: TenantScope, id: string): Promise<EvaluationDataset | null> {
    if (this.deletedIds.has(idKey(scope, id))) return null;
    const latest = this.entries(scope, id).reduce<{ version: SemVer; value: SerializedEvaluationDataset } | undefined>((current, value) => {
      const version = SemVer.parse(value.metadata.version);
      return current === undefined || version.compare(current.version) > 0 ? { version, value } : current;
    }, undefined);
    return latest === undefined ? null : deserializeEvaluationDataset(latest.value);
  }

  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> {
    if (this.deletedIds.has(idKey(scope, id))) return [];
    return this.entries(scope, id).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b));
  }

  async list(scope: TenantScope): Promise<EvaluationDatasetSummary[]> {
    const latest = new Map<string, { version: SemVer; value: SerializedEvaluationDataset }>();
    for (const value of this.store.values()) {
      if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue;
      if (this.deletedIds.has(idKey(scope, value.metadata.internalId))) continue;
      const version = SemVer.parse(value.metadata.version);
      const current = latest.get(value.metadata.internalId);
      if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value });
    }
    return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({
      internalId: value.metadata.internalId, displayName: value.metadata.displayName, publishName: value.metadata.publishName,
      latestVersion: version, state: value.metadata.state, caseCount: value.cases.length,
    }));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const dkey = idKey(scope, id);
    if (this.deletedIds.has(dkey)) return false;
    if (this.entries(scope, id).length === 0) return false;
    this.deletedIds.add(dkey);
    return true;
  }

  private entries(scope: TenantScope, id: string): SerializedEvaluationDataset[] {
    return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === id);
  }
}

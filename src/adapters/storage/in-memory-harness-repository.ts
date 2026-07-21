import type { AgentHarness } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository, HarnessSummary } from '../../domain/harness/harness-repository';
import { HarnessNotFoundError, HarnessVersionConflictError } from '../../domain/harness/errors';
import { deserializeAgentHarness, serializeAgentHarness, type SerializedAgentHarness } from '../../domain/harness/serialization';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

function key(scope: TenantScope, internalId: string, version: string): string { return `${tenantKey(scope)} ${internalId} ${version}`; }
function idKey(scope: TenantScope, internalId: string): string { return `${tenantKey(scope)} ${internalId}`; }

export class InMemoryAgentHarnessRepository implements AgentHarnessRepository {
  private readonly store = new Map<string, SerializedAgentHarness>();
  // 論理削除された internalId の集合（tenant単位）。findVersion はここを見ず、削除後も既存versionを返し続ける。
  private readonly deletedIds = new Set<string>();

  async save(harness: AgentHarness): Promise<void> {
    const serialized = serializeAgentHarness(harness);
    const entry = key(harness.metadata.tenant, harness.metadata.internalId, serialized.metadata.version);
    if (this.store.has(entry)) throw new HarnessVersionConflictError(`Harness version already exists: ${harness.metadata.internalId}@${serialized.metadata.version}`);
    this.store.set(entry, serialized);
  }
  async findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<AgentHarness | null> {
    const value = this.store.get(key(scope, internalId, version.toString()));
    return value === undefined ? null : deserializeAgentHarness(value);
  }
  async findLatest(scope: TenantScope, internalId: string): Promise<AgentHarness | null> {
    if (this.deletedIds.has(idKey(scope, internalId))) return null;
    const entries = this.entries(scope, internalId);
    let current: SerializedAgentHarness | undefined;
    for (const entry of entries) if (current === undefined || SemVer.parse(entry.metadata.version).compare(SemVer.parse(current.metadata.version)) > 0) current = entry;
    return current === undefined ? null : deserializeAgentHarness(current);
  }
  async listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]> {
    if (this.deletedIds.has(idKey(scope, internalId))) return [];
    return this.entries(scope, internalId).map((item) => SemVer.parse(item.metadata.version)).sort((a, b) => a.compare(b));
  }
  async list(scope: TenantScope): Promise<HarnessSummary[]> {
    const latest = new Map<string, SerializedAgentHarness>();
    for (const item of this.store.values()) {
      if (tenantKey(item.metadata.tenant) !== tenantKey(scope)) continue;
      if (this.deletedIds.has(idKey(scope, item.metadata.internalId))) continue;
      const previous = latest.get(item.metadata.internalId);
      if (previous === undefined || SemVer.parse(item.metadata.version).compare(SemVer.parse(previous.metadata.version)) > 0) latest.set(item.metadata.internalId, item);
    }
    return [...latest.values()].sort((a, b) => a.metadata.internalId.localeCompare(b.metadata.internalId)).map((item) => ({ internalId: item.metadata.internalId, displayName: item.metadata.displayName, publishName: item.metadata.publishName, latestVersion: SemVer.parse(item.metadata.version), pattern: item.pattern, state: item.metadata.state }));
  }
  async delete(scope: TenantScope, internalId: string): Promise<boolean> {
    const dkey = idKey(scope, internalId);
    if (this.deletedIds.has(dkey)) return false;
    if (this.entries(scope, internalId).length === 0) return false;
    this.deletedIds.add(dkey);
    return true;
  }
  private entries(scope: TenantScope, internalId: string): SerializedAgentHarness[] { return [...this.store.values()].filter((item) => tenantKey(item.metadata.tenant) === tenantKey(scope) && item.metadata.internalId === internalId); }
}

import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import { AgentVersionConflictError } from '../../domain/agent/errors';
import { deserializeAgent, serializeAgent, type SerializedAgent } from '../../domain/agent/serialization';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer } from '../../domain/tool/semver';
import type { PublishState } from '../../domain/tool/metadata';
import { AgentNotFoundError } from '../../domain/agent/errors';

function key(scope: TenantScope, internalId: string, version: string): string {
  return `${tenantKey(scope)} ${internalId} ${version}`;
}
function idKey(scope: TenantScope, internalId: string): string { return `${tenantKey(scope)} ${internalId}`; }

export class InMemoryAgentRepository implements AgentRepository {
  private readonly store = new Map<string, SerializedAgent>();
  // 論理削除された internalId の集合（tenant単位）。findVersion はここを見ず、削除後も既存versionを返し続ける。
  private readonly deletedIds = new Set<string>();

  async save(agent: Agent): Promise<void> {
    const serialized = serializeAgent(agent);
    const entryKey = key(agent.metadata.tenant, agent.metadata.internalId, serialized.metadata.version);
    if (this.store.has(entryKey)) throw new AgentVersionConflictError(`Agent version already exists: ${agent.metadata.internalId}@${serialized.metadata.version}`);
    this.store.set(entryKey, serialized);
  }

  async updateState(scope: TenantScope, internalId: string, version: SemVer, state: PublishState): Promise<Agent> {
    const entryKey = key(scope, internalId, version.toString());
    const current = this.store.get(entryKey);
    if (current === undefined) throw new AgentNotFoundError(`Agent not found: ${internalId}@${version.toString()}`);
    const updated = deserializeAgent({ ...current, metadata: { ...current.metadata, state } });
    this.store.set(entryKey, serializeAgent(updated));
    return updated;
  }

  async findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Agent | null> {
    const value = this.store.get(key(scope, internalId, version.toString()));
    return value === undefined ? null : deserializeAgent(value);
  }

  async findLatest(scope: TenantScope, internalId: string): Promise<Agent | null> {
    if (this.deletedIds.has(idKey(scope, internalId))) return null;
    const values = this.entries(scope, internalId);
    let latest: { version: SemVer; value: SerializedAgent } | undefined;
    for (const value of values) {
      const version = SemVer.parse(value.metadata.version);
      if (latest === undefined || version.compare(latest.version) > 0) latest = { version, value };
    }
    return latest === undefined ? null : deserializeAgent(latest.value);
  }

  async listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]> {
    if (this.deletedIds.has(idKey(scope, internalId))) return [];
    return this.entries(scope, internalId).map((value) => SemVer.parse(value.metadata.version)).sort((a, b) => a.compare(b));
  }

  async list(scope: TenantScope): Promise<AgentSummary[]> {
    const latest = new Map<string, { version: SemVer; value: SerializedAgent }>();
    for (const value of this.store.values()) {
      if (tenantKey(value.metadata.tenant) !== tenantKey(scope)) continue;
      if (this.deletedIds.has(idKey(scope, value.metadata.internalId))) continue;
      const version = SemVer.parse(value.metadata.version);
      const current = latest.get(value.metadata.internalId);
      if (current === undefined || version.compare(current.version) > 0) latest.set(value.metadata.internalId, { version, value });
    }
    return [...latest.values()].sort((a, b) => a.value.metadata.internalId.localeCompare(b.value.metadata.internalId)).map(({ version, value }) => ({
      internalId: value.metadata.internalId,
      displayName: value.metadata.displayName,
      publishName: value.metadata.publishName,
      latestVersion: version,
      kind: value.kind,
      state: value.metadata.state,
    }));
  }

  async delete(scope: TenantScope, internalId: string): Promise<boolean> {
    const dkey = idKey(scope, internalId);
    if (this.deletedIds.has(dkey)) return false;
    if (this.entries(scope, internalId).length === 0) return false;
    this.deletedIds.add(dkey);
    return true;
  }

  private entries(scope: TenantScope, internalId: string): SerializedAgent[] {
    return [...this.store.values()].filter((value) => tenantKey(value.metadata.tenant) === tenantKey(scope) && value.metadata.internalId === internalId);
  }
}

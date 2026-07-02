/**
 * アダプタ: InMemory ToolRepository（v2 実装契約 §13)
 *
 * Map ベースの永続化。実 DB と同じ直列化経路を通すため、
 * 保存時は serializeTool、取得時は deserializeTool を必ず経由する。
 */
import { VersionConflictError } from '../../domain/tool/errors';
import { tenantKey } from '../../domain/tool/ids';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { deserializeTool, serializeTool } from '../../domain/tool/serialization';
import type { SerializedTool } from '../../domain/tool/serialization';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

/** (tenant, internalId, version) を一意キーへ連結する。 */
function entryKey(scope: TenantScope, internalId: ToolId, version: string): string {
  return `${tenantKey(scope)} ${internalId} ${version}`;
}

/** メモリ上に SerializedTool を保持する ToolRepository 実装。 */
export class InMemoryToolRepository implements ToolRepository {
  private readonly store = new Map<string, SerializedTool>();

  async save(tool: Tool): Promise<void> {
    const data = serializeTool(tool);
    const key = entryKey(tool.metadata.tenant, tool.metadata.internalId, data.metadata.version);
    if (this.store.has(key)) {
      throw new VersionConflictError(
        `save: version already exists: ${tool.metadata.internalId}@${data.metadata.version}`,
      );
    }
    this.store.set(key, data);
  }

  async findVersion(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool | null> {
    const data = this.store.get(entryKey(scope, internalId, version.toString()));
    return data === undefined ? null : deserializeTool(data);
  }

  async findLatest(scope: TenantScope, internalId: ToolId): Promise<Tool | null> {
    let latest: { version: SemVer; data: SerializedTool } | null = null;
    for (const data of this.entriesFor(scope, internalId)) {
      const version = SemVer.parse(data.metadata.version);
      if (latest === null || version.compare(latest.version) > 0) {
        latest = { version, data };
      }
    }
    return latest === null ? null : deserializeTool(latest.data);
  }

  async listVersions(scope: TenantScope, internalId: ToolId): Promise<SemVer[]> {
    const versions: SemVer[] = [];
    for (const data of this.entriesFor(scope, internalId)) {
      versions.push(SemVer.parse(data.metadata.version));
    }
    return versions.sort((a, b) => a.compare(b));
  }

  async list(scope: TenantScope): Promise<ToolSummary[]> {
    const scopeKey = tenantKey(scope);
    // internalId ごとに SemVer 最大の SerializedTool を選ぶ。
    const latestById = new Map<ToolId, { version: SemVer; data: SerializedTool }>();
    for (const data of this.store.values()) {
      if (tenantKey(data.metadata.tenant) !== scopeKey) continue;
      const version = SemVer.parse(data.metadata.version);
      const current = latestById.get(data.metadata.internalId);
      if (current === undefined || version.compare(current.version) > 0) {
        latestById.set(data.metadata.internalId, { version, data });
      }
    }
    return [...latestById.values()].map(({ version, data }) => ({
      internalId: data.metadata.internalId,
      publishName: data.metadata.publishName,
      displayName: data.metadata.displayName,
      latestVersion: version,
      state: data.metadata.state,
    }));
  }

  /** 指定スコープ・internalId に属する SerializedTool を列挙する。 */
  private *entriesFor(scope: TenantScope, internalId: ToolId): Iterable<SerializedTool> {
    const scopeKey = tenantKey(scope);
    for (const data of this.store.values()) {
      if (
        data.metadata.internalId === internalId &&
        tenantKey(data.metadata.tenant) === scopeKey
      ) {
        yield data;
      }
    }
  }
}

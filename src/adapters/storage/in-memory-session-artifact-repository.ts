import type { TenantScope } from '../../domain/tool/ids';
import type { SessionArtifact } from '../../domain/session/session-artifact';
import type { SessionArtifactReadOptions, SessionArtifactRepository } from '../../domain/session/session-repository';

function key(scope: TenantScope, sessionId: string, artifactId: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${sessionId}\u0000${artifactId}`; }
function idemKey(scope: TenantScope, sessionId: string, idempotencyKey: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${sessionId}\u0000${idempotencyKey}`; }

export class InMemorySessionArtifactRepository implements SessionArtifactRepository {
  private readonly records = new Map<string, { artifact: SessionArtifact; payload: unknown; idempotencyKey: string }>();
  private readonly idempotency = new Map<string, string>();

  async save(artifact: SessionArtifact, payload: unknown, idempotencyKey: string): Promise<void> {
    const recordKey = key(artifact.scope, artifact.sessionId, artifact.id);
    this.records.set(recordKey, { artifact: structuredClone(artifact), payload: structuredClone(payload), idempotencyKey });
    this.idempotency.set(idemKey(artifact.scope, artifact.sessionId, idempotencyKey), artifact.id);
  }
  async find(scope: TenantScope, sessionId: string, artifactId: string): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null> {
    const record = this.records.get(key(scope, sessionId, artifactId));
    return record === undefined ? null : { artifact: structuredClone(record.artifact), payload: structuredClone(record.payload) };
  }
  async read(scope: TenantScope, sessionId: string, artifactId: string, options: SessionArtifactReadOptions): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null> {
    const result = await this.find(scope, sessionId, artifactId);
    return result === null ? null : { ...result, payload: pagePayload(result.payload, options) };
  }
  async findByIdempotencyKey(scope: TenantScope, sessionId: string, idempotencyKey: string): Promise<SessionArtifact | null> {
    const id = this.idempotency.get(idemKey(scope, sessionId, idempotencyKey));
    if (id === undefined) return null;
    const record = this.records.get(key(scope, sessionId, id));
    return record === undefined ? null : structuredClone(record.artifact);
  }
  async list(scope: TenantScope, sessionId: string): Promise<readonly SessionArtifact[]> {
    return [...this.records.values()].filter((record) => record.artifact.scope.tenantId === scope.tenantId && record.artifact.scope.workspaceId === scope.workspaceId && record.artifact.sessionId === sessionId).sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt)).map((record) => structuredClone(record.artifact));
  }
  async delete(scope: TenantScope, sessionId: string, artifactId: string): Promise<void> {
    const recordKey = key(scope, sessionId, artifactId);
    const record = this.records.get(recordKey);
    if (record !== undefined) this.idempotency.delete(idemKey(scope, sessionId, record.idempotencyKey));
    this.records.delete(recordKey);
  }
  async usage(scope: TenantScope, sessionId: string): Promise<{ readonly count: number; readonly bytes: number }> {
    const matching = [...this.records.values()].filter((record) => record.artifact.scope.tenantId === scope.tenantId && record.artifact.scope.workspaceId === scope.workspaceId && record.artifact.sessionId === sessionId);
    return { count: matching.length, bytes: matching.reduce((sum, record) => sum + record.artifact.sizeBytes, 0) };
  }
}

function pagePayload(payload: unknown, options: SessionArtifactReadOptions): unknown {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) {
    const value = payload as { schema?: unknown; rows: unknown[] };
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 100);
    const rows = value.rows.slice(offset, offset + limit);
    return { ...(value.schema === undefined ? {} : { schema: value.schema }), rows, page: { offset, limit, ...(offset + rows.length < value.rows.length ? { nextOffset: offset + rows.length } : {}) } };
  }
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { nodes?: unknown }).nodes) && Array.isArray((payload as { edges?: unknown }).edges)) {
    const value = payload as { nodes: unknown[]; edges: unknown[] };
    const section = options.section ?? 'edges';
    const source = value[section];
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 100);
    const records = source.slice(offset, offset + limit);
    return { [section]: records, page: { section, offset, limit, ...(offset + records.length < source.length ? { nextOffset: offset + records.length } : {}) } };
  }
  return structuredClone(payload);
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { TenantScope } from '../../domain/tool/ids';
import type { SessionArtifact } from '../../domain/session/session-artifact';
import type { SessionArtifactReadOptions, SessionArtifactRepository } from '../../domain/session/session-repository';

const SQL = `
CREATE TABLE IF NOT EXISTS session_artifacts (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, record_json TEXT NOT NULL, payload_path TEXT,
  PRIMARY KEY (tenant_id, workspace_id, session_id, artifact_id),
  UNIQUE (tenant_id, workspace_id, session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_session_artifacts_list ON session_artifacts (tenant_id, workspace_id, session_id, created_at DESC);
`;

interface ArtifactRow { readonly record_json: string; readonly payload_path?: string | null; readonly payload_json?: string | null }
interface PathRow { readonly payload_path?: string | null }

/**
 * SQLite はCatalogだけを保持し、payloadはSessionスコープをハッシュ化した専用ディレクトリへ保存する。
 * 旧v28試作の payload_json 列がある既存DBは読み取り互換を維持し、新規書き込みでは空文字列だけを残す。
 */
export class SqliteSessionArtifactRepository implements SessionArtifactRepository {
  private readonly db: DatabaseSync;
  private readonly dataDirectory: string;
  private readonly temporaryDirectory: boolean;
  private readonly hasLegacyPayloadJson: boolean;

  constructor(path = ':memory:', dataDirectory?: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SQL);
    const beforeMigration = this.columns();
    if (!beforeMigration.has('payload_path')) this.db.exec('ALTER TABLE session_artifacts ADD COLUMN payload_path TEXT');
    this.hasLegacyPayloadJson = beforeMigration.has('payload_json');
    this.temporaryDirectory = dataDirectory === undefined && path === ':memory:';
    this.dataDirectory = dataDirectory ?? defaultDataDirectory(path, this.temporaryDirectory);
  }

  close(): void {
    this.db.close();
    if (this.temporaryDirectory) rmSync(this.dataDirectory, { recursive: true, force: true });
  }

  async save(artifact: SessionArtifact, payload: unknown, idempotencyKey: string): Promise<void> {
    const nextPath = this.payloadPath(artifact);
    const existing = this.db.prepare(`SELECT payload_path FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND artifact_id=?`).get(artifact.scope.tenantId, artifact.scope.workspaceId, artifact.sessionId, artifact.id) as PathRow | undefined;
    await this.writePayload(nextPath, artifact, payload);
    try {
      if (this.hasLegacyPayloadJson) {
        this.db.prepare(`INSERT INTO session_artifacts (tenant_id, workspace_id, session_id, artifact_id, idempotency_key, created_at, size_bytes, record_json, payload_path, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '') ON CONFLICT(tenant_id, workspace_id, session_id, artifact_id) DO UPDATE SET record_json=excluded.record_json, payload_path=excluded.payload_path, payload_json=excluded.payload_json, size_bytes=excluded.size_bytes, idempotency_key=excluded.idempotency_key, created_at=excluded.created_at`).run(artifact.scope.tenantId, artifact.scope.workspaceId, artifact.sessionId, artifact.id, idempotencyKey, artifact.createdAt, artifact.sizeBytes, JSON.stringify(artifact), nextPath);
      } else {
        this.db.prepare(`INSERT INTO session_artifacts (tenant_id, workspace_id, session_id, artifact_id, idempotency_key, created_at, size_bytes, record_json, payload_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, workspace_id, session_id, artifact_id) DO UPDATE SET record_json=excluded.record_json, payload_path=excluded.payload_path, size_bytes=excluded.size_bytes, idempotency_key=excluded.idempotency_key, created_at=excluded.created_at`).run(artifact.scope.tenantId, artifact.scope.workspaceId, artifact.sessionId, artifact.id, idempotencyKey, artifact.createdAt, artifact.sizeBytes, JSON.stringify(artifact), nextPath);
      }
    } catch (error) {
      await rm(nextPath, { force: true });
      throw error;
    }
    const priorPath = existing?.payload_path;
    if (priorPath !== undefined && priorPath !== null && priorPath !== '' && priorPath !== nextPath) await rm(this.assertManagedPath(priorPath), { force: true });
  }

  async find(scope: TenantScope, sessionId: string, artifactId: string): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null> {
    const row = this.db.prepare(`SELECT record_json, payload_path${this.hasLegacyPayloadJson ? ', payload_json' : ''} FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND artifact_id=?`).get(scope.tenantId, scope.workspaceId, sessionId, artifactId) as ArtifactRow | undefined;
    return row === undefined ? null : { artifact: JSON.parse(row.record_json) as SessionArtifact, payload: await this.readPayload(row) };
  }

  async read(scope: TenantScope, sessionId: string, artifactId: string, options: SessionArtifactReadOptions): Promise<{ readonly artifact: SessionArtifact; readonly payload: unknown } | null> {
    const row = this.db.prepare(`SELECT record_json, payload_path${this.hasLegacyPayloadJson ? ', payload_json' : ''} FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND artifact_id=?`).get(scope.tenantId, scope.workspaceId, sessionId, artifactId) as ArtifactRow | undefined;
    if (row === undefined) return null;
    const artifact = JSON.parse(row.record_json) as SessionArtifact;
    if (artifact.kind === 'table' && row.payload_path?.endsWith('.jsonl') === true) {
      return { artifact, payload: await this.readTablePage(this.assertManagedPath(row.payload_path), options) };
    }
    return { artifact, payload: pagePayload(await this.readPayload(row), options) };
  }

  async findByIdempotencyKey(scope: TenantScope, sessionId: string, idempotencyKey: string): Promise<SessionArtifact | null> {
    const row = this.db.prepare(`SELECT record_json FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND idempotency_key=?`).get(scope.tenantId, scope.workspaceId, sessionId, idempotencyKey) as { readonly record_json: string } | undefined;
    return row === undefined ? null : JSON.parse(row.record_json) as SessionArtifact;
  }

  async list(scope: TenantScope, sessionId: string): Promise<readonly SessionArtifact[]> {
    const rows = this.db.prepare(`SELECT record_json FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId, sessionId) as Array<{ readonly record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as SessionArtifact);
  }

  async delete(scope: TenantScope, sessionId: string, artifactId: string): Promise<void> {
    const row = this.db.prepare(`SELECT payload_path FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND artifact_id=?`).get(scope.tenantId, scope.workspaceId, sessionId, artifactId) as PathRow | undefined;
    this.db.prepare(`DELETE FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=? AND artifact_id=?`).run(scope.tenantId, scope.workspaceId, sessionId, artifactId);
    if (row?.payload_path !== undefined && row.payload_path !== null && row.payload_path !== '') await rm(this.assertManagedPath(row.payload_path), { force: true });
  }

  async usage(scope: TenantScope, sessionId: string): Promise<{ readonly count: number; readonly bytes: number }> {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM session_artifacts WHERE tenant_id=? AND workspace_id=? AND session_id=?`).get(scope.tenantId, scope.workspaceId, sessionId) as { readonly count: number; readonly bytes: number };
    return { count: Number(row.count), bytes: Number(row.bytes) };
  }

  private columns(): Set<string> {
    const rows = this.db.prepare('PRAGMA table_info(session_artifacts)').all() as Array<{ readonly name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private payloadPath(artifact: SessionArtifact): string {
    const scopeHash = digest(`${artifact.scope.tenantId}\u0000${artifact.scope.workspaceId}`);
    const sessionHash = digest(artifact.sessionId);
    const artifactHash = digest(`${artifact.id}\u0000${artifact.checksum}`);
    return join(this.dataDirectory, scopeHash, sessionHash, `${artifactHash}${artifact.kind === 'table' ? '.jsonl' : '.json'}`);
  }

  private async writePayload(path: string, artifact: SessionArtifact, payload: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    if (artifact.kind === 'table') {
      if (!isTablePayload(payload)) throw new Error('table artifact payload requires schema and rows');
      const handle = await open(temporary, 'w');
      try {
        await handle.write(`${JSON.stringify({ schema: payload.schema })}\n`);
        for (const row of payload.rows) await handle.write(`${JSON.stringify(row)}\n`);
      } finally { await handle.close(); }
    } else {
      await writeFile(temporary, JSON.stringify(payload) ?? 'null', 'utf8');
    }
    await rename(temporary, path);
  }

  private async readPayload(row: ArtifactRow): Promise<unknown> {
    if (row.payload_path !== undefined && row.payload_path !== null && row.payload_path !== '') {
      const path = this.assertManagedPath(row.payload_path);
      if (path.endsWith('.jsonl')) {
        const value = await this.readTablePage(path, { limit: Number.MAX_SAFE_INTEGER }) as { schema?: unknown; rows: unknown[]; page?: unknown };
        const { page: _page, ...payload } = value;
        return payload;
      }
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    }
    if (this.hasLegacyPayloadJson && row.payload_json !== undefined && row.payload_json !== null && row.payload_json !== '') return JSON.parse(row.payload_json) as unknown;
    throw new Error('session artifact payload is missing');
  }

  private async readTablePage(path: string, options: SessionArtifactReadOptions): Promise<unknown> {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 100);
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let schema: unknown;
    let rowIndex = 0;
    let hasMore = false;
    const rows: unknown[] = [];
    for await (const line of lines) {
      if (schema === undefined) { schema = (JSON.parse(line) as { schema?: unknown }).schema; continue; }
      if (rowIndex >= offset + limit) { hasMore = true; break; }
      if (rowIndex >= offset) rows.push(JSON.parse(line) as unknown);
      rowIndex += 1;
    }
    return { ...(schema === undefined ? {} : { schema }), rows, page: { offset, limit, ...(hasMore ? { nextOffset: offset + rows.length } : {}) } };
  }

  private assertManagedPath(path: string): string {
    const base = resolve(this.dataDirectory);
    const candidate = resolve(path);
    if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) throw new Error('session artifact payload path is outside the managed directory');
    return candidate;
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function isTablePayload(value: unknown): value is { readonly schema: unknown; readonly rows: readonly unknown[] } {
  return value !== null && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows) && 'schema' in value;
}
function pagePayload(payload: unknown, options: SessionArtifactReadOptions): unknown {
  if (isTablePayload(payload)) {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 100);
    const rows = payload.rows.slice(offset, offset + limit);
    return { schema: payload.schema, rows, page: { offset, limit, ...(offset + rows.length < payload.rows.length ? { nextOffset: offset + rows.length } : {}) } };
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
  return payload;
}
function defaultDataDirectory(dbPath: string, temporary: boolean): string {
  return temporary
    ? join(tmpdir(), 'agentblume-session-artifacts', randomUUID())
    : join(dirname(resolve(dbPath)), `${basename(dbPath)}.session-artifacts`);
}

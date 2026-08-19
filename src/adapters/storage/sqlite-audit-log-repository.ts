/**
 * adapters層: 監査ログのSQLite実装（スキーマ version 3 の `audit_log`）。
 *
 * ## 列の持ち方
 *
 * 本体は `record_json` に入れつつ、**絞り込みに使う値だけ列へ出す**。
 * 監査ログは「先月のあの拒否は誰か」を後から引くための台帳なので、
 * JSONのまま全走査すると数十万行で使い物にならなくなる。
 *
 * `sequence` は rowid の別名（＝追記順）。`at` は ISO8601 文字列なので同一ミリ秒の
 * エントリが並びうる。順序が揺れると「拒否 → 再試行 → 成功」の並びが読めなくなるため、
 * 並べ替えは必ず `at DESC, sequence DESC` で行う。
 */
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { AuditSink } from '../../application/security/audit';
import { deserializeAuditEntry, serializeAuditEntry, type AuditEntry, type AuditLogFilter, type AuditLogRepository } from '../../domain/security/audit';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export class SqliteAuditLogRepository extends SqliteRepositoryBase implements AuditLogRepository, AuditSink {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }

  async record(entry: AuditEntry): Promise<void> {
    const serialized = serializeAuditEntry(entry);
    this.db.prepare(`INSERT INTO audit_log (tenant_id, workspace_id, at, subject, action, resource_kind, resource_id, outcome, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        serialized.tenantId, serialized.workspaceId, serialized.at, serialized.subject, serialized.action,
        serialized.resource.kind, serialized.resource.id ?? null, serialized.outcome, JSON.stringify(serialized),
      );
  }

  async list(scope: TenantScope, filter?: AuditLogFilter): Promise<AuditEntry[]> {
    const conditions = ['tenant_id = ?', 'workspace_id = ?'];
    const values: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (filter?.from !== undefined) { conditions.push('at >= ?'); values.push(filter.from); }
    if (filter?.to !== undefined) { conditions.push('at <= ?'); values.push(filter.to); }
    if (filter?.subject !== undefined) { conditions.push('subject = ?'); values.push(filter.subject); }
    if (filter?.action !== undefined) { conditions.push('action = ?'); values.push(filter.action); }
    if (filter?.outcome !== undefined) { conditions.push('outcome = ?'); values.push(filter.outcome); }
    if (filter?.resourceKind !== undefined) { conditions.push('resource_kind = ?'); values.push(filter.resourceKind); }
    const limit = filter?.limit;
    const sql = `SELECT record_json FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY at DESC, sequence DESC${limit === undefined ? '' : ' LIMIT ?'}`;
    if (limit !== undefined) values.push(limit);
    const rows = this.db.prepare(sql).all(...values);
    return rows.map((row) => deserializeAuditEntry(JSON.parse(String(row['record_json']))));
  }

  async deleteBefore(scope: TenantScope, before: string): Promise<number> {
    return Number(this.db.prepare('DELETE FROM audit_log WHERE tenant_id = ? AND workspace_id = ? AND at <= ?')
      .run(scope.tenantId, scope.workspaceId, before).changes);
  }
}

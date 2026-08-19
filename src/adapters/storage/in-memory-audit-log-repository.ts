/**
 * adapters層: 監査ログのInMemory実装（`test` プロファイル・単体テスト用）。
 *
 * `AuditSink`（書き）と `AuditLogRepository`（読み・掃除）の両方を満たす。
 * SQLite実装と同じ契約（新しい順・スコープ境界・フィルタ）を返すこと自体がテスト対象。
 */
import type { AuditSink } from '../../application/security/audit';
import { deserializeAuditEntry, serializeAuditEntry, type AuditEntry, type AuditLogFilter, type AuditLogRepository } from '../../domain/security/audit';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/**
 * スコープの複合鍵。区切りの U+0000 は**エスケープ表記で書く**（生のNULバイトを埋めない）。
 *
 * 以前はここに U+0000 そのものが入っていた。gitはNULを含むファイルをバイナリと判定するため、
 * `git diff` も `git show` も中身を出さなくなり、**このファイルの変更が静かにレビューの
 * 対象外になっていた**。「テナントIDに現れない文字で区切る」という意図はそのままに、
 * ソースはテキストとして読める形に保つ（挙動は同一）。
 */
const scopeKey = (scope: TenantScope): string => `${scope.tenantId}\u0000${scope.workspaceId}`;

export class InMemoryAuditLogRepository implements AuditLogRepository, AuditSink {
  /** 追記順に持つ（同じ時刻のエントリでも記録順が保てる）。 */
  private readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(serializeAuditEntry(entry));
  }

  async list(scope: TenantScope, filter?: AuditLogFilter): Promise<AuditEntry[]> {
    const key = scopeKey(scope);
    const matched = this.entries.filter((entry) => scopeKey(entry) === key && matches(entry, filter));
    // 新しい順。同時刻は「後から記録したものが先」（配列の後ろほど新しい）。
    const ordered = [...matched].reverse().sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
    const limit = filter?.limit;
    return (limit === undefined ? ordered : ordered.slice(0, limit)).map(deserializeAuditEntry);
  }

  async deleteBefore(scope: TenantScope, before: string): Promise<number> {
    const key = scopeKey(scope);
    let deleted = 0;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined || scopeKey(entry) !== key || entry.at > before) continue;
      this.entries.splice(index, 1);
      deleted += 1;
    }
    return deleted;
  }
}

function matches(entry: AuditEntry, filter?: AuditLogFilter): boolean {
  if (filter === undefined) return true;
  if (filter.from !== undefined && entry.at < filter.from) return false;
  if (filter.to !== undefined && entry.at > filter.to) return false;
  if (filter.subject !== undefined && entry.subject !== filter.subject) return false;
  if (filter.action !== undefined && entry.action !== filter.action) return false;
  if (filter.outcome !== undefined && entry.outcome !== filter.outcome) return false;
  if (filter.resourceKind !== undefined && entry.resource.kind !== filter.resourceKind) return false;
  return true;
}

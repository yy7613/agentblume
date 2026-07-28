/**
 * application層 Port: `AuditSink`（監査ログの書き込み）と参照ユースケース。
 *
 * `docs/08-security-auth.md` §7 / `docs/04-api-spec.md` §2.4 の `AuditSink` にあたる。
 * 書き込み（`record`）と参照（`QueryAuditLogUseCase`）を分けてあるのは、
 * 外部の監査基盤（SIEM）へ転送するだけの実装では**参照ができない**ため。
 * 参照はローカルの台帳（`AuditLogRepository`）に対して行う。
 *
 * ## 記録の失敗で本処理を止めない
 *
 * 監査の書き込みに失敗しても、利用者の操作は既に成功している（あるいは既に拒否した）。
 * そこで 500 を返すと「監査DBが一杯になった瞬間に全機能が止まる」ことになるので、
 * 呼び出し側（api層）は失敗を握り潰して運用ログへ落とす。**握り潰す場所を1箇所に決める**ため、
 * ここでは素直に throw してよい契約にしてある。
 */
import type { AuditEntry, AuditLogFilter, AuditLogRepository } from '../../domain/security/audit';
import type { TenantScope } from '../../domain/tool/ids';

/** 監査イベントの記録先。 */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** 1回のリクエストで返す監査エントリの既定件数。 */
export const DEFAULT_AUDIT_PAGE_SIZE = 100;
/** 1回のリクエストで返せる上限。 */
export const MAX_AUDIT_PAGE_SIZE = 500;

/** 監査ログの参照（`GET /operations/audit`）。 */
export class QueryAuditLogUseCase {
  constructor(private readonly repo: AuditLogRepository) {}

  async list(scope: TenantScope, filter?: AuditLogFilter): Promise<AuditEntry[]> {
    const limit = Math.min(filter?.limit ?? DEFAULT_AUDIT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE);
    return await this.repo.list(scope, { ...filter, limit });
  }
}

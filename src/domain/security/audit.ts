/**
 * ドメイン: 監査ログ（`AuditEntry`）
 *
 * ## Run trace とは別物
 *
 * Run trace は「モデルとツールが何をしたか」の記録で、**実行者の概念が無い**。
 * 認証が入ったいま初めて「誰が」を残せるようになったので、
 * `docs/08-security-auth.md` §7 が求める「実行者・対象・承認・結果・エラー」を
 * 別の台帳として持つ。trace は保持期限で伏せ字にされるが、監査ログは
 * 独立した保持期間（既定1年）で残す。
 *
 * ## 秘密を書かないための作り
 *
 * `detail` は自由なキーを取れる器なので、**ドメイン側で機械的に落とす**。
 * 「呼び出し側が気をつける」に頼ると、いつか誰かがリクエストボディを丸ごと入れる。
 * - 名前が秘密っぽいキー（token / apiKey / password / secret / authorization …）は捨てる。
 * - 値は文字列・数値・真偽値だけ。長い文字列は切り詰める（payload の丸写しを防ぐ）。
 */
import { z } from 'zod';
import { AUTHORIZATION_ACTIONS, AUTHORIZATION_RESOURCE_KINDS, type AuthorizationAction, type AuthorizationResourceKind } from './authorization';
import type { TenantId, WorkspaceId } from '../shared/tenant-scope';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';

/**
 * 監査エントリの結末。
 *
 * - `denied`: 認証に失敗した / 認可で拒否した（＝操作は起きていない）。
 * - `allowed`: 認可は通ったが結果はまだ分からない（長時間処理の開始記録などに使える）。
 * - `succeeded` / `failed`: 操作が終わったときの結果。
 */
export const AUDIT_OUTCOMES = ['allowed', 'denied', 'succeeded', 'failed'] as const;
/** `AUDIT_OUTCOMES` の要素。 */
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** 監査対象のリソース（`kind` 必須、`id` / `version` は分かる範囲で）。 */
export interface AuditResource {
  readonly kind: AuthorizationResourceKind;
  readonly id?: string;
  readonly version?: string;
}

/** `detail` に入れてよい値。オブジェクト・配列を許すと payload の丸写しが起きるので受け付けない。 */
export type AuditDetailValue = string | number | boolean;

/** 1件の監査記録。 */
export interface AuditEntry {
  /** 記録した時刻（ISO8601）。 */
  readonly at: IsoDateTime;
  /** 誰が（`Principal.subject`）。認証前の失敗は `UNAUTHENTICATED_SUBJECT`。 */
  readonly subject: string;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  /** 何をしようとしたか。 */
  readonly action: AuthorizationAction;
  /** 何に対して。 */
  readonly resource: AuditResource;
  readonly outcome: AuditOutcome;
  /** 補足（HTTPメソッド・ルート・ステータス・承認の可否など）。**秘密値は入らない**。 */
  readonly detail?: Readonly<Record<string, AuditDetailValue>>;
}

/** 認証に失敗したリクエストの `subject`（「誰か分からない誰か」を表す固定値）。 */
export const UNAUTHENTICATED_SUBJECT = '(unauthenticated)';

/** `detail` の1値の上限文字数。エラーメッセージを載せても台帳が肥大しない長さ。 */
export const AUDIT_DETAIL_MAX_LENGTH = 500;

/**
 * 名前が秘密を示すキー。`api/logging.ts` の pino redact と同じ語彙を使う
 * （片方だけ守っても意味がないため）。
 */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|credential|authorization|cookie|bearer)/i;

/** 秘密っぽいキーを捨て、値を安全な形へ落とす。 */
export function maskAuditDetail(detail: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, AuditDetailValue>> | undefined {
  if (detail === undefined) return undefined;
  const masked: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) { masked[key] = value; continue; }
    if (typeof value === 'boolean') { masked[key] = value; continue; }
    if (typeof value !== 'string') continue;
    masked[key] = value.length > AUDIT_DETAIL_MAX_LENGTH ? `${value.slice(0, AUDIT_DETAIL_MAX_LENGTH)}…` : value;
  }
  return Object.keys(masked).length === 0 ? undefined : masked;
}

/** `AuditEntry` の組み立て（`detail` は必ずマスクを通す）。 */
export function createAuditEntry(input: {
  readonly at: IsoDateTime;
  readonly subject: string;
  readonly scope: TenantScope;
  readonly action: AuthorizationAction;
  readonly resource: AuditResource;
  readonly outcome: AuditOutcome;
  readonly detail?: Readonly<Record<string, unknown>>;
}): AuditEntry {
  const detail = maskAuditDetail(input.detail);
  return {
    at: input.at,
    subject: input.subject === '' ? UNAUTHENTICATED_SUBJECT : input.subject,
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    action: input.action,
    resource: { kind: input.resource.kind, ...(input.resource.id === undefined ? {} : { id: input.resource.id }), ...(input.resource.version === undefined ? {} : { version: input.resource.version }) },
    outcome: input.outcome,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** 参照APIの絞り込み条件。 */
export interface AuditLogFilter {
  /** この時刻**以降**（ISO8601）。 */
  readonly from?: string;
  /** この時刻**以前**（ISO8601）。 */
  readonly to?: string;
  readonly subject?: string;
  readonly action?: AuthorizationAction;
  readonly outcome?: AuditOutcome;
  readonly resourceKind?: AuthorizationResourceKind;
  /** 返す最大件数（新しい順）。 */
  readonly limit?: number;
}

/** 監査ログの参照と掃除。書き込みは application 層の `AuditSink` が担当する。 */
export interface AuditLogRepository {
  /** 新しい順に返す。 */
  list(scope: TenantScope, filter?: AuditLogFilter): Promise<AuditEntry[]>;
  /** `before` **以前**のエントリを削除して件数を返す（保持期限の適用）。 */
  deleteBefore(scope: TenantScope, before: string): Promise<number>;
}

const detailSchema = z.record(z.string().min(1), z.union([z.string().max(AUDIT_DETAIL_MAX_LENGTH + 1), z.number(), z.boolean()]));
const entrySchema = z.object({
  at: z.string().min(1),
  subject: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  action: z.enum(AUTHORIZATION_ACTIONS),
  resource: z.object({
    kind: z.enum(AUTHORIZATION_RESOURCE_KINDS),
    id: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  }),
  outcome: z.enum(AUDIT_OUTCOMES),
  detail: detailSchema.optional(),
});

/** 保存形へ（不正な値はここで落とす）。 */
export const serializeAuditEntry = (value: AuditEntry): AuditEntry => structuredClone(entrySchema.parse(value)) as AuditEntry;
/** 保存形から復元する。 */
export const deserializeAuditEntry = (value: unknown): AuditEntry => structuredClone(entrySchema.parse(value)) as AuditEntry;

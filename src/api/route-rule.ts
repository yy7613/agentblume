/**
 * api層: 認可の表の 1 行の型と、行を作る関数（葉モジュール）。
 *
 * `authorization.ts` と業務ごとの `<業務>-authorization.ts` の両方が使うので、循環しないよう分けて置く。
 */
import type { AuthorizationAction, AuthorizationResourceKind } from '../domain/security/authorization';

/** 1ルートに割り当てる認可要件。 */
export interface RouteAuthorization {
  readonly action: AuthorizationAction;
  readonly kind: AuthorizationResourceKind;
  /** true なら結果（成功・失敗）を監査ログへ残す。拒否は `audit` に関係なく必ず残す。 */
  readonly audit?: boolean;
}

/** 表の1行。 */
export interface RouteRule extends RouteAuthorization {
  readonly method: string;
  readonly url: string;
}

export const rule = (method: string, url: string, action: AuthorizationAction, kind: AuthorizationResourceKind, audit = false): RouteRule =>
  ({ method, url, action, kind, audit });

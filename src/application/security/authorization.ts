/**
 * application層 Port: `AuthorizationPort`（Principal + action + resource → 許可/拒否）
 *
 * `docs/08-security-auth.md` §3.1 の `AuthorizationProvider` にあたる。
 * 初期実装は adapters の `RoleMatrixAuthorization`（静的なロール表）だが、
 * 将来 Policy Engine（OPA など）へ差し替えられるように非同期にしてある
 * （同期にすると、外部評価を足すときに呼び出し側を全部書き直すことになる）。
 *
 * **判定できないときは拒否**。実装が例外を投げた場合も、呼び出し側（api層のフック）は
 * 403 として扱う。「認可基盤が落ちている間は素通し」は最悪の失敗の仕方である。
 */
import type { AuthorizationAction, AuthorizationDecision, AuthorizationResource } from '../../domain/security/authorization';
import type { Principal } from '../../domain/security/principal';

/** 認可判定。 */
export interface AuthorizationPort {
  authorize(principal: Principal, action: AuthorizationAction, resource?: AuthorizationResource): Promise<AuthorizationDecision>;
}

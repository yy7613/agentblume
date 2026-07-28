/**
 * adapters層: `RoleMatrixAuthorization` — ロール表による静的な認可判定。
 *
 * 判定の中身は domain（`decideAuthorization`）にある。ここはPortの形に合わせる薄い層で、
 * 「外部のPolicy Engineへ差し替える差し込み口はここ」という位置を示すためにある。
 *
 * 静的判定で足りる理由: 初期実装のロールはワークスペース単位で、
 * 判定に必要な情報（`Principal.roles`）は認証の時点で確定している。
 * 所有者・環境・データ分類を条件にするABACへ進むときは、この実装を別クラスへ置き換える。
 */
import type { AuthorizationPort } from '../../application/security/authorization';
import { decideAuthorization, type AuthorizationAction, type AuthorizationDecision, type AuthorizationResource } from '../../domain/security/authorization';
import type { Principal } from '../../domain/security/principal';

export class RoleMatrixAuthorization implements AuthorizationPort {
  async authorize(principal: Principal, action: AuthorizationAction, resource?: AuthorizationResource): Promise<AuthorizationDecision> {
    return decideAuthorization(principal, action, resource);
  }
}

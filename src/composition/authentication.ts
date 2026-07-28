/**
 * Composition: 認証・認可の実装選択（`AuthenticationPort` / `AuthorizationPort`）。
 *
 * `composition` だけが adapters 実装を import してよい（depcruise ルール）。
 * エントリポイント（`src/server.ts`）はここを経由して実装を受け取る。
 */
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { TokenAuthentication } from '../adapters/security/token-authentication';
import type { AuthenticationPort } from '../application/security/authentication';
import type { AuthorizationPort } from '../application/security/authorization';
import type { AuthSettings } from '../config/environment';
import type { TenantScope } from '../domain/tool/ids';

/**
 * 起動設定から認証実装を組み立てる。
 *
 * - `single-user`: 常に既定テナントの Principal を返す（従来どおりの無認証動作）。
 * - `token`: Bearer トークン。トークンごとにテナントを変えられる。
 *
 * `scope` は単一ユーザーモードで使う既定テナント（`AGENTCONTEXT_TENANT_ID` / `_WORKSPACE_ID`）。
 */
export function createAuthentication(settings: AuthSettings, scope: TenantScope): AuthenticationPort {
  if (settings.mode === 'token') return new TokenAuthentication(settings.tokens);
  return new SingleUserAuthentication(scope);
}

/**
 * 認可の実装を組み立てる。
 *
 * 現状は認証方式に関係なく同じロール表（`docs/08-security-auth.md` §3.2）を使う。
 * 単一ユーザーモードで全操作が通るのは、この関数が方式を見ているからではなく、
 * `SingleUserAuthentication` が返す Principal が全ロールを持つため
 * （＝権限の話を1箇所＝Principal に集約してある）。
 */
export function createAuthorization(): AuthorizationPort {
  return new RoleMatrixAuthorization();
}

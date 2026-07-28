/**
 * Composition: 認証設定 → `AuthenticationPort` の実装選択。
 *
 * `composition` だけが adapters 実装を import してよい（depcruise ルール）。
 * エントリポイント（`src/server.ts`）はここを経由して実装を受け取る。
 */
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { TokenAuthentication } from '../adapters/security/token-authentication';
import type { AuthenticationPort } from '../application/security/authentication';
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

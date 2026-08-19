/**
 * adapters層: `SingleUserAuthentication` — 認証プロバイダ未設定時の既定。
 *
 * 常に同じ Principal（既定テナント／ワークスペース）を返す。ローカル単一利用者の体験を
 * 壊さないための互換モードであり、**`127.0.0.1` 以外へバインドする構成では使えない**
 * （`src/config/environment.ts` の `serverSettings` が起動を拒否する）。
 */
import {
  authenticated,
  type AuthenticationPort,
  type AuthenticationRequest,
  type AuthenticationResult,
} from '../../application/security/authentication';
import { singleUserPrincipal, type Principal } from '../../domain/security/principal';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export class SingleUserAuthentication implements AuthenticationPort {
  readonly mode = 'single-user' as const;
  /** 資格情報を要求しない。 */
  readonly required = false;

  private readonly principal: Principal;

  constructor(scope?: TenantScope) {
    this.principal = singleUserPrincipal(scope);
  }

  /** 資格情報は見ない（Portの形に合わせて引数だけ受ける）。 */
  async authenticate(_request: AuthenticationRequest): Promise<AuthenticationResult> {
    return authenticated(this.principal);
  }
}

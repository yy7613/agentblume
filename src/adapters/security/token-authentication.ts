/**
 * adapters層: `TokenAuthentication` — 共有トークン（Bearer）認証。
 *
 * チーム利用の最小実装。トークンは**人ごとに1本**登録できるので、
 * 「誰が」を subject として残せ、1人分だけを失効させられる（共有1本だと全員を巻き込む）。
 * トークンごとにテナント／ワークスペースを変えられるため、テナント境界を実際に効かせられる。
 *
 * OIDC（Authorization Code + PKCE）は `AuthenticationPort` の別実装として後段Waveで追加する。
 * この実装が「Portだけ作って実装ゼロ」を避けるための、動く最小の1つ。
 *
 * ## 比較のしかた
 *
 * トークンの一致判定は `timingSafeEqual`（定数時間）で行う。素の `===` は先頭から
 * 1バイトずつ比較して不一致で即座に false を返すため、応答時間の差から
 * 「何文字目まで合っているか」を推定できてしまう（総当たりが線形時間になる）。
 * 長さが違う場合は `timingSafeEqual` が throw するので、先に長さでふるい落とす
 * （長さは秘密ではない）。
 */
import { timingSafeEqual } from 'node:crypto';
import {
  authenticated,
  bearerToken,
  rejected,
  type AuthenticationPort,
  type AuthenticationRequest,
  type AuthenticationResult,
} from '../../application/security/authentication';
import type { Principal } from '../../domain/security/principal';
import { DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID } from '../../domain/security/principal';

/** 登録するトークン1本ぶんの設定。 */
export interface TokenCredential {
  /** 誰のトークンか（監査の「誰が」）。 */
  readonly subject: string;
  /** 共有秘密。`Authorization: Bearer <token>` で送られる。 */
  readonly token: string;
  /** 省略時は既定テナント。 */
  readonly tenantId?: string;
  /** 省略時は既定ワークスペース。 */
  readonly workspaceId?: string;
  readonly displayName?: string;
  /** 次Wave（RBAC）用。今回は保持するだけ。 */
  readonly roles?: readonly string[];
}

/**
 * トークンの最小長。短いトークンは総当たりで割れるため、生成の失敗（空文字・"changeme"）を
 * 入口で落とす。32文字は `openssl rand -hex 16` 相当。
 */
export const MINIMUM_TOKEN_LENGTH = 32;

/** 資格情報の設定が壊れている（起動を止めるべき状態）。 */
export class TokenAuthenticationConfigurationError extends Error {
  readonly code = 'AUTH_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'TokenAuthenticationConfigurationError';
  }
}

function equalsConstantTime(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class TokenAuthentication implements AuthenticationPort {
  readonly mode = 'token' as const;
  /** 資格情報が必須。未提示は401。 */
  readonly required = true;

  private readonly entries: readonly { readonly token: string; readonly principal: Principal }[];

  constructor(credentials: readonly TokenCredential[]) {
    if (credentials.length === 0) {
      throw new TokenAuthenticationConfigurationError('TokenAuthentication: at least one token is required');
    }
    const seenTokens = new Set<string>();
    const seenSubjects = new Set<string>();
    this.entries = credentials.map((credential) => {
      if (credential.subject.trim() === '') {
        throw new TokenAuthenticationConfigurationError('TokenAuthentication: subject must not be empty');
      }
      if (credential.token.length < MINIMUM_TOKEN_LENGTH) {
        // 値そのものはメッセージへ出さない。
        throw new TokenAuthenticationConfigurationError(
          `TokenAuthentication: token for '${credential.subject}' must be at least ${MINIMUM_TOKEN_LENGTH} characters`,
        );
      }
      if (seenTokens.has(credential.token)) {
        throw new TokenAuthenticationConfigurationError(
          `TokenAuthentication: duplicate token for '${credential.subject}' (each subject needs its own token)`,
        );
      }
      if (seenSubjects.has(credential.subject)) {
        throw new TokenAuthenticationConfigurationError(`TokenAuthentication: duplicate subject: '${credential.subject}'`);
      }
      seenTokens.add(credential.token);
      seenSubjects.add(credential.subject);
      const principal: Principal = {
        subject: credential.subject,
        tenantId: credential.tenantId ?? DEFAULT_TENANT_ID,
        workspaceId: credential.workspaceId ?? DEFAULT_WORKSPACE_ID,
        ...(credential.displayName === undefined ? {} : { displayName: credential.displayName }),
        roles: credential.roles ?? ['operator'],
      };
      return { token: credential.token, principal };
    });
  }

  async authenticate(request: AuthenticationRequest): Promise<AuthenticationResult> {
    const presented = bearerToken(request.header('authorization'));
    if (presented === undefined) return rejected('missing-credentials');
    // 一致しても早期 return しない。最初に一致したものを覚えて全件を走り切ることで、
    // 「何本目で当たったか」が応答時間に出ないようにする。
    let matched: Principal | undefined;
    for (const entry of this.entries) {
      if (equalsConstantTime(presented, entry.token) && matched === undefined) matched = entry.principal;
    }
    return matched === undefined ? rejected('invalid-credentials') : authenticated(matched);
  }
}

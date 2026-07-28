/**
 * api層: 認証フックと「スコープの唯一の供給源」
 *
 * ## 何を直したか
 *
 * 以前は全ルートが `body.scope` / `query.tenantId` からテナント境界を取っていた。
 * つまり**境界を決める主体がクライアント**で、`tenantId` を書き換えるだけで
 * 他テナントのデータを読み書き・削除できた。
 *
 * ここから先、スコープは `request.principal` からしか取れない（`scopeOf`）。
 * リクエスト本文の `scope` / `tenantId` / `workspaceId` は**受け取るが読まない**
 * （後方互換のため受理は続ける。判断の根拠は `schemas.ts` の `tenantScopeSchema` を参照）。
 *
 * ## 公開パス
 *
 * `/health` `/ready` は認証不要（ロードバランサ・監視から資格情報なしで叩けなければ意味がない）。
 * ビルド済みUIの配信（`GET /` `GET /assets/*`）も認証不要にする。ここを閉じると
 * **トークンを入力する画面自体が開けない**。UIシェルは静的ファイルで、データは含まない。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticationPort, AuthenticationRequest } from '../application/security/authentication';
import { authenticated } from '../application/security/authentication';
import type { Principal } from '../domain/security/principal';
import { principalScope, singleUserPrincipal } from '../domain/security/principal';
import type { TenantScope } from '../domain/tool/ids';

declare module 'fastify' {
  interface FastifyRequest {
    /** 認証フックが解決した主体。公開パスでは未設定。 */
    principal?: Principal;
  }
}

/** 認証されていないリクエスト（401 UNAUTHENTICATED）。 */
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';

  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** 認証不要なパス（完全一致）。 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health', '/ready']);

/**
 * `buildServer` に `authentication` を渡さなかったときの既定。
 *
 * 常に既定テナントの単一ユーザーPrincipalを返す（＝従来どおりの挙動）。**テストと埋め込み用**で、
 * 本番経路（`src/server.ts`）は composition が組み立てた実装を必ず渡す。
 * adapters の `SingleUserAuthentication` と同じ振る舞いだが、api層は adapters を import
 * できない（depcruise `api-production-no-adapters-composition`）ため、ここに最小形を置く。
 */
export function defaultAuthentication(): AuthenticationPort {
  const principal = singleUserPrincipal();
  return {
    mode: 'single-user',
    required: false,
    authenticate: async () => authenticated(principal),
  };
}

/** `/foo/bar?x=1` → `/foo`。ルートパスや空文字は `undefined`。 */
function firstSegment(url: string): string | undefined {
  const path = url.split('?')[0] ?? '';
  const match = /^(\/[^/?#]+)/.exec(path);
  return match?.[1];
}

/** クエリを落としたパス部分。 */
export function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

/**
 * 認証を免除するリクエストか。
 *
 * - `/health` `/ready`: 監視用。
 * - APIが所有しない接頭辞への GET / HEAD: ビルド済みUI（`/`, `/assets/*`, SPAフォールバック）。
 *   API接頭辞の下は必ず認証する（`/tools/...` に綴り間違いがあっても素通しにしない）。
 */
export function isPublicRequest(request: { method: string; url: string }, apiPrefixes: ReadonlySet<string>): boolean {
  if (PUBLIC_PATHS.has(pathOf(request.url))) return true;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const prefix = firstSegment(request.url);
  return prefix === undefined || !apiPrefixes.has(prefix);
}

/** Fastify のリクエストを Port が受け取れる形へ写す。 */
function toAuthenticationRequest(request: FastifyRequest): AuthenticationRequest {
  return {
    method: request.method,
    url: request.url,
    header: (name) => {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

/**
 * ルートハンドラが使うスコープ。**これがテナント境界の唯一の供給源**。
 *
 * 認証フックを通っていれば必ず `principal` が載っている。載っていない場合は
 * 公開パスからスコープ付きの処理を呼ぼうとしている設定ミスなので 401 で止める
 * （既定値へ倒すと「認証を外した経路が黙って既定テナントへ書く」状態を作ってしまう）。
 */
export function scopeOf(request: FastifyRequest): TenantScope {
  const principal = request.principal;
  if (principal === undefined) throw new UnauthenticatedError('authentication is required for this route');
  return principalScope(principal);
}

/** ルートハンドラが「誰が」を必要とするとき（監査・所有者の既定値）に使う。 */
export function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new UnauthenticatedError('authentication is required for this route');
  return principal;
}

const REJECTION_MESSAGE: Readonly<Record<string, string>> = {
  'missing-credentials': 'authentication required: send an Authorization: Bearer <token> header',
  'invalid-credentials': 'the provided credentials were rejected',
};

/**
 * 認証フックを登録する。
 *
 * `onRequest`（ボディをパースする前）に置く。認証されないリクエストのために
 * 10 MiB のボディを読み切る必要はないし、読む前に切れば攻撃面も小さい。
 */
export function registerAuthentication(
  app: FastifyInstance,
  authentication: AuthenticationPort,
  apiPrefixes: ReadonlySet<string>,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRequest(request, apiPrefixes)) return;
    const result = await authentication.authenticate(toAuthenticationRequest(request));
    if (result.kind === 'authenticated') {
      request.principal = result.principal;
      return;
    }
    // WWW-Authenticate はクライアントに「どの方式で出し直せばよいか」を伝える標準の手段。
    void reply
      .status(401)
      .header('www-authenticate', 'Bearer realm="agentblume"')
      .send({ error: { code: 'UNAUTHENTICATED', message: REJECTION_MESSAGE[result.reason] ?? 'authentication required' } });
  });
}

/**
 * `GET /auth/session` — 認証済みの主体と認証方式を返す。
 *
 * UIはこれで「単一ユーザーモードか」「自分のテナントはどこか」を知る。
 * **認証必須**にしてあるので、401 が返ること自体が「トークンが要る構成だ」という合図になる。
 */
export function registerAuthRoutes(app: FastifyInstance, authentication: AuthenticationPort): void {
  app.get('/auth/session', async (request) => {
    const principal = principalOf(request);
    return {
      session: {
        mode: authentication.mode,
        authenticationRequired: authentication.required,
        principal: {
          subject: principal.subject,
          tenantId: principal.tenantId,
          workspaceId: principal.workspaceId,
          ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }),
          roles: principal.roles,
        },
      },
    };
  });
}

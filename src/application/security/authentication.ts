/**
 * application層 Port: `AuthenticationPort`（資格情報 → Principal）
 *
 * 実装は adapters 層（`SingleUserAuthentication` / `TokenAuthentication`）。
 * api層は Fastify の `onRequest` フックでこのPortを呼び、解決できた `Principal` を
 * `request.principal` に載せる。解決できなければ 401 で止める。
 *
 * HTTPの型（FastifyRequest）をここへ持ち込まないため、フックが必要な情報だけを
 * `AuthenticationRequest` に写して渡す。
 */
import type { Principal } from '../../domain/security/principal';

/** 認証方式の識別子。起動ログ・UIバッジ・`GET /auth/session` が使う。 */
export const AUTHENTICATION_MODES = ['single-user', 'token'] as const;
/** `AUTHENTICATION_MODES` の要素。 */
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

/** 認証に必要な最小限のリクエスト情報。 */
export interface AuthenticationRequest {
  /** HTTPメソッド（大文字）。 */
  readonly method: string;
  /** パス + クエリ。 */
  readonly url: string;
  /** ヘッダ取得（名前は小文字で問い合わせる）。 */
  header(name: string): string | undefined;
}

/** 認証が拒否された理由。api層が401のメッセージを選ぶために使う。 */
export type AuthenticationRejection =
  /** Authorization ヘッダが無い（＝まだ資格情報を送っていない）。 */
  | 'missing-credentials'
  /** 資格情報はあるが一致しない・形式が違う。 */
  | 'invalid-credentials';

/** 認証結果。成功か拒否かの判別union（例外は「認証基盤の障害」だけに使う）。 */
export type AuthenticationResult =
  | { readonly kind: 'authenticated'; readonly principal: Principal }
  | { readonly kind: 'rejected'; readonly reason: AuthenticationRejection };

/** 資格情報から Principal を解決する。 */
export interface AuthenticationPort {
  /** この構成がどの方式で認証しているか。 */
  readonly mode: AuthenticationMode;
  /**
   * 認証が必須か。`false`（単一ユーザーモード）なら資格情報なしでも Principal を返す。
   * 起動時のバインドアドレス検証とUI表示がこの値を見る。
   */
  readonly required: boolean;
  authenticate(request: AuthenticationRequest): Promise<AuthenticationResult>;
}

/** 成功結果の組み立て（実装の定型を1箇所へ）。 */
export function authenticated(principal: Principal): AuthenticationResult {
  return { kind: 'authenticated', principal };
}

/** 拒否結果の組み立て。 */
export function rejected(reason: AuthenticationRejection): AuthenticationResult {
  return { kind: 'rejected', reason };
}

/**
 * `Authorization: Bearer <token>` からトークンを取り出す。
 *
 * scheme の大小は無視する（RFC 7235 は case-insensitive）。scheme が Bearer でない、
 * または値が空なら `undefined`。
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  return match?.[1];
}

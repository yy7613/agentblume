/**
 * api層: 資産メタデータの所有者（`owner`）の既定値（v52）。
 *
 * `owner` は自由入力のラベルで、認可にも検索にも使っていない（認可は認証主体 `ownerSubject` を見る）。
 * そのため要求本文では省略可とし、省略・空文字・空白だけのときはログイン中の主体の名前で埋める。
 * ドメインの不変条件（保存される `metadata.owner` は空でない）は変えず、ここで必ず空でない値にしてから渡す。
 */
import type { FastifyRequest } from 'fastify';
import { principalOf } from './authentication';

/** 要求の owner（前後の空白を除く）。空・省略ならログイン中の主体の表示名、無ければ subject。 */
export function resolveOwner(request: FastifyRequest, owner: string | undefined): string {
  const explicit = owner?.trim() ?? '';
  if (explicit !== '') return explicit;
  const principal = principalOf(request);
  const displayName = principal.displayName?.trim() ?? '';
  return displayName !== '' ? displayName : principal.subject;
}

/** 本文の `owner` を解決済みの値へ置き換える（`...body` で丸ごと渡すルート用）。 */
export function withResolvedOwner<T extends { readonly owner?: string | undefined }>(request: FastifyRequest, body: T): Omit<T, 'owner'> & { owner: string } {
  return { ...body, owner: resolveOwner(request, body.owner) };
}

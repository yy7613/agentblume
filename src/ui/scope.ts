/**
 * UI が使うテナントスコープの唯一の置き場。
 *
 * ## なぜ1箇所にまとめたか
 *
 * 以前は12画面が `const scope = { tenantId: 'local', workspaceId: 'default' }` を各自で書いていた。
 * そのうえ Tool Builder はこの値を**自由入力欄として利用者へ露出**していたので、
 * うっかり書き換えて保存したToolは他の画面から永久に見えなくなった。
 *
 * いまはサーバーが**認証済みPrincipalから**スコープを決める（`src/api/authentication.ts`）。
 * リクエストに載せた scope はサーバーに読まれない。したがってここに置く値は
 * 「境界の指定」ではなく **「自分がどのテナントに居るかの写し」** であり、用途は2つだけ。
 *
 * - 下書き（localStorage）のキーをテナントごとに分けること。
 * - 画面へ現在のテナントを表示すること。
 *
 * 起動時に `GET /auth/session` の結果で `applySessionScope` を1回呼ぶ。
 * 各画面は同じオブジェクト参照を読むので、描画開始前に確定していれば全画面へ行き渡る。
 */
import type { TenantScopeDto } from './api/types';

/** 認証プロバイダ未設定（単一ユーザーモード）のときのスコープ。 */
export const DEFAULT_SCOPE: TenantScopeDto = { tenantId: 'local', workspaceId: 'default' };

/**
 * 現在のスコープ。**参照を差し替えない**（各画面が import 時に掴んだ参照を読み続けるため、
 * 中身を書き換える形にしてある）。
 */
export const scope: { tenantId: string; workspaceId: string } = { ...DEFAULT_SCOPE };

/** `GET /auth/session` が返した自分のスコープを反映する。 */
export function applySessionScope(next: TenantScopeDto): void {
  scope.tenantId = next.tenantId;
  scope.workspaceId = next.workspaceId;
}

/** テスト用: 既定値へ戻す。 */
export function resetScope(): void {
  applySessionScope(DEFAULT_SCOPE);
}

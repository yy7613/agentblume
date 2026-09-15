/**
 * api層: 経費精算「入力と規程（追加読取・運賃マスタ・規程のヒアリング。docs/21 §20.9.4）」のルート → 必要な権限。
 *
 * `expense-authorization.ts` の `EXPENSE_ROUTE_RULES` が連結する。リソース種別はすべて `workspace`。
 * - 追加読取とヒアリングの開始・回答は保存しないが**モデルを回す**ので edit（仕訳の読取と同じ理由）。
 * - 監査は「以後の判定の基準が変わる」操作だけ: 運賃マスタの保存・CSV 取込、ヒアリングの案の規程への保存。
 * - 運賃の照合（lookup）は POST だが読むだけなので read。
 */
import { rule, type RouteRule } from './route-rule';

export const EXPENSE_INPUT_ROUTE_RULES: readonly RouteRule[] = [
  rule('POST', '/expense/receipts/extract-detail', 'edit', 'workspace'),
  rule('GET', '/expense/fares', 'read', 'workspace'),
  rule('PUT', '/expense/fares', 'edit', 'workspace', true),
  rule('GET', '/expense/fares/export', 'read', 'workspace'),
  rule('POST', '/expense/fares/import', 'edit', 'workspace', true),
  rule('POST', '/expense/fares/lookup', 'read', 'workspace'),
  rule('POST', '/expense/policy-hearings', 'edit', 'workspace'),
  rule('GET', '/expense/policy-hearings', 'read', 'workspace'),
  rule('GET', '/expense/policy-hearings/:id', 'read', 'workspace'),
  rule('POST', '/expense/policy-hearings/:id/answers', 'edit', 'workspace'),
  rule('GET', '/expense/policy-hearings/:id/diff', 'read', 'workspace'),
  rule('POST', '/expense/policy-hearings/:id/accept', 'edit', 'workspace', true),
  rule('POST', '/expense/policy-hearings/:id/cancel', 'edit', 'workspace'),
];

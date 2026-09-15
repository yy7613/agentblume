/**
 * api層: 経費精算「人と承認（従業員・組織・紐付け候補・承認の流れ。docs/21 §20.9.2）」のルート → 必要な権限。
 *
 * `expense-authorization.ts` の `EXPENSE_ROUTE_RULES` が連結する。リソース種別はすべて `workspace`。
 * - 参照は read、マスタの変更は edit。**口座番号つきの従業員 CSV の出力だけ approve**（個人の口座番号の持ち出し。振込データの作成と同じ重さ）。
 * - 監査: 従業員の登録・編集（口座のすり替えを後から追う）、CSV の取込と出力（個人情報の出し入れ）、組織の保存（承認者が変わる）、
 *   紐付けの確定（申請者が変わる）。参照・試算・準備状況は記録しない。
 */
import { rule, type RouteRule } from './route-rule';

export const EXPENSE_PEOPLE_ROUTE_RULES: readonly RouteRule[] = [
  rule('GET', '/expense/me', 'read', 'workspace'),
  rule('GET', '/expense/people/readiness', 'read', 'workspace'),
  rule('GET', '/expense/employees', 'read', 'workspace'),
  rule('POST', '/expense/employees', 'edit', 'workspace', true),
  rule('GET', '/expense/employees/export', 'read', 'workspace', true),
  rule('GET', '/expense/employees/export-bank-accounts', 'approve', 'workspace', true),
  rule('POST', '/expense/employees/import', 'edit', 'workspace', true),
  rule('GET', '/expense/employees/:id', 'read', 'workspace'),
  rule('PUT', '/expense/employees/:id', 'edit', 'workspace', true),
  rule('GET', '/expense/organization', 'read', 'workspace'),
  rule('PUT', '/expense/organization', 'edit', 'workspace', true),
  rule('GET', '/expense/claims/employee-links', 'read', 'workspace'),
  rule('POST', '/expense/claims/employee-links', 'edit', 'workspace', true),
  rule('GET', '/expense/claims/:id/approval-flow', 'read', 'workspace'),
  rule('POST', '/expense/approval-routes/preview', 'read', 'workspace'),
];

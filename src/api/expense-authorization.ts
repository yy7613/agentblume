/**
 * api層: 経費精算（docs/21-expense.md §10.2）のルート → 必要な権限。
 *
 * 業務のルールは業務ごとのファイルに置き、`authorization.ts` の `ROUTE_RULES` が連結する（ADR-0039）。
 */
import { EXPENSE_INPUT_ROUTE_RULES } from './expense-input-authorization';
import { EXPENSE_MONEY_ROUTE_RULES } from './expense-money-authorization';
import { EXPENSE_PEOPLE_ROUTE_RULES } from './expense-people-authorization';
import { rule, type RouteRule } from './route-rule';

const EXPENSE_CORE_ROUTE_RULES: readonly RouteRule[] = [
  /**
   * --- 経費精算（docs/21-expense.md §10） ---
   *
   * リソース種別は `workspace`（経費は専用の種別を持たない。参照は全ロール、変更は Editor 以上）。
   * **承認と承認取消だけ `approve`（Publisher 以上）**: 経費の承認は職務分掌（入力する人と支払いを認める人を分ける）の要。
   * 自己承認の禁止はロールではなく会社のルールなので規程（`forbidSelfApproval`）で扱う。
   * 監査（`audit: true`）は「後から必ず問われる操作」だけ: 規程の保存・初期化・CSV 取込（以後の判定の基準が変わる）、
   * 申請の削除（証憑の抹消）、確認済み（規程違反を誰がどう認めたか）、差し戻し、承認と承認取消、仕訳下書きの作成、
   * 精算 CSV の出力（個人名と金額の持ち出し）、精算済みの印。明細の保存・取込・チェックの実行は結果が承認側の監査に現れるので対象外。
   * 抽出は保存しないが**モデルを回す**ので edit に置く（仕訳と同じ理由）。
   */
  rule('GET', '/expense/policy', 'read', 'workspace'),
  rule('PUT', '/expense/policy', 'edit', 'workspace', true),
  rule('POST', '/expense/policy/reset', 'edit', 'workspace', true),
  rule('GET', '/expense/policy/export', 'read', 'workspace'),
  rule('POST', '/expense/policy/import', 'edit', 'workspace', true),
  rule('GET', '/expense/claims', 'read', 'workspace'),
  rule('POST', '/expense/claims', 'edit', 'workspace'),
  rule('POST', '/expense/claims/import-csv', 'edit', 'workspace'),
  rule('POST', '/expense/claims/check', 'edit', 'workspace'),
  rule('POST', '/expense/claims/settle', 'edit', 'workspace', true),
  rule('GET', '/expense/claims/:id', 'read', 'workspace'),
  rule('PUT', '/expense/claims/:id', 'edit', 'workspace'),
  rule('DELETE', '/expense/claims/:id', 'edit', 'workspace', true),
  rule('POST', '/expense/claims/:id/items', 'edit', 'workspace'),
  rule('DELETE', '/expense/claims/:id/items/:itemId', 'edit', 'workspace'),
  rule('GET', '/expense/claims/:id/items/:itemId/receipt', 'read', 'workspace'),
  rule('POST', '/expense/receipts/extract', 'edit', 'workspace'),
  rule('POST', '/expense/claims/:id/acknowledge', 'edit', 'workspace', true),
  rule('GET', '/expense/claims/:id/return-draft', 'read', 'workspace'),
  rule('POST', '/expense/claims/:id/return', 'edit', 'workspace', true),
  rule('POST', '/expense/claims/:id/approve', 'approve', 'workspace', true),
  rule('POST', '/expense/claims/:id/unapprove', 'approve', 'workspace', true),
  rule('POST', '/expense/claims/:id/journal-drafts', 'edit', 'workspace', true),
  rule('GET', '/expense/export', 'read', 'workspace', true),
];

/** 骨格のルートと 3 系統（A 人と承認 / B お金の流れ / C 入力と規程。docs/21 §20.9）のルート。系統の表は系統のファイルが持つ。 */
export const EXPENSE_ROUTE_RULES: readonly RouteRule[] = [
  ...EXPENSE_CORE_ROUTE_RULES,
  ...EXPENSE_PEOPLE_ROUTE_RULES,
  ...EXPENSE_MONEY_ROUTE_RULES,
  ...EXPENSE_INPUT_ROUTE_RULES,
];

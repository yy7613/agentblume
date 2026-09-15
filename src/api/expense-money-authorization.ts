/**
 * api層: 経費精算「お金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）」のルート → 必要な権限。
 *
 * `expense-authorization.ts` の `EXPENSE_ROUTE_RULES` が連結する。リソース種別はすべて `workspace`。
 * - 参照は read。プレビュー（保存しない）も read。
 * - 仮払の承認だけ `approve`（職務分掌。仮払を渡すことを認める人と入力する人を分ける）。
 * - 監査は「後から必ず問われる操作・個人情報の持ち出し」: 仮払の承認・取消・支払・支払取消・精算・返金・追加支給・仕訳下書き、
 *   カードの設定・明細の取込と削除・対象外の印・手動の紐付けと解除、集計 CSV の出力（個人名と金額の持ち出し）。
 *   仮払の申請・編集、申請への紐付け、照合の実行は結果が承認・精算側の監査に現れるので対象外。
 * 振込データ（UC3）: 口座番号を含む出力（作成・再ダウンロード）は `approve` + 監査。振込元の設定の保存・確定・取消は edit + 監査。
 * 事前点検（状態を変えない）は read。
 */
import { rule, type RouteRule } from './route-rule';

export const EXPENSE_MONEY_ROUTE_RULES: readonly RouteRule[] = [
  rule('GET', '/expense/money-readiness', 'read', 'workspace'),
  // 振込データ（UC3）
  rule('GET', '/expense/payout-settings', 'read', 'workspace'),
  rule('PUT', '/expense/payout-settings', 'edit', 'workspace', true),
  rule('POST', '/expense/payouts/preview', 'read', 'workspace'),
  rule('POST', '/expense/payouts', 'approve', 'workspace', true),
  rule('GET', '/expense/payouts', 'read', 'workspace'),
  rule('GET', '/expense/payouts/:id/file', 'approve', 'workspace', true),
  rule('POST', '/expense/payouts/:id/confirm', 'edit', 'workspace', true),
  rule('POST', '/expense/payouts/:id/cancel', 'edit', 'workspace', true),
  // 仮払（UC4）
  rule('GET', '/expense/advances', 'read', 'workspace'),
  rule('POST', '/expense/advances', 'edit', 'workspace'),
  rule('GET', '/expense/advances/:id', 'read', 'workspace'),
  rule('PUT', '/expense/advances/:id', 'edit', 'workspace'),
  rule('POST', '/expense/advances/:id/approve', 'approve', 'workspace', true),
  rule('POST', '/expense/advances/:id/cancel', 'edit', 'workspace', true),
  rule('POST', '/expense/advances/:id/mark-paid', 'edit', 'workspace', true),
  rule('POST', '/expense/advances/:id/unpay', 'edit', 'workspace', true),
  rule('GET', '/expense/advances/:id/settlement-preview', 'read', 'workspace'),
  rule('POST', '/expense/advances/:id/settle', 'edit', 'workspace', true),
  rule('POST', '/expense/advances/:id/refund-received', 'edit', 'workspace', true),
  rule('POST', '/expense/advances/:id/additional-paid', 'edit', 'workspace', true),
  rule('POST', '/expense/advances/:id/journal-drafts', 'edit', 'workspace', true),
  rule('PUT', '/expense/claims/:id/advance', 'edit', 'workspace'),
  // 法人カード（UC5）
  rule('GET', '/expense/card-settings', 'read', 'workspace'),
  rule('PUT', '/expense/card-settings', 'edit', 'workspace', true),
  rule('POST', '/expense/card-statements/preview', 'read', 'workspace'),
  rule('POST', '/expense/card-statements', 'edit', 'workspace', true),
  rule('GET', '/expense/card-statements', 'read', 'workspace'),
  rule('DELETE', '/expense/card-statements/:id', 'edit', 'workspace', true),
  rule('GET', '/expense/card-transactions', 'read', 'workspace'),
  rule('POST', '/expense/card-transactions/match', 'edit', 'workspace'),
  rule('POST', '/expense/card-transactions/:id/exclude', 'edit', 'workspace', true),
  rule('POST', '/expense/card-transactions/:id/include', 'edit', 'workspace', true),
  rule('POST', '/expense/card-transactions/:id/link', 'edit', 'workspace', true),
  rule('POST', '/expense/card-transactions/:id/unlink', 'edit', 'workspace', true),
  // 集計（UC6）
  rule('GET', '/expense/summary', 'read', 'workspace'),
  rule('GET', '/expense/summary/export', 'read', 'workspace', true),
];

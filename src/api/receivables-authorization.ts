/**
 * api層: 入金消込（docs/22-receivables.md §7）のルート → 必要な権限。
 *
 * 業務のルールは業務ごとのファイルに置き、`authorization.ts` の `ROUTE_RULES` が連結する（ADR-0039）。
 */
import { rule, type RouteRule } from './route-rule';

export const RECEIVABLES_ROUTE_RULES: readonly RouteRule[] = [
  /**
   * リソース種別は仕訳と同じ `workspace`（参照は全ロール、変更は Editor 以上）。
   * 監査（`audit: true`）は「後から必ず問われる操作」だけ: 設定の保存（端数処理・手数料範囲・仕訳科目という判定と帳簿の前提）、
   * 発行・取消（対外的な書類の確定と抹消）、消込の確定・一括確定・取消（売掛金の消滅と仕訳）、取引先の削除、明細の削除。
   * 判定の実行と明細の取込は、結果が確定の監査に現れるので対象外。
   */
  rule('GET', '/receivables/settings', 'read', 'workspace'),
  rule('PUT', '/receivables/settings', 'edit', 'workspace', true),
  rule('GET', '/receivables/customers', 'read', 'workspace'),
  rule('POST', '/receivables/customers', 'edit', 'workspace'),
  rule('GET', '/receivables/customers/:id', 'read', 'workspace'),
  rule('PUT', '/receivables/customers/:id', 'edit', 'workspace'),
  rule('DELETE', '/receivables/customers/:id', 'edit', 'workspace', true),
  rule('GET', '/receivables/invoices', 'read', 'workspace'),
  rule('POST', '/receivables/invoices', 'edit', 'workspace'),
  // 保存しないので参照権限で足りる（POST なのは下書きの中身を本文で渡すため）。
  rule('POST', '/receivables/invoices/check', 'read', 'workspace'),
  rule('GET', '/receivables/invoices/:id', 'read', 'workspace'),
  rule('PUT', '/receivables/invoices/:id', 'edit', 'workspace'),
  rule('DELETE', '/receivables/invoices/:id', 'edit', 'workspace'),
  rule('POST', '/receivables/invoices/:id/issue', 'edit', 'workspace', true),
  rule('POST', '/receivables/invoices/:id/void', 'edit', 'workspace', true),
  rule('POST', '/receivables/invoices/:id/duplicate', 'edit', 'workspace'),
  rule('GET', '/receivables/bank-csv-profiles', 'read', 'workspace'),
  rule('POST', '/receivables/bank-csv-profiles', 'edit', 'workspace'),
  rule('DELETE', '/receivables/bank-csv-profiles/:id', 'edit', 'workspace'),
  rule('POST', '/receivables/bank-transactions/preview', 'read', 'workspace'),
  rule('POST', '/receivables/bank-transactions/import', 'edit', 'workspace'),
  rule('GET', '/receivables/bank-transactions', 'read', 'workspace'),
  rule('DELETE', '/receivables/bank-transactions/:id', 'edit', 'workspace', true),
  rule('POST', '/receivables/bank-transactions/:id/ignore', 'edit', 'workspace'),
  rule('POST', '/receivables/bank-transactions/:id/unignore', 'edit', 'workspace'),
  rule('POST', '/receivables/matching/judge', 'edit', 'workspace'),
  rule('GET', '/receivables/matching/candidates', 'read', 'workspace'),
  rule('POST', '/receivables/matchings', 'edit', 'workspace', true),
  rule('POST', '/receivables/matchings/confirm-decided', 'edit', 'workspace', true),
  rule('GET', '/receivables/matchings', 'read', 'workspace'),
  rule('POST', '/receivables/matchings/:id/cancel', 'edit', 'workspace', true),
];

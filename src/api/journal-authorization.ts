/**
 * api層: 仕訳（docs/20-journal.md §9）のルート → 必要な権限。
 *
 * 業務のルールは業務ごとのファイルに置き、`authorization.ts` の `ROUTE_RULES` が連結する（ADR-0039）。
 * 割り当ての方針と監査の基準は `authorization.ts` の表の冒頭コメントに従う。
 */
import { rule, type RouteRule } from './route-rule';

export const JOURNAL_ROUTE_RULES: readonly RouteRule[] = [
  /**
   * --- 仕訳（docs/20-journal.md §9） ---
   *
   * リソース種別は `workspace`（仕訳は専用の種別を持たない。参照は全ロール、変更は Editor 以上）。
   * 監査（`audit: true`）は「後から必ず問われる操作」だけに付ける:
   * 科目マスタの全体保存・標準へ戻す・CSV 取込（**帳簿の土台を差し替える**）、ルールの保存と削除
   * （以後の自動仕訳の内容が変わる）、仕訳の確定と削除（会計上の記録の確定・抹消）、CSV 出力
   * （帳簿の持ち出し。`markExported` は仕訳の状態も変える）。
   * 文書の保存・判定の実行・CSV 取込による文書の作成は、結果が仕訳側の監査に現れるので対象外。
   */
  rule('GET', '/journal/chart', 'read', 'workspace'),
  rule('PUT', '/journal/chart', 'edit', 'workspace', true),
  rule('POST', '/journal/chart/reset', 'edit', 'workspace', true),
  rule('GET', '/journal/chart/export', 'read', 'workspace'),
  rule('POST', '/journal/chart/import', 'edit', 'workspace', true),
  rule('GET', '/journal/rules', 'read', 'workspace'),
  rule('POST', '/journal/rules', 'edit', 'workspace', true),
  rule('DELETE', '/journal/rules/:id', 'edit', 'workspace', true),
  rule('POST', '/journal/rules/test', 'read', 'workspace'),
  rule('GET', '/journal/documents', 'read', 'workspace'),
  rule('POST', '/journal/documents', 'edit', 'workspace'),
  rule('GET', '/journal/documents/:id', 'read', 'workspace'),
  rule('PUT', '/journal/documents/:id', 'edit', 'workspace'),
  rule('DELETE', '/journal/documents/:id', 'edit', 'workspace', true),
  rule('POST', '/journal/documents/import-csv', 'edit', 'workspace'),
  rule('POST', '/journal/documents/judge', 'edit', 'workspace'),
  rule('GET', '/journal/csv-presets', 'read', 'workspace'),
  rule('GET', '/journal/entries', 'read', 'workspace'),
  rule('POST', '/journal/entries', 'edit', 'workspace'),
  rule('PUT', '/journal/entries/:id', 'edit', 'workspace'),
  rule('POST', '/journal/entries/:id/confirm', 'edit', 'workspace', true),
  rule('DELETE', '/journal/entries/:id', 'edit', 'workspace', true),
  rule('GET', '/journal/export', 'read', 'workspace', true),
  /**
   * フェーズ 2（LLM 抽出とヒアリング）。抽出は保存しないが**モデルを回す**ので edit に置く
   * （参照権限しか無い利用者が課金の伴う処理を走らせられるのは違う）。
   * 受け入れだけ監査する: 科目マスタへの登録・ルールの保存・再判定を一度に行う「後から必ず問われる操作」だから。
   */
  rule('POST', '/journal/documents/extract', 'edit', 'workspace'),
  rule('POST', '/journal/hearings', 'edit', 'workspace'),
  rule('GET', '/journal/hearings', 'read', 'workspace'),
  rule('GET', '/journal/hearings/:id', 'read', 'workspace'),
  rule('POST', '/journal/hearings/:id/answers', 'edit', 'workspace'),
  rule('POST', '/journal/hearings/:id/accept', 'edit', 'workspace', true),
  rule('POST', '/journal/hearings/:id/cancel', 'edit', 'workspace'),
];

/**
 * api層: 契約書レビューと期限台帳（docs/23-contract.md §6）のルート → 必要な権限。
 *
 * 業務のルールは業務ごとのファイルに置き、`authorization.ts` の `ROUTE_RULES` が連結する（ADR-0039）。
 * リソース種別は `workspace`（参照は全ロール、変更は Editor 以上）。
 * **LLM を回すルートは保存しなくても `edit`**（参照権限しか無い利用者に課金の伴う処理を走らせない。仕訳と同じ）。
 * 監査（`audit: true`）は「後から必ず問われる操作」だけ: 審査基準の変更・削除（以後のレビュー結果が変わる）、
 * レビューの確定、締結登録と締結済み契約の変更・終了・削除（台帳の記録）、期限の完了（通知したという記録）、文書の削除。
 */
import { rule, type RouteRule } from './route-rule';

export const CONTRACT_ROUTE_RULES: readonly RouteRule[] = [
  rule('GET', '/contracts/playbooks', 'read', 'workspace'),
  rule('GET', '/contracts/playbooks/:id', 'read', 'workspace'),
  rule('POST', '/contracts/playbooks', 'edit', 'workspace', true),
  rule('DELETE', '/contracts/playbooks/:id', 'edit', 'workspace', true),
  rule('GET', '/contracts/playbook-templates', 'read', 'workspace'),
  rule('POST', '/contracts/playbooks/from-template', 'edit', 'workspace', true),
  rule('GET', '/contracts/documents', 'read', 'workspace'),
  rule('POST', '/contracts/documents', 'edit', 'workspace'),
  rule('GET', '/contracts/documents/:id', 'read', 'workspace'),
  rule('PUT', '/contracts/documents/:id', 'edit', 'workspace'),
  rule('DELETE', '/contracts/documents/:id', 'edit', 'workspace', true),
  rule('POST', '/contracts/documents/transcribe', 'edit', 'workspace'),
  rule('POST', '/contracts/documents/:id/extract', 'edit', 'workspace'),
  rule('PUT', '/contracts/documents/:id/clauses', 'edit', 'workspace'),
  rule('POST', '/contracts/documents/:id/reviews', 'edit', 'workspace'),
  rule('GET', '/contracts/reviews/:id', 'read', 'workspace'),
  rule('PUT', '/contracts/reviews/:id/decisions', 'edit', 'workspace'),
  rule('POST', '/contracts/reviews/:id/finalize', 'edit', 'workspace', true),
  // 保存しないので参照権限で足りる（POST なのは締結日などを本文で渡すため）。
  rule('POST', '/contracts/deadlines/preview', 'read', 'workspace'),
  rule('POST', '/contracts/signed', 'edit', 'workspace', true),
  rule('GET', '/contracts/signed', 'read', 'workspace'),
  rule('GET', '/contracts/signed/:id', 'read', 'workspace'),
  rule('PUT', '/contracts/signed/:id', 'edit', 'workspace', true),
  rule('DELETE', '/contracts/signed/:id', 'edit', 'workspace', true),
  rule('POST', '/contracts/signed/:id/terminate', 'edit', 'workspace', true),
  rule('GET', '/contracts/deadlines', 'read', 'workspace'),
  rule('POST', '/contracts/signed/:id/deadlines/:deadlineId/complete', 'edit', 'workspace', true),
];

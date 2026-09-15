/**
 * 契約書レビューと期限台帳（docs/23-contract.md §9）の組込みツールのシード定義。
 *
 * 業務の組込みツールは業務ごとのファイルに置き、`src/builtin-tools.ts` の共通ループが冪等に登録する（ADR-0039）。
 * 3 本とも読むだけ。レビューの確定・締結登録・期限の完了はツールにしない（画面から人が押す。docs/20 §14.1 と同じ方針）。
 */
import type { BuiltinToolSeed } from './seed';

export const CONTRACT_REVIEW_DRAFT_TOOL_ID = 'builtin-contract-review-draft';
export const CONTRACT_DEADLINES_TOOL_ID = 'builtin-contract-deadlines';
export const CONTRACT_CLAUSES_TOOL_ID = 'builtin-contract-clauses';

/** `contract_deadlines` の引数（agent-input の schema と一致させる）。省略した条件は実行時にスキップされる。 */
export const CONTRACT_DEADLINES_ARGUMENTS = {
  columns: [
    { name: 'within_days', type: 'number' as const, nullable: true },
    { name: 'counterparty', type: 'string' as const, nullable: true },
  ],
};

/** `contract_clauses` の引数。 */
export const CONTRACT_CLAUSES_ARGUMENTS = {
  columns: [
    { name: 'topic', type: 'string' as const, nullable: true },
    { name: 'tag', type: 'string' as const, nullable: true },
    { name: 'counterparty', type: 'string' as const, nullable: true },
  ],
};

const binding = (field: string) => ({ source: 'agent-input' as const, field });

export const CONTRACT_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
    internalId: CONTRACT_REVIEW_DRAFT_TOOL_ID,
    workingName: 'Contract review draft',
    displayName: 'Review Attached Contract',
    publishName: 'contract_review_draft',
    owner: 'builtin',
    // 読み取りと判定だけ。文書もレビューも保存しない。
    sideEffect: 'read-only',
    graph: {
      nodes: [
        // 契約書は引数では運べない（数十万文字をモデルに書かせることになる）ので、実行文脈から供給する。引数なしのツール。
        { id: 'review', type: 'contract-review-draft', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 64, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'review', to: 'agent-result' }],
    },
    agentTool: {
      name: 'contract_review_draft',
      description: 'Reads the contract attached to the current message (a PDF whose text was extracted in the browser, pasted text, or page images), splits it into articles, extracts the key clauses (term, auto-renewal, renewal notice deadline, payment terms, liability cap, subcontracting, IP ownership, jurisdiction, and any other clause types defined in the playbook), and checks each clause against the default contract review playbook of this workspace. Returns one row per clause type (row_type = topic: topic_id, topic_label, verdict, present, article_ref, quote, quote_verified, value_summary, reasons, recommended_text, findings, value_json, criteria_json) plus one row_type = document row with document-wide findings such as stamp duty candidates, the longest payment period, and date inconsistencies; every row also carries file_name, playbook_name, and overall. verdict is accept, negotiate (see recommended_text), reject, or unresolved when a person has to decide; reasons lists codes such as clause-missing, quote-not-found, conflicting-clauses, value-unparsed, criterion-failed, llm-criterion-failed, payment-over-limit, counterparty-profile-missing, deadline-mismatch, and stamp-duty-candidate. Always cite article_ref and quote when you explain a verdict, and treat quote_verified = false as unconfirmed. Call this when the user attaches a contract and asks what to negotiate, whether it is acceptable, or which clauses are risky. Takes no arguments: it always reads the attachments of this message and uses the default playbook. The result is a comparison with the criteria and settings registered in the playbook, not legal advice; say so, and leave whether a law applies and the final decision to the user. A long contract can take several minutes. It only proposes: it never saves the contract, finalizes a review, or registers a signed contract. If nothing is attached it fails and says so, so ask the user to attach the contract.',
    },
  },
  {
    internalId: CONTRACT_DEADLINES_TOOL_ID,
    workingName: 'Contract deadlines draft',
    displayName: 'Contract Deadlines',
    publishName: 'contract_deadlines',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: CONTRACT_DEADLINES_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'deadlines', type: 'contract-deadlines', config: { includeOverdue: true, horizonDays: 3650, limit: 500 } },
        // 引数の宣言。filter の valueBinding がここへ束縛される（エッジは張らない。仕訳 journal_entries と同じ）。
        { id: 'arguments', type: 'agent-input', config: { schema: CONTRACT_DEADLINES_ARGUMENTS, sample: { within_days: null, counterparty: null } } },
        // 過ぎた期限は days_left が負なので、lte の絞り込みに必ず残る。
        { id: 'by-days', type: 'filter', config: { column: 'days_left', op: 'lte', value: 90, valueBinding: binding('within_days') } },
        { id: 'by-counterparty', type: 'filter', config: { conditions: [{ column: 'counterparty', op: 'contains', value: 'サンプル', caseInsensitive: true, valueBinding: binding('counterparty') }] } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 200, maxBytes: 131_072, overflow: 'error' } },
      ],
      edges: [
        { from: 'deadlines', to: 'by-days' },
        { from: 'by-days', to: 'by-counterparty' },
        { from: 'by-counterparty', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'contract_deadlines',
      description: 'Returns the open deadlines of the signed contracts registered in this workspace, one row per deadline sorted by due date (contract_id, title, counterparty, kind, due_date, days_left, state, term_index, term_end, auto_renewal, basis, today). kind is renewal_notice (the last day to tell the counterparty that the contract should not be renewed), expiry, renewal (the day an auto-renewing contract renews), or custom. days_left is counted in calendar days from today and is negative when the deadline has passed (state = overdue); state = due-soon means it falls within the alert period set in the playbook. Auto-renewing contracts are shown for their current term. Call this when the user asks which contracts renew or expire soon, which renewal notices are due, or what deadlines a counterparty\'s contracts have. Narrow with within_days (deadlines up to that many days from today; overdue ones always stay) and counterparty (part of the counterparty name); omit an argument to skip that filter. Deadlines are computed from the clauses a person confirmed when registering the contract; quote basis when you tell the user a date. It only reads: it never marks a deadline as done, renews, or terminates a contract.',
    },
  },
  {
    internalId: CONTRACT_CLAUSES_TOOL_ID,
    workingName: 'Contract clauses draft',
    displayName: 'Search Contract Clauses',
    publishName: 'contract_clauses',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: CONTRACT_CLAUSES_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'clauses', type: 'contract-clauses', config: { status: 'active', limit: 500 } },
        { id: 'arguments', type: 'agent-input', config: { schema: CONTRACT_CLAUSES_ARGUMENTS, sample: { topic: null, tag: null, counterparty: null } } },
        {
          id: 'by-topic',
          type: 'filter',
          config: {
            conditions: [
              { column: 'topic_id', op: 'contains', value: 'liability', caseInsensitive: true, valueBinding: binding('topic') },
              { column: 'topic_label', op: 'contains', value: '損害賠償', caseInsensitive: true, valueBinding: binding('topic') },
            ],
            combine: 'or',
          },
        },
        { id: 'by-tag', type: 'filter', config: { conditions: [{ column: 'tags', op: 'contains', value: 'no-cap', caseInsensitive: true, valueBinding: binding('tag') }] } },
        { id: 'by-counterparty', type: 'filter', config: { conditions: [{ column: 'counterparty', op: 'contains', value: 'サンプル', caseInsensitive: true, valueBinding: binding('counterparty') }] } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 500, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [
        { from: 'clauses', to: 'by-topic' },
        { from: 'by-topic', to: 'by-tag' },
        { from: 'by-tag', to: 'by-counterparty' },
        { from: 'by-counterparty', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'contract_clauses',
      description: 'Searches the clauses of the signed contracts registered in this workspace and returns one row per contract and clause type (contract_id, title, counterparty, signed_date, contract_status, topic_id, topic_label, present, value_summary, tags, article_ref, quote, review_verdict, value_json). A clause type that a contract does not contain still appears with present = false and the tag missing, so you can answer questions such as "which contracts have no liability cap?". tags is a comma-separated list from a fixed vocabulary: missing, no-cap, cap-fixed, cap-fees-paid, cap-unspecified, auto-renewal, no-auto-renewal, payment-over-limit, promissory-note, subcontract-free, subcontract-consent, subcontract-notify, subcontract-prohibited, ip-ours, ip-theirs, ip-shared, ip-unspecified, court-exclusive, court-non-exclusive, unverified. Call this when the user asks which contracts contain, lack, or share a certain term, for example liability caps, auto-renewal, subcontracting permission, IP ownership, or the agreed court. Narrow with topic (part of a clause type id or label, such as liability or 損害賠償), tag (exactly one tag from the vocabulary, such as no-cap; for "no cap at all" also check missing), and counterparty (part of the counterparty name); omit an argument to skip that filter. Only active contracts are searched. Values are the ones a person confirmed when the contract was registered; cite article_ref and quote, and treat the unverified tag as unconfirmed. It only reads: it never edits, renews, or terminates a contract, and its answer is not legal advice.',
    },
  },
];

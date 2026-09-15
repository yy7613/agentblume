/**
 * 経費精算（docs/21-expense.md §13）の組込みツールのシード定義。
 *
 * 業務の組込みツールは業務ごとのファイルに置き、`src/builtin-tools.ts` の共通ループが冪等に登録する（ADR-0039）。
 * **すべて読むだけ**。チェック結果の保存・確認済み・差し戻し・承認・精算・仕訳下書きの作成はツールにしない
 * （状態を変える副作用で、承認は「誰が認めたか」が要る。モデルの判断で承認が起きると責任の所在が消える。§13.4）。
 */
import { EXPENSE_INPUT_BUILTIN_TOOLS } from './expense-input';
import { EXPENSE_MONEY_BUILTIN_TOOLS } from './expense-money';
import type { BuiltinToolSeed } from './seed';

export { EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID, EXPENSE_SUMMARY_TOOL_ID } from './expense-money';
export { EXPENSE_FARES_TOOL_ID } from './expense-input';

export const EXPENSE_CHECK_RECEIPT_TOOL_ID = 'builtin-expense-check-receipt';
export const EXPENSE_CLAIMS_TOOL_ID = 'builtin-expense-claims';
export const EXPENSE_POLICY_TOOL_ID = 'builtin-expense-policy';

/** 申請一覧ツールの引数。すべて nullable = 省略可（省略した条件は実行時にスキップされる）。 */
const CLAIM_ARGUMENTS = {
  columns: [
    { name: 'claimant', type: 'string' as const, nullable: true },
    { name: 'period', type: 'string' as const, nullable: true },
    { name: 'status', type: 'string' as const, nullable: true },
  ],
};

export const EXPENSE_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
    internalId: EXPENSE_CHECK_RECEIPT_TOOL_ID,
    workingName: 'Expense receipt check draft',
    displayName: 'Check Expense Receipt',
    publishName: 'expense_check_receipt',
    owner: 'builtin',
    // 読み取りと試算チェックだけ。申請も証憑も保存しない。
    sideEffect: 'read-only',
    graph: {
      nodes: [
        // 添付は引数では運べない（数 MB の base64 をモデルに書かせることになる）ので実行文脈から供給する。
        { id: 'check', type: 'expense-receipt-check', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 64, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'check', to: 'agent-result' }],
    },
    agentTool: {
      name: 'expense_check_receipt',
      description: 'Reads the receipt image attached to the current message, checks it against the expense policy saved in this workspace, and returns the verdict with one row per finding (file_name, item_no, verdict, severity, code, message, fix, category_id, category, transaction_date, payee, amount, registration_number, attendees, search_keys_complete, policy_saved, warnings, facts_json). Call this when the user attaches a receipt and asks whether it can be reimbursed, what is wrong with it, or what they must add before submitting it. Takes no arguments: it always reads the attachments of this message. verdict is pass, needs-review, or returned; a receipt with no findings comes back as a single row with verdict pass and code null. code is a fixed reason code (for example receipt-missing, date-missing, payee-missing, registration-number-missing, attendees-missing, per-person-limit-exceeded, pre-approval-missing, duplicate-across-claims), and message and fix are Japanese sentences you can relay to the user as they are. The category is guessed from the aliases in the policy; when category_id is null, ask the user which expense category it belongs to. Head counts and purposes are rarely printed on a receipt, so attendees-missing usually means you should ask the user how many people attended. Checks that need a whole claim (claim period, submission deadline, per-claim totals, duplicates inside a claim) are not run here. Amounts are tax-inclusive integers in JPY, fields that are not printed on the receipt come back null, and values are never corrected automatically, so read warnings before trusting the totals. When policy_saved is false the workspace still uses the initial policy template, so tell the user that the limits may differ from their company\'s rules. It only reads: it never saves the receipt, creates or updates a claim, approves anything, or writes a CSV file. If nothing is attached it fails and says so, so ask the user to attach the image.',
    },
  },
  {
    internalId: EXPENSE_CLAIMS_TOOL_ID,
    workingName: 'Expense claims draft',
    displayName: 'Expense Claims',
    publishName: 'expense_claims',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: CLAIM_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'claims', type: 'expense-claims', config: { limit: 500 } },
        // 引数の宣言。filter の valueBinding がここへ束縛される（エッジは張らない）。
        { id: 'arguments', type: 'agent-input', config: { schema: CLAIM_ARGUMENTS, sample: { claimant: null, period: null, status: null } } },
        { id: 'by-claimant', type: 'filter', config: { column: 'claimant', op: 'contains', value: 'テスト', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'claimant' } } },
        // 期間: 'YYYY' / 'YYYY-MM' の前方一致を、申請期間の始まりか終わりのどちらかに対して見る。
        {
          id: 'by-period',
          type: 'filter',
          config: {
            conditions: [
              { column: 'period_from', op: 'contains', value: '2026-09', valueBinding: { source: 'agent-input', field: 'period' } },
              { column: 'period_to', op: 'contains', value: '2026-09', valueBinding: { source: 'agent-input', field: 'period' } },
            ],
            combine: 'or',
          },
        },
        { id: 'by-status', type: 'filter', config: { column: 'status', op: 'eq', value: 'approved', valueBinding: { source: 'agent-input', field: 'status' } } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 500, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [
        { from: 'claims', to: 'by-claimant' },
        { from: 'by-claimant', to: 'by-period' },
        { from: 'by-period', to: 'by-status' },
        { from: 'by-status', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'expense_claims',
      description: 'Returns the expense claims (employee reimbursement requests) of this workspace, one row per claim (claim_id, claimant, employee_code, department, period_from, period_to, title, status, verdict, stale, item_count, total_amount, return_count, review_count, acknowledged_count, approved_by, approved_at, settled_at, journal_linked, top_reasons, updated_at, employee_id, department_id, advance_id, reimbursable_amount, current_step, current_approvers). Call this when the user asks which claims are waiting for approval, what someone has claimed in a period, how much has been approved or settled, or why a claim was returned. Narrow with claimant (part of the claimant\'s name, case-insensitive), period (a date prefix such as 2026 or 2026-09, matched against the start or the end of the claim period), and status (exactly one of draft, checked, in-approval, returned, approved, settled); omit an argument to skip that filter. verdict is pass, needs-review, or returned, and is null before the first check; stale true means the policy or the items changed after the check, so the verdict is out of date and the claim must be checked again before approval. top_reasons lists the most frequent reason codes; call expense_policy to explain the limits behind them. current_step and current_approvers show who must approve next while a claim is in-approval, and reimbursable_amount is the part paid back to the claimant. Amounts are tax-inclusive integers in JPY. It returns at most 500 claims and never includes receipt images. It only reads: it never checks, returns, approves, or settles a claim, creates journal entries, or writes a CSV file; a person does those on the Expense screen.',
    },
  },
  {
    internalId: EXPENSE_POLICY_TOOL_ID,
    workingName: 'Expense policy draft',
    displayName: 'Expense Policy',
    publishName: 'expense_policy',
    owner: 'builtin',
    sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'policy', type: 'expense-policy', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 200, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'policy', to: 'agent-result' }],
    },
    agentTool: {
      name: 'expense_policy',
      description: 'Returns the expense policy of this workspace, one row per expense category (category_id, name, enabled, account_id, default_tax_rate, receipt_required, receipt_exempt_below, invoice_required, invoice_exempt_below, requires_purpose, requires_attendees, requires_attendee_details, per_item_limit, per_claim_limit, per_person_limit, per_person_basis, per_unit_label, per_unit_limit, pre_approval, aliases, note, policy_saved, submission_deadline_days, attendees_include_claimant, non_reimbursable_payment_methods, severity_overrides_json, updated_at). Call this when the user asks what the spending limits are, whether a receipt or an invoice registration number is required, whether the number of attendees must be written, or which spending needs prior approval. Takes no arguments. Limits are integers in JPY, tax-inclusive unless per_person_basis is tax-excluded, and a null limit means there is no limit; per_unit_limit applies per day or per night as named by per_unit_label. The claim-wide rules (policy_saved, submission_deadline_days, attendees_include_claimant, non_reimbursable_payment_methods, severity_overrides_json) repeat on every row. When policy_saved is false the workspace still uses the initial template, whose numbers (such as 10,000 JPY per person for entertainment meals) are only defaults; say so instead of presenting them as the company\'s rules. Disabled categories are included with enabled false and must not be suggested for new expenses. It only reads: it never changes the policy.',
    },
  },
  // 系統のツール（B: 集計・仮払・カード明細、C: 運賃マスタ）。定義は系統のファイルが持つ（docs/21 §20.11）。
  ...EXPENSE_MONEY_BUILTIN_TOOLS,
  ...EXPENSE_INPUT_BUILTIN_TOOLS,
];

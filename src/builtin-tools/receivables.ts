/**
 * 入金消込（docs/22-receivables.md §10）の組込みツールのシード定義。
 *
 * 業務の組込みツールは業務ごとのファイルに置き、`src/builtin-tools.ts` の共通ループが冪等に登録する（ADR-0039）。
 * 3 本とも読むだけ。発行・取消・消込の確定・名義の学習・仕訳の作成はツールにしない（状態を変える操作は承認ゲートと
 * 「誰がいつ」が要るので、画面から人が押す。docs/20 §14.1 と同じ理由）。
 */
import type { BuiltinToolSeed } from './seed';

export const RECEIVABLES_OUTSTANDING_TOOL_ID = 'builtin-receivables-outstanding';
export const RECEIVABLES_MATCH_CANDIDATES_TOOL_ID = 'builtin-receivables-match-candidates';
export const RECEIVABLES_INVOICE_DRAFT_TOOL_ID = 'builtin-receivables-invoice-draft';

/**
 * 「期日超過だけ」を真偽値にしないのは、false を渡されたとき「未到来だけ」か「絞らない」かが曖昧になるため。
 * 数値の下限にすると、省略 = 絞らない、1 = 超過のみ、30 = 1 か月超、が一意に読める。
 */
const OUTSTANDING_ARGUMENTS = {
  columns: [
    { name: 'customer', type: 'string' as const, nullable: true },
    { name: 'min_days_overdue', type: 'number' as const, nullable: true },
  ],
};

const MATCH_ARGUMENTS = {
  columns: [
    { name: 'transaction_id', type: 'string' as const, nullable: true },
    { name: 'customer', type: 'string' as const, nullable: true },
  ],
};

export const RECEIVABLES_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
    internalId: RECEIVABLES_OUTSTANDING_TOOL_ID,
    workingName: 'Receivables outstanding draft',
    displayName: 'Unpaid Invoices',
    publishName: 'receivables_outstanding',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: OUTSTANDING_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'outstanding', type: 'receivables-outstanding', config: { limit: 500 } },
        { id: 'arguments', type: 'agent-input', config: { schema: OUTSTANDING_ARGUMENTS, sample: { customer: null, min_days_overdue: null } } },
        { id: 'by-customer', type: 'filter', config: { column: 'customer_name', op: 'contains', value: '山田', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'customer' } } },
        { id: 'by-overdue', type: 'filter', config: { column: 'days_overdue', op: 'gte', value: 1, valueBinding: { source: 'agent-input', field: 'min_days_overdue' } } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 500, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'outstanding', to: 'by-customer' }, { from: 'by-customer', to: 'by-overdue' }, { from: 'by-overdue', to: 'agent-result' }],
    },
    agentTool: {
      name: 'receivables_outstanding',
      description: 'Returns the unpaid invoices (accounts receivable) of this workspace, one row per invoice that has been issued and is not fully paid (invoice_id, invoice_number, customer_id, customer_name, issue_date, due_date, grand_total, paid_amount, outstanding_amount, days_overdue, last_payment_date, status, sales_entry_id). Call this when the user asks who has not paid yet, how much a customer still owes, or which invoices are past due. Narrow with customer (part of a customer name, case-insensitive) and min_days_overdue (1 for every past-due invoice, 30 for invoices more than a month late); omit an argument to skip that filter. days_overdue counts days from the due date to today on the server clock and is 0 when the invoice is not yet due or has no due date. Amounts are tax-inclusive integers in JPY; rows are sorted by due date, oldest first, at most 500. It only reads: it never issues, voids, or reconciles an invoice and never creates journal entries.',
    },
  },
  {
    internalId: RECEIVABLES_MATCH_CANDIDATES_TOOL_ID,
    workingName: 'Receivables match candidates draft',
    displayName: 'Payment Match Candidates',
    publishName: 'receivables_match_candidates',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: MATCH_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'candidates', type: 'receivables-match-candidates', config: { limit: 100, maxCandidates: 5 } },
        { id: 'arguments', type: 'agent-input', config: { schema: MATCH_ARGUMENTS, sample: { transaction_id: null, customer: null } } },
        { id: 'by-transaction', type: 'filter', config: { column: 'transaction_id', op: 'eq', value: 'tx-1', valueBinding: { source: 'agent-input', field: 'transaction_id' } } },
        {
          id: 'by-customer',
          type: 'filter',
          config: {
            // payer_name は銀行の生の名義（半角カナのことが多い）なので、取引先名と名義の OR にする。
            conditions: [
              { column: 'customer_name', op: 'contains', value: '山田', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'customer' } },
              { column: 'payer_name', op: 'contains', value: 'ヤマダ', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'customer' } },
            ],
            combine: 'or',
          },
        },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 500, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'candidates', to: 'by-transaction' }, { from: 'by-transaction', to: 'by-customer' }, { from: 'by-customer', to: 'agent-result' }],
    },
    agentTool: {
      name: 'receivables_match_candidates',
      description: 'Returns the invoices that each unreconciled bank deposit could be paying, with the reason, one row per deposit and candidate (transaction_id, transaction_date, amount, payer_name, stage, reason, reason_message, candidate_rank, invoice_ids, invoice_numbers, customer_id, customer_name, candidate_total, difference, fee_amount, combination_size, name_match, name_score). Call this when the user asks which invoice a payment belongs to, why a deposit was not reconciled, or what is left to reconcile. stage is decided (exactly one invoice with the same amount and a recognized payer name), candidate (a likely match that a person must confirm: a bank transfer fee deducted, several invoices paid together, a partial payment, a partial payer-name match, or an amount-only match) or unmatched (no candidate, or several equally likely ones). reason is a fixed code such as exact-amount-and-name, fee-difference, combined-payment, partial-payment, amount-only, no-candidate, multiple-candidates, ambiguous-combination or alias-conflict, and reason_message explains it in Japanese. difference is candidate_total minus amount, so a positive value is the shortfall, usually a transfer fee; invoice_ids lists several ids separated by commas for a combined payment. A deposit without any candidate still returns one row whose candidate columns are null. Narrow with transaction_id (exact) and customer (part of the customer name or the payer name); omit an argument to skip that filter. Amounts are integers in JPY. It only reads and recomputes: it never confirms a match, marks an invoice as paid, learns a payer name, or creates journal entries, so tell the user to confirm matches on the Receivables screen.',
    },
  },
  {
    internalId: RECEIVABLES_INVOICE_DRAFT_TOOL_ID,
    workingName: 'Receivables invoice draft draft',
    displayName: 'Draft Invoice from Order',
    publishName: 'receivables_invoice_draft',
    owner: 'builtin',
    // 読み取って組み立てるだけ。取引先も請求書も保存しない。
    sideEffect: 'read-only',
    graph: {
      nodes: [
        // 添付は引数では運べないので実行文脈から供給する（agent-input は置かない）。
        { id: 'draft', type: 'receivables-invoice-draft', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 200, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [{ from: 'draft', to: 'agent-result' }],
    },
    agentTool: {
      name: 'receivables_invoice_draft',
      description: 'Reads the purchase order or quotation image attached to the current message and returns a draft invoice built from it, one row per invoice line (file_name, customer_name, customer_id, transaction_date, due_date, pricing, line_no, description, quantity, unit_price, amount, tax_rate, taxable_10, tax_10, taxable_8, tax_8, taxable_0, grand_total, document_total, total_difference, violations, warnings, draft_json). Call this when the user attaches an order or a quotation and asks to prepare the invoice for it. Takes no arguments: it always reads the attachments of this message. Consumption tax is recomputed once per tax rate for the whole invoice with the rounding set in this workspace, so grand_total can differ from document_total, the total printed on the attachment; report total_difference and warnings instead of trusting either value silently. customer_id is null when no saved customer matches the name. violations lists, comma-separated, the invoice requirement codes that must be fixed before the invoice can be issued (for example issuer-registration-number-missing, transaction-date-missing or per-line-rounding); the issue date is always left for the user to decide. It only proposes: it does not save a customer or an invoice, issue anything, or create journal entries; the user pastes draft_json into the invoice form on the Receivables screen. If nothing is attached it fails and says so, so ask the user to attach the image.',
    },
  },
];

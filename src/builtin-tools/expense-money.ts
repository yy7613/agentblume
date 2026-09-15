/**
 * 経費精算「お金の流れ」の組込みツールのシード定義（docs/21 §20.11.1〜3。すべて read-only）。
 *
 * `expense_summary` / `expense_advances` / `expense_card_transactions` の 3 本。ID 定数は骨格が決めたもの（変えないこと）。
 * G-2（行ソースへのツールの引数。`RowSourceRowsInput.arguments`）が入っているので、`expense_summary` は §20.11.1 の本来の形
 * （`group_by` / `period` の範囲 / `status` を行ソースが受け取る）でシードする。`department` だけは行への filter。
 * 保存・承認・支払・取込・照合はツールにしない（ADR-0040 §7）。口座番号は出さない。
 */
import type { BuiltinToolSeed } from './seed';

export const EXPENSE_SUMMARY_TOOL_ID = 'builtin-expense-summary';
export const EXPENSE_ADVANCES_TOOL_ID = 'builtin-expense-advances';
export const EXPENSE_CARD_TRANSACTIONS_TOOL_ID = 'builtin-expense-card-transactions';

const SUMMARY_ARGUMENTS = {
  columns: [
    { name: 'period', type: 'string' as const, nullable: true },
    { name: 'group_by', type: 'string' as const, nullable: true },
    { name: 'status', type: 'string' as const, nullable: true },
    { name: 'department', type: 'string' as const, nullable: true },
  ],
};

const ADVANCE_ARGUMENTS = {
  columns: [
    { name: 'employee', type: 'string' as const, nullable: true },
    { name: 'status', type: 'string' as const, nullable: true },
  ],
};

const CARD_ARGUMENTS = {
  columns: [
    { name: 'status', type: 'string' as const, nullable: true },
    { name: 'card', type: 'string' as const, nullable: true },
    { name: 'period', type: 'string' as const, nullable: true },
  ],
};

const OUTPUT = (maxRows: number) => ({ shape: 'rows', format: 'json', maxRows, maxBytes: 262_144, overflow: 'error' });

export const EXPENSE_MONEY_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
    internalId: EXPENSE_SUMMARY_TOOL_ID,
    workingName: 'Expense summary draft',
    displayName: 'Expense Summary',
    publishName: 'expense_summary',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: SUMMARY_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'summary', type: 'expense-summary', config: { limit: 2000 } },
        // 引数の宣言。period / group_by / status は行ソースが実行時の引数として読む（エッジは張らない）。
        { id: 'arguments', type: 'agent-input', config: { schema: SUMMARY_ARGUMENTS, sample: { period: null, group_by: null, status: null, department: null } } },
        { id: 'by-department', type: 'filter', config: { column: 'department', op: 'contains', value: '営業', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'department' } } },
        { id: 'agent-result', type: 'agent-output', config: OUTPUT(2000) },
      ],
      edges: [
        { from: 'summary', to: 'by-department' },
        { from: 'by-department', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'expense_summary',
      description: 'Returns totals of the expense claims in this workspace grouped the way you ask, one row per group (month, department_id, department, category_id, category, employee_id, claimant, status, claim_count, item_count, amount, reimbursable_amount, corporate_amount, basis, period_from, period_to, group_by). Call this when the user asks how much was spent in a month, which department or expense category spent the most, how much each person claimed, or how totals changed from month to month. All arguments are optional: period is a year (2026), a month (2026-09), or a range of months (2026-04..2026-09) and defaults to the last 12 months; group_by is a comma-separated list chosen from month, department, category, claimant, and status and defaults to month,category; status is one of checked, in-approval, approved, settled, or all and defaults to approved and settled together; department keeps only departments whose name contains the text. Columns that are not in group_by come back null. Months come from each item\'s transaction date, and items without a transaction date are counted under the month unknown. amount is the tax-inclusive total in JPY, reimbursable_amount is the part paid back to employees, and corporate_amount is the part paid with company cards, so amount always equals the sum of the other two. Rows name people and departments, so share them only with users who may see expense data; bank accounts and receipt images are never included. It only reads: it never checks, approves, settles, or exports anything; a person does those on the Expense screen.',
    },
  },
  {
    internalId: EXPENSE_ADVANCES_TOOL_ID,
    workingName: 'Expense advances draft',
    displayName: 'Expense Advances',
    publishName: 'expense_advances',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: ADVANCE_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'advances', type: 'expense-advances', config: { limit: 500 } },
        { id: 'arguments', type: 'agent-input', config: { schema: ADVANCE_ARGUMENTS, sample: { employee: null, status: null } } },
        { id: 'by-employee', type: 'filter', config: { column: 'employee', op: 'contains', value: 'テスト', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'employee' } } },
        { id: 'by-status', type: 'filter', config: { column: 'status', op: 'eq', value: 'paid', valueBinding: { source: 'agent-input', field: 'status' } } },
        { id: 'agent-result', type: 'agent-output', config: OUTPUT(500) },
      ],
      edges: [
        { from: 'advances', to: 'by-employee' },
        { from: 'by-employee', to: 'by-status' },
        { from: 'by-status', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'expense_advances',
      description: 'Returns the cash advances of this workspace (money paid to an employee before the spending, to be settled later with expense claims), one row per advance (advance_id, employee_id, employee, department, purpose, amount, status, needed_on, planned_settle_by, overdue, approved_at, paid_on, linked_claim_count, linked_claim_total, difference, additional_payment, refund, settled_on, updated_at). Call this when the user asks which advances are still open, who has not settled an advance, whether an advance is overdue, or how much an employee must pay back or receive. Narrow with employee (part of the employee name, case-insensitive) and status (exactly one of requested, approved, paid, settling, settled, cancelled); omit an argument to skip that filter. overdue is true when the advance was paid but is not settled after planned_settle_by. difference is the total of the approved claims linked to the advance minus the advance amount: a positive value is paid to the employee as additional_payment, a negative value must be returned by the employee as refund, and it is null until the advance is settled. Amounts are integers in JPY. Bank accounts are never included. It only reads: it never approves, pays, settles, or cancels an advance; a person does those on the Expense screen.',
    },
  },
  {
    internalId: EXPENSE_CARD_TRANSACTIONS_TOOL_ID,
    workingName: 'Expense card transactions draft',
    displayName: 'Expense Card Transactions',
    publishName: 'expense_card_transactions',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: CARD_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'cards', type: 'expense-card-transactions', config: { limit: 2000 } },
        { id: 'arguments', type: 'agent-input', config: { schema: CARD_ARGUMENTS, sample: { status: null, card: null, period: null } } },
        { id: 'by-status', type: 'filter', config: { column: 'status', op: 'eq', value: 'unmatched', valueBinding: { source: 'agent-input', field: 'status' } } },
        {
          id: 'by-card',
          type: 'filter',
          config: {
            conditions: [
              { column: 'card_label', op: 'contains', value: '営業', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'card' } },
              { column: 'card_last4', op: 'contains', value: '1111', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'card' } },
            ],
            combine: 'or',
          },
        },
        { id: 'by-period', type: 'filter', config: { column: 'used_on', op: 'contains', value: '2026-09', valueBinding: { source: 'agent-input', field: 'period' } } },
        { id: 'agent-result', type: 'agent-output', config: OUTPUT(2000) },
      ],
      edges: [
        { from: 'cards', to: 'by-status' },
        { from: 'by-status', to: 'by-card' },
        { from: 'by-card', to: 'by-period' },
        { from: 'by-period', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'expense_card_transactions',
      description: 'Returns the corporate card transactions imported into this workspace and how each one was matched to expense claims, one row per transaction (transaction_id, card_id, card_label, card_last4, holder, used_on, merchant, amount, status, match_kind, match_strength, claim_id, item_id, claimant, claim_status, date_diff_days, exclusion_reason, import_file, updated_at). Call this when the user asks which company card charges still have no receipt submitted, whether a card charge was also claimed as an out-of-pocket expense, or which charges were marked as out of scope. Narrow with status (exactly one of unmatched, matched, excluded), card (part of the card label or its last four digits), and period (a date prefix such as 2026 or 2026-09 matched against used_on); omit an argument to skip that filter. match_kind corporate-item means the charge matches an item reported as paid by company card, which is the normal case; match_kind reimbursement-item means it matches an item claimed for reimbursement, which is a likely double payment the user should review on the Expense screen. unmatched rows are charges nobody has submitted a receipt for yet. The matches are the ones saved the last time someone ran matching on the Expense screen, so they can be out of date. Negative amounts are refunds. Amounts are integers in JPY. It only reads: it never imports statements, runs matching, links or unlinks a charge, excludes a charge, or changes a claim.',
    },
  },
];

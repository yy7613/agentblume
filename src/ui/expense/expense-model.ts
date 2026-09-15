/**
 * 経費精算画面の純粋関数（docs/21-expense.md §4, §11, §20.4, §20.5.1, §20.10）。
 *
 * 理由コードの文言（原因 → 直し方）・導線・状態のラベル・フォームの下書き ⇔ DTO の変換と入力検証・OpenTarget の解釈を持つ。
 * UI は backend の内部レイヤを import しないので、`REASON_CATALOG` の重さの選択肢と導線先はここに書き写し、
 * テスト（expense-model.test.ts）が domain の正準値と突き合わせて食い違いを検出する。
 * 上限額・費目名などの規程の値はここに持たない（すべて規程のデータから出す）。
 */
import type { OpenTarget } from '../navigation';
import type {
  ExpenseBlockingReasonDto, ExpenseCategoryDto, ExpenseCheckReasonDto, ExpenseClaimDto, ExpenseClaimStatusDto, ExpenseFixTargetDto,
  ExpenseItemExtractionDto, ExpenseItemSourceDto, ExpenseJournalLinkProblemDto, ExpensePaymentMethodDto, ExpensePolicyDto, ExpensePreApprovalRuleDto,
  ExpenseReasonCodeDto, ExpenseReceiptFactsDto, ExpenseReceiptRouteDto, ExpenseSeverityDto, ExpenseSeverityOverrideDto, ExpenseTotalsByRateDto, ExpenseVerdictDto,
  SaveExpenseClaimDto, SaveExpenseItemDto, SaveExpensePolicyDto,
} from '../api/expense-types';

export type Translate = (english: string, japanese: string) => string;
/** 手順の 5 タブ（規程 → 申請取込 → チェック → 承認 → 精算出力）。 */
export type ExpenseStepTab = 'policy' | 'ingest' | 'check' | 'approve' | 'settle';
/** 2 段目の「台帳とマスタ」のタブ（手順ではないので分ける。§20.10.1）。 */
export type ExpenseLedgerTab = 'employees' | 'advances' | 'cards' | 'fares' | 'reports';
export type ExpenseTab = ExpenseStepTab | ExpenseLedgerTab;
export const EXPENSE_LEDGER_TABS: readonly ExpenseLedgerTab[] = ['employees', 'advances', 'cards', 'fares', 'reports'];
type Params = ExpenseCheckReasonDto['params'];

/* ---------------------------------------------------------------------------
 * 理由コードのカタログ（domain の REASON_CATALOG の写し）
 * ------------------------------------------------------------------------- */

const RR: readonly ExpenseSeverityOverrideDto[] = ['review', 'return'];
const ORR: readonly ExpenseSeverityOverrideDto[] = ['off', 'review', 'return'];
const FIXED: readonly ExpenseSeverityOverrideDto[] = [];

/** 規程で選べる重さ（空 = 変更不可）。domain の `REASON_CATALOG[code].adjustable` と同じ値。 */
export const EXPENSE_REASON_ADJUSTABLE: Readonly<Record<ExpenseReasonCodeDto, readonly ExpenseSeverityOverrideDto[]>> = {
  'policy-unreviewed': ['review', 'off'],
  'claimant-unlinked': ORR, 'claimant-employee-disabled': RR,
  'advance-employee-mismatch': FIXED, 'advance-not-paid': RR, 'advance-already-settled': FIXED,
  'approval-route-unresolved': FIXED,
  'claim-empty': FIXED,
  'category-missing': RR, 'category-unknown': FIXED,
  'amount-missing': FIXED, 'date-missing': FIXED, 'payee-missing': RR, 'purpose-missing': ORR,
  'receipt-missing': RR, 'receipt-extraction-warning': FIXED, 'receipt-amount-mismatch': RR,
  'date-substituted-by-issue-date': FIXED, 'receipt-reads-disagree': RR, 'read-values-unconfirmed': ORR,
  'date-in-future': FIXED, 'date-outside-period': RR, 'submission-late': ORR,
  'payment-not-reimbursable': RR, 'registration-number-missing': ORR,
  'route-missing': ORR, 'commuter-pass-overlap': RR, 'commuter-pass-partial-overlap': ORR, 'fare-exceeds-table': ORR, 'fare-route-unknown': ORR,
  'per-item-limit-exceeded': RR, 'attendees-missing': RR, 'per-person-limit-exceeded': RR, 'attendee-details-missing': ORR, 'unit-count-missing': RR, 'per-unit-limit-exceeded': RR,
  'pre-approval-missing': RR,
  'duplicate-in-claim': RR, 'duplicate-across-claims': RR, 'duplicate-receipt-image': RR,
  'card-charge-claimed': RR, 'corporate-payment-unmatched': ORR,
  'per-claim-limit-exceeded': RR,
};

/** 既定の重さ（domain の `defaultSeverity` の写し）。重さの表の「既定」表示に使う。 */
export const EXPENSE_REASON_DEFAULT_SEVERITY: Readonly<Record<ExpenseReasonCodeDto, ExpenseSeverityDto>> = {
  'policy-unreviewed': 'review',
  'claimant-unlinked': 'review', 'claimant-employee-disabled': 'review', 'advance-employee-mismatch': 'return', 'advance-not-paid': 'review', 'advance-already-settled': 'return', 'approval-route-unresolved': 'review',
  'claim-empty': 'return', 'category-missing': 'return', 'category-unknown': 'return',
  'amount-missing': 'return', 'date-missing': 'return', 'payee-missing': 'review', 'purpose-missing': 'review',
  'receipt-missing': 'return', 'receipt-extraction-warning': 'review', 'receipt-amount-mismatch': 'review',
  'date-substituted-by-issue-date': 'review', 'receipt-reads-disagree': 'review', 'read-values-unconfirmed': 'review',
  'date-in-future': 'return', 'date-outside-period': 'return', 'submission-late': 'review',
  'payment-not-reimbursable': 'return', 'registration-number-missing': 'review',
  'route-missing': 'review', 'commuter-pass-overlap': 'return', 'commuter-pass-partial-overlap': 'review', 'fare-exceeds-table': 'review', 'fare-route-unknown': 'review',
  'per-item-limit-exceeded': 'return', 'attendees-missing': 'return', 'per-person-limit-exceeded': 'return', 'attendee-details-missing': 'review', 'unit-count-missing': 'return', 'per-unit-limit-exceeded': 'return',
  'pre-approval-missing': 'return', 'duplicate-in-claim': 'return', 'duplicate-across-claims': 'return', 'duplicate-receipt-image': 'return',
  'card-charge-claimed': 'return', 'corporate-payment-unmatched': 'review',
  'per-claim-limit-exceeded': 'return',
};

/** 導線先（domain の `fixTargets` の写し）。 */
export const EXPENSE_REASON_FIX_TARGETS: Readonly<Record<ExpenseReasonCodeDto, readonly ExpenseFixTargetDto[]>> = {
  'policy-unreviewed': ['policy-save'],
  'claimant-unlinked': ['claim-claimant', 'employee'], 'claimant-employee-disabled': ['employee', 'claim-claimant'],
  'advance-employee-mismatch': ['claim-advance', 'advance'], 'advance-not-paid': ['advance', 'claim-advance'], 'advance-already-settled': ['claim-advance'],
  'approval-route-unresolved': ['employee', 'organization', 'policy-approval'],
  'claim-empty': ['item'],
  'category-missing': ['item-category', 'policy-category'], 'category-unknown': ['item-category', 'policy-category'],
  'amount-missing': ['item', 'receipt'], 'date-missing': ['item', 'receipt'], 'payee-missing': ['item', 'receipt'], 'purpose-missing': ['item'],
  'receipt-missing': ['item', 'policy-category'], 'receipt-extraction-warning': ['receipt'], 'receipt-amount-mismatch': ['receipt'],
  'date-substituted-by-issue-date': ['receipt', 'item'], 'receipt-reads-disagree': ['receipt'], 'read-values-unconfirmed': ['item', 'receipt'],
  'date-in-future': ['item'], 'date-outside-period': ['item'], 'submission-late': ['policy-rules'],
  'payment-not-reimbursable': ['item', 'policy-rules'], 'registration-number-missing': ['item', 'receipt', 'policy-category'],
  'route-missing': ['item-route'], 'commuter-pass-overlap': ['item-route', 'employee-commuter'], 'commuter-pass-partial-overlap': ['item', 'employee-commuter', 'fare-table'],
  'fare-exceeds-table': ['item-route', 'fare-table'], 'fare-route-unknown': ['fare-table'],
  'per-item-limit-exceeded': ['policy-category'], 'attendees-missing': ['item'], 'per-person-limit-exceeded': ['item', 'item-category', 'policy-category'],
  'attendee-details-missing': ['item'], 'unit-count-missing': ['item'], 'per-unit-limit-exceeded': ['item', 'policy-category'],
  'pre-approval-missing': ['item', 'policy-pre-approval'],
  'duplicate-in-claim': ['item'], 'duplicate-across-claims': ['other-claim'], 'duplicate-receipt-image': ['other-claim', 'receipt'],
  'card-charge-claimed': ['card-transaction', 'item'], 'corporate-payment-unmatched': ['card-transactions', 'item'],
  'per-claim-limit-exceeded': ['policy-category'],
};

/** 明細フォームの入力欄の鍵（フォーカスと強調に使う）。`route` は C の区間欄（`RouteFields` が id `expense-item-route` を持つ）。 */
export type ItemField = 'categoryId' | 'transactionDate' | 'issueDate' | 'payeeName' | 'registrationNumber' | 'amount' | 'paymentMethod' | 'description'
  | 'purpose' | 'attendeesCount' | 'attendeeNames' | 'attendeeRelation' | 'unitCount' | 'preApprovalRef' | 'receipt' | 'period' | 'route';

/** 理由コードの `item` 導線でフォーカスする欄。 */
const REASON_ITEM_FIELD: Partial<Record<ExpenseReasonCodeDto, ItemField>> = {
  'amount-missing': 'amount', 'date-missing': 'transactionDate', 'payee-missing': 'payeeName', 'purpose-missing': 'purpose',
  'receipt-missing': 'receipt', 'date-in-future': 'transactionDate', 'date-outside-period': 'period', 'payment-not-reimbursable': 'paymentMethod',
  'registration-number-missing': 'registrationNumber', 'attendees-missing': 'attendeesCount', 'per-person-limit-exceeded': 'attendeesCount',
  'attendee-details-missing': 'attendeeNames', 'unit-count-missing': 'unitCount', 'per-unit-limit-exceeded': 'unitCount', 'pre-approval-missing': 'preApprovalRef',
  'date-substituted-by-issue-date': 'transactionDate', 'commuter-pass-partial-overlap': 'amount', 'card-charge-claimed': 'paymentMethod',
};

/* ---------------------------------------------------------------------------
 * ラベル
 * ------------------------------------------------------------------------- */

function num(value: string | number | boolean | null | undefined): string {
  if (typeof value === 'number') return value.toLocaleString('en-US');
  return value === null || value === undefined ? '' : String(value);
}

export function paymentMethodLabel(method: string, text: Translate): string {
  switch (method) {
    case 'cash': return text('Cash', '現金');
    case 'credit_card': return text('Credit card', 'クレジットカード');
    case 'bank_transfer': return text('Bank transfer', '振込');
    case 'qr': return text('QR payment', 'QR コード決済');
    case 'e_money': return text('E-money', '電子マネー');
    case 'direct_debit': return text('Direct debit', '口座振替');
    case 'corporate': return text('Paid by the company', '会社払い');
    case 'unknown': return text('Unknown', '不明');
    default: return method;
  }
}

export const EXPENSE_PAYMENT_METHODS: readonly ExpensePaymentMethodDto[] = ['cash', 'credit_card', 'bank_transfer', 'qr', 'e_money', 'direct_debit', 'unknown'];

export function claimStatusLabel(status: ExpenseClaimStatusDto | string, text: Translate): string {
  switch (status) {
    case 'draft': return text('Draft', '下書き');
    case 'checked': return text('Checked', 'チェック済み');
    case 'in-approval': return text('In approval', '承認中');
    case 'returned': return text('Returned', '差し戻し中');
    case 'approved': return text('Approved', '承認済み');
    case 'settled': return text('Settled', '精算済み');
    default: return status;
  }
}

export function verdictLabel(verdict: ExpenseVerdictDto | undefined, text: Translate): string {
  switch (verdict) {
    case 'pass': return text('Pass', '通過');
    case 'needs-review': return text('Needs review', '要確認');
    case 'returned': return text('Return', '差し戻し');
    default: return text('Not checked', '未チェック');
  }
}

export function severityLabel(severity: ExpenseSeverityOverrideDto, text: Translate): string {
  return severity === 'review' ? text('Needs review', '要確認') : severity === 'return' ? text('Return', '差し戻し') : text('Off (do not report)', '出さない');
}

/** CSV 取込の項目名（`columnMatches[].field`）の表示名。 */
export function csvFieldLabel(field: string | null, text: Translate): string {
  switch (field) {
    case null: return text('(not used)', '（当たらない）');
    case 'claimant': return text('Claimant', '申請者');
    case 'employeeCode': return text('Employee code', '社員番号');
    case 'department': return text('Department', '部署');
    case 'transactionDate': return text('Transaction date', '取引日');
    case 'payeeName': return text('Payee', '支払先');
    case 'amount': return text('Amount', '金額');
    case 'category': return text('Category', '費目');
    case 'purpose': return text('Purpose', '目的');
    case 'attendeeCount': return text('Attendees', '参加人数');
    case 'attendeeNames': return text('Attendee names', '参加者');
    case 'relation': return text('Relation', '関係');
    case 'unitCount': return text('Days / nights', '日数・泊数');
    case 'paymentMethod': return text('Payment method', '支払方法');
    case 'corporatePayment': return text('Paid by the company', '会社払い');
    case 'registrationNumber': return text('Registration number', '登録番号');
    case 'preApprovalRef': return text('Pre-approval ref', '事前承認番号');
    case 'description': return text('Description', '摘要');
    default: return field;
  }
}

/** 理由コードの短い名前（重さの表・承認できない理由の見出し）。 */
export function reasonTitle(code: ExpenseReasonCodeDto, text: Translate): string {
  return REASON_TEXT[code]({}, text).title;
}

/* ---------------------------------------------------------------------------
 * 理由の文言（§4 の「原因（画面）」「直し方（画面）」）
 * ------------------------------------------------------------------------- */

interface ReasonText { readonly title: string; readonly cause: string; readonly fix: string }
type ReasonTextBuilder = (params: Params, text: Translate) => ReasonText;

const weakNote = (p: Params, text: Translate): string => (p['weak'] === true
  ? text(' (the payee is empty, so only the date, amount, and category were compared)', '（支払先が空のため、取引日・金額・費目だけで照合しています）')
  : '');

/*
 * 実用化の 16 コード（§20.4）の注記。日本語はサーバーの `application/expense/reason-messages.ts` と同じ条件・同じ文で、
 * テストが一致を固定する。件数・日数・回数はサーバーが桁区切りをしない（`text()`）ので、ここも `plain` で出す。
 */

function plain(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function present(p: Params, key: string): boolean {
  const value = p[key];
  return value !== null && value !== undefined && value !== '';
}

export function advanceStatusLabel(status: string, text: Translate): string {
  switch (status) {
    case 'requested': return text('Requested', '申請中');
    case 'approved': return text('Approved', '承認済み');
    case 'paid': return text('Paid', '支払済み');
    case 'settling': return text('Settling', '精算中');
    case 'settled': return text('Settled', '精算済み');
    case 'cancelled': return text('Cancelled', '取消');
    default: return status;
  }
}

/** 承認者が決まらない原因（`approval-route-unresolved` の cause）→ 原因の文と直し方。 */
export function approvalCauseText(p: Params, text: Translate): { readonly causeText: string; readonly causeFix: string } {
  switch (p['cause']) {
    case 'manager-missing': return { causeText: text(`${num(p['claimant'])} has no manager set`, `${num(p['claimant'])} さんの上長が未設定です`), causeFix: text('Set the manager in the employee master', '従業員マスタで上長を設定してください') };
    case 'manager-disabled': return { causeText: text(`the manager ${num(p['manager'])} is disabled`, `上長 ${num(p['manager'])} さんが無効です`), causeFix: text('Set the manager again', '上長を設定し直してください') };
    case 'department-head-missing': return { causeText: text(`the department "${num(p['department'])}" and its parent departments have no head`, `部門「${num(p['department'])}」とその上位の部門に部門長がいません`), causeFix: text('Set a department head in the organization', '組織で部門長を設定してください') };
    case 'group-empty': return { causeText: text(`the approver group "${num(p['group'])}" has no enabled member`, `承認グループ「${num(p['group'])}」に有効なメンバーがいません`), causeFix: text('Add members in the organization', '組織でメンバーを足してください') };
    case 'employee-disabled': return { causeText: text(`the designated approver ${num(p['employee'])} is disabled`, `指定の承認者 ${num(p['employee'])} さんが無効です`), causeFix: text('Choose another approver in the approval routes of the policy', '規程の承認経路で承認者を選び直してください') };
    case 'only-claimant': return { causeText: text('the only approver is the claimant', '承認者が申請者本人しかいません'), causeFix: text('Add another approver, or review the approval routes of the policy', '別の承認者を足すか、規程の承認経路を見直してください') };
    case 'claimant-unlinked': return { causeText: text('the claimant is not linked to the employee master', '申請者が従業員マスタに紐付いていません'), causeFix: text('Choose the claimant from the employee master when editing the claim', '申請の編集で申請者を従業員マスタから選んでください') };
    default: return { causeText: text('the approver cannot be decided', '承認者を決められません'), causeFix: text('Check the employee master, the organization, and the approval routes of the policy', '従業員マスタ・組織・規程の承認経路を確認してください') };
  }
}

function fareTypeLabel(p: Params, text: Translate): string {
  const value = p['fareType'];
  return value === 'ic' ? 'IC' : value === 'ticket' ? text('ticket', '切符') : plain(value);
}

function cardMatchNote(p: Params, text: Translate): string {
  const weak = p['weak'] === true ? text(' (the merchant name differs, so only the date and amount were compared)', '（加盟店名が一致しないため、日付と金額だけで照合しています）') : '';
  const diff = p['dateDiffDays'];
  const shifted = typeof diff === 'number' && diff !== 0 ? text(` (${String(Math.abs(diff))} days from the usage date)`, `（利用日と ${String(Math.abs(diff))} 日ずれ）`) : '';
  return `${weak}${shifted}`;
}

const REASON_TEXT: Readonly<Record<ExpenseReasonCodeDto, ReasonTextBuilder>> = {
  'policy-unreviewed': (_p, text) => ({
    title: text('Policy not saved yet', '規程が未保存'),
    cause: text('The policy is still the initial template and has not been saved. Limits may differ from your company rules.', '規程が初期テンプレートのまま保存されていません。上限額などが自社の規程と違う可能性があります'),
    fix: text('Review the categories and limits in the Policy step, press "Save", then check again.', '規程ステップで費目と上限額を確認して「保存」を押し、もう一度チェックしてください'),
  }),
  'claimant-unlinked': (p, text) => ({
    title: text('Claimant not linked', '申請者が未紐付け'),
    cause: text(
      `The claimant "${num(p['claimant'])}" is not linked to anyone in the employee master${present(p, 'candidates') ? ` (employees with the same name: ${plain(p['candidates'])})` : ''}.`,
      `申請者「${num(p['claimant'])}」が従業員マスタの誰にも紐付いていません${present(p, 'candidates') ? `（同じ名前の従業員: ${plain(p['candidates'])}）` : ''}`,
    ),
    fix: text('Choose the claimant from the employee master when editing the claim. If they are not in the master, register the employee first. Approval routes, commuter pass deduction, and payout files only work for linked claimants.', '申請の編集で申請者を従業員マスタから選んでください。マスタに居なければ先に従業員を登録します。承認経路・定期区間の控除・振込データは、紐付いた申請者でしか使えません'),
  }),
  'claimant-employee-disabled': (p, text) => ({
    title: text('Claimant disabled in the employee master', '申請者が無効'),
    cause: p['missing'] === true
      ? text(`The claimant "${num(p['claimant'])}" was not found in the employee master (the data may have been deleted).`, `申請者「${num(p['claimant'])}」は従業員マスタで見つかりません（削除されたデータの可能性があります）`)
      : text(`The claimant "${num(p['claimant'])}" is disabled in the employee master.`, `申請者「${num(p['claimant'])}」は従業員マスタで無効になっています`),
    fix: text('If it is their own expense from before leaving or moving, mark it as reviewed. If it is someone else, choose the claimant again.', '退職・異動の前の支出で本人の申請なら確認済みにしてください。別の人なら申請者を選び直してください'),
  }),
  'advance-employee-mismatch': (p, text) => ({
    title: text('Advance of another person', '他人の仮払'),
    cause: text(`The linked advance ${num(p['advanceId'])} (${num(p['advanceEmployee'])}) does not belong to the claimant of this claim.`, `紐付けた仮払 ${num(p['advanceId'])}（${num(p['advanceEmployee'])} さん）は、この申請の申請者のものではありません`),
    fix: text('Choose the right advance, or unlink the advance.', '正しい仮払を選び直すか、仮払の紐付けを外してください'),
  }),
  'advance-not-paid': (p, text) => ({
    title: text('Advance not paid yet', '仮払が未払い'),
    cause: text(`The linked advance ${num(p['advanceId'])} has not been paid yet (status: ${advanceStatusLabel(plain(p['advanceStatus']), text)}).`, `紐付けた仮払 ${num(p['advanceId'])} はまだ支払済みではありません（状態: ${advanceStatusLabel(plain(p['advanceStatus']), text)}）`),
    fix: text('If you handed over the advance, press "Mark as paid" in the advance ledger. If not, unlink it and settle as a normal reimbursement.', '仮払を渡したなら仮払台帳で「支払済みにする」を押してください。渡していなければ紐付けを外して通常の立替精算にします'),
  }),
  'advance-already-settled': (p, text) => ({
    title: text('Advance already settled', '仮払が精算済み'),
    cause: text(`The linked advance ${num(p['advanceId'])} was settled on ${num(p['settledOn'])}.`, `紐付けた仮払 ${num(p['advanceId'])} は ${num(p['settledOn'])} に精算済みです`),
    fix: text('Link another advance, or unlink it and settle as a normal reimbursement.', '別の仮払に紐付けるか、紐付けを外して通常の立替精算にしてください'),
  }),
  'approval-route-unresolved': (p, text) => {
    const { causeText, causeFix } = approvalCauseText(p, text);
    return {
      title: text('Approver not decided', '承認者が決まらない'),
      cause: text(`The approver of step "${num(p['stepName'])}" in the approval route "${num(p['routeName'])}" cannot be decided (${causeText}).`, `承認経路「${num(p['routeName'])}」の段「${num(p['stepName'])}」の承認者が決まりません（${causeText}）`),
      fix: text(`${causeFix}. This claim cannot be approved until it is fixed.`, `${causeFix}。直すまでこの申請は承認できません`),
    };
  },
  'claim-empty': (_p, text) => ({
    title: text('No items', '明細なし'),
    cause: text('This claim has no items.', 'この申請には明細がありません'),
    fix: text('Add a receipt or an item in the Ingest step.', '取込ステップで領収書か明細を追加してください'),
  }),
  'category-missing': (p, text) => ({
    title: text('Category not decided', '費目が未決定'),
    cause: text(`No category is set (no category matches the imported value "${num(p['categoryText'])}").`, `費目が決まっていません（取込時の値「${num(p['categoryText'])}」に一致する費目がありません）`),
    fix: text(`Choose the category for the item. If people always write it this way, add "${num(p['categoryText'])}" to the category's aliases in the policy so it matches next time.`, `明細の費目を選んでください。いつも同じ書き方なら、規程の費目の「別名」に「${num(p['categoryText'])}」を足すと次から自動で当たります`),
  }),
  'category-unknown': (p, text) => ({
    title: text('Unknown category', '規程に無い費目'),
    cause: text(`The category "${num(p['categoryId'])}" is not in the policy or is disabled.`, `費目「${num(p['categoryId'])}」が規程に無いか、無効になっています`),
    fix: text('Choose another category, or enable that category again in the policy.', '別の費目を選び直すか、規程でその費目を有効に戻してください'),
  }),
  'amount-missing': (_p, text) => ({
    title: text('Amount missing', '金額なし'),
    cause: text('There is no amount (zero or less counts as missing). The e-bookkeeping search key "amount" is not satisfied.', '金額がありません（0 円以下も含む）。電子帳簿保存法の検索要件「取引金額」を満たしません'),
    fix: text('Look at the receipt and enter the tax-inclusive amount paid.', '領収書を見て税込の支払額を入力してください'),
  }),
  'date-missing': (p, text) => {
    const hasIssue = p['issueDate'] !== null && p['issueDate'] !== undefined;
    return {
      title: text('Transaction date missing', '取引日なし'),
      cause: text(`There is no transaction date${hasIssue ? ` (the issue date ${num(p['issueDate'])} exists)` : ''}. The e-bookkeeping search key "date" is not satisfied.`, `取引日がありません${hasIssue ? `（発行日 ${num(p['issueDate'])} はあります）` : ''}。電子帳簿保存法の検索要件「取引年月日」を満たしません`),
      fix: text('Enter the transaction date from the receipt. If it equals the issue date, press "Use the issue date as the transaction date".', '領収書の取引日を入力してください。発行日と同じなら「発行日を取引日にする」を押してください'),
    };
  },
  'payee-missing': (p, text) => ({
    title: text('Payee missing', '支払先なし'),
    cause: text(`There is no payee (shop or business name). The e-bookkeeping search key "counterparty" is not satisfied.${p['readerHint'] === true ? ' (Reading an expense report or slip often leaves the payee empty, so check the original receipt.)' : ''}`, `支払先（店名・事業者名）がありません。電子帳簿保存法の検索要件「取引先」を満たしません${p['readerHint'] === true ? '（精算書・伝票の読取では支払先が空になりやすいため、元の領収書を確認してください）' : ''}`),
    fix: text('Enter the issuer name on the receipt (including the shop or branch).', '領収書の発行者名（店舗名・支店名まで）を入力してください'),
  }),
  'purpose-missing': (p, text) => ({
    title: text('Purpose missing', '目的なし'),
    cause: text(`The category "${num(p['category'])}" requires a purpose, but it is empty.`, `費目「${num(p['category'])}」は目的の記入が必要ですが、空欄です`),
    fix: text('Enter who the expense was with and what it was for.', '誰と・何のための支出かを入力してください'),
  }),
  'receipt-missing': (p, text) => {
    const exempt = p['exemptBelow'] !== null && p['exemptBelow'] !== undefined;
    return {
      title: text('Receipt missing', '領収書なし'),
      cause: exempt
        ? text(`The category "${num(p['category'])}" requires a receipt from ¥${num(p['exemptBelow'])}, but none is attached.`, `費目「${num(p['category'])}」は ${num(p['exemptBelow'])} 円以上で領収書が必要ですが、添付がありません`)
        : text(`The category "${num(p['category'])}" requires a receipt, but none is attached.`, `費目「${num(p['category'])}」は領収書が必要ですが、添付がありません`),
      fix: text('Attach the receipt image. If this category is paid without receipts (IC cards, etc.), review "receipt required" for the category in the policy.', '領収書の画像を添付してください。領収書が出ない支払い（IC カードなど）の費目なら、規程の費目で「領収書の要否」を見直してください'),
    };
  },
  'receipt-extraction-warning': (p, text) => ({
    title: text('Reading warnings', '読取の注意点'),
    cause: text(`The reading has warnings: ${num(p['warnings'])}`, `読み取りに注意点があります: ${num(p['warnings'])}`),
    fix: text('Compare with the receipt image and confirm the amount, date, and registration number. Values were not corrected automatically.', '領収書の画像と見比べて、金額・日付・登録番号が正しいか確かめてください。値は自動で直していません'),
  }),
  'receipt-amount-mismatch': (p, text) => ({
    title: text('Amount and breakdown differ', '金額と内訳が不一致'),
    cause: text(`The per-rate breakdown sums to ¥${num(p['sum'])}, which is ¥${num(p['diff'])} off the amount ¥${num(p['amount'])} (tolerance ¥${num(p['tolerance'])}).`, `税率別の内訳の合計 ${num(p['sum'])} 円が金額 ${num(p['amount'])} 円と ${num(p['diff'])} 円ずれています（許容 ${num(p['tolerance'])} 円）`),
    fix: text('One of them was misread or mistyped. Check the receipt and correct the wrong one.', 'どちらかの読み取り・入力の誤りです。領収書を見て正しい方に直してください'),
  }),
  'date-substituted-by-issue-date': (p, text) => ({
    title: text('Issue date used as the date', '発行日で代用した取引日'),
    cause: text(`The transaction date ${num(p['date'])} is the issue date, used because the reading found no usage date.`, `取引日 ${num(p['date'])} は、読取で利用日が見つからず発行日を使った値です`),
    fix: text('Compare with the usage date on the receipt. If it differs, fix the date; if it is the same, confirm the date field and save to clear this. Values were not corrected automatically.', '領収書の利用日と見比べてください。違えば取引日を直し、同じなら取引日欄を確認して保存すると消えます。値は自動で直していません'),
  }),
  'receipt-reads-disagree': (p, text) => ({
    title: text('Two readings disagree', '読取の食い違い'),
    cause: text(`The two readings disagree: ${plain(p['disagreements'])}`, `2 回の読取で値が食い違っています: ${plain(p['disagreements'])}`),
    fix: text('Look at the receipt and enter the right value. Neither value was adopted automatically.', '領収書を見て正しい値を入力してください。どちらの値も自動では採用していません'),
  }),
  'read-values-unconfirmed': (p, text) => ({
    title: text('Read values not confirmed', '読取値が未確認'),
    cause: text(`${plain(p['fields'])}: still the candidates filled in by the reading, not confirmed by a person.`, `${plain(p['fields'])}は読取で入れた候補のままで、人が確認していません`),
    fix: text('Check the receipt and the claimant\'s explanation; if they are right, confirm the field and save (saving clears this).', '領収書と申請者の説明を確かめ、正しければその欄を確認して保存してください（保存すると消えます）'),
  }),
  'date-in-future': (p, text) => ({
    title: text('Date in the future', '未来の日付'),
    cause: text(`The transaction date ${num(p['date'])} is after today.`, `取引日 ${num(p['date'])} が今日より後です`),
    fix: text('Check the date input (a mistyped year or a Japanese era conversion).', '取引日の入力（年の打ち間違い・和暦の換算）を確認してください'),
  }),
  'date-outside-period': (p, text) => ({
    title: text('Outside the claim period', '申請期間の外'),
    cause: text(`The transaction date ${num(p['date'])} is outside the claim period ${num(p['from'])} to ${num(p['to'])}.`, `取引日 ${num(p['date'])} が申請期間 ${num(p['from'])}〜${num(p['to'])} の外です`),
    fix: text('Fix the claim period, or move this item to the claim for that period.', '申請期間を直すか、この明細を該当期間の申請へ移してください'),
  }),
  'submission-late': (p, text) => ({
    title: text('Submitted late', '提出期限切れ'),
    cause: text(`${num(p['days'])} days passed between the transaction date ${num(p['date'])} and the import (policy deadline: ${num(p['limitDays'])} days).`, `取引日 ${num(p['date'])} から取込まで ${num(p['days'])} 日経っています（規程の期限 ${num(p['limitDays'])} 日）`),
    fix: text('Check why it is late, and mark it as reviewed if you accept it.', '遅れの理由を確認し、認めるなら確認済みにしてください'),
  }),
  'payment-not-reimbursable': (p, text) => ({
    title: text('Payment not reimbursable', '立替精算の対象外'),
    cause: text(`The payment method "${paymentMethodLabel(num(p['paymentMethod']), text)}" is not reimbursable (company cards are booked from the company's statement, so it would be booked twice).`, `支払方法「${paymentMethodLabel(num(p['paymentMethod']), text)}」は立替精算の対象外です（会社のカード等は会社側の明細から計上されるため二重計上になります）`),
    fix: text('Check the payment method; if the company paid, delete this item.', '支払方法の入力を確認し、会社払いならこの明細を削除してください'),
  }),
  'registration-number-missing': (p, text) => {
    const hasRaw = p['raw'] !== null && p['raw'] !== undefined;
    const hasDate = p['date'] !== null && p['date'] !== undefined;
    const rawNoteEn = hasRaw ? ` (the read value "${num(p['raw'])}" has ${num(p['digits'])} digits, so it was not used)` : '';
    const rawNoteJa = hasRaw ? `（読み取った「${num(p['raw'])}」は数字 ${num(p['digits'])} 桁のため採用していません）` : '';
    return {
      title: text('Registration number missing', '登録番号なし'),
      cause: text(
        `There is no registration number (T + 13 digits)${rawNoteEn}. Unless it is a qualified invoice, the input tax credit ${hasDate ? `follows the transitional measure at ${num(p['date'])} (${num(p['deductionRate'])}%)` : 'rate cannot be decided because there is no transaction date'}.`,
        `登録番号（T + 13 桁）がありません${rawNoteJa}。適格請求書でなければ、仕入税額控除は${hasDate ? `取引日 ${num(p['date'])} 時点の経過措置（${num(p['deductionRate'])}%）になります` : '取引日が無いため経過措置の割合は決まりません'}`,
      ),
      fix: text('Enter the registration number if the receipt has one. If not, confirm the payee is tax-exempt and mark it as reviewed. For categories that need no number (public transport under ¥30,000, etc.), review the category settings in the policy.', '領収書に登録番号があれば入力してください。無ければ相手が免税事業者か確認して確認済みにしてください。登録番号の要らない費目（3 万円未満の公共交通機関など）なら規程の費目で設定を見直してください'),
    };
  },
  'route-missing': (p, text) => ({
    title: text('Route missing', '区間なし'),
    cause: text(`The category "${num(p['category'])}" requires a route (departure and arrival stations), but ${plain(p['missing'])} is missing.`, `費目「${num(p['category'])}」は区間（出発駅・到着駅）の記入が必要ですが、${plain(p['missing'])}がありません`),
    fix: text('Enter the departure and arrival stations (add stops in order if any). For a round trip, set the trip count to 2.', '出発駅と到着駅を入力してください（経由があれば順に足します）。往復なら回数を 2 にします'),
  }),
  'commuter-pass-overlap': (p, text) => ({
    title: text('Within the commuter pass', '通勤定期の範囲内'),
    cause: text(
      `The route ${plain(p['route'])} is within ${num(p['claimant'])}'s commuter pass (${plain(p['passRoute'])}${present(p, 'validTo') ? `, until ${plain(p['validTo'])}` : ''}).`,
      `区間 ${plain(p['route'])} は ${num(p['claimant'])} さんの通勤定期（${plain(p['passRoute'])}${present(p, 'validTo') ? `、${plain(p['validTo'])} まで` : ''}）の範囲内です`,
    ),
    fix: text('Travel covered by the commuter pass cannot be reimbursed. If the trip went outside the pass, fix the route. If the pass route is outdated, update it in the employee master.', '定期で乗れる区間は精算できません。定期の範囲外の移動なら区間を直してください。定期の区間が古ければ従業員マスタで更新してください'),
  }),
  'commuter-pass-partial-overlap': (p, text) => {
    const suggest = present(p, 'restRoute') && present(p, 'suggestedAmount');
    return {
      title: text('Partly within the commuter pass', '通勤定期と一部重複'),
      cause: text(
        `${plain(p['overlapFrom'])} to ${plain(p['overlapTo'])} of the route ${plain(p['route'])} overlaps the commuter pass${suggest ? ` (the fare table has ¥${num(p['suggestedAmount'])} for ${plain(p['restRoute'])} outside the pass)` : ''}.`,
        `区間 ${plain(p['route'])} のうち ${plain(p['overlapFrom'])}〜${plain(p['overlapTo'])} が通勤定期と重なります${suggest ? `（運賃マスタでは定期の外の ${plain(p['restRoute'])} が ${num(p['suggestedAmount'])} 円です）` : ''}`,
      ),
      fix: text('Change the amount to exclude the part covered by the pass, or, if the route was unavoidable, check the reason and mark it as reviewed. The amount was not corrected automatically.', '定期で乗れる部分を除いた金額に直すか、経路上やむを得なければ理由を確かめて確認済みにしてください。金額は自動で直していません'),
    };
  },
  'fare-exceeds-table': (p, text) => {
    const count = p['candidateCount'];
    const many = typeof count === 'number' && count >= 2;
    return {
      title: text('Over the registered fare', '運賃マスタより高い'),
      cause: text(
        `The amount ¥${num(p['amount'])} exceeds ¥${num(p['fare'])} × ${plain(p['trips'])} trips = ¥${num(p['expected'])} for ${plain(p['route'])} (${fareTypeLabel(p, text)}) in the fare table by ¥${num(p['over'])} (tolerance ¥${num(p['tolerance'])}${many ? `; compared with the highest of ${plain(count)} fares registered for the route` : ''}).`,
        `金額 ${num(p['amount'])} 円が運賃マスタの ${plain(p['route'])}（${fareTypeLabel(p, text)}）${num(p['fare'])} 円 × ${plain(p['trips'])} 回 = ${num(p['expected'])} 円を ${num(p['over'])} 円超えています（許容 ${num(p['tolerance'])} 円${many ? `、同じ区間の登録 ${plain(count)} 件のうち最も高い運賃で比べています` : ''}）`,
      ),
      fix: text('Check the trip count (2 for a round trip) and IC card vs. ticket. If the fare changed, fix the fare table.', '回数（往復なら 2）と IC / 切符の別を確認してください。運賃が改定されていれば運賃マスタを直してください'),
    };
  },
  'fare-route-unknown': (p, text) => ({
    title: text('Route not in the fare table', '運賃マスタに無い区間'),
    cause: text(`The route ${plain(p['route'])} (${fareTypeLabel(p, text)}) is not registered in the fare table.`, `区間 ${plain(p['route'])}（${fareTypeLabel(p, text)}）は運賃マスタに登録がありません`),
    fix: text('Check the fare and register it in the fare table so it is compared next time. For a one-off route, mark it as reviewed.', '運賃を確かめて運賃マスタに登録すると、次から照合されます。一度きりの経路なら確認済みにしてください'),
  }),
  'per-item-limit-exceeded': (p, text) => ({
    title: text('Over the per-item limit', '1 件上限を超過'),
    cause: text(`It exceeds the per-item limit ¥${num(p['limit'])} of "${num(p['category'])}" by ¥${num(p['over'])} (¥${num(p['amount'])}).`, `費目「${num(p['category'])}」の 1 件上限 ${num(p['limit'])} 円を ${num(p['over'])} 円超えています（${num(p['amount'])} 円）`),
    fix: text('Check that the policy limit is right. If you allow exceptions, change the severity to "needs review" or handle it with a pre-approval rule.', '規程の上限が正しいか確認してください。例外として認める運用なら、重さを「要確認」に変えるか事前承認条件で扱ってください'),
  }),
  'attendees-missing': (p, text) => ({
    title: text('Attendees missing', '参加人数なし'),
    cause: text(`The category "${num(p['category'])}" requires the number of attendees, but it is empty.`, `費目「${num(p['category'])}」は参加人数の記入が必要ですが、空欄です`),
    fix: text('Enter the number of attendees (whether the claimant is included follows the claim rules).', '参加人数を入力してください（申請者を含めるかは規程の申請ルールに従う）'),
  }),
  'per-person-limit-exceeded': (p, text) => {
    const excluded = p['basis'] === 'tax-excluded';
    return {
      title: text('Over the per-person limit', '1 人あたり基準を超過'),
      cause: text(
        `¥${num(p['perPerson'])} per person (${excluded ? 'tax excluded' : 'tax included'}, ${num(p['count'])} people) exceeds the ¥${num(p['limit'])} limit of "${num(p['category'])}"${p['basisFallback'] === true ? ' (judged tax-included because there is no per-rate breakdown)' : ''}.`,
        `1 人あたり ${num(p['perPerson'])} 円（${excluded ? '税抜' : '税込'}、${num(p['count'])} 人）が費目「${num(p['category'])}」の基準 ${num(p['limit'])} 円を超えています${p['basisFallback'] === true ? '（税率別の内訳が無く税抜にできないため、税込で判定しました）' : ''}`,
      ),
      fix: text('Check the number of attendees. Meals over the limit become entertainment expenses, so check whether the category should change.', '人数の入力を確認してください。基準を超える飲食費は交際費になるため、費目を変える必要がないか確認してください'),
    };
  },
  'attendee-details-missing': (p, text) => {
    const partsEn = [p['missingNames'] === true ? 'attendee names' : '', p['missingRelation'] === true ? 'the relation' : ''].filter((part) => part !== '');
    const partsJa = [p['missingNames'] === true ? '参加者の氏名' : '', p['missingRelation'] === true ? '関係' : ''].filter((part) => part !== '');
    return {
      title: text('Attendee details missing', '参加者の記入なし'),
      cause: text(`The category "${num(p['category'])}" requires attendee names (companies) and the relation, but ${partsEn.join(' and ') || 'they are'} missing.`, `費目「${num(p['category'])}」は参加者の氏名（社名）と関係の記入が必要ですが、${partsJa.join('と')}がありません`),
      fix: text('Enter the attendee names or companies and their relation to you (client, internal, etc.).', '参加者の氏名または社名と、自社との関係（取引先・社内など）を入力してください'),
    };
  },
  'unit-count-missing': (p, text) => ({
    title: text('Day / night count missing', '日数・泊数なし'),
    cause: text(`The category "${num(p['category'])}" requires the number of ${num(p['unitLabel'])}, but it is empty.`, `費目「${num(p['category'])}」は${num(p['unitLabel'])}数の記入が必要ですが、空欄です`),
    fix: text(`Enter the number of ${num(p['unitLabel'])}.`, `${num(p['unitLabel'])}数を入力してください`),
  }),
  'per-unit-limit-exceeded': (p, text) => ({
    title: text('Over the per-day / per-night limit', '1 日・1 泊あたり上限を超過'),
    cause: text(`¥${num(p['perUnit'])} per ${num(p['unitLabel'])} exceeds the limit ¥${num(p['limit'])} (¥${num(p['amount'])} / ${num(p['unitCount'])} ${num(p['unitLabel'])}).`, `1 ${num(p['unitLabel'])}あたり ${num(p['perUnit'])} 円が上限 ${num(p['limit'])} 円を超えています（${num(p['amount'])} 円 / ${num(p['unitCount'])} ${num(p['unitLabel'])}）`),
    fix: text(`Check the number of ${num(p['unitLabel'])} and the policy limit.`, `${num(p['unitLabel'])}数の入力と規程の上限を確認してください`),
  }),
  'pre-approval-missing': (p, text) => ({
    title: text('Pre-approval missing', '事前承認なし'),
    cause: text(`It matches the pre-approval rule "${num(p['ruleName'])}", but there is no pre-approval number or record.`, `事前承認の条件「${num(p['ruleName'])}」に当たりますが、事前承認の番号・記録がありません`),
    fix: text('Enter the pre-approval number (such as a ringi number). If the rule is too broad, review the pre-approval rules in the policy.', '事前承認の番号（稟議番号など）を入力してください。条件が広すぎるなら規程の事前承認条件を見直してください'),
  }),
  'duplicate-in-claim': (p, text) => ({
    title: text('Duplicate in this claim', '申請内の重複'),
    cause: text(`It has the same payee, date, and amount as the item "${num(p['otherDescription'])}" in this claim${weakNote(p, text)}.`, `この申請の明細「${num(p['otherDescription'])}」と支払先・取引日・金額が同じです${weakNote(p, text)}`),
    fix: text('Check whether the same receipt was imported twice, and delete one if so.', '同じ領収書を 2 回取り込んでいないか確認し、重複ならどちらかを削除してください'),
  }),
  'duplicate-across-claims': (p, text) => ({
    title: text('Duplicate of another claim', '他の申請と重複'),
    cause: text(`It has the same payee, date, and amount as an item in ${num(p['claimantName'])}'s claim ${num(p['otherClaimId'])} (${claimStatusLabel(num(p['otherStatus']), text)})${weakNote(p, text)}.`, `${num(p['claimantName'])} さんの申請 ${num(p['otherClaimId'])}（${claimStatusLabel(num(p['otherStatus']), text)}）の明細と支払先・取引日・金額が同じです${weakNote(p, text)}`),
    fix: text('Open the other claim and check that the same expense has not already been reimbursed. If it is a different expense, mark it as reviewed.', '相手の申請を開き、同じ支出が既に精算されていないか確認してください。別の支出なら確認済みにしてください'),
  }),
  'duplicate-receipt-image': (p, text) => ({
    title: text('Same receipt image', '同じ領収書画像'),
    cause: text(`The attached image is the same file as an item image in claim ${num(p['otherClaimId'])}.`, `添付の画像が申請 ${num(p['otherClaimId'])} の明細の画像と同じファイルです`),
    fix: text('Check that the same receipt is not used for another item or claim.', '同じ領収書を別の明細・別の申請で使っていないか確認してください'),
  }),
  'card-charge-claimed': (p, text) => ({
    title: text('Paid with a corporate card', '法人カードの利用と一致'),
    cause: text(
      `It matches the ¥${num(p['cardAmount'])} charge at ${plain(p['merchant'])} on ${plain(p['usedOn'])} on the corporate card "${plain(p['cardLabel'])}"${cardMatchNote(p, text)}. Reimbursing it would pay twice.`,
      `法人カード「${plain(p['cardLabel'])}」の ${plain(p['usedOn'])} ${plain(p['merchant'])} ${num(p['cardAmount'])} 円の利用と一致します${cardMatchNote(p, text)}。立替として精算すると二重払いになります`,
    ),
    fix: text('If it was paid with the corporate card, delete this item or set the payment method to "paid by the company". If it is a different expense, mark it as reviewed.', '法人カードで払った支出なら、この明細を削除するか支払方法を「会社払い」にしてください。別の支出なら確認済みにしてください'),
  }),
  'corporate-payment-unmatched': (p, text) => ({
    title: text('No matching card transaction', 'カード明細と照合できない'),
    cause: text(`The item is paid by the company, but no matching charge is in the imported corporate card statements (${plain(p['coverage'])}).`, `会社払いの明細ですが、取り込んだ法人カード明細（${plain(p['coverage'])}）に一致する利用がありません`),
    fix: text('Check for a missing statement import, a mistyped amount or date, or a charge on another card. You can also link it by hand in the card ledger.', 'カード明細の取込漏れ・金額や日付の入力誤り・別のカードの利用でないか確かめてください。カード台帳から手動で紐付けることもできます'),
  }),
  'per-claim-limit-exceeded': (p, text) => ({
    title: text('Over the per-claim limit', '1 申請の上限を超過'),
    cause: text(`The total ¥${num(p['total'])} of "${num(p['category'])}" in this claim exceeds the limit ¥${num(p['limit'])} by ¥${num(p['over'])}.`, `費目「${num(p['category'])}」の申請内合計 ${num(p['total'])} 円が上限 ${num(p['limit'])} 円を ${num(p['over'])} 円超えています`),
    fix: text('Check that the policy limit is right; if it is, return the claim to the claimant.', '規程の上限が正しいか確認し、正しければ申請者へ差し戻してください'),
  }),
};

export interface ReasonSummary {
  readonly code: ExpenseReasonCodeDto;
  readonly severity: ExpenseSeverityDto;
  readonly itemId?: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly fixTargets: readonly ExpenseFixTargetDto[];
}

/** 理由 1 件を「原因 → 直し方 → 導線」にする。 */
export function summarizeCheck(reason: Pick<ExpenseCheckReasonDto, 'code' | 'severity' | 'params'> & { readonly itemId?: string }, text: Translate): ReasonSummary {
  const built = REASON_TEXT[reason.code](reason.params, text);
  return {
    code: reason.code, severity: reason.severity, ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }),
    title: built.title, cause: built.cause, fix: built.fix, fixTargets: EXPENSE_REASON_FIX_TARGETS[reason.code],
  };
}

/* ---------------------------------------------------------------------------
 * 導線（OpenTarget）
 * ------------------------------------------------------------------------- */

export interface FixContext {
  readonly claimId: string;
  readonly itemId?: string;
  /** 明細の費目（理由の params に無いときの費目の行）。 */
  readonly categoryId?: string;
  readonly code: ExpenseReasonCodeDto;
  readonly params: Params;
}

function stringParam(params: Params, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 導線先 → 経費画面の OpenTarget。section は `claim` / `item:<itemId>` / `receipt:<itemId>` / `category` / `rules` / `pre-approval`
 * に加え、規程の保存ボタン `save` と仕訳設定 `journal`（どちらも規程タブ）。`nodeId` はフォーカスする明細の欄。
 *
 * 実用化（§20.4）の section: 申請の `claimant` / `advance-link` / `item-route:<itemId>`（取込タブ）、規程の `approval`、
 * 台帳の `employee` / `employee-commuter` / `organization` / `advance` / `card` / `cards` / `fares`。
 * 台帳の行の id は、系統の contributor が params に入れた `employeeId` / `departmentId` / `groupId` / `routeId` / `advanceId` /
 * `cardTransactionId` を使う（無ければ一覧を開く。文言の差し込み値とは別の、導線だけのための値）。
 */
export function openTargetForFix(fixTarget: ExpenseFixTargetDto, context: FixContext): OpenTarget {
  const { claimId, params, code } = context;
  switch (fixTarget) {
    case 'item': {
      // 申請内の重複は相手の明細を開く（どちらを消すかを見比べるため）。
      const itemId = code === 'duplicate-in-claim' ? (stringParam(params, 'otherItemId') ?? context.itemId) : context.itemId;
      const field = REASON_ITEM_FIELD[code];
      return { internalId: claimId, section: `item:${itemId ?? ''}`, ...(field === undefined ? {} : { nodeId: field }) };
    }
    case 'item-category': return { internalId: claimId, section: `item:${context.itemId ?? ''}`, nodeId: 'categoryId' };
    case 'receipt': return { internalId: claimId, section: `receipt:${context.itemId ?? ''}` };
    case 'policy-category': return { internalId: stringParam(params, 'categoryId') ?? context.categoryId ?? '', section: 'category' };
    case 'policy-rules': return { internalId: '', section: 'rules' };
    case 'policy-pre-approval': return { internalId: stringParam(params, 'ruleId') ?? '', section: 'pre-approval' };
    case 'policy-save': return { internalId: '', section: 'save' };
    case 'other-claim': return { internalId: stringParam(params, 'otherClaimId') ?? '', section: 'claim' };
    case 'claim-claimant': return { internalId: claimId, section: 'claimant' };
    case 'claim-advance': return { internalId: claimId, section: 'advance-link' };
    case 'item-route': return { internalId: claimId, section: `item-route:${context.itemId ?? ''}` };
    case 'employee': return { internalId: stringParam(params, 'employeeId') ?? '', section: 'employee' };
    case 'employee-commuter': return { internalId: stringParam(params, 'employeeId') ?? '', section: 'employee-commuter' };
    case 'organization': return { internalId: stringParam(params, 'departmentId') ?? stringParam(params, 'groupId') ?? '', section: 'organization' };
    case 'policy-approval': return { internalId: stringParam(params, 'routeId') ?? '', section: 'approval' };
    case 'advance': return { internalId: stringParam(params, 'advanceId') ?? '', section: 'advance' };
    case 'card-transaction': return { internalId: stringParam(params, 'cardTransactionId') ?? '', section: 'card' };
    case 'card-transactions': return { internalId: '', section: 'cards' };
    case 'fare-table': return { internalId: '', section: 'fares' };
  }
}

export function fixTargetLabel(fixTarget: ExpenseFixTargetDto, code: ExpenseReasonCodeDto, text: Translate): string {
  switch (fixTarget) {
    case 'item': return itemFieldActionLabel(code === 'duplicate-in-claim' ? undefined : REASON_ITEM_FIELD[code], code, text);
    case 'item-category': return text('Choose the category', '費目を選ぶ');
    // 読取の食い違い・発行日の代用は、入力欄と領収書を並べて見比べるのが直し方（§20.4.2）。
    case 'receipt': return code === 'date-substituted-by-issue-date' || code === 'receipt-reads-disagree' ? text('Open beside the receipt', '領収書と並べて開く') : text('View the receipt', '領収書を見る');
    case 'policy-category': return text('Open the policy category', '規程の費目を開く');
    case 'policy-rules': return text('Open the claim rules', '規程の申請ルールを開く');
    case 'policy-pre-approval': return text('Open the pre-approval rules', '事前承認条件を開く');
    case 'policy-save': return text('Open the policy', '規程を開く');
    case 'other-claim': return text('Open the other claim', '相手の申請を開く');
    case 'claim-claimant': return text('Choose the claimant', '申請者を選ぶ');
    case 'claim-advance': return text('Open the advance link', '仮払の紐付けを開く');
    case 'item-route': return text('Enter the route', '区間を入力');
    case 'employee': return code === 'claimant-unlinked' ? text('Open the employee master', '従業員マスタを開く') : text('Open the employee', '従業員を開く');
    case 'employee-commuter': return text('Open the commuter pass', '定期区間を開く');
    case 'organization': return text('Open the organization', '組織を開く');
    case 'policy-approval': return text('Open the approval routes', '承認経路を開く');
    case 'advance': return text('Open the advance', '仮払を開く');
    case 'card-transaction': return text('Open the card transaction', 'カード明細を開く');
    case 'card-transactions': return text('Open unmatched card transactions', 'カード明細を開く');
    case 'fare-table': return text('Open the fare table', '運賃マスタを開く');
  }
}

function itemFieldActionLabel(field: ItemField | undefined, code: ExpenseReasonCodeDto, text: Translate): string {
  switch (field) {
    case 'amount': return text('Enter the amount', '金額を入力');
    case 'transactionDate': return text('Enter the transaction date', '取引日を入力');
    case 'payeeName': return text('Enter the payee', '支払先を入力');
    case 'purpose': return text('Enter the purpose', '目的を入力');
    case 'receipt': return text('Attach an image', '画像を添付');
    case 'period': return text('Edit the claim period', '申請の期間を編集');
    case 'paymentMethod': return text('Enter the payment method', '支払方法を入力');
    case 'registrationNumber': return text('Enter the registration number', '登録番号を入力');
    case 'attendeesCount': return text('Enter the attendees', '参加人数を入力');
    case 'attendeeNames': return text('Enter the attendee names', '参加者を入力');
    case 'unitCount': return text('Enter the day / night count', '日数・泊数を入力');
    case 'preApprovalRef': return text('Enter the pre-approval number', '事前承認番号を入力');
    case 'route': return text('Enter the route', '区間を入力');
    default: return code === 'claim-empty' ? text('Open Ingest', '取込を開く') : code === 'duplicate-in-claim' ? text('Open the other item', '相手の明細を開く') : text('Open the item', '明細を開く');
  }
}

export type ExpenseFocusSection =
  | 'claim' | 'item' | 'receipt' | 'category' | 'rules' | 'pre-approval' | 'save' | 'journal'
  | 'claimant' | 'advance-link' | 'item-route' | 'approval'
  | 'employee' | 'employee-commuter' | 'organization' | 'advance' | 'card' | 'cards' | 'fares';

export interface ExpenseFocus {
  readonly tab: ExpenseTab;
  readonly section: ExpenseFocusSection;
  /** 申請 id（claim / item / receipt / claimant / advance-link / item-route）、規程の中の id（category / pre-approval / approval）、台帳の行の id。 */
  readonly id: string;
  readonly itemId?: string;
  readonly field?: string;
}

/** 他画面・理由カードからの OpenTarget → 開くタブと対象。未知の section は undefined。 */
export function parseExpenseTarget(target: OpenTarget): ExpenseFocus | undefined {
  const section = target.section ?? '';
  if (section.startsWith('item:')) {
    const itemId = section.slice('item:'.length);
    return { tab: 'ingest', section: 'item', id: target.internalId, ...(itemId === '' ? {} : { itemId }), ...(target.nodeId === undefined ? {} : { field: target.nodeId }) };
  }
  if (section.startsWith('item-route:')) {
    const itemId = section.slice('item-route:'.length);
    return { tab: 'ingest', section: 'item-route', id: target.internalId, ...(itemId === '' ? {} : { itemId }), field: 'route' };
  }
  if (section.startsWith('receipt:')) {
    const itemId = section.slice('receipt:'.length);
    return { tab: 'check', section: 'receipt', id: target.internalId, ...(itemId === '' ? {} : { itemId }) };
  }
  switch (section) {
    case 'claim': return { tab: 'check', section: 'claim', id: target.internalId };
    case 'category': case 'rules': case 'pre-approval': case 'save': case 'journal': case 'approval':
      return { tab: 'policy', section, id: target.internalId };
    case 'claimant': case 'advance-link': return { tab: 'ingest', section, id: target.internalId };
    case 'employee': case 'employee-commuter': case 'organization': return { tab: 'employees', section, id: target.internalId };
    case 'advance': return { tab: 'advances', section, id: target.internalId };
    case 'card': case 'cards': return { tab: 'cards', section, id: target.internalId };
    case 'fares': return { tab: 'fares', section, id: target.internalId };
    default: return undefined;
  }
}

/** 開いた対象で「選んでいる申請」を切り替えるタブか（台帳の行 id や規程の id を申請 id と取り違えないため）。 */
export function focusSelectsClaim(focus: Pick<ExpenseFocus, 'tab' | 'id'>): boolean {
  return (focus.tab === 'ingest' || focus.tab === 'check' || focus.tab === 'approve') && focus.id !== '';
}

/** 仕訳連携の問題 1 件の導線。`journal-chart` だけは仕訳画面へ出る。 */
export function journalProblemTarget(problem: ExpenseJournalLinkProblemDto, claimId: string): { readonly screen: 'Expense' | 'Journal'; readonly target: OpenTarget } {
  switch (problem.fixTarget) {
    case 'journal-chart': return { screen: 'Journal', target: { internalId: problem.accountId ?? '', section: 'account' } };
    case 'policy-category': return { screen: 'Expense', target: { internalId: problem.categoryId ?? '', section: 'category' } };
    case 'policy-journal': return { screen: 'Expense', target: { internalId: '', section: 'journal' } };
    default: return { screen: 'Expense', target: { internalId: claimId, section: `item:${problem.itemId ?? ''}` } };
  }
}

export function journalProblemLabel(problem: ExpenseJournalLinkProblemDto, text: Translate): string {
  switch (problem.fixTarget) {
    case 'journal-chart': return text('Open the journal chart of accounts', '仕訳の科目マスタを開く');
    case 'policy-category': return text('Open the policy category', '規程の費目を開く');
    case 'policy-journal': return text('Open the journal settings of the policy', '規程の仕訳設定を開く');
    default: return text('Open the item', '明細を開く');
  }
}

/* ---------------------------------------------------------------------------
 * 承認できない理由
 * ------------------------------------------------------------------------- */

export interface BlockerSummary {
  readonly key: string;
  readonly title: string;
  readonly fix: string;
  readonly target?: OpenTarget;
  readonly actionLabel?: string;
  /** 画面の外へ出ずにその場でする導線（再読み込み・承認のコメント欄へ）。target とは排他。 */
  readonly localAction?: 'reload' | 'focus-comment';
}

function isReasonCode(code: string): code is ExpenseReasonCodeDto {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, code);
}

/** §20.5.1 の承認の擬似コード。`approval-route-unresolved` は理由コードと同名なので、params があるときだけ擬似コードとして読む。 */
export const EXPENSE_APPROVAL_BLOCKER_CODES = [
  'approval-route-unresolved', 'approval-not-current-approver', 'approval-actor-unlinked', 'approval-claimant-self',
  'approval-same-approver', 'approval-step-changed', 'approval-proxy-comment-missing',
] as const;

function approvalBlockerSummary(blocker: ExpenseBlockingReasonDto, claimId: string, key: string, text: Translate): BlockerSummary | undefined {
  const p: Params = blocker.params ?? {};
  const approvalRoutes = { target: { internalId: stringParam(p, 'routeId') ?? '', section: 'approval' }, actionLabel: text('Open the approval routes', '承認経路を開く') };
  switch (blocker.code) {
    case 'approval-route-unresolved': {
      if (blocker.params === undefined) return undefined;
      const { causeText, causeFix } = approvalCauseText(p, text);
      // 原因ごとに直す場所が違う（上長は従業員、部門長・グループは組織、指定の承認者・本人しかいないは経路）。
      const destination = p['cause'] === 'manager-missing' || p['cause'] === 'manager-disabled'
        ? { target: { internalId: stringParam(p, 'employeeId') ?? '', section: 'employee' }, actionLabel: text('Open the employee', '従業員を開く') }
        : p['cause'] === 'department-head-missing' || p['cause'] === 'group-empty'
          ? { target: { internalId: stringParam(p, 'departmentId') ?? stringParam(p, 'groupId') ?? '', section: 'organization' }, actionLabel: text('Open the organization', '組織を開く') }
          : p['cause'] === 'claimant-unlinked'
            ? { target: { internalId: claimId, section: 'claimant' }, actionLabel: text('Choose the claimant', '申請者を選ぶ') }
            : approvalRoutes;
      return { key, title: text(`The approver of step "${num(p['stepName'])}" cannot be decided (${causeText})`, `段「${num(p['stepName'])}」の承認者が決まりません（${causeText}）`), fix: causeFix, ...destination };
    }
    case 'approval-not-current-approver':
      return { key, title: text(`You are not an approver of the current step "${num(p['stepName'])}" (approvers: ${num(p['approvers'])})`, `あなたは現在の段「${num(p['stepName'])}」の承認者ではありません（承認者: ${num(p['approvers'])}）`), fix: text('Ask an approver to approve it. To approve on their behalf, ask to be added to the proxy approver group of the policy.', '承認者に承認を依頼してください。代理で承認するなら、規程の代理承認グループに入れてもらってください'), ...approvalRoutes };
    case 'approval-actor-unlinked':
      return { key, title: text(`The login ID "${num(p['subject'])}" is not linked to the employee master, so it cannot be told whether you are a designated approver`, `ログイン ID「${num(p['subject'])}」が従業員マスタに紐付いていないため、指定の承認者か判定できません`), fix: text(`Add ${num(p['subject'])} to your "login IDs" in the employee master.`, `従業員マスタで自分の「ログイン ID」に ${num(p['subject'])} を足してください`), target: { internalId: stringParam(p, 'employeeId') ?? '', section: 'employee' }, actionLabel: text('Open the employee master', '従業員マスタを開く') };
    case 'approval-claimant-self':
      return { key, title: text('The claimant cannot approve their own claim', '申請者本人は自分の申請を承認できません'), fix: text('Ask another approver (this can be changed in the approval route settings of the policy).', '別の承認者に依頼してください（規程の承認経路の設定で変更できます）'), ...approvalRoutes };
    case 'approval-same-approver':
      return { key, title: text(`The person who approved the previous step "${num(p['previousStep'])}" cannot approve this step`, `前の段「${num(p['previousStep'])}」を承認した人は、この段を承認できません`), fix: text('Ask another approver (the policy can also allow the same person to approve consecutive steps).', '別の承認者に依頼してください（規程で「同じ人の連続承認」を許すこともできます）'), ...approvalRoutes };
    case 'approval-step-changed':
      return { key, title: text(`The approval moved on after you opened this screen (current step: ${num(p['stepName'])})`, `画面を開いた後に承認が進みました（現在の段: ${num(p['stepName'])}）`), fix: text('Reload, then try again.', '画面を再読み込みしてから操作してください'), localAction: 'reload', actionLabel: text('Reload', '再読み込み') };
    case 'approval-proxy-comment-missing':
      return { key, title: text('A proxy approval needs a comment', '代理承認にはコメントが必要です'), fix: text('Write whom you approve for and why.', '誰の代わりに・なぜ承認するかを書いてください'), localAction: 'focus-comment', actionLabel: text('Go to the comment', 'コメント欄へ') };
    default: return undefined;
  }
}

/** 承認を妨げる理由（`approvalBlockers` / 409 の `blockingReasons`）→ 見出し・次の一手・導線。 */
export function summarizeBlocker(blocker: ExpenseBlockingReasonDto, claim: Pick<ExpenseClaimDto, 'id' | 'judgment' | 'items'>, text: Translate): BlockerSummary {
  const key = `${blocker.code}:${blocker.itemId ?? ''}`;
  const approval = approvalBlockerSummary(blocker, claim.id, key, text);
  if (approval !== undefined) return approval;
  if (blocker.code === 'judgment-missing') {
    return { key, title: text('The claim has not been checked yet', 'まだチェックしていません'), fix: text('Press "Check" in the Check step.', 'チェックステップで「チェック」を押してください'), target: { internalId: claim.id, section: 'claim' }, actionLabel: text('Open Check', 'チェックを開く') };
  }
  if (blocker.code === 'judgment-stale') {
    return { key, title: text('The policy or items changed after the check', '判定の後に規程か明細が変わりました'), fix: text('Check the claim again, then approve.', 'もう一度チェックしてから承認してください'), target: { internalId: claim.id, section: 'claim' }, actionLabel: text('Open Check', 'チェックを開く') };
  }
  if (blocker.code === 'self-approval') {
    return { key, title: text('You imported this claim yourself', '自分で取り込んだ申請です'), fix: text('Ask someone other than the person who imported it to approve (you can change this in the claim rules of the policy).', '取り込んだ人とは別の人が承認してください（規程の申請ルールで変更できます）'), target: { internalId: '', section: 'rules' }, actionLabel: text('Open the policy', '規程を開く') };
  }
  if (!isReasonCode(blocker.code)) return { key, title: blocker.code, fix: text('Follow the reason shown by the server.', 'サーバーが示した理由に従ってください') };
  const code = blocker.code;
  const found = [...(claim.judgment?.claimReasons ?? []), ...(claim.judgment?.items.flatMap((item) => item.reasons) ?? [])]
    .find((reason) => reason.code === code && (reason.itemId ?? undefined) === (blocker.itemId ?? undefined));
  const params = found?.params ?? {};
  const summary = summarizeCheck({ code, severity: found?.severity ?? EXPENSE_REASON_DEFAULT_SEVERITY[code], params, ...(blocker.itemId === undefined ? {} : { itemId: blocker.itemId }) }, text);
  const fixTarget = summary.fixTargets[0];
  const item = claim.items.find((candidate) => candidate.id === blocker.itemId);
  return {
    key, title: `${summary.title}: ${summary.cause}`, fix: summary.fix,
    ...(fixTarget === undefined ? {} : {
      target: openTargetForFix(fixTarget, { claimId: claim.id, code, params, ...(blocker.itemId === undefined ? {} : { itemId: blocker.itemId }), ...(item?.categoryId === undefined ? {} : { categoryId: item.categoryId }) }),
      actionLabel: fixTargetLabel(fixTarget, code, text),
    }),
  };
}

/* ---------------------------------------------------------------------------
 * 判定の読み方
 * ------------------------------------------------------------------------- */

export interface ReviewReason { readonly reason: ExpenseCheckReasonDto; readonly acknowledged?: { readonly note: string; readonly by: string; readonly at: string } }

/** 要確認の理由（申請全体 → 明細の順）と、確認済みならその記録。 */
export function reviewReasonsOf(claim: Pick<ExpenseClaimDto, 'judgment' | 'acknowledgements'>): readonly ReviewReason[] {
  const reasons = [...(claim.judgment?.claimReasons ?? []), ...(claim.judgment?.items.flatMap((item) => item.reasons) ?? [])].filter((reason) => reason.severity === 'review');
  return reasons.map((reason) => {
    const ack = claim.acknowledgements.find((entry) => entry.code === reason.code && (entry.itemId ?? undefined) === (reason.itemId ?? undefined));
    return ack === undefined ? { reason } : { reason, acknowledged: { note: ack.note, by: ack.by, at: ack.at } };
  });
}

/** 電帳法の検索要件 3 点（取引年月日・取引金額・取引先）が揃っているか。 */
export function searchKeysOf(facts: ExpenseReceiptFactsDto): { readonly date: boolean; readonly amount: boolean; readonly payee: boolean } {
  return { date: facts.transactionDate !== undefined && facts.transactionDate !== '', amount: typeof facts.amount === 'number' && facts.amount > 0, payee: (facts.payeeName ?? '').trim() !== '' };
}

export function itemLabel(item: { readonly facts: ExpenseReceiptFactsDto }, index: number, text: Translate): string {
  const label = (item.facts.description ?? '').trim() || (item.facts.payeeName ?? '').trim();
  return label !== '' ? label : text(`Item ${index + 1}`, `明細 ${index + 1}`);
}

/**
 * 読取の警告文から、強調する欄を推し量る（値は直さず、見るべき場所を示すだけ）。
 * 警告は仕訳の読取の自由文なので、語で当てる。
 */
export function warningFields(warnings: readonly string[]): ReadonlySet<ItemField> {
  const fields = new Set<ItemField>();
  for (const warning of warnings) {
    const lower = warning.toLowerCase();
    if (/登録番号|registration/.test(lower)) fields.add('registrationNumber');
    if (/取引日|発行日|日付|date/.test(lower)) fields.add('transactionDate');
    if (/合計|金額|税率|total|amount/.test(lower)) fields.add('amount');
    if (/参加人数|人数|headcount|attendee/.test(lower)) fields.add('attendeesCount');
    if (/目的|purpose/.test(lower)) fields.add('purpose');
    if (/支払先|発行者|issuer|payee/.test(lower)) fields.add('payeeName');
  }
  return fields;
}

/** 費目で必須になる欄と、入力欄の横に出す上限の文言。 */
export function categoryHints(category: ExpenseCategoryDto | undefined, text: Translate): { readonly required: ReadonlySet<ItemField>; readonly limits: readonly string[] } {
  const required = new Set<ItemField>();
  const limits: string[] = [];
  if (category === undefined) return { required, limits };
  if (category.requires.purpose) required.add('purpose');
  if (category.requires.attendees) required.add('attendeesCount');
  if (category.requires.attendeeDetails) { required.add('attendeeNames'); required.add('attendeeRelation'); }
  if (category.limits.perUnit !== undefined) required.add('unitCount');
  if (category.receipt.required) required.add('receipt');
  if (category.invoice.required) required.add('registrationNumber');
  if (category.limits.perItem !== undefined) limits.push(text(`Up to ¥${num(category.limits.perItem)} per item`, `1 件 ${num(category.limits.perItem)} 円まで`));
  if (category.limits.perPerson !== undefined) {
    limits.push(category.limits.perPersonBasis === 'tax-excluded'
      ? text(`Up to ¥${num(category.limits.perPerson)} per person (tax excluded)`, `1 人 ${num(category.limits.perPerson)} 円まで（税抜）`)
      : text(`Up to ¥${num(category.limits.perPerson)} per person (tax included)`, `1 人 ${num(category.limits.perPerson)} 円まで（税込）`));
  }
  if (category.limits.perUnit !== undefined) limits.push(text(`Up to ¥${num(category.limits.perUnit.amount)} per ${category.limits.perUnit.label}`, `1 ${category.limits.perUnit.label} ${num(category.limits.perUnit.amount)} 円まで`));
  if (category.limits.perClaim !== undefined) limits.push(text(`Up to ¥${num(category.limits.perClaim)} per claim`, `1 申請 ${num(category.limits.perClaim)} 円まで`));
  if (category.receipt.exemptBelow !== undefined) limits.push(text(`Receipt needed from ¥${num(category.receipt.exemptBelow)}`, `${num(category.receipt.exemptBelow)} 円以上は領収書が必要`));
  return { required, limits };
}

/* ---------------------------------------------------------------------------
 * 入力値の検証
 * ------------------------------------------------------------------------- */

export type Message = readonly [en: string, ja: string];

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 「1,200」「¥1200」「１２００」も受ける整数。空は undefined、読めなければ null。 */
export function parseInteger(raw: string): number | undefined | null {
  const cleaned = raw.normalize('NFKC').replace(/[,¥円\s]/g, '');
  if (cleaned === '') return undefined;
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** `;`・`、`・改行区切りの一覧。 */
export function splitNames(raw: string): readonly string[] {
  return raw.split(/[;；、\n]/).map((part) => part.trim()).filter((part) => part !== '');
}

export function localIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 新しい申請の既定の期間（今月の 1 日〜末日）。 */
export function defaultPeriod(now: Date = new Date()): { readonly from: string; readonly to: string } {
  return { from: localIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: localIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

/* 申請フォーム ------------------------------------------------------------- */

export interface ClaimFormDraft {
  readonly name: string;
  readonly employeeCode: string;
  readonly department: string;
  readonly from: string;
  readonly to: string;
  readonly title: string;
  /** 従業員マスタの紐付け（A の `ClaimantField` が入れる。空 = 紐付けない）。指定するとサーバーが氏名などの写しを埋める。 */
  readonly employeeId: string;
}

export function emptyClaimDraft(now: Date = new Date()): ClaimFormDraft {
  const period = defaultPeriod(now);
  return { name: '', employeeCode: '', department: '', from: period.from, to: period.to, title: '', employeeId: '' };
}

export function claimDraftFromClaim(claim: Pick<ExpenseClaimDto, 'claimant' | 'period' | 'title'>): ClaimFormDraft {
  return {
    name: claim.claimant.name, employeeCode: claim.claimant.employeeCode ?? '', department: claim.claimant.department ?? '', from: claim.period.from, to: claim.period.to, title: claim.title ?? '',
    employeeId: claim.claimant.employeeId ?? '',
  };
}

export function claimInputFromDraft(draft: ClaimFormDraft): { readonly input?: SaveExpenseClaimDto; readonly errors: Readonly<Partial<Record<keyof ClaimFormDraft, Message>>> } {
  const errors: Partial<Record<keyof ClaimFormDraft, Message>> = {};
  if (draft.name.trim() === '') errors.name = ['Enter the claimant name.', '申請者の氏名を入力してください。'];
  if (!isIsoDate(draft.from)) errors.from = ['Enter the start date as YYYY-MM-DD.', '期間の開始日を YYYY-MM-DD で入力してください。'];
  if (!isIsoDate(draft.to)) errors.to = ['Enter the end date as YYYY-MM-DD.', '期間の終了日を YYYY-MM-DD で入力してください。'];
  else if (isIsoDate(draft.from) && draft.from > draft.to) errors.to = ['The end date must be on or after the start date.', '終了日は開始日以降にしてください。'];
  if (Object.keys(errors).length > 0) return { errors };
  const employeeCode = draft.employeeCode.trim();
  const department = draft.department.trim();
  const title = draft.title.trim();
  const employeeId = draft.employeeId.trim();
  return {
    errors,
    input: {
      claimant: { name: draft.name.trim(), ...(employeeCode === '' ? {} : { employeeCode }), ...(department === '' ? {} : { department }), ...(employeeId === '' ? {} : { employeeId }) },
      period: { from: draft.from, to: draft.to },
      ...(title === '' ? {} : { title }),
    },
  };
}

/* 明細フォーム ------------------------------------------------------------- */

export interface ItemFormDraft {
  readonly categoryId: string;
  readonly categoryText: string;
  readonly transactionDate: string;
  readonly issueDate: string;
  readonly payeeName: string;
  readonly registrationNumber: string;
  readonly amount: string;
  readonly paymentMethod: '' | ExpensePaymentMethodDto;
  readonly corporatePayment: boolean;
  readonly description: string;
  readonly purpose: string;
  readonly attendeesCount: string;
  readonly attendeeNames: string;
  readonly attendeeRelation: string;
  readonly unitCount: string;
  readonly preApprovalRef: string;
  /** 読取値のまま / 手で直した / 発行日を写した。 */
  readonly dateSource: '' | 'read' | 'manual' | 'issue-copied';
  /** 読取時の取引日（手で直したかを判定する）。 */
  readonly readTransactionDate?: string;
  /** 税率別の内訳は画面で編集しないが、保存時に落とさない。 */
  readonly totalsByRate?: readonly ExpenseTotalsByRateDto[];
  /** 区間（C の `ItemRouteFields` が編集する）。区間欄の無い費目でも、保存で落とさない。 */
  readonly route?: ExpenseReceiptRouteDto;
}

export function emptyItemDraft(): ItemFormDraft {
  return {
    categoryId: '', categoryText: '', transactionDate: '', issueDate: '', payeeName: '', registrationNumber: '', amount: '', paymentMethod: '', corporatePayment: false,
    description: '', purpose: '', attendeesCount: '', attendeeNames: '', attendeeRelation: '', unitCount: '', preApprovalRef: '', dateSource: '',
  };
}

/** 保存済みの明細・読取の下書き → フォーム。 */
export function itemDraftFrom(item: { readonly categoryId?: string; readonly categoryText?: string; readonly facts: ExpenseReceiptFactsDto }): ItemFormDraft {
  const { facts } = item;
  return {
    categoryId: item.categoryId ?? '', categoryText: item.categoryText ?? '',
    transactionDate: facts.transactionDate ?? '', issueDate: facts.issueDate ?? '', payeeName: facts.payeeName ?? '', registrationNumber: facts.registrationNumber ?? '',
    amount: facts.amount === undefined ? '' : String(facts.amount), paymentMethod: facts.paymentMethod ?? '', corporatePayment: facts.corporatePayment === true,
    description: facts.description ?? '', purpose: facts.purpose ?? '',
    attendeesCount: facts.attendees?.count === undefined ? '' : String(facts.attendees.count), attendeeNames: (facts.attendees?.names ?? []).join('; '), attendeeRelation: facts.attendees?.relation ?? '',
    unitCount: facts.unitCount === undefined ? '' : String(facts.unitCount), preApprovalRef: facts.preApprovalRef ?? '',
    dateSource: facts.dateSource ?? '',
    ...(facts.dateSource === 'read' && facts.transactionDate !== undefined ? { readTransactionDate: facts.transactionDate } : {}),
    ...(facts.totalsByRate === undefined ? {} : { totalsByRate: facts.totalsByRate }),
    ...(facts.route === undefined ? {} : { route: facts.route }),
  };
}

/** 「発行日を取引日にする」。発行日が無ければそのまま。 */
export function copyIssueDate(draft: ItemFormDraft): ItemFormDraft {
  return draft.issueDate === '' ? draft : { ...draft, transactionDate: draft.issueDate, dateSource: 'issue-copied' };
}

export const REGISTRATION_NUMBER_PATTERN = /^T\d{13}$/;

export interface ItemInputResult {
  readonly input?: SaveExpenseItemDto;
  readonly errors: Readonly<Partial<Record<ItemField, Message>>>;
  /** 保存は止めないが知らせること（登録番号の形など）。 */
  readonly warnings: readonly Message[];
}

type ExpenseExtractionFlag = NonNullable<ExpenseItemExtractionDto['flags']>[number];

/** 人がその欄を直したら外す読取の印（docs/21 §20.3.6）。印の付いた欄が 1 つでも変われば、人が確かめたとみなす。 */
const FLAG_FORM_FIELDS: Readonly<Partial<Record<ExpenseExtractionFlag, readonly (keyof ItemFormDraft)[]>>> = {
  'attendees-read': ['attendeesCount', 'attendeeNames'],
  'route-read': ['route'],
  'payee-read': ['payeeName'],
  'purpose-read': ['purpose'],
  'transaction-date-substituted': ['transactionDate'],
};

/** 2 回の読取の食い違いの欄 → フォームの欄。`reads-disagree` は食い違った欄をすべて直したときだけ外す（1 欄だけ直しても残りは未確認）。 */
const DISAGREEMENT_FORM_FIELDS: Readonly<Record<string, keyof ItemFormDraft>> = {
  registrationNumber: 'registrationNumber', transactionDate: 'transactionDate', issueDate: 'issueDate', payeeName: 'payeeName',
};

/**
 * 保存する読取の印。フォームを開いたときの値 `original` と比べ、人が直した欄の印を外す。
 * 外さないと、人が確かめて直した欄にも `read-values-unconfirmed` などの理由が出続け、確認の手間が消えない。
 * 直していない欄の印は残す（値を見ただけでは確認したことにしない）。
 */
export function confirmedExtraction(extraction: Partial<ExpenseItemExtractionDto>, original: ItemFormDraft, draft: ItemFormDraft): Partial<ExpenseItemExtractionDto> {
  const flags = extraction.flags ?? [];
  if (flags.length === 0) return extraction;
  const edited = (field: keyof ItemFormDraft): boolean => JSON.stringify(original[field] ?? '') !== JSON.stringify(draft[field] ?? '');
  const disagreed = (extraction.detail?.disagreements ?? []).map((entry) => DISAGREEMENT_FORM_FIELDS[entry.field]);
  const kept = flags.filter((flag) => {
    if (flag === 'reads-disagree') return !(disagreed.length > 0 && disagreed.every((field) => field !== undefined && edited(field)));
    const fields = FLAG_FORM_FIELDS[flag];
    return fields === undefined || !fields.some(edited);
  });
  if (kept.length === flags.length) return extraction;
  const { flags: _dropped, ...rest } = extraction;
  return kept.length === 0 ? rest : { ...rest, flags: kept };
}

/** フォーム → 保存本文。値を推測で埋めない（空欄は送らず、判定の理由コードに任せる）。 */
export function itemInputFromDraft(draft: ItemFormDraft, base: {
  readonly itemId?: string; readonly source: ExpenseItemSourceDto; readonly extraction?: Partial<ExpenseItemExtractionDto>;
  readonly receipt?: SaveExpenseItemDto['receipt'];
  /** フォームを開いたときの値。渡すと、人が直した欄の読取の印を外して送る（`confirmedExtraction`）。 */
  readonly original?: ItemFormDraft;
}): ItemInputResult {
  const errors: Partial<Record<ItemField, Message>> = {};
  const warnings: Message[] = [];
  const amount = parseInteger(draft.amount);
  if (amount === null || (amount !== undefined && amount <= 0)) errors.amount = ['Enter the amount as a whole number of yen (1 or more).', '金額は 1 以上の整数（円）で入力してください。'];
  if (draft.transactionDate !== '' && !isIsoDate(draft.transactionDate)) errors.transactionDate = ['Enter the transaction date as YYYY-MM-DD.', '取引日を YYYY-MM-DD で入力してください。'];
  if (draft.issueDate !== '' && !isIsoDate(draft.issueDate)) errors.issueDate = ['Enter the issue date as YYYY-MM-DD.', '発行日を YYYY-MM-DD で入力してください。'];
  const count = parseInteger(draft.attendeesCount);
  if (count === null || (count !== undefined && count < 1)) errors.attendeesCount = ['Enter the number of attendees as a whole number (1 or more).', '参加人数は 1 以上の整数で入力してください。'];
  const units = parseInteger(draft.unitCount);
  if (units === null || (units !== undefined && units < 1)) errors.unitCount = ['Enter the day / night count as a whole number (1 or more).', '日数・泊数は 1 以上の整数で入力してください。'];
  const registration = draft.registrationNumber.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
  if (registration !== '' && !REGISTRATION_NUMBER_PATTERN.test(registration)) {
    warnings.push([`"${draft.registrationNumber}" is not T + 13 digits, so the server will drop it and keep a warning.`, `「${draft.registrationNumber}」は T + 13 桁ではないため、保存時に採用されず警告として残ります。`]);
  }
  if (Object.keys(errors).length > 0) return { errors, warnings };

  const names = splitNames(draft.attendeeNames);
  const relation = draft.attendeeRelation.trim();
  const attendees = { ...(count === undefined || count === null ? {} : { count }), ...(names.length === 0 ? {} : { names }), ...(relation === '' ? {} : { relation }) };
  const dateSource = draft.transactionDate === ''
    ? undefined
    : draft.dateSource === 'issue-copied' && draft.transactionDate === draft.issueDate
      ? 'issue-copied'
      : draft.readTransactionDate !== undefined && draft.readTransactionDate === draft.transactionDate ? 'read' : 'manual';
  const optional = (key: string, value: string) => (value.trim() === '' ? {} : { [key]: value.trim() });
  const facts: ExpenseReceiptFactsDto = {
    ...optional('transactionDate', draft.transactionDate),
    ...optional('issueDate', draft.issueDate),
    ...optional('payeeName', draft.payeeName),
    ...(registration === '' ? {} : { registrationNumber: registration }),
    ...(amount === undefined || amount === null ? {} : { amount }),
    ...(draft.totalsByRate === undefined ? {} : { totalsByRate: draft.totalsByRate }),
    ...(draft.paymentMethod === '' ? {} : { paymentMethod: draft.paymentMethod }),
    ...(draft.corporatePayment ? { corporatePayment: true } : {}),
    ...optional('description', draft.description),
    ...optional('purpose', draft.purpose),
    ...(Object.keys(attendees).length === 0 ? {} : { attendees }),
    ...(units === undefined || units === null ? {} : { unitCount: units }),
    ...optional('preApprovalRef', draft.preApprovalRef),
    ...(dateSource === undefined ? {} : { dateSource }),
    ...(draft.route === undefined ? {} : { route: draft.route }),
  };
  const categoryText = draft.categoryText.trim();
  return {
    errors, warnings,
    input: {
      ...(base.itemId === undefined ? {} : { itemId: base.itemId }),
      ...(draft.categoryId === '' ? {} : { categoryId: draft.categoryId }),
      ...(draft.categoryId === '' && categoryText !== '' ? { categoryText } : {}),
      facts, source: base.source,
      ...(base.extraction === undefined ? {} : { extraction: base.original === undefined ? base.extraction : confirmedExtraction(base.extraction, base.original, draft) }),
      ...(base.receipt === undefined ? {} : { receipt: base.receipt }),
    },
  };
}

/* ---------------------------------------------------------------------------
 * 規程の編集
 * ------------------------------------------------------------------------- */

export interface PolicyIssue { readonly path: string; readonly message: Message }

const CATEGORY_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const AMOUNT_MAX = 100_000_000;

function amountIssue(value: number | undefined, path: string, issues: PolicyIssue[]): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > AMOUNT_MAX) issues.push({ path, message: ['Enter a whole number of yen between 1 and 100,000,000, or leave it empty for no limit.', '1〜100,000,000 の整数（円）を入れるか、上限なしなら空欄にしてください。'] });
}

/** 保存前に画面で分かる不備（サーバーの検証の手前。保存ボタンを押す前に直す場所を示す）。 */
export function policyIssues(policy: SaveExpensePolicyDto): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const ids = new Set<string>();
  policy.categories.forEach((category, index) => {
    const at = `categories.${index}`;
    if (!CATEGORY_ID_PATTERN.test(category.id)) issues.push({ path: `${at}.id`, message: ['The id may use lowercase letters, digits, "_", ".", and "-" (up to 64).', 'id は英小文字・数字・「_」「.」「-」の 64 文字以内にしてください。'] });
    else if (ids.has(category.id)) issues.push({ path: `${at}.id`, message: [`The id "${category.id}" is used twice.`, `id「${category.id}」が重複しています。`] });
    ids.add(category.id);
    if (category.name.trim() === '') issues.push({ path: `${at}.name`, message: ['Enter the category name.', '費目の名前を入力してください。'] });
    amountIssue(category.limits.perItem, `${at}.limits.perItem`, issues);
    amountIssue(category.limits.perClaim, `${at}.limits.perClaim`, issues);
    amountIssue(category.limits.perPerson, `${at}.limits.perPerson`, issues);
    if (category.limits.perUnit !== undefined) {
      amountIssue(category.limits.perUnit.amount, `${at}.limits.perUnit.amount`, issues);
      const label = category.limits.perUnit.label.trim();
      if (label.length < 1 || label.length > 4) issues.push({ path: `${at}.limits.perUnit.label`, message: ['Enter the unit name (1 to 4 characters, such as "day" in Japanese 日).', '単位名（日・泊など 1〜4 文字）を入力してください。'] });
    }
    if (category.limits.perPerson !== undefined && !category.requires.attendees) issues.push({ path: `${at}.requires.attendees`, message: ['A per-person limit needs "attendees required" (the limit cannot be judged without a head count).', '1 人あたりの上限を使うなら「参加人数が必須」をオンにしてください（人数が無いと判定できません）。'] });
    for (const [key, requirement] of [['receipt', category.receipt], ['invoice', category.invoice]] as const) {
      if (requirement.exemptBelow !== undefined && (!Number.isInteger(requirement.exemptBelow) || requirement.exemptBelow < 0)) issues.push({ path: `${at}.${key}.exemptBelow`, message: ['Enter a whole number of yen (0 or more), or leave it empty.', '0 以上の整数（円）を入れるか、空欄にしてください。'] });
    }
  });
  policy.preApprovalRules.forEach((rule, index) => {
    const at = `preApprovalRules.${index}`;
    if (rule.name.trim() === '') issues.push({ path: `${at}.name`, message: ['Enter the rule name.', '条件の名前を入力してください。'] });
    amountIssue(rule.minAmount, `${at}.minAmount`, issues);
    amountIssue(rule.minPerPerson, `${at}.minPerPerson`, issues);
    if (rule.categoryIds.length === 0 && rule.minAmount === undefined && rule.minPerPerson === undefined) issues.push({ path: `${at}.categoryIds`, message: ['A rule with no category and no amount would match every item. Pick categories or set an amount.', '費目も金額も無い条件は全明細に当たります。費目を選ぶか金額を入れてください。'] });
    for (const categoryId of rule.categoryIds) if (!ids.has(categoryId)) issues.push({ path: `${at}.categoryIds`, message: [`The category "${categoryId}" is not in the category list.`, `費目「${categoryId}」が費目の一覧にありません。`] });
  });
  const days = policy.claimRules.submissionDeadlineDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) issues.push({ path: 'claimRules.submissionDeadlineDays', message: ['Enter the deadline as 1 to 3650 days, or leave it empty for no deadline.', '期限は 1〜3650 日の整数にするか、期限なしなら空欄にしてください。'] });
  if (policy.journal.creditAccountId.trim() === '') issues.push({ path: 'journal.creditAccountId', message: ['Choose the credit account for journal drafts.', '仕訳下書きの貸方科目を選んでください。'] });
  if (policy.journal.descriptionTemplate.length > 200) issues.push({ path: 'journal.descriptionTemplate', message: ['Keep the description template within 200 characters.', '摘要のひな形は 200 文字以内にしてください。'] });
  return issues;
}

/**
 * 保存本文（`updatedAt` を落とす）。実用化の節（承認経路・交通費・カード・仮払）は読んだ値をそのまま引き継ぐ:
 * 省略して送るとサーバーが既定値で補うため、規程タブの保存で系統の設定が消えてしまう。
 * 費目の `route` と仕訳の `departmentDimensionId` は費目・仕訳設定のオブジェクトごと送るので落ちない。
 */
export function policyBody(policy: ExpensePolicyDto | SaveExpensePolicyDto): SaveExpensePolicyDto {
  return {
    categories: policy.categories, claimRules: policy.claimRules, preApprovalRules: policy.preApprovalRules, severityOverrides: policy.severityOverrides, journal: policy.journal,
    ...(policy.approval === undefined ? {} : { approval: policy.approval }),
    ...(policy.transport === undefined ? {} : { transport: policy.transport }),
    ...(policy.card === undefined ? {} : { card: policy.card }),
    ...(policy.advance === undefined ? {} : { advance: policy.advance }),
  };
}

/* ---------------------------------------------------------------------------
 * 実用機能の準備状況（規程タブ先頭のカード。§20.10.1）
 * ------------------------------------------------------------------------- */

export type ExpenseReadinessKey = 'employees' | 'approval' | 'payout' | 'cards' | 'fares';

export interface ExpenseReadinessRow {
  readonly key: ExpenseReadinessKey;
  /** 設定済みか。分からないもの（まだ読めない設定）は false として「未設定」に出す（失敗ではない）。 */
  readonly configured: boolean;
  /** 「開く」の行き先。 */
  readonly target: OpenTarget | { readonly tab: ExpenseTab };
}

/**
 * 準備状況の行。承認経路は規程から分かる。従業員・振込元・カード・運賃は系統の API が読めるまで `known` で渡す（渡さなければ未設定）。
 * 未設定は「使うときに設定」で、赤くしない（設定しなくても申請・チェック・承認・CSV 出力は使える）。
 */
export function readinessRows(policy: Pick<ExpensePolicyDto, 'approval'> | undefined, known: Readonly<Partial<Record<Exclude<ExpenseReadinessKey, 'approval'>, boolean>>> = {}): readonly ExpenseReadinessRow[] {
  return [
    { key: 'employees', configured: known.employees === true, target: { tab: 'employees' } },
    { key: 'approval', configured: (policy?.approval?.routes.length ?? 0) > 0, target: { internalId: '', section: 'approval' } },
    { key: 'payout', configured: known.payout === true, target: { tab: 'settle' } },
    { key: 'cards', configured: known.cards === true, target: { tab: 'cards' } },
    { key: 'fares', configured: known.fares === true, target: { tab: 'fares' } },
  ];
}

export function readinessLabel(key: ExpenseReadinessKey, text: Translate): { readonly title: string; readonly unlocks: string } {
  switch (key) {
    case 'employees': return { title: text('Employee master', '従業員マスタ'), unlocks: text('Needed for approval routes, commuter pass deduction, and payout files', '承認経路・定期区間の控除・振込データに使います') };
    case 'approval': return { title: text('Approval routes', '承認経路'), unlocks: text('Without routes, every claim has one approval step (anyone who can approve)', '経路が無ければ、すべての申請が 1 段の承認（承認権限を持つ人なら誰でも）になります') };
    case 'payout': return { title: text('Payout source account', '振込元'), unlocks: text('Needed to create bank transfer files (Zengin format)', '振込データ（全銀協形式）を作るときに使います') };
    case 'cards': return { title: text('Corporate cards', 'カード'), unlocks: text('Needed to match corporate card statements with claims', '法人カードの明細と申請の照合に使います') };
    case 'fares': return { title: text('Fare table', '運賃'), unlocks: text('Needed to check transport fares and commuter pass overlaps', '交通費の運賃と定期区間の照合に使います') };
  }
}

function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  let index = taken.size + 1;
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function newCategory(categories: readonly ExpenseCategoryDto[]): ExpenseCategoryDto {
  const taxCodeByRate = categories[0]?.taxCodeByRate ?? {};
  return {
    id: uniqueId('category', new Set(categories.map((category) => category.id))), name: '', enabled: true,
    sortOrder: categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 1, aliases: [], defaultTaxRate: 10, taxCodeByRate,
    receipt: { required: true }, invoice: { required: true }, requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' },
  };
}

export function newPreApprovalRule(rules: readonly ExpensePreApprovalRuleDto[]): ExpensePreApprovalRuleDto {
  return { id: uniqueId('rule', new Set(rules.map((rule) => rule.id))), name: '', enabled: true, categoryIds: [] };
}

/** 数値欄の入力 → 規程の値。空は undefined、読めない値は NaN（`policyIssues` が拾う）。 */
export function amountFromInput(raw: string): number | undefined {
  const parsed = parseInteger(raw);
  return parsed === null ? Number.NaN : parsed;
}

/** undefined を入れるときはキーごと消す（保存本文に null を送らない）。 */
export function withOptional<T extends object, K extends string>(object: T, key: K, value: unknown): T {
  const next = { ...object } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

/** 重さの上書きの変更。既定に戻すときはキーを消す。 */
export function withSeverityOverride(overrides: SaveExpensePolicyDto['severityOverrides'], code: ExpenseReasonCodeDto, value: '' | ExpenseSeverityOverrideDto): SaveExpensePolicyDto['severityOverrides'] {
  return withOptional(overrides, code, value === '' ? undefined : value);
}

/** 規程の費目の科目が仕訳の科目マスタに（有効で）あるか。未設定は true（「マスタに無い」印を出さない）。 */
export function accountKnown(accountId: string | undefined, accounts: readonly { readonly id: string; readonly enabled: boolean }[]): boolean {
  return accountId === undefined || accountId === '' || accounts.some((account) => account.enabled && account.id === accountId);
}

/** 金額の合計（精算出力の一覧）。 */
export function sumAmounts(rows: readonly { readonly totalAmount: number }[]): number {
  return rows.reduce((sum, row) => sum + row.totalAmount, 0);
}

/** ApiError.details から配列を安全に取り出す（形の違う値は捨てる）。 */
export function detailArray<T>(details: Readonly<Record<string, unknown>> | undefined, key: string, guard: (value: unknown) => value is T): readonly T[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter(guard) : [];
}

export function isBlockingReason(value: unknown): value is ExpenseBlockingReasonDto {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string';
}

export function isJournalLinkProblem(value: unknown): value is ExpenseJournalLinkProblemDto {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string' && typeof (value as { fixTarget?: unknown }).fixTarget === 'string';
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

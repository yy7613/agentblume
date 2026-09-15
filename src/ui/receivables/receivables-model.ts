/**
 * 入金消込画面（docs/22 §8）の純関数: 表示の整形、理由コード → 「原因・次の一手・ボタン」、違反コード → 文言と直す場所、
 * 取込の警告の文言、ディープリンクの解決、請求書フォームの行 ↔ DTO の変換、JSON 貼付の読み込み。
 *
 * 文言の正本はここ（サーバーの英語の message を画面の正本にしない）。UI はバックエンドの層を import できないので、
 * 理由コードの表は `application/receivables/reason-messages.ts`（ツール用・日本語のみ）と別に日英で持つ。
 */
import type { OpenTarget } from '../navigation';
import type {
  BankTransactionDto, CsvWarningDto, CustomerDto, InvoiceDto, InvoiceIssueDto, InvoiceLineDto, InvoiceStatusDto, MatchCandidateDto,
  MatchJudgmentDto, PricingDto, RoundingModeDto, SaveInvoiceDto, TaxRateDto,
} from '../api/receivables-types';

export type Text = (en: string, ja: string) => string;

export type ReceivablesStep = 'customers' | 'invoice' | 'issue' | 'import' | 'matching' | 'journal';
export const RECEIVABLES_STEPS: readonly ReceivablesStep[] = ['customers', 'invoice', 'issue', 'import', 'matching', 'journal'];

export function formatYen(amount: number | undefined): string {
  return amount === undefined ? '—' : `¥${amount.toLocaleString('en-US')}`;
}

const yen = (value: unknown) => Number(value ?? 0).toLocaleString('en-US');

export function roundingModeLabel(mode: RoundingModeDto | string, text: Text): string {
  return mode === 'round-half-up' ? text('round half up', '四捨五入') : mode === 'ceil' ? text('round up', '切り上げ') : text('round down', '切り捨て');
}

export function invoiceStatusLabel(status: InvoiceStatusDto, text: Text): string {
  switch (status) {
    case 'draft': return text('Draft', '下書き');
    case 'issued': return text('Issued', '発行済み');
    case 'partially_paid': return text('Partially paid', '一部入金');
    case 'paid': return text('Paid', '入金済み');
    case 'void': return text('Void', '取消');
  }
}

/** 最初に開くステップ（docs/22 §8）: 設定未保存 → 取引先、未消込の入金がある → 消込、それ以外 → 請求書作成。 */
export function initialStep(state: { readonly settingsSaved: boolean | undefined; readonly unmatchedCount: number }): ReceivablesStep {
  if (state.settingsSaved === false) return 'customers';
  if (state.unmatchedCount > 0) return 'matching';
  return 'invoice';
}

/** 画面内のディープリンク（`usePendingOpen('Receivables', target)`）→ 開くステップ。 */
export function openReceivablesTarget(target: OpenTarget): { readonly step: ReceivablesStep; readonly id: string; readonly section: string } | undefined {
  switch (target.section) {
    case 'customer':
    case 'customer-aliases': return { step: 'customers', id: target.internalId, section: target.section };
    case 'invoice': return { step: 'issue', id: target.internalId, section: target.section };
    case 'transaction':
    case 'matching': return { step: 'matching', id: target.internalId, section: target.section };
    case 'settings': return { step: 'customers', id: target.internalId, section: 'settings' };
    default: return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * 請求書の記載事項の違反・警告（docs/22 §3.4）
 * ------------------------------------------------------------------------ */

/** 直す場所。`settings` は設定ダイアログの区画、`field` はフォームの欄（行番号つき）。 */
export type IssueTarget =
  | { readonly kind: 'settings'; readonly section: 'issuer' | 'rounding' | 'matching' | 'journal' }
  | { readonly kind: 'field'; readonly field: 'customerId' | 'issueDate' | 'transactionDate' | 'dueDate' | 'lines' | 'totals'; readonly row?: number };

export interface IssueMessage {
  readonly cause: string;
  readonly fix: string;
  readonly target: IssueTarget;
  /** 「計算値で置き換える」を出すか（持ち込んだ税額の違反）。 */
  readonly replaceDeclared?: boolean;
}

export function invoiceIssueMessage(issue: InvoiceIssueDto, text: Text): IssueMessage {
  const p = issue.params;
  const row = typeof p['row'] === 'number' ? p['row'] : undefined;
  const field = (name: Extract<IssueTarget, { kind: 'field' }>['field']): IssueTarget => ({ kind: 'field', field: name, ...(row === undefined ? {} : { row }) });
  const issuer: IssueTarget = { kind: 'settings', section: 'issuer' };
  switch (issue.code) {
    case 'issuer-name-missing': return { cause: text('The issuer (your company) name is not set.', '発行者（自社）の名称が設定されていません。'), fix: text('Enter the issuer name in Settings.', '設定で発行者名を入れてください。'), target: issuer };
    case 'issuer-registration-number-missing': return { cause: text('You are set up as a registered issuer, but the registration number is empty.', '適格請求書発行事業者として設定されていますが、登録番号がありません。'), fix: text('Enter T + 13 digits, or switch to "not a registered issuer".', '登録番号（T + 13 桁）を入れてください。登録していないなら「登録事業者ではない」に切り替えてください。'), target: issuer };
    case 'issuer-registration-number-invalid': return { cause: text(`The registration number "${p['value']}" has the wrong shape (${p['digits']} digits).`, `登録番号「${p['value']}」の形が違います（数字 ${p['digits']} 桁）。`), fix: text('Enter T followed by exactly 13 digits.', 'T のあとに数字 13 桁で入れ直してください。'), target: issuer };
    case 'issuer-not-registered': return { cause: text('You are not set up as a registered issuer, so this is not a qualified invoice.', '登録事業者ではない設定なので、この請求書は適格請求書になりません（相手は仕入税額控除を満額受けられません）。'), fix: text('If you are registered, enter the number in Settings.', '登録済みなら設定で登録番号を入れてください。'), target: issuer };
    case 'recipient-missing': return { cause: text('There is no recipient (customer).', '宛名（取引先）がありません。'), fix: text('Choose a customer.', '取引先を選んでください。'), target: field('customerId') };
    case 'customer-disabled': return { cause: text(`The customer "${p['customer']}" is disabled.`, `無効にした取引先（${p['customer']}）です。`), fix: text('Enable the customer or choose another one.', '取引先を有効に戻すか別の取引先を選んでください。'), target: field('customerId') };
    case 'issue-date-missing': return { cause: text('The issue date is empty.', '発行日がありません。'), fix: text('Enter the issue date.', '発行日を入れてください。'), target: field('issueDate') };
    case 'transaction-date-missing': return { cause: text('The transaction date is empty (a required item).', '取引年月日がありません（記載事項）。'), fix: text('Enter the transaction date (the last day for a period).', '取引日（期間なら末日）を入れてください。'), target: field('transactionDate') };
    case 'lines-empty': return { cause: text('There are no lines.', '明細がありません。'), fix: text('Add at least one line.', '明細を 1 行以上足してください。'), target: field('lines') };
    case 'line-description-missing': return { cause: text(`Line ${row}: the description is empty.`, `${row} 行目の品名（取引内容）が空です。`), fix: text('Enter the description.', '品名を入れてください。'), target: field('lines') };
    case 'line-amount-missing': return { cause: text(`Line ${row}: the amount is empty.`, `${row} 行目の金額がありません。`), fix: text('Enter the amount, or both the quantity and the unit price.', '金額か、数量と単価の両方を入れてください。'), target: field('lines') };
    case 'line-amount-not-integer': return { cause: text(`Line ${row}: unit price × quantity has a fraction of a yen.`, `${row} 行目の単価 × 数量が円未満を含みます。`), fix: text('Enter the amount directly.', '金額を直接入れてください。'), target: field('lines') };
    case 'line-tax-rate-missing': return { cause: text(`Line ${row}: the tax rate is empty.`, `${row} 行目の税率がありません。`), fix: text('Choose 10%, 8%, or 0%.', '10% / 8% / 0% を選んでください。'), target: field('lines') };
    case 'rate-total-negative': return { cause: text(`The ${p['rate']}% total is negative (discounts exceed the items).`, `${p['rate']}% の合計が負です（値引が本体を上回っています）。`), fix: text('Check the tax rate and amount of the discount.', '値引の税率・金額を確かめてください。'), target: field('lines') };
    case 'grand-total-not-positive': return { cause: text('The invoice total is 0 yen or less.', '請求額が 0 円以下です。'), fix: text('Check the lines.', '明細を確かめてください。'), target: field('lines') };
    case 'amount-out-of-range': return { cause: text('An amount or the number of lines is out of range.', '金額・行数が扱える範囲を超えています。'), fix: text('Split the invoice.', '請求書を分けてください。'), target: field('lines') };
    case 'per-line-rounding': return { cause: text(`The ${p['rate']}% tax was rounded per line (imported ${yen(p['declared'])} yen; rounding once per rate gives ${yen(p['once'])} yen).`, `${p['rate']}% の消費税が明細ごとに丸められています（取り込んだ税額 ${yen(p['declared'])} 円 = 明細ごとの丸め。正しくは税率ごとに 1 回で ${yen(p['once'])} 円）。`), fix: text('Issue with the computed tax instead of the imported one.', '取り込んだ税額を使わず、計算した税額で発行してください。'), target: field('totals'), replaceDeclared: true };
    case 'declared-tax-mismatch': return { cause: text(`The imported ${p['rate']}% tax (${yen(p['declared'])} yen) does not match the computed ${yen(p['computed'] ?? p['once'])} yen.`, `取り込んだ ${p['rate']}% の税額（${yen(p['declared'])} 円）が計算値（${yen(p['computed'] ?? p['once'])} 円）と合いません。`), fix: text('Check the line amounts, tax rates, and tax-exclusive/inclusive, then replace with the computed value.', '明細金額・税率・税抜 / 税込の区分を確かめ、計算値で置き換えてください。'), target: field('totals'), replaceDeclared: true };
    case 'rounding-mode-differs': return { cause: text(`The imported tax matches if rounded by "${roundingModeLabel(String(p['mode']), text)}" (Settings: "${roundingModeLabel(String(p['currentMode']), text)}").`, `取り込んだ税額は「${roundingModeLabel(String(p['mode']), text)}」なら一致します（設定は「${roundingModeLabel(String(p['currentMode']), text)}」）。`), fix: text('Check the rounding in Settings (keep it consistent with issued invoices).', '設定の端数処理を確かめてください（発行済みの請求書と揃える）。'), target: { kind: 'settings', section: 'rounding' } };
    case 'declared-total-mismatch': return { cause: text(`The imported total (${yen(p['declared'])} yen) differs from the computed total (${yen(p['computed'])} yen) by ${yen(p['difference'])} yen.`, `取り込んだ合計（${yen(p['declared'])} 円）と計算した合計（${yen(p['computed'])} 円）が差額 ${yen(p['difference'])} 円で違います。`), fix: text('Check for misread lines or a missing discount.', '読み取り誤りか値引の漏れを確かめてください。'), target: field('lines') };
    case 'zero-rate-lines': return { cause: text(`Lines ${p['rows']} are 0% without a category.`, `${p['rows']} 行目が 0% です（非課税 / 不課税 / 輸出の区分を確かめてください）。`), fix: text('Choose the category.', '区分を選んでください。'), target: field('lines') };
    case 'due-date-missing': return { cause: text('There is no due date (it will not appear in the overdue list).', '支払期日がありません（期日超過の一覧に出ません）。'), fix: text("Enter a due date or set the customer's payment terms.", '期日を入れるか取引先の支払条件を設定してください。'), target: field('dueDate') };
    case 'due-date-before-issue-date': return { cause: text('The due date is before the issue date.', '支払期日が発行日より前です。'), fix: text('Fix the dates.', '日付を直してください。'), target: field('dueDate') };
    case 'transaction-date-after-issue-date': return { cause: text('The transaction date is after the issue date.', '取引日が発行日より後です。'), fix: text('Fix the date unless this is an advance invoice.', '前払いの請求でなければ日付を直してください。'), target: field('transactionDate') };
    default: return { cause: issue.code, fix: text('Check the invoice.', '請求書を確かめてください。'), target: field('lines') };
  }
}

/* ---------------------------------------------------------------------------
 * 消込の理由（docs/22 §4.5）
 * ------------------------------------------------------------------------ */

export type MatchAction =
  | { readonly kind: 'confirm'; readonly learnAlias: boolean }
  | { readonly kind: 'edit-allocation' }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'open-invoice'; readonly invoiceId: string }
  | { readonly kind: 'open-customer'; readonly customerId: string; readonly section: 'customer' | 'customer-aliases' }
  | { readonly kind: 'open-settings'; readonly section: 'matching' }
  | { readonly kind: 'new-invoice' }
  | { readonly kind: 'open-journal' }
  | { readonly kind: 'rejudge' };

export interface MatchActionButton {
  readonly label: string;
  readonly action: MatchAction;
  readonly primary?: boolean;
}

export interface ReasonSummary {
  readonly cause: string;
  readonly next: string;
  readonly buttons: readonly MatchActionButton[];
}

export interface ReasonLookup {
  readonly customerName: (customerId: string) => string;
  readonly invoiceNumber: (invoiceId: string) => string;
}

export function summarizeMatch(transaction: Pick<BankTransactionDto, 'payerName' | 'amount'>, judgment: MatchJudgmentDto, lookup: ReasonLookup, text: Text): ReasonSummary {
  const first: MatchCandidateDto | undefined = judgment.candidates[0];
  const customer = first === undefined ? '' : lookup.customerName(first.customerId);
  const numbers = first === undefined ? '' : first.invoiceIds.map(lookup.invoiceNumber).join(', ');
  const payer = transaction.payerName === '' ? text('(no payer name)', '（名義なし）') : transaction.payerName;
  const ids = String(judgment.params?.['customerIds'] ?? '').split(',').filter((id) => id !== '');
  const openFirstInvoice: MatchActionButton[] = first === undefined ? [] : [{ label: text('Open the invoice', '請求書を開く'), action: { kind: 'open-invoice', invoiceId: first.invoiceIds[0]! } }];
  const confirm = (label: string, learnAlias = false): MatchActionButton => ({ label, action: { kind: 'confirm', learnAlias }, primary: true });
  const edit: MatchActionButton = { label: text('Edit allocation', '配分を編集'), action: { kind: 'edit-allocation' } };
  const ignore: MatchActionButton = { label: text('Mark as not a receivable', '対象外にする'), action: { kind: 'ignore' } };
  const aliases = (customerId: string): MatchActionButton => ({ label: text(`Edit payer names of ${lookup.customerName(customerId)}`, `${lookup.customerName(customerId)} の別名を編集`), action: { kind: 'open-customer', customerId, section: 'customer-aliases' } });
  switch (judgment.reason) {
    case 'exact-amount-and-name': return { cause: text(`"${payer}" matches ${numbers} of ${customer} (${yen(first?.candidateTotal)} yen) by amount and name.`, `「${payer}」は ${customer} の ${numbers}（${yen(first?.candidateTotal)} 円）と金額・名義が一致しました。`), next: text('Review and confirm (bulk confirm is also available).', '内容を見て確定してください（一括確定も可）。'), buttons: [confirm(text('Confirm', '確定')), ...openFirstInvoice] };
    case 'fee-difference': return { cause: text(`${yen(first?.difference)} yen less than the balance of ${numbers}. The transfer fee may have been deducted.`, `${numbers} の残高より ${yen(first?.difference)} 円少ない入金です。振込手数料を差し引かれた可能性があります。`), next: text('Confirm with the difference as a transfer fee. If it is not a fee, edit the allocation as a partial payment.', '差額を支払手数料として確定してください。手数料でなければ一部入金として配分を直してください。'), buttons: [confirm(text('Confirm with fee', '手数料込みで確定')), edit, { label: text('Settings › fee tolerance', '設定 › 手数料の許容範囲'), action: { kind: 'open-settings', section: 'matching' } }] };
    case 'combined-payment': return { cause: text(`The total of ${first?.invoiceIds.length} invoices of ${customer} (${numbers}) matches the deposit.`, `${customer} の請求 ${first?.invoiceIds.length} 件（${numbers}）の合計が入金額と一致しました。`), next: text('Check the combination and confirm.', '組み合わせを確かめて確定してください。'), buttons: [confirm(text('Confirm combined', '合算で確定')), ...openFirstInvoice] };
    case 'combined-payment-with-fee': return { cause: text(`${yen(first?.difference)} yen less than the total of ${first?.invoiceIds.length} invoices (combined + transfer fee).`, `${first?.invoiceIds.length} 件の合計より ${yen(first?.difference)} 円少ない入金です（合算 + 振込手数料）。`), next: text('Check the combination and the fee, then confirm.', '組み合わせと手数料を確かめて確定してください。'), buttons: [confirm(text('Confirm', '確定')), edit] };
    case 'partial-payment': return { cause: text(`A deposit of ${yen(transaction.amount)} yen against ${numbers} (balance ${yen(first?.candidateTotal)} yen). It may be a partial payment.`, `${numbers}（残高 ${yen(first?.candidateTotal)} 円）に対して ${yen(transaction.amount)} 円の入金です。一部入金の可能性があります。`), next: text('Confirm as a partial payment, or keep it pending if the rest comes with another deposit.', '一部入金として確定してください（請求は「一部入金」になります）。別の入金と合わせて払われる予定なら保留のままにします。'), buttons: [confirm(text('Confirm partial payment', '一部入金で確定')), edit] };
    case 'name-partial': return { cause: text(`The payer name "${payer}" partly matches ${customer}, and the amount matches ${numbers}.`, `名義「${payer}」が ${customer} と一部だけ一致し、金額は ${numbers} と一致しました。`), next: text('If it is the same customer, confirm and remember the payer name.', '同じ相手なら確定し、名義を別名として覚えてください。'), buttons: [confirm(text('Confirm and remember the name', '確定して名義を覚える'), true), ...(first === undefined ? [] : [{ label: text('Open the customer', '取引先を開く'), action: { kind: 'open-customer' as const, customerId: first.customerId, section: 'customer' as const } }])] };
    case 'amount-only': return { cause: text(`The payer name "${payer}" matches no customer, but the amount matches ${numbers} of ${customer}.`, `名義「${payer}」はどの取引先とも一致しませんが、${customer} の ${numbers} と金額が一致しました。`), next: text('If it is the same customer, confirm and remember the name (next time it will be decided automatically).', '同じ相手なら確定し、名義を別名として覚えてください（次回からは自動で「決定」になります）。'), buttons: [confirm(text('Confirm and remember the name', '確定して名義を覚える'), true), ...(first === undefined ? [] : [aliases(first.customerId)])] };
    case 'no-candidate': return { cause: text('No unpaid invoice matches the amount and name.', '金額・名義が一致する未入金の請求がありません。'), next: text('If the invoice is not issued yet, issue it. If this is not a receivable (interest, refund), mark it as not a receivable.', '請求書が未発行なら発行してください。消込対象でない入金（利息・返金など）なら「対象外」にしてください。'), buttons: [{ label: text('Create an invoice', '請求書を作る'), action: { kind: 'new-invoice' } }, ignore, edit] };
    case 'no-open-invoice': return { cause: ids.length === 0 ? text('There are no unpaid invoices.', '未入金の請求がありません。') : text(`There are no unpaid invoices (all invoices of ${ids.map(lookup.customerName).join(', ')} are paid or issued after the deposit date).`, `未入金の請求がありません（${ids.map(lookup.customerName).join('、')} の請求はすべて入金済み、または入金日より後に発行）。`), next: text('Check for a missing invoice or an advance payment. Handle advances in the Journal.', '請求書の発行漏れか前受けかを確かめてください。前受金は仕訳側で処理します。'), buttons: [{ label: text('Create an invoice', '請求書を作る'), action: { kind: 'new-invoice' } }, { label: text('Open the Journal', '仕訳を開く'), action: { kind: 'open-journal' } }, ignore] };
    case 'multiple-candidates': return { cause: text(`${judgment.params?.['count'] ?? judgment.candidates.length} unpaid invoices have the same amount, so none can be chosen.`, `同じ金額の未入金請求が ${judgment.params?.['count'] ?? judgment.candidates.length} 件あり、どれか決められません。`), next: text("Pick one from the candidates. Registering the payer name as the customer's alias narrows it next time.", '候補から選んで確定してください。取引先の名義を別名に登録すると次回から絞れます。'), buttons: [edit, ...(first === undefined ? [] : [aliases(first.customerId)])] };
    case 'ambiguous-combination': return { cause: text(`${judgment.params?.['count'] ?? judgment.candidates.length} combinations of invoices add up to the deposit.`, `合計が入金額になる請求の組み合わせが ${judgment.params?.['count'] ?? judgment.candidates.length} 通りあります。`), next: text("Check the customer's remittance advice and pick from the candidates.", '取引先の支払通知で対象を確かめ、候補から選んでください。'), buttons: [edit] };
    case 'search-limit': return { cause: text(`Too many unpaid invoices to search all combinations (stopped at ${judgment.params?.['pool']} invoices / ${yen(judgment.params?.['evaluations'])} combinations).`, `未入金請求が多すぎて、組み合わせを探しきれませんでした（${judgment.params?.['pool']} 件 / ${yen(judgment.params?.['evaluations'])} 通りで打ち切り）。`), next: text('Pick the invoices and allocate manually.', '対象の請求を選んで手動で配分してください。'), buttons: [edit] };
    case 'alias-conflict': return { cause: text(`The payer name "${payer}" is registered for several customers (${ids.map(lookup.customerName).join(', ')}).`, `名義「${payer}」が複数の取引先（${ids.map(lookup.customerName).join('、')}）の別名 / カナに登録されています。`), next: text('Remove the alias from one of them.', 'どちらか一方から別名を消してください。'), buttons: ids.map(aliases) };
    case 'overpayment': return { cause: text(`${yen(judgment.params?.['excess'])} yen more than the balance of ${numbers} (${yen(first?.candidateTotal)} yen).`, `${numbers} の残高 ${yen(first?.candidateTotal)} 円より ${yen(judgment.params?.['excess'])} 円多い入金です。`), next: text('Check for an under-invoice or a double payment. Advances and refunds are handled in the Journal.', '請求の不足・二重払いを確かめてください。前受金 / 返金は仕訳側で処理します（入金消込では扱いません）。'), buttons: [...openFirstInvoice, { label: text('Open the Journal', '仕訳を開く'), action: { kind: 'open-journal' } }, ignore] };
    default: return { cause: judgment.reason, next: text('Judge again.', '再判定してください。'), buttons: [{ label: text('Judge again', '再判定'), action: { kind: 'rejudge' } }] };
  }
}

export function stageLabel(stage: string, text: Text): string {
  return stage === 'decided' ? text('Decided', '決定') : stage === 'candidate' ? text('Candidate', '候補') : text('Pending', '保留');
}

export function csvWarningMessage(warning: CsvWarningDto, text: Text): string {
  const p = warning.params;
  switch (warning.code) {
    case 'garbled-rows': return text(`Some rows look garbled (rows ${p['rows']}). Choose the character encoding and read the file again.`, `文字化けした行があります（${p['rows']} 行目）。文字コードを指定して読み直してください。`);
    case 'no-balance-column': return text('The file has no balance column, so deposits with the same date, amount, and payer name may be treated as duplicates. Import them from the duplicates list if needed.', '残高列が無いため、同じ日・同額・同名義の入金を重複と見なすことがあります。必要なら重複一覧から取り込んでください。');
    case 'detected-profile': return text(`Detected profile: ${p['profile']}`, `判定したプロファイル: ${p['profile']}`);
    case 'skipped-rows': return text(`${p['count']} of ${p['total']} rows could not be read.`, `${p['total']} 行のうち ${p['count']} 行を読めませんでした。`);
  }
}

export function mappingProblemLabel(problem: string, text: Text): string {
  return problem === 'date' ? text('Date column', '日付の列') : text('Deposit column or signed amount column', '入金の列 または 符号付き金額の列');
}

/* ---------------------------------------------------------------------------
 * 請求書フォーム
 * ------------------------------------------------------------------------ */

/** フォームの 1 行（入力途中の文字列を持つ）。 */
export interface LineForm {
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly amount: string;
  readonly taxRate: '' | '10' | '8' | '0';
  readonly zeroRateKind: '' | 'exempt' | 'non-taxable' | 'export';
}

export interface InvoiceForm {
  readonly customerId: string;
  readonly issueDate: string;
  readonly transactionDate: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly dueDate: string;
  readonly pricing: PricingDto;
  readonly lines: readonly LineForm[];
  readonly note: string;
  /** 取り込んだ税額（検査にだけ使う）。「計算値で置き換える」で消す。 */
  readonly declared?: SaveInvoiceDto['declared'];
  readonly customerNameHint?: string;
}

export const emptyLine = (taxRate: LineForm['taxRate'] = '10'): LineForm => ({ description: '', quantity: '', unit: '', unitPrice: '', amount: '', taxRate, zeroRateKind: '' });

export function newInvoiceForm(today: string, pricing: PricingDto): InvoiceForm {
  return { customerId: '', issueDate: today, transactionDate: today, periodFrom: '', periodTo: '', dueDate: '', pricing, lines: [emptyLine()], note: '' };
}

const numberOrUndefined = (value: string): number | undefined => {
  const trimmed = value.replace(/,/gu, '').trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function formToInvoice(form: InvoiceForm): SaveInvoiceDto {
  const optional = (value: string) => value.trim() === '' ? undefined : value.trim();
  const period = optional(form.periodFrom) !== undefined && optional(form.periodTo) !== undefined ? { from: form.periodFrom, to: form.periodTo } : undefined;
  return {
    ...(optional(form.customerId) === undefined ? {} : { customerId: form.customerId }),
    ...(optional(form.issueDate) === undefined ? {} : { issueDate: form.issueDate }),
    ...(optional(form.transactionDate) === undefined ? {} : { transactionDate: form.transactionDate }),
    ...(period === undefined ? {} : { transactionPeriod: period }),
    ...(optional(form.dueDate) === undefined ? {} : { dueDate: form.dueDate }),
    pricing: form.pricing,
    lines: form.lines.map((line): InvoiceLineDto => {
      const quantity = numberOrUndefined(line.quantity);
      const unitPrice = numberOrUndefined(line.unitPrice);
      const amount = numberOrUndefined(line.amount);
      return {
        description: line.description,
        ...(quantity === undefined ? {} : { quantity }),
        ...(line.unit.trim() === '' ? {} : { unit: line.unit.trim() }),
        ...(unitPrice === undefined ? {} : { unitPrice }),
        ...(amount === undefined ? {} : { amount }),
        ...(line.taxRate === '' ? {} : { taxRate: Number(line.taxRate) as TaxRateDto }),
        ...(line.zeroRateKind === '' || line.taxRate !== '0' ? {} : { zeroRateKind: line.zeroRateKind }),
      };
    }),
    ...(form.declared === undefined ? {} : { declared: form.declared }),
    ...(optional(form.note) === undefined ? {} : { note: form.note }),
  };
}

export function invoiceToForm(invoice: SaveInvoiceDto & { readonly customerNameHint?: string }): InvoiceForm {
  const text = (value: number | undefined) => value === undefined ? '' : String(value);
  return {
    customerId: invoice.customerId ?? '',
    issueDate: invoice.issueDate ?? '',
    transactionDate: invoice.transactionDate ?? '',
    periodFrom: invoice.transactionPeriod?.from ?? '',
    periodTo: invoice.transactionPeriod?.to ?? '',
    dueDate: invoice.dueDate ?? '',
    pricing: invoice.pricing,
    lines: invoice.lines.length === 0 ? [emptyLine()] : invoice.lines.map((line) => ({
      description: line.description, quantity: text(line.quantity), unit: line.unit ?? '', unitPrice: text(line.unitPrice), amount: text(line.amount),
      taxRate: line.taxRate === undefined ? '' : String(line.taxRate) as LineForm['taxRate'], zeroRateKind: line.zeroRateKind ?? '',
    })),
    note: invoice.note ?? '',
    ...(invoice.declared === undefined ? {} : { declared: invoice.declared }),
    ...(invoice.customerNameHint === undefined ? {} : { customerNameHint: invoice.customerNameHint }),
  };
}

/** 「JSON を貼り付け」（ツールの `draft_json`）。形が合わなければ理由を返す。 */
export function parsePastedInvoice(raw: string): { readonly ok: true; readonly invoice: SaveInvoiceDto & { readonly customerNameHint?: string } } | { readonly ok: false; readonly reason: 'json' | 'shape' } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: 'json' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'shape' };
  const record = value as Record<string, unknown>;
  if ((record['pricing'] !== 'exclusive' && record['pricing'] !== 'inclusive') || !Array.isArray(record['lines'])) return { ok: false, reason: 'shape' };
  if (record['lines'].some((line) => line === null || typeof line !== 'object' || typeof (line as Record<string, unknown>)['description'] !== 'string')) return { ok: false, reason: 'shape' };
  return { ok: true, invoice: record as unknown as SaveInvoiceDto & { customerNameHint?: string } };
}

/** 支払条件から期日の既定（発行日 + n 日）。 */
export function defaultDueDate(issueDate: string, customer: Pick<CustomerDto, 'paymentTermDays'> | undefined): string {
  if (customer?.paymentTermDays === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(issueDate)) return '';
  const [year, month, day] = issueDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + customer.paymentTermDays)).toISOString().slice(0, 10);
}

/** 配分編集のライブ表示: 合計 − 手数料 と入金額の差（0 なら確定できる）。 */
export function allocationBalance(depositAmount: number, allocations: readonly { readonly amount: number }[], fee: number): number {
  return allocations.reduce((sum, allocation) => sum + allocation.amount, 0) - fee - depositAmount;
}

/** 候補から判定時点の残高を作る（単独なら候補の残高合計、合算なら各配分 = 残高）。 */
export function expectedOutstandingOf(candidate: MatchCandidateDto): Readonly<Record<string, number>> {
  return candidate.invoiceIds.length === 1
    ? { [candidate.invoiceIds[0]!]: candidate.candidateTotal }
    : Object.fromEntries(candidate.allocations.map((allocation) => [allocation.invoiceId, allocation.amount]));
}

/** 仕訳の出所タグ → 出所（発行 / 消込）と参照 id。 */
export function journalOrigin(tags: readonly string[] | undefined): { readonly kind: 'invoice' | 'matching'; readonly id: string } | undefined {
  const tag = (tags ?? []).find((entry) => /^receivables:(invoice|matching):/u.test(entry));
  if (tag === undefined) return undefined;
  const [, kind, ...rest] = tag.split(':');
  return { kind: kind as 'invoice' | 'matching', id: rest.join(':') };
}

const SMALL_KANA: Readonly<Record<string, string>> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };

/**
 * 別名の入力中に見せる「照合に使う形」の目安（NFKC・ひらがな → カタカナ・小書き → 並字・法人略語と記号の除去・大文字）。
 * **正本はサーバーの `normalizePayerName`** で、保存後はサーバーの値を表示する（UI はバックエンドの層を import できないため簡易版）。
 */
export function previewPayerName(text: string): string {
  return text.normalize('NFKC').normalize('NFC')
    .replace(/[ぁ-ゖ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォッャュョヮヵヶ]/gu, (char) => SMALL_KANA[char] ?? char)
    .replace(/株式会社|有限会社|合同会社|[(（][株有][)）]/gu, '')
    .replace(/(^|[\s(（])(?:トクヒ|シユウ|ザイ|シヤ|ガク|フク|ドク|カブ|メ|シ|ド|イ|ソ|カ|ユ)[)）]/gu, '$1')
    .replace(/[(（](?:トクヒ|シユウ|ザイ|シヤ|ガク|フク|ドク|カブ|メ|シ|ド|イ|ソ|カ|ユ)(?=[\s)）]|$)/gu, '')
    .replace(/[ー－―‐\-−]/gu, 'ー')
    .replace(/[\s・、。，,.．()（）「」『』[\]［］/／]/gu, '')
    .toUpperCase();
}

/** 8% の明細に付ける軽減税率の印（印刷レイアウトは必ず付ける）。 */
export const REDUCED_RATE_MARK = '※';

export function isOpenInvoice(invoice: Pick<InvoiceDto, 'status'>): boolean {
  return invoice.status === 'issued' || invoice.status === 'partially_paid';
}

/** File → base64（生バイト。文字コードの判定はサーバーが行う）。 */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

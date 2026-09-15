/**
 * ドメイン: 承認済み申請 → 仕訳下書きの組み立て（純粋。docs/21 §8.2 / §20.12）。
 *
 * **1 明細 = 1 仕訳**。明細ごとに支払先・登録番号・インボイス区分が違い、仕訳の 1 エントリはインボイス区分を
 * 1 つしか持てないため。問題（科目が無い・内訳と金額の不一致など）が 1 件でもあれば**1 件も作らない**
 * （途中まで作ってから止まるのを避けるため、先に全明細を検査する）。端数は黙って寄せない。
 *
 * 実用化の差分（§20.12）:
 * - 下書きは出所 `source`（明細・会社払いの明細・仮払の支払・仮払の精算・振込）を持つ。仮払・振込の下書きは B が組む。
 * - 規程の `journal.departmentDimensionId` と申請者の部門の `journalDimensionValueId` がそろったときだけ、費用行へ部門の補助軸を入れる。
 * - 会社払いの明細を申請に含める運用（`card.acceptCorporatePaymentItems`）では、会社払いの明細の貸方を `card.creditAccountId` にする。
 */
import type { InvoiceStatus } from '../journal/document';
import { resolveInvoiceStatus, splitTotalsByRate, taxCodeForTransitional, transitionalDeductionRate } from '../journal/tax';
import { itemLabel, type ExpenseClaim } from './claim';
import type { ExpenseJournalLinkProblem } from './errors';
import { findDepartment, type ExpenseOrganization } from './organization';
import { findCategory, type ExpenseCategory, type ExpensePolicy, type ExpenseTaxRate } from './policy';
import { usableAmount, type ReceiptFacts } from './receipt-facts';

export interface ExpenseJournalDraftLine {
  readonly side: 'debit' | 'credit';
  readonly accountId: string;
  readonly taxCode: string;
  /** 税込整数、正。 */
  readonly amount: number;
  readonly partner?: string;
  /** 仕訳の補助軸 id → 値 id（例 { department: 'sales' }）。仕訳の JournalEntryLine.dimensionValues へそのまま写す。 */
  readonly dimensionValues?: Readonly<Record<string, string>>;
}

export const EXPENSE_JOURNAL_DRAFT_SOURCE_KINDS = ['claim-item', 'card-item', 'advance-payment', 'advance-settlement', 'payout'] as const;
export type ExpenseJournalDraftSourceKind = (typeof EXPENSE_JOURNAL_DRAFT_SOURCE_KINDS)[number];

export interface ExpenseJournalDraft {
  /** 出所。明細の下書きは `{ kind: 'claim-item' | 'card-item', id: claimId, itemId }`。 */
  readonly source: { readonly kind: ExpenseJournalDraftSourceKind; readonly id: string; readonly itemId?: string };
  /** YYYY-MM-DD。 */
  readonly date: string;
  readonly description: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly registrationNumber?: string;
  readonly lines: readonly ExpenseJournalDraftLine[];
  /** `['expense', 'expense-claim:<claimId>', 'expense-item:<itemId>']`（仕訳側で出所を表す）。 */
  readonly tags: readonly string[];
}

export interface JournalDraftsResult {
  readonly drafts: readonly ExpenseJournalDraft[];
  readonly problems: readonly ExpenseJournalLinkProblem[];
  /** 作成はするが人に見てほしい点（8% の経過措置の税区分など）。 */
  readonly warnings: readonly string[];
}

export interface JournalDraftOptions {
  /** 部門の補助軸の値を引く組織（省略 = 補助軸を入れない）。 */
  readonly organization?: Pick<ExpenseOrganization, 'departments'>;
  /** 会社払いの明細の貸方の取引先（カードの `issuerName ?? label`。B が分かるときに渡す）。 */
  readonly corporatePartner?: string;
}

/** 費目の要否と登録番号・取引日から、その明細のインボイス区分を決める。 */
export function invoiceStatusFor(facts: ReceiptFacts, category: Pick<ExpenseCategory, 'invoice'>): InvoiceStatus {
  const amount = usableAmount(facts);
  if (!category.invoice.required) return 'not_required';
  if (category.invoice.exemptBelow !== undefined && amount !== undefined && amount < category.invoice.exemptBelow) return 'not_required';
  return resolveInvoiceStatus({
    ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
    ...(facts.transactionDate === undefined ? {} : { transactionDate: facts.transactionDate }),
    direction: 'out',
    kind: 'receipt',
  });
}

/** 摘要テンプレートの置換。未知のキーは空にし、空白を詰める。 */
export function renderDescriptionTemplate(template: string, values: Readonly<Record<string, string | undefined>>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? '').replace(/\s+/gu, ' ').trim();
}

/** 税率ごとの税込金額。内訳が無ければ費目の既定税率で全額。 */
export function amountsByRate(facts: ReceiptFacts, category: Pick<ExpenseCategory, 'defaultTaxRate'>, amount: number): readonly { readonly rate: ExpenseTaxRate; readonly amount: number }[] {
  if (facts.totalsByRate === undefined || facts.totalsByRate.length === 0) return [{ rate: category.defaultTaxRate, amount }];
  const split = splitTotalsByRate({ totalsByRate: facts.totalsByRate });
  return ([[10, split.taxable10], [8, split.taxable8], [0, split.taxable0]] as const)
    .filter(([, value]) => value > 0)
    .map(([rate, value]) => ({ rate, amount: value }));
}

/**
 * 費用行に入れる部門の補助軸（規程の補助軸 id と、申請者の部門の値 id がそろったときだけ）。
 * どちらかが無ければ入れない（警告にしない。部門を使わない会社を煩わせないため）。
 */
export function departmentDimensionFor(claim: Pick<ExpenseClaim, 'claimant'>, policy: Pick<ExpensePolicy, 'journal'>, organization: Pick<ExpenseOrganization, 'departments'> | undefined): Readonly<Record<string, string>> | undefined {
  const dimensionId = policy.journal.departmentDimensionId;
  if (dimensionId === undefined || organization === undefined) return undefined;
  const valueId = findDepartment(organization, claim.claimant.departmentId)?.journalDimensionValueId;
  return valueId === undefined ? undefined : { [dimensionId]: valueId };
}

export function buildJournalDrafts(claim: ExpenseClaim, policy: ExpensePolicy, options: JournalDraftOptions = {}): JournalDraftsResult {
  const drafts: ExpenseJournalDraft[] = [];
  const problems: ExpenseJournalLinkProblem[] = [];
  const warnings: string[] = [];
  const dimensionValues = departmentDimensionFor(claim, policy, options.organization);

  for (const [index, item] of claim.items.entries()) {
    const label = itemLabel(item, index);
    const itemProblems: ExpenseJournalLinkProblem[] = [];
    const category = findCategory(policy, item.categoryId);
    if (category === undefined) {
      problems.push({ itemId: item.id, code: 'category-missing', message: `明細「${label}」の費目が決まっていません。明細の費目を選んでから作成してください`, fixTarget: 'item' });
      continue;
    }
    if (category.accountId === undefined) {
      itemProblems.push({ itemId: item.id, code: 'account-missing', message: `費目「${category.name}」に仕訳の科目がありません。規程の費目で科目を選んでください`, fixTarget: 'policy-category', categoryId: category.id });
    }
    const date = item.facts.transactionDate;
    const amount = usableAmount(item.facts);
    if (date === undefined) itemProblems.push({ itemId: item.id, code: 'date-missing', message: `明細「${label}」に取引日がありません。取引日を入力してから作成してください`, fixTarget: 'item' });
    if (amount === undefined) itemProblems.push({ itemId: item.id, code: 'amount-missing', message: `明細「${label}」に金額がありません。金額を入力してから作成してください`, fixTarget: 'item' });
    let rows: readonly { readonly rate: ExpenseTaxRate; readonly amount: number }[] = [];
    if (amount !== undefined) {
      rows = amountsByRate(item.facts, category, amount);
      const sum = rows.reduce((accumulated, row) => accumulated + row.amount, 0);
      if (sum !== amount) {
        itemProblems.push({ itemId: item.id, code: 'totals-mismatch', message: `明細「${label}」の税率別の内訳の合計 ${sum} 円が金額 ${amount} 円と一致しません。どちらかを直してから作成してください（端数は自動で寄せません）`, fixTarget: 'item' });
      }
      for (const row of rows) {
        if (category.taxCodeByRate[String(row.rate) as '10' | '8' | '0'] === undefined) {
          itemProblems.push({ itemId: item.id, code: 'tax-code-missing', message: `費目「${category.name}」に ${row.rate}% の税区分がありません。規程の費目で税区分を設定してください`, fixTarget: 'policy-category', categoryId: category.id });
        }
      }
    }
    if (itemProblems.length > 0 || date === undefined || amount === undefined || category.accountId === undefined) {
      problems.push(...itemProblems);
      continue;
    }

    const corporate = policy.card.acceptCorporatePaymentItems && item.facts.corporatePayment === true;
    const invoiceStatus = invoiceStatusFor(item.facts, category);
    const transitional = invoiceStatus === 'transitional' || invoiceStatus === 'none';
    const lines: ExpenseJournalDraftLine[] = rows.map((row) => {
      let taxCode = category.taxCodeByRate[String(row.rate) as '10' | '8' | '0'] as string;
      if (transitional && row.rate === 10) taxCode = taxCodeForTransitional(transitionalDeductionRate(date));
      if (transitional && row.rate === 8) {
        warnings.push(`明細「${label}」: 軽減税率の経過措置の税区分が無いため 8% の通常の税区分で作成しました。仕訳画面で直してください`);
      }
      return {
        side: 'debit', accountId: category.accountId as string, taxCode, amount: row.amount,
        ...(item.facts.payeeName === undefined ? {} : { partner: item.facts.payeeName }),
        ...(dimensionValues === undefined ? {} : { dimensionValues }),
      };
    });
    if (corporate) {
      // 会社払いの明細は従業員への未払ではなく、カード会社への未払（規程の card.creditAccountId）に立てる。
      lines.push({ side: 'credit', accountId: policy.card.creditAccountId, taxCode: policy.card.creditTaxCode, amount, ...(options.corporatePartner === undefined ? {} : { partner: options.corporatePartner }) });
    } else {
      const creditPartner = policy.journal.partnerFrom === 'claimant' ? claim.claimant.name : item.facts.payeeName;
      lines.push({ side: 'credit', accountId: policy.journal.creditAccountId, taxCode: policy.journal.creditTaxCode, amount, ...(creditPartner === undefined ? {} : { partner: creditPartner }) });
    }
    const description = renderDescriptionTemplate(policy.journal.descriptionTemplate, {
      claimant: claim.claimant.name, payee: item.facts.payeeName, category: category.name, purpose: item.facts.purpose, description: item.facts.description, claimId: claim.id,
    });
    drafts.push({
      source: { kind: corporate ? 'card-item' : 'claim-item', id: claim.id, itemId: item.id },
      date,
      description: description === '' ? category.name : description,
      invoiceStatus,
      ...(invoiceStatus === 'qualified' && item.facts.registrationNumber !== undefined ? { registrationNumber: item.facts.registrationNumber } : {}),
      lines,
      tags: ['expense', `expense-claim:${claim.id}`, `expense-item:${item.id}`, ...(corporate ? ['expense-card'] : [])],
    });
  }

  return problems.length > 0 ? { drafts: [], problems, warnings: [] } : { drafts, problems: [], warnings };
}

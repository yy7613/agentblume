/**
 * ドメイン: 精算 CSV の行組み立て（純粋。docs/21 §9）。
 *
 * UTF-8 BOM・CRLF・日付 `YYYY/MM/DD`・金額は税込整数（仕訳 §8 と同じ流儀）。
 * **状態を変えない**（精算済みの印は別の操作。支払いが済んだかは CSV を作った瞬間には分からないため）。
 * 黙って埋めないものは `warnings` に並べる（支払先の無い明細・仕訳下書きの無い申請・規程変更前の判定のまま承認）。
 */
import { toCsv } from '../journal/csv';
import { splitTotalsByRate, taxAmountFromInclusive } from '../journal/tax';
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from './business-date';
import { itemLabel, reimbursableAmount, type ExpenseClaim } from './claim';
import { invoiceStatusFor } from './journal-draft';
import { findCategory, type ExpensePolicy } from './policy';
import { usableAmount } from './receipt-facts';

export const SETTLEMENT_FORMATS = ['payout', 'detail'] as const;
export type SettlementFormat = (typeof SETTLEMENT_FORMATS)[number];

export const PAYOUT_COLUMNS = ['claim_id', 'claimant', 'employee_code', 'department', 'period_from', 'period_to', 'item_count', 'total_amount', 'approved_by', 'approved_at'] as const;
export const DETAIL_COLUMNS = [
  'claim_id', 'item_id', 'claimant', 'employee_code', 'department', 'transaction_date', 'date_source', 'payee', 'category_id', 'category', 'account_id',
  'amount', 'tax_10_amount', 'tax_8_amount', 'registration_number', 'invoice_status', 'payment_method', 'purpose', 'attendees', 'attendee_names',
  'unit_count', 'pre_approval_ref', 'description', 'receipt_file', 'acknowledged_codes', 'approved_by', 'approved_at', 'journal_entry_id',
] as const;

const UTF8_BOM = '﻿';

export interface SettlementCsvInput {
  readonly format: SettlementFormat;
  readonly claims: readonly ExpenseClaim[];
  readonly policy: ExpensePolicy;
  /** 出力日（YYYY-MM-DD。ファイル名に使う）。 */
  readonly today: string;
  readonly timeZone?: string;
}

export interface SettlementCsvResult {
  readonly format: SettlementFormat;
  readonly fileName: string;
  readonly content: string;
  readonly claimCount: number;
  readonly itemCount: number;
  readonly totalAmount: number;
  readonly warnings: readonly string[];
}

function slashDate(date: string | undefined): string {
  return date === undefined ? '' : date.replaceAll('-', '/');
}

/** 並べすぎると読めないので、警告に出す id は先頭の数件だけにする。 */
function sample(values: readonly string[]): string {
  return values.length <= 5 ? values.join(', ') : `${values.slice(0, 5).join(', ')} ほか ${values.length - 5} 件`;
}

export function buildSettlementCsv(input: SettlementCsvInput): SettlementCsvResult {
  const timeZone = input.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
  const approvedAt = (claim: ExpenseClaim): string => (claim.approval === undefined ? '' : slashDate(businessDateOf(new Date(claim.approval.at), timeZone)));
  let itemCount = 0;
  let totalAmount = 0;
  const rows: (string | number | undefined)[][] = [];
  const missingPayee: string[] = [];

  for (const claim of input.claims) {
    // 従業員へ支払う額（会社払いの明細を申請に含める運用では会社払いを除く。規程のフラグが off なら MVP と同じ合計。§20.2.3）。
    const claimTotal = reimbursableAmount(claim, input.policy);
    itemCount += claim.items.length;
    totalAmount += claimTotal;
    for (const [index, item] of claim.items.entries()) {
      if (item.facts.payeeName === undefined) missingPayee.push(`${claim.id}「${itemLabel(item, index)}」`);
    }
    if (input.format === 'payout') {
      rows.push([claim.id, claim.claimant.name, claim.claimant.employeeCode, claim.claimant.department, slashDate(claim.period.from), slashDate(claim.period.to), claim.items.length, claimTotal, claim.approval?.displayName ?? claim.approval?.by, approvedAt(claim)]);
      continue;
    }
    for (const item of claim.items) {
      const category = findCategory(input.policy, item.categoryId);
      const amount = usableAmount(item.facts);
      let tax10: number | undefined;
      let tax8: number | undefined;
      if (amount !== undefined) {
        if (item.facts.totalsByRate !== undefined && item.facts.totalsByRate.length > 0) {
          const split = splitTotalsByRate({ totalsByRate: item.facts.totalsByRate });
          tax10 = split.tax10;
          tax8 = split.tax8;
        } else if (category !== undefined) {
          tax10 = category.defaultTaxRate === 10 ? taxAmountFromInclusive(amount, 10) : 0;
          tax8 = category.defaultTaxRate === 8 ? taxAmountFromInclusive(amount, 8) : 0;
        }
      }
      rows.push([
        claim.id, item.id, claim.claimant.name, claim.claimant.employeeCode, claim.claimant.department,
        slashDate(item.facts.transactionDate), item.facts.dateSource, item.facts.payeeName, item.categoryId, category?.name, category?.accountId,
        amount, tax10, tax8, item.facts.registrationNumber, category === undefined ? undefined : invoiceStatusFor(item.facts, category),
        item.facts.corporatePayment === true ? 'corporate' : item.facts.paymentMethod, item.facts.purpose, item.facts.attendees?.count, item.facts.attendees?.names?.join(';'),
        item.facts.unitCount, item.facts.preApprovalRef, item.facts.description, item.receiptId === undefined ? undefined : (item.source.fileName ?? item.receiptId),
        claim.acknowledgements.filter((entry) => entry.itemId === item.id).map((entry) => entry.code).join(';'),
        claim.approval?.displayName ?? claim.approval?.by, approvedAt(claim),
        claim.journalLink?.entries.find((entry) => entry.itemId === item.id)?.entryId,
      ]);
    }
  }

  const warnings: string[] = [];
  if (missingPayee.length > 0) warnings.push(`支払先が無い明細が ${missingPayee.length} 件あります（電子帳簿保存法の検索要件「取引先」を満たしません）: ${sample(missingPayee)}`);
  const withoutJournal = input.claims.filter((claim) => claim.journalLink?.complete !== true).map((claim) => claim.id);
  if (withoutJournal.length > 0) warnings.push(`仕訳下書きを作成していない申請が ${withoutJournal.length} 件あります: ${sample(withoutJournal)}`);
  const oldPolicy = input.claims.filter((claim) => claim.judgment !== undefined && claim.judgment.policyUpdatedAt !== input.policy.updatedAt).map((claim) => claim.id);
  if (oldPolicy.length > 0) warnings.push(`規程を変更する前の規程で判定したまま承認された申請が ${oldPolicy.length} 件あります: ${sample(oldPolicy)}`);

  const header = input.format === 'payout' ? [...PAYOUT_COLUMNS] : [...DETAIL_COLUMNS];
  return {
    format: input.format,
    fileName: `expense-${input.format}-${input.today}.csv`,
    content: UTF8_BOM + toCsv([header, ...rows]),
    claimCount: input.claims.length,
    itemCount,
    totalAmount,
    warnings,
  };
}

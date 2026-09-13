/**
 * ドメイン: ルールの outcome から仕訳草案を組み立てる（純関数）。
 *
 * 金額指定（total / taxable:10 / taxable:8 / tax:10 / tax:8 / remainder / { fixed } / { ratio }）を facts の
 * 金額に解決し、科目名をマスタから写し、摘要テンプレートを置換し、インボイス区分を決める。
 * 組み立てられない理由（消えた科目・貸借不一致・金額や日付の欠落）はエラーではなく
 * `UndecidedReason` で返す（判定結果の一部になる）。
 */
import { findAccount, findTaxCategory, type ChartOfAccounts } from './chart-of-accounts';
import { readFactPath } from './conditions';
import type { DocumentFacts, DocumentKind, UndecidedReason } from './document';
import { entryTotals, type JournalEntryDraft, type JournalEntryLine } from './entry';
import type { AmountSpec, JournalRule, OutcomeLine } from './rule';
import { resolveInvoiceStatus, splitTotalsByRate, taxAmountFromInclusive } from './tax';

export interface BuildEntryInput {
  readonly rule: JournalRule;
  readonly facts: DocumentFacts;
  /** 帳票種別。インボイス区分の自動判定に使う。 */
  readonly kind?: DocumentKind;
  readonly chart: ChartOfAccounts;
  /** 取引日が無いときにインボイス区分を決める基準日（`YYYY-MM-DD`）。 */
  readonly today?: string;
}

export type BuildEntryResult =
  | { readonly ok: true; readonly entry: JournalEntryDraft }
  | { readonly ok: false; readonly reason: UndecidedReason };

/** 摘要テンプレートの置換。無い値は空文字。 */
export function renderDescriptionTemplate(template: string, facts: DocumentFacts): string {
  return template.replace(/\{([^{}]*)\}/gu, (_match, raw: string) => {
    const value = readFactPath(facts, raw.trim());
    if (value === undefined || value === null || Array.isArray(value)) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }).replace(/\s+/gu, ' ').trim();
}

function resolveAmount(spec: AmountSpec, total: number, split: ReturnType<typeof splitTotalsByRate>): number | undefined {
  if (typeof spec === 'string') {
    switch (spec) {
      case 'total': return total;
      case 'taxable:10': return split.taxable10;
      case 'taxable:8': return split.taxable8;
      case 'tax:10': return split.tax10;
      case 'tax:8': return split.tax8;
      case 'remainder': return undefined; // 他行の解決後に埋める
      default: return undefined;
    }
  }
  if ('fixed' in spec) return spec.fixed;
  return Math.round(total * spec.ratio);
}

function partnerOf(line: OutcomeLine, facts: DocumentFacts): string | undefined {
  if (line.partnerFrom === undefined) return undefined;
  if (line.partnerFrom === 'issuerName') return facts.issuerName;
  if (line.partnerFrom === 'counterpartyHint') return facts.counterpartyHint ?? facts.issuerName;
  return line.partnerFrom.fixed;
}

/**
 * ルールと facts から仕訳草案を作る。
 * - 科目が無い / 無効 → `unknown-account`
 * - 金額の元になる `grandTotal` や日付が無い → `missing-fact`
 * - 借方合計 ≠ 貸方合計（remainder が負になる場合を含む）→ `unbalanced`
 */
export function buildEntryFromRule(input: BuildEntryInput): BuildEntryResult {
  const { rule, facts, chart } = input;
  const missing: string[] = [];
  const date = facts.transactionDate ?? facts.issueDate;
  if (date === undefined) missing.push('transactionDate');
  if (facts.grandTotal === undefined) missing.push('grandTotal');
  if (missing.length > 0) return { ok: false, reason: { code: 'missing-fact', ruleId: rule.id, facts: missing } };

  const unknownAccounts = rule.outcome.lines
    .map((line) => line.accountId)
    .filter((accountId, index, all) => all.indexOf(accountId) === index)
    .filter((accountId) => { const account = findAccount(chart, accountId); return account === undefined || !account.enabled; });
  if (unknownAccounts.length > 0) return { ok: false, reason: { code: 'unknown-account', ruleId: rule.id, accountIds: unknownAccounts } };

  const total = facts.grandTotal!;
  const split = splitTotalsByRate(facts);
  const resolved: (number | undefined)[] = rule.outcome.lines.map((line) => resolveAmount(line.amount, total, split));
  // remainder: 同じ側の他行の合計を total から引く（1 側に複数の remainder は等分せず最初の 1 行だけが埋まる）。
  for (const [index, line] of rule.outcome.lines.entries()) {
    if (line.amount !== 'remainder') continue;
    const others = rule.outcome.lines.reduce((sum, other, otherIndex) => (otherIndex !== index && other.side === line.side ? sum + (resolved[otherIndex] ?? 0) : sum), 0);
    resolved[index] = total - others;
  }

  const lines: JournalEntryLine[] = [];
  for (const [index, line] of rule.outcome.lines.entries()) {
    const amount = resolved[index];
    if (amount === undefined || !Number.isInteger(amount) || amount <= 0) return { ok: false, reason: { code: 'unbalanced', ruleId: rule.id } };
    const account = findAccount(chart, line.accountId)!;
    const taxCategory = findTaxCategory(chart, line.taxCode);
    const taxAmount = taxCategory?.rate !== undefined && taxCategory.rate > 0 ? taxAmountFromInclusive(amount, taxCategory.rate) : undefined;
    const partner = partnerOf(line, facts);
    lines.push({
      side: line.side,
      accountId: account.id,
      accountName: account.name,
      ...(line.dimensionValues === undefined ? {} : { dimensionValues: { ...line.dimensionValues } }),
      taxCode: line.taxCode,
      amount,
      ...(taxAmount === undefined ? {} : { taxAmount }),
      ...(partner === undefined || partner.length === 0 ? {} : { partner }),
    });
  }
  const totals = entryTotals(lines);
  if (totals.debit !== totals.credit || totals.debit === 0) return { ok: false, reason: { code: 'unbalanced', ruleId: rule.id } };

  const template = rule.outcome.descriptionTemplate ?? '{description}';
  const description = renderDescriptionTemplate(template, facts) || facts.description?.trim() || facts.issuerName?.trim() || rule.name;
  const invoiceStatus = rule.outcome.invoiceStatus === undefined || rule.outcome.invoiceStatus === 'auto'
    ? resolveInvoiceStatus({
      ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
      ...(facts.transactionDate === undefined ? {} : { transactionDate: facts.transactionDate }),
      ...(facts.direction === undefined ? {} : { direction: facts.direction }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    }, input.today)
    : rule.outcome.invoiceStatus;

  return {
    ok: true,
    entry: {
      date: date!,
      lines,
      description,
      invoiceStatus,
      ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
    },
  };
}

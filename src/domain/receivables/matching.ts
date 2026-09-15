/**
 * ドメイン: 入金の消込判定（docs/22 §4.1〜§4.3 / ADR-0041 決定 1）。純関数（I/O もモデル呼び出しも持たない）。
 *
 * 結果は `decided`（決定）/ `candidate`（候補付き保留。人が確定する）/ `unmatched`（保留）と、**理由コード 1 つ**。
 * 評価順は固定で、最初に当たった理由だけを返す（1 つの入金に効く理由を並べると、画面の「次の一手」が定まらない）。
 *
 * `decided` は「入金額 = 請求残高」かつ「名義が別名 / カナ / 社名で完全一致」かつ「その候補がちょうど 1 件」だけ。
 * 手数料差額・合算・一部入金・名義の部分一致・金額だけの一致は、計算上一意でも人が確かめる。
 * 名義が一致しない入金では合算と手数料差額を探さない（全取引先の組み合わせは偶然の一致が多く、誤誘導の方が大きい）。
 */
import { findCombinations, HARD_MAX_EVALUATIONS, HARD_MAX_POOL, type FoundCombination } from './combinations';
import type { PayerAlias } from './customer';
import { normalizePayerName } from './payer-name';
import { HARD_MAX_COMBINATION_SIZE, type ReceivablesSettings } from './settings';

export const MATCH_STAGES = ['decided', 'candidate', 'unmatched'] as const;
export type MatchStage = (typeof MATCH_STAGES)[number];
export const DECIDED_REASONS = ['exact-amount-and-name'] as const;
export const CANDIDATE_REASONS = ['fee-difference', 'combined-payment', 'combined-payment-with-fee', 'partial-payment', 'name-partial', 'amount-only'] as const;
export const UNMATCHED_REASONS = ['no-candidate', 'no-open-invoice', 'multiple-candidates', 'ambiguous-combination', 'search-limit', 'alias-conflict', 'overpayment'] as const;
export type CandidateReason = (typeof CANDIDATE_REASONS)[number];
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];
export type MatchReason = (typeof DECIDED_REASONS)[number] | CandidateReason | UnmatchedReason;

export const NAME_MATCHES = ['alias', 'kana', 'name', 'partial', 'none'] as const;
export type NameMatch = (typeof NAME_MATCHES)[number];
const NAME_SCORES: Readonly<Record<NameMatch, number>> = { alias: 1, kana: 1, name: 0.9, partial: 0.6, none: 0 };

/** 参考候補として返す上限。 */
export const MAX_REFERENCE_CANDIDATES = 5;

export interface MatchAllocation {
  readonly invoiceId: string;
  readonly amount: number;
}

export interface MatchCandidate {
  /** 合算なら複数（期日の古い順）。 */
  readonly invoiceIds: readonly string[];
  readonly allocations: readonly MatchAllocation[];
  /** 対象請求の残高合計。 */
  readonly candidateTotal: number;
  /** candidateTotal − 入金額（正 = 不足）。 */
  readonly difference: number;
  /** 手数料差額として扱う額（0 以上。不足が許容範囲のときだけ）。 */
  readonly feeAmount: number;
  readonly customerId: string;
  readonly nameMatch: NameMatch;
  readonly nameScore: number;
  /** 1 始まり。 */
  readonly rank: number;
}

export type MatchJudgment =
  | { readonly stage: 'decided'; readonly reason: 'exact-amount-and-name'; readonly candidates: readonly MatchCandidate[]; readonly params?: Readonly<Record<string, string | number>> }
  | { readonly stage: 'candidate'; readonly reason: CandidateReason; readonly candidates: readonly MatchCandidate[]; readonly params?: Readonly<Record<string, string | number>> }
  | { readonly stage: 'unmatched'; readonly reason: UnmatchedReason; readonly candidates: readonly MatchCandidate[]; readonly params?: Readonly<Record<string, string | number>> };

/** 判定に要る請求の部分。 */
export interface OpenInvoiceView {
  readonly id: string;
  readonly customerId: string;
  readonly outstanding: number;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly status: string;
}

/** 判定に要る取引先の部分。 */
export interface MatchCustomer {
  readonly id: string;
  readonly name: string;
  readonly kana?: string;
  readonly payerAliases: readonly Pick<PayerAlias, 'normalized'>[];
  readonly enabled: boolean;
}

export interface JudgeTransactionInput {
  readonly transaction: { readonly amount: number; readonly date: string; readonly payerNameNorm: string };
  readonly openInvoices: readonly OpenInvoiceView[];
  readonly customers: readonly MatchCustomer[];
  readonly settings: Pick<ReceivablesSettings, 'matching'>;
}

/** 期日の古い順（期日なしは末尾）→ 発行日 → id。合算の候補の並びと、探索のプールの切り詰めに使う。 */
export function compareByDue(left: OpenInvoiceView, right: OpenInvoiceView): number {
  if (left.dueDate !== right.dueDate) {
    if (left.dueDate === undefined) return 1;
    if (right.dueDate === undefined) return -1;
    return left.dueDate < right.dueDate ? -1 : 1;
  }
  if (left.issueDate !== right.issueDate) return left.issueDate < right.issueDate ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 取引先ごとの最良の名義一致（§4.2 の表）。 */
export function nameMatchOf(payerNameNorm: string, customer: MatchCustomer, partialMinLength: number): NameMatch {
  if (payerNameNorm === '') return 'none';
  if (customer.payerAliases.some((alias) => alias.normalized === payerNameNorm)) return 'alias';
  const kana = normalizePayerName(customer.kana);
  if (kana !== '' && kana === payerNameNorm) return 'kana';
  const name = normalizePayerName(customer.name);
  if (name !== '' && name === payerNameNorm) return 'name';
  const partial = [kana, name, ...customer.payerAliases.map((alias) => alias.normalized)].some((key) => {
    if (key === '') return false;
    const [shorter, longer] = key.length <= payerNameNorm.length ? [key, payerNameNorm] : [payerNameNorm, key];
    return shorter.length >= partialMinLength && longer.includes(shorter);
  });
  return partial ? 'partial' : 'none';
}

function single(invoice: OpenInvoiceView, amount: number, nameMatch: NameMatch, allocation: number, feeAmount: number, rank = 1): MatchCandidate {
  return {
    invoiceIds: [invoice.id], allocations: [{ invoiceId: invoice.id, amount: allocation }],
    candidateTotal: invoice.outstanding, difference: invoice.outstanding - amount, feeAmount,
    customerId: invoice.customerId, nameMatch, nameScore: NAME_SCORES[nameMatch], rank,
  };
}

function combined(found: FoundCombination, byId: ReadonlyMap<string, OpenInvoiceView>, customerId: string, nameMatch: NameMatch, rank: number): MatchCandidate {
  return {
    invoiceIds: found.ids,
    allocations: found.ids.map((id) => ({ invoiceId: id, amount: byId.get(id)!.outstanding })),
    candidateTotal: found.total, difference: found.difference, feeAmount: Math.max(found.difference, 0),
    customerId, nameMatch, nameScore: NAME_SCORES[nameMatch], rank,
  };
}

const ranked = (candidates: readonly MatchCandidate[]): readonly MatchCandidate[] =>
  candidates.slice(0, MAX_REFERENCE_CANDIDATES).map((candidate, index) => ({ ...candidate, rank: index + 1 }));

/** §4.3 の評価順で判定する。 */
export function judgeTransaction(input: JudgeTransactionInput): MatchJudgment {
  const { transaction, settings } = input;
  const { feeTolerance: fee, maxCombinationSize, partialNameMinLength } = settings.matching;
  const amount = transaction.amount;
  const customers = input.customers.filter((customer) => customer.enabled);
  const open = input.openInvoices
    .filter((invoice) => (invoice.status === 'issued' || invoice.status === 'partially_paid') && invoice.outstanding > 0 && invoice.issueDate <= transaction.date)
    .slice()
    .sort(compareByDue);
  const nameMatches = new Map(customers.map((customer) => [customer.id, nameMatchOf(transaction.payerNameNorm, customer, partialNameMinLength)]));
  const nameOf = (customerId: string): NameMatch => nameMatches.get(customerId) ?? 'none';
  const matchedCustomers = customers.filter((customer) => nameOf(customer.id) !== 'none');

  // #0: 未入金の請求が無い。名義で分かる取引先があれば、画面が「その取引先の請求はすべて入金済み」と言えるよう載せる。
  if (open.length === 0) {
    return { stage: 'unmatched', reason: 'no-open-invoice', candidates: [], ...(matchedCustomers.length === 0 ? {} : { params: { customerIds: matchedCustomers.map((customer) => customer.id).join(',') } }) };
  }

  // #1: 同じ名義が複数の取引先の別名 / カナに登録されている。どちらにも寄せない。
  const strong = customers.filter((customer) => nameOf(customer.id) === 'alias' || nameOf(customer.id) === 'kana');
  if (strong.length >= 2) return { stage: 'unmatched', reason: 'alias-conflict', candidates: [], params: { customerIds: strong.map((customer) => customer.id).join(',') } };

  // #2〜#6: 名義で絞れた取引先の請求だけを見る。
  const inScope = new Set(matchedCustomers.map((customer) => customer.id));
  const scoped = open.filter((invoice) => inScope.has(invoice.customerId));
  if (matchedCustomers.length > 0) {
    // #3: 同額の単独候補。
    const exact = scoped.filter((invoice) => invoice.outstanding === amount);
    if (exact.length === 1) {
      const nameMatch = nameOf(exact[0]!.customerId);
      const candidate = single(exact[0]!, amount, nameMatch, amount, 0);
      return nameMatch === 'partial'
        ? { stage: 'candidate', reason: 'name-partial', candidates: [candidate] }
        : { stage: 'decided', reason: 'exact-amount-and-name', candidates: [candidate] };
    }
    if (exact.length >= 2) {
      return { stage: 'unmatched', reason: 'multiple-candidates', candidates: ranked(exact.map((invoice) => single(invoice, amount, nameOf(invoice.customerId), amount, 0))), params: { count: exact.length } };
    }

    // #4: 手数料差額の単独候補。
    const withFee = scoped.filter((invoice) => {
      const shortfall = invoice.outstanding - amount;
      return shortfall >= fee.min && shortfall <= fee.max && shortfall > 0;
    });
    if (withFee.length === 1) {
      const invoice = withFee[0]!;
      return { stage: 'candidate', reason: 'fee-difference', candidates: [single(invoice, amount, nameOf(invoice.customerId), invoice.outstanding, invoice.outstanding - amount)] };
    }
    if (withFee.length >= 2) {
      return { stage: 'unmatched', reason: 'multiple-candidates', candidates: ranked(withFee.map((invoice) => single(invoice, amount, nameOf(invoice.customerId), invoice.outstanding, invoice.outstanding - amount))), params: { count: withFee.length } };
    }

    // #5: 取引先ごとの合算。
    const size = Math.min(maxCombinationSize, HARD_MAX_COMBINATION_SIZE);
    const byId = new Map(scoped.map((invoice) => [invoice.id, invoice]));
    const exactCombos: MatchCandidate[] = [];
    const feeCombos: MatchCandidate[] = [];
    let limited = false;
    let evaluations = 0;
    for (const customer of matchedCustomers) {
      const items = scoped.filter((invoice) => invoice.customerId === customer.id).map((invoice) => ({ id: invoice.id, amount: invoice.outstanding }));
      if (items.length < 2) continue;
      const search = findCombinations(items, amount, fee, size, HARD_MAX_EVALUATIONS);
      limited = limited || search.truncated || search.exhausted;
      evaluations += search.evaluations;
      const nameMatch = nameOf(customer.id);
      exactCombos.push(...search.exact.map((found) => combined(found, byId, customer.id, nameMatch, 0)));
      feeCombos.push(...search.withFee.map((found) => combined(found, byId, customer.id, nameMatch, 0)));
    }
    if (exactCombos.length >= 2) return { stage: 'unmatched', reason: 'ambiguous-combination', candidates: ranked(exactCombos), params: { count: exactCombos.length } };
    if (exactCombos.length === 1) return { stage: 'candidate', reason: 'combined-payment', candidates: ranked(exactCombos) };
    if (limited) return { stage: 'unmatched', reason: 'search-limit', candidates: [], params: { pool: HARD_MAX_POOL, evaluations: HARD_MAX_EVALUATIONS, evaluated: evaluations } };
    if (feeCombos.length >= 2) return { stage: 'unmatched', reason: 'ambiguous-combination', candidates: ranked(feeCombos), params: { count: feeCombos.length } };
    if (feeCombos.length === 1) return { stage: 'candidate', reason: 'combined-payment-with-fee', candidates: ranked(feeCombos) };

    // #6: 名義の取引先が 1 社で、未入金請求が 1 件だけ。
    if (matchedCustomers.length === 1 && scoped.length === 1) {
      const invoice = scoped[0]!;
      const nameMatch = nameOf(invoice.customerId);
      if (amount < invoice.outstanding - fee.max) {
        return { stage: 'candidate', reason: 'partial-payment', candidates: [{ ...single(invoice, amount, nameMatch, amount, 0) }] };
      }
      if (amount > invoice.outstanding) {
        return { stage: 'unmatched', reason: 'overpayment', candidates: [single(invoice, amount, nameMatch, invoice.outstanding, 0)], params: { excess: amount - invoice.outstanding } };
      }
    }
  }

  // #7: 名義で決まらない。全取引先の同額だけを見る（合算・手数料は探さない）。
  const amountOnly = open.filter((invoice) => invoice.outstanding === amount);
  if (amountOnly.length === 1) {
    const invoice = amountOnly[0]!;
    return { stage: 'candidate', reason: 'amount-only', candidates: [single(invoice, amount, nameOf(invoice.customerId), amount, 0)] };
  }
  if (amountOnly.length >= 2) {
    return { stage: 'unmatched', reason: 'multiple-candidates', candidates: ranked(amountOnly.map((invoice) => single(invoice, amount, nameOf(invoice.customerId), amount, 0))), params: { count: amountOnly.length } };
  }
  return { stage: 'unmatched', reason: 'no-candidate', candidates: [] };
}

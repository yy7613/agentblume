/**
 * ドメイン: 法人カード利用と明細の照合（docs/21 §20.3.5。UC5。純関数）。
 *
 * 1. 候補の組: カード利用（金額 > 0）× 明細（取引日と金額がある）で、金額差 ≤ 許容差・日付差 ≤ 許容日数。
 *    カードの保有者と申請者の従業員が両方あって違う組は除く（共用カードは保有者を空にする）。
 * 2. 強さ: 加盟店キーと支払先キーが両方あり、等しいか一方が他方を含む（短い方が 3 文字以上）→ strong。
 *    どちらかが空 → weak。両方あって食い違う → 金額が弱い一致の最低金額以上なら weak、未満なら組にしない。
 * 3. 1 対 1: 強さ → |日付差| → |金額差| → 利用日 → カード利用 id → 申請 id → 明細 id の昇順に並べ、使っていない組を先頭から採る。
 * 4. 種類: 明細が会社払いなら `corporate-item`（正常）、そうでなければ `reimbursement-item`（二重計上の疑い）。
 *
 * 判定（`check-money.ts`）と照合の保存（application の `match-card-transactions.ts`）が同じ関数を使う。
 */
import { daysBetween } from '../business-date';
import type { CardMatchKind, CardMatchStrength } from '../card';

export interface CardMatchTransaction {
  readonly id: string;
  readonly cardId: string;
  readonly usedOn: string;
  readonly merchantKey: string;
  readonly amount: number;
}

export interface CardMatchItem {
  readonly claimId: string;
  readonly itemId: string;
  readonly employeeId?: string;
  readonly transactionDate: string;
  readonly amount: number;
  readonly payeeKey?: string;
  readonly corporate: boolean;
}

export interface CardMatchTolerance {
  readonly dateToleranceDays: number;
  readonly amountToleranceYen: number;
  readonly weakMatchMinAmount: number;
}

export interface CardMatchAssignment {
  readonly transactionId: string;
  readonly claimId: string;
  readonly itemId: string;
  readonly kind: CardMatchKind;
  readonly strength: CardMatchStrength;
  /** 取引日 → 利用日の日数（利用日が後なら正）。 */
  readonly dateDiffDays: number;
  /** カード利用の金額 − 明細の金額。 */
  readonly amountDiff: number;
}

export interface MatchCardTransactionsInput {
  readonly transactions: readonly CardMatchTransaction[];
  readonly items: readonly CardMatchItem[];
  /** カードの保有者（見つからないカードは共用として扱う）。 */
  readonly cards: readonly { readonly id: string; readonly holderEmployeeId?: string }[];
  readonly tolerance: CardMatchTolerance;
}

/** 照合で包含を認める短い方のキーの最小文字数。 */
export const CARD_MERCHANT_CONTAINS_MIN_CHARS = 3;

const STRENGTH_ORDER: Readonly<Record<CardMatchStrength, number>> = { strong: 0, weak: 1 };

function charCount(text: string): number {
  return [...text].length;
}

/** 明細の一意キー（申請 id と明細 id の組）。 */
export function cardItemKey(claimId: string, itemId: string): string {
  return `${claimId}${itemId}`;
}

/** 加盟店キーと支払先キーから一致の強さを決める。組にしないなら undefined。 */
export function cardMatchStrength(merchantKey: string | undefined, payeeKey: string | undefined, amount: number, weakMatchMinAmount: number): CardMatchStrength | undefined {
  const merchant = merchantKey ?? '';
  const payee = payeeKey ?? '';
  if (merchant === '' || payee === '') return 'weak';
  if (merchant === payee) return 'strong';
  const [shorter, longer] = charCount(merchant) <= charCount(payee) ? [merchant, payee] : [payee, merchant];
  if (charCount(shorter) >= CARD_MERCHANT_CONTAINS_MIN_CHARS && longer.includes(shorter)) return 'strong';
  return amount >= weakMatchMinAmount ? 'weak' : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Candidate extends CardMatchAssignment {
  readonly usedOn: string;
}

/** 候補の組を作って 1 対 1 に割り当てる（並びは割り当ての優先順）。 */
export function matchCardTransactions(input: MatchCardTransactionsInput): readonly CardMatchAssignment[] {
  const { tolerance } = input;
  const holders = new Map(input.cards.map((card) => [card.id, card.holderEmployeeId]));
  const candidates: Candidate[] = [];
  for (const transaction of input.transactions) {
    if (transaction.amount <= 0) continue;
    const holder = holders.get(transaction.cardId);
    for (const item of input.items) {
      if (item.amount <= 0) continue;
      const amountDiff = transaction.amount - item.amount;
      if (Math.abs(amountDiff) > tolerance.amountToleranceYen) continue;
      const dateDiffDays = daysBetween(item.transactionDate, transaction.usedOn);
      if (Math.abs(dateDiffDays) > tolerance.dateToleranceDays) continue;
      if (holder !== undefined && item.employeeId !== undefined && holder !== item.employeeId) continue;
      const strength = cardMatchStrength(transaction.merchantKey, item.payeeKey, transaction.amount, tolerance.weakMatchMinAmount);
      if (strength === undefined) continue;
      candidates.push({
        transactionId: transaction.id, claimId: item.claimId, itemId: item.itemId,
        kind: item.corporate ? 'corporate-item' : 'reimbursement-item', strength, dateDiffDays, amountDiff, usedOn: transaction.usedOn,
      });
    }
  }
  candidates.sort((left, right) => STRENGTH_ORDER[left.strength] - STRENGTH_ORDER[right.strength]
    || Math.abs(left.dateDiffDays) - Math.abs(right.dateDiffDays)
    || Math.abs(left.amountDiff) - Math.abs(right.amountDiff)
    || compareText(left.usedOn, right.usedOn)
    || compareText(left.transactionId, right.transactionId)
    || compareText(left.claimId, right.claimId)
    || compareText(left.itemId, right.itemId));
  const usedTransactions = new Set<string>();
  const usedItems = new Set<string>();
  const assignments: CardMatchAssignment[] = [];
  for (const { usedOn: _usedOn, ...candidate } of candidates) {
    const itemKey = cardItemKey(candidate.claimId, candidate.itemId);
    if (usedTransactions.has(candidate.transactionId) || usedItems.has(itemKey)) continue;
    usedTransactions.add(candidate.transactionId);
    usedItems.add(itemKey);
    assignments.push(candidate);
  }
  return assignments;
}

/** 日付がどれかの区間（両端を含む）に入るか。 */
export function dateInRanges(date: string, ranges: readonly { readonly from: string; readonly to: string }[]): boolean {
  return ranges.some((range) => range.from <= date && date <= range.to);
}

/**
 * ドメイン: 重複検出の鍵（純関数。docs/21 §3.4）。
 *
 * - 強い鍵: 支払先キー × 取引日 × 金額。支払先キーは仕訳の `normalizeDescription`（NFKC・法人略号除去・空白圧縮）を
 *   さらに空白除去・小文字化したもの（半角カナと全角カナ、`株式会社` の有無が同じ鍵になる）。
 * - 弱い鍵: どちらかの支払先が空のとき 取引日 × 金額 × 費目。精算書の読取で支払先が空になる実測があり、
 *   別の取引を誤って差し戻さないよう、弱い鍵の一致は判定側で常に要確認にする。
 * - 金額の許容差は持たない（1 円違いは別の取引）。
 *
 * 索引（`expense_item_keys`）と判定の両方がこの鍵を使うので、ここ 1 か所に置く。
 */
import { normalizeDescription } from '../journal/normalize';
import type { ExpenseItem } from './claim';
import { usableAmount } from './receipt-facts';

/** 他の申請の明細（application が索引から集める）。 */
export interface DuplicateCandidate {
  readonly claimId: string;
  readonly itemId: string;
  readonly claimStatus: string;
  readonly claimantName: string;
  readonly payeeKey?: string;
  readonly transactionDate?: string;
  readonly amount?: number;
  readonly categoryId?: string;
  readonly receiptSha256?: string;
}

/** 明細 1 件の照合キー（索引の 1 行と同じ形）。 */
export interface ItemKey {
  readonly transactionDate?: string;
  readonly amount?: number;
  readonly payeeKey?: string;
  readonly categoryId?: string;
  readonly receiptSha256?: string;
}

/** 支払先の照合キー。空なら undefined。 */
export function payeeKeyOf(name: string | undefined): string | undefined {
  const key = normalizeDescription(name).replace(/\s+/gu, '').toLowerCase();
  return key === '' ? undefined : key;
}

export function itemKeyOf(item: Pick<ExpenseItem, 'facts' | 'categoryId'>, receiptSha256?: string): ItemKey {
  const amount = usableAmount(item.facts);
  const payeeKey = payeeKeyOf(item.facts.payeeName);
  return {
    ...(item.facts.transactionDate === undefined ? {} : { transactionDate: item.facts.transactionDate }),
    ...(amount === undefined ? {} : { amount }),
    ...(payeeKey === undefined ? {} : { payeeKey }),
    ...(item.categoryId === undefined ? {} : { categoryId: item.categoryId }),
    ...(receiptSha256 === undefined ? {} : { receiptSha256 }),
  };
}

/** 2 つの鍵が同じ取引を指すか。取引日と金額が揃わなければ比べない。 */
export function matchKeys(left: ItemKey, right: ItemKey): 'strong' | 'weak' | undefined {
  if (left.transactionDate === undefined || left.amount === undefined) return undefined;
  if (left.transactionDate !== right.transactionDate || left.amount !== right.amount) return undefined;
  if (left.payeeKey !== undefined && right.payeeKey !== undefined) return left.payeeKey === right.payeeKey ? 'strong' : undefined;
  return left.categoryId !== undefined && left.categoryId === right.categoryId ? 'weak' : undefined;
}

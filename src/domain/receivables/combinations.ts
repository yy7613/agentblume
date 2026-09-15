/**
 * ドメイン: 合算入金の組み合わせ探索（docs/22 §4.4 / ADR-0041 決定 3）。純関数。
 *
 * 対象は**1 取引先の**未入金請求だけ。部分集合は 2^n あるので、上限を置かないと 1 回の判定がリクエストを塞ぐ。
 * 件数・評価数・停止条件はコード定数（利用者設定にしない計算量の安全弁）。利用者が変えられるのは K と手数料の範囲だけ。
 *
 * 動的計画法を使わないのは、金額が円単位で大きく表が膨らむうえ、「一意か」を知るには組み合わせの列挙が要るため。
 */

export const HARD_MAX_POOL = 20;
export const HARD_MAX_EVALUATIONS = 50_000;
/** 一致がこの件数に達したら止める（曖昧と言うのに 2 組、参考表示に 5 組あれば足りる）。 */
export const STOP_AFTER_MATCHES = 6;

export interface CombinationItem {
  readonly id: string;
  /** 正の残高。 */
  readonly amount: number;
}

export interface FoundCombination {
  /** 入力（期日の古い順）の並びのまま。 */
  readonly ids: readonly string[];
  readonly total: number;
  /** total − target（0 なら一致、正なら不足 = 手数料候補）。 */
  readonly difference: number;
}

export interface CombinationSearch {
  /** 合計 = target。 */
  readonly exact: readonly FoundCombination[];
  /** fee.min ≤ total − target ≤ fee.max（0 を除く）。 */
  readonly withFee: readonly FoundCombination[];
  /** プール超過（`HARD_MAX_POOL` を超えた分は探していない）。 */
  readonly truncated: boolean;
  /** 評価数の上限に達して打ち切った。 */
  readonly exhausted: boolean;
  readonly evaluations: number;
}

/**
 * 大きさ 2..maxSize の部分集合から、合計が target と一致するもの・手数料の範囲だけ多いものを探す。
 * `items` は呼び出し側が期日の古い順に並べて渡す（プールの切り詰めも古い順に残す）。
 */
export function findCombinations(
  items: readonly CombinationItem[],
  target: number,
  fee: { readonly min: number; readonly max: number },
  maxSize: number,
  budget: number = HARD_MAX_EVALUATIONS,
): CombinationSearch {
  const truncated = items.length > HARD_MAX_POOL;
  const pool = items.slice(0, HARD_MAX_POOL);
  const exact: FoundCombination[] = [];
  const withFee: FoundCombination[] = [];
  const upper = target + Math.max(fee.max, 0);
  const chosen: number[] = [];
  let evaluations = 0;
  let exhausted = false;

  const stop = () => exhausted || exact.length + withFee.length >= STOP_AFTER_MATCHES;

  const visit = (start: number, sum: number): void => {
    for (let index = start; index < pool.length; index += 1) {
      if (stop()) return;
      const next = sum + pool[index]!.amount;
      // 残高は正なので、上限を超えた枝はそれ以上足しても戻らない。
      if (next > upper) continue;
      chosen.push(index);
      if (chosen.length >= 2) {
        if (evaluations >= budget) { exhausted = true; chosen.pop(); return; }
        evaluations += 1;
        const difference = next - target;
        const found = (): FoundCombination => ({ ids: chosen.map((position) => pool[position]!.id), total: next, difference });
        if (difference === 0) exact.push(found());
        else if (difference > 0 && difference >= fee.min && difference <= fee.max) withFee.push(found());
      }
      if (chosen.length < maxSize) visit(index + 1, next);
      chosen.pop();
    }
  };

  visit(0, 0);
  return { exact, withFee, truncated, exhausted, evaluations };
}

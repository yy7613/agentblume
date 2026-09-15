import { describe, expect, it } from 'vitest';
import { findCombinations, HARD_MAX_POOL, STOP_AFTER_MATCHES, type CombinationItem } from './combinations';

const items = (...amounts: number[]): CombinationItem[] => amounts.map((amount, index) => ({ id: `i${index}`, amount }));
const noFee = { min: 1, max: 0 };

describe('findCombinations', () => {
  it('正常: 合計が一致する組み合わせがちょうど 1 組', () => {
    const result = findCombinations(items(33_000, 22_000, 50_000), 55_000, { min: 1, max: 880 }, 3);
    expect(result.exact).toEqual([{ ids: ['i0', 'i1'], total: 55_000, difference: 0 }]);
    expect(result).toMatchObject({ withFee: [], truncated: false, exhausted: false });
  });

  it('正常: 一致が 2 組 / 0 組。手数料の範囲だけ多い組み合わせは別に返す（差 0 は含めない）', () => {
    expect(findCombinations(items(10_000, 20_000, 15_000, 15_000), 30_000, noFee, 3).exact.map((found) => found.ids)).toEqual([['i0', 'i1'], ['i2', 'i3']]);
    const fee = findCombinations(items(33_000, 22_000), 54_560, { min: 1, max: 880 }, 3);
    expect(fee.exact).toEqual([]);
    expect(fee.withFee).toEqual([{ ids: ['i0', 'i1'], total: 55_000, difference: 440 }]);
    expect(findCombinations(items(100, 200), 1_000, noFee, 3)).toMatchObject({ exact: [], withFee: [] });
  });

  it('境界: 組み合わせの大きさは 2..K（K = 2 なら 3 件の合算は探さない。K = 5 なら探す）', () => {
    expect(findCombinations(items(1, 2, 3, 4, 5), 15, noFee, 2).exact).toEqual([]);
    expect(findCombinations(items(1, 2, 3, 4, 5), 15, noFee, 5).exact).toEqual([{ ids: ['i0', 'i1', 'i2', 'i3', 'i4'], total: 15, difference: 0 }]);
    // 単独（大きさ 1）は合算として返さない（単独の一致は判定の別の段が見る）。
    expect(findCombinations(items(15, 1), 15, noFee, 5).exact).toEqual([]);
  });

  it('境界: プールは 20 件ちょうどまで探し、21 件目以降は探さずに truncated を立てる', () => {
    const twenty = findCombinations(items(...Array.from({ length: HARD_MAX_POOL }, (_, index) => index + 1)), 39, noFee, 2);
    expect(twenty.truncated).toBe(false);
    expect(twenty.exact.map((found) => found.ids)).toEqual([['i18', 'i19']]);
    const twentyOne = findCombinations(items(...Array.from({ length: HARD_MAX_POOL + 1 }, (_, index) => index + 1)), 41, noFee, 2);
    expect(twentyOne.truncated).toBe(true);
    // 21 件目（i20 = 21）は探索に入らないので 20 + 21 は見つからない。
    expect(twentyOne.exact).toEqual([]);
  });

  it('境界: 評価数の上限ちょうどまでは打ち切らず、超える評価で exhausted', () => {
    // 3 件 × 大きさ 2..3 = 4 通り（刈り込みが起きない大きな target）。
    expect(findCombinations(items(1, 2, 3), 100, noFee, 3, 4)).toMatchObject({ exhausted: false, evaluations: 4 });
    expect(findCombinations(items(1, 2, 3), 100, noFee, 3, 3)).toMatchObject({ exhausted: true, evaluations: 3 });
  });

  it('境界: 一致が 6 組に達したら探索を止める', () => {
    const result = findCombinations(items(...Array.from({ length: 8 }, () => 1)), 2, noFee, 2);
    expect(result.exact.length + result.withFee.length).toBe(STOP_AFTER_MATCHES);
  });

  it('プロパティ: 刈り込みありの探索は全列挙と同じ一致を返す（小さな集合で乱数比較）', () => {
    let seed = 42;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    for (let trial = 0; trial < 60; trial += 1) {
      const amounts = Array.from({ length: 2 + Math.floor(random() * 6) }, () => 1 + Math.floor(random() * 9));
      const target = 2 + Math.floor(random() * 20);
      const expected: string[][] = [];
      for (let mask = 1; mask < 1 << amounts.length; mask += 1) {
        const ids = amounts.map((_, index) => index).filter((index) => (mask & (1 << index)) !== 0);
        if (ids.length < 2 || ids.length > 3) continue;
        if (ids.reduce((sum, index) => sum + amounts[index]!, 0) === target) expected.push(ids.map((index) => `i${index}`));
      }
      const found = findCombinations(items(...amounts), target, noFee, 3, 1_000_000).exact.map((combination) => [...combination.ids]);
      if (expected.length < STOP_AFTER_MATCHES) {
        expect(found.map((ids) => ids.join()).sort()).toEqual(expected.map((ids) => ids.join()).sort());
      } else {
        expect(found).toHaveLength(STOP_AFTER_MATCHES);
      }
    }
  });
});

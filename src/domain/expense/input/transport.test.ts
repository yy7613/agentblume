import { describe, expect, it } from 'vitest';
import type { CommuterPass } from '../employee';
import { checkFare, fareCandidates, findCommuterOverlap, validOn, type FareTableFacts } from './transport';

/** 運賃は架空。 */
const table: FareTableFacts = {
  routes: [
    { id: 'fare-nakano-shinjuku', stations: ['中野', '新宿'], fareType: 'ic', fare: 170, bidirectional: true },
    { id: 'fare-shinjuku-kasumigaseki', stations: ['新宿', '霞ケ関'], fareType: 'ic', fare: 200, bidirectional: true },
    { id: 'fare-nakano-kasumigaseki', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ic', fare: 300, bidirectional: true },
    { id: 'fare-nakano-kasumigaseki-yotsuya', stations: ['中野', '四ツ谷', '霞ケ関'], fareType: 'ic', fare: 280, bidirectional: true },
    { id: 'fare-nakano-kasumigaseki-ticket', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', fare: 320, bidirectional: false, validFrom: '2026-04-01', validTo: '2027-03-31' },
    { id: 'fare-shinjuku-shibuya', stations: ['新宿', '渋谷'], fareType: 'ic', fare: 160, bidirectional: true },
  ],
  stationAliases: [{ name: '霞ケ関', aliases: ['霞が関', '霞ヶ関'] }],
};

const ids = (routes: readonly { readonly id: string }[]): string[] => routes.map((route) => route.id);

describe('validOn', () => {
  it('境界: 開始日・終了日を含み、省略は無制限、日付が無ければ絞らない', () => {
    const entry = { validFrom: '2026-04-01', validTo: '2027-03-31' };
    expect(validOn(entry, '2026-03-31')).toBe(false);
    expect(validOn(entry, '2026-04-01')).toBe(true);
    expect(validOn(entry, '2027-03-31')).toBe(true);
    expect(validOn(entry, '2027-04-01')).toBe(false);
    expect(validOn({}, '1999-01-01')).toBe(true);
    expect(validOn(entry, undefined)).toBe(true);
  });
});

describe('fareCandidates', () => {
  it('正常: 両端の駅キーが一致する経路。別名と「駅」の違いを吸収する', () => {
    expect(ids(fareCandidates({ stations: ['中野駅', '霞が関'], fareType: 'ic', date: '2026-09-10' }, table))).toEqual(['fare-nakano-kasumigaseki', 'fare-nakano-kasumigaseki-yotsuya']);
  });

  it('正常: 双方向なら逆向きも当たる。双方向 false の逆向きは当たらない', () => {
    expect(ids(fareCandidates({ stations: ['霞ケ関', '新宿', '中野'], fareType: 'ic' }, table))).toEqual(['fare-nakano-kasumigaseki']);
    expect(fareCandidates({ stations: ['霞ケ関', '新宿', '中野'], fareType: 'ticket', date: '2026-09-10' }, table)).toEqual([]);
    expect(ids(fareCandidates({ stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', date: '2026-09-10' }, table))).toEqual(['fare-nakano-kasumigaseki-ticket']);
  });

  it('正常: 経由があれば経由を順に含む経路に絞り、0 件になれば絞らない', () => {
    expect(ids(fareCandidates({ stations: ['中野', '四ツ谷', '霞ケ関'], fareType: 'ic' }, table))).toEqual(['fare-nakano-kasumigaseki-yotsuya']);
    expect(ids(fareCandidates({ stations: ['中野', '渋谷', '霞ケ関'], fareType: 'ic' }, table))).toEqual(['fare-nakano-kasumigaseki', 'fare-nakano-kasumigaseki-yotsuya']);
  });

  it('境界: 有効期間の外の経路と券種の違う経路は当たらない', () => {
    expect(fareCandidates({ stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', date: '2026-03-31' }, table)).toEqual([]);
    expect(fareCandidates({ stations: ['中野', '新宿'], fareType: 'ticket' }, table)).toEqual([]);
  });
});

describe('checkFare', () => {
  const base = { stations: ['中野', '霞ケ関'], fareType: 'ic' as const, date: '2026-09-10' };

  it('境界: 運賃マスタに経路が 1 件も無ければ照合しない（undefined）', () => {
    expect(checkFare({ ...base, trips: 1, amount: 99_999, toleranceYen: 0 }, { routes: [], stationAliases: [] })).toBeUndefined();
  });

  it('異常: 候補が無ければ経路不明', () => {
    expect(checkFare({ ...base, stations: ['渋谷', '品川'], trips: 1, amount: 200, toleranceYen: 0 }, table)).toEqual({ kind: 'unknown' });
  });

  it('正常: 候補が複数なら最大運賃で比べ、候補数を返す', () => {
    expect(checkFare({ ...base, trips: 1, amount: 300, toleranceYen: 0 }, table)).toEqual({ kind: 'within', fare: 300, expected: 300, candidateCount: 2 });
  });

  it('境界: 運賃 × 回数 + 許容差 ちょうどは超過にしない。1 円でも超えれば超過', () => {
    expect(checkFare({ ...base, trips: 2, amount: 600, toleranceYen: 0 }, table)).toMatchObject({ kind: 'within', expected: 600 });
    expect(checkFare({ ...base, trips: 2, amount: 601, toleranceYen: 0 }, table)).toEqual({ kind: 'exceeds', fare: 300, expected: 600, over: 1, candidateCount: 2 });
    expect(checkFare({ ...base, trips: 2, amount: 610, toleranceYen: 10 }, table)).toMatchObject({ kind: 'within' });
    expect(checkFare({ ...base, trips: 2, amount: 611, toleranceYen: 10 }, table)).toMatchObject({ kind: 'exceeds', over: 11 });
  });
});

describe('findCommuterOverlap', () => {
  const pass: CommuterPass = { id: 'pass-b', stations: ['中野', '新宿', '霞ケ関'], validFrom: '2026-04-01', validTo: '2027-03-31' };
  const overlap = (stations: readonly string[], overrides: { readonly passes?: readonly CommuterPass[]; readonly date?: string; readonly trips?: number } = {}) => findCommuterOverlap({
    stations, trips: overrides.trips ?? 1, fareType: 'ic', date: overrides.date ?? '2026-09-10', passes: overrides.passes ?? [pass], table,
  });

  it('正常: 明細の全駅が定期に含まれれば全部（向きは問わない・別名を吸収）', () => {
    expect(overlap(['新宿', '霞ケ関'])).toEqual({ kind: 'full', pass });
    expect(overlap(['霞が関', '中野'])).toEqual({ kind: 'full', pass });
  });

  it('正常: 出発側だけが定期内なら一部。定期の外の区間の最小運賃 × 回数を候補にする', () => {
    expect(overlap(['中野', '新宿', '渋谷'], { trips: 2 })).toEqual({ kind: 'partial', pass, overlapFrom: '中野', overlapTo: '新宿', restRoute: '新宿 > 渋谷', suggestedAmount: 320 });
  });

  it('正常: 到着側だけが定期内なら一部（逆向きの双方向の経路で候補を引く）', () => {
    expect(overlap(['渋谷', '新宿', '霞ケ関'])).toEqual({ kind: 'partial', pass, overlapFrom: '新宿', overlapTo: '霞ケ関', restRoute: '渋谷 > 新宿', suggestedAmount: 160 });
  });

  it('境界: 定期の外の区間が運賃マスタに無ければ金額の候補を出さない', () => {
    expect(overlap(['中野', '高円寺'])).toEqual({ kind: 'partial', pass, overlapFrom: '中野', overlapTo: '中野' });
  });

  it('正常: 両端が定期の外で経由の連続 2 駅以上が定期内なら一部（金額の候補は出さない）。1 駅だけなら重なりにしない', () => {
    expect(overlap(['吉祥寺', '中野', '新宿', '渋谷'])).toEqual({ kind: 'partial', pass, overlapFrom: '中野', overlapTo: '新宿' });
    expect(overlap(['吉祥寺', '新宿', '渋谷'])).toBeUndefined();
  });

  it('制約: 両端が定期内でも経由が定期の外（A > D > C）は、路線図が無いので検出しない', () => {
    expect(overlap(['中野', '四ツ谷', '霞ケ関'])).toBeUndefined();
    expect(overlap(['渋谷', '品川'])).toBeUndefined();
  });

  it('境界: 取引日に有効な定期だけを見る（初日・末日を含む）', () => {
    expect(overlap(['新宿', '霞ケ関'], { date: '2026-03-31' })).toBeUndefined();
    expect(overlap(['新宿', '霞ケ関'], { date: '2026-04-01' })).toMatchObject({ kind: 'full' });
    expect(overlap(['新宿', '霞ケ関'], { date: '2027-03-31' })).toMatchObject({ kind: 'full' });
    expect(overlap(['新宿', '霞ケ関'], { date: '2027-04-01' })).toBeUndefined();
  });

  it('正常: 複数の定期に当たったら全部重なる方を優先し、次に定期の id の昇順', () => {
    const passA: CommuterPass = { id: 'pass-a', stations: ['新宿', '渋谷'] };
    const passC: CommuterPass = { id: 'pass-c', stations: ['中野', '新宿', '渋谷'] };
    expect(overlap(['中野', '新宿', '渋谷'], { passes: [pass, passA] })).toMatchObject({ kind: 'partial', pass: passA });
    expect(overlap(['中野', '新宿', '渋谷'], { passes: [pass, passA, passC] })).toEqual({ kind: 'full', pass: passC });
  });
});

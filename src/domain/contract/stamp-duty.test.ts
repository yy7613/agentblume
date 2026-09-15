import { describe, expect, it } from 'vitest';
import { DEFAULT_STAMP_DUTY } from './playbook-templates';
import { stampDutyCandidates, tierAmount, type StampDutyDocumentType, type StampDutySettings } from './stamp-duty';

const no2 = DEFAULT_STAMP_DUTY.documentTypes.find((type) => type.code === 'no2')!;

describe('stamp-duty: tierAmount（第 2 号文書の階層）', () => {
  it.each([
    [0, 0], [9_999, 0], [10_000, 200], [1_000_000, 200], [1_000_001, 400], [2_000_000, 400], [3_000_000, 1_000], [5_000_000, 2_000],
    [10_000_000, 10_000], [50_000_000, 20_000], [100_000_000, 60_000], [500_000_000, 100_000], [1_000_000_000, 200_000],
    [5_000_000_000, 400_000], [5_000_000_001, 600_000],
  ])('境界: 契約金額 %i 円 → %i 円', (amount, expected) => {
    expect(tierAmount(no2.tiers!, amount)).toBe(expected);
  });

  it('正常: 階層の並びが崩れていても upTo の昇順で見る', () => {
    expect(tierAmount([{ upTo: null, amount: 3 }, { upTo: 100, amount: 1 }, { upTo: 50, amount: 0 }], 60)).toBe(1);
  });

  it('異常: どの階層にも当たらなければ undefined', () => {
    expect(tierAmount([{ upTo: 100, amount: 1 }], 101)).toBeUndefined();
    expect(tierAmount([], 1)).toBeUndefined();
  });
});

describe('stamp-duty: stampDutyCandidates', () => {
  it.each([
    ['無効', { ...DEFAULT_STAMP_DUTY, enabled: false }, { nature: 'ukeoi' as const, contractAmount: 1_000_000 }],
    ['性質不明（undefined）', DEFAULT_STAMP_DUTY, { nature: undefined, contractAmount: 1_000_000 }],
    ['どの課税文書にも当たらない性質', DEFAULT_STAMP_DUTY, { nature: 'nda' as const }],
  ])('正常: %s は候補なし', (_label, settings, input) => {
    expect(stampDutyCandidates(input, settings)).toEqual([]);
  });

  it('正常: 請負はちょうど 100 万円で第 2 号 200 円、第 7 号 4,000 円の両方を並べる', () => {
    const candidates = stampDutyCandidates({ nature: 'ukeoi', contractAmount: 1_000_000 }, DEFAULT_STAMP_DUTY);
    expect(candidates).toEqual([
      { code: 'stamp-duty-candidate', documentTypeCode: 'no2', name: no2.name, amount: 200, nature: 'ukeoi', electronic: false, sourceUrl: no2.sourceUrl },
      expect.objectContaining({ code: 'stamp-duty-candidate', documentTypeCode: 'no7', amount: 4_000 }),
    ]);
  });

  it.each([
    [9_999, 0], [1_000_001, 400], [5_000_000_001, 600_000],
  ])('境界: 請負 %i 円の第 2 号は %i 円（0 は非課税）', (contractAmount, expected) => {
    expect(stampDutyCandidates({ nature: 'ukeoi', contractAmount }, DEFAULT_STAMP_DUTY)[0]?.amount).toBe(expected);
  });

  it('異常: 金額不明は第 2 号を stamp-duty-amount-unknown（記載なしの税額を添える）', () => {
    const [first, second] = stampDutyCandidates({ nature: 'ukeoi' }, DEFAULT_STAMP_DUTY);
    expect(first).toMatchObject({ code: 'stamp-duty-amount-unknown', documentTypeCode: 'no2', amount: 200 });
    expect(second).toMatchObject({ code: 'stamp-duty-candidate', documentTypeCode: 'no7', amount: 4_000 });
  });

  it('異常: 記載なしの税額が無い表なら金額不明の税額は null', () => {
    const { noAmountStated: _omit, ...withoutNoAmount } = no2;
    expect(stampDutyCandidates({ nature: 'ukeoi' }, { enabled: true, documentTypes: [withoutNoAmount] })[0]).toMatchObject({ code: 'stamp-duty-amount-unknown', amount: null });
  });

  it.each([
    ['3 か月・更新なし', { termMonths: 3, renews: false }, false],
    ['3 か月・更新の有無不明', { termMonths: 3 }, false],
    ['3 か月・更新あり', { termMonths: 3, renews: true }, true],
    ['4 か月・更新なし', { termMonths: 4, renews: false }, true],
    ['期間不明', {}, true],
  ])('境界: 第 7 号の除外（%s → 候補 %s）', (_label, extra, included) => {
    const candidates = stampDutyCandidates({ nature: 'basic_transaction', ...extra }, DEFAULT_STAMP_DUTY);
    expect(candidates.some((candidate) => candidate.documentTypeCode === 'no7')).toBe(included);
  });

  it('境界: unlessRenewal の無い条件は更新ありでも除外する', () => {
    const type: StampDutyDocumentType = { code: 'x', name: 'x', natures: ['basic_transaction'], condition: { excludeTermMonthsAtMost: 3 }, fixedAmount: 1, sourceUrl: '', note: '' };
    expect(stampDutyCandidates({ nature: 'basic_transaction', termMonths: 3, renews: true }, { enabled: true, documentTypes: [type] })).toEqual([]);
  });

  it('正常: 電子契約は候補を残しつつ税額 0・electronic true', () => {
    const candidates = stampDutyCandidates({ nature: 'ukeoi', contractAmount: 1_000_000, signingMethod: 'electronic' }, DEFAULT_STAMP_DUTY);
    expect(candidates.map((candidate) => [candidate.documentTypeCode, candidate.amount, candidate.electronic])).toEqual([['no2', 0, true], ['no7', 0, true]]);
    expect(stampDutyCandidates({ nature: 'ukeoi', contractAmount: 1_000_000, signingMethod: 'paper' }, DEFAULT_STAMP_DUTY)[0]?.electronic).toBe(false);
  });

  it('例外: 階層が空・どの階層にも当たらない表は税額 null（電子契約なら 0）', () => {
    const settings: StampDutySettings = {
      enabled: true,
      documentTypes: [
        { code: 'empty', name: 'e', natures: ['sale'], tiers: [], sourceUrl: '', note: '' },
        { code: 'capped', name: 'c', natures: ['sale'], tiers: [{ upTo: 10, amount: 1 }], sourceUrl: '', note: '' },
      ],
    };
    expect(stampDutyCandidates({ nature: 'sale', contractAmount: 100 }, settings).map((candidate) => candidate.amount)).toEqual([null, null]);
    expect(stampDutyCandidates({ nature: 'sale', contractAmount: 100, signingMethod: 'electronic' }, settings).map((candidate) => candidate.amount)).toEqual([null, 0]);
  });
});

describe('stamp-duty: 電子契約で金額が分からないとき', () => {
  it('境界: 金額不明の候補でも電子契約なら税額は 0 円（他の電子契約の候補と揃える）', () => {
    const candidates = stampDutyCandidates({ nature: 'ukeoi', signingMethod: 'electronic' }, DEFAULT_STAMP_DUTY);
    expect(candidates.find((candidate) => candidate.documentTypeCode === 'no2')).toMatchObject({ code: 'stamp-duty-amount-unknown', amount: 0, electronic: true });
  });
});

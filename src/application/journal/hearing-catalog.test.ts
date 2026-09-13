/**
 * selectAmbiguityCases のテスト（純関数）。
 *
 * ここが緩いと、モデルは帳票と関係のない質問（飲食のレシートに家事按分）を返す。
 * 「当てはまるものだけ・上限つき・ルールが名指ししたものは必ず」を固定する。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentFacts, UndecidedReason } from '../../domain/journal/document';
import { MAX_HEARING_AMBIGUITY_CASES, selectAmbiguityCases } from './hearing-catalog';

function ids(facts: DocumentFacts, kind: Parameters<typeof selectAmbiguityCases>[0]['kind'] = 'simplified_invoice', reasons?: readonly UndecidedReason[]): readonly string[] {
  return selectAmbiguityCases({ kind, facts, ...(reasons === undefined ? {} : { reasons }) }).map((entry) => entry.id);
}

describe('selectAmbiguityCases', () => {
  it('正常: 飲食店の支出は「飲食の目的」を選ぶ', () => {
    expect(ids({ direction: 'out', descriptionNorm: 'カフェ サンプル 霞が関店', grandTotal: 1230 })).toContain('meal_purpose');
  });

  it('正常: EC サイトは「何を買ったか」を選ぶ（表記揺れは NFKC + 小文字化で吸収）', () => {
    expect(ids({ direction: 'out', issuerName: 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ', grandTotal: 3000 })).toContain('ec_item_type');
  });

  it('境界: 固定資産の確認は 1 品または合計が 100,000 円以上のとき（99,999 円では聞かない）', () => {
    expect(ids({ direction: 'out', descriptionNorm: 'パソコン', grandTotal: 99_999 })).not.toContain('fixed_asset_check');
    expect(ids({ direction: 'out', descriptionNorm: 'パソコン', grandTotal: 100_000 })).toContain('fixed_asset_check');
    // 合計が小さくても 1 行が 10 万円以上なら聞く。
    expect(ids({ direction: 'out', grandTotal: 50_000, lines: [{ description: 'カメラ', amount: 120_000 }] })).toContain('fixed_asset_check');
  });

  it('正常: 支出の請求書に登録番号が無ければ「適格請求書発行事業者の確認」を選ぶ', () => {
    expect(ids({ direction: 'out', grandTotal: 1000 }, 'invoice')).toContain('invoice_registration');
    // 番号があるなら聞かない。
    expect(ids({ direction: 'out', grandTotal: 1000, registrationNumber: 'T1234567890123' }, 'invoice')).not.toContain('invoice_registration');
    // 銀行明細はそもそも番号を載せないので聞かない（免税事業者と誤認しない）。
    expect(ids({ direction: 'out', grandTotal: 1000 }, 'bank_statement')).not.toContain('invoice_registration');
  });

  it('正常: 銀行明細の入金は「入金の内容」、8% 対象があれば「軽減税率の確認」を選ぶ', () => {
    expect(ids({ direction: 'in', descriptionNorm: '振込 サンプル ショウジ' }, 'bank_statement')).toContain('bank_transfer_in');
    expect(ids({ direction: 'out', grandTotal: 1080, totalsByRate: [{ rate: 8, taxableAmount: 1080, amountIncludesTax: true }] })).toContain('reduced_rate_check');
  });

  it('正常: ルールの askIf が名指ししたケースは、トリガに当たらなくても必ず先頭に入る', () => {
    const selected = ids({ direction: 'out', grandTotal: 500, descriptionNorm: '文具' }, 'simplified_invoice', [
      { code: 'ask-if', ruleId: 'r1', questionId: 'household_ratio', prompt: '按分率は？' },
    ]);
    expect(selected[0]).toBe('household_ratio');
  });

  it('境界: 当てはまるものが多くても上限で切る', () => {
    const selected = ids({
      direction: 'out', grandTotal: 200_000,
      descriptionNorm: 'カフェ 楽天 タクシー 年払い 税理士報酬 家賃 保険料',
      totalsByRate: [{ rate: 8, taxableAmount: 1000, amountIncludesTax: true }],
    }, 'invoice');
    expect(selected.length).toBe(MAX_HEARING_AMBIGUITY_CASES);
  });

  it('境界: 何も当てはまらなければ空（カタログ抜きで facts と理由だけを渡す）', () => {
    expect(ids({ direction: 'in', descriptionNorm: '' }, 'payslip')).toEqual([]);
  });

  it('異常: 入金（direction: in）の飲食語では支出向けのケースを選ばない', () => {
    expect(ids({ direction: 'in', descriptionNorm: 'カフェ サンプル' })).not.toContain('meal_purpose');
  });

  it('例外: facts が空でも、理由が空でも投げない（純関数なので呼び出し側で守る必要が無い）', () => {
    expect(() => selectAmbiguityCases({ kind: 'unknown', facts: {} })).not.toThrow();
    expect(() => selectAmbiguityCases({ kind: 'unknown', facts: {}, reasons: [] })).not.toThrow();
    // 名指しされた questionId がカタログに無くても無視するだけ（ルールは任意の id を書ける）。
    expect(ids({ direction: 'out', grandTotal: 1 }, 'other', [{ code: 'ask-if', ruleId: 'r', questionId: 'なにか独自の質問', prompt: 'p' }])).toEqual([]);
  });
});

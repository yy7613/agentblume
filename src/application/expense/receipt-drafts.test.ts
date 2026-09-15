import { describe, expect, it } from 'vitest';
import { policyFixture } from '../../adapters/storage/expense-repository.fixtures';
import { receiptDraftsFromRead } from './receipt-drafts';
import type { ReceiptReadResult } from './receipt-read';

const POLICY = policyFixture();
const read = (overrides: Partial<ReceiptReadResult> = {}): ReceiptReadResult => ({
  documentKind: 'receipt',
  facts: { issuerName: '甲交通', transactionDate: '2026-09-10', grandTotal: 3200 },
  warnings: [],
  ...overrides,
});

describe('receiptDraftsFromRead: 領収書', () => {
  it('正常: 発行者を支払先・合計を金額にし、読取の出所・モデル・確信度を残す', () => {
    const result = receiptDraftsFromRead(read({
      facts: { issuerName: ' 甲交通 ', transactionDate: '2026-09-10', issueDate: '2026-09-11', grandTotal: 3300, registrationNumber: 'T1234567890123', totalsByRate: [{ rate: 10, taxableAmount: 3300, amountIncludesTax: true }], paymentMethod: 'credit_card', description: ' タクシー代 ' },
      model: { provider: 'p', model: 'm' },
      confidence: 0.8,
      warnings: ['読取の警告'],
    }), POLICY, 'receipt.png');
    expect(result.claimantHint).toBeUndefined();
    expect(result.warnings).toEqual(['読取の警告']);
    expect(result.drafts).toEqual([{
      categoryId: 'transport.taxi',
      facts: { transactionDate: '2026-09-10', dateSource: 'read', issueDate: '2026-09-11', payeeName: '甲交通', registrationNumber: 'T1234567890123', amount: 3300, totalsByRate: [{ rate: 10, taxableAmount: 3300, amountIncludesTax: true }], paymentMethod: 'credit_card', description: 'タクシー代' },
      source: { type: 'image', fileName: 'receipt.png' },
      extraction: { method: 'llm', model: { provider: 'p', model: 'm' }, confidence: 0.8, documentKind: 'receipt', warnings: ['読取の警告'] },
    }]);
  });

  it('正常: 支払方法 unknown は落とす', () => {
    const [draft] = receiptDraftsFromRead(read({ facts: { grandTotal: 100, paymentMethod: 'unknown' } }), POLICY).drafts;
    expect(draft!.facts).toEqual({ amount: 100 });
  });

  it('正常: extra.headcount と purpose は候補として入れ、確認を促す警告を足す', () => {
    const [draft] = receiptDraftsFromRead(read({ facts: { grandTotal: 100, extra: { headcount: 3, purpose: ' 打合せ ' } } }), POLICY).drafts;
    expect(draft!.facts).toMatchObject({ attendees: { count: 3 }, purpose: '打合せ' });
    expect(draft!.extraction.warnings).toEqual(['参加人数は読取値です。確認してください', '目的は読取値です。確認してください']);
  });

  it.each([[0], [2.5], ['3'], [null]])('境界: headcount %s は使わない', (headcount) => {
    const [draft] = receiptDraftsFromRead(read({ facts: { grandTotal: 100, extra: { headcount, purpose: '  ' } } }), POLICY).drafts;
    expect(draft!.facts).toEqual({ amount: 100 });
    expect(draft!.extraction.warnings).toEqual([]);
  });

  it('異常: 登録番号の形が合わなければ落として rejected と警告', () => {
    const [draft] = receiptDraftsFromRead(read({ facts: { grandTotal: 100, registrationNumber: 'T12' } }), POLICY).drafts;
    expect(draft!.facts).not.toHaveProperty('registrationNumber');
    expect(draft!.extraction.rejectedRegistrationNumber).toBe('T12');
    expect(draft!.extraction.warnings[0]).toContain('登録番号「T12」');
  });

  it('正常: 拡張子 .PDF は source.type pdf、ファイル名が無ければ image でファイル名を持たない', () => {
    expect(receiptDraftsFromRead(read(), POLICY, 'SCAN.PDF').drafts[0]!.source).toEqual({ type: 'pdf', fileName: 'SCAN.PDF' });
    expect(receiptDraftsFromRead(read(), POLICY).drafts[0]!.source).toEqual({ type: 'image' });
  });

  it('正常: 別名が支払先に含まれれば費目を推定し、2 費目に当たれば決めない', () => {
    expect(receiptDraftsFromRead(read({ facts: { issuerName: 'ホテル甲', grandTotal: 1 } }), POLICY).drafts[0]!.categoryId).toBe('travel.lodging');
    expect(receiptDraftsFromRead(read({ facts: { issuerName: 'ホテル甲', description: '送料', grandTotal: 1 } }), POLICY).drafts[0]).not.toHaveProperty('categoryId');
  });

  it('異常: 事実が形に合わなければ金額と日付だけ残して縮退し、警告に理由を書く', () => {
    const [draft] = receiptDraftsFromRead(read({ facts: { issuerName: '長'.repeat(300), transactionDate: '2026-09-10', issueDate: '2026-09-09', grandTotal: 500, description: '説明' } }), POLICY).drafts;
    expect(draft!.facts).toEqual({ amount: 500, transactionDate: '2026-09-10', issueDate: '2026-09-09' });
    expect(draft!.extraction.warnings[0]).toContain('金額と日付だけを残しました');
  });

  it('異常: 日付そのものが形に合わなくても全体を落とさず、形に合う金額だけを残して警告する', () => {
    // 縮退側でも壊れた日付を再検証すると例外になり、「1 項目の不正で全体を落とさない」に反する（回帰防止）。
    const result = receiptDraftsFromRead(read({ facts: { transactionDate: '2026-02-30', issueDate: '2026-02-28', grandTotal: 500 } }), POLICY);
    expect(result.drafts[0]!.facts).toEqual({ amount: 500, issueDate: '2026-02-28' });
    expect(result.drafts[0]!.extraction.warnings.some((warning) => warning.includes('金額と日付だけを残しました'))).toBe(true);
  });

  it('異常: 金額が小数でも全体を落とさず、形に合う日付だけを残す', () => {
    const result = receiptDraftsFromRead(read({ facts: { transactionDate: '2026-09-10', grandTotal: 500.5 } }), POLICY);
    expect(result.drafts[0]!.facts).toEqual({ transactionDate: '2026-09-10' });
  });
});

describe('receiptDraftsFromRead: 経費精算書・伝票', () => {
  it('正常: expense_report の発行者は支払先にせず claimantHint にする', () => {
    const result = receiptDraftsFromRead(read({ documentKind: 'expense_report', facts: { issuerName: ' 山田太郎 ', transactionDate: '2026-09-10', grandTotal: 1000, lines: [{ description: 'タクシー代', amount: 1000 }] } }), POLICY);
    expect(result.claimantHint).toBe('山田太郎');
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.facts).not.toHaveProperty('payeeName');
  });

  it('正常: 伝票（slip_transfer）の発行者も支払先にしない', () => {
    const result = receiptDraftsFromRead(read({ documentKind: 'slip_transfer', facts: { issuerName: '経理', grandTotal: 1 } }), POLICY);
    expect(result.claimantHint).toBe('経理');
    expect(result.drafts[0]!.facts).toEqual({ amount: 1 });
  });

  it('正常: 明細行 2 行以上は行ごとに分割し、日付は空で警告、税率を内訳に写す', () => {
    const result = receiptDraftsFromRead(read({
      documentKind: 'expense_report',
      facts: { issuerName: '山田太郎', transactionDate: '2026-09-10', grandTotal: 1500, lines: [{ description: ' 電車代 ', amount: 500, taxRate: 10 }, { description: '会議用弁当', amount: 1000 }] },
      warnings: ['合計欄が不鮮明'],
    }), POLICY, 'report.pdf');
    expect(result.claimantHint).toBe('山田太郎');
    expect(result.warnings).toEqual(['合計欄が不鮮明']);
    expect(result.drafts).toEqual([
      {
        categoryId: 'transport.public',
        facts: { amount: 500, totalsByRate: [{ rate: 10, taxableAmount: 500, amountIncludesTax: true }], description: '電車代' },
        source: { type: 'pdf', fileName: 'report.pdf' },
        extraction: { method: 'llm', documentKind: 'expense_report', warnings: ['合計欄が不鮮明', '精算書の明細には日付が無いため、利用日を入力してください'] },
      },
      {
        categoryId: 'meal.meeting',
        facts: { amount: 1000, description: '会議用弁当' },
        source: { type: 'pdf', fileName: 'report.pdf' },
        extraction: { method: 'llm', documentKind: 'expense_report', warnings: ['合計欄が不鮮明', '精算書の明細には日付が無いため、利用日を入力してください'] },
      },
    ]);
  });

  it('異常: 明細行の値が形に合わなければその行だけ縮退する', () => {
    const result = receiptDraftsFromRead(read({ documentKind: 'expense_report', facts: { issuerName: '', lines: [{ description: 'a', amount: 1, taxRate: 5 as never }, { description: 'b', amount: 2 }] } }), POLICY);
    expect(result.claimantHint).toBeUndefined();
    expect(result.drafts[0]!.facts).toEqual({ amount: 1 });
    expect(result.drafts[0]!.extraction.warnings.at(-1)).toContain('金額と日付だけを残しました');
    expect(result.drafts[1]!.facts).toEqual({ amount: 2, description: 'b' });
  });
});

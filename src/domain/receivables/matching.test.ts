import { describe, expect, it } from 'vitest';
import { compareByDue, judgeTransaction, nameMatchOf, type MatchCustomer, type OpenInvoiceView } from './matching';
import { normalizePayerName } from './payer-name';

const settings = { matching: { feeTolerance: { min: 100, max: 880 }, maxCombinationSize: 3, partialNameMinLength: 4 } };

function customer(id: string, overrides: Partial<MatchCustomer> = {}): MatchCustomer {
  return { id, name: `取引先${id}`, payerAliases: [], enabled: true, ...overrides };
}
function invoice(id: string, customerId: string, outstanding: number, overrides: Partial<OpenInvoiceView> = {}): OpenInvoiceView {
  return { id, customerId, outstanding, issueDate: '2026-08-31', dueDate: '2026-09-30', status: 'issued', ...overrides };
}
function judge(payer: string, amount: number, invoices: readonly OpenInvoiceView[], customers: readonly MatchCustomer[], override = settings) {
  return judgeTransaction({ transaction: { amount, date: '2026-09-30', payerNameNorm: normalizePayerName(payer) }, openInvoices: invoices, customers, settings: override });
}

const sample = customer('sample', { kana: 'サンプルシヨウジ' });
const yamada = customer('yamada', { name: '山田商事株式会社', payerAliases: [{ normalized: 'ヤマダシヨウジ' }] });
const test = customer('test', { name: 'テストコウギヨウ' });

describe('judgeTransaction の評価順（docs/22 §4.3）', () => {
  it('#0: 未入金の請求が無ければ no-open-invoice。名義で分かる取引先は params に載せる', () => {
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 1000, [], [sample])).toEqual({ stage: 'unmatched', reason: 'no-open-invoice', candidates: [], params: { customerIds: 'sample' } });
    expect(judge('ﾌﾒｲ', 1000, [], [sample])).toEqual({ stage: 'unmatched', reason: 'no-open-invoice', candidates: [] });
    // 入金日より後に発行・入金済み・取消は未入金に数えない。
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 1000, [invoice('late', 'sample', 1000, { issueDate: '2026-10-01' }), invoice('paid', 'sample', 0), invoice('void', 'sample', 1000, { status: 'void' })], [sample]).reason).toBe('no-open-invoice');
  });

  it('#1: 同じ名義が 2 社以上の別名 / カナにあれば、同額の請求があっても alias-conflict', () => {
    const twin = customer('twin', { kana: 'サンプルシヨウジ' });
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 1000, [invoice('a', 'sample', 1000)], [sample, twin])).toEqual({ stage: 'unmatched', reason: 'alias-conflict', candidates: [], params: { customerIds: 'sample,twin' } });
  });

  it('#3: 同額 + 名義（別名 / カナ / 社名）一致 + 1 件だけが decided', () => {
    for (const [payer, who, nameMatch, score] of [['ｻﾝﾌﾟﾙｼﾖｳｼﾞ', sample, 'kana', 1], ['ﾔﾏﾀﾞｼﾖｳｼﾞ', yamada, 'alias', 1], ['ﾃｽﾄｺｳｷﾞﾖｳ', test, 'name', 0.9]] as const) {
      const result = judge(payer, 110_000, [invoice('inv', who.id, 110_000), invoice('other', 'other', 110_000)], [who, customer('other')]);
      expect(result).toEqual({
        stage: 'decided', reason: 'exact-amount-and-name',
        candidates: [{ invoiceIds: ['inv'], allocations: [{ invoiceId: 'inv', amount: 110_000 }], candidateTotal: 110_000, difference: 0, feeAmount: 0, customerId: who.id, nameMatch, nameScore: score, rank: 1 }],
      });
    }
  });

  it('#3: 名義の部分一致なら同額でも candidate / name-partial。最小文字数ちょうどが境目', () => {
    const short = customer('short', { kana: 'ABCD' });
    expect(judge('ABCDE', 500, [invoice('i', 'short', 500)], [short]).reason).toBe('name-partial');
    // 最小文字数 5 にすると ABCD は部分一致にならず、名義で絞れないので金額だけの一致になる。
    expect(judge('ABCDE', 500, [invoice('i', 'short', 500)], [short], { matching: { ...settings.matching, partialNameMinLength: 5 } }).reason).toBe('amount-only');
  });

  it('#3: 同じ取引先に同額の請求が 2 件なら multiple-candidates（期日の古い順に候補を並べる）', () => {
    const result = judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 1000, [invoice('newer', 'sample', 1000, { dueDate: '2026-10-31' }), invoice('older', 'sample', 1000)], [sample]);
    expect(result).toMatchObject({ stage: 'unmatched', reason: 'multiple-candidates', params: { count: 2 } });
    expect(result.candidates.map((candidate) => [candidate.invoiceIds[0], candidate.rank])).toEqual([['older', 1], ['newer', 2]]);
  });

  it('#4: 手数料の許容範囲 min − 1 / min / max / max + 1 の境界', () => {
    const judgeShortfall = (shortfall: number) => judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 10_000 - shortfall, [invoice('i', 'sample', 10_000)], [sample]);
    expect(judgeShortfall(99).reason).toBe('no-candidate');
    expect(judgeShortfall(100)).toMatchObject({ stage: 'candidate', reason: 'fee-difference', candidates: [{ feeAmount: 100, difference: 100, allocations: [{ invoiceId: 'i', amount: 10_000 }] }] });
    expect(judgeShortfall(880)).toMatchObject({ reason: 'fee-difference', candidates: [{ feeAmount: 880 }] });
    expect(judgeShortfall(881)).toMatchObject({ stage: 'candidate', reason: 'partial-payment', candidates: [{ feeAmount: 0, allocations: [{ invoiceId: 'i', amount: 9_119 }] }] });
  });

  it('#4: 手数料差額の候補が 2 件なら multiple-candidates', () => {
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 9_500, [invoice('a', 'sample', 10_000), invoice('b', 'sample', 10_200)], [sample])).toMatchObject({ stage: 'unmatched', reason: 'multiple-candidates', params: { count: 2 } });
  });

  it('#5: 名義で絞った取引先の合算がちょうど 1 組なら combined-payment（別社の同額請求に引っ張られない）', () => {
    const result = judge('ﾃｽﾄｺｳｷﾞﾖｳ', 55_000, [invoice('inv3', 'test', 33_000), invoice('inv4', 'test', 22_000, { dueDate: '2026-10-15' }), invoice('inv6', 'test', 50_000, { dueDate: '2026-11-30' }), invoice('otherco', 'other', 55_000)], [test, customer('other')]);
    expect(result).toEqual({
      stage: 'candidate', reason: 'combined-payment',
      candidates: [{ invoiceIds: ['inv3', 'inv4'], allocations: [{ invoiceId: 'inv3', amount: 33_000 }, { invoiceId: 'inv4', amount: 22_000 }], candidateTotal: 55_000, difference: 0, feeAmount: 0, customerId: 'test', nameMatch: 'name', nameScore: 0.9, rank: 1 }],
    });
  });

  it('#5: 合算 + 手数料、一致 2 組の ambiguous-combination、手数料内 2 組も曖昧', () => {
    expect(judge('ﾃｽﾄｺｳｷﾞﾖｳ', 54_560, [invoice('a', 'test', 33_000), invoice('b', 'test', 22_000)], [test])).toMatchObject({ stage: 'candidate', reason: 'combined-payment-with-fee', candidates: [{ feeAmount: 440, difference: 440 }] });
    const ambiguous = judge('ﾃｽﾄｺｳｷﾞﾖｳ', 30_000, [invoice('a', 'test', 10_000), invoice('b', 'test', 20_000), invoice('c', 'test', 15_000), invoice('d', 'test', 15_000)], [test]);
    expect(ambiguous).toMatchObject({ stage: 'unmatched', reason: 'ambiguous-combination', params: { count: 2 } });
    expect(ambiguous.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(judge('ﾃｽﾄｺｳｷﾞﾖｳ', 29_700, [invoice('a', 'test', 10_000), invoice('b', 'test', 20_000), invoice('c', 'test', 15_000), invoice('d', 'test', 15_000)], [test])).toMatchObject({ reason: 'ambiguous-combination' });
  });

  it('#5: 一致 0 組のまま探索上限（プール 21 件）に達したら search-limit', () => {
    const many = Array.from({ length: 21 }, (_, index) => invoice(`i${String(index).padStart(2, '0')}`, 'test', 1_000 + index * 7_919));
    expect(judge('ﾃｽﾄｺｳｷﾞﾖｳ', 999_999, many, [test])).toMatchObject({ stage: 'unmatched', reason: 'search-limit', params: { pool: 20, evaluations: 50_000 } });
  });

  it('#6: 1 社 1 件で残高より多い入金は overpayment（参考候補に請求を載せる）', () => {
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 12_000, [invoice('i', 'sample', 10_000)], [sample])).toMatchObject({ stage: 'unmatched', reason: 'overpayment', params: { excess: 2_000 }, candidates: [{ invoiceIds: ['i'], difference: -2_000 }] });
  });

  it('#7: 名義が一致しない入金は合算も手数料も探さず、同額だけを見る', () => {
    expect(judge('ﾌﾒｲ', 55_000, [invoice('a', 'test', 33_000), invoice('b', 'test', 22_000)], [test]).reason).toBe('no-candidate');
    expect(judge('ﾌﾒｲ', 54_560, [invoice('a', 'test', 55_000)], [test]).reason).toBe('no-candidate');
    expect(judge('ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ', 88_000, [invoice('i', 'design', 88_000)], [customer('design', { name: '山田デザイン事務所' })])).toMatchObject({ stage: 'candidate', reason: 'amount-only', candidates: [{ nameMatch: 'none', nameScore: 0 }] });
    expect(judge('ｼﾖｳﾋﾝ ﾀﾞｲｷﾝ', 44_000, [invoice('a', 'x', 44_000), invoice('b', 'y', 44_000)], [customer('x'), customer('y')])).toMatchObject({ stage: 'unmatched', reason: 'multiple-candidates' });
  });

  it('境界: 無効な取引先の別名では絞らない。空の名義はどの取引先とも一致しない', () => {
    const disabled = { ...sample, enabled: false };
    expect(judge('ｻﾝﾌﾟﾙｼﾖｳｼﾞ', 1_000, [invoice('i', 'sample', 1_000)], [disabled]).reason).toBe('amount-only');
    expect(nameMatchOf('', sample, 4)).toBe('none');
    expect(nameMatchOf('サンプルシヨウジトウキヨウ', sample, 4)).toBe('partial');
  });

  it('正常: 合算の候補数は参考表示の上限 5 で切る', () => {
    const invoices = Array.from({ length: 8 }, (_, index) => invoice(`i${index}`, 'test', 1_000));
    const result = judge('ﾃｽﾄｺｳｷﾞﾖｳ', 2_000, invoices, [test]);
    expect(result.reason).toBe('ambiguous-combination');
    expect(result.candidates).toHaveLength(5);
  });
});

describe('compareByDue', () => {
  it('正常: 期日の古い順 → 期日なしは末尾 → 発行日 → id', () => {
    const list = [
      invoice('c', 'x', 1, { dueDate: undefined }), invoice('b', 'x', 1, { dueDate: '2026-09-30', issueDate: '2026-09-02' }),
      invoice('a', 'x', 1, { dueDate: '2026-09-30', issueDate: '2026-09-02' }), invoice('d', 'x', 1, { dueDate: '2026-09-01' }),
      invoice('e', 'x', 1, { dueDate: '2026-09-30', issueDate: '2026-09-01' }), invoice('f', 'x', 1, { dueDate: undefined }),
    ];
    expect([...list].sort(compareByDue).map((entry) => entry.id)).toEqual(['d', 'e', 'a', 'b', 'c', 'f']);
  });
});

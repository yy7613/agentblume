import { beforeEach, describe, expect, it } from 'vitest';
import { AT, claimFixture, policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { EXPENSE_RECEIPT_CHECK_COLUMNS } from '../../domain/etl/nodes/expense-receipt-check';
import type { DuplicateCandidate } from '../../domain/expense/duplicates';
import type { DuplicateCandidateQuery } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExtractReceiptInput, ExtractReceiptResult } from './extract-receipt';
import type { ExpenseItemDraft } from './receipt-drafts';
import { ExpenseReceiptCheckRowsProvider } from './receipt-check-rows';
import { receiptSha256 } from './receipt-hash';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const NOW = new Date('2026-09-15T00:00:00.000Z');

class RecordingClaimRepository extends InMemoryExpenseClaimRepository {
  readonly queries: DuplicateCandidateQuery[] = [];
  override async findDuplicateCandidates(target: TenantScope, query: DuplicateCandidateQuery): Promise<readonly DuplicateCandidate[]> {
    this.queries.push(query);
    return super.findDuplicateCandidates(target, query);
  }
}

class FakeExtract {
  readonly inputs: ExtractReceiptInput[] = [];
  constructor(private readonly drafts: readonly ExpenseItemDraft[]) {}
  async execute(input: ExtractReceiptInput): Promise<ExtractReceiptResult> {
    this.inputs.push(input);
    return { drafts: this.drafts, warnings: [] };
  }
}

// 初期テンプレートで指摘の出ない明細（電車代は証憑不要・3 万円未満はインボイス不要）
const PASS_DRAFT: ExpenseItemDraft = {
  categoryId: 'transport.public',
  facts: { transactionDate: '2026-09-10', payeeName: '甲鉄道', amount: 300, purpose: '客先訪問' },
  source: { type: 'image', fileName: 'a.png' },
  // 読取の警告があると receipt-extraction-warning（要確認）になるので、通過の明細には持たせない
  extraction: { method: 'llm', warnings: [] },
};
const FINDING_DRAFT: ExpenseItemDraft = { facts: { payeeName: '乙' }, source: { type: 'image' }, extraction: { method: 'llm', warnings: ['w1', 'w2'] } };

let claims: RecordingClaimRepository;
let policies: InMemoryExpensePolicyRepository;

beforeEach(async () => {
  claims = new RecordingClaimRepository();
  policies = new InMemoryExpensePolicyRepository();
});

const provider = (extract: FakeExtract) => new ExpenseReceiptCheckRowsProvider(extract, policies, claims, () => NOW);

describe('ExpenseReceiptCheckRowsProvider', () => {
  it('正常: 指摘の無い明細は verdict pass・code null の 1 行で、列の並びは固定スキーマと同じ', async () => {
    await policies.save(scope, policyFixture(AT));
    const extract = new FakeExtract([PASS_DRAFT]);
    const rows = await provider(extract).rows(scope, [{ name: 'a.png', dataUrl: DATA_URL }]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toEqual([...EXPENSE_RECEIPT_CHECK_COLUMNS]);
    expect(rows[0]).toEqual({
      file_name: 'a.png', item_no: 1, verdict: 'pass', severity: null, code: null, message: null, fix: null, category_id: 'transport.public', category: '電車・バス',
      transaction_date: '2026-09-10', payee: '甲鉄道', amount: 300, registration_number: null, attendees: null, search_keys_complete: true, policy_saved: true,
      warnings: '', facts_json: JSON.stringify(PASS_DRAFT.facts),
    });
    expect(extract.inputs).toEqual([{ scope, images: [DATA_URL], fileName: 'a.png' }]);
  });

  it('正常: 指摘は 1 行 1 件で日本語の message / fix を持ち、未保存の規程は policy_saved false', async () => {
    const rows = await provider(new FakeExtract([FINDING_DRAFT])).rows(scope, [{ name: 'b.png', dataUrl: DATA_URL }]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const codes = rows.map((row) => row['code']);
    expect(codes).toContain('amount-missing');
    expect(codes).toContain('category-missing');
    expect(codes).toContain('receipt-extraction-warning');
    for (const row of rows) {
      expect(row).toMatchObject({ verdict: 'returned', policy_saved: false, category_id: null, amount: null, search_keys_complete: false, warnings: 'w1 / w2' });
      expect(row['message']).toMatch(/[぀-ヿ一-鿿]/u);
      expect(row['fix']).toMatch(/[぀-ヿ一-鿿]/u);
      expect(['review', 'return']).toContain(row['severity']);
    }
  });

  it('正常: 重複候補は画像の sha256 と取引日 × 金額で問い合わせ、キーが無ければ sha256 だけ', async () => {
    await provider(new FakeExtract([PASS_DRAFT, FINDING_DRAFT])).rows(scope, [{ name: 'a.png', dataUrl: DATA_URL }]);
    const sha = receiptSha256(DATA_URL);
    expect(claims.queries).toEqual([
      { keys: [{ transactionDate: '2026-09-10', amount: 300 }], sha256s: [sha] },
      { keys: [], sha256s: [sha] },
    ]);
  });

  it('正常: 保存済みの申請と同じ取引なら重複の指摘が出る', async () => {
    await policies.save(scope, policyFixture(AT));
    await claims.save(claimFixture('c1', { items: [{ id: 'x', categoryId: 'transport.public', facts: PASS_DRAFT.facts, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } }] }), new Map());
    const rows = await provider(new FakeExtract([PASS_DRAFT])).rows(scope, [{ name: 'a.png', dataUrl: DATA_URL }]);
    expect(rows.map((row) => row['code'])).toContain('duplicate-across-claims');
  });

  it('境界: limit で読む枚数を絞り、明細番号は 1 枚の中で数える', async () => {
    const extract = new FakeExtract([PASS_DRAFT, PASS_DRAFT]);
    const rows = await provider(extract).rows(scope, [{ name: '1.png', dataUrl: DATA_URL }, { name: '2.png', dataUrl: DATA_URL }], { limit: 1 });
    expect(extract.inputs).toHaveLength(1);
    expect(new Set(rows.map((row) => row['file_name']))).toEqual(new Set(['1.png']));
    expect([...new Set(rows.map((row) => row['item_no']))]).toEqual([1, 2]);
  });

  it('境界: 添付 0 件は読取せずに空', async () => {
    const extract = new FakeExtract([PASS_DRAFT]);
    expect(await provider(extract).rows(scope, [])).toEqual([]);
    expect(extract.inputs).toEqual([]);
  });

  it('正常: now を省略すると現在の業務日付で判定し、支払先が無ければ payee は null', async () => {
    const draft: ExpenseItemDraft = { facts: { amount: 100 }, source: { type: 'image' }, extraction: { method: 'llm', warnings: [] } };
    const rows = await new ExpenseReceiptCheckRowsProvider(new FakeExtract([draft]), policies, claims).rows(scope, [{ name: 'c.png', dataUrl: DATA_URL }]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row['payee'] === null && row['transaction_date'] === null)).toBe(true);
  });
});

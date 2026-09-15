import { beforeEach, describe, expect, it } from 'vitest';
import { AT, claimFixture, itemFixture, receiptFixture, SHA_A, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { ExpenseClaimNotFoundError, ExpenseCsvImportError, ExpenseDomainError, ExpenseTransitionError } from '../../domain/expense/errors';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { ImportExpenseCsvUseCase, type ImportExpenseCsvInput } from './import-csv';

const PERIOD = { from: '2026-09-01', to: '2026-09-30' };
const csv = (...lines: string[]): string => `${lines.join('\r\n')}\r\n`;

let claims: InMemoryExpenseClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;
let sequence: number;

beforeEach(() => {
  claims = new InMemoryExpenseClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
  sequence = 0;
});

function useCase(now = new Date('2026-09-15T00:00:00.000Z')): ImportExpenseCsvUseCase {
  return new ImportExpenseCsvUseCase(claims, receipts, policies, new NoopUnitOfWork(), () => `id-${++sequence}`, () => now);
}
const run = (overrides: Partial<ImportExpenseCsvInput>, now?: Date) => useCase(now).execute({ scope, content: '', period: PERIOD, by: 'importer', ...overrides });

describe('ImportExpenseCsvUseCase: 申請の作成', () => {
  it('正常: 申請者（氏名 + 社員番号）ごとに draft の申請を作り、別名で費目を当てる', async () => {
    const content = csv(
      '申請者,社員番号,日付,支払先,金額,費目',
      '山田 太郎,E001,2026/09/10,甲交通,3200,タクシー代',
      '山田太郎,E002,2026/09/11,乙商店,500,文具',
      '山田　太郎,e001,2026/09/12,丙,800,謎',
    );
    const result = await run({ content, fileName: 'claims.csv' }, new Date('2026-09-30T23:30:00.000Z'));
    expect(result.claims.map((claim) => [claim.claimant.employeeCode, claim.itemCount, claim.importedCount, claim.created])).toEqual([['E001', 2, 2, true], ['E002', 1, 1, true]]);
    const first = await claims.findById(scope, result.claims[0]!.id);
    expect(first).toMatchObject({ status: 'draft', period: PERIOD, submittedBy: 'importer', history: [{ type: 'created', by: 'importer', note: 'CSV 取込: claims.csv' }] });
    expect(first!.items[0]).toMatchObject({
      categoryId: 'transport.taxi', categoryText: 'タクシー代', facts: { amount: 3200, payeeName: '甲交通', transactionDate: '2026-09-10' },
      source: { type: 'csv-row', fileName: 'claims.csv', row: { 申請者: '山田 太郎', 金額: '3200' } }, extraction: { method: 'csv', warnings: [] },
      // 取込日は業務タイムゾーン（UTC 23:30 = JST 翌日）
      addedOn: '2026-10-01',
    });
    expect(first!.items[1]).not.toHaveProperty('categoryId');
    expect(first!.items[1]!.categoryText).toBe('謎');
  });

  it('正常: 列の対応表と行の警告を返し、読めない値の行も取り込む', async () => {
    const result = await run({ content: csv('氏名,date,amount,余分,登録番号', '太郎,2026-09-10,abc,x,T12') });
    expect(result.columnMatches.map((match) => match.field)).toEqual(['claimant', 'transactionDate', 'amount', null, 'registrationNumber']);
    expect(result.warnings).toHaveLength(2);
    const saved = await claims.findById(scope, result.claims[0]!.id);
    expect(saved!.items[0]!.extraction).toMatchObject({ method: 'csv', rejectedRegistrationNumber: 'T12' });
    expect(saved!.items[0]!.facts).not.toHaveProperty('amount');
    expect(result.claims[0]!.claimant).toEqual({ name: '太郎' });
  });

  it('境界: 1 申請者 101 行目以降は skippedRows（100 件まで取り込む）', async () => {
    const rows = Array.from({ length: 102 }, (_, index) => `太郎,2026-09-10,${index + 1}`);
    const result = await run({ content: csv('申請者,日付,金額', ...rows) });
    expect(result.claims).toEqual([expect.objectContaining({ itemCount: 100, importedCount: 100 })]);
    expect(result.skippedRows.map((row) => row.row)).toEqual([102, 103]);
    expect(result.skippedRows[0]!.reason).toContain('100 件まで');
  });

  it('異常: 値が長すぎる行は skippedRows に回し、行番号順に並べる', async () => {
    const result = await run({ content: csv('申請者,日付,金額,支払先', `太郎,2026-09-10,100,${'長'.repeat(201)}`, '太郎,2026-09-10', '太郎,2026-09-11,200,乙') });
    expect(result.skippedRows.map((row) => row.row)).toEqual([2, 3]);
    expect(result.skippedRows[0]!.reason).toContain('payeeName must be at most 200');
    expect(result.claims[0]!.importedCount).toBe(1);
  });

  it('境界: ある申請者の行がすべて読み飛ばしなら、その申請者の申請だけ作らない', async () => {
    const result = await run({ content: csv('申請者,日付,金額,支払先', `花子,2026-09-10,100,${'長'.repeat(201)}`, '太郎,2026-09-11,200,乙') });
    expect(result.claims.map((claim) => claim.claimant.name)).toEqual(['太郎']);
    expect(result.skippedRows.map((row) => row.row)).toEqual([2]);
  });

  it('正常: id と時刻を省略すると UUID と現在時刻を使う', async () => {
    const before = Date.now();
    const result = await new ImportExpenseCsvUseCase(claims, receipts, policies, new NoopUnitOfWork()).execute({ scope, content: csv('申請者,日付,金額', '太郎,2026-09-10,100'), period: PERIOD, by: 'a' });
    expect(result.claims[0]!.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Date.parse((await claims.findById(scope, result.claims[0]!.id))!.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('境界: 全行が読み飛ばしなら申請を作らない', async () => {
    const result = await run({ content: csv('申請者,日付,金額', ',2026-09-10,100') });
    expect(result.claims).toEqual([]);
    expect(await claims.list(scope)).toEqual([]);
  });

  it('異常: period が不正なら 400（ExpenseDomainError）で何も保存しない', async () => {
    await expect(run({ content: csv('申請者,日付,金額', '太郎,2026-09-10,100'), period: { from: '2026-10-01', to: '2026-09-01' } })).rejects.toBeInstanceOf(ExpenseDomainError);
    expect(await claims.list(scope)).toEqual([]);
  });

  it('異常: 必須列が無ければ ExpenseCsvImportError', async () => {
    await expect(run({ content: csv('日付,金額', '2026-09-10,100') })).rejects.toBeInstanceOf(ExpenseCsvImportError);
  });
});

describe('ImportExpenseCsvUseCase: claimId 指定の追記', () => {
  it('正常: 既存の申請へ追記し（申請者列は不要）、既存の証憑ハッシュを索引に残す', async () => {
    await claims.save(claimFixture('c1', { items: [itemFixture('item-1', {}, { receiptId: 'r1' })] }), new Map([['item-1', SHA_A]]));
    await receipts.save(receiptFixture('r1', { claimId: 'c1', itemId: 'item-1' }));
    const result = await run({ claimId: 'c1', content: csv('日付,金額,申請者', '2026-09-11,500,別人', '2026-09-12,600,') });
    expect(result.claims).toEqual([{ id: 'c1', claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部' }, itemCount: 3, importedCount: 2, created: false }]);
    const saved = await claims.findById(scope, 'c1');
    expect(saved!.history.at(-1)).toMatchObject({ type: 'edited', by: 'importer', note: 'CSV 取込' });
    expect(await claims.findDuplicateCandidates(scope, { keys: [], sha256s: [SHA_A] })).toHaveLength(1);
  });

  it('境界: 既存 99 件の申請には 1 件だけ入り、残りは skippedRows', async () => {
    await claims.save(claimFixture('c1', { items: Array.from({ length: 99 }, (_, index) => itemFixture(`i${index}`)) }), new Map());
    const result = await run({ claimId: 'c1', content: csv('日付,金額', '2026-09-11,1', '2026-09-11,2', '2026-09-11,3') });
    expect(result.claims[0]).toMatchObject({ itemCount: 100, importedCount: 1 });
    expect(result.skippedRows.map((row) => row.row)).toEqual([3, 4]);
  });

  it('異常: 無い申請は 404、承認済みの申請へは追記できない', async () => {
    await expect(run({ claimId: 'none', content: csv('日付,金額', '2026-09-11,1') })).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
    await claims.save(claimFixture('c2', { status: 'approved', approval: { by: 'b', at: AT } }), new Map());
    await expect(run({ claimId: 'c2', content: csv('日付,金額', '2026-09-11,1') })).rejects.toBeInstanceOf(ExpenseTransitionError);
  });
});

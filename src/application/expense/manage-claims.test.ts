import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture, receiptFixture, SAMPLE_DATA_URL, scope } from '../../adapters/storage/expense-repository.fixtures';
import { employeeFixture, fixtureEmployees, fixtureOrganization, FIXTURE_DEPARTMENT_IDS, FIXTURE_EMPLOYEE_IDS } from '../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseEmployeeRepository } from '../../adapters/storage/in-memory-expense-people-repositories';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import type { ApprovalPlan } from '../../domain/expense/approval';
import { approveStep, claimFingerprint, withJudgment, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseDomainError, ExpenseItemNotFoundError, ExpenseReceiptNotFoundError, ExpenseTransitionError } from '../../domain/expense/errors';
import { emptyExpenseOrganization, type ExpenseOrganization } from '../../domain/expense/organization';
import type { ExpenseCardRepository } from '../../domain/expense/repositories';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import {
  claimTotalAmount, ClaimantResolver, CreateExpenseClaimUseCase, DeleteExpenseClaimUseCase, DeleteExpenseItemUseCase, GetExpenseClaimUseCase, GetExpenseReceiptUseCase,
  ListExpenseClaimsUseCase, SaveExpenseItemUseCase, UpdateExpenseClaimUseCase, type SaveExpenseItemInput,
} from './manage-claims';
import { receiptSha256 } from './receipt-hash';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const OTHER_DATA_URL = 'data:image/png;base64,AAAAAAAA';

let claims: InMemoryExpenseClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;
let sequence: number;
const makeId = (): string => `id-${++sequence}`;

beforeEach(() => {
  claims = new InMemoryExpenseClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
  sequence = 0;
});

function checkedClaim(id = 'c1'): ExpenseClaim {
  const claim = claimFixture(id);
  return withJudgment(claim, {
    verdict: 'pass', items: [], claimReasons: [], totals: { amount: 3200, byCategory: [] }, searchKeysComplete: true,
    policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(claim), checkedAt: AT,
  }, AT);
}

const saveItem = (now: Date = NOW) => new SaveExpenseItemUseCase(claims, receipts, policies, new NoopUnitOfWork(), makeId, () => now);
const itemInput = (overrides: Partial<SaveExpenseItemInput> = {}): SaveExpenseItemInput => ({
  scope, claimId: 'c1', facts: { transactionDate: '2026-09-10', amount: 1000, payeeName: '甲' }, source: { type: 'manual' }, by: 'editor', ...overrides,
});

describe('CreateExpenseClaimUseCase', () => {
  it('正常: 作成者を submittedBy と履歴 created に残して保存する', async () => {
    const claim = await new CreateExpenseClaimUseCase(claims, makeId, () => NOW).execute({ scope, claimant: { name: '太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, title: '9 月', by: 'alice' });
    expect(claim).toMatchObject({ id: 'id-1', status: 'draft', submittedBy: 'alice', title: '9 月', items: [], history: [{ type: 'created', by: 'alice', at: NOW.toISOString() }] });
    expect(await claims.findById(scope, 'id-1')).toEqual(claim);
  });

  it('異常: 期間の逆転は保存せずに拒否する', async () => {
    await expect(new CreateExpenseClaimUseCase(claims, makeId, () => NOW).execute({ scope, claimant: { name: '太郎' }, period: { from: '2026-09-30', to: '2026-09-01' }, by: 'a' })).rejects.toThrow(/from must not be after/u);
    expect(await claims.list(scope)).toEqual([]);
  });
});

describe('UpdateExpenseClaimUseCase / GetExpenseClaimUseCase', () => {
  it('正常: 判定済みの申請を編集すると判定が消えて draft になり、title 省略は消す', async () => {
    await claims.save({ ...checkedClaim(), title: '旧' }, new Map());
    const updated = await new UpdateExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, id: 'c1', claimant: { name: '花子' }, period: { from: '2026-09-01', to: '2026-09-30' }, by: 'editor' });
    expect(updated.status).toBe('draft');
    expect(updated.judgment).toBeUndefined();
    expect(updated.title).toBeUndefined();
    expect((await new GetExpenseClaimUseCase(claims).execute(scope, 'c1')).claimant.name).toBe('花子');
  });

  it('異常: 承認済みの編集は 409', async () => {
    await claims.save(claimFixture('c1', { status: 'approved', approval: { by: 'b', at: AT } }), new Map());
    await expect(new UpdateExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, id: 'c1', claimant: { name: 'x' }, period: { from: '2026-09-01', to: '2026-09-30' }, by: 'e' })).rejects.toBeInstanceOf(ExpenseTransitionError);
  });

  it('異常: 無い申請は 404', async () => {
    await expect(new GetExpenseClaimUseCase(claims).execute(scope, 'none')).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });
});

describe('DeleteExpenseClaimUseCase', () => {
  it('正常: 申請を削除すると証憑本体も消える', async () => {
    await claims.save(claimFixture('c1'), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1' }));
    await new DeleteExpenseClaimUseCase(claims, receipts, new NoopUnitOfWork()).execute(scope, 'c1');
    expect(await claims.findById(scope, 'c1')).toBeNull();
    expect(await receipts.findById(scope, 'r1')).toBeNull();
  });

  it('異常: 承認済み・精算済みは 409 で、何も消さない', async () => {
    await claims.save(claimFixture('c1', { status: 'approved', approval: { by: 'b', at: AT } }), new Map());
    await claims.save(claimFixture('c2', { status: 'settled', approval: { by: 'b', at: AT }, settlement: { settledAt: AT, by: 'b' } }), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1' }));
    const useCase = new DeleteExpenseClaimUseCase(claims, receipts, new NoopUnitOfWork());
    await expect(useCase.execute(scope, 'c1')).rejects.toMatchObject({ nextStep: '承認を取り消してから削除してください' });
    await expect(useCase.execute(scope, 'c2')).rejects.toMatchObject({ nextStep: expect.stringContaining('精算済み') });
    expect(await receipts.findById(scope, 'r1')).not.toBeNull();
  });

  it('異常: 無い申請は 404', async () => {
    await expect(new DeleteExpenseClaimUseCase(claims, receipts, new NoopUnitOfWork()).execute(scope, 'none')).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });
});

describe('SaveExpenseItemUseCase', () => {
  beforeEach(async () => {
    await claims.save(claimFixture('c1', { items: [] }), new Map());
  });

  it('異常: 形の合わない登録番号は落として警告と rejectedRegistrationNumber に残す（400 にしない）', async () => {
    const claim = await saveItem().execute(itemInput({ facts: { amount: 1000, registrationNumber: 'T12345' } }));
    const item = claim.items[0]!;
    expect(item.facts).toEqual({ amount: 1000 });
    expect(item.extraction.rejectedRegistrationNumber).toBe('T12345');
    expect(item.extraction.warnings.join('')).toContain('登録番号「T12345」');
  });

  it('正常: 読取側の警告と保存時の警告を重複なく合わせ、読取の rejected は番号が入れば消す', async () => {
    const kept = await saveItem().execute(itemInput({ itemId: 'a', facts: { amount: 1 }, extraction: { warnings: ['w', 'w'], rejectedRegistrationNumber: 'T1' } }));
    expect(kept.items[0]!.extraction).toMatchObject({ warnings: ['w'], rejectedRegistrationNumber: 'T1' });
    const fixed = await saveItem().execute(itemInput({ itemId: 'a', facts: { amount: 1, registrationNumber: 'T1234567890123' }, extraction: { rejectedRegistrationNumber: 'T1' } }));
    expect(fixed.items[0]!.extraction.rejectedRegistrationNumber).toBeUndefined();
  });

  it('正常: 費目文字列だけなら規程の別名で categoryId を当て、当たらなければ文字列だけ残す', async () => {
    const resolved = await saveItem().execute(itemInput({ itemId: 'a', categoryText: ' タクシー代 ' }));
    expect(resolved.items[0]).toMatchObject({ categoryId: 'transport.taxi', categoryText: 'タクシー代' });
    const unresolved = await saveItem().execute(itemInput({ itemId: 'b', categoryId: '', categoryText: '謎の費目' }));
    expect(unresolved.items[1]).not.toHaveProperty('categoryId');
    expect(unresolved.items[1]!.categoryText).toBe('謎の費目');
    const explicit = await saveItem().execute(itemInput({ itemId: 'c', categoryId: ' books ', categoryText: '  ' }));
    expect(explicit.items[2]).toMatchObject({ categoryId: 'books' });
    expect(explicit.items[2]).not.toHaveProperty('categoryText');
  });

  it('正常: 証憑を保存し、sha256 が申請の索引（重複候補の問い合わせ）に入る', async () => {
    const claim = await saveItem().execute(itemInput({ source: { type: 'pdf', fileName: 'a.pdf' }, receipt: { dataUrl: SAMPLE_DATA_URL, fileName: 'a.pdf', mime: 'application/pdf', text: '本文' }, extraction: { warnings: [] } }));
    const item = claim.items[0]!;
    const receipt = await receipts.findById(scope, item.receiptId!);
    expect(receipt).toMatchObject({ claimId: 'c1', itemId: item.id, sha256: receiptSha256(SAMPLE_DATA_URL), source: { type: 'pdf', fileName: 'a.pdf', mime: 'application/pdf', text: '本文' } });
    expect(item.extraction.method).toBe('llm');
    const candidates = await claims.findDuplicateCandidates(scope, { keys: [], sha256s: [receiptSha256(SAMPLE_DATA_URL)] });
    expect(candidates.map((candidate) => candidate.itemId)).toEqual([item.id]);
  });

  it('正常: 証憑を差し替えると古い証憑本体が消え、索引も新しい画像になる', async () => {
    const first = await saveItem().execute(itemInput({ itemId: 'a', source: { type: 'image' }, receipt: { dataUrl: SAMPLE_DATA_URL } }));
    const oldReceiptId = first.items[0]!.receiptId!;
    const second = await saveItem().execute(itemInput({ itemId: 'a', source: { type: 'image' }, receipt: { dataUrl: OTHER_DATA_URL } }));
    expect(second.items[0]!.receiptId).not.toBe(oldReceiptId);
    expect(await receipts.findById(scope, oldReceiptId)).toBeNull();
    expect(await claims.findDuplicateCandidates(scope, { keys: [], sha256s: [receiptSha256(SAMPLE_DATA_URL)] })).toEqual([]);
    expect(await claims.findDuplicateCandidates(scope, { keys: [], sha256s: [receiptSha256(OTHER_DATA_URL)] })).toHaveLength(1);
  });

  it('正常: 証憑なしの更新は既存の receiptId と addedOn を残す', async () => {
    const first = await saveItem(new Date('2026-09-01T00:00:00.000Z')).execute(itemInput({ itemId: 'a', source: { type: 'image' }, receipt: { dataUrl: SAMPLE_DATA_URL } }));
    const second = await saveItem(new Date('2026-09-20T00:00:00.000Z')).execute(itemInput({ itemId: 'a', facts: { amount: 2000 } }));
    expect(second.items[0]!.receiptId).toBe(first.items[0]!.receiptId);
    expect(second.items[0]!.addedOn).toBe('2026-09-01');
    expect(second.items[0]!.extraction.method).toBe('manual');
    expect(await receipts.hashesByClaim(scope, 'c1')).toEqual(new Map([['a', receiptSha256(SAMPLE_DATA_URL)]]));
  });

  it('境界: 新規の addedOn は業務タイムゾーンの日付（UTC 23:30 は JST 翌日）', async () => {
    const claim = await saveItem(new Date('2026-09-30T23:30:00.000Z')).execute(itemInput());
    expect(claim.items[0]!.addedOn).toBe('2026-10-01');
  });

  it('正常: itemId が無い明細を指せばその id で新規、csv-row の取込方法は csv', async () => {
    const claim = await saveItem().execute(itemInput({ itemId: 'given', source: { type: 'csv-row', row: { 金額: '1000' } }, extraction: { model: { provider: 'p', model: 'm' }, confidence: 0.9, documentKind: 'receipt' } }));
    expect(claim.items[0]).toMatchObject({ id: 'given', extraction: { method: 'csv', model: { provider: 'p', model: 'm' }, confidence: 0.9, documentKind: 'receipt' } });
  });

  it('異常: 申請が無ければ 404、形の不正な事実は 400 で保存しない', async () => {
    await expect(saveItem().execute(itemInput({ claimId: 'none' }))).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
    await expect(saveItem().execute(itemInput({ facts: { amount: 'x' } }))).rejects.toThrow(/expense item: facts.amount/u);
    expect((await claims.findById(scope, 'c1'))!.items).toEqual([]);
  });
});

describe('DeleteExpenseItemUseCase', () => {
  it('正常: 明細を削除すると証憑本体と索引の画像ハッシュも消える', async () => {
    await claims.save(claimFixture('c1', { items: [] }), new Map());
    const saved = await saveItem().execute(itemInput({ itemId: 'a', source: { type: 'image' }, receipt: { dataUrl: SAMPLE_DATA_URL } }));
    const updated = await new DeleteExpenseItemUseCase(claims, receipts, new NoopUnitOfWork(), () => NOW).execute({ scope, claimId: 'c1', itemId: 'a', by: 'editor' });
    expect(updated.items).toEqual([]);
    expect(await receipts.findById(scope, saved.items[0]!.receiptId!)).toBeNull();
    expect(await claims.findDuplicateCandidates(scope, { keys: [], sha256s: [receiptSha256(SAMPLE_DATA_URL)] })).toEqual([]);
  });

  it('正常: 証憑の無い明細も削除できる、無い明細は 404', async () => {
    await claims.save(claimFixture('c1'), new Map());
    const useCase = new DeleteExpenseItemUseCase(claims, receipts, new NoopUnitOfWork(), () => NOW);
    expect((await useCase.execute({ scope, claimId: 'c1', itemId: 'item-1', by: 'e' })).items).toEqual([]);
    await expect(useCase.execute({ scope, claimId: 'c1', itemId: 'item-1', by: 'e' })).rejects.toBeInstanceOf(ExpenseItemNotFoundError);
  });
});

describe('GetExpenseReceiptUseCase', () => {
  it('正常: 明細の証憑本体を返す', async () => {
    await claims.save(claimFixture('c1', { items: [itemFixture('item-1', {}, { receiptId: 'r1' })] }), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1' }));
    expect((await new GetExpenseReceiptUseCase(claims, receipts).execute(scope, 'c1', 'item-1')).id).toBe('r1');
  });

  it('異常: 申請なし・明細なし・証憑なし（receiptId なし / 本体が消えている）の 404 3 種', async () => {
    await claims.save(claimFixture('c1', { items: [itemFixture('plain'), itemFixture('dangling', {}, { receiptId: 'gone' })] }), new Map());
    const useCase = new GetExpenseReceiptUseCase(claims, receipts);
    await expect(useCase.execute(scope, 'none', 'plain')).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
    await expect(useCase.execute(scope, 'c1', 'none')).rejects.toBeInstanceOf(ExpenseItemNotFoundError);
    await expect(useCase.execute(scope, 'c1', 'plain')).rejects.toBeInstanceOf(ExpenseReceiptNotFoundError);
    await expect(useCase.execute(scope, 'c1', 'dangling')).rejects.toBeInstanceOf(ExpenseReceiptNotFoundError);
  });
});

describe('ListExpenseClaimsUseCase', () => {
  it('正常: 規程を保存していなければ初期テンプレートの版と比べて古くない', async () => {
    await claims.save(checkedClaim(), new Map());
    const [summary] = await new ListExpenseClaimsUseCase(claims, policies).execute(scope);
    expect(summary!.stale).toBe(false);
  });

  it('異常: 判定後に規程を保存し直すと、明細が同じでも stale', async () => {
    await claims.save(checkedClaim(), new Map());
    await policies.save(scope, policyFixture('2026-09-20T00:00:00.000Z'));
    const [summary] = await new ListExpenseClaimsUseCase(claims, policies).execute(scope, { status: 'checked' });
    expect(summary!.stale).toBe(true);
  });

  it('正常: 絞り込みの条件をリポジトリへ渡す', async () => {
    await claims.save(checkedClaim('c1'), new Map());
    await claims.save(claimFixture('c2'), new Map());
    expect((await new ListExpenseClaimsUseCase(claims, policies).execute(scope, { status: 'draft' })).map((summary) => summary.id)).toEqual(['c2']);
  });

  it('正常: claimTotalAmount を再公開している', () => {
    expect(claimTotalAmount(claimFixture('c1'))).toBe(3200);
  });
});

describe('既定の時刻・id', () => {
  it('正常: now・makeId・タイムゾーンを省略すると現在時刻と UUID を使う', async () => {
    const before = Date.now();
    const created = await new CreateExpenseClaimUseCase(claims).execute({ scope, claimant: { name: '太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, by: 'a' });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before);
    const updated = await new UpdateExpenseClaimUseCase(claims, receipts).execute({ scope, id: created.id, claimant: { name: '花子' }, period: created.period, by: 'a' });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(before);
    const withItem = await new SaveExpenseItemUseCase(claims, receipts, policies, new NoopUnitOfWork()).execute(itemInput({ claimId: created.id }));
    expect(withItem.items[0]!.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(withItem.items[0]!.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const removed = await new DeleteExpenseItemUseCase(claims, receipts, new NoopUnitOfWork()).execute({ scope, claimId: created.id, itemId: withItem.items[0]!.id, by: 'a' });
    expect(removed.items).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * 実用化（§20.9.1 / §20.8.3 / UC7）: 申請者の写し・承認中の削除・カード照合の解除・読取の印
 * ------------------------------------------------------------------------- */

describe('ClaimantResolver', () => {
  let employees: InMemoryExpenseEmployeeRepository;
  let organization: ExpenseOrganization;
  const resolver = (): ClaimantResolver => new ClaimantResolver(employees, { get: async () => organization });

  beforeEach(async () => {
    employees = new InMemoryExpenseEmployeeRepository();
    for (const employee of fixtureEmployees()) await employees.save(employee);
    organization = fixtureOrganization();
  });

  it('正常: employeeId を指定したら、本文の氏名・社員番号・部門は使わず従業員マスタと組織から写す', async () => {
    const claimant = await resolver().resolve(scope, { name: '偽名', employeeCode: 'X999', department: '勝手な部門', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.admin });
    expect(claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales });
  });

  it('境界: 社員番号の無い従業員は employeeCode を作らず、組織に無い部門は部門名を作らない（部門 id の写しは残す）', async () => {
    expect(await resolver().resolve(scope, { name: 'x', employeeId: FIXTURE_EMPLOYEE_IDS.saburo })).toEqual({ name: 'テスト三郎', department: '経理部', employeeId: FIXTURE_EMPLOYEE_IDS.saburo, departmentId: FIXTURE_DEPARTMENT_IDS.accounting });
    organization = emptyExpenseOrganization();
    expect(await resolver().resolve(scope, { name: 'x', employeeId: FIXTURE_EMPLOYEE_IDS.taro })).toEqual({ name: 'テスト太郎', employeeCode: 'E001', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales });
    await employees.save(employeeFixture('emp-nodept', { name: '部門なし' }));
    expect(await resolver().resolve(scope, { name: 'x', employeeId: 'emp-nodept' })).toEqual({ name: '部門なし', employeeId: 'emp-nodept' });
  });

  it.each([
    ['省略', undefined],
    ['空白', '  '],
  ])('境界: employeeId が%sなら本文を使い、参照の id（departmentId）は写さない', async (_label, employeeId) => {
    const find = vi.spyOn(employees, 'findById');
    const claimant = await resolver().resolve(scope, { name: 'テスト花子', employeeCode: 'E002', department: '営業部', departmentId: FIXTURE_DEPARTMENT_IDS.sales, ...(employeeId === undefined ? {} : { employeeId }) });
    expect(claimant).toEqual({ name: 'テスト花子', employeeCode: 'E002', department: '営業部' });
    expect(find).not.toHaveBeenCalled();
  });

  it('異常: 従業員マスタに無い・無効な従業員は 400（直す欄 claimant.employeeId）', async () => {
    for (const employeeId of ['emp-none', FIXTURE_EMPLOYEE_IDS.shiro]) {
      const error = await resolver().resolve(scope, { name: 'x', employeeId }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExpenseDomainError);
      expect((error as ExpenseDomainError).details).toEqual({ field: 'claimant.employeeId' });
    }
  });
});

describe('CreateExpenseClaimUseCase / UpdateExpenseClaimUseCase: 申請者の写し', () => {
  const period = { from: '2026-09-01', to: '2026-09-30' };
  let claimants: ClaimantResolver;

  beforeEach(async () => {
    const employees = new InMemoryExpenseEmployeeRepository();
    for (const employee of fixtureEmployees()) await employees.save(employee);
    claimants = new ClaimantResolver(employees, { get: async () => fixtureOrganization() });
  });

  it('正常: 作成・編集とも従業員マスタから写した申請者を保存する', async () => {
    const created = await new CreateExpenseClaimUseCase(claims, makeId, () => NOW, claimants).execute({ scope, claimant: { name: '入力', employeeId: FIXTURE_EMPLOYEE_IDS.taro }, period, by: 'alice' });
    expect(created.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales });
    await new UpdateExpenseClaimUseCase(claims, receipts, () => NOW, claimants).execute({ scope, id: created.id, claimant: { name: '入力', employeeId: FIXTURE_EMPLOYEE_IDS.hanako }, period, by: 'alice' });
    expect((await claims.findById(scope, created.id))!.claimant).toEqual({ name: 'テスト花子', employeeCode: 'E002', department: '営業部', employeeId: FIXTURE_EMPLOYEE_IDS.hanako, departmentId: FIXTURE_DEPARTMENT_IDS.sales });
  });

  it('異常: 無効な従業員を指定した作成・編集は 400 で保存しない', async () => {
    await expect(new CreateExpenseClaimUseCase(claims, makeId, () => NOW, claimants).execute({ scope, claimant: { name: 'x', employeeId: FIXTURE_EMPLOYEE_IDS.shiro }, period, by: 'a' })).rejects.toBeInstanceOf(ExpenseDomainError);
    expect(await claims.list(scope)).toEqual([]);
    await claims.save(claimFixture('c1'), new Map());
    await expect(new UpdateExpenseClaimUseCase(claims, receipts, () => NOW, claimants).execute({ scope, id: 'c1', claimant: { name: 'x', employeeId: 'emp-none' }, period, by: 'a' })).rejects.toBeInstanceOf(ExpenseDomainError);
    expect((await claims.findById(scope, 'c1'))!.claimant.name).toBe('テスト太郎');
  });

  it('境界: 解決器を配線しない構成は参照の id を写さない（クライアントの申告を信じない）', async () => {
    const created = await new CreateExpenseClaimUseCase(claims, makeId, () => NOW).execute({ scope, claimant: { name: '太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales }, period, by: 'a' });
    expect(created.claimant).toEqual({ name: '太郎' });
    const updated = await new UpdateExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, id: created.id, claimant: { name: '太郎', department: '営業部', employeeId: FIXTURE_EMPLOYEE_IDS.taro }, period, by: 'a' });
    expect(updated.claimant).toEqual({ name: '太郎', department: '営業部' });
  });
});

describe('DeleteExpenseClaimUseCase: 承認中・カード照合の解除（§20.8.3）', () => {
  const twoSteps: ApprovalPlan = {
    routeName: '2 段', unresolved: [],
    steps: [
      { stepId: 'first', name: '一次', approverKind: 'any-approver', approvers: [], skipped: false },
      { stepId: 'second', name: '二次', approverKind: 'any-approver', approvers: [], skipped: false },
    ],
  };

  it('異常: 承認中（in-approval）は承認を取り消すよう促して 409、証憑もカードの照合も触らない', async () => {
    await claims.save(approveStep(checkedClaim(), policyFixture(AT), twoSteps, [], 'boss', AT), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1' }));
    const cards = { unlinkClaim: vi.fn() };
    await expect(new DeleteExpenseClaimUseCase(claims, receipts, new NoopUnitOfWork(), cards as unknown as ExpenseCardRepository).execute(scope, 'c1')).rejects.toMatchObject({ nextStep: '承認を取り消してから削除してください' });
    expect((await claims.findById(scope, 'c1'))!.status).toBe('in-approval');
    expect(await receipts.findById(scope, 'r1')).not.toBeNull();
    expect(cards.unlinkClaim).not.toHaveBeenCalled();
  });

  it('正常: 証憑・カードの照合・申請を 1 トランザクションの中で消す', async () => {
    await claims.save(claimFixture('c1'), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1' }));
    const order: string[] = [];
    const unitOfWork = new NoopUnitOfWork();
    const transaction = unitOfWork.withTransaction.bind(unitOfWork);
    vi.spyOn(unitOfWork, 'withTransaction').mockImplementation((async (work: () => Promise<unknown>) => {
      order.push('begin');
      const result = await transaction(work);
      order.push('commit');
      return result;
    }) as never);
    vi.spyOn(receipts, 'deleteByClaim').mockImplementation(async () => { order.push('receipts'); return 1; });
    vi.spyOn(claims, 'delete').mockImplementation(async () => { order.push('claim'); return true; });
    const cards = { unlinkClaim: vi.fn(async () => { order.push('cards'); return 2; }) };
    await new DeleteExpenseClaimUseCase(claims, receipts, unitOfWork, cards as unknown as ExpenseCardRepository).execute(scope, 'c1');
    expect(cards.unlinkClaim).toHaveBeenCalledWith(scope, 'c1');
    expect(order).toEqual(['begin', 'receipts', 'cards', 'claim', 'commit']);
  });

  it('例外: 照合の解除に失敗したら申請を消さずに伝える', async () => {
    await claims.save(claimFixture('c1'), new Map());
    const cards = { unlinkClaim: vi.fn().mockRejectedValue(new Error('card store is locked')) };
    await expect(new DeleteExpenseClaimUseCase(claims, receipts, new NoopUnitOfWork(), cards as unknown as ExpenseCardRepository).execute(scope, 'c1')).rejects.toThrow('card store is locked');
    expect(await claims.findById(scope, 'c1')).not.toBeNull();
  });
});

describe('SaveExpenseItemUseCase: 構造化した読取の印と追加読取の記録（UC7）', () => {
  const detail = {
    promptVersion: 'expense-detail/v1', model: { provider: 'lm-studio', model: 'gemma-3-12b' }, readAt: AT,
    raw: {
      registrationNumberText: null, payeeNameText: 'サンプル交通', transactionDateText: '2026/09/10', issueDateText: null,
      attendees: { countText: null, names: [] }, purposeClues: ['客先訪問'], route: { from: null, to: null, via: [], fareType: null }, notes: [],
    },
    disagreements: [{ field: 'payeeName', journalValue: 'サンプル', detailValue: 'サンプル交通' }],
  };

  beforeEach(async () => {
    await claims.save(claimFixture('c1', { items: [] }), new Map());
  });

  it('正常: flags と detail を明細の読取メタに保存する', async () => {
    const claim = await saveItem().execute(itemInput({ source: { type: 'image' }, extraction: { flags: ['purpose-read', 'reads-disagree'], detail } }));
    expect(claim.items[0]!.extraction).toMatchObject({ method: 'llm', flags: ['purpose-read', 'reads-disagree'], detail });
    expect((await claims.findById(scope, 'c1'))!.items[0]!.extraction.detail).toEqual(detail);
  });

  it('境界: 空の flags・省略は印も記録も持たない（人が欄を直して印を外した保存）', async () => {
    const claim = await saveItem().execute(itemInput({ itemId: 'a', extraction: { flags: [] } }));
    expect(claim.items[0]!.extraction).not.toHaveProperty('flags');
    expect(claim.items[0]!.extraction).not.toHaveProperty('detail');
  });

  it('異常: 形の合わない記録・未知の印は 400 で保存しない', async () => {
    await expect(saveItem().execute(itemInput({ extraction: { detail: { promptVersion: '' } } }))).rejects.toBeInstanceOf(ExpenseDomainError);
    await expect(saveItem().execute(itemInput({ extraction: { flags: ['guessed' as never] } }))).rejects.toBeInstanceOf(ExpenseDomainError);
    expect((await claims.findById(scope, 'c1'))!.items).toEqual([]);
  });
});

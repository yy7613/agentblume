import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture, receiptFixture, SHA_A, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import type { ApprovalPlan } from '../../domain/expense/approval';
import { approveStep, claimFingerprint, withJudgment, type ExpenseClaim } from '../../domain/expense/claim';
import type { DuplicateCandidate } from '../../domain/expense/duplicates';
import { ExpenseClaimNotFoundError } from '../../domain/expense/errors';
import { allReasons } from '../../domain/expense/judgment';
import type { DuplicateCandidateQuery } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { CheckExpenseClaimsUseCase } from './check-claims';
import { NO_CHECK_FACTS, type ApprovalRoutePlanner, type ExpenseCheckFactsProvider } from './ports';

/** 重複候補の問い合わせ内容を記録する（全申請を読まずに索引で引いていることを確かめる）。 */
class RecordingClaimRepository extends InMemoryExpenseClaimRepository {
  readonly queries: DuplicateCandidateQuery[] = [];
  override async findDuplicateCandidates(target: TenantScope, query: DuplicateCandidateQuery): Promise<readonly DuplicateCandidate[]> {
    this.queries.push(query);
    return super.findDuplicateCandidates(target, query);
  }
}

const NOW = new Date('2026-09-15T00:00:00.000Z');
let claims: RecordingClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;

beforeEach(async () => {
  claims = new RecordingClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
  await policies.save(scope, policyFixture(AT));
});

const useCase = (now = NOW, timeZone?: string) => (timeZone === undefined
  ? new CheckExpenseClaimsUseCase(claims, receipts, policies, () => now)
  : new CheckExpenseClaimsUseCase(claims, receipts, policies, () => now, timeZone));

function judged(claim: ExpenseClaim, policyUpdatedAt: string): ExpenseClaim {
  return withJudgment(claim, { verdict: 'pass', items: [], claimReasons: [], totals: { amount: 0, byCategory: [] }, searchKeysComplete: true, policyUpdatedAt, itemsFingerprint: claimFingerprint(claim), checkedAt: AT }, AT);
}

// 初期テンプレートで理由の出ない明細（電車代は証憑不要・3 万円未満はインボイス不要）
const passItem = (id: string) => itemFixture(id, { purpose: '客先訪問' }, { categoryId: 'transport.public' });

describe('CheckExpenseClaimsUseCase: 重複候補の問い合わせ', () => {
  it('正常: 取引日 × 金額のキーと画像ハッシュを、自分の申請を除いて問い合わせる', async () => {
    await claims.save(claimFixture('c1', { items: [itemFixture('item-1', {}, { receiptId: 'r1' }), itemFixture('item-2', { amount: 0 }), itemFixture('item-3', { transactionDate: undefined })] }), new Map());
    await receipts.save(receiptFixture('r1', { claimId: 'c1', itemId: 'item-1', sha256: SHA_A }));
    await useCase().execute({ scope, claimIds: ['c1'] });
    expect(claims.queries).toEqual([{ keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [SHA_A], excludeClaimId: 'c1' }]);
  });

  it('境界: キーも画像ハッシュも無ければ問い合わせない', async () => {
    await claims.save(claimFixture('c1', { items: [itemFixture('item-1', { amount: undefined })] }), new Map());
    await useCase().execute({ scope, claimIds: ['c1'] });
    expect(claims.queries).toEqual([]);
  });

  it('正常: 他の申請の同じ取引は重複の理由になる', async () => {
    await claims.save(claimFixture('other', { status: 'approved', approval: { by: 'b', at: AT } }), new Map());
    await claims.save(claimFixture('c1'), new Map());
    await useCase().execute({ scope, claimIds: ['c1'] });
    const saved = await claims.findById(scope, 'c1');
    expect(allReasons(saved!.judgment!).map((reason) => reason.code)).toContain('duplicate-across-claims');
  });
});

describe('CheckExpenseClaimsUseCase: 対象', () => {
  it('正常: 省略時は draft と規程の版が古い checked だけを判定し、新しい checked と承認済みは触らない', async () => {
    await claims.save(claimFixture('draft'), new Map());
    await claims.save(judged(claimFixture('fresh'), AT), new Map());
    await claims.save(judged(claimFixture('stale'), '2020-01-01T00:00:00.000Z'), new Map());
    await claims.save(claimFixture('approved', { status: 'approved', approval: { by: 'b', at: AT } }), new Map());
    const result = await useCase().execute({ scope });
    expect(result.checked).toBe(2);
    expect(result.skipped).toBe(0);
    expect((await claims.findById(scope, 'fresh'))!.judgment!.checkedAt).toBe(AT);
    expect((await claims.findById(scope, 'stale'))!.judgment!.checkedAt).toBe(NOW.toISOString());
    expect((await claims.findById(scope, 'draft'))!.status).toBe('checked');
  });

  it('境界: 指定された承認済み・精算済みは判定せず skipped に数える', async () => {
    const approved = claimFixture('a', { status: 'approved', approval: { by: 'b', at: AT } });
    await claims.save(approved, new Map());
    await claims.save(claimFixture('s', { status: 'settled', approval: { by: 'b', at: AT }, settlement: { settledAt: AT, by: 'b' } }), new Map());
    const result = await useCase().execute({ scope, claimIds: ['a', 's'] });
    expect(result).toEqual({ checked: 0, pass: 0, needsReview: 0, returned: 0, skipped: 2 });
    expect(await claims.findById(scope, 'a')).toEqual(approved);
  });

  it('異常: 存在しない id が含まれれば 404 で、何も保存しない', async () => {
    await claims.save(claimFixture('c1'), new Map());
    await expect(useCase().execute({ scope, claimIds: ['c1', 'none'] })).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
    expect((await claims.findById(scope, 'c1'))!.status).toBe('draft');
  });
});

describe('CheckExpenseClaimsUseCase: 判定の保存と件数', () => {
  it('正常: 判定に規程の版・明細の指紋・判定時刻を付けて保存し、判定結果ごとに数える', async () => {
    // 金額を申請ごとにずらす（同じ取引だと互いに重複の理由を出してしまう）
    const pass = claimFixture('pass', { items: [itemFixture('item-1', { purpose: '客先訪問', amount: 301 }, { categoryId: 'transport.public' })] });
    await claims.save(pass, new Map());
    await claims.save(claimFixture('review', { items: [itemFixture('item-1', { purpose: undefined, amount: 302 }, { categoryId: 'transport.public' })] }), new Map());
    await claims.save(claimFixture('returned', { items: [itemFixture('item-1', { amount: 303 })] }), new Map());
    const result = await useCase().execute({ scope, claimIds: ['pass', 'review', 'returned'], by: 'checker' });
    expect(result).toEqual({ checked: 3, pass: 1, needsReview: 1, returned: 1, skipped: 0 });
    const saved = await claims.findById(scope, 'pass');
    expect(saved!.judgment).toMatchObject({ verdict: 'pass', policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(pass), checkedAt: NOW.toISOString() });
    expect(saved!.history.at(-1)).toMatchObject({ type: 'checked', by: 'checker' });
  });

  it('正常: 規程が未保存なら policy-unreviewed が出る', async () => {
    const unsaved = new InMemoryExpensePolicyRepository();
    await claims.save(claimFixture('c1', { items: [passItem('item-1')] }), new Map());
    await new CheckExpenseClaimsUseCase(claims, receipts, unsaved, () => NOW).execute({ scope, claimIds: ['c1'] });
    expect(allReasons((await claims.findById(scope, 'c1'))!.judgment!).map((reason) => reason.code)).toEqual(['policy-unreviewed']);
  });

  it('境界: 判定日は業務タイムゾーン（UTC 2026-09-30T23:30Z は JST 10/01 なので当日のレシートは未来でない）', async () => {
    const claim = claimFixture('c1', { period: { from: '2026-10-01', to: '2026-10-31' }, items: [itemFixture('item-1', { transactionDate: '2026-10-01', purpose: '訪問' }, { categoryId: 'transport.public', addedOn: '2026-10-01' })] });
    await claims.save(claim, new Map());
    const now = new Date('2026-09-30T23:30:00.000Z');
    await useCase(now).execute({ scope, claimIds: ['c1'] });
    expect(allReasons((await claims.findById(scope, 'c1'))!.judgment!).map((reason) => reason.code)).not.toContain('date-in-future');
    // UTC の日付で判定すると未来日になる（タイムゾーンを注入していることの対照）
    await useCase(now, 'UTC').execute({ scope, claimIds: ['c1'] });
    expect(allReasons((await claims.findById(scope, 'c1'))!.judgment!).map((reason) => reason.code)).toContain('date-in-future');
  });
});

describe('CheckExpenseClaimsUseCase: 系統の事実（provider。§20.3.1）', () => {
  it('正常: すべての provider を申請・規程・業務日で呼び、集めた事実で系統の理由が足される（マスタを使っていて未紐付け → claimant-unlinked だけが増える）', async () => {
    const claim = claimFixture('c1', { items: [passItem('item-1')] });
    await claims.save(claim, new Map());
    await useCase().execute({ scope, claimIds: ['c1'] });
    const withoutFacts = (await claims.findById(scope, 'c1'))!.judgment!;

    await claims.save(claim, new Map());
    const people: ExpenseCheckFactsProvider = { gather: vi.fn().mockResolvedValue({ people: { masterInUse: true } }) };
    const money: ExpenseCheckFactsProvider = { gather: vi.fn().mockResolvedValue({}) };
    const result = await new CheckExpenseClaimsUseCase(claims, receipts, policies, () => NOW, undefined, [people, money, NO_CHECK_FACTS]).execute({ scope, claimIds: ['c1'] });
    expect(result).toEqual({ checked: 1, pass: 0, needsReview: 1, returned: 0, skipped: 0 });
    for (const provider of [people, money]) {
      expect(provider.gather).toHaveBeenCalledTimes(1);
      expect(provider.gather).toHaveBeenCalledWith(scope, expect.objectContaining({ id: 'c1', status: 'draft' }), expect.objectContaining({ updatedAt: AT }), '2026-09-15');
    }
    // 事実のない判定との差は、A の claimant-unlinked が足されることだけ（ほかの理由はそのまま）。
    const withFacts = allReasons((await claims.findById(scope, 'c1'))!.judgment!);
    expect(withFacts.filter((reason) => reason.code !== 'claimant-unlinked')).toEqual(allReasons(withoutFacts));
    expect(withFacts.map((reason) => reason.code)).toContain('claimant-unlinked');
  });

  it('境界: 事実を集めない provider（NO_CHECK_FACTS）は空の事実を返す', async () => {
    expect(await NO_CHECK_FACTS.gather(scope, claimFixture('c1'), policyFixture(), '2026-09-15')).toEqual({});
  });

  it('例外: provider の失敗はそのまま伝え、その申請を保存しない（事実が欠けたまま判定しない）', async () => {
    await claims.save(claimFixture('c1'), new Map());
    const broken: ExpenseCheckFactsProvider = { gather: vi.fn().mockRejectedValue(new Error('employee master is unavailable')) };
    await expect(new CheckExpenseClaimsUseCase(claims, receipts, policies, () => NOW, undefined, [broken]).execute({ scope, claimIds: ['c1'] })).rejects.toThrow('employee master is unavailable');
    expect((await claims.findById(scope, 'c1'))!.status).toBe('draft');
  });
});

describe('CheckExpenseClaimsUseCase: 現在の段の承認者の索引（「あなたの承認待ち」）', () => {
  const planner = (approvers: readonly string[]): ApprovalRoutePlanner => ({ plan: vi.fn(), actorBlockers: vi.fn(), currentApprovers: vi.fn().mockResolvedValue(approvers) });

  it('正常: プランナーが返す承認者を判定した申請と一緒に保存する', async () => {
    await claims.save(claimFixture('c1'), new Map());
    const withPlanner = planner(['emp-hanako', 'emp-jiro']);
    await new CheckExpenseClaimsUseCase(claims, receipts, policies, () => NOW, undefined, [], withPlanner).execute({ scope, claimIds: ['c1'] });
    expect(withPlanner.currentApprovers).toHaveBeenCalledWith(scope, expect.objectContaining({ id: 'c1', status: 'checked', judgment: expect.objectContaining({ checkedAt: NOW.toISOString() }) }), expect.objectContaining({ updatedAt: AT }));
    expect((await claims.list(scope, { awaitingEmployeeId: 'emp-jiro' })).map((summary) => summary.id)).toEqual(['c1']);
  });

  it('境界: プランナーを渡さなければ承認者を空で保存し直す（古い索引を残さない）', async () => {
    await claims.save(claimFixture('c1'), new Map(), ['emp-hanako']);
    expect(await claims.list(scope, { awaitingEmployeeId: 'emp-hanako' })).toHaveLength(1);
    await useCase().execute({ scope, claimIds: ['c1'] });
    expect(await claims.list(scope, { awaitingEmployeeId: 'emp-hanako' })).toEqual([]);
  });
});

describe('CheckExpenseClaimsUseCase: 承認中（in-approval）の再チェック', () => {
  const twoSteps: ApprovalPlan = {
    routeId: 'r1', routeName: '部門長 → 経理', unresolved: [],
    steps: [
      { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'emp-hanako', name: 'テスト花子' }], skipped: false },
      { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'emp-jiro', name: 'テスト次郎' }], skipped: false },
    ],
  };
  const inApproval = (id: string, amount: number): ExpenseClaim => approveStep(judged(claimFixture(id, { items: [itemFixture('item-1', { amount })] }), AT), policyFixture(AT), twoSteps, [], 'hanako', AT, { employeeId: 'emp-hanako' });

  it('正常: 省略時の対象に規程の版が古い in-approval も含め、段の承認を捨てて checked に戻す。新しい in-approval は触らない', async () => {
    await claims.save(inApproval('fresh', 1001), new Map());
    expect((await useCase().execute({ scope })).checked).toBe(0);
    expect((await claims.findById(scope, 'fresh'))!.status).toBe('in-approval');

    await claims.save(inApproval('stale', 1002), new Map());
    await policies.save(scope, policyFixture('2026-09-15T01:00:00.000Z'));
    const result = await useCase().execute({ scope });
    // 規程を保存し直したので、どちらの承認中も古い判定になり再チェックの対象になる。
    expect(result.checked).toBe(2);
    const saved = await claims.findById(scope, 'stale');
    expect(saved!.status).toBe('checked');
    expect(saved!.approvalFlow).toBeUndefined();
    expect(saved!.judgment!.policyUpdatedAt).toBe('2026-09-15T01:00:00.000Z');
  });
});

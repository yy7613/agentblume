import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { fixtureOrganization, FIXTURE_DEPARTMENT_IDS, FIXTURE_EMPLOYEE_IDS } from '../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import type { CreateExpenseClaimProps } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseJournalLinkError, ExpenseTransitionError } from '../../domain/expense/errors';
import { createExpensePolicy, type ExpensePolicy } from '../../domain/expense/policy';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DraftJournalEntriesUseCase, JournalDraftRejectedError, type ExpenseJournalDraft, type JournalDraftSink } from './draft-journal-entries';
import type { JournalChartReadPort, OrganizationReadPort } from './ports';

const NOW = new Date('2026-09-20T00:00:00.000Z');
const REG = 'T1234567890123';

/** 仕訳側の偽物。`failAt` 回目（1 始まり）の呼び出しで `failure` を投げる。 */
class FakeSink implements JournalDraftSink {
  readonly drafts: ExpenseJournalDraft[] = [];
  private calls = 0;
  constructor(private readonly failAt?: number, private readonly failure: Error = new JournalDraftRejectedError('account expense.travel is disabled')) {}
  async createDraft(_scope: TenantScope, draft: ExpenseJournalDraft): Promise<{ entryId: string }> {
    this.calls += 1;
    if (this.calls === this.failAt) throw this.failure;
    this.drafts.push(draft);
    return { entryId: `entry-${draft.source.itemId}` };
  }
}

let claims: InMemoryExpenseClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;

beforeEach(async () => {
  claims = new InMemoryExpenseClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
});

const threeItems = ['item-1', 'item-2', 'item-3'].map((id) => itemFixture(id, { registrationNumber: REG }));
async function seed(overrides: Partial<CreateExpenseClaimProps> = {}): Promise<void> {
  await claims.save(claimFixture('c1', { status: 'approved', approval: { by: 'boss', at: AT }, items: threeItems, ...overrides }), new Map());
}
const useCase = (sink: JournalDraftSink | undefined) => new DraftJournalEntriesUseCase(claims, receipts, policies, sink, () => NOW);
const run = (sink: JournalDraftSink | undefined) => useCase(sink).execute({ scope, claimId: 'c1', by: 'acct' });

async function linkError(promise: Promise<unknown>): Promise<ExpenseJournalLinkError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ExpenseJournalLinkError);
  return error as ExpenseJournalLinkError;
}

describe('DraftJournalEntriesUseCase: 正常', () => {
  it('正常: 全明細の下書きを作り complete と journal-drafted の履歴を保存する', async () => {
    await seed();
    const sink = new FakeSink();
    const result = await run(sink);
    expect(sink.drafts.map((draft) => draft.source.itemId)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(result.entryIds).toEqual(['entry-item-1', 'entry-item-2', 'entry-item-3']);
    expect(result.warnings).toEqual([]);
    const saved = await claims.findById(scope, 'c1');
    expect(saved!.journalLink).toMatchObject({ complete: true, by: 'acct', draftedAt: NOW.toISOString(), entries: [{ itemId: 'item-1', entryId: 'entry-item-1' }, { itemId: 'item-2', entryId: 'entry-item-2' }, { itemId: 'item-3', entryId: 'entry-item-3' }] });
    expect(saved!.history.at(-1)).toMatchObject({ type: 'journal-drafted', note: '3 entries' });
  });

  it('正常: 精算済みの申請からも作れる', async () => {
    await seed({ status: 'settled', settlement: { settledAt: AT, by: 'acct' } });
    expect((await run(new FakeSink())).claim.journalLink!.complete).toBe(true);
  });
});

describe('DraftJournalEntriesUseCase: problems', () => {
  it('異常: problems があれば仕訳を 1 件も作らず ExpenseJournalLinkError', async () => {
    await seed({ items: [itemFixture('item-1', { registrationNumber: REG }), itemFixture('item-2', {}, { categoryId: undefined })] });
    const sink = new FakeSink();
    const error = await linkError(run(sink));
    expect(sink.drafts).toEqual([]);
    expect(error.problems).toEqual([expect.objectContaining({ itemId: 'item-2', code: 'category-missing', fixTarget: 'item' })]);
    expect(error.createdEntryIds).toEqual([]);
    expect((await claims.findById(scope, 'c1'))!.journalLink).toBeUndefined();
  });

  it('異常: 作成途中の申請で problems が出たら、作成済みの id を createdEntryIds に載せる', async () => {
    await seed({ items: [itemFixture('item-1', { registrationNumber: REG }), itemFixture('item-2', {}, { categoryId: undefined })], journalLink: { entries: [{ itemId: 'item-1', entryId: 'entry-item-1' }], complete: false, draftedAt: AT, by: 'acct', warnings: [] } });
    expect((await linkError(run(new FakeSink()))).createdEntryIds).toEqual(['entry-item-1']);
  });
});

describe('DraftJournalEntriesUseCase: 途中の拒否と再開', () => {
  it('異常: 途中で仕訳側に拒否されたら、作れた分を complete false で保存してから投げる', async () => {
    await seed();
    const error = await linkError(run(new FakeSink(2)));
    expect(error.createdEntryIds).toEqual(['entry-item-1']);
    expect(error.problems).toEqual([expect.objectContaining({ itemId: 'item-2', code: 'journal-rejected', fixTarget: 'journal-chart', categoryId: 'transport.taxi', accountId: 'expense.travel' })]);
    expect(error.problems[0]!.message).toContain('1 件は仕訳画面に下書きとして作成済みです');
    expect(error.problems[0]!.message).toContain('account expense.travel is disabled');
    const saved = await claims.findById(scope, 'c1');
    expect(saved!.journalLink).toMatchObject({ complete: false, entries: [{ itemId: 'item-1', entryId: 'entry-item-1' }] });
    expect(saved!.history.at(-1)?.type).not.toBe('journal-drafted');
  });

  it('正常: 再実行では残りの明細だけを作り、二重に作らない', async () => {
    await seed();
    await linkError(run(new FakeSink(2)));
    const retry = new FakeSink();
    const result = await run(retry);
    expect(retry.drafts.map((draft) => draft.source.itemId)).toEqual(['item-2', 'item-3']);
    expect(result.entryIds).toEqual(['entry-item-2', 'entry-item-3']);
    expect(result.claim.journalLink).toMatchObject({ complete: true });
    expect(result.claim.journalLink!.entries.map((entry) => entry.itemId)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('境界: 最初の 1 件で拒否されたら記録を残さない', async () => {
    await seed();
    const error = await linkError(run(new FakeSink(1)));
    expect(error.createdEntryIds).toEqual([]);
    expect(error.problems[0]!.message).toContain('0 件は仕訳画面に');
    expect((await claims.findById(scope, 'c1'))!.journalLink).toBeUndefined();
  });

  it('例外: 予期しない例外でも作成済み分を記録してから同じ例外を投げ直す', async () => {
    await seed();
    const boom = new Error('connection lost');
    await expect(run(new FakeSink(3, boom))).rejects.toBe(boom);
    expect((await claims.findById(scope, 'c1'))!.journalLink).toMatchObject({ complete: false, entries: [{ itemId: 'item-1' }, { itemId: 'item-2' }] });
  });
});

describe('DraftJournalEntriesUseCase: 前提', () => {
  it('異常: 承認済み・精算済み以外は 409', async () => {
    await claims.save(claimFixture('c1', { status: 'checked' }), new Map());
    await expect(run(new FakeSink())).rejects.toMatchObject({ nextStep: '承認してから仕訳下書きを作成してください' });
  });

  it('異常: complete 済みは 409', async () => {
    await seed({ journalLink: { entries: [], complete: true, draftedAt: AT, by: 'acct', warnings: [] } });
    await expect(run(new FakeSink())).rejects.toMatchObject({ nextStep: expect.stringContaining('作成済み') });
  });

  it('異常: 仕訳連携が配線されていなければ 409（精算 CSV を案内）', async () => {
    await seed();
    const promise = run(undefined);
    await expect(promise).rejects.toBeInstanceOf(ExpenseTransitionError);
    await expect(promise).rejects.toMatchObject({ nextStep: expect.stringContaining('精算 CSV') });
  });

  it('異常: 無い申請は 404', async () => {
    await expect(run(new FakeSink())).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });

  it('正常: now を省略すると現在時刻で記録する', async () => {
    const before = Date.now();
    await seed();
    const result = await new DraftJournalEntriesUseCase(claims, receipts, policies, new FakeSink()).execute({ scope, claimId: 'c1', by: 'acct' });
    expect(Date.parse(result.claim.journalLink!.draftedAt)).toBeGreaterThanOrEqual(before);
  });
});

/* ---------------------------------------------------------------------------
 * 実用化（§20.12）: 部門の補助軸・会社払いの貸方
 * ------------------------------------------------------------------------- */

describe('DraftJournalEntriesUseCase: 部門の補助軸', () => {
  const withDimension = (): ExpensePolicy => {
    const base = policyFixture(AT);
    return createExpensePolicy({ ...base, journal: { ...base.journal, departmentDimensionId: 'department' } });
  };
  const salesClaimant = { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales };
  const organization = () => ({ get: vi.fn(async () => fixtureOrganization()) });
  const chart = (values: readonly { readonly id: string; readonly enabled: boolean }[] = [{ id: 'dept-sales', enabled: true }], dimensionId = 'department') => ({
    read: vi.fn(async () => ({ accounts: [], dimensions: [{ id: dimensionId, name: '部門', values: values.map((value) => ({ ...value, name: value.id })) }] })),
  });
  const runWith = (sink: JournalDraftSink, org?: OrganizationReadPort, journalChart?: JournalChartReadPort) => new DraftJournalEntriesUseCase(claims, receipts, policies, sink, () => NOW, org, journalChart).execute({ scope, claimId: 'c1', by: 'acct' });

  it('正常: 規程の補助軸 id と部門の値がそろい、科目マスタに有効な値があれば、借方の行へ部門の補助軸を入れる（貸方には入れない）', async () => {
    await policies.save(scope, withDimension());
    await seed({ claimant: salesClaimant });
    const sink = new FakeSink();
    const org = organization();
    const journalChart = chart();
    await runWith(sink, org, journalChart);
    expect(sink.drafts).toHaveLength(3);
    for (const draft of sink.drafts) {
      expect(draft.lines.filter((line) => line.side === 'debit').map((line) => line.dimensionValues)).toEqual([{ department: 'dept-sales' }]);
      expect(draft.lines.find((line) => line.side === 'credit')).not.toHaveProperty('dimensionValues');
    }
    expect(org.get).toHaveBeenCalledWith(scope);
    expect(journalChart.read).toHaveBeenCalledTimes(1);
  });

  it('境界: 規程に補助軸 id が無ければ組織も科目マスタも読まず、補助軸を入れない', async () => {
    await seed({ claimant: salesClaimant });
    const sink = new FakeSink();
    const org = organization();
    const journalChart = chart();
    await runWith(sink, org, journalChart);
    expect(org.get).not.toHaveBeenCalled();
    expect(journalChart.read).not.toHaveBeenCalled();
    expect(sink.drafts.flatMap((draft) => draft.lines).some((line) => line.dimensionValues !== undefined)).toBe(false);
  });

  it('境界: 組織の読み取りを配線しない構成・部門に値が無い申請者は補助軸を入れず、科目マスタも照合しない', async () => {
    await policies.save(scope, withDimension());
    const journalChart = chart([]);
    await seed({ claimant: salesClaimant });
    const noOrganization = new FakeSink();
    await runWith(noOrganization, undefined, journalChart);
    expect(noOrganization.drafts.flatMap((draft) => draft.lines).some((line) => line.dimensionValues !== undefined)).toBe(false);

    await seed({ claimant: { name: 'テスト次郎', employeeId: FIXTURE_EMPLOYEE_IDS.jiro, departmentId: FIXTURE_DEPARTMENT_IDS.admin } });
    const noValue = new FakeSink();
    await runWith(noValue, organization(), journalChart);
    expect(noValue.drafts.flatMap((draft) => draft.lines).some((line) => line.dimensionValues !== undefined)).toBe(false);
    expect(journalChart.read).not.toHaveBeenCalled();
  });

  it('境界: 科目マスタの照合を配線しない構成は照合せずに補助軸を入れる', async () => {
    await policies.save(scope, withDimension());
    await seed({ claimant: salesClaimant });
    const sink = new FakeSink();
    await runWith(sink, organization());
    expect(sink.drafts[0]!.lines[0]!.dimensionValues).toEqual({ department: 'dept-sales' });
  });

  it.each([
    ['科目マスタに値が無い', [{ id: 'dept-other', enabled: true }], 'department'],
    ['値が無効', [{ id: 'dept-sales', enabled: false }], 'department'],
    ['補助軸そのものが無い', [{ id: 'dept-sales', enabled: true }], 'project'],
  ] as const)('異常: %s なら department-dimension-unknown（組織へ導線）で 1 件も作らない', async (_label, values, dimensionId) => {
    await policies.save(scope, withDimension());
    await seed({ claimant: salesClaimant });
    const sink = new FakeSink();
    const error = await linkError(runWith(sink, organization(), chart(values, dimensionId)));
    expect(error.problems).toEqual([{ code: 'department-dimension-unknown', fixTarget: 'organization', departmentId: 'dept-sales', message: expect.stringContaining('部門『営業部』の仕訳の補助軸の値『dept-sales』が科目マスタに無いか無効です') }]);
    expect(error.createdEntryIds).toEqual([]);
    expect(sink.drafts).toEqual([]);
    expect((await claims.findById(scope, 'c1'))!.journalLink).toBeUndefined();
  });

  it('異常: 明細の問題と補助軸の問題は一緒に並べる（直す場所を一度に見せる）', async () => {
    await policies.save(scope, withDimension());
    await seed({ claimant: salesClaimant, items: [itemFixture('item-1', {}, { categoryId: undefined })] });
    const error = await linkError(runWith(new FakeSink(), organization(), chart([])));
    expect(error.problems.map((problem) => problem.code)).toEqual(['category-missing', 'department-dimension-unknown']);
  });
});

describe('DraftJournalEntriesUseCase: 会社払いの明細の貸方', () => {
  it('正常: 会社払いを申請に含める運用では、会社払いの明細の貸方を規程のカードの未払金にし、出所を card-item にする', async () => {
    const base = policyFixture(AT);
    await policies.save(scope, createExpensePolicy({ ...base, card: { ...base.card, acceptCorporatePaymentItems: true, creditAccountId: 'liability.accounts_payable' } }));
    await seed({ items: [itemFixture('item-1', { registrationNumber: REG }), itemFixture('item-2', { registrationNumber: REG, corporatePayment: true, paymentMethod: 'credit_card' })] });
    const sink = new FakeSink();
    const result = await run(sink);
    expect(sink.drafts.map((draft) => [draft.source, draft.lines.at(-1)?.accountId])).toEqual([
      [{ kind: 'claim-item', id: 'c1', itemId: 'item-1' }, base.journal.creditAccountId],
      [{ kind: 'card-item', id: 'c1', itemId: 'item-2' }, 'liability.accounts_payable'],
    ]);
    expect(sink.drafts[1]!.tags).toContain('expense-card');
    expect(result.claim.journalLink!.entries).toEqual([{ itemId: 'item-1', entryId: 'entry-item-1' }, { itemId: 'item-2', entryId: 'entry-item-2' }]);
  });
});

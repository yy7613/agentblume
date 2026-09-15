import { describe, expect, it } from 'vitest';
import { moneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, FIXTURE_EMPLOYEE_IDS } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseJournalLinkError } from '../../../domain/expense/errors';
import type { JournalChartReadPort } from '../ports';
import { DraftAdvanceJournalEntriesUseCase } from './advance-journal-drafts';

const approval = { by: 'shonin', at: '2026-09-15T00:00:00.000Z' };
const chartWithout = (missing: string): JournalChartReadPort => ({
  read: async () => ({
    accounts: ['asset.suspense_paid', 'asset.ordinary_deposit', 'liability.accrued_expenses', 'liability.other_payables'].map((id) => ({ id, name: id, enabled: id !== missing })),
    dimensions: [],
  }),
});

async function problemsOf(work: Promise<unknown>): Promise<readonly { code: string }[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ExpenseJournalLinkError) return error.problems;
    throw error;
  }
  throw new Error('expected ExpenseJournalLinkError');
}

describe('DraftAdvanceJournalEntriesUseCase', () => {
  it('正常: 支払の仕訳下書きを作り、仕訳 id を仮払に記録する', async () => {
    const ctx = moneyTestContext();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    const result = await new DraftAdvanceJournalEntriesUseCase(ctx.deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'keiri' });
    expect(result.entryIds).toEqual(['je-1']);
    expect(ctx.journal.drafts[0]?.draft).toMatchObject({ source: { kind: 'advance-payment', id: 'adv-paid' }, tags: ['expense', 'expense-advance:adv-paid', 'expense-advance-payment'] });
    expect((await ctx.advances.findById(scope, 'adv-paid'))?.journalLink?.paymentEntryId).toBe('je-1');
    // 作成済みは二重に作らない。
    expect((await problemsOf(new DraftAdvanceJournalEntriesUseCase(ctx.deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'keiri' }))).map((problem) => problem.code)).toEqual(['advance-journal-exists']);
  });

  it('異常: 仕訳連携が無い構成・科目マスタに無い科目・仕訳側の拒否は理由付きで止め、仮払を変えない', async () => {
    const detached = moneyTestContext({ journal: false });
    await detached.advances.save(advanceFixture('adv-paid', 'paid'));
    expect((await problemsOf(new DraftAdvanceJournalEntriesUseCase(detached.deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'k' }))).map((problem) => problem.code)).toEqual(['journal-unavailable']);

    const chart = moneyTestContext({ chart: chartWithout('asset.suspense_paid') });
    await chart.advances.save(advanceFixture('adv-paid', 'paid'));
    expect((await problemsOf(new DraftAdvanceJournalEntriesUseCase(chart.deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'k' }))).map((problem) => problem.code)).toEqual(['account-not-in-chart']);

    const rejected = moneyTestContext();
    await rejected.advances.save(advanceFixture('adv-paid', 'paid'));
    rejected.journal.reject = '科目が無効です';
    expect((await problemsOf(new DraftAdvanceJournalEntriesUseCase(rejected.deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'k' }))).map((problem) => problem.code)).toEqual(['journal-rejected']);
    expect((await rejected.advances.findById(scope, 'adv-paid'))?.journalLink).toBeUndefined();
  });

  it('例外: 仕訳側の想定外の失敗はそのまま伝える', async () => {
    const ctx = moneyTestContext();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    const deps = { ...ctx.deps, journalDrafts: { createDraft: async () => { throw new Error('disk full'); } } };
    await expect(new DraftAdvanceJournalEntriesUseCase(deps).execute({ scope, advanceId: 'adv-paid', stage: 'payment', by: 'k' })).rejects.toThrow('disk full');
  });

  it('異常→正常: 精算の下書きは紐付く申請の明細の下書きが揃うまで作らず、揃えば作る', async () => {
    const ctx = moneyTestContext({ chart: chartWithout('none') });
    await ctx.advances.save(advanceFixture('adv-settled', 'settled'));
    const claimant = { name: 'テスト三郎', employeeId: FIXTURE_EMPLOYEE_IDS.saburo };
    await ctx.claims.save(claimFixture('claim-advance-1', { advanceId: 'adv-settled', claimant, status: 'approved', approval }), new Map());
    const drafts = new DraftAdvanceJournalEntriesUseCase(ctx.deps);
    expect((await problemsOf(drafts.execute({ scope, advanceId: 'adv-settled', stage: 'settlement', by: 'k' }))).map((problem) => problem.code)).toEqual(['advance-claim-journal-missing']);
    await ctx.claims.save(claimFixture('claim-advance-1', {
      advanceId: 'adv-settled', claimant, status: 'approved', approval,
      journalLink: { entries: [{ itemId: 'item-1', entryId: 'je-item' }], complete: true, draftedAt: approval.at, by: 'k', warnings: [] },
    }), new Map());
    const result = await drafts.execute({ scope, advanceId: 'adv-settled', stage: 'settlement', by: 'k' });
    expect(result.advance.journalLink?.settlementEntryId).toBe('je-1');
    expect(ctx.journal.drafts[0]?.draft.source).toEqual({ kind: 'advance-settlement', id: 'adv-settled' });
  });
});

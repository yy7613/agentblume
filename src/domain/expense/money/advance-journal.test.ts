import { describe, expect, it } from 'vitest';
import { createExpenseAdvance, type CreateExpenseAdvanceProps, type ExpenseAdvance } from '../advance';
import { defaultExpensePolicy } from '../default-policy';
import { buildAdvanceJournalDraft } from './advance-journal';

const AT = '2026-09-01T00:00:00.000Z';
const policy = defaultExpensePolicy();

function advance(overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  return createExpenseAdvance({
    tenant: { tenantId: 't', workspaceId: 'w' }, id: 'adv-1', employeeId: 'emp-taro', employeeSnapshot: { name: 'テスト太郎' },
    purpose: '大阪出張', amount: 30000, neededOn: '2026-09-05', plannedSettleBy: '2026-09-30', status: 'paid',
    approval: { by: 's', at: AT, proxy: false }, payment: { paidOn: '2026-09-03', method: 'transfer', by: 'k', at: AT },
    submittedBy: 'taro', createdAt: AT, updatedAt: AT, ...overrides,
  });
}

function settled(claimsTotal: number, overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  const difference = claimsTotal - 30000;
  return advance({
    status: 'settling',
    settlement: {
      computedAt: '2026-09-20T03:00:00.000Z', claimIds: ['c1'], claimsTotal, difference,
      ...(difference > 0 ? { additionalPayment: { amount: difference, status: 'pending' as const } } : {}),
      ...(difference < 0 ? { refund: { amount: -difference } } : {}),
    },
    ...overrides,
  });
}

const sum = (lines: readonly { side: string; amount: number }[], side: string): number => lines.filter((line) => line.side === side).reduce((total, line) => total + line.amount, 0);

describe('buildAdvanceJournalDraft: 支払', () => {
  it('正常: 仮払金 / 普通預金（取引先 = 従業員）。インボイス区分 not_required・税区分 JP-NA・出所とタグ', () => {
    const { draft, problems } = buildAdvanceJournalDraft(advance(), policy, 'payment');
    expect(problems).toEqual([]);
    expect(draft).toEqual({
      source: { kind: 'advance-payment', id: 'adv-1' }, date: '2026-09-03', description: '仮払 テスト太郎 大阪出張', invoiceStatus: 'not_required',
      lines: [
        { side: 'debit', accountId: 'asset.suspense_paid', taxCode: 'JP-NA', amount: 30000, partner: 'テスト太郎' },
        { side: 'credit', accountId: 'asset.ordinary_deposit', taxCode: 'JP-NA', amount: 30000 },
      ],
      tags: ['expense', 'expense-advance:adv-1', 'expense-advance-payment'],
    });
  });

  it('異常: 支払前・作成済みは問題を返して下書きを作らない', () => {
    expect(buildAdvanceJournalDraft(advance({ status: 'approved', payment: undefined }), policy, 'payment').problems[0]?.code).toBe('advance-not-paid');
    expect(buildAdvanceJournalDraft(advance({ journalLink: { paymentEntryId: 'je-1', warnings: [] } }), policy, 'payment').problems[0]?.code).toBe('advance-journal-exists');
  });

  it('異常: 科目マスタに無い科目は journal-chart の問題（重複しない）', () => {
    const { draft, problems } = buildAdvanceJournalDraft(advance(), policy, 'payment', new Set(['asset.ordinary_deposit']));
    expect(draft).toBeUndefined();
    expect(problems).toEqual([expect.objectContaining({ code: 'account-not-in-chart', accountId: 'asset.suspense_paid', fixTarget: 'journal-chart' })]);
  });
});

describe('buildAdvanceJournalDraft: 精算', () => {
  it('正常: 承認額合計 ≥ 仮払額なら「未払金 A / 仮払金 A」で貸借が一致する', () => {
    const { draft } = buildAdvanceJournalDraft(settled(32000), policy, 'settlement');
    expect(draft?.lines).toEqual([
      { side: 'debit', accountId: policy.journal.creditAccountId, taxCode: 'JP-NA', amount: 30000, partner: 'テスト太郎' },
      { side: 'credit', accountId: 'asset.suspense_paid', taxCode: 'JP-NA', amount: 30000, partner: 'テスト太郎' },
    ]);
    expect(draft?.date).toBe('2026-09-20');
    expect(draft?.tags).toContain('expense-advance-settlement');
  });

  it('正常: 承認額合計 < 仮払額なら「未払金 C + 普通預金 (A − C) / 仮払金 A」で貸借が一致する', () => {
    const { draft } = buildAdvanceJournalDraft(settled(25000, { status: 'settled', settlement: { computedAt: '2026-09-20T03:00:00.000Z', claimIds: ['c1'], claimsTotal: 25000, difference: -5000, refund: { amount: 5000, receivedOn: '2026-09-22' }, settledOn: '2026-09-22' } }), policy, 'settlement');
    expect(draft?.lines.map((line) => [line.side, line.accountId, line.amount])).toEqual([
      ['debit', policy.journal.creditAccountId, 25000], ['debit', 'asset.ordinary_deposit', 5000], ['credit', 'asset.suspense_paid', 30000],
    ]);
    expect(sum(draft?.lines ?? [], 'debit')).toBe(sum(draft?.lines ?? [], 'credit'));
    expect(draft?.date).toBe('2026-09-22');
  });

  it('境界: 紐付く申請が 0 円（全額返金）なら未払金の行を作らない', () => {
    const { draft } = buildAdvanceJournalDraft(settled(0), policy, 'settlement');
    expect(draft?.lines.map((line) => [line.side, line.accountId, line.amount])).toEqual([['debit', 'asset.ordinary_deposit', 30000], ['credit', 'asset.suspense_paid', 30000]]);
  });

  it('異常: 精算前・作成済み・科目マスタに無い返金の科目は問題になる', () => {
    expect(buildAdvanceJournalDraft(advance(), policy, 'settlement').problems[0]?.code).toBe('advance-not-settled');
    expect(buildAdvanceJournalDraft(settled(30000, { status: 'settled', settlement: { computedAt: AT, claimIds: [], claimsTotal: 30000, difference: 0, settledOn: '2026-09-20' }, journalLink: { settlementEntryId: 'je-9', warnings: [] } }), policy, 'settlement').problems[0]?.code).toBe('advance-journal-exists');
    const known = new Set([policy.journal.creditAccountId, 'asset.suspense_paid']);
    expect(buildAdvanceJournalDraft(settled(20000), policy, 'settlement', known).problems.map((problem) => problem.accountId)).toEqual(['asset.ordinary_deposit']);
  });
});

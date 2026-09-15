import { describe, expect, it } from 'vitest';
import { createExpenseAdvance, type ExpenseAdvance } from '../advance';
import { defaultExpensePolicy } from '../default-policy';
import { ExpenseTransitionError } from '../errors';
import type { ExpensePayoutBatch } from '../payout';
import { clearAdditionalPaymentExport, markAdditionalPaymentExported, payAdvanceAdditional } from './advance-transitions';
import { buildPayoutJournalDraft } from './payout-journal';

const AT = '2026-09-20T00:00:00.000Z';

describe('buildPayoutJournalDraft', () => {
  it('正常: 申請・追加支給は未払金、仮払の支払は仮払金を従業員ごとに借方、振込元の預金に合計を貸方（貸借一致）', () => {
    const batch = {
      id: 'batch-1', transferDate: '2026-09-25', fileName: 'zengin-sofuri-20260925-batch-1.txt', totalAmount: 37180,
      settingsSnapshot: { journal: { createPaymentEntry: true, sourceAccountId: 'asset.ordinary_deposit' } },
      lines: [
        { name: 'テスト太郎', sources: [{ kind: 'claim', id: 'c1', amount: 3000 }, { kind: 'claim', id: 'c2', amount: 2180 }, { kind: 'advance-additional', id: 'a2', amount: 2000 }] },
        { name: 'テスト花子', sources: [{ kind: 'advance-payment', id: 'a1', amount: 30000 }] },
      ],
    } as unknown as ExpensePayoutBatch;
    const policy = defaultExpensePolicy();
    const draft = buildPayoutJournalDraft(batch, policy);
    expect(draft).toMatchObject({ source: { kind: 'payout', id: 'batch-1' }, date: '2026-09-25', invoiceStatus: 'not_required', tags: ['expense', 'expense-payout:batch-1'] });
    expect(draft.lines.map((line) => [line.side, line.accountId, line.amount, line.partner])).toEqual([
      ['debit', policy.journal.creditAccountId, 7180, 'テスト太郎'], ['debit', policy.advance.advanceAccountId, 30000, 'テスト花子'], ['credit', 'asset.ordinary_deposit', 37180, undefined],
    ]);
  });
});

describe('追加支給の振込の印（advance-transitions）', () => {
  const settling = (): ExpenseAdvance => createExpenseAdvance({
    tenant: { tenantId: 't', workspaceId: 'w' }, id: 'adv-1', employeeId: 'emp-hanako', employeeSnapshot: { name: 'テスト花子' }, purpose: '出張', amount: 30000,
    neededOn: '2026-09-05', plannedSettleBy: '2026-09-30', status: 'settling', approval: { by: 's', at: AT, proxy: false }, payment: { paidOn: '2026-09-04', method: 'cash', by: 'k', at: AT },
    settlement: { computedAt: AT, claimIds: ['c1'], claimsTotal: 32000, difference: 2000, additionalPayment: { amount: 2000, status: 'pending' } },
    submittedBy: 'h', createdAt: AT, updatedAt: AT,
  });

  it('正常: 支払待ち → exported（バッチ id）→ 確定で paid（バッチ id を保つ）と精算済み。同じバッチの印は冪等', () => {
    const exported = markAdditionalPaymentExported(settling(), 'batch-1', AT);
    expect(exported.settlement?.additionalPayment).toEqual({ amount: 2000, status: 'exported', payoutBatchId: 'batch-1' });
    expect(markAdditionalPaymentExported(exported, 'batch-1', AT)).toBe(exported);
    const paid = payAdvanceAdditional(exported, { paidOn: '2026-09-25', method: 'transfer' }, 'k', AT);
    expect(paid).toMatchObject({ status: 'settled', settlement: { additionalPayment: { status: 'paid', payoutBatchId: 'batch-1', paidOn: '2026-09-25' }, settledOn: '2026-09-25' } });
    expect(payAdvanceAdditional(settling(), { paidOn: '2026-09-25', method: 'transfer', payoutBatchId: 'batch-9' }, 'k', AT).settlement?.additionalPayment?.payoutBatchId).toBe('batch-9');
  });

  it('正常: 取消でそのバッチの印だけを外して支払待ちへ戻す（別のバッチ・印の無い仮払は変えない）', () => {
    const exported = markAdditionalPaymentExported(settling(), 'batch-1', AT);
    expect(clearAdditionalPaymentExport(exported, 'batch-1', AT).settlement?.additionalPayment).toEqual({ amount: 2000, status: 'pending' });
    expect(clearAdditionalPaymentExport(exported, 'batch-2', AT)).toBe(exported);
    const plain = settling();
    expect(clearAdditionalPaymentExport(plain, 'batch-1', AT)).toBe(plain);
  });

  it('異常: 別のバッチに入っている・支払待ちの追加支給が無い仮払には印を付けない', () => {
    const exported = markAdditionalPaymentExported(settling(), 'batch-1', AT);
    expect(() => markAdditionalPaymentExported(exported, 'batch-2', AT)).toThrow(ExpenseTransitionError);
    const refund = createExpenseAdvance({ ...settling(), settlement: { computedAt: AT, claimIds: [], claimsTotal: 20000, difference: -10000, refund: { amount: 10000 } } });
    expect(() => markAdditionalPaymentExported(refund, 'batch-1', AT)).toThrow(ExpenseTransitionError);
  });
});

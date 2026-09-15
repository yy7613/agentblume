// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/tool-api';
import {
  advanceStatusLabel, blockingReasonTargets, blockingReasonText, cardTransactionStatusLabel, paymentMethodText, readMoneyError, signedYen, todayIso,
} from './money-shared';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

describe('money-shared', () => {
  it('signedYen / todayIso: 符号つきの差額と端末の今日', () => {
    expect(signedYen(1200)).toBe('+¥1,200');
    expect(signedYen(-1200)).toBe('−¥1,200');
    expect(signedYen(0)).toBe('¥0');
    expect(todayIso(new Date(2026, 8, 5))).toBe('2026-09-05');
  });

  it('状態・方法の文言は日英を持ち、未知の値はそのまま出す', () => {
    for (const status of ['requested', 'approved', 'paid', 'settling', 'settled', 'cancelled']) expect(advanceStatusLabel(status, ja)).not.toBe(status);
    expect(advanceStatusLabel('unknown', en)).toBe('unknown');
    for (const status of ['unmatched', 'matched', 'excluded']) expect(cardTransactionStatusLabel(status, ja)).not.toBe(status);
    expect(cardTransactionStatusLabel('other', en)).toBe('other');
    expect(paymentMethodText('cash', ja)).toBe('現金');
    expect(paymentMethodText('transfer', ja)).toBe('振込');
    expect(paymentMethodText('cheque', en)).toBe('cheque');
  });

  it('blockingReasonText: 既知の code は平易な文、未知の code はそのまま', () => {
    const codes = ['advance-status', 'approval-claimant-self', 'advance-has-claims', 'advance-journal-drafted', 'advance-in-payout', 'advance-not-paid', 'advance-too-many-claims',
      'advance-claim-not-approved', 'advance-employee-mismatch', 'advance-already-settled', 'card-transaction-matched', 'card-item-matched'];
    for (const code of codes) {
      expect(blockingReasonText({ code, params: { advanceStatus: 'paid', count: 21, max: 20, batchId: 'b1', claimId: 'c1' } }, en)).not.toBe(code);
      expect(blockingReasonText({ code }, ja)).not.toBe(code);
    }
    expect(blockingReasonText({ code: 'something-new' }, en)).toBe('something-new');
    expect(blockingReasonText({ code: 'advance-has-claims', params: { count: 2 } }, en)).toBe('Claims are linked to this advance (2).');
  });

  it('blockingReasonTargets: params の id から直す場所を作り、いま見ている対象は除く', () => {
    expect(blockingReasonTargets({ code: 'x', itemId: 'i1', params: { claimId: 'c1' } }, en).map((entry) => entry.target)).toEqual([{ internalId: 'c1', section: 'item:i1' }]);
    expect(blockingReasonTargets({ code: 'x', params: { advanceId: 'a1', cardTransactionId: 't1', employeeId: 'e1', claimId: null } }, en, { advanceId: 'a1' }).map((entry) => entry.target))
      .toEqual([{ internalId: 't1', section: 'card' }, { internalId: 'e1', section: 'employee' }]);
    expect(blockingReasonTargets({ code: 'x', params: { cardTransactionId: 't1' } }, en, { cardTransactionId: 't1' })).toEqual([]);
  });

  it('readMoneyError: ApiError の本文から次の一手・理由・問題・取込 id・行を読み、それ以外は文言だけ', () => {
    const info = readMoneyError(new ApiError(409, 'EXPENSE_TRANSITION', 'raw', undefined, { row: 4, details: {
      nextStep: '先に承認してください', blockingReasons: [{ code: 'advance-not-paid' }, 'bad'], problems: [{ message: 'm', fixTarget: 'item', code: 'c' }, { message: 1 }],
      createdEntryIds: ['e1', 2], importId: 'imp1', importedAt: '2026-09-01', missingColumns: ['merchant'], field: 'period',
    } }));
    expect(info).toMatchObject({ status: 409, code: 'EXPENSE_TRANSITION', detail: 'raw', nextStep: '先に承認してください', importId: 'imp1', importedAt: '2026-09-01', row: 4, field: 'period' });
    expect(info.reasons).toHaveLength(1);
    expect(info.problems).toHaveLength(1);
    expect(info.createdEntryIds).toEqual(['e1']);
    expect(info.missingColumns).toEqual(['merchant']);
    expect(readMoneyError(new Error('boom'))).toEqual({ message: 'boom', reasons: [], problems: [], createdEntryIds: [], missingColumns: [] });
    expect(readMoneyError('text').message).toBe('text');
    expect(readMoneyError(new ApiError(404, 'EXPENSE_ADVANCE_NOT_FOUND', ''))).not.toHaveProperty('detail');
  });
});

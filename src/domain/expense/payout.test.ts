import { describe, expect, it } from 'vitest';
import { EXPENSE_PAYOUT_BLOCKING_CODES, EXPENSE_PAYOUT_WARNING_CODES } from './errors';
import {
  createExpensePayoutBatch, createExpensePayoutSettings, DEFAULT_ZENGIN_FORMAT, defaultExpensePayoutSettings, isBlockingPayoutProblem, PAYOUT_PROBLEM_TEXT, payoutProblem,
  validateZenginFormat, type ExpensePayoutBatch,
} from './payout';

const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const sealed = (plain: string) => ({ v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plain).toString('base64'), hint: plain.slice(-4) });
const bank = { bankCode: '9999', branchCode: '999', accountType: 'ordinary' as const, accountNumber: sealed('0000001'), holderKana: 'テスト タロウ', changedAt: AT, changedBy: 'keiri' };

describe('振込元の設定', () => {
  it('正常: 未保存の既定は振込元なし・書式は最も広く通る組み合わせ・支払仕訳は off（§20.17-6）', () => {
    const settings = defaultExpensePayoutSettings();
    expect(settings).toEqual({ format: DEFAULT_ZENGIN_FORMAT, journal: { createPaymentEntry: false, sourceAccountId: 'asset.ordinary_deposit' }, updatedAt: '2026-09-15T00:00:00.000Z' });
  });

  it('正常: 振込元の口座（口座番号は封緘値）・依頼人コード・依頼人名・書式の部分指定', () => {
    const settings = createExpensePayoutSettings({
      source: { bankCode: '9999', bankNameKana: 'サンプル', branchCode: '999', accountType: 'current', accountNumber: sealed('1234567') },
      requesterCode: '0123456789', requesterNameKana: 'カ)サンプルシヨウジ', format: { lineEnding: 'none', charset: 'extended', maxRecords: 1 }, journal: { createPaymentEntry: true }, updatedAt: AT,
    });
    expect(settings.source).toMatchObject({ accountType: 'current', accountNumber: { hint: '4567' } });
    expect(settings.format).toEqual({ ...DEFAULT_ZENGIN_FORMAT, lineEnding: 'none', charset: 'extended', maxRecords: 1 });
    expect(settings.journal).toEqual({ createPaymentEntry: true, sourceAccountId: 'asset.ordinary_deposit' });
  });

  it('異常: 依頼人コードは 10 桁・依頼人名は 40 バイト・書式の値域', () => {
    expect(() => createExpensePayoutSettings({ requesterCode: '123', updatedAt: AT })).toThrow(/requesterCode/u);
    expect(() => createExpensePayoutSettings({ requesterNameKana: 'ア'.repeat(41), updatedAt: AT })).toThrow(/40 bytes/u);
    expect(() => createExpensePayoutSettings({ source: { bankCode: '9999', branchCode: '999', accountType: 'savings', accountNumber: sealed('0000001') } as never, updatedAt: AT })).toThrow(/accountType/u);
    expect(() => validateZenginFormat({ maxRecords: 0 })).toThrow(/maxRecords/u);
    expect(() => validateZenginFormat({ transferKind: '9' })).toThrow(/transferKind/u);
    expect(() => validateZenginFormat({ eofMark: 'yes' })).toThrow(/eofMark/u);
    expect(() => validateZenginFormat([])).toThrow(/must be an object/u);
    expect(() => createExpensePayoutSettings({ journal: { createPaymentEntry: 'no' } as never, updatedAt: AT })).toThrow(/createPaymentEntry/u);
    expect(() => createExpensePayoutSettings({ journal: { sourceAccountId: '' }, updatedAt: AT })).toThrow(/sourceAccountId/u);
    expect(() => createExpensePayoutSettings({ requesterNameKana: 12 as never, updatedAt: AT })).toThrow(/must be a string/u);
    expect(() => createExpensePayoutSettings(null as never)).toThrow(/props are required/u);
  });
});

describe('振込バッチ', () => {
  const batch = (overrides: Partial<ExpensePayoutBatch> = {}): ExpensePayoutBatch => createExpensePayoutBatch({
    tenant, id: 'batch-1', status: 'exported', transferDate: '2026-09-25',
    lines: [{ employeeId: 'emp-1', name: 'テスト太郎', holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank, amount: 1500, sources: [{ kind: 'claim', id: 'c1', amount: 1000 }, { kind: 'advance-additional', id: 'adv-1', amount: 500 }] }],
    recordCount: 1, totalAmount: 1500, fileName: 'zengin-sofuri-20260925-batch-1.txt', fileSha256: 'b'.repeat(64), settingsSnapshot: defaultExpensePayoutSettings(),
    acknowledgedWarnings: ['payout-transfer-date-weekend'], by: 'boss', createdAt: AT, journalEntryId: '', ...overrides,
  });

  it('正常: 口座の写し（封緘値のまま）と出所の合計を持ち、確定・取消の記録を状態と対応させる', () => {
    expect(batch()).not.toHaveProperty('journalEntryId');
    expect(batch().lines[0]?.bank.accountNumber.hint).toBe('0001');
    expect(batch({ status: 'confirmed', confirmedAt: AT, confirmedBy: 'keiri', journalEntryId: 'je-1' })).toMatchObject({ confirmedBy: 'keiri', journalEntryId: 'je-1' });
    expect(batch({ status: 'cancelled', cancel: { by: 'keiri', at: AT, note: '作り直す' } }).cancel?.note).toBe('作り直す');
    expect(batch({ confirmedAt: AT, confirmedBy: 'x' })).not.toHaveProperty('confirmedAt');
  });

  it('異常: 行の金額 = 出所の合計（返金は相殺しない）・件数と合計の整合・金額の上限・名義 30 バイト', () => {
    const line = batch().lines[0]!;
    expect(() => batch({ lines: [{ ...line, amount: 1400 }], totalAmount: 1400 })).toThrow(/sum of its sources/u);
    expect(() => batch({ recordCount: 2 })).toThrow(/recordCount/u);
    expect(() => batch({ totalAmount: 1 })).toThrow(/totalAmount/u);
    expect(() => batch({ lines: [{ ...line, amount: 10_000_000_000, sources: [{ kind: 'claim', id: 'c1', amount: 10_000_000_000 }] }], totalAmount: 10_000_000_000 })).toThrow(/amount must be an integer/u);
    expect(() => batch({ lines: [{ ...line, holderKanaConverted: 'ｱ'.repeat(31) }] })).toThrow(/30 bytes/u);
    expect(() => batch({ lines: [] })).toThrow(/at least one line/u);
    expect(() => batch({ lines: [{ ...line, sources: [] }] })).toThrow(/at least one source/u);
    expect(() => batch({ lines: [{ ...line, sources: [{ kind: 'refund', id: 'x', amount: 1500 }] }] as never })).toThrow(/kind must be one of/u);
    expect(() => batch({ lines: [{ ...line, sources: [{ kind: 'claim', id: 'x', amount: 0 }] }] })).toThrow(/positive integer/u);
    expect(() => batch({ status: 'confirmed' })).toThrow(/confirmedAt/u);
    expect(() => batch({ status: 'cancelled' })).toThrow(/cancel note/u);
    expect(() => batch({ status: 'unknown' as never })).toThrow(/status must be one of/u);
    expect(() => batch({ fileSha256: 'xyz' })).toThrow(/fileSha256/u);
    expect(() => batch({ transferDate: '2026/09/25' })).toThrow(/transferDate/u);
    expect(() => batch({ acknowledgedWarnings: [1] as never })).toThrow(/acknowledgedWarnings/u);
    expect(() => createExpensePayoutBatch(null as never)).toThrow(/props are required/u);
  });
});

describe('点検の文言（§20.5.2）', () => {
  it('正常: 全コードに原因・次の一手・導線があり、止める / 警告の区別が表と一致する', () => {
    const codes = [...EXPENSE_PAYOUT_BLOCKING_CODES, ...EXPENSE_PAYOUT_WARNING_CODES];
    expect(Object.keys(PAYOUT_PROBLEM_TEXT).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const problem = payoutProblem(code, { employee: 'テスト太郎', amount: 12000000000, count: 10001, max: 9999, bytes: 31 }, { employeeId: 'emp-1' });
      expect(problem.message).toMatch(/。.+/u);
      expect(problem.message).not.toContain('undefined');
      expect(problem.employeeId).toBe('emp-1');
    }
    expect(EXPENSE_PAYOUT_BLOCKING_CODES.every(isBlockingPayoutProblem)).toBe(true);
    expect(EXPENSE_PAYOUT_WARNING_CODES.some(isBlockingPayoutProblem)).toBe(false);
  });

  it('正常: 名義の 30 バイト超は止め、従業員の口座欄を導線にする（§20.17-7 の決定）', () => {
    const problem = payoutProblem('payout-holder-kana-too-long', { employee: 'テスト太郎', bytes: 31 });
    expect(problem).toMatchObject({ code: 'payout-holder-kana-too-long', fixTarget: 'employee-bank-account' });
    expect(problem.message).toBe('テスト太郎 さんの名義カナが変換後 31 バイトで、上限 30 バイトを超えています（濁点・半濁点は 1 文字として数えます）。銀行に登録された名義の略し方（法人略語など）で 30 バイト以内にしてください');
    expect(isBlockingPayoutProblem('payout-holder-kana-too-long')).toBe(true);
    expect(payoutProblem('payout-amount-too-large', { employee: 'x', amount: 10_000_000_000 }).message).toContain('10,000,000,000 円');
    expect(payoutProblem('payout-source-missing', {}).params).toEqual({});
  });
});

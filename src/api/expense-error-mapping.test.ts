import { describe, expect, it } from 'vitest';
import { JournalDraftRejectedError } from '../application/expense/errors';
import {
  ExpenseAdvanceNotFoundError, ExpenseCardDuplicateImportError, ExpenseCardImportError, ExpenseCardImportNotFoundError, ExpenseCardTransactionNotFoundError,
  ExpenseClaimNotFoundError, ExpenseCsvImportError, ExpenseDetailExtractionUnavailableError, ExpenseDomainError, ExpenseEmployeeCsvImportError,
  ExpenseEmployeeNotFoundError, ExpenseHearingNotFoundError, ExpenseHearingSchemaError, ExpenseHearingUnavailableError, ExpenseItemNotFoundError,
  ExpenseJournalLinkError, ExpensePayoutBlockedError, ExpensePayoutNotFoundError, ExpensePolicyConflictError, ExpenseReceiptNotFoundError,
  ExpenseTransitionError,
} from '../domain/expense/errors';
import { JournalDomainError } from '../domain/journal/errors';
import { expenseHttpError } from './expense-error-mapping';

describe('expenseHttpError', () => {
  it('正常: 参照切れは 404、code は EXPENSE_ で始まる', () => {
    expect(expenseHttpError(new ExpenseClaimNotFoundError('x'))).toEqual({ status: 404, body: { error: { code: 'EXPENSE_CLAIM_NOT_FOUND', message: 'x' } } });
    expect(expenseHttpError(new ExpenseItemNotFoundError('x'))?.body.error.code).toBe('EXPENSE_ITEM_NOT_FOUND');
    expect(expenseHttpError(new ExpenseReceiptNotFoundError('x'))?.body.error.code).toBe('EXPENSE_RECEIPT_NOT_FOUND');
  });

  it('正常: 入力不正は 400。行番号があれば本文に載せ、無ければキーを作らない', () => {
    expect(expenseHttpError(new ExpenseDomainError('bad', 3))).toEqual({ status: 400, body: { error: { code: 'EXPENSE_DOMAIN', message: 'bad', row: 3 } } });
    expect(expenseHttpError(new ExpenseDomainError('bad'))?.body.error).not.toHaveProperty('row');
    expect(expenseHttpError(new ExpenseCsvImportError('no date column'))).toEqual({ status: 400, body: { error: { code: 'EXPENSE_CSV_IMPORT', message: 'no date column' } } });
  });

  it('正常: 遷移の拒否は 409 に blockingReasons / nextStep / claims を載せる（空の claims と未指定の nextStep はキーを作らない）', () => {
    const full = expenseHttpError(new ExpenseTransitionError('no', { blockingReasons: [{ code: 'payee-missing', itemId: 'i1' }], nextStep: '確認済みにしてください', claims: [{ id: 'c1', status: 'draft' }] }));
    expect(full).toEqual({ status: 409, body: { error: { code: 'EXPENSE_TRANSITION', message: 'no', blockingReasons: [{ code: 'payee-missing', itemId: 'i1' }], nextStep: '確認済みにしてください', claims: [{ id: 'c1', status: 'draft' }] } } });
    const bare = expenseHttpError(new ExpenseTransitionError('no'));
    expect(bare?.body.error).toEqual({ code: 'EXPENSE_TRANSITION', message: 'no', blockingReasons: [] });
  });

  it('正常: 仕訳連携の失敗は 409 に problems と createdEntryIds を載せる。ユースケースから漏れた拒否も 409', () => {
    const problem = { itemId: 'i1', code: 'account-missing', message: '科目がありません', fixTarget: 'policy-category' as const, categoryId: 'misc' };
    expect(expenseHttpError(new ExpenseJournalLinkError('link', [problem], ['e1']))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_JOURNAL_LINK', message: 'link', problems: [problem], createdEntryIds: ['e1'] } } });
    expect(expenseHttpError(new JournalDraftRejectedError('disabled'))).toMatchObject({ status: 409, body: { error: { code: 'EXPENSE_JOURNAL_LINK' } } });
  });

  it('境界: 経費のエラーでなければ undefined（仕訳のエラーは仕訳の写像に任せる）', () => {
    expect(expenseHttpError(new JournalDomainError('x'))).toBeUndefined();
    expect(expenseHttpError(new Error('x'))).toBeUndefined();
    expect(expenseHttpError('string')).toBeUndefined();
  });
});

describe('expenseHttpError: 実用化の例外（§20.9.5）', () => {
  it.each([
    ['従業員', new ExpenseEmployeeNotFoundError('x'), 'EXPENSE_EMPLOYEE_NOT_FOUND'],
    ['仮払', new ExpenseAdvanceNotFoundError('x'), 'EXPENSE_ADVANCE_NOT_FOUND'],
    ['振込', new ExpensePayoutNotFoundError('x'), 'EXPENSE_PAYOUT_NOT_FOUND'],
    ['カード利用', new ExpenseCardTransactionNotFoundError('x'), 'EXPENSE_CARD_TRANSACTION_NOT_FOUND'],
    ['カード取込', new ExpenseCardImportNotFoundError('x'), 'EXPENSE_CARD_IMPORT_NOT_FOUND'],
    ['ヒアリング', new ExpenseHearingNotFoundError('x'), 'EXPENSE_HEARING_NOT_FOUND'],
  ])('正常: %s の参照切れは 404', (_label, error, code) => {
    expect(expenseHttpError(error)).toEqual({ status: 404, body: { error: { code, message: 'x' } } });
  });

  it('正常: 入力不正の「直す場所」（field・conflictEmployeeId・converted）を本文の追加キーに載せる', () => {
    const converted = { text: 'ﾃｽﾄ', bytes: 4, invalid: [{ char: '漢', index: 0 }] };
    expect(expenseHttpError(new ExpenseDomainError('code taken', undefined, { field: 'code', conflictEmployeeId: 'emp-hanako' }))).toEqual({ status: 400, body: { error: { code: 'EXPENSE_DOMAIN', message: 'code taken', field: 'code', conflictEmployeeId: 'emp-hanako' } } });
    expect(expenseHttpError(new ExpenseDomainError('kana', 4, { field: 'bankAccount.holderKana', converted }))?.body.error).toEqual({ code: 'EXPENSE_DOMAIN', message: 'kana', row: 4, field: 'bankAccount.holderKana', converted });
  });

  it('正常: 従業員 CSV・カード明細 CSV の前提違反は 400 に行・足りない列・推定した列の対応を載せ、無いものはキーを作らない', () => {
    expect(expenseHttpError(new ExpenseEmployeeCsvImportError('no name column', { row: 1, missingColumns: ['氏名'] }))).toEqual({ status: 400, body: { error: { code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', message: 'no name column', row: 1, missingColumns: ['氏名'] } } });
    expect(expenseHttpError(new ExpenseEmployeeCsvImportError('empty'))?.body.error).toEqual({ code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', message: 'empty' });
    expect(expenseHttpError(new ExpenseCardImportError('mapping', { missingColumns: ['amount'], suggestedMapping: { usedOn: '利用日' } }))).toEqual({ status: 400, body: { error: { code: 'EXPENSE_CARD_IMPORT', message: 'mapping', missingColumns: ['amount'], suggestedMapping: { usedOn: '利用日' } } } });
    expect(expenseHttpError(new ExpenseCardImportError('bad row', { row: 7 }))?.body.error).toEqual({ code: 'EXPENSE_CARD_IMPORT', message: 'bad row', row: 7 });
  });

  it('正常: 二重取込・振込の点検・規程の衝突は 409 に直す手がかりを載せる', () => {
    expect(expenseHttpError(new ExpenseCardDuplicateImportError('dup', 'import-1', '2026-09-15T00:00:00.000Z'))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_CARD_DUPLICATE_IMPORT', message: 'dup', importId: 'import-1', importedAt: '2026-09-15T00:00:00.000Z' } } });
    const problem = { code: 'payout-bank-account-missing' as const, employeeId: 'emp-taro', message: '口座がありません', fixTarget: 'employee-bank-account' as const };
    const warning = { code: 'payout-transfer-date-weekend' as const, message: '振込日が土日です', fixTarget: 'transfer-date' as const };
    expect(expenseHttpError(new ExpensePayoutBlockedError('blocked', [problem], [warning]))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_PAYOUT_BLOCKED', message: 'blocked', problems: [problem], warnings: [warning] } } });
    expect(expenseHttpError(new ExpensePayoutBlockedError('blocked', [problem]))?.body.error).toMatchObject({ problems: [problem], warnings: [] });
    expect(expenseHttpError(new ExpensePolicyConflictError('stale', '2026-09-15T02:00:00.000Z'))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_POLICY_CONFLICT', message: 'stale', currentUpdatedAt: '2026-09-15T02:00:00.000Z' } } });
  });

  it('正常: モデルを使う機能が使えなければ 409 に missing（何が足りないか）、ヒアリングのスキーマ違反は 502 に issues', () => {
    expect(expenseHttpError(new ExpenseDetailExtractionUnavailableError('no model', 'model'))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', message: 'no model', missing: 'model' } } });
    expect(expenseHttpError(new ExpenseHearingUnavailableError('no structured output', 'structured-output'))).toEqual({ status: 409, body: { error: { code: 'EXPENSE_HEARING_UNAVAILABLE', message: 'no structured output', missing: 'structured-output' } } });
    expect(expenseHttpError(new ExpenseHearingSchemaError('bad', ['questions: required']))).toEqual({ status: 502, body: { error: { code: 'EXPENSE_HEARING_SCHEMA', message: 'bad', issues: ['questions: required'] } } });
  });
});

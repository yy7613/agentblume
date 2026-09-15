import { describe, expect, it } from 'vitest';
import { ReceivablesExtractionUnavailableError } from '../application/receivables/errors';
import {
  BankCsvProfileNotFoundError, BankTransactionNotFoundError, CustomerNotFoundError, InvoiceComplianceError, InvoiceNotFoundError,
  JournalLinkError, MatchingNotFoundError, ReceivablesCsvImportError, ReceivablesDomainError, ReceivablesStateError,
} from '../domain/receivables/errors';
import { receivablesHttpError } from './receivables-error-mapping';

describe('receivablesHttpError', () => {
  it('正常: 違反の一覧・行番号・状態の理由・足りない科目を本文に載せる', () => {
    expect(receivablesHttpError(new InvoiceComplianceError('no', [{ code: 'lines-empty', path: 'lines', params: {} }]))).toEqual({ status: 400, body: { error: { code: 'RECEIVABLES_INVOICE_COMPLIANCE', message: 'no', violations: [{ code: 'lines-empty', path: 'lines', params: {} }] } } });
    expect(receivablesHttpError(new ReceivablesCsvImportError('bad', 7))).toEqual({ status: 400, body: { error: { code: 'RECEIVABLES_CSV_IMPORT', message: 'bad', row: 7 } } });
    expect(receivablesHttpError(new ReceivablesCsvImportError('bad'))?.body.error).not.toHaveProperty('row');
    expect(receivablesHttpError(new ReceivablesStateError('invoice-outstanding-changed', 'changed', { invoiceId: 'i' }))).toEqual({ status: 409, body: { error: { code: 'RECEIVABLES_STATE', message: 'changed', reason: 'invoice-outstanding-changed', params: { invoiceId: 'i' } } } });
    expect(receivablesHttpError(new JournalLinkError('missing', [{ kind: 'account', id: 'x', settingPath: 'journal.accounts.sales' }]))).toEqual({ status: 409, body: { error: { code: 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING', message: 'missing', missing: [{ kind: 'account', id: 'x', settingPath: 'journal.accounts.sales' }] } } });
  });

  it.each(['allocation-exceeds-outstanding', 'allocation-sum-mismatch', 'fee-out-of-tolerance', 'profile-builtin'] as const)('境界: 入力の誤り %s は 400', (reason) => {
    expect(receivablesHttpError(new ReceivablesStateError(reason, 'x'))?.status).toBe(400);
  });

  it('正常: 参照切れは 404、不変条件違反は 400、読み取り不可は 409', () => {
    for (const error of [new CustomerNotFoundError('x'), new InvoiceNotFoundError('x'), new BankTransactionNotFoundError('x'), new MatchingNotFoundError('x'), new BankCsvProfileNotFoundError('x')]) {
      expect(receivablesHttpError(error)).toMatchObject({ status: 404, body: { error: { code: error.code } } });
      expect(error.code).toMatch(/^RECEIVABLES_.*_NOT_FOUND$/);
    }
    expect(receivablesHttpError(new ReceivablesDomainError('x'))).toMatchObject({ status: 400, body: { error: { code: 'RECEIVABLES_DOMAIN' } } });
    expect(receivablesHttpError(new ReceivablesExtractionUnavailableError('x'))).toMatchObject({ status: 409, body: { error: { code: 'RECEIVABLES_EXTRACTION_UNAVAILABLE' } } });
  });

  it('例外: 自分の業務のエラーでなければ undefined', () => {
    expect(receivablesHttpError(new Error('x'))).toBeUndefined();
    expect(receivablesHttpError('x')).toBeUndefined();
  });
});

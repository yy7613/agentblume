import { describe, expect, it } from 'vitest';
import { localizeApiErrorMessage } from './error-messages';
import { RECEIVABLES_ERROR_MESSAGES, RECEIVABLES_STATE_HEADINGS } from './receivables-error-messages';

const heading = RECEIVABLES_ERROR_MESSAGES.heading!;

describe('入金消込のエラー見出し', () => {
  it('正常: code はすべて RECEIVABLES_ で始まり、共通の変換から使われる', () => {
    expect(Object.keys(RECEIVABLES_ERROR_MESSAGES.headings).every((code) => code.startsWith('RECEIVABLES_'))).toBe(true);
    expect(localizeApiErrorMessage({ status: 404, code: 'RECEIVABLES_INVOICE_NOT_FOUND', serverMessage: 'invoice not found: x' }, 'ja')).toContain('請求書が見つかりませんでした');
  });

  it('正常: 状態の理由ごとに次の一手まで言う（全理由に日英がある）', () => {
    for (const [reason, [english, japanese]] of Object.entries(RECEIVABLES_STATE_HEADINGS)) {
      expect(heading({ status: 409, code: 'RECEIVABLES_STATE', serverMessage: '', details: { reason } }, 'en')).toBe(english);
      expect(heading({ status: 409, code: 'RECEIVABLES_STATE', serverMessage: '', details: { reason } }, 'ja')).toBe(japanese);
    }
    expect(localizeApiErrorMessage({ status: 409, code: 'RECEIVABLES_STATE', serverMessage: 'x', details: { reason: 'invoice-outstanding-changed' } }, 'ja')).toMatch(/^判定の後に請求の残高が変わりました/);
    expect(heading({ status: 409, code: 'RECEIVABLES_STATE', serverMessage: '', details: { reason: 'unknown' } }, 'ja')).toBeUndefined();
    expect(heading({ status: 409, code: 'RECEIVABLES_STATE', serverMessage: '' }, 'ja')).toBeUndefined();
  });

  it('正常: CSV の行番号・足りない科目・違反の件数を見出しに埋める', () => {
    expect(heading({ status: 400, code: 'RECEIVABLES_CSV_IMPORT', serverMessage: '', row: 7 }, 'ja')).toMatch(/^CSV の 7 行目/);
    expect(heading({ status: 400, code: 'RECEIVABLES_CSV_IMPORT', serverMessage: '', row: 7 }, 'en')).toMatch(/^Row 7/);
    expect(heading({ status: 400, code: 'RECEIVABLES_CSV_IMPORT', serverMessage: '' }, 'ja')).toBeUndefined();
    const missing = { missing: [{ kind: 'account', id: 'ghost', settingPath: 'journal.accounts.sales' }] };
    expect(heading({ status: 409, code: 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING', serverMessage: '', details: missing }, 'ja')).toContain('journal.accounts.sales = ghost');
    expect(heading({ status: 409, code: 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING', serverMessage: '', details: missing }, 'en')).toContain('Settings › Journal link');
    expect(heading({ status: 409, code: 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING', serverMessage: '' }, 'ja')).toBeUndefined();
    expect(heading({ status: 400, code: 'RECEIVABLES_INVOICE_COMPLIANCE', serverMessage: '', details: { violations: [{}, {}] } }, 'ja')).toContain('直す項目が 2 件');
    expect(heading({ status: 400, code: 'RECEIVABLES_INVOICE_COMPLIANCE', serverMessage: '', details: { violations: [{}] } }, 'en')).toContain('1 items to fix');
    expect(heading({ status: 400, code: 'RECEIVABLES_INVOICE_COMPLIANCE', serverMessage: '' }, 'en')).toBeUndefined();
  });

  it('例外: 他の業務の code には反応しない', () => {
    expect(heading({ status: 400, code: 'JOURNAL_CSV_IMPORT', serverMessage: '', row: 1 }, 'ja')).toBeUndefined();
  });
});

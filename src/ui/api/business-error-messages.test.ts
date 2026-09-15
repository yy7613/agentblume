import { describe, expect, it } from 'vitest';
import type { BusinessErrorMessages } from './business-error-types';
import { CONTRACT_ERROR_MESSAGES } from './contract-error-messages';
import { localizeApiErrorMessage, localizeRunFailure } from './error-messages';
import { EXPENSE_ERROR_MESSAGES } from './expense-error-messages';
import { JOURNAL_ERROR_MESSAGES } from './journal-error-messages';
import { RECEIVABLES_ERROR_MESSAGES } from './receivables-error-messages';

/** 業務ごとのエラー見出し（ADR-0039）の規約。 */
const BUSINESSES: readonly (readonly [prefix: string, messages: BusinessErrorMessages])[] = [
  ['JOURNAL_', JOURNAL_ERROR_MESSAGES],
  ['EXPENSE_', EXPENSE_ERROR_MESSAGES],
  ['RECEIVABLES_', RECEIVABLES_ERROR_MESSAGES],
  ['CONTRACT_', CONTRACT_ERROR_MESSAGES],
];

describe('業務のエラー見出し', () => {
  it('正常: 業務の code は業務名で始まり、業務どうしで重ならない（共通の code を上書きしない）', () => {
    const seen = new Set<string>();
    for (const [prefix, messages] of BUSINESSES) {
      for (const code of Object.keys(messages.headings)) {
        expect(code.startsWith(prefix), code).toBe(true);
        expect(seen.has(code), code).toBe(false);
        seen.add(code);
      }
    }
  });

  it('正常: 業務の見出しが共通の変換で使われる（API の失敗と保存済み Run の失敗の両方）', () => {
    expect(localizeApiErrorMessage({ status: 404, code: 'JOURNAL_RULE_NOT_FOUND', serverMessage: 'journal rule not found: r1' }, 'ja')).toContain('仕訳ルールが見つかりませんでした');
    expect(localizeRunFailure({ code: 'JOURNAL_EXPORT', message: 'no entries' }, 'en')).toContain('The journal export failed');
  });

  it('正常: 本文の行番号を使う見出しは、共通の見出しより先に使われる', () => {
    expect(localizeApiErrorMessage({ status: 400, code: 'JOURNAL_CSV_IMPORT', serverMessage: 'bad row', row: 7 }, 'ja')).toMatch(/^CSV の 7 行目を取り込めませんでした/);
  });

  it('境界: 行番号が無ければ業務の見出し関数は何も返さず、code の見出しに落ちる', () => {
    expect(JOURNAL_ERROR_MESSAGES.heading?.({ status: 400, code: 'JOURNAL_CSV_IMPORT', serverMessage: '' }, 'en')).toBeUndefined();
    expect(localizeApiErrorMessage({ status: 400, code: 'JOURNAL_CSV_IMPORT', serverMessage: 'x' }, 'en')).toMatch(/^The CSV could not be imported/);
  });

  it('例外: 他の業務の code には業務の見出し関数が反応しない', () => {
    expect(JOURNAL_ERROR_MESSAGES.heading?.({ status: 400, code: 'EXPENSE_POLICY', serverMessage: '', row: 1 }, 'ja')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { BusinessErrorPayload } from './business-error-types';
import { EXPENSE_ERROR_MESSAGES } from './expense-error-messages';

const payload = (overrides: Partial<BusinessErrorPayload>): BusinessErrorPayload => ({ status: 400, code: 'EXPENSE_DOMAIN', serverMessage: 'server', ...overrides });
const heading = (value: BusinessErrorPayload, language: 'en' | 'ja') => EXPENSE_ERROR_MESSAGES.heading?.(value, language);

/** §20.9.5 で足した code（api の expense-error-mapping.ts と揃える）。 */
const PRACTICAL_CODES = [
  'EXPENSE_EMPLOYEE_NOT_FOUND', 'EXPENSE_ADVANCE_NOT_FOUND', 'EXPENSE_PAYOUT_NOT_FOUND', 'EXPENSE_CARD_TRANSACTION_NOT_FOUND', 'EXPENSE_CARD_IMPORT_NOT_FOUND', 'EXPENSE_HEARING_NOT_FOUND',
  'EXPENSE_EMPLOYEE_CSV_IMPORT', 'EXPENSE_CARD_IMPORT', 'EXPENSE_CARD_DUPLICATE_IMPORT', 'EXPENSE_PAYOUT_BLOCKED', 'EXPENSE_POLICY_CONFLICT',
  'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', 'EXPENSE_HEARING_UNAVAILABLE', 'EXPENSE_HEARING_SCHEMA',
];

describe('EXPENSE_ERROR_MESSAGES', () => {
  it('正常: 経費の code はすべて EXPENSE_ で始まり、日英とも空でない見出しを持つ', () => {
    expect(Object.keys(EXPENSE_ERROR_MESSAGES.headings).sort()).toEqual([
      'EXPENSE_CLAIM_NOT_FOUND', 'EXPENSE_CSV_IMPORT', 'EXPENSE_DOMAIN', 'EXPENSE_ITEM_NOT_FOUND', 'EXPENSE_JOURNAL_LINK', 'EXPENSE_RECEIPT_NOT_FOUND', 'EXPENSE_TRANSITION',
      ...PRACTICAL_CODES,
    ].sort());
    for (const [code, [en, ja]] of Object.entries(EXPENSE_ERROR_MESSAGES.headings)) {
      expect(code.startsWith('EXPENSE_')).toBe(true);
      expect(en).not.toBe('');
      expect(ja).not.toBe('');
      expect(en).not.toBe(ja);
    }
  });

  it('正常: 実用化の見出しは「原因。次の一手」の 2 文で、日本語の見出しは句点で区切る', () => {
    for (const code of PRACTICAL_CODES) {
      const [en, ja] = EXPENSE_ERROR_MESSAGES.headings[code] ?? ['', ''];
      expect(ja, code).toMatch(/^[^。]+。[^。]+$/u);
      expect(en, code).toMatch(/\. [A-Z]/u);
    }
  });

  it('正常: CSV 取込と入力不備に行番号があれば、その行を示す見出しにする（従業員 CSV・カード明細も同じ）', () => {
    expect(heading(payload({ code: 'EXPENSE_CSV_IMPORT', row: 3 }), 'ja')).toBe('CSV の 3 行目を取り込めませんでした。その行の値を確認してください');
    expect(heading(payload({ code: 'EXPENSE_DOMAIN', row: 7 }), 'en')).toBe('Row 7 of the CSV could not be imported. Check the values on that row');
    expect(heading(payload({ code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', row: 12 }), 'ja')).toBe('CSV の 12 行目を取り込めませんでした。その行の値を確認してください');
    expect(heading(payload({ code: 'EXPENSE_CARD_IMPORT', row: 2 }), 'en')).toBe('Row 2 of the CSV could not be imported. Check the values on that row');
  });

  it('正常: 従業員 CSV・カード明細で足りない列が分かれば、その列を見出しに出す', () => {
    const missing = payload({ code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', details: { missingColumns: ['name', 'bank_code'] } });
    expect(heading(missing, 'ja')).toBe('CSV に必要な列がありません: name、bank_code。列名を直すか列の対応を選んでください');
    expect(heading({ ...missing, code: 'EXPENSE_CARD_IMPORT' }, 'en')).toBe('The CSV is missing required columns: name, bank_code. Rename the headers or choose the column mapping');
  });

  it('境界: 足りない列が空・文字列でない値だけなら共通の見出しに任せる。経費明細 CSV の missingColumns は使わない', () => {
    expect(heading(payload({ code: 'EXPENSE_CARD_IMPORT', details: { missingColumns: [] } }), 'ja')).toBeUndefined();
    expect(heading(payload({ code: 'EXPENSE_CARD_IMPORT', details: { missingColumns: [3, ''] } }), 'ja')).toBeUndefined();
    expect(heading(payload({ code: 'EXPENSE_CARD_IMPORT', details: { missingColumns: 'date' } }), 'ja')).toBeUndefined();
    expect(heading(payload({ code: 'EXPENSE_CSV_IMPORT', details: { missingColumns: ['date'] } }), 'ja')).toBeUndefined();
  });

  it.each([
    ['model', '設定画面で main モデルを選んでください', 'choose a main model in Settings'],
    ['structured-output', '設定画面で構造化出力に対応したモデルを選んでください', 'choose a model with structured output in Settings'],
    ['vision', '設定画面で画像（vision）に対応したモデルを選んでください', 'choose a vision-capable model in Settings'],
  ])('正常: 追加読取・ヒアリングが使えない理由 %s は、足りないものに合わせた次の一手を見出しにする', (missing, ja, en) => {
    expect(heading(payload({ status: 409, code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', details: { missing } }), 'ja')).toBe(`経費の追加読取は使えません。${ja}`);
    expect(heading(payload({ status: 409, code: 'EXPENSE_HEARING_UNAVAILABLE', details: { missing } }), 'en')).toBe(`Drafting the policy from your rules is not available: ${en}`);
  });

  it('境界: 使えない理由が無い・未知なら共通の見出しに任せる', () => {
    expect(heading(payload({ status: 409, code: 'EXPENSE_HEARING_UNAVAILABLE' }), 'ja')).toBeUndefined();
    expect(heading(payload({ status: 409, code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', details: { missing: 'gpu' } }), 'ja')).toBeUndefined();
  });

  it('境界: 行番号が無い CSV の失敗は共通の見出しに任せる', () => {
    expect(heading(payload({ code: 'EXPENSE_CSV_IMPORT' }), 'ja')).toBeUndefined();
  });

  it('正常: 遷移の拒否は日本語ならサーバーの次の一手を見出しに入れ、英語は共通の見出しに任せる', () => {
    const transition = payload({ status: 409, code: 'EXPENSE_TRANSITION', details: { nextStep: 'もう一度チェックしてください' } });
    expect(heading(transition, 'ja')).toBe('操作できません。もう一度チェックしてください');
    expect(heading(transition, 'en')).toBeUndefined();
  });

  it('境界: 次の一手が無い・空・文字列でない遷移の拒否と、他の code は undefined', () => {
    expect(heading(payload({ status: 409, code: 'EXPENSE_TRANSITION' }), 'ja')).toBeUndefined();
    expect(heading(payload({ status: 409, code: 'EXPENSE_TRANSITION', details: { nextStep: '' } }), 'ja')).toBeUndefined();
    expect(heading(payload({ status: 409, code: 'EXPENSE_TRANSITION', details: { nextStep: 3 } }), 'ja')).toBeUndefined();
    expect(heading(payload({ status: 409, code: 'EXPENSE_JOURNAL_LINK', row: 2 }), 'ja')).toBeUndefined();
    expect(heading(payload({ status: 409, code: 'EXPENSE_PAYOUT_BLOCKED', row: 2 }), 'ja')).toBeUndefined();
  });
});

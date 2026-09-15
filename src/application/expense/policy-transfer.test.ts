import { describe, expect, it } from 'vitest';
import { InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { defaultExpensePolicy } from '../../domain/expense/default-policy';
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseCategory } from '../../domain/expense/policy';
import { SaveExpensePolicyUseCase } from './manage-policy';
import {
  categoriesToCsv, categoryFromCsvRecord, EXPENSE_CATEGORY_CSV_COLUMNS, EXPENSE_CATEGORY_CSV_FILE_NAME, ExportExpensePolicyCsvUseCase, ImportExpensePolicyCsvUseCase,
} from './policy-transfer';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const NOW = new Date('2026-09-20T01:00:00.000Z');
const clock = (): Date => NOW;
const BOM = '﻿';

/** 例外を値として受け取る（行番号などのプロパティを検査するため）。 */
async function caught(promise: Promise<unknown>): Promise<ExpenseDomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExpenseDomainError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

/** 列名 → 値のレコードから CSV を組む（ヘッダは列の定義順で、使った列だけ）。 */
function csvOf(records: readonly Readonly<Record<string, string>>[]): string {
  const used = EXPENSE_CATEGORY_CSV_COLUMNS.filter((column) => records.some((record) => record[column] !== undefined));
  const quote = (value: string): string => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [used.join(','), ...records.map((record) => used.map((column) => quote(record[column] ?? '')).join(','))].join('\r\n') + '\r\n';
}

describe('categoriesToCsv / ExportExpensePolicyCsvUseCase', () => {
  it('正常: BOM 付き・CRLF・固定の 24 列。真偽は true/false、空の上限は空セル、別名は ; 区切り', async () => {
    const { content, fileName } = await new ExportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository()).execute(scope);
    expect(fileName).toBe(EXPENSE_CATEGORY_CSV_FILE_NAME);
    expect(content.startsWith(BOM)).toBe(true);
    const lines = content.slice(1).split('\r\n');
    expect(lines[0]).toBe('id,code,name,enabled,accountId,defaultTaxRate,taxCode10,taxCode8,taxCode0,receiptRequired,receiptExemptBelow,invoiceRequired,invoiceExemptBelow,requiresPurpose,requiresAttendees,requiresAttendeeDetails,perItemLimit,perClaimLimit,perPersonLimit,perPersonBasis,perUnitLabel,perUnitLimit,aliases,note');
    expect(lines[0]).toBe(EXPENSE_CATEGORY_CSV_COLUMNS.join(','));
    expect(lines[1]).toBe('transport.public,,電車・バス,true,expense.travel,10,JP-IN-10-S,JP-IN-8R-S,JP-IN-NA,false,,true,30000,true,false,false,,,,tax-included,,,電車;バス;電車代;バス代;地下鉄;交通費,3 万円未満の公共交通機関は帳簿のみ保存で仕入税額控除ができます');
    expect(lines[2]).toBe('transport.taxi,,タクシー,true,expense.travel,10,JP-IN-10-S,JP-IN-8R-S,JP-IN-NA,true,,true,,true,false,false,10000,,,tax-included,,,タクシー代;ハイヤー,');
    expect(lines[4]).toBe('travel.lodging,,宿泊費,true,expense.travel,10,JP-IN-10-S,JP-IN-8R-S,JP-IN-NA,true,,true,,true,false,false,,,,tax-included,泊,12000,宿泊;ホテル,');
    // カンマを含む注記は引用される。
    expect(content).toContain('"1 人 10,000 円以下の飲食費は交際費から除外できます');
    expect(lines.at(-1)).toBe('');
  });

  it('正常: 保存済みの規程は保存したものを出す（code・無効の費目・上限を含む）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const base = defaultExpensePolicy();
    const books = base.categories.find((category) => category.id === 'books')!;
    const category: ExpenseCategory = { ...books, code: 'B01', enabled: false, limits: { perItem: 5000, perClaim: 20000, perPersonBasis: 'tax-excluded' } };
    await new SaveExpensePolicyUseCase(policies, clock).execute({ scope, ...base, categories: [category], preApprovalRules: [] });
    const { content } = await new ExportExpensePolicyCsvUseCase(policies).execute(scope);
    expect(content.slice(1).split('\r\n')[1]).toBe('books,B01,書籍・資料,false,expense.books,10,JP-IN-10-S,JP-IN-8R-S,JP-IN-NA,true,,true,,false,false,false,5000,20000,,tax-excluded,,,書籍;図書;新聞図書費,');
  });

  it('境界: 出力した CSV をそのまま取り込むと費目が完全に戻る（往復で値が変わらない）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const content = categoriesToCsv(defaultExpensePolicy());
    const imported = await new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content });
    expect(imported.categories).toEqual(defaultExpensePolicy().categories);
  });
});

describe('categoryFromCsvRecord', () => {
  it('境界: 空欄は既定値（enabled / 領収書 / インボイスは true、必須項目は false、税率 10、基準は税込、上限なし）', () => {
    expect(categoryFromCsvRecord({ id: 'x', name: '名前' }, 2, 0)).toEqual({
      id: 'x', name: '名前', enabled: true, sortOrder: 10, aliases: [], defaultTaxRate: 10, taxCodeByRate: {},
      receipt: { required: true }, invoice: { required: true },
      requires: { purpose: false, attendees: false, attendeeDetails: false },
      limits: { perPersonBasis: 'tax-included' },
    });
  });

  it('正常: 大文字の真偽・桁区切りの上限・前後空白と空要素のある別名・単位あたりの上限を読む。並びは行順', () => {
    const category = categoryFromCsvRecord({
      id: ' lodging ', code: 'L1', name: '宿泊', enabled: 'FALSE', accountId: 'expense.travel', defaultTaxRate: '8', taxCode8: 'JP-IN-8R-S',
      receiptRequired: 'false', receiptExemptBelow: '3,000', invoiceRequired: 'True', invoiceExemptBelow: '30000',
      requiresPurpose: 'true', requiresAttendees: 'true', requiresAttendeeDetails: 'false',
      perItemLimit: '10,000', perClaimLimit: '50000', perPersonLimit: '8000', perPersonBasis: 'tax-excluded', perUnitLabel: '泊', perUnitLimit: '12000',
      aliases: ' ホテル ; ;旅館', note: '注記',
    }, 4, 2);
    expect(category).toEqual({
      id: 'lodging', code: 'L1', name: '宿泊', enabled: false, sortOrder: 30, aliases: ['ホテル', '旅館'], accountId: 'expense.travel', defaultTaxRate: 8,
      taxCodeByRate: { '8': 'JP-IN-8R-S' }, receipt: { required: false, exemptBelow: 3000 }, invoice: { required: true, exemptBelow: 30000 },
      requires: { purpose: true, attendees: true, attendeeDetails: false },
      limits: { perItem: 10000, perClaim: 50000, perPerson: 8000, perPersonBasis: 'tax-excluded', perUnit: { label: '泊', amount: 12000 } },
      note: '注記',
    });
  });
});

describe('ImportExpensePolicyCsvUseCase', () => {
  it('正常: 費目の一覧だけを置き換え、**申請ルール・事前承認条件・重さ・仕訳設定は既存のまま残す**', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const base = defaultExpensePolicy();
    await new SaveExpensePolicyUseCase(policies, () => new Date('2026-09-15T00:00:00.000Z')).execute({
      scope, ...base,
      claimRules: { ...base.claimRules, forbidSelfApproval: true, submissionDeadlineDays: 30 },
      severityOverrides: { 'payee-missing': 'return' },
      journal: { ...base.journal, descriptionTemplate: '経費 {claimant}' },
    });
    const imported = await new ImportExpensePolicyCsvUseCase(policies, clock).execute({
      scope, content: 'id,name\r\nmeal.entertainment,接待\r\nsupplies,消耗品\r\n',
    });
    expect(imported.categories.map((category) => [category.id, category.name, category.sortOrder])).toEqual([['meal.entertainment', '接待', 10], ['supplies', '消耗品', 20]]);
    expect(imported.claimRules).toEqual({ ...base.claimRules, forbidSelfApproval: true, submissionDeadlineDays: 30 });
    expect(imported.preApprovalRules).toEqual(base.preApprovalRules);
    expect(imported.severityOverrides).toEqual({ 'payee-missing': 'return' });
    expect(imported.journal.descriptionTemplate).toBe('経費 {claimant}');
    expect(imported.updatedAt).toBe(NOW.toISOString());
    expect(await policies.get(scope)).toEqual(imported);
  });

  it('異常: 事前承認条件が参照する費目を消す CSV は、行番号ではなく**条件名と費目 id を並べて**拒否し、保存しない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const error = await caught(new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content: 'id,name\r\ntransport.taxi,タクシー\r\n' }));
    expect(error.message).toContain('「交際費で 1 件 50,000 円以上」→ meal.entertainment');
    expect(error.message).toContain('無効（enabled=false）にして残すか、事前承認条件から外してから取り込んでください');
    expect(error.row).toBeUndefined();
    expect(await policies.get(scope)).toBeNull();
  });

  it('境界: 参照中の費目を無効（enabled=false）で残す CSV は受け付ける', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const imported = await new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content: 'id,name,enabled\r\nmeal.entertainment,交際費,false\r\n' });
    expect(imported.categories[0]?.enabled).toBe(false);
  });

  it.each([
    ['真偽が true/false 以外', { enabled: 'yes' }, /row 3: enabled must be true or false \(found: yes\)/u],
    ['税率が 10 / 8 / 0 以外', { defaultTaxRate: '5' }, /row 3: defaultTaxRate must be one of 10, 8, 0 \(found: 5\)/u],
    ['上限が小数', { perItemLimit: '1.5' }, /row 3: perItemLimit must be a whole number of yen/u],
    ['上限が負の数', { perClaimLimit: '-100' }, /row 3: perClaimLimit must be a whole number of yen/u],
    ['免除の閾値が数値でない', { receiptExemptBelow: 'abc' }, /row 3: receiptExemptBelow must be a whole number of yen/u],
    ['perUnit のラベルだけ', { perUnitLabel: '泊' }, /row 3: perUnitLabel and perUnitLimit must be filled together/u],
    ['perUnit の金額だけ', { perUnitLimit: '3000' }, /row 3: perUnitLabel and perUnitLimit must be filled together/u],
    ['1 人あたりの基準が不正', { perPersonBasis: 'net' }, /row 3: perPersonBasis must be one of tax-included, tax-excluded/u],
    ['id が空', { id: '' }, /row 3: id must not be empty/u],
  ])('異常: 行の不正（%s）は行番号（ヘッダ = 1）付きの ExpenseDomainError', async (_label, patch, message) => {
    const policies = new InMemoryExpensePolicyRepository();
    const content = csvOf([{ id: 'meal.entertainment', name: '交際費' }, { id: 'transport.taxi', name: 'タクシー', ...patch }]);
    const error = await caught(new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content }));
    expect(error.message).toMatch(message);
    expect(error.row).toBe(3);
    expect(await policies.get(scope)).toBeNull();
  });

  it.each([
    ['id の形が不正', { id: 'Bad ID' }, /categories\[1\]\.id must match/u],
    ['上限が 0 円（範囲外）', { perItemLimit: '0' }, /categories\[1\]\.limits\.perItem must be an integer between 1 and 100000000/u],
    ['1 人あたりの上限があるのに人数が必須でない', { perPersonLimit: '10000' }, /limits\.perPerson needs requires\.attendees/u],
  ])('異常: 規程の検証エラー（%s）も表計算ソフトの行番号へ言い換える', async (_label, patch, message) => {
    const policies = new InMemoryExpensePolicyRepository();
    const content = csvOf([{ id: 'meal.entertainment', name: '交際費' }, { id: 'transport.taxi', name: 'タクシー', ...patch }]);
    const error = await caught(new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content }));
    expect(error.message).toMatch(/^expense categories CSV row 3: /u);
    expect(error.message).toMatch(message);
    expect(error.row).toBe(3);
  });

  it('異常: 位置を言わない規程の検証エラー（名前の衝突）は行番号なしのまま伝える', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const error = await caught(new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content: 'id,name\r\nmeal.entertainment,交際費\r\nother,交際費\r\n' }));
    expect(error.message).toMatch(/is used by both meal\.entertainment and other/u);
    expect(error.row).toBeUndefined();
  });

  it.each([
    ['name 列が無い', 'id,label\r\nmeal.entertainment,交際費\r\n', /the header row must include the 'name' column \(found: id, label\)/u],
    ['id 列が無い', 'name\r\n交際費\r\n', /the header row must include the 'id' column/u],
  ])('異常: ヘッダの必須列の欠落（%s）は取込全体を断る', async (_label, content, message) => {
    const error = await caught(new ImportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository(), clock).execute({ scope, content }));
    expect(error.message).toMatch(message);
  });

  it('境界: BOM 付きのヘッダも列名で読める', async () => {
    const imported = await new ImportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository(), clock).execute({ scope, content: `${BOM}name,id\r\n交際費,meal.entertainment\r\n` });
    expect(imported.categories.map((category) => category.id)).toEqual(['meal.entertainment']);
  });

  it.each([
    ['空ファイル', ''],
    ['BOM だけ', BOM],
    ['空行だけ', '\r\n , \r\n'],
  ])('異常: 行が無いファイル（%s）は断る', async (_label, content) => {
    await expect(new ImportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository(), clock).execute({ scope, content }))
      .rejects.toThrow(/the file has no rows/u);
  });

  it('例外: 引用符の閉じ忘れは行番号付きの ExpenseDomainError に包み直す', async () => {
    const error = await caught(new ImportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository(), clock).execute({ scope, content: 'id,name\r\n"meal.entertainment,交際費\r\n' }));
    expect(error.message).toMatch(/^expense categories CSV: .*unterminated quote/u);
    expect(error.row).toBe(2);
  });
});

describe('ImportExpensePolicyCsvUseCase: 交通費の区間の設定（route）の引き継ぎ', () => {
  it('正常: CSV に route の列が無いので、同じ id の費目の設定を引き継ぎ、新しい費目には付けない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const base = defaultExpensePolicy();
    const route = { required: true, commuterPass: false, fareTable: true };
    await new SaveExpensePolicyUseCase(policies, clock).execute({ scope, ...base, categories: base.categories.map((category) => (category.id === 'transport.public' ? { ...category, route } : category)) });

    const exported = await new ExportExpensePolicyCsvUseCase(policies).execute(scope);
    expect(exported.content).not.toContain('commuterPass');
    const roundTrip = await new ImportExpensePolicyCsvUseCase(policies, clock).execute({ scope, content: exported.content });
    expect(roundTrip.categories.find((category) => category.id === 'transport.public')?.route).toEqual(route);

    const replaced = await new ImportExpensePolicyCsvUseCase(policies, clock).execute({
      scope, content: csvOf([{ id: 'transport.public', name: '電車・バス' }, { id: 'meal.entertainment', name: '交際費' }, { id: 'transport.bike', name: 'シェアサイクル' }]),
    });
    expect(replaced.categories.find((category) => category.id === 'transport.public')?.route).toEqual(route);
    expect(replaced.categories.find((category) => category.id === 'transport.bike')).not.toHaveProperty('route');
    expect(replaced.categories.find((category) => category.id === 'meal.entertainment')).not.toHaveProperty('route');
  });

  it('境界: route の無い規程（未保存の初期テンプレート）からの取込は route を作らない', async () => {
    const imported = await new ImportExpensePolicyCsvUseCase(new InMemoryExpensePolicyRepository(), clock).execute({ scope, content: csvOf([{ id: 'meal.entertainment', name: '交際費' }]) });
    expect(imported.categories.map((category) => category.route)).toEqual([undefined]);
  });
});

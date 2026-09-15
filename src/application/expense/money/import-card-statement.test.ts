import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { scope } from '../../../adapters/storage/expense-repository.fixtures';
import { fixtureCardSettings } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseCardDuplicateImportError, ExpenseCardImportError, ExpenseCardImportNotFoundError } from '../../../domain/expense/errors';
import { ImportCardStatementUseCase } from './import-card-statement';

const HEADER = '利用日,利用店名,利用金額,カード番号下4桁,備考';
const csv = (lines: readonly string[]): string => `﻿${[HEADER, ...lines].join('\r\n')}\r\n`;
const SEPTEMBER = csv(['2026/09/10,サンプルマート 霞が関店,3200,1111,', '2026/09/12,サンプルホテル,12000,2222,出張', '2026/09/15,サンプル書店,abc,1111,']);

async function setup(withProfiles = true): Promise<{ ctx: MoneyTestContext; usecase: ImportCardStatementUseCase }> {
  const ctx = moneyTestContext();
  const settings = fixtureCardSettings();
  await ctx.settings.save(scope, 'cards', withProfiles ? settings : { ...settings, profiles: [] });
  let sequence = 0;
  return { ctx, usecase: new ImportCardStatementUseCase(ctx.deps, () => { sequence += 1; return `id${sequence}`; }) };
}

describe('ImportCardStatementUseCase.preview', () => {
  it('正常: 見出しの署名で保存済みのプロファイルを選び、先頭の行・読めない行・期間を返す（保存しない）', async () => {
    const { ctx, usecase } = await setup();
    const preview = await usecase.preview(scope, { content: SEPTEMBER });
    expect(preview).toMatchObject({ detectedProfileId: 'profile-generic', rowCount: 3, periodFrom: '2026-09-10', periodTo: '2026-09-12', problems: [] });
    expect(preview.rows.map((row) => [row.row, row.cardId, row.amount])).toEqual([[2, 'card-sales', 3200], [3, 'card-shared', 12000]]);
    expect(preview.skippedRows).toEqual([{ row: 4, reason: expect.stringContaining('abc') }]);
    expect(await ctx.cards.listImports(scope)).toEqual([]);
  });

  it('正常: プロファイルが無ければ見出しから推定した対応で読む。推定できなければ対応を選ぶよう問題を返す', async () => {
    const { usecase } = await setup(false);
    const preview = await usecase.preview(scope, { content: SEPTEMBER });
    expect(preview.detectedProfileId).toBeUndefined();
    expect(preview.suggestedMapping).toMatchObject({ usedOn: '利用日', merchant: '利用店名', amount: '利用金額', cardLast4: 'カード番号下4桁' });
    expect(preview.rows).toHaveLength(2);
    const unknown = await usecase.preview(scope, { content: 'A,B,C\r\n1,2,3\r\n' });
    expect(unknown.problems).toEqual([{ code: 'mapping-missing', message: expect.stringContaining('usedOn, merchant, amount'), missingColumns: ['usedOn', 'merchant', 'amount'] }]);
  });

  it('異常: 指定の対応の列が見出しに無ければ取込エラーを問題として返し、保存していないプロファイル id は断る', async () => {
    const { usecase } = await setup();
    const preview = await usecase.preview(scope, { content: SEPTEMBER, mapping: { columns: { usedOn: 'ご利用日', merchant: '利用店名', amount: '利用金額' }, amountSign: 'charge-positive', skipLinesBefore: 0 }, cardId: 'card-sales' });
    expect(preview.problems).toEqual([expect.objectContaining({ code: 'card-import', missingColumns: ['usedOn'], row: 1 })]);
    await expect(usecase.preview(scope, { content: SEPTEMBER, profileId: 'profile-missing' })).rejects.toThrow(ExpenseCardImportError);
  });

  it('正常: 前置きの行があるプロファイルも、その行数で読んで署名を比べる', async () => {
    const { ctx, usecase } = await setup();
    const settings = fixtureCardSettings();
    const withPreamble = { ...settings.profiles[0] as NonNullable<typeof settings.profiles[0]>, id: 'profile-preamble', name: '前置きあり', headerSignature: ['ご利用日', 'ご利用店名', 'ご利用金額'], columns: { usedOn: 'ご利用日', merchant: 'ご利用店名', amount: 'ご利用金額' }, skipLinesBefore: 2 };
    await ctx.settings.save(scope, 'cards', { ...settings, profiles: [...settings.profiles, withPreamble] });
    const preview = await usecase.preview(scope, { content: 'サンプルカード ご利用明細\r\n2026年9月分\r\nご利用日,ご利用店名,ご利用金額\r\n2026/09/10,店,100\r\n', cardId: 'card-shared' });
    expect(preview.detectedProfileId).toBe('profile-preamble');
    expect(preview.rows[0]).toMatchObject({ row: 4, cardId: 'card-shared', amount: 100 });
  });
});

describe('ImportCardStatementUseCase.import', () => {
  it('正常: 取り込むと取込の記録（SHA-256・期間・件数）と未照合の利用行を保存する', async () => {
    const { ctx, usecase } = await setup();
    const result = await usecase.import(scope, { content: SEPTEMBER, fileName: 'card-statement-generic.csv' }, 'keiri');
    expect(result).toMatchObject({ importId: 'card-import-id1', imported: 2, duplicates: 0, periodFrom: '2026-09-10', periodTo: '2026-09-12', profileId: 'profile-generic' });
    expect(result.warnings).toEqual([expect.stringContaining('1 行を取り込めませんでした')]);
    const [record] = await ctx.cards.listImports(scope);
    expect(record).toMatchObject({ fileName: 'card-statement-generic.csv', rowCount: 3, importedCount: 2, duplicateCount: 0, skippedRows: [{ row: 4 }], by: 'keiri' });
    expect(record?.fileSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((await ctx.cards.listTransactions(scope)).map((transaction) => [transaction.cardId, transaction.status, transaction.amount])).toEqual([['card-shared', 'unmatched', 12000], ['card-sales', 'unmatched', 3200]]);
  });

  it('異常: 同じファイルは取込全体を 409 にし、期間の重なる別のファイルの同じ行は重複として数えて入れない', async () => {
    const { ctx, usecase } = await setup();
    await usecase.import(scope, { content: SEPTEMBER, fileName: 'a.csv' }, 'k');
    await expect(usecase.import(scope, { content: SEPTEMBER, fileName: 'a-again.csv' }, 'k')).rejects.toThrow(ExpenseCardDuplicateImportError);
    const overlap = await usecase.import(scope, { content: csv(['2026/09/10,サンプルマート 霞が関店,3200,1111,', '2026/09/20,サンプル交通,1500,1111,']), fileName: 'overlap.csv' }, 'k');
    expect(overlap).toMatchObject({ imported: 1, duplicates: 1 });
    expect(overlap.warnings).toEqual([expect.stringContaining('1 行は取込済み')]);
    expect(await ctx.cards.listTransactions(scope)).toHaveLength(3);
    expect(Object.fromEntries((await ctx.cards.listImports(scope)).map((record) => [record.fileName, record.duplicateCount]))).toEqual({ 'a.csv': 0, 'overlap.csv': 1 });
  });

  it('正常: saveProfileAs で今回の列の対応をプロファイルに保存し、同じ名前なら置き換える', async () => {
    const { ctx, usecase } = await setup(false);
    const mapping = { columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額', cardLast4: 'カード番号下4桁' }, amountSign: 'charge-positive' as const, skipLinesBefore: 0 };
    const first = await usecase.import(scope, { content: SEPTEMBER, fileName: 'a.csv', mapping, saveProfileAs: 'サンプルカード' }, 'k');
    expect(first.profileId).toMatch(/^profile-id\d+$/u);
    const second = await usecase.import(scope, { content: csv(['2026/10/01,店,100,1111,']), fileName: 'b.csv', mapping: { ...mapping, amountSign: 'charge-negative' }, saveProfileAs: 'サンプルカード' }, 'k');
    expect(second.profileId).toBe(first.profileId);
    const saved = await ctx.settings.get(scope, 'cards');
    expect(saved?.profiles).toEqual([expect.objectContaining({ id: first.profileId, name: 'サンプルカード', amountSign: 'charge-negative', headerSignature: ['利用日', '利用店名', '利用金額', 'カード番号下4桁', '備考'] })]);
    // 次は署名で自動選択される。
    expect((await usecase.import(scope, { content: csv(['2026/10/02,店,-200,1111,']), fileName: 'c.csv' }, 'k')).profileId).toBe(first.profileId);
  });

  it('異常: 対応が決まらない・取り込める行が 0 件なら、推定した対応や最初の行の理由を付けて断る', async () => {
    const { usecase } = await setup(false);
    const noMapping = await usecase.import(scope, { content: SEPTEMBER, fileName: 'a.csv' }, 'k').catch((error: unknown) => error);
    expect(noMapping).toBeInstanceOf(ExpenseCardImportError);
    expect((noMapping as ExpenseCardImportError).suggestedMapping).toMatchObject({ usedOn: '利用日' });
    const mapping = { columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額', cardLast4: 'カード番号下4桁' }, amountSign: 'charge-positive' as const, skipLinesBefore: 0 };
    await expect(usecase.import(scope, { content: csv(['2026/09/15,店,abc,1111,']), fileName: 'bad.csv', mapping }, 'k')).rejects.toMatchObject({ row: 2, message: expect.stringContaining('row 2') });
    await expect(usecase.import(scope, { content: csv([]), fileName: 'empty.csv', mapping }, 'k')).rejects.toThrow('no rows could be imported');
  });

  it('正常: 取込の一覧と削除（利用行も消す）。無い取込の削除は 404', async () => {
    const { ctx, usecase } = await setup();
    const { importId } = await usecase.import(scope, { content: SEPTEMBER, fileName: 'a.csv' }, 'k');
    expect((await usecase.listImports(scope)).map((record) => record.id)).toEqual([importId]);
    expect(await usecase.deleteImport(scope, importId)).toBe(2);
    expect(await ctx.cards.listTransactions(scope)).toEqual([]);
    await expect(usecase.deleteImport(scope, importId)).rejects.toThrow(ExpenseCardImportNotFoundError);
  });
});

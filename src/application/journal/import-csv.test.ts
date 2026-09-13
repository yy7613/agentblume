import { describe, expect, it } from 'vitest';
import { InMemoryJournalDocumentRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { JournalCsvImportError } from '../../domain/journal/errors';
import { CUSTOM_CSV_PRESET, ImportJournalCsvUseCase } from './import-csv';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

function ids(): () => string {
  let counter = 0;
  return () => `doc-${(counter += 1)}`;
}

function usecase(documents = new InMemoryJournalDocumentRepository()) {
  return { documents, run: new ImportJournalCsvUseCase(documents, ids(), clock) };
}

const genericCsv = [
  '日付,摘要,出金,入金,残高',
  '2026-09-10,アマゾン ウェブ サービス,1100,,50000',
  '2026-09-11,振込 ｶ)ヤマダ,,20000,70000',
  '',
].join('\r\n');

describe('ImportJournalCsvUseCase', () => {
  it('正常: 列名署名からプリセットを自動判定し、1 行 1 文書で保存する', async () => {
    const { documents, run } = usecase();
    const result = await run.execute({ scope, content: genericCsv, accountHint: 'テスト銀行' });
    expect(result.preset).toBe('generic');
    expect(result.imported).toHaveLength(2);
    expect(result.skippedRows).toEqual([]);
    expect(result.warnings).toContain('detected preset: generic');
    expect(await documents.list(scope)).toHaveLength(2);
  });

  it('正常: 出金は支出、入金は収入。摘要は正規化され口座名が入る', async () => {
    const { documents, run } = usecase();
    await run.execute({ scope, content: genericCsv, accountHint: 'テスト銀行' });
    const saved = await documents.findByIds(scope, ['doc-1', 'doc-2']);
    expect(saved[0]?.facts).toMatchObject({ direction: 'out', grandTotal: 1100, transactionDate: '2026-09-10', accountHint: 'テスト銀行' });
    expect(saved[1]?.facts).toMatchObject({ direction: 'in', grandTotal: 20000 });
    // 法人略号は正規化で落ちる。
    expect(saved[1]?.facts.descriptionNorm).toBe('振込 ヤマダ');
    expect(saved[0]?.kind).toBe('bank_statement');
    expect(saved[0]?.source).toMatchObject({ type: 'csv-row', preset: 'generic' });
    // CSV の生値は残す（あとから元データを確認できる）。
    expect(saved[0]?.source.row).toMatchObject({ 日付: '2026-09-10' });
  });

  it('正常: BOM 付きでも列名が壊れない', async () => {
    const { run } = usecase();
    const result = await run.execute({ scope, content: `﻿${genericCsv}` });
    expect(result.preset).toBe('generic');
    expect(result.imported).toHaveLength(2);
  });

  it('正常: preset を明示すれば自動判定しない', async () => {
    const { run } = usecase();
    const result = await run.execute({
      scope, preset: 'rakuten-bank',
      content: '取引日,入出金(円),残高(円),入出金先内容\r\n2026-09-10,-1100,50000,アマゾン\r\n',
    });
    expect(result.preset).toBe('rakuten-bank');
    expect(result.imported).toHaveLength(1);
    expect(result.warnings).not.toContain('detected preset: rakuten-bank');
  });

  it('正常: columnMapping で未知の列構成を取り込める（preset は custom）', async () => {
    const { documents, run } = usecase();
    const result = await run.execute({
      scope,
      content: 'Date,Memo,Amount\r\n2026-09-10,COFFEE SHOP,-500\r\n',
      columnMapping: { date: 'Date', description: 'Memo', amount: 'Amount' },
    });
    expect(result.preset).toBe(CUSTOM_CSV_PRESET);
    expect(result.imported).toHaveLength(1);
    expect((await documents.findById(scope, 'doc-1'))?.facts).toMatchObject({ direction: 'out', grandTotal: 500 });
  });

  it('境界: 読めない行は skippedRows へ積み、残りは保存する（行番号はヘッダ行を 1 とする）', async () => {
    const { documents, run } = usecase();
    const content = [
      '日付,摘要,出金,入金,残高',
      '2026-09-10,正常な行,1100,,50000',
      'これは合計行です,,,,',
      '2026-09-12,日付が読めない行,,,',
      '2026-09-13,もう一つ正常な行,300,,49000',
    ].join('\r\n');
    const result = await run.execute({ scope, content });
    expect(result.imported).toHaveLength(2);
    expect(result.skippedRows.map((row) => row.row)).toEqual([3, 4]);
    expect(result.skippedRows[0]?.reason).toContain('row 3');
    expect(result.warnings).toContain('skipped 2 of 4 rows');
    expect(await documents.list(scope)).toHaveLength(2);
  });

  it('境界: 全列が空白の行は黙って捨てる（skippedRows に出さない）', async () => {
    const { run } = usecase();
    const content = '日付,摘要,出金,入金,残高\r\n\r\n , , , , \r\n2026-09-10,正常,1100,,1\r\n';
    const result = await run.execute({ scope, content });
    expect(result.imported).toHaveLength(1);
    expect(result.skippedRows).toEqual([]);
  });

  it('境界: ヘッダだけの CSV は 0 件で成功する', async () => {
    const { run } = usecase();
    const result = await run.execute({ scope, content: '日付,摘要,出金,入金,残高\r\n' });
    expect(result.imported).toEqual([]);
    expect(result.skippedRows).toEqual([]);
  });

  it('正常: 返す文書は要約（証憑本体を含まない）', async () => {
    const { run } = usecase();
    const result = await run.execute({ scope, content: genericCsv });
    expect(result.imported[0]).not.toHaveProperty('source');
    expect(JSON.stringify(result.imported)).not.toContain('残高');
  });

  it('例外: プリセットが決まらなければ取込全体を断る（行番号なし）', async () => {
    const { documents, run } = usecase();
    await expect(run.execute({ scope, content: 'foo,bar\r\n1,2\r\n' })).rejects.toThrow(JournalCsvImportError);
    await expect(run.execute({ scope, content: 'foo,bar\r\n1,2\r\n' })).rejects.toThrow(/could not detect a preset/);
    try {
      await run.execute({ scope, content: 'foo,bar\r\n1,2\r\n' });
    } catch (error) {
      expect((error as JournalCsvImportError).row).toBeUndefined();
    }
    expect(await documents.list(scope)).toEqual([]);
  });

  it('例外: 未知の preset id は取込前に断る', async () => {
    const { run } = usecase();
    await expect(run.execute({ scope, preset: 'nope', content: genericCsv })).rejects.toThrow(/unknown preset: nope/);
  });

  it('例外: 空ファイル・引用符の閉じ忘れ', async () => {
    const { run } = usecase();
    await expect(run.execute({ scope, content: '' })).rejects.toThrow(/has no rows/);
    await expect(run.execute({ scope, content: '日付,摘要,出金,入金,残高\r\n2026-09-10,"閉じてない,1,,1\r\n' })).rejects.toThrow(/unterminated quote/);
  });
});
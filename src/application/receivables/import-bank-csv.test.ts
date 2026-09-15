import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { InMemoryBankCsvProfileRepository, InMemoryBankTransactionRepository } from '../../adapters/storage/in-memory-receivables-repositories';
import { createBankCsvProfile } from '../../domain/receivables/bank-csv-profile';
import { BankCsvProfileNotFoundError, ReceivablesCsvImportError } from '../../domain/receivables/errors';
import { BANK_CSV_MAX_BYTES, bytesFromBase64, decodeBankCsv } from './bank-csv-decode';
import { ImportBankCsvUseCase, PreviewBankCsvUseCase } from './import-bank-csv';
import { AT, NOW, scope, sequentialIds } from './receivables-usecases.fixtures';

const utf8Bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]).toString('base64');
const utf8 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const sjis = (text: string) => iconv.encode(text, 'cp932').toString('base64');

const GENERIC = [
  '日付,摘要,出金,入金,残高',
  '2026/09/30,ﾌﾘｺﾐ ｻﾝﾌﾟﾙｼﾖｳｼﾞ,,110000,1110000',
  '2026/09/30,ｶｰﾄﾞ ｼﾖｳﾋﾝ,5000,,1105000',
  '2026/10/01,ﾌﾘｺﾐ 1234567 ｶ)ﾔﾏﾀﾞｼﾖｳｼﾞ,,54560,1159560',
  '日付不明,ﾌﾘｺﾐ ﾌﾒｲ,,100,',
].join('\r\n');

function setup() {
  const profiles = new InMemoryBankCsvProfileRepository();
  const transactions = new InMemoryBankTransactionRepository();
  return { profiles, transactions, preview: new PreviewBankCsvUseCase(profiles), importer: new ImportBankCsvUseCase(profiles, transactions, sequentialIds('tx'), () => NOW) };
}

describe('decodeBankCsv', () => {
  it('正常: BOM 付きは UTF-8、厳格な UTF-8 で読めれば UTF-8、読めなければ CP932（NEC 特殊文字も化けない）', () => {
    expect(decodeBankCsv(Buffer.from(utf8Bom('日付'), 'base64'))).toMatchObject({ text: '日付', encoding: 'utf-8', warnings: [] });
    expect(decodeBankCsv(Buffer.from('入金', 'utf8'))).toMatchObject({ text: '入金', encoding: 'utf-8' });
    expect(decodeBankCsv(iconv.encode('ﾌﾘｺﾐ ①ﾃｽﾄ', 'cp932'))).toMatchObject({ text: 'ﾌﾘｺﾐ ①ﾃｽﾄ', encoding: 'shift_jis', warnings: [] });
  });

  it('境界: 明示指定を優先する。化けた行は行番号つきの警告にする', () => {
    const bytes = iconv.encode('日付\n入金', 'cp932');
    expect(decodeBankCsv(bytes, 'shift_jis')).toMatchObject({ text: '日付\n入金', encoding: 'shift_jis' });
    const garbled = decodeBankCsv(bytes, 'utf-8');
    expect(garbled.encoding).toBe('utf-8');
    expect(garbled.warnings).toEqual([{ code: 'garbled-rows', params: { rows: '1, 2', count: 2 } }]);
    expect(decodeBankCsv(Buffer.from('日付', 'utf8'), 'utf-8').warnings).toEqual([]);
  });

  it('境界: 生バイト 5 MiB ちょうどまで受け、超えたら undefined', () => {
    expect(bytesFromBase64(Buffer.alloc(BANK_CSV_MAX_BYTES).toString('base64'))?.length).toBe(BANK_CSV_MAX_BYTES);
    expect(bytesFromBase64(Buffer.alloc(BANK_CSV_MAX_BYTES + 1).toString('base64'))).toBeUndefined();
  });
});

describe('PreviewBankCsvUseCase', () => {
  it('正常: 組込みプロファイルを判定し、ヘッダ行・先頭行・データ行数を返す（保存しない）', async () => {
    const { preview, transactions } = setup();
    const result = await preview.execute({ scope, contentBase64: utf8Bom(GENERIC) });
    expect(result).toMatchObject({ encoding: 'utf-8', headerRow: 1, headers: ['日付', '摘要', '出金', '入金', '残高'], profile: { id: 'builtin:generic', origin: 'builtin' }, mappingRequired: false, dataRowCount: 4, preamble: [] });
    expect(result.rows).toHaveLength(4);
    expect(result.warnings).toEqual([{ code: 'detected-profile', params: { profile: '汎用（日付,摘要,出金,入金,残高）' } }]);
    expect(await transactions.list(scope)).toEqual([]);
  });

  it('境界: 未知の列構成は列マッピングが必要と返し、日付と金額らしい行をヘッダ行に推す', async () => {
    const { preview } = setup();
    const csv = ['口座番号,1234567', '期間,2026/09', '', '取引日,お預入金額,振込依頼人名', '2026/09/30,1000,ﾃｽﾄ'].join('\n');
    const result = await preview.execute({ scope, contentBase64: utf8(csv) });
    expect(result).toMatchObject({ headerRow: 3, headers: ['取引日', 'お預入金額', '振込依頼人名'], mappingRequired: true, mappingProblems: ['date', 'deposit-or-amount'], preamble: [['口座番号', '1234567'], ['期間', '2026/09']] });
    expect(result).not.toHaveProperty('profile');
  });
});

describe('ImportBankCsvUseCase', () => {
  it('正常: 入金行だけを取り込み、出金は件数・読めない行は理由つきで返す。摘要から名義を切り出す', async () => {
    const { importer } = setup();
    const result = await importer.execute({ scope, contentBase64: utf8Bom(GENERIC), fileName: 'bank.csv', accountKey: 'main' });
    expect(result).toMatchObject({ profileId: 'builtin:generic', encoding: 'utf-8', skippedWithdrawals: 1, duplicates: [] });
    expect(result.imported.map((transaction) => [transaction.date, transaction.amount, transaction.payerName, transaction.payerNameNorm, transaction.balance, transaction.source.rowNumber])).toEqual([
      ['2026-09-30', 110_000, 'サンプルシヨウジ', 'サンプルシヨウジ', 1_110_000, 2],
      ['2026-10-01', 54_560, 'カ)ヤマダシヨウジ', 'ヤマダシヨウジ', 1_159_560, 4],
    ]);
    expect(result.imported[0]).toMatchObject({ accountKey: 'main', status: 'unmatched', source: { fileName: 'bank.csv', profileId: 'builtin:generic' }, createdAt: AT });
    expect(result.skippedRows).toEqual([{ row: 5, reason: expect.stringMatching(/date/) }]);
    expect(result.warnings).toEqual([{ code: 'skipped-rows', params: { count: 1, total: 4 } }]);
  });

  it('正常: 取り込み直すと同じ行は重複として返す。同じファイル内の同日同額同名義は出現順で区別する', async () => {
    const { importer, transactions } = setup();
    const twice = ['日付,摘要,出金,入金', '2026/09/30,ﾌﾘｺﾐ ﾃｽﾄ,,1000', '2026/09/30,ﾌﾘｺﾐ ﾃｽﾄ,,1000'].join('\n');
    expect((await importer.execute({ scope, contentBase64: utf8(twice) })).imported).toHaveLength(2);
    const again = await importer.execute({ scope, contentBase64: utf8(twice) });
    expect(again.imported).toEqual([]);
    expect(again.duplicates).toEqual([
      { row: 2, date: '2026-09-30', amount: 1000, payerName: 'テスト', existingId: 'tx-1' },
      { row: 3, date: '2026-09-30', amount: 1000, payerName: 'テスト', existingId: 'tx-2' },
    ]);
    // 残高列が無い明細は、同日同額同名義を重複と見なし得ることを常に知らせる（重複しか無い取込でも出す）。
    expect(again.warnings).toEqual([{ code: 'no-balance-column', params: {} }]);
    const third = await importer.execute({ scope, contentBase64: utf8(['日付,摘要,出金,入金', '2026/09/30,ﾌﾘｺﾐ ﾃｽﾄ,,1000'].join('\n')), forceRows: [2] });
    expect(third.imported).toHaveLength(1);
    expect(third.warnings).toEqual([{ code: 'no-balance-column', params: {} }]);
    expect(new Set((await transactions.list(scope)).map((transaction) => transaction.fingerprint)).size).toBe(3);
  });

  it('正常: 前置き行のある未知の列構成を保存したプロファイルで自動判定し、名義の列をそのまま使う（行番号はファイル上の番号）', async () => {
    const { importer, profiles } = setup();
    await profiles.save(createBankCsvProfile({ tenant: scope, id: 'chigin', name: '地銀', mapping: { date: '取引日', deposit: 'お預入金額', withdrawal: 'お引出金額', payerName: '振込依頼人名' }, accountKey: 'chigin-main', createdAt: AT, updatedAt: AT }));
    const csv = ['口座番号,1234567', '期間,2026/09', 'x,y', '取引日,お引出金額,お預入金額,振込依頼人名', '2026/09/30,,88000,ﾔﾏﾀﾞ ﾀﾛｳ', '2026/09/30,500,,'].join('\n');
    const result = await importer.execute({ scope, contentBase64: sjis(csv) });
    expect(result).toMatchObject({ profileId: 'chigin', encoding: 'shift_jis', skippedWithdrawals: 1 });
    expect(result.imported[0]).toMatchObject({ accountKey: 'chigin-main', payerName: 'ﾔﾏﾀﾞ ﾀﾛｳ', payerNameNorm: 'ヤマダタロウ', description: 'ﾔﾏﾀﾞ ﾀﾛｳ', source: { rowNumber: 5 } });
  });

  it('正常: その場の列マッピング（ヘッダ行指定）とプロファイル id の明示指定', async () => {
    const { importer, preview, profiles } = setup();
    const csv = ['メモ', '年月日,金額,内容', '2026/09/30,-300,ﾃﾞﾝｷﾀﾞｲ', '2026/09/30,2000,ﾌﾘｺﾐ ﾃｽﾄ'].join('\n');
    const adHoc = await importer.execute({ scope, contentBase64: utf8(csv), mapping: { date: '年月日', amount: '金額', description: '内容' }, headerRow: 2 });
    expect(adHoc).toMatchObject({ skippedWithdrawals: 1, imported: [{ amount: 2_000, payerNameNorm: 'テスト', accountKey: 'default' }] });
    expect(adHoc).not.toHaveProperty('profileId');
    await profiles.save(createBankCsvProfile({ tenant: scope, id: 'p', name: 'x', mapping: { date: '年月日', amount: '金額', description: '内容' }, headerRow: 2, createdAt: AT, updatedAt: AT }));
    expect((await preview.execute({ scope, contentBase64: utf8(csv), profileId: 'p' })).headerRow).toBe(2);
    expect((await preview.execute({ scope, contentBase64: utf8(GENERIC), profileId: 'builtin:generic' })).profile?.id).toBe('builtin:generic');
    await expect(preview.execute({ scope, contentBase64: utf8(GENERIC), profileId: 'missing' })).rejects.toBeInstanceOf(BankCsvProfileNotFoundError);
    await expect(preview.execute({ scope, contentBase64: utf8(GENERIC), profileId: 'builtin:nope' })).rejects.toBeInstanceOf(BankCsvProfileNotFoundError);
  });

  it('異常: 列構成が決まらない・マッピングの不足・空・大きすぎ・引用符の閉じ忘れは取込全体を断る', async () => {
    const { importer } = setup();
    await expect(importer.execute({ scope, contentBase64: utf8('名前,メモ\nx,y') })).rejects.toThrow(/could not detect a bank CSV profile/);
    await expect(importer.execute({ scope, contentBase64: utf8(GENERIC), mapping: { date: '日付' } })).rejects.toThrow(/mapping is missing: deposit-or-amount/);
    await expect(importer.execute({ scope, contentBase64: utf8('\n\n') })).rejects.toThrow(/no rows/);
    await expect(importer.execute({ scope, contentBase64: Buffer.alloc(BANK_CSV_MAX_BYTES + 1).toString('base64') })).rejects.toThrow(/larger than 5 MiB/);
    const unterminated = await importer.execute({ scope, contentBase64: utf8('日付,摘要\n"2026/09/30,x') }).catch((error: unknown) => error);
    expect(unterminated).toBeInstanceOf(ReceivablesCsvImportError);
    expect((unterminated as ReceivablesCsvImportError).row).toBe(2);
  });

  it('例外: 一意索引に弾かれた行（別の取込と競合）は 1 行の問題として skippedRows に積む', async () => {
    const { profiles, transactions } = setup();
    const racing = { ...transactions, findByFingerprints: async () => new Map<string, string>(), save: async () => { throw new Error('UNIQUE constraint failed'); } };
    const result = await new ImportBankCsvUseCase(profiles, racing as never, sequentialIds(), () => NOW).execute({ scope, contentBase64: utf8Bom(GENERIC) });
    expect(result.imported).toEqual([]);
    expect(result.skippedRows.map((entry) => entry.row)).toEqual([5, 2, 4]);
  });
});

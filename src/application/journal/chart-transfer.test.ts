import { describe, expect, it } from 'vitest';
import { InMemoryChartOfAccountsRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { JournalDomainError } from '../../domain/journal/errors';
import { CHART_CSV_COLUMNS, ExportChartCsvUseCase, ImportChartCsvUseCase } from './chart-transfer';
import { SaveChartOfAccountsUseCase } from './manage-chart';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

const baseChart = {
  accounts: [
    { id: 'expense.supplies', code: '741', name: '消耗品費', category: 'expense' as const, defaultTaxCode: 'JP-IN-10-S', aliases: ['消耗品', '事務用品'], enabled: true, sortOrder: 10 },
    { id: 'asset.cash', name: '現金', category: 'asset' as const, aliases: [], enabled: false, sortOrder: 20 },
  ],
  dimensions: [{ id: 'department', name: '部門', values: [{ id: 'sales', name: '営業部', enabled: true }] }],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in' as const, rate: 10, enabled: true }],
};

async function seeded() {
  const charts = new InMemoryChartOfAccountsRepository();
  await new SaveChartOfAccountsUseCase(charts, clock).execute({ scope, ...baseChart });
  return charts;
}

describe('ExportChartCsvUseCase', () => {
  it('正常: BOM 付き・CRLF・7 列のヘッダ。別名は ; 区切り、enabled は true/false', async () => {
    const content = await new ExportChartCsvUseCase(await seeded()).execute(scope);
    expect(content.startsWith('﻿')).toBe(true);
    const lines = content.slice(1).split('\r\n');
    expect(lines[0]).toBe(CHART_CSV_COLUMNS.join(','));
    expect(lines[1]).toBe('expense.supplies,741,消耗品費,expense,JP-IN-10-S,消耗品;事務用品,true');
    // 省略できる列は空セル。無効化された科目も出す（CSV で戻せるように）。
    expect(lines[2]).toBe('asset.cash,,現金,asset,,,false');
    expect(lines.at(-1)).toBe('');
  });

  it('境界: 未保存のワークスペースは標準セットを出す', async () => {
    const content = await new ExportChartCsvUseCase(new InMemoryChartOfAccountsRepository()).execute(scope);
    expect(content).toContain('expense.supplies');
    expect(content.split('\r\n').length).toBeGreaterThan(50);
  });
});

describe('ImportChartCsvUseCase', () => {
  it('正常: 勘定科目の一覧を置き換え、**税区分と補助軸は既存のまま残す**', async () => {
    const charts = await seeded();
    const chart = await new ImportChartCsvUseCase(charts, clock).execute({
      scope,
      content: 'id,code,name,category,defaultTaxCode,aliases,enabled\r\nexpense.misc,,雑費,expense,JP-IN-10-S,その他;諸経費,true\r\n',
    });
    expect(chart.accounts).toEqual([expect.objectContaining({ id: 'expense.misc', name: '雑費', aliases: ['その他', '諸経費'], enabled: true, sortOrder: 10 })]);
    // 科目 CSV に定義が無いものを消してはならない（消すと既存のルール・仕訳が一斉に壊れる）。
    expect(chart.taxCategories).toEqual(baseChart.taxCategories);
    expect(chart.dimensions).toEqual(baseChart.dimensions);
    expect(chart.updatedAt).toBe(NOW.toISOString());
    expect((await charts.get(scope))?.accounts).toHaveLength(1);
  });

  it('正常: BOM 付き・列順が違う CSV も列名で読める。enabled 省略は有効扱い', async () => {
    const charts = await seeded();
    const chart = await new ImportChartCsvUseCase(charts, clock).execute({
      scope,
      content: '﻿name,id,category\r\n雑費,expense.misc,expense\r\n',
    });
    expect(chart.accounts[0]).toMatchObject({ id: 'expense.misc', name: '雑費', enabled: true, aliases: [] });
  });

  it('正常: 行の順序が sortOrder になる（表計算ソフトで並べ替えた結果を採る）', async () => {
    const charts = await seeded();
    const chart = await new ImportChartCsvUseCase(charts, clock).execute({
      scope,
      content: 'id,name,category\r\nb,B,expense\r\na,A,expense\r\n',
    });
    expect(chart.accounts.map((account) => [account.id, account.sortOrder])).toEqual([['b', 10], ['a', 20]]);
  });

  it('境界: 空行は捨てる。false は無効化として読む', async () => {
    const charts = await seeded();
    const chart = await new ImportChartCsvUseCase(charts, clock).execute({
      scope,
      content: 'id,name,category,enabled\r\na,A,expense,false\r\n\r\n,,,\r\nb,B,asset,true\r\n',
    });
    expect(chart.accounts.map((account) => [account.id, account.enabled])).toEqual([['a', false], ['b', true]]);
  });

  it('異常: 未知の category は行番号つきの JournalDomainError（ヘッダ行が 1）', async () => {
    const charts = await seeded();
    const usecase = new ImportChartCsvUseCase(charts, clock);
    await expect(usecase.execute({ scope, content: 'id,name,category\r\na,A,expense\r\nb,B,nope\r\n' }))
      .rejects.toThrow(/row 3: unknown category: nope/);
    // 失敗した取込は既存のマスタを壊さない。
    expect((await charts.get(scope))?.accounts).toHaveLength(2);
  });

  it('異常: id の重複は行番号つきで断る', async () => {
    const charts = await seeded();
    await expect(new ImportChartCsvUseCase(charts, clock).execute({ scope, content: 'id,name,category\r\na,A,expense\r\na,A2,expense\r\n' }))
      .rejects.toThrow(/row 3: duplicate account id: a/);
  });

  it('異常: id が空・必須列が無い・空ファイルは JournalDomainError', async () => {
    const charts = await seeded();
    const usecase = new ImportChartCsvUseCase(charts, clock);
    await expect(usecase.execute({ scope, content: 'id,name,category\r\n,A,expense\r\n' })).rejects.toThrow(/row 2: id must not be empty/);
    await expect(usecase.execute({ scope, content: 'name,category\r\nA,expense\r\n' })).rejects.toThrow(/must include the 'id' column/);
    await expect(usecase.execute({ scope, content: '' })).rejects.toThrow(JournalDomainError);
  });

  it('異常: 既存の税区分に無い defaultTaxCode は弾く（domain の検証に載る）', async () => {
    const charts = await seeded();
    await expect(new ImportChartCsvUseCase(charts, clock).execute({ scope, content: 'id,name,category,defaultTaxCode\r\na,A,expense,JP-NOPE\r\n' }))
      .rejects.toThrow(/unknown tax category/);
  });

  it('正常: 出力 → 取込で往復する（科目が欠けない）', async () => {
    const charts = await seeded();
    const content = await new ExportChartCsvUseCase(charts).execute(scope);
    const chart = await new ImportChartCsvUseCase(charts, clock).execute({ scope, content });
    expect(chart.accounts.map((account) => account.id)).toEqual(['expense.supplies', 'asset.cash']);
    expect(chart.accounts[0]).toMatchObject({ code: '741', aliases: ['消耗品', '事務用品'], enabled: true });
    expect(chart.accounts[1]).toMatchObject({ enabled: false });
  });
});
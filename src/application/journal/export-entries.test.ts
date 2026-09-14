import { describe, expect, it } from 'vitest';
import { InMemoryChartOfAccountsRepository, InMemoryJournalEntryRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalEntry } from '../../domain/journal/entry';
import { JournalExportError } from '../../domain/journal/errors';
import { ExportJournalEntriesUseCase } from './export-entries';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

async function setup() {
  const entries = new InMemoryJournalEntryRepository();
  const charts = new InMemoryChartOfAccountsRepository();
  await charts.save(scope, DEFAULT_CHART_OF_ACCOUNTS);
  return { entries, charts, usecase: new ExportJournalEntriesUseCase(entries, charts, clock) };
}

async function addEntry(entries: InMemoryJournalEntryRepository, id: string, overrides: Record<string, unknown> = {}) {
  await entries.save(createJournalEntry({
    tenant: scope, id, documentId: 'doc-1', ruleId: 'rule-1', date: '2026-09-10',
    lines: [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ],
    description: 'テスト仕入', invoiceStatus: 'qualified', status: 'draft', decidedBy: 'rule',
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...overrides,
  }));
}

describe('ExportJournalEntriesUseCase', () => {
  it('正常: 汎用 CSV（BOM 付き・25 列）とファイル名・件数を返す', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'e1');

    const result = await usecase.execute({ scope, format: 'generic' });
    expect(result.format).toBe('generic');
    // ファイル名は出力日（now）から作る。
    expect(result.fileName).toBe('journal-2026-09-13.csv');
    expect(result.entryCount).toBe(1);
    expect(result.content.startsWith('﻿')).toBe(true);
    const lines = result.content.slice(1).split('\r\n');
    expect(lines[0]?.split(',')).toHaveLength(25);
    expect(lines[1]).toContain('消耗品費');
    expect(lines[1]).toContain('2026/09/10');
  });

  it('正常: 状態と期間で絞り込める', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'draft-entry');
    await addEntry(entries, 'confirmed-entry', { status: 'confirmed' });
    await addEntry(entries, 'old-entry', { date: '2026-08-01' });

    expect((await usecase.execute({ scope, format: 'generic', status: 'confirmed' })).entryCount).toBe(1);
    expect((await usecase.execute({ scope, format: 'generic', from: '2026-09-01' })).entryCount).toBe(2);
    expect((await usecase.execute({ scope, format: 'generic', to: '2026-08-31' })).entryCount).toBe(1);
  });

  it('境界: 対象が 0 件でもヘッダ行だけの CSV を返す（エラーにしない）', async () => {
    const { usecase } = await setup();
    const result = await usecase.execute({ scope, format: 'generic' });
    expect(result.entryCount).toBe(0);
    expect(result.content.slice(1).split('\r\n')[0]).toContain('entry_id');
    expect(result.content.slice(1).split('\r\n')[1]).toBe('');
  });

  it('正常: markExported は出力した仕訳を exported にする', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'e1');
    await addEntry(entries, 'e2', { status: 'confirmed' });

    await usecase.execute({ scope, format: 'generic', markExported: true });
    expect((await entries.findById(scope, 'e1'))?.status).toBe('exported');
    expect((await entries.findById(scope, 'e2'))?.status).toBe('exported');
  });

  it('境界: markExported は絞り込みの対象だけを動かす', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'in-range');
    await addEntry(entries, 'out-of-range', { date: '2026-08-01' });

    await usecase.execute({ scope, format: 'generic', from: '2026-09-01', markExported: true });
    expect((await entries.findById(scope, 'in-range'))?.status).toBe('exported');
    expect((await entries.findById(scope, 'out-of-range'))?.status).toBe('draft');
  });

  it('境界: 既定（markExported 省略）は状態を動かさない', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'e1');
    await usecase.execute({ scope, format: 'generic' });
    expect((await entries.findById(scope, 'e1'))?.status).toBe('draft');
  });

  it('正常: 弥生は Shift-JIS のバイト列を contentBase64 で返し、content は読める UTF-8 のまま', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'J2026-000123');

    const result = await usecase.execute({ scope, format: 'yayoi' });
    expect(result.format).toBe('yayoi');
    expect(result.fileName).toBe('journal-yayoi-2026-09-13.csv');
    expect(result.encoding).toBe('shift_jis');
    // ヘッダ行を持たず、識別フラグから始まる 25 列。
    expect(result.content.startsWith('2000,000123,,2026/09/10,消耗品費,')).toBe(true);
    expect(result.content.split('\r\n')[0]?.split(',')).toHaveLength(25);
    // base64 のバイト列は Shift-JIS。復号すると本文に戻る（会計ソフトはこれを読む）。
    const bytes = Buffer.from(result.contentBase64!, 'base64');
    expect(new TextDecoder('shift_jis').decode(bytes)).toBe(result.content);
    expect(bytes[0]).toBe(0x32);                                  // BOM を付けない（先頭は識別フラグの '2'）
    expect(bytes.length).toBeLessThan(Buffer.byteLength(result.content, 'utf8')); // 日本語が 2 バイトになっている
    expect(result.warnings).toEqual([]);
  });

  it('正常: freee / MF は UTF-8（BOM 付き）でバイト列を返さない', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'J2026-000123');

    const freee = await usecase.execute({ scope, format: 'freee' });
    expect(freee.encoding).toBe('utf-8');
    expect(freee.contentBase64).toBeUndefined();
    expect(freee.content.startsWith('﻿[表題行],日付,伝票番号')).toBe(true);
    expect(freee.content).toContain('[明細行],2026/09/10,000123,');

    const mf = await usecase.execute({ scope, format: 'mf' });
    expect(mf.encoding).toBe('utf-8');
    expect(mf.fileName).toBe('journal-mf-2026-09-13.csv');
    expect(mf.content.startsWith('﻿取引No,取引日,')).toBe(true);
    expect(mf.content).toContain('適格');
  });

  it('異常: 税区分に会計ソフトの対応名が無いと warnings に出す（黙って別の区分にしない）', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const charts = new InMemoryChartOfAccountsRepository();
    await charts.save(scope, { ...DEFAULT_CHART_OF_ACCOUNTS, taxCategories: DEFAULT_CHART_OF_ACCOUNTS.taxCategories.map((item) => (item.code === 'JP-IN-10-S' ? { ...item, mapping: {} } : item)) });
    const usecase = new ExportJournalEntriesUseCase(entries, charts, clock);
    await addEntry(entries, 'J2026-000123');

    const result = await usecase.execute({ scope, format: 'yayoi' });
    expect(result.warnings.some((warning) => warning.includes('JP-IN-10-S'))).toBe(true);
    expect(result.content).toContain('JP-IN-10-S');
  });

  it('異常: Shift-JIS にできない文字があれば警告する（黙って ? に化けさせない）', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'J2026-000123', { description: '絵文字 🍣 入りの摘要' });

    const result = await usecase.execute({ scope, format: 'yayoi' });
    expect(result.warnings.some((warning) => warning.includes('Shift-JIS') && warning.includes('🍣'))).toBe(true);
  });

  it('境界: 0 件のとき弥生は空（ヘッダ行が無い形式）、freee / MF はヘッダ行だけ', async () => {
    const { usecase } = await setup();
    const yayoi = await usecase.execute({ scope, format: 'yayoi' });
    expect(yayoi.entryCount).toBe(0);
    expect(yayoi.content).toBe('\r\n');
    expect((await usecase.execute({ scope, format: 'freee' })).content.split('\r\n')).toHaveLength(2);
    expect((await usecase.execute({ scope, format: 'mf' })).content.split('\r\n')).toHaveLength(2);
  });

  it('正常: generic の応答も encoding と warnings を持つ（画面が形式で分岐しない）', async () => {
    const { entries, usecase } = await setup();
    await addEntry(entries, 'e1');
    const result = await usecase.execute({ scope, format: 'generic' });
    expect(result.encoding).toBe('utf-8');
    expect(result.contentBase64).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('異常: 知らない形式は「未対応」ではなく「未知」として断る', async () => {
    const { usecase } = await setup();
    await expect(usecase.execute({ scope, format: 'nope' as never })).rejects.toThrow(JournalExportError);
    await expect(usecase.execute({ scope, format: 'nope' as never })).rejects.toThrow(/unknown format: nope/);
  });

  it('境界: マスタ未保存でも標準セットで科目名を解決して出力できる', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const usecase = new ExportJournalEntriesUseCase(entries, new InMemoryChartOfAccountsRepository(), clock);
    await addEntry(entries, 'e1');
    expect((await usecase.execute({ scope, format: 'generic' })).entryCount).toBe(1);
  });
});
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

  it('異常: 弥生 / freee / MF はまだ変換が無いので JournalExportError', async () => {
    const { usecase } = await setup();
    for (const format of ['yayoi', 'freee', 'mf'] as const) {
      await expect(usecase.execute({ scope, format })).rejects.toThrow(JournalExportError);
      await expect(usecase.execute({ scope, format })).rejects.toThrow(/not available yet/);
    }
  });

  it('異常: 知らない形式は「未対応」ではなく「未知」として断る', async () => {
    const { usecase } = await setup();
    await expect(usecase.execute({ scope, format: 'nope' as never })).rejects.toThrow(/unknown format: nope/);
  });

  it('境界: マスタ未保存でも標準セットで科目名を解決して出力できる', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const usecase = new ExportJournalEntriesUseCase(entries, new InMemoryChartOfAccountsRepository(), clock);
    await addEntry(entries, 'e1');
    expect((await usecase.execute({ scope, format: 'generic' })).entryCount).toBe(1);
  });
});
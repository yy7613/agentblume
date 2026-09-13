import { describe, expect, it } from 'vitest';
import { GENERIC_CSV_COLUMNS } from '../../domain/journal/export';
import {
  findJournalExportPreset, JOURNAL_EXPORT_FORMATS, JOURNAL_EXPORT_PRESETS, SUPPORTED_JOURNAL_EXPORT_FORMATS,
} from './export-presets';

describe('会計ソフト別の列写像（フェーズ 1 はデータのみ）', () => {
  it('正常: 弥生 / freee / MF の 3 つを持ち、形式の一覧と対応する', () => {
    expect(JOURNAL_EXPORT_PRESETS.map((preset) => preset.id)).toEqual(['yayoi', 'freee', 'mf']);
    // generic は domain の 25 列が正本なのでプリセットには含まれない。
    expect(JOURNAL_EXPORT_FORMATS).toEqual(['generic', 'yayoi', 'freee', 'mf']);
    for (const preset of JOURNAL_EXPORT_PRESETS) expect(JOURNAL_EXPORT_FORMATS).toContain(preset.id);
  });

  it('正常: フェーズ 1 で出せるのは generic だけ（変換はまだ書いていない）', () => {
    expect(SUPPORTED_JOURNAL_EXPORT_FORMATS).toEqual(['generic']);
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      expect(SUPPORTED_JOURNAL_EXPORT_FORMATS).not.toContain(preset.id);
    }
  });

  it('正常: どのプリセットも名前・列・文字コード・注記を持つ', () => {
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      expect(preset.name.trim().length, preset.id).toBeGreaterThan(0);
      expect(preset.note.trim().length, preset.id).toBeGreaterThan(0);
      expect(['utf-8', 'shift_jis']).toContain(preset.encoding);
      expect(preset.columns.length, preset.id).toBeGreaterThan(0);
    }
  });

  it('正常: 列名は空でなく、プリセット内で重複しない（取り込み側は並びで読む）', () => {
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      for (const column of preset.columns) expect(column.trim().length, `${preset.id}: ${column}`).toBeGreaterThan(0);
      expect(new Set(preset.columns).size, `${preset.id} の列名`).toBe(preset.columns.length);
    }
  });

  it('正常: 弥生は 25 項目（汎用 CSV が最大公約数に取った形式）', () => {
    const yayoi = findJournalExportPreset('yayoi');
    expect(yayoi?.columns).toHaveLength(25);
    expect(GENERIC_CSV_COLUMNS).toHaveLength(25);
    expect(yayoi?.encoding).toBe('shift_jis');
    expect(yayoi?.columns[0]).toBe('識別フラグ');
  });

  it('正常: 借方・貸方を持つ形式（弥生 / MF）は両側の科目・税区分・金額の列が揃っている', () => {
    for (const id of ['yayoi', 'mf'] as const) {
      const columns = findJournalExportPreset(id)!.columns;
      for (const side of ['借方', '貸方']) {
        expect(columns.some((column) => column.startsWith(`${side}勘定科目`)), `${id}: ${side}勘定科目`).toBe(true);
        expect(columns.some((column) => column.startsWith(`${side}税区分`)), `${id}: ${side}税区分`).toBe(true);
        expect(columns.some((column) => column.startsWith(`${side}金額`)), `${id}: ${side}金額`).toBe(true);
      }
    }
  });

  it('正常: freee は収支区分と勘定科目・税区分・金額を持つ（借方 / 貸方ではない形式）', () => {
    const freee = findJournalExportPreset('freee')!;
    expect(freee.columns).toEqual(expect.arrayContaining(['収支区分', '勘定科目', '税区分', '金額', '取引先']));
    expect(freee.encoding).toBe('utf-8');
  });

  it('境界: findJournalExportPreset は未知の id と generic に undefined を返す', () => {
    expect(findJournalExportPreset('nope')).toBeUndefined();
    expect(findJournalExportPreset('generic')).toBeUndefined();
    expect(findJournalExportPreset('')).toBeUndefined();
  });
});

describe('会計ソフト別の列写像（異常系・例外系）', () => {
  it('異常: 知らない形式 id を引くと undefined を返す（generic は正本なのでプリセットには無い）', () => {
    expect(findJournalExportPreset('unknown')).toBeUndefined();
    expect(findJournalExportPreset('generic')).toBeUndefined();
    expect(SUPPORTED_JOURNAL_EXPORT_FORMATS).toEqual(['generic']);
  });

  it('例外: 空文字や記号を渡しても throw しない', () => {
    expect(() => findJournalExportPreset('')).not.toThrow();
    expect(() => findJournalExportPreset('__proto__')).not.toThrow();
    expect(findJournalExportPreset('__proto__')).toBeUndefined();
  });

  it('例外: 列定義が壊れていない（空文字・重複が無く、各社の仕様どおりの列数）', () => {
    const expectedColumnCount: Readonly<Record<string, number>> = { yayoi: 25, freee: 20, mf: 27 };
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      expect(new Set(preset.columns).size, preset.id).toBe(preset.columns.length);
      for (const column of preset.columns) expect(column.trim(), preset.id).not.toBe('');
      expect(preset.columns.length, preset.id).toBe(expectedColumnCount[preset.id]);
      expect(['utf-8', 'shift_jis'], preset.id).toContain(preset.encoding);
    }
    // 汎用 25 列は domain 側が正本で、各社プリセットとは別物。
    expect(GENERIC_CSV_COLUMNS).toHaveLength(25);
  });
});

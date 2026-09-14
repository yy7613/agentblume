import { describe, expect, it } from 'vitest';
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalEntry, type JournalEntry, type JournalEntryLine } from '../../domain/journal/entry';
import { GENERIC_CSV_COLUMNS, genericCsvRows, type GenericCsvRow } from '../../domain/journal/export';
import {
  findJournalExportPreset, freeeCsvRows, groupRowsByEntry, JOURNAL_EXPORT_FORMATS, JOURNAL_EXPORT_PRESETS,
  mfCsvRows, slipNumberOf, SUPPORTED_JOURNAL_EXPORT_FORMATS, vendorCsvRows, VENDOR_MAX_ENTRY_LINES, yayoiCsvRows,
} from './export-presets';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = '2026-09-13T00:00:00.000Z';
const chart = DEFAULT_CHART_OF_ACCOUNTS;

function entry(id: string, lines: readonly JournalEntryLine[], overrides: Record<string, unknown> = {}): JournalEntry {
  return createJournalEntry({
    tenant: scope, id, documentId: 'doc-1', ruleId: 'rule-1', date: '2026-09-10', lines,
    description: '文具の購入', invoiceStatus: 'qualified', status: 'confirmed', decidedBy: 'rule',
    createdAt: NOW, updatedAt: NOW, ...overrides,
  });
}

const simpleLines: readonly JournalEntryLine[] = [
  { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 },
  { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
];

/** 借方 2 行 + 貸方 1 行の複合仕訳（3 行になる）。 */
const compoundLines: readonly JournalEntryLine[] = [
  { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100 },
  { side: 'debit', accountId: 'expense.books', accountName: '新聞図書費', taxCode: 'JP-IN-8R-S', amount: 540 },
  { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1640 },
];

function rowsOf(...entries: readonly JournalEntry[]): readonly GenericCsvRow[] {
  return entries.flatMap((item) => genericCsvRows(item, chart));
}

/** 汎用 25 列の生の行（決算整理仕訳など、いまの domain が作らない値を試すため）。 */
function rawRow(overrides: Partial<Record<(typeof GENERIC_CSV_COLUMNS)[number], string | number>>): GenericCsvRow {
  const base = Object.fromEntries(GENERIC_CSV_COLUMNS.map((column) => [column, ''])) as Record<string, string | number>;
  return { ...base, ...overrides } as GenericCsvRow;
}

describe('会計ソフト別の列写像（プリセットの定義）', () => {
  it('正常: 弥生 / freee / MF の 3 つを持ち、形式の一覧と対応する', () => {
    expect(JOURNAL_EXPORT_PRESETS.map((preset) => preset.id)).toEqual(['yayoi', 'freee', 'mf']);
    expect(JOURNAL_EXPORT_FORMATS).toEqual(['generic', 'yayoi', 'freee', 'mf']);
    for (const preset of JOURNAL_EXPORT_PRESETS) expect(JOURNAL_EXPORT_FORMATS).toContain(preset.id);
  });

  it('正常: フェーズ 3 で 4 形式すべて出力できる', () => {
    expect(SUPPORTED_JOURNAL_EXPORT_FORMATS).toEqual(['generic', 'yayoi', 'freee', 'mf']);
  });

  it('正常: 列数と先頭・末尾の並び（取り込み側は列名ではなく並びで読む）', () => {
    const yayoi = findJournalExportPreset('yayoi')!;
    expect(yayoi.columns).toHaveLength(25);
    expect(yayoi.columns[0]).toBe('識別フラグ');
    expect(yayoi.columns[24]).toBe('調整');
    expect(yayoi.encoding).toBe('shift_jis');
    expect(yayoi.header).toBe(false);

    const freee = findJournalExportPreset('freee')!;
    expect(freee.columns).toHaveLength(32);
    expect(freee.columns.slice(0, 3)).toEqual(['日付', '伝票番号', '決算整理仕訳']);
    expect(freee.columns[31]).toBe('摘要');
    expect(freee.encoding).toBe('utf-8');

    const mf = findJournalExportPreset('mf')!;
    expect(mf.columns).toHaveLength(27);
    expect(mf.columns.slice(0, 2)).toEqual(['取引No', '取引日']);
    expect(mf.columns[7]).toBe('借方インボイス');
    expect(mf.columns[15]).toBe('貸方インボイス');
    expect(mf.encoding).toBe('utf-8');
  });

  it('正常: 借方・貸方を持つ形式（弥生 / freee / MF）は両側の科目・税区分・金額の列が揃っている', () => {
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      for (const side of ['借方', '貸方']) {
        expect(preset.columns.some((column) => column.startsWith(`${side}勘定科目`)), `${preset.id}: ${side}勘定科目`).toBe(true);
        expect(preset.columns.some((column) => column.startsWith(`${side}税区分`)), `${preset.id}: ${side}税区分`).toBe(true);
        expect(preset.columns.some((column) => column.startsWith(`${side}金額`)), `${preset.id}: ${side}金額`).toBe(true);
      }
    }
  });

  it('境界: findJournalExportPreset は未知の id と generic に undefined を返す', () => {
    expect(findJournalExportPreset('nope')).toBeUndefined();
    expect(findJournalExportPreset('generic')).toBeUndefined();
    expect(findJournalExportPreset('')).toBeUndefined();
  });

  it('例外: 空文字や記号を渡しても throw しない', () => {
    expect(() => findJournalExportPreset('__proto__')).not.toThrow();
    expect(findJournalExportPreset('__proto__')).toBeUndefined();
  });

  it('[回帰固定] 例外: 列定義が壊れていない（空文字・重複が無い）', () => {
    for (const preset of JOURNAL_EXPORT_PRESETS) {
      expect(new Set(preset.columns).size, preset.id).toBe(preset.columns.length);
      for (const column of preset.columns) expect(column.trim(), preset.id).not.toBe('');
    }
    // 汎用 25 列は domain 側が正本で、各社プリセットとは別物。
    expect(GENERIC_CSV_COLUMNS).toHaveLength(25);
  });
});

describe('弥生 25 項目への写像', () => {
  it('正常: 単一仕訳は 1 行・識別フラグ 2000・25 列（ヘッダ行を出さない）', () => {
    const { rows, warnings } = yayoiCsvRows(rowsOf(entry('J2026-000123', simpleLines)), chart);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(25);
    expect(rows[0]![0]).toBe('2000');
    expect(rows[0]![1]).toBe('000123');       // 伝票No は entry_id の数字部 6 桁
    expect(rows[0]![2]).toBe('');             // 決算（closing_flag=0）
    expect(rows[0]![3]).toBe('2026/09/10');
    expect(rows[0]!.slice(4, 10)).toEqual(['消耗品費', '', '', '課対仕入込10%', '1100', '100']);
    expect(rows[0]!.slice(10, 16)).toEqual(['現金', '', '', '対象外', '1100', '']);
    expect(rows[0]![16]).toBe('文具の購入');
    expect(rows[0]![19]).toBe('0');           // タイプ
    expect(rows[0]![21]).toBe('rule=rule-1 doc=doc-1'); // 仕訳メモ
    expect(rows[0]![24]).toBe('no');          // 調整
    expect(warnings).toEqual([]);
  });

  it('正常: 3 行の複合仕訳は 2110 / 2100 / 2101 で束ね、科目の無い側は 対象外・0 にする', () => {
    const { rows } = yayoiCsvRows(rowsOf(entry('J2026-000200', compoundLines)), chart);
    expect(rows.map((row) => row[0])).toEqual(['2110', '2100', '2101']);
    expect(rows.map((row) => row[1])).toEqual(['000200', '000200', '000200']);
    // 借方行は貸方側が空 → 税区分 対象外・金額 0（弥生は空欄を受け付けない）。
    expect(rows[0]!.slice(10, 16)).toEqual(['', '', '', '対象外', '0', '0']);
    expect(rows[2]!.slice(4, 10)).toEqual(['', '', '', '対象外', '0', '0']);
    expect(rows[2]!.slice(10, 16)).toEqual(['現金', '', '', '対象外', '1640', '']);
  });

  it('境界: closing_flag=1 の行は決算に 本決 を入れる', () => {
    const { rows } = yayoiCsvRows([rawRow({ entry_id: 'J-000001', date: '2026/12/31', closing_flag: 1, debit_account: '減価償却費', debit_tax_code: 'JP-NA', debit_amount: 100, credit_account: '工具器具備品', credit_tax_code: 'JP-NA', credit_amount: 100 })], chart);
    expect(rows[0]![2]).toBe('本決');
  });

  it('異常: 摘要が 64 字を超えると切り詰め、切り詰めたことを警告する', () => {
    const long = 'あ'.repeat(70);
    const { rows, warnings } = yayoiCsvRows(rowsOf(entry('J-000001', simpleLines, { description: long })), chart);
    expect(rows[0]![16]).toHaveLength(64);
    expect(warnings.some((warning) => warning.includes('摘要') && warning.includes('64'))).toBe(true);
  });

  it('異常: entry_id に数字が無いと伝票No を空欄にして警告する（勝手に採番しない）', () => {
    const { rows, warnings } = yayoiCsvRows(rowsOf(entry('manual-entry', simpleLines)), chart);
    expect(rows[0]![1]).toBe('');
    expect(warnings.some((warning) => warning.includes('伝票番号'))).toBe(true);
  });

  it('異常: 税区分に弥生の対応名が無いと内部コードのまま出し、直し方を警告に書く', () => {
    const custom: ChartOfAccounts = { ...chart, taxCategories: [...chart.taxCategories, { code: 'JP-CUSTOM', name: '自作区分', side: 'in', enabled: true }] };
    const lines: readonly JournalEntryLine[] = [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-CUSTOM', amount: 100 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 100 },
    ];
    const { rows, warnings } = yayoiCsvRows(rowsOf(entry('J-000002', lines)), custom);
    expect(rows[0]![7]).toBe('JP-CUSTOM');
    expect(warnings.some((warning) => warning.includes('JP-CUSTOM') && warning.includes('弥生'))).toBe(true);
  });

  it('境界: 仕訳が 0 件なら行も 0（ヘッダ行が無い形式なので空の出力になる）', () => {
    expect(yayoiCsvRows([], chart)).toEqual({ rows: [], warnings: [] });
  });

  it('境界: 1 伝票の上限ちょうどは警告せず、超えると分けるよう警告する', () => {
    // domain の仕訳は 100 行までなので、上限超えは生の行（他所から来た汎用 CSV）で試す。
    const rowsFor = (count: number): readonly GenericCsvRow[] => Array.from({ length: count }, (_value, index) =>
      rawRow({ entry_id: 'J-000010', line_no: index + 1, date: '2026/09/10', debit_account: '現金', debit_tax_code: 'JP-NA', debit_amount: 1 }));
    expect(yayoiCsvRows(rowsFor(VENDOR_MAX_ENTRY_LINES), chart).warnings).toEqual([]);
    expect(yayoiCsvRows(rowsFor(VENDOR_MAX_ENTRY_LINES + 1), chart).warnings.some((warning) => warning.includes(String(VENDOR_MAX_ENTRY_LINES + 1)))).toBe(true);
  });
});

describe('freee 仕訳インポートへの写像', () => {
  it('正常: 1 行目は [表題行] + 列名、データ行は [明細行] で始まる', () => {
    const { rows } = freeeCsvRows(rowsOf(entry('J2026-000123', simpleLines)), chart);
    expect(rows[0]![0]).toBe('[表題行]');
    expect(rows[0]!.slice(1)).toEqual(findJournalExportPreset('freee')!.columns);
    expect(rows[0]).toHaveLength(33);
    expect(rows[1]![0]).toBe('[明細行]');
    expect(rows[1]).toHaveLength(33);
    expect(rows[1]![1]).toBe('2026/09/10');
    expect(rows[1]![2]).toBe('000123');   // 伝票番号
    expect(rows[1]![4]).toBe('消耗品費');
    expect(rows[1]![16]).toBe('課対仕入10%');  // 借方税区分（借方 14 列の 13 番目）
    expect(rows[1]![18]).toBe('現金');          // 貸方勘定科目
    expect(rows[1]![32]).toBe('文具の購入');   // 摘要
  });

  it('正常: 複合仕訳は同じ伝票番号で束ねる（1 仕訳 = 同一番号）', () => {
    const { rows } = freeeCsvRows(rowsOf(entry('J2026-000200', compoundLines), entry('J2026-000201', simpleLines)), chart);
    expect(rows.slice(1).map((row) => row[2])).toEqual(['000200', '000200', '000200', '000201']);
  });

  it('境界: 仕訳が 0 件でも [表題行] だけは出す', () => {
    const { rows, warnings } = freeeCsvRows([], chart);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('[表題行]');
    expect(warnings).toEqual([]);
  });

  it('異常: 摘要は 1,024 字まで。超えたら切り詰めて警告する', () => {
    const long = 'あ'.repeat(1100);
    const { rows, warnings } = freeeCsvRows(rowsOf(entry('J-000001', simpleLines, { description: long })), chart);
    expect(rows[1]![32]).toHaveLength(1024);
    expect(warnings.some((warning) => warning.includes('1024'))).toBe(true);
  });

  it('例外: 税区分の対応名が無くても throw せず、コードのまま出して警告する', () => {
    const custom: ChartOfAccounts = { ...chart, taxCategories: chart.taxCategories.map((item) => (item.code === 'JP-IN-10-S' ? { ...item, mapping: {} } : item)) };
    const { rows, warnings } = freeeCsvRows(rowsOf(entry('J-000003', simpleLines)), custom);
    expect(rows[1]![16]).toBe('JP-IN-10-S');
    expect(warnings.some((warning) => warning.includes('freee'))).toBe(true);
  });
});

describe('マネーフォワード 仕訳帳への写像', () => {
  it('正常: ヘッダ行 27 列、取引No で 1 仕訳を束ねる', () => {
    const { rows } = mfCsvRows(rowsOf(entry('J2026-000123', simpleLines)), chart);
    expect(rows[0]).toEqual(findJournalExportPreset('mf')!.columns);
    expect(rows[1]).toHaveLength(27);
    expect(rows[1]![0]).toBe('000123');
    expect(rows[1]![1]).toBe('2026/09/10');
    expect(rows[1]!.slice(2, 10)).toEqual(['消耗品費', '', '', '', '課税仕入 10%', '適格', '1100', '100']);
    expect(rows[1]![18]).toBe('文具の購入');
    expect(rows[1]![19]).toBe('rule=rule-1 doc=doc-1');
  });

  it('正常: インボイス列は区分ごとの表示名（経過措置は税区分の控除割合から）', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['qualified', 'JP-IN-10-S', '適格'],
      ['transitional', 'JP-IN-10-S-D80', '80％控除'],
      ['transitional', 'JP-IN-10-S-D70', '70％控除'],
      ['transitional', 'JP-IN-10-S-D50', '50％控除'],
      ['transitional', 'JP-IN-10-S-D30', '30％控除'],
      ['none', 'JP-IN-10-S-D0', '控除なし'],
      ['not_required', 'JP-IN-10-S', ''],
    ];
    for (const [invoiceStatus, taxCode, expected] of cases) {
      const lines: readonly JournalEntryLine[] = [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode, amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
      ];
      const { rows } = mfCsvRows(rowsOf(entry('J-000123', lines, { invoiceStatus })), chart);
      expect(rows[1]![7], `${invoiceStatus} / ${taxCode}`).toBe(expected);
    }
  });

  it('異常: 経過措置なのに税区分へ控除割合が無ければ空欄にし、設定先を警告に書く', () => {
    const lines: readonly JournalEntryLine[] = [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ];
    const { rows, warnings } = mfCsvRows(rowsOf(entry('J-000123', lines, { invoiceStatus: 'transitional' })), chart);
    expect(rows[1]![7]).toBe('');
    expect(warnings.some((warning) => warning.includes('控除割合'))).toBe(true);
  });

  it('境界: 科目の無い側は税区分もインボイスも空欄（弥生と違い 対象外 を入れない）', () => {
    const { rows } = mfCsvRows(rowsOf(entry('J-000200', compoundLines)), chart);
    expect(rows[1]!.slice(10, 18)).toEqual(['', '', '', '', '', '', '', '']);
  });

  it('例外: 仕訳が 0 件でもヘッダ行だけを返し、警告は空', () => {
    expect(mfCsvRows([], chart)).toEqual({ rows: [[...findJournalExportPreset('mf')!.columns]], warnings: [] });
  });
});

describe('共通のヘルパ', () => {
  it('正常: vendorCsvRows は形式ごとの組み立てへ振り分ける', () => {
    const rows = rowsOf(entry('J-000001', simpleLines));
    expect(vendorCsvRows('yayoi', rows, chart).rows[0]![0]).toBe('2000');
    expect(vendorCsvRows('freee', rows, chart).rows[0]![0]).toBe('[表題行]');
    expect(vendorCsvRows('mf', rows, chart).rows[0]![0]).toBe('取引No');
  });

  it('境界: slipNumberOf は数字部の末尾 6 桁（不足は 0 埋め、数字なしは空）', () => {
    expect(slipNumberOf('J2026-000123')).toBe('000123');
    expect(slipNumberOf('e12')).toBe('000012');
    expect(slipNumberOf('J-1234567')).toBe('234567');
    expect(slipNumberOf('manual')).toBe('');
    expect(slipNumberOf('')).toBe('');
  });

  it('境界: groupRowsByEntry は同じ entry_id の連続行を 1 組にする', () => {
    const rows = rowsOf(entry('J-000001', compoundLines), entry('J-000002', simpleLines));
    expect(groupRowsByEntry(rows).map((group) => group.length)).toEqual([3, 1]);
    expect(groupRowsByEntry([])).toEqual([]);
  });

  it('例外: 値の欠けた行を渡しても throw せず空欄で埋める', () => {
    const broken = rawRow({ entry_id: 'J-000009' });
    expect(() => yayoiCsvRows([broken], chart)).not.toThrow();
    expect(() => freeeCsvRows([broken], chart)).not.toThrow();
    expect(() => mfCsvRows([broken], chart)).not.toThrow();
    expect(yayoiCsvRows([broken], chart).rows[0]).toHaveLength(25);
  });
});

describe('MF インボイス列は課税仕入の行にだけ出す', () => {
  /** MF の借方インボイスは 8 列目、貸方インボイスは 16 列目。 */
  const DEBIT_INVOICE = 7;
  const CREDIT_INVOICE = 15;

  it('正常: 課税仕入の借方には区分を出し、対象外の貸方（現金・預金）は空欄にする', () => {
    // 仕入税額控除の区分なので、対象外の行に「適格」を出すと取り込んだ側で意味の無い区分が付く。
    const { rows } = mfCsvRows(genericCsvRows(entry('e1', simpleLines), chart), chart);
    const data = rows[1]!;

    expect(data[DEBIT_INVOICE]).toBe('適格');
    expect(data[CREDIT_INVOICE]).toBe('');
  });

  it('境界: 経過措置は借方だけに控除割合を出す', () => {
    const lines = [
      { side: 'debit', accountId: 'expense.outsourcing', accountName: '外注工賃', taxCode: 'JP-IN-10-S-D80', amount: 88000 },
      { side: 'credit', accountId: 'liability.other_payables', accountName: '未払金', taxCode: 'JP-NA', amount: 88000 },
    ] as const;
    const { rows } = mfCsvRows(genericCsvRows(entry('e2', lines, { invoiceStatus: 'transitional' }), chart), chart);
    const data = rows[1]!;

    expect(data[DEBIT_INVOICE]).toBe('80％控除');
    expect(data[CREDIT_INVOICE]).toBe('');
  });

  it('異常: 売上の税区分にはインボイス列を出さない（控除の話ではない）', () => {
    const lines = [
      { side: 'debit', accountId: 'asset.bank', accountName: '普通預金', taxCode: 'JP-NA', amount: 55000 },
      { side: 'credit', accountId: 'revenue.sales', accountName: '売上高', taxCode: 'JP-OUT-10-S', amount: 55000 },
    ] as const;
    const { rows } = mfCsvRows(genericCsvRows(entry('e3', lines), chart), chart);
    const data = rows[1]!;

    expect(data[DEBIT_INVOICE]).toBe('');
    expect(data[CREDIT_INVOICE]).toBe('');
  });
});

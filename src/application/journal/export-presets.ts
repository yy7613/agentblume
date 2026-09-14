/**
 * application層: 会計ソフトごとの仕訳インポート列と、汎用 25 列からの値の組み立て（docs/20 §8）。
 *
 * 汎用 25 列（`domain/journal/export.ts` の `GENERIC_CSV_COLUMNS`）が正本で、弥生 / freee / MF は
 * **その純粋な写像**として作る（平坦化のやり直しはしない。単一行 / 複合行の作り分けは domain が済ませてある）。
 *
 * 列名は各社の仕訳インポート仕様（docs/20 末尾の参考 URL）から写した表示名。
 * 会計ソフト側の取り込み画面は列名ではなく**並び**で読むものが多いので、順序を変えてはならない。
 *
 * 値を作れないとき（税区分に各社の対応名が無い・摘要が長すぎる・伝票番号にできる数字が無い・
 * 1 伝票の行数上限を超える）は**黙って埋めずに警告を積む**。会計ソフトの取込画面で初めて気づくのが一番高い。
 */
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import type { GenericCsvColumn, GenericCsvRow } from '../../domain/journal/export';

export const JOURNAL_EXPORT_FORMATS = ['generic', 'yayoi', 'freee', 'mf'] as const;
export type JournalExportFormat = (typeof JOURNAL_EXPORT_FORMATS)[number];

/** 実際に出力できる形式（フェーズ 3 で 4 形式すべて）。 */
export const SUPPORTED_JOURNAL_EXPORT_FORMATS: readonly JournalExportFormat[] = ['generic', 'yayoi', 'freee', 'mf'];

/** 会計ソフト側の税区分名を引くためのキー（`TaxCategory.mapping` の項目名）。 */
export type VendorId = Exclude<JournalExportFormat, 'generic'>;

export interface JournalExportPreset {
  readonly id: VendorId;
  readonly name: string;
  /** 取り込み側が期待する列の並び（先頭がヘッダ行の 1 列目）。 */
  readonly columns: readonly string[];
  /** 会計ソフトが期待する文字コード。 */
  readonly encoding: 'utf-8' | 'shift_jis';
  /** ヘッダ行を出すか（弥生は列名の行を持たない）。 */
  readonly header: boolean;
  readonly note: string;
}

/** 弥生会計「仕訳データ（25 項目）」。ヘッダ行は無い。 */
const YAYOI_COLUMNS: readonly string[] = [
  '識別フラグ', '伝票No', '決算', '取引日付',
  '借方勘定科目', '借方補助科目', '借方部門', '借方税区分', '借方金額', '借方税金額',
  '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方税区分', '貸方金額', '貸方税金額',
  '摘要', '番号', '期日', 'タイプ', '生成元', '仕訳メモ', '付箋1', '付箋2', '調整',
];

/**
 * freee「他社会計ソフト仕訳のインポート（freee 形式）」の列（調査メモ §4.3）。
 * 1 行目に `[表題行]`、データ行の先頭に `[明細行]` を置く（列名の並びには含めない）。
 */
const FREEE_COLUMNS: readonly string[] = [
  '日付', '伝票番号', '決算整理仕訳',
  '借方勘定科目', '借方科目コード', '借方補助科目', '借方取引先', '借方取引先コード', '借方部門', '借方品目', '借方メモタグ',
  '借方セグメント1', '借方セグメント2', '借方セグメント3', '借方金額', '借方税区分', '借方税額',
  '貸方勘定科目', '貸方科目コード', '貸方補助科目', '貸方取引先', '貸方取引先コード', '貸方部門', '貸方品目', '貸方メモタグ',
  '貸方セグメント1', '貸方セグメント2', '貸方セグメント3', '貸方金額', '貸方税区分', '貸方税額',
  '摘要',
];

/** マネーフォワード クラウド会計「仕訳帳」インポートの列。 */
const MF_COLUMNS: readonly string[] = [
  '取引No', '取引日',
  '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額',
  '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額',
  '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者',
];

export const JOURNAL_EXPORT_PRESETS: readonly JournalExportPreset[] = [
  { id: 'yayoi', name: '弥生会計（仕訳データ 25 項目）', columns: YAYOI_COLUMNS, encoding: 'shift_jis', header: false, note: 'ヘッダ行を持たず、1 行 = 1 仕訳行。単一行は識別フラグ 2000、複合仕訳は 2110 / 2100 / 2101 で束ねる。' },
  { id: 'freee', name: 'freee 会計（仕訳インポート）', columns: FREEE_COLUMNS, encoding: 'utf-8', header: true, note: '1 行目は [表題行]、データ行は [明細行] で始まる。複合仕訳は伝票番号で束ねる。' },
  { id: 'mf', name: 'マネーフォワード クラウド会計（仕訳帳）', columns: MF_COLUMNS, encoding: 'utf-8', header: true, note: '取引No が同じ行が 1 仕訳。インボイス列は 適格 / 80％控除 …/ 控除なし。' },
];

/** id でプリセットを引く。 */
export function findJournalExportPreset(id: string): JournalExportPreset | undefined {
  return JOURNAL_EXPORT_PRESETS.find((preset) => preset.id === id);
}

/* 値の組み立て ------------------------------------------------------------- */

/** 会計ソフト 1 社ぶんの出力（行 × 列と、値を作れなかったことの警告）。 */
export interface VendorCsvRows {
  /** ヘッダ行を含む、そのまま CSV にできる行。 */
  readonly rows: readonly (readonly string[])[];
  readonly warnings: readonly string[];
}

/** 摘要の上限（弥生 64 字 / freee 1,024 字）。 */
export const YAYOI_DESCRIPTION_LIMIT = 64;
export const FREEE_DESCRIPTION_LIMIT = 1024;
/** 仕訳メモの上限（弥生 180 字）。 */
const YAYOI_MEMO_LIMIT = 180;
/** 1 仕訳（伝票）に束ねられる行数の上限（弥生の振替伝票がもっとも厳しい）。 */
export const VENDOR_MAX_ENTRY_LINES = 100;

/** freee の行頭マーカー。 */
export const FREEE_HEADER_MARKER = '[表題行]';
export const FREEE_LINE_MARKER = '[明細行]';

/** 順序を保ったまま重複を落とす警告の入れ物。 */
class WarningBag {
  private readonly seen = new Set<string>();
  add(message: string): void { this.seen.add(message); }
  list(): readonly string[] { return [...this.seen]; }
}

function cell(row: GenericCsvRow, column: GenericCsvColumn): string {
  const value = row[column];
  return value === undefined || value === null ? '' : String(value);
}

/** 同じ `entry_id` の連続した行を 1 仕訳に束ねる（domain が仕訳ごとに行を並べている前提）。 */
export function groupRowsByEntry(rows: readonly GenericCsvRow[]): readonly (readonly GenericCsvRow[])[] {
  const groups: GenericCsvRow[][] = [];
  let currentId: string | undefined;
  for (const row of rows) {
    const id = cell(row, 'entry_id');
    if (currentId === undefined || id !== currentId || groups.length === 0) groups.push([row]);
    else groups[groups.length - 1]!.push(row);
    currentId = id;
  }
  return groups;
}

/** 摘要などを上限で切り詰める。切り詰めたら警告（末尾が欠けたことを黙らせない）。 */
function truncate(text: string, limit: number, label: string, entryId: string, warnings: WarningBag): string {
  if (text.length <= limit) return text;
  warnings.add(`仕訳 ${entryId} の${label}が ${limit} 文字を超えたため末尾を切り詰めました（${text.length} 文字）。会計ソフトへは切り詰めた文字列が入ります。`);
  return text.slice(0, limit);
}

/** `entry_id` の数字部（末尾 6 桁）。数字が無ければ空文字。 */
export function slipNumberOf(entryId: string): string {
  const digits = (entryId.match(/\d/gu) ?? []).join('');
  if (digits === '') return '';
  return digits.length <= 6 ? digits.padStart(6, '0') : digits.slice(-6);
}

function slipNumber(entryId: string, vendorLabel: string, warnings: WarningBag): string {
  const number = slipNumberOf(entryId);
  if (number === '') warnings.add(`仕訳 ${entryId} に数字が無いため ${vendorLabel} の伝票番号を空欄にしました。仕訳 id に連番を含めるか、会計ソフト側で採番してください。`);
  return number;
}

const VENDOR_LABEL: Readonly<Record<VendorId, string>> = { yayoi: '弥生', freee: 'freee', mf: 'マネーフォワード' };

/** 税区分の会計ソフト表示名。マッピングが無ければ内部コードのまま出し、警告する（勝手に別の区分にしない）。 */
function vendorTaxName(chart: ChartOfAccounts, code: string, vendor: VendorId, warnings: WarningBag): string {
  if (code === '') return '';
  const category = chart.taxCategories.find((item) => item.code === code);
  const name = category?.mapping?.[vendor];
  if (name !== undefined && name.trim() !== '') return name;
  warnings.add(`税区分 ${code} に${VENDOR_LABEL[vendor]}の対応名が無いため、内部コードのまま出力しました。「科目」タブの税区分でマッピングを設定してください。`);
  return code;
}

/** 1 仕訳の行数が多すぎないか（会計ソフト側で 1 伝票に収まらない）。 */
function checkGroupSize(group: readonly GenericCsvRow[], entryId: string, vendor: VendorId, warnings: WarningBag): void {
  if (group.length > VENDOR_MAX_ENTRY_LINES) {
    warnings.add(`仕訳 ${entryId} は ${group.length} 行あり、${VENDOR_LABEL[vendor]}が 1 伝票に束ねられる ${VENDOR_MAX_ENTRY_LINES} 行を超えます。仕訳を分けてから出力してください。`);
  }
}

function memoOf(row: GenericCsvRow): string {
  const parts: string[] = [];
  const rule = cell(row, 'rule_id');
  const document = cell(row, 'source_document_id');
  if (rule !== '') parts.push(`rule=${rule}`);
  if (document !== '') parts.push(`doc=${document}`);
  return parts.join(' ');
}

function isClosing(row: GenericCsvRow): boolean {
  return cell(row, 'closing_flag') === '1';
}

/**
 * 弥生会計 25 項目。ヘッダ行なし。
 * 識別フラグは単一行 `2000`、複合仕訳は先頭 `2110` / 中間 `2100` / 末尾 `2101`。
 * 科目の無い側は税区分 `対象外`・金額 `0`（弥生は空欄を受け付けない）。
 */
export function yayoiCsvRows(rows: readonly GenericCsvRow[], chart: ChartOfAccounts): VendorCsvRows {
  const warnings = new WarningBag();
  const out: string[][] = [];
  for (const group of groupRowsByEntry(rows)) {
    const entryId = cell(group[0]!, 'entry_id');
    checkGroupSize(group, entryId, 'yayoi', warnings);
    const number = slipNumber(entryId, '弥生', warnings);
    group.forEach((row, index) => {
      const flag = group.length === 1 ? '2000' : index === 0 ? '2110' : index === group.length - 1 ? '2101' : '2100';
      const side = (prefix: 'debit' | 'credit') => {
        const account = cell(row, `${prefix}_account` as GenericCsvColumn);
        const empty = account === '';
        return [
          account,
          cell(row, `${prefix}_sub_account` as GenericCsvColumn),
          cell(row, `${prefix}_department` as GenericCsvColumn),
          empty ? '対象外' : vendorTaxName(chart, cell(row, `${prefix}_tax_code` as GenericCsvColumn), 'yayoi', warnings),
          empty ? '0' : cell(row, `${prefix}_amount` as GenericCsvColumn),
          empty ? '0' : cell(row, `${prefix}_tax_amount` as GenericCsvColumn),
        ];
      };
      out.push([
        flag, number, isClosing(row) ? '本決' : '', cell(row, 'date'),
        ...side('debit'),
        ...side('credit'),
        truncate(cell(row, 'description'), YAYOI_DESCRIPTION_LIMIT, '摘要', entryId, warnings),
        '', '', '0', '',
        truncate(memoOf(row), YAYOI_MEMO_LIMIT, '仕訳メモ', entryId, warnings),
        '', '', 'no',
      ]);
    });
  }
  return { rows: out, warnings: warnings.list() };
}

/**
 * freee 仕訳インポート。1 行目 `[表題行]` + 列名、データ行は `[明細行]` で始まる。
 * 複合仕訳は伝票番号（`entry_id` の数字部）で束ねる。
 */
export function freeeCsvRows(rows: readonly GenericCsvRow[], chart: ChartOfAccounts): VendorCsvRows {
  const warnings = new WarningBag();
  const out: string[][] = [[FREEE_HEADER_MARKER, ...FREEE_COLUMNS]];
  for (const group of groupRowsByEntry(rows)) {
    const entryId = cell(group[0]!, 'entry_id');
    checkGroupSize(group, entryId, 'freee', warnings);
    const number = slipNumber(entryId, 'freee', warnings);
    for (const row of group) {
      const side = (prefix: 'debit' | 'credit') => {
        const account = cell(row, `${prefix}_account` as GenericCsvColumn);
        const empty = account === '';
        return [
          account, '',
          cell(row, `${prefix}_sub_account` as GenericCsvColumn),
          cell(row, `${prefix}_partner` as GenericCsvColumn), '',
          cell(row, `${prefix}_department` as GenericCsvColumn),
          empty ? '' : cell(row, 'item'),
          empty ? '' : cell(row, 'tags'),
          '', '', '',
          cell(row, `${prefix}_amount` as GenericCsvColumn),
          empty ? '' : vendorTaxName(chart, cell(row, `${prefix}_tax_code` as GenericCsvColumn), 'freee', warnings),
          cell(row, `${prefix}_tax_amount` as GenericCsvColumn),
        ];
      };
      out.push([
        FREEE_LINE_MARKER, cell(row, 'date'), number, isClosing(row) ? '1' : '',
        ...side('debit'),
        ...side('credit'),
        truncate(cell(row, 'description'), FREEE_DESCRIPTION_LIMIT, '摘要', entryId, warnings),
      ]);
    }
  }
  return { rows: out, warnings: warnings.list() };
}

/** MF のインボイス列（借方 / 貸方それぞれ）。 */
const MF_DEDUCTION_LABELS: Readonly<Record<string, string>> = { '0.8': '80％控除', '0.7': '70％控除', '0.5': '50％控除', '0.3': '30％控除' };

/**
 * インボイス区分 → MF の表示名。
 * `qualified` → `適格`、`transitional` → 税区分の控除割合（`80％控除` 等）、`none` → `控除なし`、`not_required` → 空欄。
 */
function mfInvoiceLabel(chart: ChartOfAccounts, invoiceStatus: string, taxCode: string, entryId: string, warnings: WarningBag): string {
  // インボイス列は「仕入税額控除をどれだけ受けられるか」の区分なので、課税仕入の行にだけ出す。
  // 対象外・非課税の行や貸方（預金など）に「適格」を出すと、取り込んだ側に意味の無い区分が付く。
  const category = chart.taxCategories.find((item) => item.code === taxCode);
  if (category === undefined || category.side !== 'in' || (category.rate ?? 0) <= 0) return '';
  if (invoiceStatus === 'qualified') return '適格';
  if (invoiceStatus === 'none') return '控除なし';
  if (invoiceStatus === 'not_required' || invoiceStatus === '') return '';
  if (invoiceStatus !== 'transitional') {
    warnings.add(`仕訳 ${entryId} のインボイス区分 ${invoiceStatus} はマネーフォワードの区分に対応しないため、インボイス列を空欄にしました。`);
    return '';
  }
  const rate = category.deductionRate;
  const label = rate === undefined ? undefined : MF_DEDUCTION_LABELS[String(rate)];
  if (label === undefined) {
    warnings.add(`仕訳 ${entryId} は経過措置ですが、税区分 ${taxCode} に控除割合（80% / 70% / 50% / 30%）が無いためインボイス列を空欄にしました。「科目」タブの税区分で控除割合を設定してください。`);
    return '';
  }
  return label;
}

/** マネーフォワード クラウド会計 仕訳帳。ヘッダ行あり。取引No が同じ行が 1 仕訳。 */
export function mfCsvRows(rows: readonly GenericCsvRow[], chart: ChartOfAccounts): VendorCsvRows {
  const warnings = new WarningBag();
  const out: string[][] = [[...MF_COLUMNS]];
  for (const group of groupRowsByEntry(rows)) {
    const entryId = cell(group[0]!, 'entry_id');
    checkGroupSize(group, entryId, 'mf', warnings);
    const number = slipNumber(entryId, 'マネーフォワード', warnings);
    for (const row of group) {
      const side = (prefix: 'debit' | 'credit') => {
        const account = cell(row, `${prefix}_account` as GenericCsvColumn);
        const empty = account === '';
        const taxCode = cell(row, `${prefix}_tax_code` as GenericCsvColumn);
        return [
          account,
          cell(row, `${prefix}_sub_account` as GenericCsvColumn),
          cell(row, `${prefix}_department` as GenericCsvColumn),
          cell(row, `${prefix}_partner` as GenericCsvColumn),
          empty ? '' : vendorTaxName(chart, taxCode, 'mf', warnings),
          empty ? '' : mfInvoiceLabel(chart, cell(row, 'invoice_status'), taxCode, entryId, warnings),
          cell(row, `${prefix}_amount` as GenericCsvColumn),
          cell(row, `${prefix}_tax_amount` as GenericCsvColumn),
        ];
      };
      out.push([
        number, cell(row, 'date'),
        ...side('debit'),
        ...side('credit'),
        cell(row, 'description'), memoOf(row), cell(row, 'tags'), '', isClosing(row) ? '1' : '',
        '', '', '', '',
      ]);
    }
  }
  return { rows: out, warnings: warnings.list() };
}

/** 形式 → 行の組み立て（`generic` はここでは扱わない。domain の `exportGenericCsv` が正本）。 */
export function vendorCsvRows(format: VendorId, rows: readonly GenericCsvRow[], chart: ChartOfAccounts): VendorCsvRows {
  if (format === 'yayoi') return yayoiCsvRows(rows, chart);
  if (format === 'freee') return freeeCsvRows(rows, chart);
  return mfCsvRows(rows, chart);
}

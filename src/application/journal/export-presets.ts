/**
 * application層: 会計ソフトごとの仕訳インポート列（データのみ。docs/20 §8）。
 *
 * 汎用 25 列（`domain/journal/export.ts` の `GENERIC_CSV_COLUMNS`）が正本で、弥生 / freee / MF は
 * **その写像**として後から足せるようにする。フェーズ 1 では列の並びだけを持ち、変換ロジックは書かない
 * （`ExportJournalEntriesUseCase` は `generic` 以外を `JournalExportError` で断る）。フェーズ 3 で
 * `columns` に対応する値の組み立てを足すと `format` を増やすだけで済む。
 *
 * 列名は各社の仕訳インポート仕様（docs/20 末尾の参考 URL）から写した表示名。
 * 会計ソフト側の取り込み画面は列名ではなく**並び**で読むものが多いので、順序を変えてはならない。
 */

export const JOURNAL_EXPORT_FORMATS = ['generic', 'yayoi', 'freee', 'mf'] as const;
export type JournalExportFormat = (typeof JOURNAL_EXPORT_FORMATS)[number];

/** フェーズ 1 で実際に出力できる形式。 */
export const SUPPORTED_JOURNAL_EXPORT_FORMATS: readonly JournalExportFormat[] = ['generic'];

export interface JournalExportPreset {
  readonly id: Exclude<JournalExportFormat, 'generic'>;
  readonly name: string;
  /** 取り込み側が期待する列の並び（先頭がヘッダ行の 1 列目）。 */
  readonly columns: readonly string[];
  /** 会計ソフトが期待する文字コード（フェーズ 3 で書き出しに使う）。 */
  readonly encoding: 'utf-8' | 'shift_jis';
  readonly note: string;
}

/** 弥生会計「仕訳日記帳」インポートの 25 項目。 */
const YAYOI_COLUMNS: readonly string[] = [
  '識別フラグ', '伝票No', '決算', '取引日付',
  '借方勘定科目', '借方補助科目', '借方部門', '借方税区分', '借方金額', '借方税金額',
  '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方税区分', '貸方金額', '貸方税金額',
  '摘要', '番号', '期日', 'タイプ', '生成元', '仕訳メモ', '付箋1', '付箋2', '調整',
];

/** freee「仕訳インポート」の列。 */
const FREEE_COLUMNS: readonly string[] = [
  '収支区分', '管理番号', '発生日', '決済期日', '取引先', '勘定科目', '税区分', '金額', '税計算区分', '税額',
  '備考', '品目', '部門', 'メモタグ', 'セグメント1', 'セグメント2', 'セグメント3', '決済日', '決済口座', '決済金額',
];

/** マネーフォワード クラウド会計「仕訳帳」インポートの列。 */
const MF_COLUMNS: readonly string[] = [
  '取引No', '取引日',
  '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額',
  '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額',
  '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者',
];

export const JOURNAL_EXPORT_PRESETS: readonly JournalExportPreset[] = [
  { id: 'yayoi', name: '弥生会計（仕訳日記帳）', columns: YAYOI_COLUMNS, encoding: 'shift_jis', note: 'ヘッダ行を持たず、1 行 = 1 仕訳行。複合仕訳は識別フラグ 2000 で束ねる。' },
  { id: 'freee', name: 'freee 会計（仕訳インポート）', columns: FREEE_COLUMNS, encoding: 'utf-8', note: '収支区分は 収入 / 支出。複合仕訳は管理番号で束ねる。' },
  { id: 'mf', name: 'マネーフォワード クラウド会計（仕訳帳）', columns: MF_COLUMNS, encoding: 'utf-8', note: '取引No が同じ行が 1 仕訳。インボイス列は適格 / 区分記載などの区分。' },
];

/** id でプリセットを引く。 */
export function findJournalExportPreset(id: string): JournalExportPreset | undefined {
  return JOURNAL_EXPORT_PRESETS.find((preset) => preset.id === id);
}
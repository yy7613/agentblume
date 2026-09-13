/**
 * ドメイン: 銀行 / カード明細 CSV のプリセット（docs/20 §6）。
 *
 * 列名署名でプリセットを自動判定し、1 行を 1 文書（`bank_statement` / `card_statement`）の facts へ正規化する。
 * 署名に無い列（楽天カードの追加列など）は無視し、`source.row` に生値を残す。未知の列構成は
 * 列マッピング（`ColumnMapping`）で取り込む。全銀協固定長は対象外。
 */
import type { CreateJournalDocumentProps, DocumentFacts, DocumentKind, PaymentMethod } from './document';
import { JournalCsvImportError } from './errors';
import { counterpartyFromDescription, normalizeDescription, parseAmount, parseJapaneseDate } from './normalize';

export const JOURNAL_CSV_PRESET_IDS = ['generic', 'rakuten-bank', 'mufg', 'smbc', 'yucho', 'rakuten-card'] as const;
export type JournalCsvPresetId = (typeof JOURNAL_CSV_PRESET_IDS)[number];

/** UI に返す形（`JournalCsvPresetDto` と同型）。 */
export interface JournalCsvPresetInfo {
  readonly id: JournalCsvPresetId;
  readonly name: string;
  readonly description: string;
  readonly headerSignature: readonly string[];
  readonly kind: 'bank_statement' | 'card_statement' | 'generic';
}

/** 未知の列構成向けの列マッピング（列名で指定）。`amount` は符号付き 1 列（負 = 出金）。 */
export interface ColumnMapping {
  readonly date: string;
  readonly description: string;
  readonly withdrawal?: string;
  readonly deposit?: string;
  readonly amount?: string;
  readonly balance?: string;
  readonly detail?: string;
}

export interface RowToDocumentOptions {
  readonly accountHint?: string;
  readonly fileName?: string;
}

/** `rowToDocument` の結果（保存ユースケースの入力。tenant / 時刻は呼び出し側が足す）。 */
export type JournalDocumentInput = Pick<CreateJournalDocumentProps, 'kind' | 'source' | 'facts' | 'extraction'>;

interface RowFacts {
  readonly date: string | undefined;
  readonly description: string;
  readonly withdrawal: number | undefined;
  readonly deposit: number | undefined;
  readonly balance?: number | undefined;
}

interface PresetDefinition extends JournalCsvPresetInfo {
  /** 署名のうち無くてもよい列。 */
  readonly optionalColumns?: readonly string[];
  readonly documentKind: DocumentKind;
  readonly paymentMethod?: PaymentMethod;
  read(row: Readonly<Record<string, string>>): RowFacts;
}

/** 列名は正規化した形で引く（生の列名でも引ける）。 */
const cell = (row: Readonly<Record<string, string>>, column: string): string => (row[normalizeHeader(column)] ?? row[column] ?? '').trim();
const money = (row: Readonly<Record<string, string>>, column: string): number | undefined => {
  const raw = cell(row, column);
  return raw === '' ? undefined : parseAmount(raw);
};

const PRESETS: readonly PresetDefinition[] = [
  {
    id: 'generic', name: '汎用（日付,摘要,出金,入金,残高）', description: '「日付,摘要,出金,入金[,残高]」の 5 列（残高は省略可）。',
    headerSignature: ['日付', '摘要', '出金', '入金', '残高'], optionalColumns: ['残高'], kind: 'generic', documentKind: 'bank_statement',
    read: (row) => ({ date: parseJapaneseDate(cell(row, '日付')), description: cell(row, '摘要'), withdrawal: money(row, '出金'), deposit: money(row, '入金'), balance: money(row, '残高') }),
  },
  {
    id: 'rakuten-bank', name: '楽天銀行', description: '「取引日,入出金(円),残高(円),入出金先内容」。入出金は符号付き 1 列（負 = 出金）。',
    headerSignature: ['取引日', '入出金(円)', '残高(円)', '入出金先内容'], kind: 'bank_statement', documentKind: 'bank_statement',
    read: (row) => {
      const amount = money(row, '入出金(円)');
      return { date: parseJapaneseDate(cell(row, '取引日')), description: cell(row, '入出金先内容'), withdrawal: amount !== undefined && amount < 0 ? -amount : undefined, deposit: amount !== undefined && amount >= 0 ? amount : undefined, balance: money(row, '残高(円)') };
    },
  },
  {
    id: 'mufg', name: '三菱UFJ銀行', description: '「日付,摘要,摘要内容,支払い金額,預かり金額,差引残高,メモ,未資金化区分,入払区分」。',
    headerSignature: ['日付', '摘要', '摘要内容', '支払い金額', '預かり金額', '差引残高', 'メモ', '未資金化区分', '入払区分'], kind: 'bank_statement', documentKind: 'bank_statement',
    read: (row) => ({ date: parseJapaneseDate(cell(row, '日付')), description: [cell(row, '摘要'), cell(row, '摘要内容')].filter((part) => part.length > 0).join(' '), withdrawal: money(row, '支払い金額'), deposit: money(row, '預かり金額'), balance: money(row, '差引残高') }),
  },
  {
    id: 'smbc', name: '三井住友銀行', description: '「お取引日,お引出し,お預入れ,お取り扱い内容,残高,メモ,ラベル」。',
    headerSignature: ['お取引日', 'お引出し', 'お預入れ', 'お取り扱い内容', '残高', 'メモ', 'ラベル'], kind: 'bank_statement', documentKind: 'bank_statement',
    read: (row) => ({ date: parseJapaneseDate(cell(row, 'お取引日')), description: cell(row, 'お取り扱い内容'), withdrawal: money(row, 'お引出し'), deposit: money(row, 'お預入れ'), balance: money(row, '残高') }),
  },
  {
    id: 'yucho', name: 'ゆうちょ銀行', description: '「日付,入出金明細ID,詳細1,詳細2,払出し金額,預入れ金額,貸付金額,返済金額,残高,取扱店,取扱店名,メモ」。',
    headerSignature: ['日付', '入出金明細ID', '詳細1', '詳細2', '払出し金額', '預入れ金額', '貸付金額', '返済金額', '残高', '取扱店', '取扱店名', 'メモ'], kind: 'bank_statement', documentKind: 'bank_statement',
    read: (row) => ({ date: parseJapaneseDate(cell(row, '日付')), description: [cell(row, '詳細1'), cell(row, '詳細2')].filter((part) => part.length > 0).join(' '), withdrawal: money(row, '払出し金額') ?? money(row, '返済金額'), deposit: money(row, '預入れ金額') ?? money(row, '貸付金額'), balance: money(row, '残高') }),
  },
  {
    id: 'rakuten-card', name: '楽天カード', description: '「利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額」+ 追加列。全行が支出（クレジットカード）。',
    headerSignature: ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '支払手数料', '支払総額'], kind: 'card_statement', documentKind: 'card_statement', paymentMethod: 'credit_card',
    read: (row) => ({ date: parseJapaneseDate(cell(row, '利用日')), description: cell(row, '利用店名・商品名'), withdrawal: money(row, '利用金額'), deposit: undefined }),
  },
];

/** UI に見せるプリセット一覧。 */
export const JOURNAL_CSV_PRESETS: readonly JournalCsvPresetInfo[] = PRESETS.map(({ id, name, description, headerSignature, kind }) => ({ id, name, description, headerSignature, kind }));

/** 列名の正規化（BOM・空白を落とし NFKC）。署名の比較と行の読み取りで同じ形にする。 */
export function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/u, '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

function normalizeRow(row: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) normalized[normalizeHeader(key)] = value;
  return normalized;
}

function signatureMatches(preset: PresetDefinition, headers: ReadonlySet<string>): boolean {
  const optional = new Set((preset.optionalColumns ?? []).map(normalizeHeader));
  return preset.headerSignature.every((column) => optional.has(normalizeHeader(column)) || headers.has(normalizeHeader(column)));
}

/** ヘッダ行からプリセットを判定する。署名の必須列がすべて含まれる最初のプリセット（順序は問わない）。 */
export function detectPreset(headers: readonly string[]): JournalCsvPresetId | undefined {
  const normalized = new Set(headers.map(normalizeHeader));
  // 汎用は列名が短く他と重なりにくいが、念のため専用プリセットを先に見る。
  const ordered = [...PRESETS.filter((preset) => preset.id !== 'generic'), ...PRESETS.filter((preset) => preset.id === 'generic')];
  return ordered.find((preset) => signatureMatches(preset, normalized))?.id;
}

/** 摘要から支払手段を推定する（best-effort）。 */
export function paymentMethodFromDescription(description: string): PaymentMethod {
  const text = description.normalize('NFKC');
  // 銀行 CSV の摘要は半角カナのことが多い（NFKC で全角カナになる）。漢字とカナの両表記を見る。
  if (/ATM|現金|引出|ヒキダシ/iu.test(text)) return 'cash';
  if (/口座振替|自動振替|自動払込|自動引落|引落|自振|振替|コウザフリカエ|ジドウハライコミ|ジドウフリカエ|ヒキオトシ/u.test(text)) return 'direct_debit';
  if (/カード|クレジット|CARD|VISA|MASTER|JCB|AMEX/iu.test(text)) return 'credit_card';
  if (/振込|振り込み|送金|給与|給料|フリコミ|ソウキン|キュウヨ|キユウヨ/u.test(text)) return 'bank_transfer';
  if (/PAYPAY|ペイペイ|楽天ペイ|D払い|AUPAY|メルペイ|LINEPAY/iu.test(text)) return 'qr';
  if (/SUICA|PASMO|ICOCA|NANACO|WAON|EDY/iu.test(text)) return 'e_money';
  return 'unknown';
}

function toDocument(kind: DocumentKind, presetId: string | undefined, paymentMethod: PaymentMethod | undefined, row: Readonly<Record<string, string>>, facts: RowFacts, options: RowToDocumentOptions, rowNumber?: number): JournalDocumentInput {
  if (facts.date === undefined) throw new JournalCsvImportError(`CSV row ${rowNumber ?? '?'}: date is missing or unreadable`, rowNumber);
  if (facts.withdrawal === undefined && facts.deposit === undefined) throw new JournalCsvImportError(`CSV row ${rowNumber ?? '?'}: amount is missing or unreadable`, rowNumber);
  const withdrawal = facts.withdrawal ?? 0;
  const deposit = facts.deposit ?? 0;
  const direction = withdrawal > 0 && deposit === 0 ? 'out' : deposit > 0 && withdrawal === 0 ? 'in' : withdrawal >= deposit ? 'out' : 'in';
  const grandTotal = direction === 'out' ? withdrawal - deposit : deposit - withdrawal;
  if (grandTotal <= 0) throw new JournalCsvImportError(`CSV row ${rowNumber ?? '?'}: amount must be positive`, rowNumber);
  const descriptionNorm = normalizeDescription(facts.description);
  const counterpartyHint = counterpartyFromDescription(descriptionNorm);
  const normalizedFacts: DocumentFacts = {
    direction,
    transactionDate: facts.date,
    grandTotal,
    paymentMethod: paymentMethod ?? paymentMethodFromDescription(facts.description),
    ...(options.accountHint === undefined || options.accountHint.trim() === '' ? {} : { accountHint: options.accountHint.trim() }),
    description: facts.description,
    descriptionNorm,
    ...(counterpartyHint === undefined ? {} : { counterpartyHint }),
    ...(facts.balance === undefined ? {} : { extra: { balance: facts.balance } }),
  };
  return {
    kind,
    source: {
      type: 'csv-row',
      ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
      row: { ...row },
      ...(presetId === undefined ? {} : { preset: presetId }),
    },
    facts: normalizedFacts,
    extraction: { method: 'csv-preset', warnings: [] },
  };
}

/** プリセットで 1 行を文書入力へ。行番号（1 始まり。ヘッダ込み）はエラーメッセージに使う。 */
export function rowToDocument(presetId: JournalCsvPresetId, row: Readonly<Record<string, string>>, options: RowToDocumentOptions = {}, rowNumber?: number): JournalDocumentInput {
  const preset = PRESETS.find((entry) => entry.id === presetId);
  if (preset === undefined) throw new JournalCsvImportError(`unknown CSV preset: ${presetId}`);
  return toDocument(preset.documentKind, preset.id, preset.paymentMethod, row, preset.read(normalizeRow(row)), options, rowNumber);
}

/** 列マッピングで 1 行を文書入力へ（未知の列構成向け）。 */
export function rowToDocumentWithMapping(mapping: ColumnMapping, row: Readonly<Record<string, string>>, options: RowToDocumentOptions = {}, rowNumber?: number): JournalDocumentInput {
  if (mapping.amount === undefined && mapping.withdrawal === undefined && mapping.deposit === undefined) throw new JournalCsvImportError('column mapping needs amount or withdrawal / deposit columns');
  const normalized = normalizeRow(row);
  const description = [cell(normalized, mapping.description), mapping.detail === undefined ? '' : cell(normalized, mapping.detail)].filter((part) => part.length > 0).join(' ');
  let withdrawal = mapping.withdrawal === undefined ? undefined : money(normalized, mapping.withdrawal);
  let deposit = mapping.deposit === undefined ? undefined : money(normalized, mapping.deposit);
  if (mapping.amount !== undefined) {
    const signed = money(normalized, mapping.amount);
    if (signed !== undefined) {
      if (signed < 0) withdrawal = -signed;
      else deposit = signed;
    }
  }
  const facts: RowFacts = { date: parseJapaneseDate(cell(normalized, mapping.date)), description, withdrawal, deposit, balance: mapping.balance === undefined ? undefined : money(normalized, mapping.balance) };
  return toDocument('bank_statement', undefined, undefined, row, facts, options, rowNumber);
}

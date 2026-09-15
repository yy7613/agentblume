/**
 * ドメイン: 法人カード明細 CSV の読み取り（docs/21 §20.1.5 / §20.2.8。UC5。純関数）。
 *
 * CSV の分解は仕訳 domain の `parseCsv` / `rowToRecord`、見出しの正規化は `normalizeHeader`、日付と金額は
 * `parseJapaneseDate` / `parseAmount` を使う（§2.8 の許可。receivables のコードは import しない）。
 * 列の対応は利用者が保存するマッピング（見出しの署名で次回から自動で選ぶ）で、カード会社ごとの固定表は持たない。
 * 読めない行は黙って捨てず、行番号と理由を `skippedRows` に残す（画面が「何行目をどう直すか」を出す）。
 */
import { parseCsv, rowToRecord, stripBom } from '../../journal/csv';
import { normalizeHeader } from '../../journal/csv-presets';
import { JournalCsvImportError } from '../../journal/errors';
import { parseAmount, parseJapaneseDate } from '../../journal/normalize';
import { cardDedupeKey, type CardAmountSign, type CardColumnMapping, type CardImportMapping, type CardStatementProfile, type ExpenseCard } from '../card';
import { payeeKeyOf } from '../duplicates';
import { ExpenseCardImportError } from '../errors';

export const CARD_STATEMENT_MAX_ROWS = 5000;
export const CARD_MERCHANT_MAX_CHARS = 200;
export const CARD_MEMO_MAX_CHARS = 500;

export type CardColumnKey = keyof CardColumnMapping;
export const CARD_REQUIRED_COLUMNS: readonly CardColumnKey[] = ['usedOn', 'merchant', 'amount'];
export const CARD_COLUMN_KEYS: readonly CardColumnKey[] = ['usedOn', 'merchant', 'amount', 'postedOn', 'cardLast4', 'memo'];

/** 見出しの候補（正規化・小文字化して完全一致 → 部分一致の順に見る）。推定の起点で、利用者が選び直せる。 */
const HEADER_CANDIDATES: Readonly<Record<CardColumnKey, readonly string[]>> = {
  usedOn: ['利用日', 'ご利用日', '利用年月日', 'ご利用年月日', '取引日', '日付', 'date', 'useddate', 'transactiondate'],
  merchant: ['利用店名', 'ご利用店名', '利用先', 'ご利用先', '加盟店名', '加盟店', '店名', '利用店名・商品名', '摘要', '内容', 'merchant', 'description', 'payee'],
  amount: ['利用金額', 'ご利用金額', '金額', '請求金額', '支払金額', 'お支払金額', 'amount'],
  postedOn: ['計上日', '確定日', '請求日', '支払日', 'posteddate', 'postedon'],
  cardLast4: ['カード番号下4桁', 'カード下4桁', '下4桁', 'カード番号', 'cardlast4', 'cardnumber'],
  memo: ['備考', 'メモ', 'memo', 'note'],
};

function headerKey(header: string): string {
  return normalizeHeader(header).toLowerCase();
}

export interface CardStatementTable {
  /** 見出し（CSV のまま）。 */
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** データ行 1 行目の CSV 上の行番号（見出しの次の行）。 */
  readonly firstRowNumber: number;
}

/** 前置きの行を飛ばして見出しとデータ行に分ける。 */
export function readCardStatementTable(content: string, skipLinesBefore = 0): CardStatementTable {
  const text = stripBom(content);
  let offset = 0;
  for (let skipped = 0; skipped < skipLinesBefore; skipped += 1) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) { offset = text.length; break; }
    offset = newline + 1;
  }
  let parsed: string[][];
  try {
    parsed = parseCsv(text.slice(offset));
  } catch (error) {
    if (error instanceof JournalCsvImportError) throw new ExpenseCardImportError(`card statement: the CSV is broken (${error.message})`, { ...(error.row === undefined ? {} : { row: error.row + skipLinesBefore }) });
    throw error;
  }
  const [headers, ...rows] = parsed;
  if (headers === undefined) throw new ExpenseCardImportError('card statement: the file has no header row');
  if (rows.length > CARD_STATEMENT_MAX_ROWS) throw new ExpenseCardImportError(`card statement: at most ${CARD_STATEMENT_MAX_ROWS} rows can be imported at once (got ${rows.length})`);
  return { headers: headers.map((header) => header.trim()), rows, firstRowNumber: skipLinesBefore + 2 };
}

/** 見出しの署名（正規化済み・空は除く）。 */
export function cardHeaderSignature(headers: readonly string[]): readonly string[] {
  return headers.map(normalizeHeader).filter((header) => header !== '');
}

/** 見出しから列の対応を推定する（見つからない項目は含めない）。 */
export function suggestCardMapping(headers: readonly string[]): Partial<Record<CardColumnKey, string>> {
  const keyed = headers.map((header) => ({ header, key: headerKey(header) })).filter((entry) => entry.key !== '');
  const used = new Set<string>();
  const suggestion: Partial<Record<CardColumnKey, string>> = {};
  const pick = (column: CardColumnKey, predicate: (key: string, candidate: string) => boolean): void => {
    if (suggestion[column] !== undefined) return;
    for (const candidate of HEADER_CANDIDATES[column].map(headerKey)) {
      const found = keyed.find((entry) => !used.has(entry.header) && predicate(entry.key, candidate));
      if (found !== undefined) {
        suggestion[column] = found.header;
        used.add(found.header);
        return;
      }
    }
  };
  for (const column of CARD_COLUMN_KEYS) pick(column, (key, candidate) => key === candidate);
  for (const column of CARD_REQUIRED_COLUMNS) pick(column, (key, candidate) => key.includes(candidate));
  return suggestion;
}

/** 見出しの署名が一致する保存済みのプロファイル（並びは問わない）。 */
export function detectCardProfile(headers: readonly string[], profiles: readonly CardStatementProfile[]): CardStatementProfile | undefined {
  const signature = new Set(cardHeaderSignature(headers));
  return profiles.find((profile) => profile.headerSignature.length === signature.size && profile.headerSignature.every((header) => signature.has(normalizeHeader(header))));
}

/** マッピングの列名を CSV の見出しに当てる。見つからない項目は `missing`。 */
export function resolveCardColumns(headers: readonly string[], columns: CardColumnMapping): { readonly resolved: Partial<Record<CardColumnKey, string>>; readonly missing: readonly CardColumnKey[] } {
  const byKey = new Map(headers.map((header) => [headerKey(header), header]));
  const resolved: Partial<Record<CardColumnKey, string>> = {};
  const missing: CardColumnKey[] = [];
  for (const column of CARD_COLUMN_KEYS) {
    const name = columns[column];
    if (name === undefined) continue;
    const header = byKey.get(headerKey(name));
    if (header === undefined) missing.push(column);
    else resolved[column] = header;
  }
  return { resolved, missing };
}

export interface ParsedCardRow {
  /** CSV 上の行番号。 */
  readonly row: number;
  readonly cardId: string;
  readonly usedOn: string;
  readonly postedOn?: string;
  readonly merchantRaw: string;
  readonly merchantKey: string;
  readonly amount: number;
  readonly memo?: string;
  readonly raw: Readonly<Record<string, string>>;
  readonly dedupeKey: string;
}

export interface CardStatementParseResult {
  readonly headers: readonly string[];
  readonly rows: readonly ParsedCardRow[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly rowCount: number;
  readonly periodFrom?: string;
  readonly periodTo?: string;
}

export interface ParseCardStatementOptions {
  readonly mapping: CardImportMapping;
  /** 取込全体のカード（指定しなければ下 4 桁の列、それも無ければ有効なカードが 1 枚のときだけそのカード）。 */
  readonly cardId?: string;
  readonly cards: readonly ExpenseCard[];
}

function signed(amount: number, sign: CardAmountSign): number {
  return sign === 'charge-negative' ? -amount : amount;
}

function clip(text: string, max: number): string {
  return [...text].slice(0, max).join('');
}

/** 明細 CSV を利用行に読む（保存はしない）。列の対応やカードが決まらなければ `ExpenseCardImportError`。 */
export function parseCardStatement(content: string, options: ParseCardStatementOptions): CardStatementParseResult {
  const { mapping, cards } = options;
  const table = readCardStatementTable(content, mapping.skipLinesBefore);
  const { resolved, missing } = resolveCardColumns(table.headers, mapping.columns);
  if (missing.length > 0) {
    const suggested = suggestCardMapping(table.headers);
    throw new ExpenseCardImportError(`card statement: the columns for ${missing.join(', ')} were not found in the header row`, {
      row: table.firstRowNumber - 1, missingColumns: missing, suggestedMapping: suggested as Record<string, string>,
    });
  }
  const fixedCard = options.cardId === undefined ? undefined : cards.find((card) => card.id === options.cardId);
  if (options.cardId !== undefined && fixedCard === undefined) throw new ExpenseCardImportError(`card statement: card ${options.cardId} is not registered`);
  const enabledCards = cards.filter((card) => card.enabled);
  if (fixedCard === undefined && resolved.cardLast4 === undefined && enabledCards.length !== 1) {
    throw new ExpenseCardImportError('card statement: choose the card of this statement, or map the column with the last four digits of the card number', { missingColumns: ['cardLast4'] });
  }
  const defaultCard = fixedCard ?? (resolved.cardLast4 === undefined ? enabledCards[0] : undefined);

  const rows: ParsedCardRow[] = [];
  const skippedRows: { row: number; reason: string }[] = [];
  const occurrences = new Map<string, number>();
  table.rows.forEach((cells, index) => {
    const row = table.firstRowNumber + index;
    const raw = rowToRecord(table.headers, cells);
    const cell = (column: CardColumnKey): string => (resolved[column] === undefined ? '' : (raw[resolved[column] as string] ?? '').trim());
    const usedOn = parseJapaneseDate(cell('usedOn'));
    if (usedOn === undefined) { skippedRows.push({ row, reason: `利用日「${cell('usedOn')}」を日付として読めません` }); return; }
    const parsedAmount = parseAmount(cell('amount'));
    if (parsedAmount === undefined) { skippedRows.push({ row, reason: `金額「${cell('amount')}」を数値として読めません` }); return; }
    if (parsedAmount === 0) { skippedRows.push({ row, reason: '金額が 0 円の行は取り込みません' }); return; }
    let card = defaultCard;
    if (card === undefined) {
      const digits = cell('cardLast4').replace(/\D/gu, '').slice(-4);
      card = enabledCards.find((entry) => entry.last4 === digits) ?? cards.find((entry) => entry.last4 === digits);
      if (card === undefined) { skippedRows.push({ row, reason: `カード番号の下 4 桁「${cell('cardLast4')}」に一致するカードが登録されていません` }); return; }
    }
    const merchantRaw = clip(cell('merchant'), CARD_MERCHANT_MAX_CHARS);
    const merchantKey = payeeKeyOf(merchantRaw) ?? '';
    const amount = signed(parsedAmount, mapping.amountSign);
    const base = `${card.id}|${usedOn}|${amount}|${merchantKey}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const postedOn = parseJapaneseDate(cell('postedOn'));
    const memo = cell('memo');
    rows.push({
      row, cardId: card.id, usedOn, merchantRaw, merchantKey, amount, raw, dedupeKey: cardDedupeKey(card.id, usedOn, amount, merchantKey, occurrence),
      ...(postedOn === undefined ? {} : { postedOn }), ...(memo === '' ? {} : { memo: clip(memo, CARD_MEMO_MAX_CHARS) }),
    });
  });
  const dates = rows.map((entry) => entry.usedOn).sort();
  return {
    headers: table.headers, rows, skippedRows, rowCount: table.rows.length,
    ...(dates.length === 0 ? {} : { periodFrom: dates[0] as string, periodTo: dates[dates.length - 1] as string }),
  };
}

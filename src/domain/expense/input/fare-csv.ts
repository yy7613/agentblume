/**
 * ドメイン: 運賃マスタの CSV（docs/21 §20.2.10。UC8。純関数）。
 *
 * 列: `id,stations,fare_type,fare,bidirectional,valid_from,valid_to,note`（UTF-8 BOM・CRLF。`stations` は ` > ` 区切り）。
 * 取込は経路の一覧だけを置き換える（駅名の別名は残す。application の `ImportExpenseFaresCsvUseCase`）。
 * 失敗は行番号付き（`ExpenseCsvImportError`。ヘッダが 1 行目）で返し、画面が「何行目の何を直すか」を示せるようにする。
 */
import { parseCsv, rowToRecord, toCsv } from '../../journal/csv';
import { ExpenseCsvImportError, ExpenseDomainError } from '../errors';
import { FARE_TABLE_MAX_ROUTES, validateFareRoute, type FareRoute } from '../fare-table';

export const FARE_CSV_COLUMNS = ['id', 'stations', 'fare_type', 'fare', 'bidirectional', 'valid_from', 'valid_to', 'note'] as const;
export const FARE_CSV_FILE_NAME = 'expense-fares.csv';
const REQUIRED_COLUMNS = ['stations', 'fare'] as const;

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'y', 'はい', '双方向', '往復', '○']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'n', 'いいえ', '片道', '×']);

export function fareTableToCsv(routes: readonly FareRoute[]): string {
  return `﻿${toCsv([
    FARE_CSV_COLUMNS,
    ...routes.map((route) => [route.id, route.stations.join(' > '), route.fareType, route.fare, route.bidirectional ? 'true' : 'false', route.validFrom, route.validTo, route.note]),
  ])}`;
}

function parseFareType(value: string, row: number): string {
  const key = value.normalize('NFKC').trim().toLowerCase();
  if (key === '' || key === 'ic') return 'ic';
  if (key === 'ticket' || key === '切符' || key === 'きっぷ') return 'ticket';
  throw new ExpenseCsvImportError(`fare CSV: row ${row}: fare_type must be ic or ticket (received "${value}")`, row);
}

function parseBidirectional(value: string, row: number): boolean {
  const key = value.normalize('NFKC').trim().toLowerCase();
  // 空欄は双方向（同じ区間の逆向きは同じ運賃のことがほとんど。違う路線だけ片道として登録する）。
  if (key === '' || TRUE_VALUES.has(key)) return true;
  if (FALSE_VALUES.has(key)) return false;
  throw new ExpenseCsvImportError(`fare CSV: row ${row}: bidirectional must be true or false (received "${value}")`, row);
}

function parseFare(value: string, row: number): number {
  const text = value.normalize('NFKC').replace(/[,円¥\s]/gu, '');
  const fare = Number(text);
  if (text === '' || !Number.isInteger(fare)) throw new ExpenseCsvImportError(`fare CSV: row ${row}: fare must be an integer in JPY (received "${value}")`, row);
  return fare;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  let suffix = 2;
  while (taken.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  return id;
}

/** CSV → 経路の一覧（1 経路ずつ `validateFareRoute` を通す。表全体の重なりの検査は `createExpenseFareTable`）。 */
export function parseFareCsv(content: string): readonly FareRoute[] {
  let rows: string[][];
  try {
    rows = parseCsv(content);
  } catch (error) {
    throw new ExpenseCsvImportError(`fare CSV: ${error instanceof Error ? error.message : String(error)}`, (error as { row?: number }).row);
  }
  const header = rows[0];
  if (header === undefined) throw new ExpenseCsvImportError('fare CSV: the file is empty; the first line must be the header id,stations,fare_type,fare,bidirectional,valid_from,valid_to,note', 1);
  const headers = header.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length > 0) throw new ExpenseCsvImportError(`fare CSV: missing columns: ${missing.join(', ')} (expected ${FARE_CSV_COLUMNS.join(',')})`, 1);
  if (rows.length - 1 > FARE_TABLE_MAX_ROUTES) throw new ExpenseCsvImportError(`fare CSV: at most ${FARE_TABLE_MAX_ROUTES} routes can be imported (received ${rows.length - 1})`);
  const taken = new Set<string>();
  return rows.slice(1).map((cells, index) => {
    const row = index + 2;
    const record = rowToRecord(headers, cells);
    const stations = (record['stations'] ?? '').split(/\s*[>＞]\s*/u).map((station) => station.trim()).filter((station) => station !== '');
    const explicitId = (record['id'] ?? '').trim();
    if (explicitId !== '' && taken.has(explicitId)) throw new ExpenseCsvImportError(`fare CSV: row ${row}: duplicate id ${explicitId}`, row);
    const id = explicitId === '' ? uniqueId(`fare-${row}`, taken) : explicitId;
    try {
      const route = validateFareRoute({
        id,
        stations,
        fareType: parseFareType(record['fare_type'] ?? '', row),
        fare: parseFare(record['fare'] ?? '', row),
        bidirectional: parseBidirectional(record['bidirectional'] ?? '', row),
        validFrom: (record['valid_from'] ?? '').trim(),
        validTo: (record['valid_to'] ?? '').trim(),
        note: record['note'] ?? '',
      }, `fare CSV: row ${row}`);
      taken.add(route.id);
      return route;
    } catch (error) {
      if (error instanceof ExpenseDomainError) throw new ExpenseCsvImportError(error.message, row);
      throw error;
    }
  });
}

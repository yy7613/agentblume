/**
 * ドメイン: 従業員 CSV の読み取りと書き出し（docs/21 §20.9.2。系統 A。純関数）。
 *
 * 列: `id,code,name,name_kana,department_id,manager_code,login_subjects,bank_code,bank_name_kana,branch_code,branch_name_kana,
 * account_type,account_number,account_holder_kana,commuter_pass_1,commuter_pass_1_valid_to,…,commuter_pass_3_valid_to,enabled,note`
 * （UTF-8 BOM・CRLF。`login_subjects` は `;` 区切り、定期は ` > ` 区切りの駅）。書き出しは末尾に `account_number_last4` を足す。
 *
 * - 行番号はヘッダ = 1（空行は数えない。仕訳の `parseCsv` が空行を捨てるため）。
 * - **ヘッダに無い列は「既存の値を保つ」**（`present` で区別）。列があって空なら消す。ただし口座は、口座の列が全部空なら既存を保つ
 *   （CSV で口座を黙って消さない）。口座番号の列が空なら既存の口座番号を保つ（§20.9.2）。
 * - 値の不正は行を捨てて `skippedRows` に理由を積む（取込全体は止めない）。必須の列（`name`）が無いときだけ全体を止める。
 * - 口座番号の形・名義カナの 30 バイト・社員番号の一意などの不変条件は、application が `createExpenseEmployee` / 口座の封緘で検査する。
 */
import { isIsoDate } from '../../journal/document';
import { csvValue, parseCsv } from '../../journal/csv';
import { JournalCsvImportError } from '../../journal/errors';
import { accountNumberLast4, BANK_ACCOUNT_TYPES, type BankAccountType } from '../bank-account';
import type { ExpenseEmployee } from '../employee';
import { ExpenseEmployeeCsvImportError } from '../errors';

export const EMPLOYEE_CSV_PASS_SLOTS = 3;

export const EMPLOYEE_CSV_COLUMNS = [
  'id', 'code', 'name', 'name_kana', 'department_id', 'manager_code', 'login_subjects',
  'bank_code', 'bank_name_kana', 'branch_code', 'branch_name_kana', 'account_type', 'account_number', 'account_holder_kana',
  'commuter_pass_1', 'commuter_pass_1_valid_to', 'commuter_pass_2', 'commuter_pass_2_valid_to', 'commuter_pass_3', 'commuter_pass_3_valid_to',
  'enabled', 'note',
] as const;
export type EmployeeCsvColumn = (typeof EMPLOYEE_CSV_COLUMNS)[number];

/** 書き出しだけに足す列（取込では読まない）。 */
export const EMPLOYEE_CSV_LAST4_COLUMN = 'account_number_last4';
export const EMPLOYEE_CSV_REQUIRED_COLUMNS: readonly EmployeeCsvColumn[] = ['name'];
export const EMPLOYEE_CSV_MAX_ROWS = 5000;
export const EMPLOYEE_CSV_STATION_SEPARATOR = ' > ';

const BANK_COLUMNS: readonly EmployeeCsvColumn[] = ['bank_code', 'bank_name_kana', 'branch_code', 'branch_name_kana', 'account_type', 'account_number', 'account_holder_kana'];

/** 預金種目の表記揺れ（英語の値・日本語・全銀のコード）。 */
const ACCOUNT_TYPE_ALIASES: Readonly<Record<string, BankAccountType>> = {
  ordinary: 'ordinary', current: 'current', savings: 'savings', other: 'other',
  普通: 'ordinary', 当座: 'current', 貯蓄: 'savings', その他: 'other',
  '1': 'ordinary', '2': 'current', '4': 'savings', '9': 'other',
};

export interface EmployeeCsvBankAccount {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: BankAccountType;
  /** 空 = 既存の口座番号を保つ。 */
  readonly accountNumber?: string;
  readonly holderKana: string;
}

export interface EmployeeCsvPass {
  readonly stations: readonly string[];
  readonly validTo?: string;
}

export interface EmployeeCsvRecord {
  readonly row: number;
  /** ヘッダにある列（無い列は既存の値を保つ）。 */
  readonly present: ReadonlySet<EmployeeCsvColumn>;
  readonly id?: string;
  readonly code?: string;
  readonly name: string;
  readonly nameKana?: string;
  readonly departmentId?: string;
  readonly managerCode?: string;
  readonly loginSubjects: readonly string[];
  /** undefined = 口座の列が全部空（既存の口座を保つ）。 */
  readonly bankAccount?: EmployeeCsvBankAccount;
  /** 3 枠。undefined = その枠は空。 */
  readonly commuterPasses: readonly (EmployeeCsvPass | undefined)[];
  /** undefined = 空欄（新規は有効、更新は既存を保つ）。 */
  readonly enabled?: boolean;
  readonly note?: string;
}

export interface EmployeeCsvParseResult {
  readonly records: readonly EmployeeCsvRecord[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly columns: readonly EmployeeCsvColumn[];
}

class RowError extends Error {}

function headerKey(header: string): string {
  return header.normalize('NFKC').trim().toLowerCase();
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseEnabled(value: string): boolean | undefined {
  const key = value.normalize('NFKC').trim().toLowerCase();
  if (key === '') return undefined;
  if (['true', '1', 'yes', '有効'].includes(key)) return true;
  if (['false', '0', 'no', '無効'].includes(key)) return false;
  throw new RowError(`enabled の値「${value}」を読めません。true / false（有効 / 無効）のどちらかにしてください`);
}

function parseStations(value: string, column: string): readonly string[] {
  const stations = value.split('>').map((station) => station.trim()).filter((station) => station !== '');
  if (stations.length < 2) throw new RowError(`${column} は「新宿 > 霞ケ関」のように駅を 2 つ以上「>」で区切って書いてください`);
  return stations;
}

function readRow(row: number, values: Readonly<Record<string, string>>, present: ReadonlySet<EmployeeCsvColumn>): EmployeeCsvRecord {
  const cell = (column: EmployeeCsvColumn): string => values[column] ?? '';
  const name = optional(cell('name'));
  if (name === undefined) throw new RowError('氏名（name）が空です。氏名を入れてください');

  let bankAccount: EmployeeCsvBankAccount | undefined;
  if (BANK_COLUMNS.some((column) => cell(column).trim() !== '')) {
    const bankCode = optional(cell('bank_code'));
    const branchCode = optional(cell('branch_code'));
    const holderKana = optional(cell('account_holder_kana'));
    const rawType = optional(cell('account_type'));
    const missing = [bankCode === undefined ? 'bank_code' : '', branchCode === undefined ? 'branch_code' : '', rawType === undefined ? 'account_type' : '', holderKana === undefined ? 'account_holder_kana' : ''].filter((column) => column !== '');
    if (missing.length > 0) throw new RowError(`口座の列が揃っていません（空の列: ${missing.join('・')}）。口座を登録しないなら口座の列を全部空にしてください`);
    const accountType = ACCOUNT_TYPE_ALIASES[(rawType as string).normalize('NFKC').toLowerCase()];
    if (accountType === undefined) throw new RowError(`account_type の値「${rawType ?? ''}」を読めません。${BANK_ACCOUNT_TYPES.join(' / ')} のどれかにしてください`);
    const bankNameKana = optional(cell('bank_name_kana'));
    const branchNameKana = optional(cell('branch_name_kana'));
    const accountNumber = optional(cell('account_number'));
    bankAccount = {
      bankCode: bankCode as string, branchCode: branchCode as string, accountType, holderKana: holderKana as string,
      ...(bankNameKana === undefined ? {} : { bankNameKana }),
      ...(branchNameKana === undefined ? {} : { branchNameKana }),
      ...(accountNumber === undefined ? {} : { accountNumber }),
    };
  }

  const commuterPasses: (EmployeeCsvPass | undefined)[] = [];
  for (let slot = 1; slot <= EMPLOYEE_CSV_PASS_SLOTS; slot += 1) {
    const stationsColumn = `commuter_pass_${slot}` as EmployeeCsvColumn;
    const validToColumn = `commuter_pass_${slot}_valid_to` as EmployeeCsvColumn;
    const rawStations = cell(stationsColumn).trim();
    const validTo = optional(cell(validToColumn));
    if (rawStations === '') {
      if (validTo !== undefined) throw new RowError(`${validToColumn} があるのに ${stationsColumn}（駅の並び）が空です`);
      commuterPasses.push(undefined);
      continue;
    }
    if (validTo !== undefined && !isIsoDate(validTo)) throw new RowError(`${validToColumn} の値「${validTo}」は YYYY-MM-DD の日付にしてください`);
    commuterPasses.push({ stations: parseStations(rawStations, stationsColumn), ...(validTo === undefined ? {} : { validTo }) });
  }

  const enabled = parseEnabled(cell('enabled'));
  const fields = {
    id: optional(cell('id')),
    code: optional(cell('code')),
    nameKana: optional(cell('name_kana')),
    departmentId: optional(cell('department_id')),
    managerCode: optional(cell('manager_code')),
    note: optional(cell('note')),
  };
  return {
    row,
    present,
    name,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    loginSubjects: cell('login_subjects').split(';').map((subject) => subject.trim()).filter((subject) => subject !== ''),
    ...(bankAccount === undefined ? {} : { bankAccount }),
    commuterPasses,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

/** CSV 全体を読む。必須の列が無い・行が多すぎる・引用符が閉じていないときは全体を止める（`ExpenseEmployeeCsvImportError`）。 */
export function parseEmployeeCsv(content: string): EmployeeCsvParseResult {
  let table: string[][];
  try {
    table = parseCsv(content);
  } catch (error) {
    if (error instanceof JournalCsvImportError) throw new ExpenseEmployeeCsvImportError('CSV の引用符（"）が閉じていません。表計算ソフトで開いて保存し直してください', { ...(error.row === undefined ? {} : { row: error.row }) });
    throw error;
  }
  if (table.length === 0) throw new ExpenseEmployeeCsvImportError('CSV に行がありません。ヘッダ行（id,code,name,…）と従業員の行があるファイルを選んでください');
  const headers = (table[0] as string[]).map(headerKey);
  const duplicated = headers.find((header, index) => header !== '' && headers.indexOf(header) !== index);
  if (duplicated !== undefined) throw new ExpenseEmployeeCsvImportError(`ヘッダの列「${duplicated}」が 2 回あります。どちらか一方にしてください`, { row: 1 });
  const columns = EMPLOYEE_CSV_COLUMNS.filter((column) => headers.includes(column));
  const missingColumns = EMPLOYEE_CSV_REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missingColumns.length > 0) {
    throw new ExpenseEmployeeCsvImportError(`必須の列がありません: ${missingColumns.join(', ')}。サンプル samples/expense/employees.csv のヘッダを使ってください`, { row: 1, missingColumns });
  }
  const dataRows = table.slice(1);
  if (dataRows.length > EMPLOYEE_CSV_MAX_ROWS) {
    throw new ExpenseEmployeeCsvImportError(`従業員の行が ${dataRows.length} 行あります。1 回に取り込めるのは ${EMPLOYEE_CSV_MAX_ROWS} 行までです。ファイルを分けてください`);
  }
  const present = new Set<EmployeeCsvColumn>(columns);
  const records: EmployeeCsvRecord[] = [];
  const skippedRows: { row: number; reason: string }[] = [];
  dataRows.forEach((cells, index) => {
    const row = index + 2;
    if (cells.length > headers.length && cells.slice(headers.length).some((value) => value.trim() !== '')) {
      skippedRows.push({ row, reason: `列の数（${cells.length}）がヘッダ（${headers.length}）より多い行です。値の中のカンマは "" で囲んでください` });
      return;
    }
    const values: Record<string, string> = {};
    headers.forEach((header, position) => { if (header !== '') values[header] = cells[position] ?? ''; });
    try {
      records.push(readRow(row, values, present));
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      skippedRows.push({ row, reason: error.message });
    }
  });
  return { records, skippedRows, columns };
}

export interface EmployeeCsvExportOptions {
  /** 上長の従業員 id → CSV の `manager_code`（社員番号。無ければ id）。 */
  readonly managerCodeOf: (managerEmployeeId: string) => string | undefined;
  /** 口座番号の平文（口座つき出力のときだけ。application が開封して渡す）。無ければ列は空。 */
  readonly accountNumbers?: ReadonlyMap<string, string>;
}

/** 従業員の一覧を CSV にする（UTF-8 BOM・CRLF）。 */
export function employeesToCsv(employees: readonly ExpenseEmployee[], options: EmployeeCsvExportOptions): string {
  const header = [...EMPLOYEE_CSV_COLUMNS, EMPLOYEE_CSV_LAST4_COLUMN];
  const lines = employees.map((employee) => {
    const bank = employee.bankAccount;
    const passes = Array.from({ length: EMPLOYEE_CSV_PASS_SLOTS }, (_, index) => employee.commuterPasses[index]);
    const values: Record<string, string> = {
      id: employee.id,
      code: employee.code ?? '',
      name: employee.name,
      name_kana: employee.nameKana ?? '',
      department_id: employee.departmentId ?? '',
      manager_code: employee.managerEmployeeId === undefined ? '' : options.managerCodeOf(employee.managerEmployeeId) ?? employee.managerEmployeeId,
      login_subjects: employee.loginSubjects.join(';'),
      bank_code: bank?.bankCode ?? '',
      bank_name_kana: bank?.bankNameKana ?? '',
      branch_code: bank?.branchCode ?? '',
      branch_name_kana: bank?.branchNameKana ?? '',
      account_type: bank?.accountType ?? '',
      account_number: options.accountNumbers?.get(employee.id) ?? '',
      account_holder_kana: bank?.holderKana ?? '',
      enabled: employee.enabled ? 'true' : 'false',
      note: employee.note ?? '',
      [EMPLOYEE_CSV_LAST4_COLUMN]: bank === undefined ? '' : accountNumberLast4(bank),
    };
    passes.forEach((pass, index) => {
      values[`commuter_pass_${index + 1}`] = pass === undefined ? '' : pass.stations.join(EMPLOYEE_CSV_STATION_SEPARATOR);
      values[`commuter_pass_${index + 1}_valid_to`] = pass?.validTo ?? '';
    });
    return header.map((column) => csvValue(values[column] ?? '')).join(',');
  });
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

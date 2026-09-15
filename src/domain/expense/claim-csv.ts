/**
 * ドメイン: 汎用の経費明細 CSV の読み取り（純粋。docs/21 §6.3）。
 *
 * 列はヘッダ名で引き、**別名**（NFKC・空白除去・小文字化で照合）で揃える。別名は CSV の列名の辞書で、
 * 規程（費目・上限）ではない。読めない値は**行を捨てずに項目を空にして**警告を積む（空欄は判定が理由コードで拾う）。
 * 行そのものが壊れている（列数不一致など）ときだけ `skippedRows`（行番号はヘッダ = 1）。
 */
import { parseCsv } from '../journal/csv';
import type { PaymentMethod } from '../journal/document';
import { JournalCsvImportError } from '../journal/errors';
import { normalizeRegistrationNumber, parseAmount, parseJapaneseDate } from '../journal/normalize';
import { ExpenseCsvImportError } from './errors';
import { digitCount, type ReceiptFacts } from './receipt-facts';

export const CLAIM_CSV_MAX_ROWS = 2000;

export const CLAIM_CSV_FIELDS = [
  'claimant', 'employeeCode', 'department', 'transactionDate', 'payeeName', 'amount', 'category', 'purpose',
  'attendeeCount', 'attendeeNames', 'relation', 'unitCount', 'paymentMethod', 'corporatePayment', 'registrationNumber', 'preApprovalRef', 'description',
] as const;
export type ClaimCsvField = (typeof CLAIM_CSV_FIELDS)[number];

/** 列名の別名（§6.3 の表）。先頭が画面に出す代表名。 */
export const CLAIM_CSV_ALIASES: Readonly<Record<ClaimCsvField, readonly string[]>> = {
  claimant: ['申請者', '氏名', '社員名', '従業員名', 'claimant', 'employee'],
  employeeCode: ['社員番号', '従業員番号', 'employee_code'],
  department: ['部署', '部門', 'department'],
  transactionDate: ['日付', '利用日', '取引日', 'date'],
  payeeName: ['支払先', '店名', '取引先', '支払先名', 'payee', 'vendor'],
  amount: ['金額', '税込金額', '支払金額', 'amount'],
  category: ['費目', '経費科目', '勘定科目', 'category'],
  purpose: ['目的', '用途', '内容', 'purpose'],
  attendeeCount: ['人数', '参加人数', 'attendees'],
  attendeeNames: ['参加者', '同席者', 'attendee_names'],
  relation: ['関係', 'relation'],
  unitCount: ['日数', '泊数', 'unit_count'],
  paymentMethod: ['支払方法', 'payment_method'],
  corporatePayment: ['会社払い', 'corporate'],
  registrationNumber: ['登録番号', 'インボイス番号', 'registration_number'],
  preApprovalRef: ['事前承認番号', '稟議番号', 'pre_approval_ref'],
  description: ['摘要', '備考', 'description'],
};

/** 列名の照合キー。 */
export function normalizeCsvHeader(header: string): string {
  return header.replace(/^﻿/u, '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

const PAYMENT_METHOD_WORDS: Readonly<Record<string, PaymentMethod>> = {
  '現金': 'cash', cash: 'cash',
  'カード': 'credit_card', 'クレジット': 'credit_card', 'クレジットカード': 'credit_card', card: 'credit_card', credit: 'credit_card', credit_card: 'credit_card',
  '振込': 'bank_transfer', '銀行振込': 'bank_transfer', bank_transfer: 'bank_transfer', transfer: 'bank_transfer',
  qr: 'qr', 'qrコード': 'qr', 'qr決済': 'qr', 'コード決済': 'qr',
  '電子マネー': 'e_money', '交通系ic': 'e_money', e_money: 'e_money',
  '口座振替': 'direct_debit', '引落': 'direct_debit', '引き落とし': 'direct_debit', direct_debit: 'direct_debit',
};
const TRUE_WORDS = new Set(['true', 'はい', '1', 'yes', '○']);
const FALSE_WORDS = new Set(['false', 'いいえ', '0', 'no', '']);

export interface ClaimCsvColumnMatch {
  readonly header: string;
  /** 当たった項目。当たらなかった列は null（画面が「使わない列」として見せる）。 */
  readonly field: ClaimCsvField | null;
}

export interface ClaimCsvSkippedRow {
  readonly row: number;
  readonly reason: string;
}

export interface ClaimCsvRow {
  /** 行番号（ヘッダ = 1）。 */
  readonly line: number;
  readonly claimant?: { readonly name: string; readonly employeeCode?: string; readonly department?: string };
  readonly categoryText?: string;
  /** 形を整えた事実（最終的な検証は application が `sanitizeReceiptFacts` で通す）。 */
  readonly facts: ReceiptFacts;
  readonly rejectedRegistrationNumber?: string;
  readonly warnings: readonly string[];
  readonly record: Readonly<Record<string, string>>;
}

export interface ParsedClaimCsv {
  readonly rows: readonly ClaimCsvRow[];
  readonly skippedRows: readonly ClaimCsvSkippedRow[];
  readonly columnMatches: readonly ClaimCsvColumnMatch[];
  readonly warnings: readonly string[];
}

function aliasList(field: ClaimCsvField): string {
  return CLAIM_CSV_ALIASES[field].map((alias) => `「${alias}」`).join('');
}

/** 列の対応表を作る（同じ項目に当たる列が複数あれば先の列を採る）。 */
export function matchClaimCsvColumns(headers: readonly string[]): readonly ClaimCsvColumnMatch[] {
  const taken = new Set<ClaimCsvField>();
  return headers.map((header) => {
    const key = normalizeCsvHeader(header);
    const field = CLAIM_CSV_FIELDS.find((candidate) => !taken.has(candidate) && CLAIM_CSV_ALIASES[candidate].some((alias) => normalizeCsvHeader(alias) === key));
    if (field === undefined) return { header, field: null };
    taken.add(field);
    return { header, field };
  });
}

export function parseClaimCsv(content: string, options: { readonly requireClaimant: boolean }): ParsedClaimCsv {
  let table: string[][];
  try {
    table = parseCsv(content);
  } catch (error) {
    if (error instanceof JournalCsvImportError) throw new ExpenseCsvImportError('CSV の引用符（"）が閉じていません。表計算ソフトで開いて保存し直してください', error.row);
    throw error;
  }
  if (table.length === 0) throw new ExpenseCsvImportError('CSV に行がありません。ヘッダ行と明細の行があるファイルを選んでください');
  const headers = table[0]!.map((header) => header.trim());
  const columnMatches = matchClaimCsvColumns(headers);
  const indexOf = (field: ClaimCsvField): number => columnMatches.findIndex((match) => match.field === field);
  const found = headers.join(', ');
  if (indexOf('transactionDate') < 0) throw new ExpenseCsvImportError(`取引日の列が見つかりません。列名を${aliasList('transactionDate')}のどれかにしてください（見つかった列: ${found}）`);
  if (indexOf('amount') < 0) throw new ExpenseCsvImportError(`金額の列が見つかりません。列名を${aliasList('amount')}のどれかにしてください（見つかった列: ${found}）`);
  if (options.requireClaimant && indexOf('claimant') < 0) {
    throw new ExpenseCsvImportError(`申請者の列が見つかりません。列名を${aliasList('claimant')}のどれかにするか、既存の申請を選んでから取り込んでください（見つかった列: ${found}）`);
  }
  const body = table.slice(1);
  if (body.length > CLAIM_CSV_MAX_ROWS) throw new ExpenseCsvImportError(`CSV の明細が ${body.length} 行あります。1 回に取り込めるのは ${CLAIM_CSV_MAX_ROWS} 行までです。ファイルを分けてください`);

  const rows: ClaimCsvRow[] = [];
  const skippedRows: ClaimCsvSkippedRow[] = [];
  const warnings: string[] = [];
  for (const [index, cells] of body.entries()) {
    const line = index + 2;
    if (cells.length !== headers.length) {
      skippedRows.push({ row: line, reason: `列の数（${cells.length}）がヘッダ（${headers.length}）と合いません。区切りのカンマや引用符を確認してください` });
      continue;
    }
    const cell = (field: ClaimCsvField): string => { const position = indexOf(field); return position < 0 ? '' : (cells[position] ?? '').trim(); };
    const rowWarnings: string[] = [];
    const warn = (message: string): void => { rowWarnings.push(`${line} 行目: ${message}`); };

    const claimantName = cell('claimant');
    if (options.requireClaimant && claimantName === '') {
      skippedRows.push({ row: line, reason: '申請者が空欄です。申請者の氏名を入れてください' });
      continue;
    }
    const dateText = cell('transactionDate');
    const transactionDate = parseJapaneseDate(dateText);
    if (dateText !== '' && transactionDate === undefined) warn(`日付「${dateText}」を読めなかったので空にしました`);
    const amountText = cell('amount');
    const amount = parseAmount(amountText);
    if (amountText !== '' && amount === undefined) warn(`金額「${amountText}」を読めなかったので空にしました`);

    const countText = cell('attendeeCount').normalize('NFKC');
    const countMatch = /^(\d+)\s*(?:名|人)?$/u.exec(countText);
    const attendeeCount = countMatch === null ? undefined : Number(countMatch[1]);
    if (countText !== '' && (attendeeCount === undefined || attendeeCount < 1)) warn(`参加人数「${countText}」を読めなかったので空にしました`);
    const unitText = cell('unitCount').normalize('NFKC');
    const unitMatch = /^(\d+)\s*(?:日|泊)?$/u.exec(unitText);
    const unitCount = unitMatch === null ? undefined : Number(unitMatch[1]);
    if (unitText !== '' && (unitCount === undefined || unitCount < 1)) warn(`日数・泊数「${unitText}」を読めなかったので空にしました`);

    const methodText = cell('paymentMethod');
    const paymentMethod = methodText === '' ? undefined : PAYMENT_METHOD_WORDS[methodText.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()];
    if (methodText !== '' && paymentMethod === undefined) warn(`支払方法「${methodText}」が分からなかったので空にしました（現金・カード・振込・QR・電子マネー・口座振替のどれかにしてください）`);
    const corporateText = cell('corporatePayment').normalize('NFKC').toLowerCase();
    let corporatePayment: boolean | undefined;
    if (TRUE_WORDS.has(corporateText)) corporatePayment = true;
    else if (FALSE_WORDS.has(corporateText)) corporatePayment = corporateText === '' ? undefined : false;
    else warn(`会社払い「${corporateText}」が分からなかったので空にしました（はい / いいえ で入れてください）`);

    const registrationText = cell('registrationNumber');
    let registrationNumber: string | undefined;
    let rejectedRegistrationNumber: string | undefined;
    if (registrationText !== '') {
      registrationNumber = normalizeRegistrationNumber(registrationText);
      if (registrationNumber === undefined) {
        rejectedRegistrationNumber = registrationText;
        warn(`登録番号「${registrationText}」は T + 数字 13 桁の形ではない（数字 ${digitCount(registrationText)} 桁）ため採用していません`);
      }
    }
    const names = cell('attendeeNames').split(/[;；]/u).map((name) => name.trim()).filter((name) => name !== '');
    const relation = cell('relation');
    const attendees = {
      ...(attendeeCount === undefined || attendeeCount < 1 ? {} : { count: attendeeCount }),
      ...(names.length === 0 ? {} : { names }),
      ...(relation === '' ? {} : { relation }),
    };
    const text = (field: ClaimCsvField): string | undefined => { const value = cell(field); return value === '' ? undefined : value; };
    const facts: ReceiptFacts = {
      ...(transactionDate === undefined ? {} : { transactionDate, dateSource: 'manual' as const }),
      ...(text('payeeName') === undefined ? {} : { payeeName: text('payeeName') }),
      ...(amount === undefined ? {} : { amount }),
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      ...(corporatePayment === undefined ? {} : { corporatePayment }),
      ...(text('description') === undefined ? {} : { description: text('description') }),
      ...(text('purpose') === undefined ? {} : { purpose: text('purpose') }),
      ...(Object.keys(attendees).length === 0 ? {} : { attendees }),
      ...(unitCount === undefined || unitCount < 1 ? {} : { unitCount }),
      ...(registrationNumber === undefined ? {} : { registrationNumber }),
      ...(text('preApprovalRef') === undefined ? {} : { preApprovalRef: text('preApprovalRef') }),
    };
    const record = Object.fromEntries(headers.map((header, position) => [header, cells[position] ?? '']));
    warnings.push(...rowWarnings);
    rows.push({
      line,
      ...(claimantName === '' ? {} : { claimant: { name: claimantName, ...(cell('employeeCode') === '' ? {} : { employeeCode: cell('employeeCode') }), ...(cell('department') === '' ? {} : { department: cell('department') }) } }),
      ...(text('category') === undefined ? {} : { categoryText: text('category') }),
      facts,
      ...(rejectedRegistrationNumber === undefined ? {} : { rejectedRegistrationNumber }),
      warnings: rowWarnings,
      record,
    });
  }
  return { rows, skippedRows, columnMatches, warnings };
}

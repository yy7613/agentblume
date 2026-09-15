/**
 * ドメイン: 全銀協 総合振込ファイルのレコードの組み立て（docs/21 §20.6.1 / §20.6.2 / §20.6.4。UC3。純関数）。
 *
 * ヘッダー（1）× 1 → データ（2）× N → トレーラー（8）× 1 → エンド（9）× 1。各 120 バイト、Shift_JIS の半角だけ。
 * 属性 N は右詰め前ゼロ、C は左詰め後ろ半角スペース。文字の変換とバイト化は骨格の `zengin-charset.ts`（`toZenginText` / `encodeZenginText`）、
 * 預金種目は `ZENGIN_ACCOUNT_TYPE_CODES`。銀行差（改行・EOF・銀行名欄・手形交換所番号・振込指定区分・新規コード・顧客コード 1・文字集合）は
 * 振込元の設定 `format` で決める。
 *
 * ここは**点検を通った値**を並べるだけで、利用者が直せる問題（口座の未登録・名義の禁止文字・30 バイト超など）は `payout-plan.ts` が
 * 理由付きで先に止める。ここで形が合わなければ実装の誤りなので `ExpenseDomainError` を投げる（黙って切り詰めない）。
 * 口座番号は平文（7 桁）を受ける。開封は application の `openAccountNumber` だけが行い、この関数は暗号を知らない。
 */
import { isIsoDate } from '../../journal/document';
import { ZENGIN_ACCOUNT_TYPE_CODES, type BankAccountType } from '../bank-account';
import { ExpenseDomainError } from '../errors';
import { ZENGIN_MAX_AMOUNT, type PayoutSourceAccountType, type ZenginFormatSettings } from '../payout';
import { encodeZenginText, toZenginText, type ZenginCharset } from '../zengin-charset';

export const ZENGIN_RECORD_BYTES = 120;
export const ZENGIN_EOF_MARK = 0x1a;

export interface ZenginFileAccount {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  /** 平文の口座番号（1〜7 桁の数字。前ゼロで 7 桁にする）。 */
  readonly accountNumber: string;
}

export interface ZenginFileRequester extends ZenginFileAccount {
  readonly requesterCode: string;
  readonly requesterNameKana: string;
  readonly accountType: PayoutSourceAccountType;
}

export interface ZenginFileLine extends ZenginFileAccount {
  readonly accountType: BankAccountType;
  /** 受取人名（入力のままの名義カナ。ここで書式の変換をする）。 */
  readonly holderKana: string;
  readonly amount: number;
  /** 顧客コード 1 に社員番号を入れる設定のときの社員番号。 */
  readonly employeeCode?: string;
}

export interface ZenginFileResult {
  readonly bytes: Uint8Array;
  /** 改行を含まない 120 文字のレコード（テストと画面の確認用）。 */
  readonly records: readonly string[];
  readonly recordCount: number;
  readonly totalAmount: number;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(`zengin file: ${message}`);

/** 属性 N（右詰め前ゼロ）。 */
export function zenginNumeric(value: string | number, width: number, label: string): string {
  const text = String(value);
  if (!/^\d+$/u.test(text) || text.length > width) throw fail(`${label} must be at most ${width} digits (got "${text}")`);
  return text.padStart(width, '0');
}

/** 属性 C（書式の変換 → 左詰め後ろ半角スペース）。空は全部スペース。 */
export function zenginAlpha(value: string | undefined, width: number, charset: ZenginCharset, label: string): string {
  if (value === undefined || value.trim() === '') return ' '.repeat(width);
  const result = toZenginText(value.trim(), charset);
  if (result.invalid.length > 0) throw fail(`${label} has characters that cannot be written (${result.invalid.map((entry) => entry.char).join('')})`);
  const length = [...result.text].length;
  if (length > width) throw fail(`${label} is ${length} bytes, over ${width}`);
  return result.text + ' '.repeat(width - length);
}

/** 振込日の取組日（MMDD）。 */
export function zenginTransferMonthDay(transferDate: string): string {
  if (!isIsoDate(transferDate)) throw fail(`transferDate must be a date in YYYY-MM-DD (got "${transferDate}")`);
  return `${transferDate.slice(5, 7)}${transferDate.slice(8, 10)}`;
}

function bankNames(account: ZenginFileAccount, format: ZenginFormatSettings, label: string): { readonly bank: string; readonly branch: string } {
  if (!format.includeBankNames) return { bank: ' '.repeat(15), branch: ' '.repeat(15) };
  return { bank: zenginAlpha(account.bankNameKana, 15, format.charset, `${label}.bankNameKana`), branch: zenginAlpha(account.branchNameKana, 15, format.charset, `${label}.branchNameKana`) };
}

function assertRecord(record: string, label: string): string {
  if ([...record].length !== ZENGIN_RECORD_BYTES) throw fail(`${label} must be ${ZENGIN_RECORD_BYTES} bytes (got ${[...record].length})`);
  return record;
}

export function zenginHeaderRecord(requester: ZenginFileRequester, format: ZenginFormatSettings, transferDate: string): string {
  const names = bankNames(requester, format, 'source');
  return assertRecord([
    '1', '21', '0',
    zenginNumeric(requester.requesterCode, 10, 'requesterCode'),
    zenginAlpha(requester.requesterNameKana, 40, format.charset, 'requesterNameKana'),
    zenginTransferMonthDay(transferDate),
    zenginNumeric(requester.bankCode, 4, 'source.bankCode'),
    names.bank,
    zenginNumeric(requester.branchCode, 3, 'source.branchCode'),
    names.branch,
    ZENGIN_ACCOUNT_TYPE_CODES[requester.accountType],
    zenginNumeric(requester.accountNumber, 7, 'source.accountNumber'),
    ' '.repeat(17),
  ].join(''), 'header record');
}

export function zenginDataRecord(line: ZenginFileLine, format: ZenginFormatSettings, index: number): string {
  const label = `lines[${index}]`;
  if (!Number.isSafeInteger(line.amount) || line.amount < 1 || line.amount > ZENGIN_MAX_AMOUNT) throw fail(`${label}.amount must be an integer between 1 and ${ZENGIN_MAX_AMOUNT}`);
  const names = bankNames(line, format, label);
  return assertRecord([
    '2',
    zenginNumeric(line.bankCode, 4, `${label}.bankCode`),
    names.bank,
    zenginNumeric(line.branchCode, 3, `${label}.branchCode`),
    names.branch,
    format.clearingHouse === 'zeros' ? '0000' : '    ',
    ZENGIN_ACCOUNT_TYPE_CODES[line.accountType],
    zenginNumeric(line.accountNumber, 7, `${label}.accountNumber`),
    zenginAlpha(line.holderKana, 30, format.charset, `${label}.holderKana`),
    zenginNumeric(line.amount, 10, `${label}.amount`),
    format.newCode,
    format.customerCode1 === 'none' ? '0000000000' : zenginNumeric(line.employeeCode ?? '', 10, `${label}.employeeCode`),
    '0000000000',
    format.transferKind === 'space' ? ' ' : format.transferKind,
    ' ',
    ' '.repeat(7),
  ].join(''), `data record ${index}`);
}

export function zenginTrailerRecord(count: number, total: number): string {
  return assertRecord(`8${zenginNumeric(count, 6, 'recordCount')}${zenginNumeric(total, 12, 'totalAmount')}${' '.repeat(101)}`, 'trailer record');
}

export function zenginEndRecord(): string {
  return assertRecord(`9${' '.repeat(119)}`, 'end record');
}

/** 総合振込ファイルを組み立てる。0 円の行は作らない（行が 1 件も無ければ実装の誤りとして投げる）。 */
export function buildZenginTransferFile(requester: ZenginFileRequester, format: ZenginFormatSettings, lines: readonly ZenginFileLine[], transferDate: string): ZenginFileResult {
  const payable = lines.filter((line) => line.amount !== 0);
  if (payable.length === 0) throw fail('there must be at least one line with an amount');
  const totalAmount = payable.reduce((sum, line) => sum + line.amount, 0);
  const records = [
    zenginHeaderRecord(requester, format, transferDate),
    ...payable.map((line, index) => zenginDataRecord(line, format, index)),
    zenginTrailerRecord(payable.length, totalAmount),
    zenginEndRecord(),
  ];
  const newline = format.lineEnding === 'crlf' ? [0x0d, 0x0a] : [];
  const size = records.length * (ZENGIN_RECORD_BYTES + newline.length) + (format.eofMark ? 1 : 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const record of records) {
    bytes.set(encodeZenginText(record), offset);
    offset += ZENGIN_RECORD_BYTES;
    bytes.set(newline, offset);
    offset += newline.length;
  }
  if (format.eofMark) bytes[offset] = ZENGIN_EOF_MARK;
  return { bytes, records, recordCount: payable.length, totalAmount };
}

/** ファイル名 `zengin-sofuri-{YYYYMMDD}-{batchId の先頭 8 桁}.txt`。 */
export function zenginFileName(transferDate: string, batchId: string): string {
  return `zengin-sofuri-${transferDate.replaceAll('-', '')}-${batchId.slice(0, 8)}.txt`;
}

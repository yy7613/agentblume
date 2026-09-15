/**
 * ドメイン: 振込口座（BankAccount。docs/21 §20.2.5。純関数・完成品）。
 *
 * A（従業員の保存）と B（振込データ・振込元の設定）の両方が使うので骨格が置く。
 *
 * ## 口座番号は封緘して持つ（§20.17-1 の決定）
 *
 * 口座番号は `SecretCipherPort`（鍵は DB の外）で封緘した `SealedSecret` として保存し、平文は**振込データを作る瞬間だけ**
 * application が開封する。DB ファイル・バックアップ単体が漏れても口座番号が読めないようにするため（利用者の決定）。
 * 封緘の `hint` は平文の末尾 4 文字なので、7 桁に前ゼロ埋めした口座番号なら末尾 4 桁の伏せ字表示に使える（開封しない）。
 * domain は暗号を知らない（`node:crypto` を使わない）ので、ここは平文の形の検証と封緘値の**形**の検証だけを持つ。
 */
import { isSealedSecret, type SealedSecret } from '../model-settings/sealed-secret';
import { assertNonEmpty } from '../shared/assert';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ExpenseDomainError } from './errors';
import { checkZenginName, ZENGIN_BANK_NAME_MAX_BYTES, ZENGIN_HOLDER_NAME_MAX_BYTES, type ZenginCharset } from './zengin-charset';

export const BANK_ACCOUNT_TYPES = ['ordinary', 'current', 'savings', 'other'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** 全銀の預金種目（普通 1 / 当座 2 / 貯蓄 4 / その他 9）。 */
export const ZENGIN_ACCOUNT_TYPE_CODES: Readonly<Record<BankAccountType, string>> = { ordinary: '1', current: '2', savings: '4', other: '9' };

export const ACCOUNT_NUMBER_DIGITS = 7;
export const HOLDER_KANA_INPUT_MAX = 60;

/** 7 桁に前ゼロ埋めした口座番号の封緘値。`hint` が末尾 4 桁。 */
export type SealedAccountNumber = SealedSecret;

export interface BankAccount {
  /** 金融機関コード 4 桁（形だけを見る。コード表を持たない）。 */
  readonly bankCode: string;
  readonly bankNameKana?: string;
  /** 支店コード 3 桁。 */
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: BankAccountType;
  readonly accountNumber: SealedAccountNumber;
  /** 名義カナ（入力のまま保存。振込データでは `toZenginText` で変換する）。 */
  readonly holderKana: string;
  readonly changedAt: IsoDateTime;
  readonly changedBy: string;
}

/** 応答・ツール・一覧に出す形（口座番号の封緘値を外して末尾 4 桁だけにする）。 */
export type MaskedBankAccount = Omit<BankAccount, 'accountNumber'> & { readonly accountNumberLast4: string };

const fail = (message: string, field?: string): ExpenseDomainError => new ExpenseDomainError(message, undefined, field === undefined ? undefined : { field });

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function digits(value: unknown, length: number, label: string, field: string): string {
  if (typeof value !== 'string' || !new RegExp(`^\\d{${length}}$`, 'u').test(value)) throw fail(`${label} must be ${length} digits`, field);
  return value;
}

export function validateBankCode(value: unknown, label = 'bank account: bankCode'): string { return digits(value, 4, label, 'bankCode'); }
export function validateBranchCode(value: unknown, label = 'bank account: branchCode'): string { return digits(value, 3, label, 'branchCode'); }

/**
 * 利用者が入力した口座番号（平文）を 7 桁の前ゼロ埋めにする。ハイフン・空白を黙って外さない
 * （画面が外して見せてから送る。サーバーで外すと「どの値を保存したか」が利用者に見えない）。
 */
export function normalizeAccountNumber(value: unknown, label = 'bank account: accountNumber'): string {
  if (typeof value !== 'string' || !/^\d{1,7}$/u.test(value)) throw fail(`${label} must be 1 to ${ACCOUNT_NUMBER_DIGITS} digits (remove hyphens and spaces)`, 'accountNumber');
  return value.padStart(ACCOUNT_NUMBER_DIGITS, '0');
}

/** 封緘値の形（`hint` が 4 桁の数字）を検証する。 */
export function validateSealedAccountNumber(value: unknown, label = 'bank account: accountNumber'): SealedAccountNumber {
  if (!isSealedSecret(value) || !/^\d{4}$/u.test(value.hint)) throw fail(`${label} must be a sealed account number (seal the 7-digit number with the secret cipher)`, 'accountNumber');
  return { ...value };
}

/** 名義カナの検査（保存時。銀行差を許すよう extended で検査し、振込時に振込元の設定の文字集合で再点検する）。 */
export function validateHolderKana(value: unknown, label = 'bank account: holderKana', charset: ZenginCharset = 'extended'): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > HOLDER_KANA_INPUT_MAX) throw fail(`${label} must be 1 to ${HOLDER_KANA_INPUT_MAX} characters`, 'holderKana');
  const check = checkZenginName(value, ZENGIN_HOLDER_NAME_MAX_BYTES, charset);
  if (check.invalid.length > 0 || check.tooLong) {
    const reason = check.invalid.length > 0
      ? `contains characters that cannot be used in a transfer file: ${check.invalid.map((entry) => `"${entry.char}" at ${entry.index + 1}`).join(', ')}`
      : `is ${check.bytes} bytes after conversion (at most ${ZENGIN_HOLDER_NAME_MAX_BYTES}; voiced marks count as one byte each)`;
    throw new ExpenseDomainError(`${label} ${reason}`, undefined, { field: 'holderKana', converted: { text: check.text, bytes: check.bytes, invalid: check.invalid } });
  }
  return value.trim();
}

function optionalBankName(value: unknown, label: string, field: string): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`, field);
  const check = checkZenginName(value, ZENGIN_BANK_NAME_MAX_BYTES, 'extended');
  if (check.invalid.length > 0 || check.tooLong) {
    throw new ExpenseDomainError(`${label} must be kana of at most ${ZENGIN_BANK_NAME_MAX_BYTES} bytes after conversion`, undefined, { field, converted: { text: check.text, bytes: check.bytes, invalid: check.invalid } });
  }
  return value.trim();
}

/** 口座を組み立てて不変条件を検証する（口座番号は封緘値で受ける）。 */
export function createBankAccount(value: unknown, label = 'bank account'): BankAccount {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!(BANK_ACCOUNT_TYPES as readonly unknown[]).includes(raw['accountType'])) throw fail(`${label}.accountType must be one of ${BANK_ACCOUNT_TYPES.join(', ')}`, 'accountType');
  assertIsoDateTime(raw['changedAt'], `${label}.changedAt`, (message) => fail(message));
  assertNonEmpty(raw['changedBy'], `${label}.changedBy`, (message) => fail(message));
  return withDefined({
    bankCode: validateBankCode(raw['bankCode'], `${label}.bankCode`),
    bankNameKana: optionalBankName(raw['bankNameKana'], `${label}.bankNameKana`, 'bankNameKana'),
    branchCode: validateBranchCode(raw['branchCode'], `${label}.branchCode`),
    branchNameKana: optionalBankName(raw['branchNameKana'], `${label}.branchNameKana`, 'branchNameKana'),
    accountType: raw['accountType'] as BankAccountType,
    accountNumber: validateSealedAccountNumber(raw['accountNumber'], `${label}.accountNumber`),
    holderKana: validateHolderKana(raw['holderKana'], `${label}.holderKana`),
    changedAt: raw['changedAt'] as string,
    changedBy: raw['changedBy'] as string,
  });
}

/** 口座番号の末尾 4 桁（封緘値の hint。開封しない）。 */
export function accountNumberLast4(account: Pick<BankAccount, 'accountNumber'>): string {
  return account.accountNumber.hint;
}

export function maskBankAccount(account: BankAccount): MaskedBankAccount {
  const { accountNumber, ...rest } = account;
  return { ...rest, accountNumberLast4: accountNumber.hint };
}

/** 口座の中身（口座番号の封緘値は開封せずに比べられないので hint と暗号文で比べる）が変わったか。履歴の `bank-account-changed` に使う。 */
export function bankAccountChanged(before: BankAccount | undefined, after: BankAccount | undefined): boolean {
  if (before === undefined || after === undefined) return before !== after;
  const key = (account: BankAccount) => [account.bankCode, account.branchCode, account.accountType, account.accountNumber.data, account.accountNumber.hint, account.holderKana, account.bankNameKana ?? '', account.branchNameKana ?? ''].join('|');
  return key(before) !== key(after);
}

export interface YuchoConversion {
  readonly bankCode: '9900';
  readonly branchCode: string;
  readonly accountType: BankAccountType;
  /** 7 桁の前ゼロ埋め（平文。画面が並べて見せ、利用者が「この値で入れる」を押す）。 */
  readonly accountNumber: string;
}

/**
 * ゆうちょ銀行の記号番号 → 全銀の支店番号・口座番号。
 * 記号が 1 始まり（総合口座）: 支店 = 記号の 2〜3 桁目 + `8`、口座番号 = 番号の末尾の 1 を除いた 7 桁、普通。
 * 記号が 0 始まり（振替口座）: 支店 = 記号の 2〜3 桁目 + `9`、口座番号 = 番号（前ゼロ埋め）、当座。
 */
export function yuchoToZengin(symbol: string, number: string): YuchoConversion {
  const cleanSymbol = symbol.normalize('NFKC').trim();
  const cleanNumber = number.normalize('NFKC').trim();
  if (!/^\d{5}$/u.test(cleanSymbol)) throw fail('yucho: the symbol (記号) must be 5 digits', 'yuchoSymbol');
  const branch = `${cleanSymbol.slice(1, 3)}`;
  if (cleanSymbol.startsWith('1')) {
    if (!/^\d{8}$/u.test(cleanNumber) || !cleanNumber.endsWith('1')) throw fail('yucho: the number (番号) of a general account must be 8 digits ending with 1', 'yuchoNumber');
    return { bankCode: '9900', branchCode: `${branch}8`, accountType: 'ordinary', accountNumber: cleanNumber.slice(0, 7) };
  }
  if (cleanSymbol.startsWith('0')) {
    if (!/^\d{1,7}$/u.test(cleanNumber)) throw fail('yucho: the number (番号) of a transfer account must be 1 to 7 digits', 'yuchoNumber');
    return { bankCode: '9900', branchCode: `${branch}9`, accountType: 'current', accountNumber: cleanNumber.padStart(7, '0') };
  }
  throw fail('yucho: the symbol (記号) must start with 1 or 0', 'yuchoSymbol');
}

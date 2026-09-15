/**
 * ドメイン: 振込元の設定・振込バッチの型と不変条件、振込データの点検の文言（docs/21 §20.2.9 / §20.5.2 / §20.6.4。UC3）。
 *
 * レコードの組み立て（`zengin-file.ts`）と点検の組み立て（`payout-plan.ts`）は B。文字の変換は骨格の `zengin-charset.ts`。
 *
 * - 振込元の口座番号も従業員の口座と同じく封緘値で持つ（§20.17-1 の決定。応答は末尾 4 桁）。
 * - 振込バッチは作成時点の口座の写し（封緘値のまま）を持ち、再ダウンロードは写しを開封して同じバイト列を作り直す。
 * - 受取人名が変換後 30 バイトを超えたら**出力前に止める**（§20.17-7 の決定。切り詰めると組戻しになるため）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { createBankAccount, validateBankCode, validateBranchCode, validateSealedAccountNumber, type BankAccount, type SealedAccountNumber } from './bank-account';
import {
  EXPENSE_PAYOUT_BLOCKING_CODES, ExpenseDomainError, type ExpensePayoutFixTarget, type ExpensePayoutProblem, type ExpensePayoutProblemCode,
} from './errors';
import type { ExpensePayoutBatchId } from './ids';
import { checkZenginName, ZENGIN_BANK_NAME_MAX_BYTES, ZENGIN_CHARSETS, ZENGIN_REQUESTER_NAME_MAX_BYTES, type ZenginCharset } from './zengin-charset';

/** 1 件の振込金額の上限（N10）。 */
export const ZENGIN_MAX_AMOUNT = 9_999_999_999;
export const PAYOUT_MAX_RECORDS_LIMIT = 200_000;
export const DEFAULT_PAYOUT_SETTINGS_UPDATED_AT = '2026-09-15T00:00:00.000Z';

export const PAYOUT_SOURCE_ACCOUNT_TYPES = ['ordinary', 'current', 'other'] as const;
export type PayoutSourceAccountType = (typeof PAYOUT_SOURCE_ACCOUNT_TYPES)[number];

export interface PayoutSourceAccount {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: PayoutSourceAccountType;
  readonly accountNumber: SealedAccountNumber;
}

/** 銀行差を設定データにしたもの（§20.6.4。銀行名で自動選択しない）。 */
export interface ZenginFormatSettings {
  readonly lineEnding: 'crlf' | 'none';
  readonly eofMark: boolean;
  readonly includeBankNames: boolean;
  readonly clearingHouse: 'zeros' | 'spaces';
  readonly transferKind: '7' | '8' | 'space';
  readonly newCode: '0' | '1' | '2';
  readonly customerCode1: 'none' | 'employee-code';
  readonly charset: ZenginCharset;
  readonly maxRecords: number;
}

export const DEFAULT_ZENGIN_FORMAT: ZenginFormatSettings = {
  lineEnding: 'crlf', eofMark: false, includeBankNames: false, clearingHouse: 'zeros', transferKind: '7', newCode: '0', customerCode1: 'none', charset: 'strict', maxRecords: 9999,
};

export interface ExpensePayoutSettings {
  /** 未設定なら振込データを作れない（`payout-source-missing`）。 */
  readonly source?: PayoutSourceAccount;
  /** 銀行が採番する 10 桁。 */
  readonly requesterCode?: string;
  /** 変換後 40 バイト以内。 */
  readonly requesterNameKana?: string;
  readonly format: ZenginFormatSettings;
  /** 振込確定時の支払仕訳（既定 off。§20.17-6 の決定）。 */
  readonly journal: { readonly createPaymentEntry: boolean; readonly sourceAccountId: string };
  readonly updatedAt: IsoDateTime;
}

const fail = (message: string, field?: string): ExpenseDomainError => new ExpenseDomainError(message, undefined, field === undefined ? undefined : { field });

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T, label: string): T {
  if (value === undefined || value === null) return fallback;
  if (!(values as readonly unknown[]).includes(value)) throw fail(`${label} must be one of ${values.join(', ')}`);
  return value as T;
}

function kanaName(value: unknown, label: string, max: number, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`, field);
  const check = checkZenginName(value, max, 'extended');
  if (check.invalid.length > 0 || check.tooLong) throw new ExpenseDomainError(`${label} must be kana of at most ${max} bytes after conversion`, undefined, { field, converted: { text: check.text, bytes: check.bytes, invalid: check.invalid } });
  return value.trim();
}

export function validateZenginFormat(value: unknown, label = 'expense payout settings: format'): ZenginFormatSettings {
  if (value === undefined || value === null) return { ...DEFAULT_ZENGIN_FORMAT };
  const raw = obj(value, label);
  const maxRecords = raw['maxRecords'] ?? DEFAULT_ZENGIN_FORMAT.maxRecords;
  if (typeof maxRecords !== 'number' || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > PAYOUT_MAX_RECORDS_LIMIT) throw fail(`${label}.maxRecords must be an integer between 1 and ${PAYOUT_MAX_RECORDS_LIMIT}`);
  const bool = (key: 'eofMark' | 'includeBankNames'): boolean => {
    const entry = raw[key];
    if (entry === undefined || entry === null) return DEFAULT_ZENGIN_FORMAT[key];
    if (typeof entry !== 'boolean') throw fail(`${label}.${key} must be a boolean`);
    return entry;
  };
  return {
    lineEnding: oneOf(raw['lineEnding'], ['crlf', 'none'] as const, DEFAULT_ZENGIN_FORMAT.lineEnding, `${label}.lineEnding`),
    eofMark: bool('eofMark'),
    includeBankNames: bool('includeBankNames'),
    clearingHouse: oneOf(raw['clearingHouse'], ['zeros', 'spaces'] as const, DEFAULT_ZENGIN_FORMAT.clearingHouse, `${label}.clearingHouse`),
    transferKind: oneOf(raw['transferKind'], ['7', '8', 'space'] as const, DEFAULT_ZENGIN_FORMAT.transferKind, `${label}.transferKind`),
    newCode: oneOf(raw['newCode'], ['0', '1', '2'] as const, DEFAULT_ZENGIN_FORMAT.newCode, `${label}.newCode`),
    customerCode1: oneOf(raw['customerCode1'], ['none', 'employee-code'] as const, DEFAULT_ZENGIN_FORMAT.customerCode1, `${label}.customerCode1`),
    charset: oneOf(raw['charset'], ZENGIN_CHARSETS, DEFAULT_ZENGIN_FORMAT.charset, `${label}.charset`),
    maxRecords,
  };
}

export function createExpensePayoutSettings(props: { readonly source?: PayoutSourceAccount; readonly requesterCode?: string; readonly requesterNameKana?: string; readonly format?: Partial<ZenginFormatSettings>; readonly journal?: Partial<ExpensePayoutSettings['journal']>; readonly updatedAt: string }): ExpensePayoutSettings {
  if (props === null || typeof props !== 'object') throw fail('expense payout settings: props are required');
  let source: PayoutSourceAccount | undefined;
  if (props.source !== undefined && props.source !== null) {
    const raw = obj(props.source, 'expense payout settings: source');
    source = withDefined({
      bankCode: validateBankCode(raw['bankCode'], 'expense payout settings: source.bankCode'),
      bankNameKana: kanaName(raw['bankNameKana'], 'expense payout settings: source.bankNameKana', ZENGIN_BANK_NAME_MAX_BYTES, 'source.bankNameKana'),
      branchCode: validateBranchCode(raw['branchCode'], 'expense payout settings: source.branchCode'),
      branchNameKana: kanaName(raw['branchNameKana'], 'expense payout settings: source.branchNameKana', ZENGIN_BANK_NAME_MAX_BYTES, 'source.branchNameKana'),
      accountType: oneOf(raw['accountType'], PAYOUT_SOURCE_ACCOUNT_TYPES, 'ordinary', 'expense payout settings: source.accountType'),
      accountNumber: validateSealedAccountNumber(raw['accountNumber'], 'expense payout settings: source.accountNumber'),
    });
  }
  const requesterCode = props.requesterCode === undefined || props.requesterCode === null || props.requesterCode === '' ? undefined : props.requesterCode;
  if (requesterCode !== undefined && !/^\d{10}$/u.test(requesterCode)) throw fail('expense payout settings: requesterCode must be 10 digits', 'requesterCode');
  const journal = obj(props.journal ?? {}, 'expense payout settings: journal');
  const createPaymentEntry = journal['createPaymentEntry'] ?? false;
  if (typeof createPaymentEntry !== 'boolean') throw fail('expense payout settings: journal.createPaymentEntry must be a boolean');
  const sourceAccountId = journal['sourceAccountId'] ?? 'asset.ordinary_deposit';
  if (typeof sourceAccountId !== 'string' || sourceAccountId.trim() === '') throw fail('expense payout settings: journal.sourceAccountId must be a non-empty string');
  assertIsoDateTime(props.updatedAt, 'expense payout settings: updatedAt', (message) => fail(message));
  return withDefined({
    source,
    requesterCode,
    requesterNameKana: kanaName(props.requesterNameKana, 'expense payout settings: requesterNameKana', ZENGIN_REQUESTER_NAME_MAX_BYTES, 'requesterNameKana'),
    format: validateZenginFormat(props.format),
    journal: { createPaymentEntry, sourceAccountId: sourceAccountId.trim() },
    updatedAt: props.updatedAt,
  });
}

/** 保存したことが無いワークスペースの振込元の設定（振込元は未設定。書式は最も広く通る組み合わせ）。 */
export function defaultExpensePayoutSettings(updatedAt: string = DEFAULT_PAYOUT_SETTINGS_UPDATED_AT): ExpensePayoutSettings {
  return createExpensePayoutSettings({ updatedAt });
}

/* ---------------------------------------------------------------------------
 * 振込バッチ
 * ------------------------------------------------------------------------- */

export const PAYOUT_BATCH_STATUSES = ['exported', 'confirmed', 'cancelled'] as const;
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];
export const PAYOUT_SOURCE_KINDS = ['claim', 'advance-payment', 'advance-additional'] as const;
export type PayoutSourceKind = (typeof PAYOUT_SOURCE_KINDS)[number];

export interface PayoutLine {
  readonly employeeId: string;
  readonly name: string;
  /** 変換後の受取人名（30 バイト以内。点検を通ったもの）。 */
  readonly holderKanaConverted: string;
  /** 作成時点の口座の写し（口座番号は封緘値のまま）。 */
  readonly bank: BankAccount;
  readonly amount: number;
  readonly sources: readonly { readonly kind: PayoutSourceKind; readonly id: string; readonly amount: number }[];
}

export interface ExpensePayoutBatch {
  readonly tenant: TenantScope;
  readonly id: ExpensePayoutBatchId;
  readonly status: PayoutBatchStatus;
  readonly transferDate: string;
  readonly lines: readonly PayoutLine[];
  readonly recordCount: number;
  readonly totalAmount: number;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly settingsSnapshot: ExpensePayoutSettings;
  readonly acknowledgedWarnings: readonly string[];
  readonly by: string;
  readonly createdAt: IsoDateTime;
  readonly confirmedAt?: IsoDateTime;
  readonly confirmedBy?: string;
  readonly cancel?: { readonly by: string; readonly at: IsoDateTime; readonly note: string };
  readonly journalEntryId?: string;
}

export function createExpensePayoutBatch(props: ExpensePayoutBatch): ExpensePayoutBatch {
  if (props === null || typeof props !== 'object') throw fail('expense payout batch: props are required');
  const tenant = obj(props.tenant, 'expense payout batch: tenant');
  assertNonEmpty(tenant['tenantId'], 'expense payout batch: tenant.tenantId', (message) => fail(message));
  assertNonEmpty(tenant['workspaceId'], 'expense payout batch: tenant.workspaceId', (message) => fail(message));
  assertNonEmpty(props.id, 'expense payout batch: id', (message) => fail(message));
  if (!PAYOUT_BATCH_STATUSES.includes(props.status)) throw fail(`expense payout batch: status must be one of ${PAYOUT_BATCH_STATUSES.join(', ')}`);
  if (!isIsoDate(props.transferDate)) throw fail('expense payout batch: transferDate must be a date in YYYY-MM-DD');
  if (!Array.isArray(props.lines) || props.lines.length === 0) throw fail('expense payout batch: lines must have at least one line');
  const lines = props.lines.map((entry, index): PayoutLine => {
    const label = `expense payout batch: lines[${index}]`;
    const raw = obj(entry, label);
    assertNonEmpty(raw['employeeId'], `${label}.employeeId`, (message) => fail(message));
    assertNonEmpty(raw['name'], `${label}.name`, (message) => fail(message));
    if (typeof raw['holderKanaConverted'] !== 'string' || [...raw['holderKanaConverted']].length > 30) throw fail(`${label}.holderKanaConverted must be at most 30 bytes`);
    const amount = raw['amount'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || amount > ZENGIN_MAX_AMOUNT) throw fail(`${label}.amount must be an integer between 1 and ${ZENGIN_MAX_AMOUNT}`);
    if (!Array.isArray(raw['sources']) || raw['sources'].length === 0) throw fail(`${label}.sources must have at least one source`);
    const sources = raw['sources'].map((source: unknown, position) => {
      const item = obj(source, `${label}.sources[${position}]`);
      if (!(PAYOUT_SOURCE_KINDS as readonly unknown[]).includes(item['kind'])) throw fail(`${label}.sources[${position}].kind must be one of ${PAYOUT_SOURCE_KINDS.join(', ')}`);
      assertNonEmpty(item['id'], `${label}.sources[${position}].id`, (message) => fail(message));
      if (typeof item['amount'] !== 'number' || !Number.isSafeInteger(item['amount']) || item['amount'] < 1) throw fail(`${label}.sources[${position}].amount must be a positive integer`);
      return { kind: item['kind'] as PayoutSourceKind, id: item['id'] as string, amount: item['amount'] };
    });
    // 返金は相殺しないので、行の金額は必ず出所の合計（§20.6.5）。
    if (sources.reduce((sum, source) => sum + source.amount, 0) !== amount) throw fail(`${label}.amount must equal the sum of its sources`);
    return { employeeId: raw['employeeId'] as string, name: raw['name'] as string, holderKanaConverted: raw['holderKanaConverted'], bank: createBankAccount(raw['bank'], `${label}.bank`), amount, sources };
  });
  if (props.recordCount !== lines.length) throw fail('expense payout batch: recordCount must equal the number of lines');
  if (props.totalAmount !== lines.reduce((sum, line) => sum + line.amount, 0)) throw fail('expense payout batch: totalAmount must equal the sum of the lines');
  if (typeof props.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(props.fileSha256)) throw fail('expense payout batch: fileSha256 must be a lowercase SHA-256 hex digest');
  assertNonEmpty(props.fileName, 'expense payout batch: fileName', (message) => fail(message));
  if (!Array.isArray(props.acknowledgedWarnings) || props.acknowledgedWarnings.some((code) => typeof code !== 'string')) throw fail('expense payout batch: acknowledgedWarnings must be an array of codes');
  assertNonEmpty(props.by, 'expense payout batch: by', (message) => fail(message));
  assertIsoDateTime(props.createdAt, 'expense payout batch: createdAt', (message) => fail(message));
  if (props.status === 'confirmed') {
    assertIsoDateTime(props.confirmedAt, 'expense payout batch: confirmedAt', (message) => fail(message));
    assertNonEmpty(props.confirmedBy, 'expense payout batch: confirmedBy', (message) => fail(message));
  }
  let cancel: ExpensePayoutBatch['cancel'];
  if (props.cancel !== undefined) {
    const raw = obj(props.cancel, 'expense payout batch: cancel');
    assertNonEmpty(raw['by'], 'expense payout batch: cancel.by', (message) => fail(message));
    assertIsoDateTime(raw['at'], 'expense payout batch: cancel.at', (message) => fail(message));
    assertNonEmpty(raw['note'], 'expense payout batch: cancel.note', (message) => fail(message));
    cancel = { by: raw['by'] as string, at: raw['at'] as string, note: raw['note'] as string };
  }
  if ((props.status === 'cancelled') !== (cancel !== undefined)) throw fail('expense payout batch: a cancelled batch must have a cancel note, and only a cancelled one');
  const settings = props.settingsSnapshot;
  return withDefined({
    tenant: { tenantId: tenant['tenantId'] as string, workspaceId: tenant['workspaceId'] as string },
    id: props.id,
    status: props.status,
    transferDate: props.transferDate,
    lines,
    recordCount: lines.length,
    totalAmount: props.totalAmount,
    fileName: props.fileName,
    fileSha256: props.fileSha256,
    settingsSnapshot: createExpensePayoutSettings({ ...settings, ...(settings.source === undefined ? {} : { source: settings.source }) }),
    acknowledgedWarnings: [...props.acknowledgedWarnings],
    by: props.by,
    createdAt: props.createdAt,
    confirmedAt: props.status === 'confirmed' ? props.confirmedAt : undefined,
    confirmedBy: props.status === 'confirmed' ? props.confirmedBy : undefined,
    cancel,
    journalEntryId: props.journalEntryId === undefined || props.journalEntryId === '' ? undefined : props.journalEntryId,
  });
}

/* ---------------------------------------------------------------------------
 * 点検の文言（§20.5.2。原因 → 次の一手 → 導線）
 * ------------------------------------------------------------------------- */

type Params = Readonly<Record<string, string | number | boolean | null>>;

function text(params: Params, key: string): string {
  const value = params[key];
  return value === null || value === undefined ? '' : String(value);
}

function yen(params: Params, key: string): string {
  const value = params[key];
  return typeof value === 'number' ? value.toLocaleString('ja-JP') : text(params, key);
}

interface PayoutProblemText { readonly cause: (params: Params) => string; readonly fix: string; readonly fixTarget: ExpensePayoutFixTarget }

export const PAYOUT_PROBLEM_TEXT: Readonly<Record<ExpensePayoutProblemCode, PayoutProblemText>> = {
  'payout-source-missing': { cause: () => '振込元の口座（または依頼人コード・依頼人名）が設定されていません', fix: '振込元の設定で口座・依頼人コード（銀行から通知された 10 桁）・依頼人名を入れてください', fixTarget: 'payout-settings' },
  'payout-employee-unlinked': { cause: (p) => `申請 ${text(p, 'claimId')} の申請者が従業員マスタに紐付いていないため、振込先が決まりません`, fix: '申請者を従業員マスタから選んでください', fixTarget: 'claim-claimant' },
  'payout-bank-account-missing': { cause: (p) => `${text(p, 'employee')} さんの振込口座が登録されていません`, fix: '従業員マスタで口座を登録してください', fixTarget: 'employee-bank-account' },
  'payout-bank-account-invalid': { cause: (p) => `${text(p, 'employee')} さんの口座の${text(p, 'field')}が全銀協形式に合いません（${text(p, 'detail')}）`, fix: '口座を登録し直してください（銀行コード 4 桁・支店コード 3 桁・口座番号 7 桁以内の数字）', fixTarget: 'employee-bank-account' },
  'payout-holder-kana-invalid': { cause: (p) => `${text(p, 'employee')} さんの名義カナに振込データで使えない文字があります: ${text(p, 'chars')}（位置 ${text(p, 'positions')}）`, fix: '通帳の名義どおりにカナで入れ直してください。中点「・」はスペースかピリオドのどちらにするか、銀行の登録名義に合わせて選んでください', fixTarget: 'employee-bank-account' },
  'payout-holder-kana-too-long': { cause: (p) => `${text(p, 'employee')} さんの名義カナが変換後 ${text(p, 'bytes')} バイトで、上限 30 バイトを超えています（濁点・半濁点は 1 文字として数えます）`, fix: '銀行に登録された名義の略し方（法人略語など）で 30 バイト以内にしてください', fixTarget: 'employee-bank-account' },
  'payout-bank-name-missing': { cause: (p) => `振込元の設定で「銀行名・支店名を入れる」になっていますが、${text(p, 'employee')} さんの口座に銀行名 / 支店名のカナがありません`, fix: '口座に銀行名・支店名のカナを入れるか、設定を「入れない（スペース）」にしてください', fixTarget: 'employee-bank-account' },
  'payout-amount-too-large': { cause: (p) => `${text(p, 'employee')} さんの振込額 ${yen(p, 'amount')} 円が 1 件の上限 9,999,999,999 円を超えています`, fix: '申請を分けて振込データを作ってください', fixTarget: 'none' },
  'payout-too-many-records': { cause: (p) => `振込件数 ${yen(p, 'count')} 件が設定の上限 ${yen(p, 'max')} 件を超えています`, fix: '対象の申請を減らして複数のファイルに分けてください（上限は振込元の設定で銀行に合わせて変えられます）', fixTarget: 'payout-settings' },
  'payout-already-exported': { cause: (p) => `申請 ${text(p, 'claimId')} は振込データ ${text(p, 'batchId')}（${text(p, 'createdAt')}）に既に入っています`, fix: 'そのファイルを使うか、振込データを取り消してから作り直してください', fixTarget: 'payout-batch' },
  'payout-claim-not-approved': { cause: (p) => `申請 ${text(p, 'claimId')} は承認済みではありません（状態: ${text(p, 'status')}）`, fix: '対象から外すか、承認を済ませてください', fixTarget: 'approve' },
  'payout-transfer-date-invalid': { cause: (p) => `振込日 ${text(p, 'transferDate')} が今日より前です`, fix: '今日以降の銀行営業日を選んでください', fixTarget: 'transfer-date' },
  'payout-transfer-date-weekend': { cause: (p) => `振込日 ${text(p, 'transferDate')} は土日です（祝日は判定していません）`, fix: '銀行営業日か確かめてください', fixTarget: 'transfer-date' },
  'payout-bank-account-recently-changed': { cause: (p) => `${text(p, 'employee')} さんの口座が ${text(p, 'changedAt')} に ${text(p, 'changedBy')} によって変更されています（直近 30 日）`, fix: '本人に口座の変更を確認してから作成してください', fixTarget: 'employee-history' },
  'payout-holder-kana-converted': { cause: (p) => `${text(p, 'employee')} さんの名義カナを「${text(p, 'from')}」から「${text(p, 'to')}」に変換しました（小書き・長音・英小文字の書式変換）`, fix: '変換後の名義が通帳の名義と同じか確かめてください', fixTarget: 'employee-bank-account' },
  'payout-no-journal': { cause: (p) => `仕訳下書きを作っていない申請が ${yen(p, 'count')} 件あります`, fix: '精算出力で仕訳下書きを作ってから振り込むと、帳簿と支払が揃います', fixTarget: 'settle' },
};

/** 止める理由か（false = 確認必須の警告）。 */
export function isBlockingPayoutProblem(code: ExpensePayoutProblemCode): boolean {
  return (EXPENSE_PAYOUT_BLOCKING_CODES as readonly string[]).includes(code);
}

/** 点検の 1 件を組み立てる（B の planPayout が使う）。`message` は「原因。次の一手」。 */
export function payoutProblem(code: ExpensePayoutProblemCode, params: Params, refs: { readonly employeeId?: string; readonly claimId?: string; readonly advanceId?: string; readonly field?: string } = {}): ExpensePayoutProblem {
  const entry = PAYOUT_PROBLEM_TEXT[code];
  return withDefined({ code, ...refs, message: `${entry.cause(params)}。${entry.fix}`, fixTarget: entry.fixTarget, params: { ...params } });
}

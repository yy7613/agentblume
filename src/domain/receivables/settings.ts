/**
 * ドメイン: 入金消込の設定（ReceivablesSettings。docs/22 §2.1）。ワークスペースに 1 つ。
 *
 * 手数料の許容範囲・端数処理・合算の件数・仕訳の科目 id と税区分・番号書式は**利用者が編集するデータ**で、
 * ここにある値は初期値に過ぎない（仕訳の「科目を固定表にしない」と同じ方針）。
 * コードに残す定数は計算量の安全上限（`HARD_MAX_COMBINATION_SIZE` 等。matching.ts / combinations.ts）だけ。
 *
 * 振込先口座は請求書に印字して相手へ渡す公開情報なので、秘密値ではなく平文で持つ。
 */
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ReceivablesDomainError } from './errors';
import { PRICING_MODES, ROUNDING_MODES, type Pricing, type RoundingMode } from './invoice-tax';
import { DEFAULT_NUMBERING_FORMAT, numberingFormatProblem } from './numbering';

/** 合算で探す請求の件数の上限（計算量の安全弁。設定値はこれを超えられない）。 */
export const HARD_MAX_COMBINATION_SIZE = 5;
export const MIN_COMBINATION_SIZE = 2;

export interface TransferAccount {
  readonly bankName: string;
  readonly branchName: string;
  readonly accountType: string;
  readonly accountNumber: string;
  readonly holderKana: string;
}

export interface IssuerSettings {
  readonly name: string;
  /** 適格請求書発行事業者として登録しているか。 */
  readonly registered: boolean;
  /** 検査（`issuer-registration-number-invalid`）で形を見るので、保存時には形を強制しない。 */
  readonly registrationNumber?: string;
  readonly address?: string;
  readonly tel?: string;
  readonly transferAccounts: readonly TransferAccount[];
  readonly note?: string;
}

export const SALES_ENTRY_DATES = ['transaction-date', 'issue-date'] as const;
export type SalesEntryDate = (typeof SALES_ENTRY_DATES)[number];

export interface JournalLinkSettings {
  readonly enabled: boolean;
  readonly accounts: { readonly sales: string; readonly receivable: string; readonly deposit: string; readonly fee: string };
  readonly salesTaxCodes: { readonly '10': string; readonly '8': string; readonly '0': string };
  readonly feeTaxCode: string;
  /** 売掛金・預金の行の税区分（仕訳は税区分を必須にするが、売掛金の増減に消費税は無い）。 */
  readonly nonTaxableTaxCode: string;
  readonly salesEntryDate: SalesEntryDate;
}

export interface ReceivablesSettings {
  readonly issuer: IssuerSettings;
  readonly rounding: { readonly mode: RoundingMode; readonly defaultPricing: Pricing };
  readonly matching: {
    readonly feeTolerance: { readonly min: number; readonly max: number };
    readonly maxCombinationSize: number;
    readonly partialNameMinLength: number;
  };
  readonly journal: JournalLinkSettings;
  readonly numbering: { readonly format: string };
  readonly updatedAt: IsoDateTime;
}

/** 保存したことが無いワークスペースに返す初期値の時刻（保存はしない）。 */
export const DEFAULT_SETTINGS_UPDATED_AT = '2026-09-14T00:00:00.000Z';

export function defaultReceivablesSettings(updatedAt: string = DEFAULT_SETTINGS_UPDATED_AT): ReceivablesSettings {
  return {
    issuer: { name: '', registered: true, transferAccounts: [] },
    rounding: { mode: 'floor', defaultPricing: 'exclusive' },
    matching: { feeTolerance: { min: 1, max: 880 }, maxCombinationSize: 3, partialNameMinLength: 4 },
    journal: {
      enabled: true,
      accounts: { sales: 'revenue.sales', receivable: 'asset.receivables', deposit: 'asset.ordinary_deposit', fee: 'expense.fees' },
      salesTaxCodes: { '10': 'JP-OUT-10-S', '8': 'JP-OUT-8R-S', '0': 'JP-OUT-EXEMPT' },
      feeTaxCode: 'JP-IN-10-S',
      nonTaxableTaxCode: 'JP-NA',
      salesEntryDate: 'transaction-date',
    },
    numbering: { format: DEFAULT_NUMBERING_FORMAT },
    updatedAt,
  };
}

const fail = (message: string) => new ReceivablesDomainError(message);

function text(value: unknown, label: string, { required = false, max = 500 }: { readonly required?: boolean; readonly max?: number } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw fail(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  if (value.length > max) throw fail(`${label} must be at most ${max} characters`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw fail(`${label} must be a non-empty string`);
  return trimmed === '' ? undefined : trimmed;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw fail(`${label} must be between ${min} and ${max}`);
  return value;
}

/** 設定を検証して複製する。範囲外の値は**丸めずに拒否**する（黙って変えると判定の前提が利用者の意図とずれる）。 */
export function createReceivablesSettings(value: ReceivablesSettings): ReceivablesSettings {
  if (value === null || typeof value !== 'object') throw fail('receivables settings must be an object');
  const issuer = value.issuer;
  if (issuer === null || typeof issuer !== 'object') throw fail('issuer must be an object');
  if (typeof issuer.registered !== 'boolean') throw fail('issuer.registered must be a boolean');
  if (!Array.isArray(issuer.transferAccounts) || issuer.transferAccounts.length > 5) throw fail('issuer.transferAccounts must be an array of at most 5 accounts');
  const transferAccounts = issuer.transferAccounts.map((account, index) => {
    const label = `issuer.transferAccounts[${index}]`;
    if (account === null || typeof account !== 'object') throw fail(`${label} must be an object`);
    return {
      bankName: text(account.bankName, `${label}.bankName`, { required: true, max: 100 })!,
      branchName: text(account.branchName, `${label}.branchName`, { max: 100 }) ?? '',
      accountType: text(account.accountType, `${label}.accountType`, { max: 20 }) ?? '',
      accountNumber: text(account.accountNumber, `${label}.accountNumber`, { required: true, max: 30 })!,
      holderKana: text(account.holderKana, `${label}.holderKana`, { max: 100 }) ?? '',
    };
  });
  const registrationNumber = text(issuer.registrationNumber, 'issuer.registrationNumber', { max: 30 });
  const address = text(issuer.address, 'issuer.address');
  const tel = text(issuer.tel, 'issuer.tel', { max: 40 });
  const note = text(issuer.note, 'issuer.note', { max: 1000 });

  const rounding = value.rounding;
  if (rounding === null || typeof rounding !== 'object' || !ROUNDING_MODES.includes(rounding.mode)) throw fail(`rounding.mode must be one of ${ROUNDING_MODES.join(', ')}`);
  if (!PRICING_MODES.includes(rounding.defaultPricing)) throw fail(`rounding.defaultPricing must be one of ${PRICING_MODES.join(', ')}`);

  const matching = value.matching;
  if (matching === null || typeof matching !== 'object' || matching.feeTolerance === null || typeof matching.feeTolerance !== 'object') throw fail('matching.feeTolerance must be an object');
  const min = integer(matching.feeTolerance.min, 'matching.feeTolerance.min', 0, 100_000);
  const max = integer(matching.feeTolerance.max, 'matching.feeTolerance.max', 0, 100_000);
  if (min > max) throw fail('matching.feeTolerance.min must be less than or equal to max');
  const maxCombinationSize = integer(matching.maxCombinationSize, 'matching.maxCombinationSize', MIN_COMBINATION_SIZE, HARD_MAX_COMBINATION_SIZE);
  const partialNameMinLength = integer(matching.partialNameMinLength, 'matching.partialNameMinLength', 1, 30);

  const journal = value.journal;
  if (journal === null || typeof journal !== 'object' || typeof journal.enabled !== 'boolean') throw fail('journal.enabled must be a boolean');
  if (journal.accounts === null || typeof journal.accounts !== 'object') throw fail('journal.accounts must be an object');
  if (journal.salesTaxCodes === null || typeof journal.salesTaxCodes !== 'object') throw fail('journal.salesTaxCodes must be an object');
  if (!SALES_ENTRY_DATES.includes(journal.salesEntryDate)) throw fail(`journal.salesEntryDate must be one of ${SALES_ENTRY_DATES.join(', ')}`);

  const format = value.numbering?.format;
  const formatProblem = numberingFormatProblem(format as string);
  if (formatProblem !== undefined) throw fail(formatProblem);
  assertIsoDateTime(value.updatedAt, 'receivables settings: updatedAt', fail);

  return {
    issuer: {
      name: text(issuer.name, 'issuer.name', { max: 200 }) ?? '',
      registered: issuer.registered,
      ...(registrationNumber === undefined ? {} : { registrationNumber }),
      ...(address === undefined ? {} : { address }),
      ...(tel === undefined ? {} : { tel }),
      transferAccounts,
      ...(note === undefined ? {} : { note }),
    },
    rounding: { mode: rounding.mode, defaultPricing: rounding.defaultPricing },
    matching: { feeTolerance: { min, max }, maxCombinationSize, partialNameMinLength },
    journal: {
      enabled: journal.enabled,
      accounts: {
        sales: text(journal.accounts.sales, 'journal.accounts.sales', { required: true, max: 100 })!,
        receivable: text(journal.accounts.receivable, 'journal.accounts.receivable', { required: true, max: 100 })!,
        deposit: text(journal.accounts.deposit, 'journal.accounts.deposit', { required: true, max: 100 })!,
        fee: text(journal.accounts.fee, 'journal.accounts.fee', { required: true, max: 100 })!,
      },
      salesTaxCodes: {
        '10': text(journal.salesTaxCodes['10'], "journal.salesTaxCodes['10']", { required: true, max: 60 })!,
        '8': text(journal.salesTaxCodes['8'], "journal.salesTaxCodes['8']", { required: true, max: 60 })!,
        '0': text(journal.salesTaxCodes['0'], "journal.salesTaxCodes['0']", { required: true, max: 60 })!,
      },
      feeTaxCode: text(journal.feeTaxCode, 'journal.feeTaxCode', { required: true, max: 60 })!,
      nonTaxableTaxCode: text(journal.nonTaxableTaxCode, 'journal.nonTaxableTaxCode', { required: true, max: 60 })!,
      salesEntryDate: journal.salesEntryDate,
    },
    numbering: { format: format as string },
    updatedAt: value.updatedAt,
  };
}

/** 仕訳連携の設定項目名（`journal-account-missing` の導線に使う）→ 参照している id。 */
export function journalLinkReferences(settings: ReceivablesSettings): { readonly accounts: readonly { readonly id: string; readonly settingPath: string }[]; readonly taxCodes: readonly { readonly id: string; readonly settingPath: string }[] } {
  const { accounts, salesTaxCodes, feeTaxCode, nonTaxableTaxCode } = settings.journal;
  return {
    accounts: [
      { id: accounts.sales, settingPath: 'journal.accounts.sales' },
      { id: accounts.receivable, settingPath: 'journal.accounts.receivable' },
      { id: accounts.deposit, settingPath: 'journal.accounts.deposit' },
      { id: accounts.fee, settingPath: 'journal.accounts.fee' },
    ],
    taxCodes: [
      { id: salesTaxCodes['10'], settingPath: "journal.salesTaxCodes['10']" },
      { id: salesTaxCodes['8'], settingPath: "journal.salesTaxCodes['8']" },
      { id: salesTaxCodes['0'], settingPath: "journal.salesTaxCodes['0']" },
      { id: feeTaxCode, settingPath: 'journal.feeTaxCode' },
      { id: nonTaxableTaxCode, settingPath: 'journal.nonTaxableTaxCode' },
    ],
  };
}

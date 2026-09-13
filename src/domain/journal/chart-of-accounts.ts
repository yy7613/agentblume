/**
 * ドメイン: 科目マスタ（ChartOfAccounts）集約。
 *
 * 勘定科目・税区分・補助軸（補助科目 / 部門 / …）はワークスペース単位の利用者編集可能なマスタで、
 * 標準セット（`default-chart.ts`）は初期値に過ぎない（docs/20 §5）。すべて string id で、
 * 削除は論理（`enabled: false`）。ルール・仕訳は科目を id で参照し、名称変更に追従する。
 *
 * 形は UI の `JournalChartOfAccountsDto` と同型（scope は持たない。scope はリポジトリのキー）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { JournalDomainError } from './errors';

export const ACCOUNT_CATEGORIES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'other'] as const;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

export const TAX_SIDES = ['in', 'out', 'none'] as const;
export type TaxSide = (typeof TAX_SIDES)[number];

export interface Account {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly category: AccountCategory;
  /** 既定の税区分コード（`taxCategories` に存在すること）。 */
  readonly defaultTaxCode?: string;
  /** 別名（取込・ヒアリングの名寄せに使う）。 */
  readonly aliases: readonly string[];
  readonly enabled: boolean;
  readonly sortOrder: number;
  readonly note?: string;
}

export interface DimensionValue {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** 補助軸（補助科目 / 部門 / プロジェクト / タグ …）。利用者が軸自体を追加できる。 */
export interface Dimension {
  readonly id: string;
  readonly name: string;
  readonly values: readonly DimensionValue[];
}

export interface TaxCategory {
  /** 内部コード `JP-{IN|OUT|NA}-{RATE}-{KIND}[-D{割合}]`（例 `JP-IN-10-S-D80`）。 */
  readonly code: string;
  readonly name: string;
  readonly side: TaxSide;
  /** 税率（%）。非課税・対象外は省略。 */
  readonly rate?: number;
  /** 経過措置の控除割合（0..1）。未指定は全額。 */
  readonly deductionRate?: number;
  readonly enabled: boolean;
  /** 会計ソフトの表示名（空でもよい）。 */
  readonly mapping?: { readonly yayoi?: string; readonly freee?: string; readonly mf?: string };
}

export interface ChartOfAccounts {
  readonly accounts: readonly Account[];
  readonly dimensions: readonly Dimension[];
  readonly taxCategories: readonly TaxCategory[];
  readonly updatedAt: IsoDateTime;
}

export interface CreateChartOfAccountsProps {
  readonly accounts: readonly Account[];
  readonly dimensions: readonly Dimension[];
  readonly taxCategories: readonly TaxCategory[];
  readonly updatedAt: string;
}

const fail: ErrorFactory = (message) => new JournalDomainError(message);

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  return value;
}

function validateAccount(value: Account, index: number, taxCodes: ReadonlySet<string>): Account {
  const label = `createChartOfAccounts: accounts[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertNonEmpty(value.id, `${label}.id`, fail);
  assertNonEmpty(value.name, `${label}.name`, fail);
  if (!ACCOUNT_CATEGORIES.includes(value.category)) throw fail(`${label}.category must be one of ${ACCOUNT_CATEGORIES.join(', ')}`);
  if (!Number.isInteger(value.sortOrder)) throw fail(`${label}.sortOrder must be an integer`);
  if (typeof value.enabled !== 'boolean') throw fail(`${label}.enabled must be a boolean`);
  if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== 'string')) throw fail(`${label}.aliases must be an array of strings`);
  const code = optionalString(value.code, `${label}.code`);
  const note = optionalString(value.note, `${label}.note`);
  const defaultTaxCode = optionalString(value.defaultTaxCode, `${label}.defaultTaxCode`);
  if (defaultTaxCode !== undefined && !taxCodes.has(defaultTaxCode)) throw fail(`${label}.defaultTaxCode refers to an unknown tax category: ${defaultTaxCode}`);
  return {
    id: value.id.trim(),
    ...(code === undefined || code.trim() === '' ? {} : { code: code.trim() }),
    name: value.name.trim(),
    category: value.category,
    ...(defaultTaxCode === undefined ? {} : { defaultTaxCode }),
    aliases: value.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0),
    enabled: value.enabled,
    sortOrder: value.sortOrder,
    ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
  };
}

function validateDimension(value: Dimension, index: number): Dimension {
  const label = `createChartOfAccounts: dimensions[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertNonEmpty(value.id, `${label}.id`, fail);
  assertNonEmpty(value.name, `${label}.name`, fail);
  if (!Array.isArray(value.values)) throw fail(`${label}.values must be an array`);
  const seen = new Set<string>();
  const values = value.values.map((entry, valueIndex) => {
    const valueLabel = `${label}.values[${valueIndex}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${valueLabel} must be an object`);
    assertNonEmpty(entry.id, `${valueLabel}.id`, fail);
    assertNonEmpty(entry.name, `${valueLabel}.name`, fail);
    if (typeof entry.enabled !== 'boolean') throw fail(`${valueLabel}.enabled must be a boolean`);
    if (seen.has(entry.id)) throw fail(`${label}.values contains a duplicate id: ${entry.id}`);
    seen.add(entry.id);
    return { id: entry.id.trim(), name: entry.name.trim(), enabled: entry.enabled };
  });
  return { id: value.id.trim(), name: value.name.trim(), values };
}

function validateTaxCategory(value: TaxCategory, index: number): TaxCategory {
  const label = `createChartOfAccounts: taxCategories[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertNonEmpty(value.code, `${label}.code`, fail);
  assertNonEmpty(value.name, `${label}.name`, fail);
  if (!TAX_SIDES.includes(value.side)) throw fail(`${label}.side must be one of ${TAX_SIDES.join(', ')}`);
  if (value.rate !== undefined && (typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate < 0 || value.rate > 100)) throw fail(`${label}.rate must be a number between 0 and 100`);
  if (value.deductionRate !== undefined && (typeof value.deductionRate !== 'number' || !Number.isFinite(value.deductionRate) || value.deductionRate < 0 || value.deductionRate > 1)) throw fail(`${label}.deductionRate must be a number between 0 and 1`);
  if (typeof value.enabled !== 'boolean') throw fail(`${label}.enabled must be a boolean`);
  let mapping: TaxCategory['mapping'];
  if (value.mapping !== undefined) {
    if (value.mapping === null || typeof value.mapping !== 'object') throw fail(`${label}.mapping must be an object`);
    const yayoi = optionalString(value.mapping.yayoi, `${label}.mapping.yayoi`);
    const freee = optionalString(value.mapping.freee, `${label}.mapping.freee`);
    const mf = optionalString(value.mapping.mf, `${label}.mapping.mf`);
    mapping = { ...(yayoi === undefined ? {} : { yayoi }), ...(freee === undefined ? {} : { freee }), ...(mf === undefined ? {} : { mf }) };
  }
  return {
    code: value.code.trim(),
    name: value.name.trim(),
    side: value.side,
    ...(value.rate === undefined ? {} : { rate: value.rate }),
    ...(value.deductionRate === undefined ? {} : { deductionRate: value.deductionRate }),
    enabled: value.enabled,
    ...(mapping === undefined ? {} : { mapping }),
  };
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw fail(`${label} contains a duplicate: ${value}`);
    seen.add(value);
  }
}

/** 科目マスタを組み立てて不変条件を検証する（id / code / 税区分コードの一意性、既定税区分の存在など）。 */
export function createChartOfAccounts(props: CreateChartOfAccountsProps): ChartOfAccounts {
  if (props === null || typeof props !== 'object') throw fail('createChartOfAccounts: props are required');
  if (!Array.isArray(props.accounts)) throw fail('createChartOfAccounts: accounts must be an array');
  if (!Array.isArray(props.dimensions)) throw fail('createChartOfAccounts: dimensions must be an array');
  if (!Array.isArray(props.taxCategories)) throw fail('createChartOfAccounts: taxCategories must be an array');
  assertIsoDateTime(props.updatedAt, 'createChartOfAccounts: updatedAt', fail);

  const taxCategories = props.taxCategories.map(validateTaxCategory);
  assertUnique(taxCategories.map((entry) => entry.code), 'createChartOfAccounts: taxCategories.code');
  const taxCodes = new Set(taxCategories.map((entry) => entry.code));

  const accounts = props.accounts.map((account, index) => validateAccount(account, index, taxCodes));
  assertUnique(accounts.map((entry) => entry.id), 'createChartOfAccounts: accounts.id');
  assertUnique(accounts.flatMap((entry) => (entry.code === undefined ? [] : [entry.code])), 'createChartOfAccounts: accounts.code');

  const dimensions = props.dimensions.map(validateDimension);
  assertUnique(dimensions.map((entry) => entry.id), 'createChartOfAccounts: dimensions.id');

  return { accounts, dimensions, taxCategories, updatedAt: props.updatedAt };
}

/** id で科目を引く（無効化された科目も返す。有効性は呼び出し側が見る）。 */
export function findAccount(chart: ChartOfAccounts, id: string): Account | undefined {
  return chart.accounts.find((account) => account.id === id);
}

/** コードで税区分を引く。 */
export function findTaxCategory(chart: ChartOfAccounts, code: string): TaxCategory | undefined {
  return chart.taxCategories.find((entry) => entry.code === code);
}

/** 補助軸の値の表示名（無ければ id をそのまま返す。CSV 出力で使う）。 */
export function dimensionValueName(chart: ChartOfAccounts, dimensionId: string, valueId: string): string {
  const dimension = chart.dimensions.find((entry) => entry.id === dimensionId);
  return dimension?.values.find((entry) => entry.id === valueId)?.name ?? valueId;
}

/** 科目を名前または別名で引く（NFKC・大文字小文字を無視）。ヒアリングの提案や CSV 取込の名寄せに使う。 */
export function findAccountByName(chart: ChartOfAccounts, name: string): Account | undefined {
  const key = name.normalize('NFKC').trim().toLowerCase();
  if (key.length === 0) return undefined;
  return chart.accounts.find((account) => [account.name, ...account.aliases].some((candidate) => candidate.normalize('NFKC').trim().toLowerCase() === key));
}

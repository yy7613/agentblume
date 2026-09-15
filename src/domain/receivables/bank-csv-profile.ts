/**
 * ドメイン: 銀行明細 CSV のプロファイル（保存できる列マッピング。docs/22 §5.3 / ADR-0041 決定 6）。
 *
 * 行の正規化は仕訳の銀行プリセット / 列マッピング（`rowToDocument` / `rowToDocumentWithMapping`）に委ね、
 * その上に「ヘッダ行の位置」「振込依頼人名の列」「口座の既定」を足して保存できるようにする。
 * 組込みプロファイルは仕訳の銀行プリセットを写したもの（編集不可。複製して編集する）。カードのプリセットは入金が無いので写さない。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { JOURNAL_CSV_PRESETS, normalizeHeader, type ColumnMapping, type JournalCsvPresetId } from '../journal/csv-presets';
import { ReceivablesDomainError } from './errors';
import type { BankCsvProfileId } from './ids';

export const BANK_CSV_PROFILE_ORIGINS = ['builtin', 'user'] as const;
export type BankCsvProfileOrigin = (typeof BANK_CSV_PROFILE_ORIGINS)[number];

/** 前置きの行（口座情報など）を飛ばしてヘッダ行を探す範囲。 */
export const HEADER_ROW_SCAN_LIMIT = 20;
export const BUILTIN_PROFILE_PREFIX = 'builtin:';

/** 仕訳の列マッピング + 振込依頼人名の列。列名で指定する。 */
export interface ReceivablesColumnMapping {
  readonly date: string;
  readonly description?: string;
  readonly deposit?: string;
  readonly withdrawal?: string;
  /** 符号付き 1 列（負 = 出金）。 */
  readonly amount?: string;
  readonly balance?: string;
  readonly detail?: string;
  /** 振込依頼人名が独立した列の銀行向け（あれば摘要から切り出さない）。 */
  readonly payerName?: string;
}

export interface BankCsvProfile {
  readonly tenant?: TenantScope;
  readonly id: BankCsvProfileId;
  readonly name: string;
  readonly origin: BankCsvProfileOrigin;
  /** 組込みのとき、行の読み方を持つ仕訳のプリセット。 */
  readonly presetId?: JournalCsvPresetId;
  /** 利用者のとき、列マッピング。 */
  readonly mapping?: ReceivablesColumnMapping;
  /** 正規化済み列名。「署名の列がすべて含まれる」で一致とみなす。 */
  readonly headerSignature: readonly string[];
  /** ヘッダ行の行番号（1 始まり）。`auto` なら探す。 */
  readonly headerRow: number | 'auto';
  readonly accountKey?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

const fail: ErrorFactory = (message) => new ReceivablesDomainError(message);

/** 組込みプロファイル（仕訳の銀行プリセットの写し）。 */
export const BUILTIN_BANK_CSV_PROFILES: readonly BankCsvProfile[] = JOURNAL_CSV_PRESETS
  .filter((preset) => preset.kind !== 'card_statement')
  .map((preset) => ({
    id: `${BUILTIN_PROFILE_PREFIX}${preset.id}`,
    name: preset.name,
    origin: 'builtin' as const,
    presetId: preset.id,
    headerSignature: preset.headerSignature.map(normalizeHeader),
    headerRow: 'auto' as const,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  }));

export function isBuiltinProfileId(id: string): boolean {
  return id.startsWith(BUILTIN_PROFILE_PREFIX);
}

/** 列マッピングの不足（UI は保存ボタンを押せなくし、足りない項目名を出す）。 */
export function columnMappingProblems(mapping: Partial<ReceivablesColumnMapping> | undefined): readonly ('date' | 'deposit-or-amount')[] {
  const problems: ('date' | 'deposit-or-amount')[] = [];
  if (mapping?.date === undefined || mapping.date.trim() === '') problems.push('date');
  const deposit = mapping?.deposit?.trim() ?? '';
  const amount = mapping?.amount?.trim() ?? '';
  if (deposit === '' && amount === '') problems.push('deposit-or-amount');
  return problems;
}

/** 仕訳の `ColumnMapping` へ。摘要の列が無ければ名義の列を摘要として読む（仕訳の行正規化は摘要を必須にするため）。 */
export function toJournalColumnMapping(mapping: ReceivablesColumnMapping): ColumnMapping {
  const pick = (value: string | undefined) => value === undefined || value.trim() === '' ? undefined : value;
  const withdrawal = pick(mapping.withdrawal);
  const deposit = pick(mapping.deposit);
  const amount = pick(mapping.amount);
  const balance = pick(mapping.balance);
  const detail = pick(mapping.detail);
  return {
    date: mapping.date,
    description: pick(mapping.description) ?? pick(mapping.payerName) ?? '',
    ...(withdrawal === undefined ? {} : { withdrawal }),
    ...(deposit === undefined ? {} : { deposit }),
    ...(amount === undefined ? {} : { amount }),
    ...(balance === undefined ? {} : { balance }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** ヘッダが署名の列をすべて含むか。 */
export function profileMatchesHeaders(profile: Pick<BankCsvProfile, 'headerSignature'>, headers: readonly string[]): boolean {
  const normalized = new Set(headers.map(normalizeHeader));
  return profile.headerSignature.length > 0 && profile.headerSignature.every((column) => normalized.has(normalizeHeader(column)));
}

function mappingColumns(mapping: ReceivablesColumnMapping): readonly string[] {
  return [mapping.date, mapping.description, mapping.deposit, mapping.withdrawal, mapping.amount, mapping.balance, mapping.detail, mapping.payerName]
    .filter((column): column is string => column !== undefined && column.trim() !== '');
}

export interface CreateBankCsvProfileProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly name: string;
  readonly mapping: ReceivablesColumnMapping;
  /** 省略時はマッピングの列名。 */
  readonly headerSignature?: readonly string[];
  readonly headerRow?: number | 'auto';
  readonly accountKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 利用者のプロファイルを組み立てる（組込みは作れない）。 */
export function createBankCsvProfile(props: CreateBankCsvProfileProps, makeId?: () => string): BankCsvProfile {
  if (props === null || typeof props !== 'object') throw fail('createBankCsvProfile: props are required');
  assertNonEmpty(props.tenant?.tenantId, 'createBankCsvProfile: tenant.tenantId', fail);
  assertNonEmpty(props.tenant?.workspaceId, 'createBankCsvProfile: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createBankCsvProfile: id', fail);
  if (isBuiltinProfileId(id)) throw fail('a builtin bank CSV profile cannot be saved; duplicate it with a new name');
  assertNonEmpty(props.name, 'bank CSV profile name', fail);
  if (props.mapping === null || typeof props.mapping !== 'object') throw fail('bank CSV profile mapping is required');
  const problems = columnMappingProblems(props.mapping);
  if (problems.length > 0) throw fail(`bank CSV profile mapping is missing: ${problems.join(', ')}`);
  const clean = (value: unknown, label: string) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw fail(`${label} must be a string`);
    return value.trim() === '' ? undefined : value.trim();
  };
  const mapping: ReceivablesColumnMapping = Object.fromEntries(
    (['date', 'description', 'deposit', 'withdrawal', 'amount', 'balance', 'detail', 'payerName'] as const)
      .map((key) => [key, clean(props.mapping[key], `bank CSV profile mapping.${key}`)])
      .filter(([, value]) => value !== undefined),
  ) as unknown as ReceivablesColumnMapping;
  const signature = (props.headerSignature ?? mappingColumns(mapping)).map((column) => {
    if (typeof column !== 'string') throw fail('bank CSV profile headerSignature must be strings');
    return normalizeHeader(column);
  }).filter((column) => column !== '');
  if (signature.length === 0) throw fail('bank CSV profile headerSignature must not be empty');
  const missing = mappingColumns(mapping).map(normalizeHeader).filter((column) => !signature.includes(column));
  if (missing.length > 0) throw fail(`bank CSV profile headerSignature must include the mapped columns: ${missing.join(', ')}`);
  const headerRow = props.headerRow ?? 'auto';
  if (headerRow !== 'auto' && (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > HEADER_ROW_SCAN_LIMIT + 1)) throw fail(`bank CSV profile headerRow must be auto or between 1 and ${HEADER_ROW_SCAN_LIMIT + 1}`);
  assertIsoDateTime(props.createdAt, 'createBankCsvProfile: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createBankCsvProfile: updatedAt', fail);
  const accountKey = clean(props.accountKey, 'bank CSV profile accountKey');
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    name: props.name.trim(),
    origin: 'user',
    mapping,
    headerSignature: [...new Set(signature)],
    headerRow,
    ...(accountKey === undefined ? {} : { accountKey }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 日付列の候補語（列名にこれを含む）。ヘッダ行の自動検出だけに使う。 */
const DATE_HEADER_HINTS = ['日付', '取引日', '年月日', '日', 'date'];
const AMOUNT_HEADER_HINTS = ['入金', '預', '金額', '入出金', 'amount', 'deposit'];

/**
 * 先頭 `HEADER_ROW_SCAN_LIMIT` 行から「日付列と金額列の候補を両方含む最初の行」を探す（1 始まり）。見つからなければ undefined。
 */
export function findHeaderRow(rows: readonly (readonly string[])[]): number | undefined {
  const limit = Math.min(rows.length, HEADER_ROW_SCAN_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index]!.map((cell) => normalizeHeader(cell).toLowerCase());
    const hasDate = cells.some((cell) => cell.length <= 12 && DATE_HEADER_HINTS.some((hint) => cell.includes(hint)));
    const hasAmount = cells.some((cell) => cell.length <= 16 && AMOUNT_HEADER_HINTS.some((hint) => cell.includes(hint)));
    if (hasDate && hasAmount) return index + 1;
  }
  return undefined;
}

/**
 * ドメイン: 取引先（Customer）集約（docs/22 §2.2）。
 *
 * 請求書の宛名であり、入金の振込名義との照合相手でもある。照合は `kana`（振込名義カナ）と
 * `payerAliases`（入金明細に現れた生の名義）で行い、漢字の社名からカナは推測しない。
 * 別名は利用者が一覧で編集・削除でき、増える経路は手入力と「消込の確定で名義を覚える」の 2 つだけ（ADR-0041 決定 2）。
 *
 * 別名の `normalized` は**保存のたびに再計算する**（クライアントが送った値を信じると、照合と画面の表示がずれる）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { normalizeRegistrationNumber } from '../journal/normalize';
import { ReceivablesDomainError } from './errors';
import type { CustomerId, MatchingId } from './ids';
import { normalizePayerName } from './payer-name';

export const HONORIFICS = ['御中', '様'] as const;
export type Honorific = (typeof HONORIFICS)[number];

export const ALIAS_ORIGINS = ['manual', 'learned'] as const;
export type AliasOrigin = (typeof ALIAS_ORIGINS)[number];

export const MAX_PAYER_ALIASES = 50;

export interface PayerAlias {
  readonly id: string;
  /** 入金明細に現れた生の名義。 */
  readonly text: string;
  /** `normalizePayerName(text)`。 */
  readonly normalized: string;
  readonly origin: AliasOrigin;
  /** 学習したときの消込。取消で「この別名も消すか」を尋ねるのに使う。 */
  readonly matchingId?: MatchingId;
  readonly createdAt: IsoDateTime;
  readonly lastMatchedAt?: IsoDateTime;
}

export interface Customer {
  readonly tenant: TenantScope;
  readonly id: CustomerId;
  readonly name: string;
  readonly honorific: Honorific;
  readonly kana?: string;
  readonly registrationNumber?: string;
  readonly paymentTermDays?: number;
  readonly address?: string;
  readonly note?: string;
  readonly payerAliases: readonly PayerAlias[];
  readonly enabled: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateCustomerProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly name: string;
  readonly honorific?: Honorific;
  readonly kana?: string;
  readonly registrationNumber?: string;
  readonly paymentTermDays?: number;
  readonly address?: string;
  readonly note?: string;
  readonly payerAliases?: readonly (Omit<PayerAlias, 'normalized' | 'id' | 'createdAt'> & { readonly id?: string; readonly normalized?: string; readonly createdAt?: string })[];
  readonly enabled?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const fail: ErrorFactory = (message) => new ReceivablesDomainError(message);

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  if (value.length > max) throw fail(`${label} must be at most ${max} characters`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 取引先を組み立てて不変条件を検証する。`id` / 別名の id が無いときは `makeId` で生成する。 */
export function createCustomer(props: CreateCustomerProps, makeId?: () => string): Customer {
  if (props === null || typeof props !== 'object') throw fail('createCustomer: props are required');
  assertNonEmpty(props.tenant?.tenantId, 'createCustomer: tenant.tenantId', fail);
  assertNonEmpty(props.tenant?.workspaceId, 'createCustomer: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createCustomer: id', fail);
  assertNonEmpty(props.name, 'customer name', fail);
  if (props.name.length > 200) throw fail('customer name must be at most 200 characters');
  const honorific = props.honorific ?? '御中';
  if (!HONORIFICS.includes(honorific)) throw fail(`customer honorific must be one of ${HONORIFICS.join(', ')}`);
  const rawRegistration = optionalText(props.registrationNumber, 'customer registrationNumber', 30);
  let registrationNumber: string | undefined;
  if (rawRegistration !== undefined) {
    registrationNumber = normalizeRegistrationNumber(rawRegistration);
    if (registrationNumber === undefined) throw fail('customer registrationNumber must be T followed by 13 digits');
  }
  if (props.paymentTermDays !== undefined && (!Number.isInteger(props.paymentTermDays) || props.paymentTermDays < 0 || props.paymentTermDays > 365)) {
    throw fail('customer paymentTermDays must be an integer between 0 and 365');
  }
  assertIsoDateTime(props.createdAt, 'createCustomer: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createCustomer: updatedAt', fail);
  const aliases = props.payerAliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > MAX_PAYER_ALIASES) throw fail(`customer payerAliases must be an array of at most ${MAX_PAYER_ALIASES}`);
  const seen = new Set<string>();
  const payerAliases = aliases.map((alias, index): PayerAlias => {
    const label = `customer payerAliases[${index}]`;
    if (alias === null || typeof alias !== 'object') throw fail(`${label} must be an object`);
    assertNonEmpty(alias.text, `${label}.text`, fail);
    const normalized = normalizePayerName(alias.text);
    if (normalized === '') throw fail(`${label}.text has no characters left after normalization: ${alias.text}`);
    if (seen.has(normalized)) throw fail(`${label}.text duplicates another alias of this customer after normalization: ${normalized}`);
    seen.add(normalized);
    if (!ALIAS_ORIGINS.includes(alias.origin)) throw fail(`${label}.origin must be manual or learned`);
    const aliasId = alias.id ?? makeId?.();
    assertNonEmpty(aliasId, `${label}.id`, fail);
    const createdAt = alias.createdAt ?? props.updatedAt;
    assertIsoDateTime(createdAt, `${label}.createdAt`, fail);
    if (alias.lastMatchedAt !== undefined) assertIsoDateTime(alias.lastMatchedAt, `${label}.lastMatchedAt`, fail);
    return {
      id: aliasId, text: alias.text.trim(), normalized, origin: alias.origin,
      ...(alias.matchingId === undefined ? {} : { matchingId: alias.matchingId }),
      createdAt,
      ...(alias.lastMatchedAt === undefined ? {} : { lastMatchedAt: alias.lastMatchedAt }),
    };
  });
  const kana = optionalText(props.kana, 'customer kana', 100);
  const address = optionalText(props.address, 'customer address', 500);
  const note = optionalText(props.note, 'customer note', 1000);
  if (props.enabled !== undefined && typeof props.enabled !== 'boolean') throw fail('customer enabled must be a boolean');
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    name: props.name.trim(),
    honorific,
    ...(kana === undefined ? {} : { kana }),
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(props.paymentTermDays === undefined ? {} : { paymentTermDays: props.paymentTermDays }),
    ...(address === undefined ? {} : { address }),
    ...(note === undefined ? {} : { note }),
    payerAliases,
    enabled: props.enabled ?? true,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 消込の確定で名義を覚える。同じ正規化名が既にあれば最終一致日だけ更新する（別名を二重にしない）。 */
export function learnPayerAlias(customer: Customer, input: { readonly text: string; readonly aliasId: string; readonly matchingId: string; readonly at: string }): { readonly customer: Customer; readonly aliasId: string; readonly created: boolean } {
  const normalized = normalizePayerName(input.text);
  if (normalized === '') throw fail('learnPayerAlias: the payer name is empty after normalization');
  const existing = customer.payerAliases.find((alias) => alias.normalized === normalized);
  if (existing !== undefined) {
    const payerAliases = customer.payerAliases.map((alias) => alias.id === existing.id ? { ...alias, lastMatchedAt: input.at } : alias);
    return { customer: { ...customer, payerAliases, updatedAt: input.at }, aliasId: existing.id, created: false };
  }
  if (customer.payerAliases.length >= MAX_PAYER_ALIASES) throw fail(`customer payerAliases must be an array of at most ${MAX_PAYER_ALIASES}`);
  const alias: PayerAlias = { id: input.aliasId, text: input.text.trim(), normalized, origin: 'learned', matchingId: input.matchingId, createdAt: input.at, lastMatchedAt: input.at };
  return { customer: { ...customer, payerAliases: [...customer.payerAliases, alias], updatedAt: input.at }, aliasId: alias.id, created: true };
}

/** 別名を消す（無ければそのまま）。 */
export function removePayerAlias(customer: Customer, aliasId: string, at: string): Customer {
  if (!customer.payerAliases.some((alias) => alias.id === aliasId)) return customer;
  return { ...customer, payerAliases: customer.payerAliases.filter((alias) => alias.id !== aliasId), updatedAt: at };
}

/** 照合に使う正規化名（kana と別名）。 */
export function customerMatchKeys(customer: Pick<Customer, 'kana' | 'payerAliases'>): readonly string[] {
  const kana = normalizePayerName(customer.kana);
  return [...(kana === '' ? [] : [kana]), ...customer.payerAliases.map((alias) => alias.normalized)];
}

/** 別の取引先の別名 / カナと同じ正規化名を持つもの（保存はできるが、判定では `alias-conflict` になる）。 */
export interface AliasConflict {
  readonly normalized: string;
  readonly otherCustomerId: string;
  readonly otherCustomerName: string;
}

export function aliasConflicts(customer: Customer, others: readonly Customer[]): readonly AliasConflict[] {
  const keys = new Set(customerMatchKeys(customer));
  const conflicts: AliasConflict[] = [];
  for (const other of others) {
    if (other.id === customer.id) continue;
    for (const key of new Set(customerMatchKeys(other))) {
      if (keys.has(key)) conflicts.push({ normalized: key, otherCustomerId: other.id, otherCustomerName: other.name });
    }
  }
  return conflicts;
}

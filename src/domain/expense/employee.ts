/**
 * ドメイン: 従業員（ExpenseEmployee）集約（docs/21 §20.2.5。UC1。骨格が型・不変条件・直列化を持ち、CRUD と画面は A）。
 *
 * 申請者を自由文字列から id 参照へ変えるための正本。部門（集計・仕訳の補助軸・承認経路の条件）、上長（承認経路）、
 * 振込口座（UC3）、通勤定期（UC8）を 1 か所で持つ。削除は無効化のみ（申請・振込バッチから参照されるため）。
 *
 * - 社員番号は**任意**（§20.17-8 の決定）。付けるなら有効・無効を問わず一意（NFKC・空白除去・小文字化で比較）。
 * - ログイン ID（`Principal.subject`）はワークスペース内の全従業員で一意。一意の検査はリポジトリ（DB の一意制約）が持つ。
 * - 上長の循環（20 段以内に自分へ戻る）は他の従業員を読まないと分からないので、`managerChainReturnsTo` を application が呼ぶ。
 * - 口座の変更は必ず履歴 `bank-account-changed` を残す（振込データの点検で直近の変更を確認必須の警告にする。口座のすり替え対策）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { createBankAccount, maskBankAccount, type BankAccount, type MaskedBankAccount } from './bank-account';
import { ExpenseDomainError } from './errors';
import type { ExpenseDepartmentId, ExpenseEmployeeId } from './ids';
import { validateStations } from './receipt-facts';

export const EMPLOYEE_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
export const EMPLOYEE_CODE_MAX = 20;
export const EMPLOYEE_NAME_MAX = 100;
export const LOGIN_SUBJECTS_MAX = 5;
export const LOGIN_SUBJECT_MAX = 200;
export const COMMUTER_PASSES_MAX = 3;
export const EMPLOYEE_HISTORY_MAX = 50;
export const EMPLOYEE_NOTE_MAX = 500;
/** 上長をたどる上限（これを超える循環の検査はしない）。 */
export const MANAGER_CHAIN_MAX = 20;

export const EMPLOYEE_HISTORY_TYPES = ['created', 'edited', 'bank-account-changed', 'disabled', 'enabled'] as const;
export type ExpenseEmployeeHistoryType = (typeof EMPLOYEE_HISTORY_TYPES)[number];

export interface CommuterPass {
  readonly id: string;
  /** 経路順の駅の並び（2〜30）。 */
  readonly stations: readonly string[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly note?: string;
}

export interface ExpenseEmployeeHistoryEvent {
  readonly type: ExpenseEmployeeHistoryType;
  readonly by: string;
  readonly at: IsoDateTime;
  readonly note?: string;
}

export interface ExpenseEmployee {
  readonly tenant: TenantScope;
  readonly id: ExpenseEmployeeId;
  /** 社員番号（任意）。 */
  readonly code?: string;
  readonly name: string;
  /** 全角カナ（表示と検索。振込の名義は `bankAccount.holderKana`）。 */
  readonly nameKana?: string;
  readonly departmentId?: ExpenseDepartmentId;
  readonly managerEmployeeId?: ExpenseEmployeeId;
  readonly loginSubjects: readonly string[];
  readonly bankAccount?: BankAccount;
  readonly commuterPasses: readonly CommuterPass[];
  readonly enabled: boolean;
  readonly note?: string;
  readonly history: readonly ExpenseEmployeeHistoryEvent[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateExpenseEmployeeProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly code?: string;
  readonly name: string;
  readonly nameKana?: string;
  readonly departmentId?: string;
  readonly managerEmployeeId?: string;
  readonly loginSubjects?: readonly string[];
  readonly bankAccount?: BankAccount;
  readonly commuterPasses?: readonly CommuterPass[];
  readonly enabled?: boolean;
  readonly note?: string;
  readonly history?: readonly ExpenseEmployeeHistoryEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 応答・ツールに出す形（テナントを除き、口座番号を末尾 4 桁に伏せる）。 */
export type MaskedExpenseEmployee = Omit<ExpenseEmployee, 'tenant' | 'bankAccount'> & { readonly bankAccount?: MaskedBankAccount };

const fail = (message: string, field?: string): ExpenseDomainError => new ExpenseDomainError(message, undefined, field === undefined ? undefined : { field });

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function optionalText(value: unknown, label: string, max: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(`${label} must be at most ${max} characters`, field);
  return trimmed === '' ? undefined : trimmed;
}

/** 社員番号の照合キー（NFKC・空白除去・小文字化）。`expense_employees.code_key`。 */
export function employeeCodeKey(code: string): string {
  return code.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

/** 氏名の照合キー（申請者 `claimantKeyOf` の氏名部分と同じ正規化）。`expense_employees.name_key`。 */
export function employeeNameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

export function validateCommuterPass(value: unknown, label: string): CommuterPass {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`, 'commuterPasses');
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || !EMPLOYEE_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${EMPLOYEE_ID_PATTERN.source}`, 'commuterPasses');
  for (const key of ['validFrom', 'validTo'] as const) {
    if (raw[key] !== undefined && raw[key] !== null && !isIsoDate(raw[key])) throw fail(`${label}.${key} must be a date in YYYY-MM-DD`, 'commuterPasses');
  }
  const validFrom = raw['validFrom'] === null ? undefined : raw['validFrom'] as string | undefined;
  const validTo = raw['validTo'] === null ? undefined : raw['validTo'] as string | undefined;
  if (validFrom !== undefined && validTo !== undefined && validFrom > validTo) throw fail(`${label}.validFrom must not be after validTo`, 'commuterPasses');
  let stations: readonly string[];
  try { stations = validateStations(raw['stations'], `${label}.stations`); } catch (error) { throw fail((error as Error).message, 'commuterPasses'); }
  return withDefined({ id: raw['id'], stations, validFrom, validTo, note: optionalText(raw['note'], `${label}.note`, 200, 'commuterPasses') });
}

function validateHistory(value: unknown, label: string): ExpenseEmployeeHistoryEvent {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!(EMPLOYEE_HISTORY_TYPES as readonly unknown[]).includes(raw['type'])) throw fail(`${label}.type must be one of ${EMPLOYEE_HISTORY_TYPES.join(', ')}`);
  assertNonEmpty(raw['by'], `${label}.by`, (message) => fail(message));
  assertIsoDateTime(raw['at'], `${label}.at`, (message) => fail(message));
  return withDefined({ type: raw['type'] as ExpenseEmployeeHistoryType, by: raw['by'] as string, at: raw['at'] as string, note: optionalText(raw['note'], `${label}.note`, EMPLOYEE_NOTE_MAX, 'history') });
}

/** 従業員を組み立てて不変条件を検証する。`id` が無いときは `emp-` + `makeId()` の先頭 12 文字。 */
export function createExpenseEmployee(props: CreateExpenseEmployeeProps, makeId?: () => string): ExpenseEmployee {
  if (props === null || typeof props !== 'object') throw fail('expense employee: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('expense employee: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'expense employee: tenant.tenantId', (message) => fail(message));
  assertNonEmpty(props.tenant.workspaceId, 'expense employee: tenant.workspaceId', (message) => fail(message));
  const generated = makeId === undefined ? undefined : `emp-${makeId().replaceAll('-', '').slice(0, 12).toLowerCase()}`;
  const id = props.id ?? generated;
  if (typeof id !== 'string' || !EMPLOYEE_ID_PATTERN.test(id)) throw fail(`expense employee: id must match ${EMPLOYEE_ID_PATTERN.source}`, 'id');
  const name = optionalText(props.name, 'expense employee: name', EMPLOYEE_NAME_MAX, 'name');
  if (name === undefined) throw fail('expense employee: name must be a non-empty string', 'name');
  const nameKana = optionalText(props.nameKana, 'expense employee: nameKana', EMPLOYEE_NAME_MAX, 'nameKana');
  if (nameKana !== undefined && !/^[ァ-ヺ・ー　 ]+$/u.test(nameKana)) throw fail('expense employee: nameKana must be full-width katakana', 'nameKana');
  const code = optionalText(props.code, 'expense employee: code', EMPLOYEE_CODE_MAX, 'code');
  const managerEmployeeId = optionalText(props.managerEmployeeId, 'expense employee: managerEmployeeId', 64, 'managerEmployeeId');
  if (managerEmployeeId === id) throw fail('expense employee: managerEmployeeId must not be the employee itself', 'managerEmployeeId');

  const rawSubjects = props.loginSubjects ?? [];
  if (!Array.isArray(rawSubjects) || rawSubjects.length > LOGIN_SUBJECTS_MAX) throw fail(`expense employee: loginSubjects must have at most ${LOGIN_SUBJECTS_MAX} entries`, 'loginSubjects');
  const loginSubjects = rawSubjects.map((subject, index) => {
    if (typeof subject !== 'string' || subject.trim() === '' || subject.trim().length > LOGIN_SUBJECT_MAX) throw fail(`expense employee: loginSubjects[${index}] must be 1 to ${LOGIN_SUBJECT_MAX} characters`, 'loginSubjects');
    return subject.trim();
  });
  if (new Set(loginSubjects).size !== loginSubjects.length) throw fail('expense employee: loginSubjects must not repeat', 'loginSubjects');

  const rawPasses = props.commuterPasses ?? [];
  if (!Array.isArray(rawPasses) || rawPasses.length > COMMUTER_PASSES_MAX) throw fail(`expense employee: commuterPasses must have at most ${COMMUTER_PASSES_MAX} entries`, 'commuterPasses');
  const commuterPasses = rawPasses.map((pass, index) => validateCommuterPass(pass, `expense employee: commuterPasses[${index}]`));
  if (new Set(commuterPasses.map((pass) => pass.id)).size !== commuterPasses.length) throw fail('expense employee: commuterPasses ids must be unique', 'commuterPasses');

  const enabled = props.enabled ?? true;
  if (typeof enabled !== 'boolean') throw fail('expense employee: enabled must be a boolean', 'enabled');
  assertIsoDateTime(props.createdAt, 'expense employee: createdAt', (message) => fail(message));
  assertIsoDateTime(props.updatedAt, 'expense employee: updatedAt', (message) => fail(message));
  const history = (props.history ?? []).map((entry, index) => validateHistory(entry, `expense employee: history[${index}]`)).slice(-EMPLOYEE_HISTORY_MAX);

  return withDefined({
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    code,
    name,
    nameKana,
    departmentId: optionalText(props.departmentId, 'expense employee: departmentId', 64, 'departmentId'),
    managerEmployeeId,
    loginSubjects,
    bankAccount: props.bankAccount === undefined ? undefined : createBankAccount(props.bankAccount, 'expense employee: bankAccount'),
    commuterPasses,
    enabled,
    note: optionalText(props.note, 'expense employee: note', EMPLOYEE_NOTE_MAX, 'note'),
    history,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}

/** 履歴を 1 件足す（溢れたら古いものから落とす。正本は監査ログ）。 */
export function withEmployeeHistory(employee: ExpenseEmployee, event: ExpenseEmployeeHistoryEvent): readonly ExpenseEmployeeHistoryEvent[] {
  return [...employee.history, withDefined(event)].slice(-EMPLOYEE_HISTORY_MAX);
}

/**
 * `managerId` から上長をたどって `employeeId` に戻るか（循環）。`lookup` は他の従業員を引く関数。
 * 20 段を超えたら打ち切って false（たどれない長さの鎖は保存時の検査の対象外）。
 */
export function managerChainReturnsTo(employeeId: string, managerId: string | undefined, lookup: (id: string) => Pick<ExpenseEmployee, 'managerEmployeeId'> | undefined): boolean {
  let current = managerId;
  for (let depth = 0; current !== undefined && depth < MANAGER_CHAIN_MAX; depth += 1) {
    if (current === employeeId) return true;
    current = lookup(current)?.managerEmployeeId;
  }
  return false;
}

/** 直近 `days` 日に口座を変えた履歴（振込データの確認必須の警告 `payout-bank-account-recently-changed`）。 */
export function recentBankAccountChange(employee: Pick<ExpenseEmployee, 'history'>, now: Date, days = 30): ExpenseEmployeeHistoryEvent | undefined {
  const threshold = now.getTime() - days * 24 * 60 * 60 * 1000;
  return [...employee.history].reverse().find((event) => event.type === 'bank-account-changed' && new Date(event.at).getTime() >= threshold);
}

export function maskEmployee(employee: ExpenseEmployee): MaskedExpenseEmployee {
  const { tenant: _tenant, bankAccount, ...rest } = employee;
  return { ...rest, ...(bankAccount === undefined ? {} : { bankAccount: maskBankAccount(bankAccount) }) };
}

/**
 * ドメイン: 組織（ExpenseOrganization。部門と承認グループ。docs/21 §20.2.5。ワークスペースに 1 つ。骨格）。
 *
 * 規程と同じく**未保存なら空の組織を返すが保存しない**（`expense_settings` の kind `organization`）。
 * 部門長・メンバーの従業員の存在は検証しない（従業員は別の集約。解決できないことはチェックの `approval-route-unresolved` で見せる）。
 * `journalDimensionValueId`（仕訳の補助軸の値）も存在を検証しない（仕訳 BC のデータ。仕訳連携の時点で照合する。§20.12）。
 */
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ExpenseDomainError } from './errors';
import type { ExpenseApproverGroupId, ExpenseDepartmentId } from './ids';

export const ORGANIZATION_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
export const ORGANIZATION_MAX_DEPARTMENTS = 500;
export const ORGANIZATION_MAX_GROUPS = 50;
export const GROUP_MAX_MEMBERS = 100;
/** 部門長を親へたどる上限（§20.2.6 `department-head`）。 */
export const DEPARTMENT_HEAD_MAX_DEPTH = 10;
/** 保存したことが無いワークスペースの組織の版。 */
export const DEFAULT_ORGANIZATION_UPDATED_AT = '2026-09-15T00:00:00.000Z';

export interface ExpenseDepartment {
  readonly id: ExpenseDepartmentId;
  readonly code?: string;
  readonly name: string;
  readonly parentId?: ExpenseDepartmentId;
  readonly headEmployeeId?: string;
  readonly journalDimensionValueId?: string;
  readonly enabled: boolean;
}

export interface ExpenseApproverGroup {
  readonly id: ExpenseApproverGroupId;
  readonly name: string;
  readonly memberEmployeeIds: readonly string[];
  readonly enabled: boolean;
}

export interface ExpenseOrganization {
  readonly departments: readonly ExpenseDepartment[];
  readonly approverGroups: readonly ExpenseApproverGroup[];
  readonly updatedAt: IsoDateTime;
}

export interface CreateExpenseOrganizationProps {
  readonly departments?: readonly ExpenseDepartment[];
  readonly approverGroups?: readonly ExpenseApproverGroup[];
  readonly updatedAt: string;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ORGANIZATION_ID_PATTERN.test(value)) throw fail(`${label} must match ${ORGANIZATION_ID_PATTERN.source}`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(`${label} must be at most ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function createExpenseOrganization(props: CreateExpenseOrganizationProps): ExpenseOrganization {
  if (props === null || typeof props !== 'object') throw fail('expense organization: props are required');
  const rawDepartments = props.departments ?? [];
  if (!Array.isArray(rawDepartments) || rawDepartments.length > ORGANIZATION_MAX_DEPARTMENTS) throw fail(`expense organization: departments must have at most ${ORGANIZATION_MAX_DEPARTMENTS} entries`);
  const departments = rawDepartments.map((entry: unknown, index): ExpenseDepartment => {
    const label = `expense organization: departments[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${label} must be an object`);
    const raw = entry as Record<string, unknown>;
    const name = optionalText(raw['name'], `${label}.name`, 100);
    if (name === undefined) throw fail(`${label}.name must be a non-empty string`);
    if (typeof raw['enabled'] !== 'boolean') throw fail(`${label}.enabled must be a boolean`);
    return withDefined({
      id: requireId(raw['id'], `${label}.id`),
      code: optionalText(raw['code'], `${label}.code`, 20),
      name,
      parentId: raw['parentId'] === undefined || raw['parentId'] === null || raw['parentId'] === '' ? undefined : requireId(raw['parentId'], `${label}.parentId`),
      headEmployeeId: optionalText(raw['headEmployeeId'], `${label}.headEmployeeId`, 64),
      journalDimensionValueId: optionalText(raw['journalDimensionValueId'], `${label}.journalDimensionValueId`, 128),
      enabled: raw['enabled'],
    });
  });
  const byId = new Map<string, ExpenseDepartment>();
  for (const department of departments) {
    if (byId.has(department.id)) throw fail(`expense organization: duplicate department id: ${department.id}`);
    byId.set(department.id, department);
  }
  // 名前は有効な部門で一意（CSV・画面で名前から部門を当てるときに決められなくなるため）。
  const names = new Map<string, string>();
  for (const department of departments.filter((entry) => entry.enabled)) {
    const key = nameKey(department.name);
    const holder = names.get(key);
    if (holder !== undefined) throw fail(`expense organization: the department name "${department.name}" is used by both ${holder} and ${department.id}`);
    names.set(key, department.id);
  }
  for (const department of departments) {
    if (department.parentId === undefined) continue;
    if (!byId.has(department.parentId)) throw fail(`expense organization: department ${department.id} refers to an unknown parent ${department.parentId}`);
    const seen = new Set<string>([department.id]);
    let current = byId.get(department.parentId);
    while (current !== undefined) {
      if (seen.has(current.id)) throw fail(`expense organization: the parent chain of department ${department.id} loops back (${[...seen].join(' > ')})`);
      seen.add(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
  }

  const rawGroups = props.approverGroups ?? [];
  if (!Array.isArray(rawGroups) || rawGroups.length > ORGANIZATION_MAX_GROUPS) throw fail(`expense organization: approverGroups must have at most ${ORGANIZATION_MAX_GROUPS} entries`);
  const approverGroups = rawGroups.map((entry: unknown, index): ExpenseApproverGroup => {
    const label = `expense organization: approverGroups[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${label} must be an object`);
    const raw = entry as Record<string, unknown>;
    const name = optionalText(raw['name'], `${label}.name`, 100);
    if (name === undefined) throw fail(`${label}.name must be a non-empty string`);
    if (typeof raw['enabled'] !== 'boolean') throw fail(`${label}.enabled must be a boolean`);
    const members = raw['memberEmployeeIds'];
    if (!Array.isArray(members) || members.length > GROUP_MAX_MEMBERS || members.some((member) => typeof member !== 'string' || member.trim() === '')) {
      throw fail(`${label}.memberEmployeeIds must be an array of at most ${GROUP_MAX_MEMBERS} employee ids`);
    }
    return { id: requireId(raw['id'], `${label}.id`), name, memberEmployeeIds: [...new Set((members as string[]).map((member) => member.trim()))], enabled: raw['enabled'] };
  });
  if (new Set(approverGroups.map((group) => group.id)).size !== approverGroups.length) throw fail('expense organization: approver group ids must be unique');

  assertIsoDateTime(props.updatedAt, 'expense organization: updatedAt', fail);
  return { departments, approverGroups, updatedAt: props.updatedAt };
}

/** 保存したことが無いワークスペースの組織（部門もグループも無い）。 */
export function emptyExpenseOrganization(updatedAt: string = DEFAULT_ORGANIZATION_UPDATED_AT): ExpenseOrganization {
  return { departments: [], approverGroups: [], updatedAt };
}

export function findDepartment(organization: Pick<ExpenseOrganization, 'departments'>, id: string | undefined): ExpenseDepartment | undefined {
  return id === undefined ? undefined : organization.departments.find((department) => department.id === id);
}

export function findApproverGroup(organization: Pick<ExpenseOrganization, 'approverGroups'>, id: string | undefined): ExpenseApproverGroup | undefined {
  return id === undefined ? undefined : organization.approverGroups.find((group) => group.id === id);
}

/**
 * 部門長（部門長が空なら親をたどる。最大 10 段）。見つからなければ undefined。
 * 無効な部門もたどる（部門を無効にしただけで承認者が消えると、承認中の申請が止まるため。有効かどうかは A の解決が判断する）。
 */
export function departmentHeadOf(organization: Pick<ExpenseOrganization, 'departments'>, departmentId: string | undefined): { readonly departmentId: string; readonly headEmployeeId: string } | undefined {
  let current = findDepartment(organization, departmentId);
  for (let depth = 0; current !== undefined && depth <= DEPARTMENT_HEAD_MAX_DEPTH; depth += 1) {
    if (current.headEmployeeId !== undefined) return { departmentId: current.id, headEmployeeId: current.headEmployeeId };
    current = findDepartment(organization, current.parentId);
  }
  return undefined;
}

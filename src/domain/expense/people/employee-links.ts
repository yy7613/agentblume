/**
 * ドメイン: 既存の申請の申請者 → 従業員マスタの紐付け候補（docs/21 §20.1.1 / ADR-0043 §3。系統 A。純関数）。
 *
 * **名前だけで自動の紐付けはしない**（同姓同名・表記揺れで他人の口座・承認経路に結ぶ事故を避ける）。
 * 候補を「社員番号の一致 → 氏名キーの一意な一致」の順に示し、人が選んで確定する。
 * 候補は**有効な従業員だけ**から作る（紐付けの確定は `ClaimantResolver` を通り、無効な従業員は選べないため）。
 */
import type { Claimant } from '../claim';
import { employeeCodeKey, employeeNameKey, type ExpenseEmployee } from '../employee';

export const EMPLOYEE_LINK_MATCHES = ['exact-code', 'unique-name', 'ambiguous', 'none'] as const;
export type EmployeeLinkMatch = (typeof EMPLOYEE_LINK_MATCHES)[number];

export type LinkableEmployee = Pick<ExpenseEmployee, 'id' | 'name' | 'code' | 'departmentId' | 'enabled'>;

export interface EmployeeLinkCandidate {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly departmentId?: string;
}

export interface EmployeeLinkSuggestion {
  readonly match: EmployeeLinkMatch;
  readonly candidates: readonly EmployeeLinkCandidate[];
}

function candidateOf(employee: LinkableEmployee): EmployeeLinkCandidate {
  return {
    id: employee.id,
    name: employee.name,
    ...(employee.code === undefined ? {} : { code: employee.code }),
    ...(employee.departmentId === undefined ? {} : { departmentId: employee.departmentId }),
  };
}

/** 氏名キーが一致する有効な従業員（id 昇順）。判定の `claimant-unlinked` の候補にも使う。 */
export function sameNameEmployees<T extends LinkableEmployee>(name: string, employees: readonly T[]): readonly T[] {
  const key = employeeNameKey(name);
  return employees.filter((employee) => employee.enabled && employeeNameKey(employee.name) === key).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * 1 申請者の候補。社員番号が有効な従業員 1 人と一致 → `exact-code`。そうでなければ氏名キーの一致が 1 人 → `unique-name`、
 * 2 人以上 → `ambiguous`（全員を候補に）、0 人 → `none`。社員番号が一致しない（別人の番号・退職者の番号）ときは氏名で探す。
 */
export function employeeLinkSuggestion(claimant: Pick<Claimant, 'name' | 'employeeCode'>, employees: readonly LinkableEmployee[]): EmployeeLinkSuggestion {
  const enabled = employees.filter((employee) => employee.enabled);
  if (claimant.employeeCode !== undefined && claimant.employeeCode.trim() !== '') {
    const codeKey = employeeCodeKey(claimant.employeeCode);
    const byCode = enabled.filter((employee) => employee.code !== undefined && employeeCodeKey(employee.code) === codeKey);
    if (byCode.length === 1) return { match: 'exact-code', candidates: byCode.map(candidateOf) };
  }
  const byName = sameNameEmployees(claimant.name, enabled);
  if (byName.length === 1) return { match: 'unique-name', candidates: byName.map(candidateOf) };
  if (byName.length > 1) return { match: 'ambiguous', candidates: byName.map(candidateOf) };
  return { match: 'none', candidates: [] };
}

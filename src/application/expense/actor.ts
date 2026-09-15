/**
 * application層: 経費の操作者（ExpenseActor。docs/21 §20.1.2 / ADR-0043 §4）。
 *
 * 新しい認証の仕組みは作らない。api 層が `Principal`（subject・表示名・ロール）から作り、従業員マスタの「ログイン ID」
 * （`loginSubjects`）に subject を持つ有効な従業員がいれば `employeeId` を結ぶ。
 * 単一ユーザーモード（`subject === SINGLE_USER_SUBJECT`）は「そのマシンの利用者が唯一の主体」なので、どの段も代理承認として押せる
 * （承認経路を入れた瞬間にローカル単独利用が承認できなくなるのを避けるため）。代理の可否の判断そのものは A の `actorStepBlockers`。
 */
import { SINGLE_USER_SUBJECT } from '../../domain/security/principal';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { EmployeeDirectoryPort, ExpenseActor } from './ports';

// 型は ports.ts に置く（ports.ts の承認経路のポートが操作者を受け取り、ここが ports.ts を使うため）。既存の import 先を変えないよう再公開する。
export type { ExpenseActor } from './ports';

export function isSingleUserSubject(subject: string): boolean {
  return subject === SINGLE_USER_SUBJECT;
}

/** Principal 相当の値から操作者を作る（従業員の解決に失敗しても操作者は作る。結べないことは承認の拒否理由で見せる）。 */
export async function resolveExpenseActor(
  directory: EmployeeDirectoryPort | undefined,
  scope: TenantScope,
  principal: { readonly subject: string; readonly displayName?: string; readonly roles: readonly string[] },
  canApprove: boolean,
): Promise<ExpenseActor> {
  const employee = directory === undefined ? null : await directory.findBySubject(scope, principal.subject);
  return {
    subject: principal.subject,
    ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }),
    roles: [...principal.roles],
    singleUser: isSingleUserSubject(principal.subject),
    canApprove,
    ...(employee === null || !employee.enabled ? {} : { employeeId: employee.id }),
  };
}

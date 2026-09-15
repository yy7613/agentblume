/**
 * api層: リクエストの主体 → 経費の操作者（`ExpenseActor`。docs/21 §20.1.2 / ADR-0043 §4）。
 *
 * 新しい認証の仕組みは作らない。`principalOf(request)` の subject を従業員マスタの「ログイン ID」で従業員に結び、
 * approve 権限は認可の表（`decideAuthorization`）と同じ判定で決める（経費だけの別の権限表を作らない）。
 * 3 系統のルート（A の「あなたの承認待ち」・B の仮払の承認など）も、この関数で操作者を作る。
 */
import type { FastifyRequest } from 'fastify';
import { resolveExpenseActor, type ExpenseActor } from '../application/expense/actor';
import type { EmployeeDirectoryPort } from '../application/expense/ports';
import { decideAuthorization } from '../domain/security/authorization';
import { principalOf, scopeOf } from './authentication';

export async function expenseActorOf(request: FastifyRequest, directory?: EmployeeDirectoryPort): Promise<ExpenseActor> {
  const principal = principalOf(request);
  const canApprove = decideAuthorization(principal, 'approve', { kind: 'workspace' }).kind === 'allow';
  return resolveExpenseActor(directory, scopeOf(request), principal, canApprove);
}

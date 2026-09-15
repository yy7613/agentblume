import { expect } from 'vitest';
import { employeeNameKey, type ExpenseEmployee } from '../../domain/expense/employee';
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseEmployeeRepository } from '../../domain/expense/repositories';
import { employeeFixture, FIXTURE_EMPLOYEE_IDS, fixtureEmployees, otherTenant, otherWorkspace, scope } from './expense-v9.fixtures';

async function rejection(promise: Promise<unknown>): Promise<ExpenseDomainError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ExpenseDomainError);
  return error as ExpenseDomainError;
}

const ids = (employees: readonly ExpenseEmployee[]): string[] => employees.map((employee) => employee.id);

/** ExpenseEmployeeRepository 実装が満たすべき共有契約（docs/21 §20.8.3）。 */
export async function expenseEmployeeRepositoryContract(repo: ExpenseEmployeeRepository): Promise<void> {
  const { taro, hanako, jiro, saburo, shiro } = FIXTURE_EMPLOYEE_IDS;
  const employees = fixtureEmployees();
  const taroRecord = employees[0] as ExpenseEmployee;

  // 境界: 空のリポジトリ。
  expect(await repo.findById(scope, taro)).toBeNull();
  expect(await repo.findBySubject(scope, 'taro@example.com')).toBeNull();
  expect(await repo.list(scope)).toEqual([]);
  expect(await repo.countEnabled(scope)).toBe(0);

  // 正常: 口座（封緘値）・定期・履歴を含めて欠けずに往復する。
  for (const employee of employees) await repo.save(employee);
  expect(await repo.findById(scope, taro)).toEqual(taroRecord);
  expect((await repo.findById(scope, taro))?.bankAccount?.accountNumber.hint).toBe('0001');
  expect(ids(await repo.findByIds(scope, [shiro, 'missing', taro]))).toEqual([shiro, taro]);
  expect(await repo.findByIds(scope, [])).toEqual([]);

  // 正常: ログイン ID（1 人に複数可）で引ける。
  expect((await repo.findBySubject(scope, 'saburo-sso'))?.id).toBe(saburo);
  expect((await repo.findBySubject(scope, 'saburo@example.com'))?.id).toBe(saburo);
  expect(await repo.findBySubject(scope, 'nobody@example.com')).toBeNull();

  // 正常 / 境界: 社員番号の鍵（有効・無効を問わない。code_key 昇順・重複した鍵は 1 回）。鍵は正規化済みの値で引く。
  expect(ids(await repo.findByCodeKeys(scope, ['e005', 'e001', 'missing', 'e001']))).toEqual([taro, shiro]);
  expect(await repo.findByCodeKeys(scope, ['E001'])).toEqual([]);
  expect(await repo.findByCodeKeys(scope, [])).toEqual([]);

  // 正常: 氏名の鍵の完全一致（id 昇順）。社員番号なしの同姓同名は何人でも登録できる。
  await repo.save(employeeFixture('emp-taro2', { name: 'テスト 太郎' }));
  await repo.save(employeeFixture('emp-taro3', { name: 'テスト太郎', enabled: false }));
  expect(ids(await repo.findByNameKey(scope, employeeNameKey('テスト　太郎')))).toEqual([taro, 'emp-taro2', 'emp-taro3']);
  expect(await repo.findByNameKey(scope, 'テスト')).toEqual([]);

  // 正常: 一覧は有効が先 → name_key 昇順 → id 昇順。
  expect(ids(await repo.list(scope))).toEqual([saburo, taro, 'emp-taro2', jiro, hanako, shiro, 'emp-taro3']);
  expect(ids(await repo.list(scope, { enabled: false }))).toEqual([shiro, 'emp-taro3']);
  expect(ids(await repo.list(scope, { enabled: true, limit: 2 }))).toEqual([saburo, taro]);
  expect(ids(await repo.list(scope, { departmentId: 'dept-sales' }))).toEqual([taro, hanako, shiro]);
  // 正常 / 境界: 検索語は氏名・カナ（半角カナも NFKC で揃う）・社員番号の部分一致。空白だけは絞らない。limit は絞った後。
  expect(ids(await repo.list(scope, { query: 'ﾀﾛｳ' }))).toEqual([taro]);
  expect(ids(await repo.list(scope, { query: 'Ｅ00' }))).toEqual([taro, jiro, hanako, shiro]);
  expect(ids(await repo.list(scope, { query: '太 郎', limit: 2 }))).toEqual([taro, 'emp-taro2']);
  expect(ids(await repo.list(scope, { query: '太郎', enabled: false }))).toEqual(['emp-taro3']);
  expect(ids(await repo.list(scope, { query: '  ', limit: 1 }))).toEqual([saburo]);
  expect(await repo.list(scope, { query: '該当なし' })).toEqual([]);
  // 有効は 4 名（四郎は無効）+ 同姓同名の有効 1 名。
  expect(await repo.countEnabled(scope)).toBe(5);

  // 異常: 社員番号の一意（NFKC・空白・大小を無視。無効な従業員とも重ねない）。何も保存しない。
  const codeClash = await rejection(repo.save(employeeFixture('emp-dup', { code: 'ｅ 001' })));
  expect(codeClash.details).toEqual({ field: 'code', conflictEmployeeId: taro });
  expect(codeClash.message).toContain('ｅ 001');
  expect((await rejection(repo.save(employeeFixture('emp-dup', { code: 'E005' })))).details).toEqual({ field: 'code', conflictEmployeeId: shiro });
  expect(await repo.findById(scope, 'emp-dup')).toBeNull();

  // 異常: ログイン ID の一意。重なりが複数なら辞書順で最初の ID を報告する。
  const subjectClash = await rejection(repo.save(employeeFixture('emp-dup', { loginSubjects: ['zzz@example.com', 'taro@example.com', 'hanako@example.com'] })));
  expect(subjectClash.details).toEqual({ field: 'loginSubjects', conflictEmployeeId: hanako });
  expect(subjectClash.message).toContain('hanako@example.com');
  expect(await repo.findById(scope, 'emp-dup')).toBeNull();
  expect(await repo.findBySubject(scope, 'zzz@example.com')).toBeNull();

  // 正常: 自分自身との重なりは違反ではない（同じ社員番号・ログイン ID のまま更新できる）。
  await repo.save({ ...taroRecord, nameKana: 'テストタロー', updatedAt: '2026-09-16T00:00:00.000Z' });
  expect((await repo.findById(scope, taro))?.nameKana).toBe('テストタロー');

  // 正常: 保存でログイン ID と社員番号の索引が入れ直され、外した値は他の人が使える。
  await repo.save({ ...taroRecord, code: 'E101', loginSubjects: ['taro-new'] });
  expect(await repo.findBySubject(scope, 'taro@example.com')).toBeNull();
  expect((await repo.findBySubject(scope, 'taro-new'))?.id).toBe(taro);
  await repo.save(employeeFixture('emp-dup', { code: 'E001', loginSubjects: ['taro@example.com'] }));
  expect(ids(await repo.findByCodeKeys(scope, ['e001', 'e101']))).toEqual(['emp-dup', taro]);
  expect((await repo.findBySubject(scope, 'taro@example.com'))?.id).toBe('emp-dup');

  // 境界: テナント / ワークスペース分離（同じ社員番号・ログイン ID を別スコープで使える）。
  await repo.save(employeeFixture(taro, { tenant: otherWorkspace, code: 'E002', loginSubjects: ['hanako@example.com'] }));
  expect((await repo.findBySubject(otherWorkspace, 'hanako@example.com'))?.id).toBe(taro);
  expect((await repo.findBySubject(scope, 'hanako@example.com'))?.id).toBe(hanako);
  expect(ids(await repo.findByCodeKeys(otherWorkspace, ['e002']))).toEqual([taro]);
  expect(await repo.findById(otherTenant, taro)).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  expect(await repo.countEnabled(otherWorkspace)).toBe(1);
  expect((await repo.findById(scope, taro))?.code).toBe('E101');

  // 境界: 読み出した値を書き換えても保管庫の中身は変わらない。
  const fetched = await repo.findById(scope, hanako);
  (fetched as unknown as { loginSubjects: string[] }).loginSubjects.push('mutated');
  expect((await repo.findById(scope, hanako))?.loginSubjects).toEqual(['hanako@example.com']);
}

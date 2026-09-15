/**
 * 従業員マスタの登録・編集（docs/21 §20.2.5）。口座番号の封緘と伏せ字、口座の変更の履歴、名義カナの 30 バイト、参照（部門・上長・循環）。
 */
import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_NOW, peopleTestDeps, seedPeople } from '../../../adapters/storage/expense-people-deps.fixtures';
import { fixtureAccountCipher, fixturePayoutSettings, scope } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError, ExpenseEmployeeNotFoundError } from '../../../domain/expense/errors';
import type { BankAccountInput } from '../bank-account-secrets';
import { employeeHistoryFor, GetExpenseEmployeeUseCase, ListExpenseEmployeesUseCase, resolveBankAccount, SaveExpenseEmployeeUseCase, type ExpenseEmployeeInput } from './manage-employees';

const by = 'keiri@example.com';
const account = (overrides: Partial<BankAccountInput> = {}): BankAccountInput => ({ bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: '123', holderKana: 'テスト ゴロウ', ...overrides });
const newEmployee = (overrides: Partial<ExpenseEmployeeInput> = {}): ExpenseEmployeeInput => ({ code: 'E010', name: 'テスト五郎', nameKana: 'テストゴロウ', departmentId: 'dept-sales', managerEmployeeId: 'emp-hanako', loginSubjects: ['goro@example.com'], bankAccount: account(), ...overrides });

async function setup() {
  const deps = peopleTestDeps();
  await seedPeople(deps);
  return { deps, save: new SaveExpenseEmployeeUseCase(deps, () => 'abcdef12-3456-7890-abcd-ef1234567890') };
}

async function domainError(promise: Promise<unknown>): Promise<ExpenseDomainError> {
  try { await promise; } catch (error) { if (error instanceof ExpenseDomainError) return error; throw error; }
  throw new Error('expected ExpenseDomainError');
}

describe('SaveExpenseEmployeeUseCase.create', () => {
  it('正常: 口座番号を 7 桁で封緘して保存し、応答は末尾 4 桁の伏せ字・部門名・上長名・振込データの点検を返す', async () => {
    const { deps, save } = await setup();
    const view = await save.create(scope, newEmployee(), by);
    expect(view).toMatchObject({ id: 'emp-abcdef123456', name: 'テスト五郎', departmentName: '営業部', managerName: 'テスト花子', history: [{ type: 'created', by, at: PEOPLE_NOW }] });
    expect(view.bankAccount).toEqual({ bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumberLast4: '0123', holderKana: 'テスト ゴロウ', changedAt: PEOPLE_NOW, changedBy: by });
    expect(view.payoutReadiness).toEqual({ problems: [], warnings: [], holderKanaConverted: 'ﾃｽﾄ ｺﾞﾛｳ', holderKanaBytes: 8 });
    expect(JSON.stringify(view)).not.toContain('"accountNumber"');
    const stored = await deps.repositories.employees.findById(scope, view.id);
    expect(await fixtureAccountCipher.open(stored!.bankAccount!.accountNumber)).toBe('0000123');
  });

  it('異常: 既に使われている id・組織に無い部門・マスタに無い上長は、直す欄つきの 400', async () => {
    const { save } = await setup();
    expect(await domainError(save.create(scope, newEmployee({ id: 'emp-taro' }), by))).toMatchObject({ details: { field: 'id', conflictEmployeeId: 'emp-taro' } });
    expect(await domainError(save.create(scope, newEmployee({ departmentId: 'dept-ghost' }), by))).toMatchObject({ details: { field: 'departmentId' } });
    expect(await domainError(save.create(scope, newEmployee({ managerEmployeeId: 'emp-ghost' }), by))).toMatchObject({ details: { field: 'managerEmployeeId' } });
  });

  it('境界: 名義カナは変換後 30 バイトまで保存でき、31 バイトは切り詰めずに 400（欄 bankAccount.holderKana と変換結果）', async () => {
    const { save } = await setup();
    expect((await save.create(scope, newEmployee({ code: 'E011', loginSubjects: [], bankAccount: account({ holderKana: 'ガ'.repeat(15) }) }), by)).payoutReadiness.holderKanaBytes).toBe(30);
    const tooLong = await domainError(save.create(scope, newEmployee({ code: 'E012', loginSubjects: [], bankAccount: account({ holderKana: `${'ガ'.repeat(15)}ア` }) }), by));
    expect(tooLong.details).toMatchObject({ field: 'bankAccount.holderKana', converted: { bytes: 31, invalid: [] } });
    const invalid = await domainError(save.create(scope, newEmployee({ code: 'E013', loginSubjects: [], bankAccount: account({ holderKana: 'テスト・ゴロウ' }) }), by));
    expect(invalid.details?.converted?.invalid).toEqual([{ char: '・', index: 3 }]);
  });

  it('異常: 口座番号のハイフンは黙って外さず 400、新しい口座に口座番号が無ければ 400（どちらも口座番号の欄）', async () => {
    const { save } = await setup();
    expect((await domainError(save.create(scope, newEmployee({ bankAccount: account({ accountNumber: '000-123' }) }), by))).details?.field).toBe('bankAccount.accountNumber');
    expect((await domainError(save.create(scope, newEmployee({ bankAccount: account({ accountNumber: '' }) }), by))).details?.field).toBe('bankAccount.accountNumber');
  });

  it('異常: 社員番号・ログイン ID の一意違反は重なった従業員つき（リポジトリの検査）', async () => {
    const { save } = await setup();
    expect((await domainError(save.create(scope, newEmployee({ code: 'e001' }), by))).details).toEqual({ field: 'code', conflictEmployeeId: 'emp-taro' });
    expect((await domainError(save.create(scope, newEmployee({ loginSubjects: ['hanako@example.com'] }), by))).details).toEqual({ field: 'loginSubjects', conflictEmployeeId: 'emp-hanako' });
  });
});

describe('SaveExpenseEmployeeUseCase.update', () => {
  it('正常: 口座番号を送らなければ封緘値と変更日時を保ち、口座の履歴を残さない。他の欄の変更は edited', async () => {
    const { deps, save } = await setup();
    const before = (await deps.repositories.employees.findById(scope, 'emp-taro'))!;
    const view = await save.update(scope, 'emp-taro', { name: 'テスト太郎', code: 'E001', nameKana: 'テストタロウ', departmentId: 'dept-sales', managerEmployeeId: 'emp-hanako', loginSubjects: ['taro@example.com'], commuterPasses: before.commuterPasses, note: '異動予定', bankAccount: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', holderKana: 'テスト タロウ' } }, by);
    const after = (await deps.repositories.employees.findById(scope, 'emp-taro'))!;
    expect(after.bankAccount).toEqual(before.bankAccount);
    expect(view.history.map((event) => event.type)).toEqual(['created', 'edited']);
    expect(view.bankAccount?.accountNumberLast4).toBe('0001');
  });

  it('正常: 口座番号の入れ直し・名義の変更・口座を外すは必ず bank-account-changed を残す（すり替え対策）', async () => {
    const { deps, save } = await setup();
    const base = { name: 'テスト花子', code: 'E002', nameKana: 'テストハナコ', departmentId: 'dept-sales', managerEmployeeId: 'emp-jiro', loginSubjects: ['hanako@example.com'] };
    await save.update(scope, 'emp-hanako', { ...base, bankAccount: account({ accountNumber: '7654321', holderKana: 'テスト ハナコ' }) }, 'editor@example.com');
    let stored = (await deps.repositories.employees.findById(scope, 'emp-hanako'))!;
    expect(stored.bankAccount).toMatchObject({ changedAt: PEOPLE_NOW, changedBy: 'editor@example.com' });
    expect(await fixtureAccountCipher.open(stored.bankAccount!.accountNumber)).toBe('7654321');
    const sealed = stored.bankAccount!.accountNumber;
    await save.update(scope, 'emp-hanako', { ...base, bankAccount: account({ accountNumber: undefined, holderKana: 'テスト ハナ' }) }, by);
    stored = (await deps.repositories.employees.findById(scope, 'emp-hanako'))!;
    expect(stored.bankAccount?.accountNumber).toEqual(sealed);
    const removed = await save.update(scope, 'emp-hanako', { ...base, bankAccount: null }, by);
    expect(removed.bankAccount).toBeUndefined();
    expect(removed.history.map((event) => event.type)).toEqual(['created', 'bank-account-changed', 'bank-account-changed', 'bank-account-changed']);
    expect(removed.payoutReadiness.problems.map((problem) => problem.code)).toEqual(['payout-bank-account-missing']);
  });

  it('正常: 無効化・有効化は履歴に残り、何も変わらなければ保存しない', async () => {
    const { deps, save } = await setup();
    const jiro = { name: 'テスト次郎', code: 'E003', nameKana: 'テストジロウ', departmentId: 'dept-admin', loginSubjects: ['jiro@example.com'] };
    expect((await save.update(scope, 'emp-jiro', { ...jiro, enabled: false }, by)).history.map((event) => event.type)).toEqual(['created', 'disabled']);
    expect((await save.update(scope, 'emp-jiro', { ...jiro, enabled: true }, by)).history.map((event) => event.type)).toEqual(['created', 'disabled', 'enabled']);
    const spy = vi.spyOn(deps.repositories.employees, 'save');
    const same = await save.update(scope, 'emp-jiro', jiro, by);
    expect(spy).not.toHaveBeenCalled();
    expect(same.history).toHaveLength(3);
  });

  it('異常: 上長に本人・上長をたどって本人に戻る循環は 400、無い従業員は 404', async () => {
    const { save } = await setup();
    const jiro = { name: 'テスト次郎', code: 'E003', departmentId: 'dept-admin' };
    expect((await domainError(save.update(scope, 'emp-jiro', { ...jiro, managerEmployeeId: 'emp-jiro' }, by))).details).toEqual({ field: 'managerEmployeeId' });
    // 太郎 → 花子 → 次郎 なので、次郎の上長を太郎にすると循環する。
    expect((await domainError(save.update(scope, 'emp-jiro', { ...jiro, managerEmployeeId: 'emp-taro' }, by))).details).toEqual({ field: 'managerEmployeeId', employeeId: 'emp-taro' });
    await expect(save.update(scope, 'emp-ghost', jiro, by)).rejects.toBeInstanceOf(ExpenseEmployeeNotFoundError);
  });
});

describe('一覧と取得', () => {
  it('正常: 検索・有効・部門で絞り、一覧に居ない上長の名前も引く。振込元の書式設定（銀行名を入れる）で点検する', async () => {
    const { deps } = await setup();
    await deps.repositories.settings.save(scope, 'payout', { ...fixturePayoutSettings(), format: { ...fixturePayoutSettings().format, includeBankNames: true } });
    const list = new ListExpenseEmployeesUseCase(deps);
    const sales = await list.execute(scope, { departmentId: 'dept-sales', enabled: true });
    expect(sales.map((employee) => [employee.id, employee.managerName, employee.departmentName])).toEqual([['emp-taro', 'テスト花子', '営業部'], ['emp-hanako', 'テスト次郎', '営業部']]);
    expect(sales[0]?.payoutReadiness.problems.map((problem) => problem.code)).toEqual(['payout-bank-name-missing']);
    expect((await list.execute(scope, { query: 'e00' })).map((employee) => employee.id)).toEqual(['emp-taro', 'emp-jiro', 'emp-hanako', 'emp-shiro']);
    const get = new GetExpenseEmployeeUseCase(deps);
    expect((await get.execute(scope, 'emp-saburo')).managerName).toBe('テスト次郎');
    await expect(get.execute(scope, 'emp-ghost')).rejects.toBeInstanceOf(ExpenseEmployeeNotFoundError);
  });
});

describe('resolveBankAccount / employeeHistoryFor', () => {
  it('例外: 封緘の失敗は欄のない domain の失敗なら口座の欄に寄せ、それ以外の例外はそのまま投げる', async () => {
    const domainFailure = { seal: async () => { throw new ExpenseDomainError('broken'); }, open: fixtureAccountCipher.open };
    expect((await domainError(resolveBankAccount({ cipher: domainFailure }, account(), undefined, by, PEOPLE_NOW))).details?.field).toBe('bankAccount');
    const crash = { seal: async () => { throw new TypeError('crash'); }, open: fixtureAccountCipher.open };
    await expect(resolveBankAccount({ cipher: crash }, account(), undefined, by, PEOPLE_NOW)).rejects.toBeInstanceOf(TypeError);
    expect(await resolveBankAccount({ cipher: crash }, undefined, undefined, by, PEOPLE_NOW)).toBeUndefined();
  });

  it('正常: 新規は created だけ（口座の登録は変更として数えない）', () => {
    expect(employeeHistoryFor(undefined, { tenant: scope, id: 'x', name: 'x', loginSubjects: [], commuterPasses: [], enabled: true, createdAt: PEOPLE_NOW, updatedAt: PEOPLE_NOW }, by, PEOPLE_NOW)).toEqual([{ type: 'created', by, at: PEOPLE_NOW }]);
  });
});

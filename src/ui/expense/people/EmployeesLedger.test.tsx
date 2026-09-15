// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiTransport } from '../../api/business-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseEmployeeDto, ExpenseEmployeeLinkDto, ExpenseMaskedBankAccountDto } from '../../api/expense-people-types';
import { ApiError } from '../../api/tool-api';
import type { ExpenseFocusRequest } from '../expense-shared';
import { EmployeesLedger } from './EmployeesLedger';

afterEach(cleanup);

const scope = { tenantId: 't', workspaceId: 'w' };
const account: ExpenseMaskedBankAccountDto = { bankCode: '0001', branchCode: '001', accountType: 'ordinary', accountNumberLast4: '0001', holderKana: 'ﾃｽﾄ ﾀﾛｳ', changedAt: 'x', changedBy: 'u1' };

function employee(overrides: Partial<ExpenseEmployeeDto> = {}): ExpenseEmployeeDto {
  return {
    id: 'e1', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'd1', departmentName: '営業部', loginSubjects: [], commuterPasses: [], enabled: true,
    history: [{ type: 'created', by: 'u1', at: '2026-09-01T00:00:00.000Z' }], createdAt: 'x', updatedAt: 'x', payoutReadiness: { problems: [], warnings: [] }, ...overrides,
  };
}
const taro = employee({ bankAccount: account });
const organization = { organization: { departments: [{ id: 'd1', name: '営業部', enabled: true }], approverGroups: [], updatedAt: 'x' }, saved: true };

type Handler = (body: Record<string, unknown> | undefined, path: string) => unknown;

function makeTransport(handlers: Readonly<Record<string, Handler>>, employees: readonly ExpenseEmployeeDto[] = [taro]) {
  const all: Record<string, Handler> = {
    'GET /expense/employees': () => ({ employees }),
    'GET /expense/organization': () => organization,
    'GET /expense/claims/employee-links': () => ({ links: [] }),
    ...handlers,
  };
  return vi.fn(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? ''}`;
    const handler = all[key];
    if (handler === undefined) throw new Error(`unexpected ${key}`);
    return handler(init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>, path);
  });
}

function renderLedger(request: ReturnType<typeof makeTransport>, focus?: ExpenseFocusRequest) {
  const onClaimsChanged = vi.fn().mockResolvedValue(undefined);
  render(<EmployeesLedger transport={{ request: request as unknown as ApiTransport['request'] }} scope={scope} onOpen={vi.fn()} policy={undefined} claims={[]} chart={undefined} capabilities={undefined}
    onClaimsChanged={onClaimsChanged} onReloadPolicy={vi.fn()} onTab={vi.fn()} focus={focus} />);
  return { onClaimsChanged };
}

const calls = (request: ReturnType<typeof makeTransport>, key: string) => request.mock.calls.filter(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(path).split('?')[0]}` === key);
const bodyOf = (request: ReturnType<typeof makeTransport>, key: string, index = 0) => JSON.parse(String((calls(request, key)[index]?.[1] as RequestInit).body)) as Record<string, unknown>;

async function openEdit(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return screen.findByRole('region', { name: `Edit ${name}` });
}

describe('EmployeesLedger', () => {
  it('正常: 一覧に振込データに使えるかの印を出し、検索・状態・部門で絞り込む。口座番号の封緘と鍵ファイルを明示する', async () => {
    const hanako = employee({
      id: 'e2', code: 'E002', name: '山田花子', nameKana: 'ヤマダハナコ', departmentId: 'd2', departmentName: '経理部', enabled: false, bankAccount: { ...account, accountNumberLast4: '9999' },
      payoutReadiness: { problems: [{ code: 'holder-kana-invalid', field: 'bankAccount.holderKana', message: '名義カナに使えない文字があります。口座名義を直してください', fixTarget: 'employee' }], warnings: [] },
    });
    const jiro = employee({ id: 'e3', code: 'E003', name: '佐藤次郎', nameKana: undefined });
    renderLedger(makeTransport({}, [taro, hanako, jiro]));
    const region = await screen.findByRole('region', { name: 'Employees & organization' });
    await within(region).findByText('テスト太郎');
    expect(within(region).getByText('Account numbers are sealed with the key file (the same key as the model settings) before they are saved. To restore from a database backup, you also need the key file.')).toBeTruthy();
    expect(within(region).getByText('***0001')).toBeTruthy();
    expect(within(region).getByText('Ready for transfer')).toBeTruthy();
    expect(within(region).getByText('Not usable for transfer').getAttribute('title')).toContain('名義カナ');
    expect(within(region).getByText('No account')).toBeTruthy();

    await userEvent.type(within(region).getByLabelText('Search by name, kana, or employee code'), 'ﾔﾏﾀﾞ');
    expect(within(region).queryByText('テスト太郎')).toBeNull();
    expect(within(region).getByText('山田花子')).toBeTruthy();
    await userEvent.selectOptions(within(region).getByLabelText('Status filter'), 'enabled');
    expect(within(region).getByText('No employees match the filters.')).toBeTruthy();
    await userEvent.clear(within(region).getByLabelText('Search by name, kana, or employee code'));
    await userEvent.selectOptions(within(region).getByLabelText('Department filter'), 'd1');
    expect(within(region).getByText('テスト太郎')).toBeTruthy();
    expect(within(region).getByText('佐藤次郎')).toBeTruthy();
    expect(within(region).queryByText('山田花子')).toBeNull();
  });

  it('境界: 従業員がいなければ赤くせず、CSV で一括登録か 1 人ずつ追加する案内と見本の場所を出し、紐付け候補は読まない', async () => {
    const request = makeTransport({}, []);
    renderLedger(request);
    expect(await screen.findByText('No employees yet. Import them with a CSV or add them one by one.')).toBeTruthy();
    expect(screen.getByText('A sample CSV is at samples/expense/employees.csv.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls(request, 'GET /expense/claims/employee-links')).toHaveLength(0);
  });

  it('正常: 新規登録は口座番号を送り、ハイフン・空白を外したことを見せ、保存後に変換後の名義と点検を見せる', async () => {
    const created = employee({
      id: 'emp-1', code: undefined, bankAccount: { ...account, accountNumberLast4: '4567', holderKana: 'テスト タロウ' },
      payoutReadiness: { problems: [], warnings: [{ code: 'bank-account-recently-changed', message: '口座が直近に変わりました。振込の前に本人に確認してください', fixTarget: 'employee' }], holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', holderKanaBytes: 8 },
    });
    const request = makeTransport({ 'POST /expense/employees': () => ({ employee: created }) }, []);
    renderLedger(request);
    await screen.findByText('No employees yet. Import them with a CSV or add them one by one.');
    await userEvent.click(screen.getByRole('button', { name: 'Add an employee' }));
    const form = await screen.findByRole('region', { name: 'Add an employee' });
    await userEvent.type(within(form).getByLabelText('Name'), 'テスト太郎');
    await userEvent.click(within(form).getByLabelText('Register a bank account'));
    await userEvent.type(within(form).getByLabelText('Bank code'), '0001');
    await userEvent.type(within(form).getByLabelText('Branch code'), '001');
    fireEvent.change(within(form).getByLabelText('Account number'), { target: { value: '123-4567' } });
    expect((within(form).getByLabelText('Account number') as HTMLInputElement).value).toBe('1234567');
    expect(within(form).getByText('Removed hyphens and spaces (you entered "123-4567"). The value saved is 1234567.')).toBeTruthy();
    await userEvent.type(within(form).getByLabelText('Account holder (kana)'), 'テスト タロウ');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));

    await waitFor(() => expect(calls(request, 'POST /expense/employees')).toHaveLength(1));
    expect(bodyOf(request, 'POST /expense/employees')).toEqual({
      scope, name: 'テスト太郎', loginSubjects: [], enabled: true, commuterPasses: [],
      bankAccount: { bankCode: '0001', branchCode: '001', accountType: 'ordinary', holderKana: 'テスト タロウ', accountNumber: '1234567' },
    });
    const saved = await screen.findByRole('region', { name: 'Edit テスト太郎' });
    expect(within(saved).getByText(/^Saved テスト太郎\./)).toBeTruthy();
    const check = within(saved).getByRole('region', { name: 'Transfer file check' });
    expect(within(check).getByText('ﾃｽﾄ ﾀﾛｳ')).toBeTruthy();
    expect(within(check).getByText(/\(8 bytes\)/)).toBeTruthy();
    expect(within(check).getByText('口座が直近に変わりました。振込の前に本人に確認してください')).toBeTruthy();
    expect(within(saved).getByText('***4567')).toBeTruthy();
    // 保存した従業員は一覧にも出る。
    expect(within(screen.getByRole('region', { name: 'Employees & organization' })).getByRole('button', { name: 'Edit テスト太郎' })).toBeTruthy();
  });

  it('異常: 画面で分かる誤り（氏名なし）は送らずにその欄へフォーカスする', async () => {
    const request = makeTransport({}, []);
    renderLedger(request);
    await userEvent.click(await screen.findByRole('button', { name: 'Add an employee' }));
    const form = await screen.findByRole('region', { name: 'Add an employee' });
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    expect(within(form).getByText('Enter the name.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-people-employee-name'));
    expect(calls(request, 'POST /expense/employees')).toHaveLength(0);
  });

  it('正常: 編集は伏せ字を出し、「変更する」を押さなければ口座番号を送らず、押したときだけ送る', async () => {
    const request = makeTransport({ 'PUT /expense/employees/e1': () => ({ employee: taro }) });
    renderLedger(request);
    const form = await openEdit('テスト太郎');
    expect(within(form).getByText('***0001')).toBeTruthy();
    expect(within(form).queryByLabelText('Account number')).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    await waitFor(() => expect(calls(request, 'PUT /expense/employees/e1')).toHaveLength(1));
    const first = bodyOf(request, 'PUT /expense/employees/e1');
    expect(first['bankAccount']).toEqual({ bankCode: '0001', branchCode: '001', accountType: 'ordinary', holderKana: 'ﾃｽﾄ ﾀﾛｳ' });
    expect(first).not.toHaveProperty('id');

    await userEvent.click(within(form).getByRole('button', { name: 'Change the account number' }));
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-people-account-number'));
    await userEvent.type(within(form).getByLabelText('Account number'), '7654321');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    await waitFor(() => expect(calls(request, 'PUT /expense/employees/e1')).toHaveLength(2));
    expect(bodyOf(request, 'PUT /expense/employees/e1', 1)['bankAccount']).toMatchObject({ accountNumber: '7654321' });
  });

  it('異常: 名義カナの 400 は変換後の形と直す文字・バイト数を平易に出してその欄へフォーカスし、口座番号の 400 は入力欄を開いてフォーカスする', async () => {
    let count = 0;
    const request = makeTransport({
      'PUT /expense/employees/e1': () => {
        count += 1;
        if (count === 1) throw new ApiError(400, 'EXPENSE_DOMAIN', 'bankAccount.holderKana is invalid', undefined, { details: { field: 'bankAccount.holderKana', converted: { text: 'ﾃｽﾄ･ﾀﾛｳ ｶﾌﾞｼｷｶﾞｲｼﾔ ｴｲｷﾞﾖｳﾌﾞ', bytes: 34, invalid: [{ char: '・', index: 3 }] } } });
        throw new ApiError(400, 'EXPENSE_DOMAIN', 'bankAccount.accountNumber is invalid', undefined, { details: { field: 'bankAccount.accountNumber' } });
      },
    });
    renderLedger(request);
    const form = await openEdit('テスト太郎');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    const problem = await within(form).findByText(/34 bytes, over the 30-byte limit/);
    expect(problem.textContent).toContain('「・」(4)');
    expect(problem.textContent).toContain('Converted: ﾃｽﾄ･ﾀﾛｳ');
    expect(within(form).getByText(/never cut automatically/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-people-holder-kana'));

    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    expect(await within(form).findByText(/Enter 1 to 7 digits without hyphens\./)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-people-account-number'));
  });

  it('異常: 社員番号の一意違反は相手の従業員を開くボタンを出す', async () => {
    const other = employee({ id: 'e2', code: 'E002', name: '山田花子' });
    const request = makeTransport({ 'PUT /expense/employees/e1': () => { throw new ApiError(400, 'EXPENSE_DOMAIN', 'duplicate code', undefined, { details: { field: 'code', conflictEmployeeId: 'e2' } }); } }, [taro, other]);
    renderLedger(request);
    const form = await openEdit('テスト太郎');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    expect(await within(form).findByText(/already uses this employee code/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Open that employee' }));
    expect(await screen.findByRole('region', { name: 'Edit 山田花子' })).toBeTruthy();
  });

  it('正常: ゆうちょの記号・番号の変換結果を並べ、「この値で入れる」を押したときだけ口座欄に入れる', async () => {
    renderLedger(makeTransport({}, []));
    await userEvent.click(await screen.findByRole('button', { name: 'Add an employee' }));
    const form = await screen.findByRole('region', { name: 'Add an employee' });
    await userEvent.click(within(form).getByLabelText('Register a bank account'));
    await userEvent.click(within(form).getByRole('button', { name: 'Convert from a Japan Post Bank symbol and number' }));
    await userEvent.type(within(form).getByLabelText('Symbol (5 digits)'), '99999');
    await userEvent.click(within(form).getByRole('button', { name: 'Convert' }));
    expect(within(form).getByText(/The symbol must be 5 digits starting with 1/)).toBeTruthy();

    await userEvent.clear(within(form).getByLabelText('Symbol (5 digits)'));
    await userEvent.type(within(form).getByLabelText('Symbol (5 digits)'), '12345');
    await userEvent.type(within(form).getByLabelText('Number'), '12345671');
    await userEvent.click(within(form).getByRole('button', { name: 'Convert' }));
    const converted = within(form).getByLabelText('Converted values');
    expect(within(converted).getByText('9900')).toBeTruthy();
    expect(within(converted).getByText('238')).toBeTruthy();
    expect(within(converted).getByText('1234567')).toBeTruthy();
    expect((within(form).getByLabelText('Bank code') as HTMLInputElement).value).toBe('');

    await userEvent.click(within(form).getByRole('button', { name: 'Use these values' }));
    expect((within(form).getByLabelText('Bank code') as HTMLInputElement).value).toBe('9900');
    expect((within(form).getByLabelText('Branch code') as HTMLInputElement).value).toBe('238');
    expect((within(form).getByLabelText('Account type') as HTMLSelectElement).value).toBe('ordinary');
    expect((within(form).getByLabelText('Account number') as HTMLInputElement).value).toBe('1234567');
  });

  it('正常: 通勤定期を「>」区切りで入れて保存本文の駅の配列にし、4 件目は足せない', async () => {
    const request = makeTransport({ 'PUT /expense/employees/e1': () => ({ employee: taro }) });
    renderLedger(request);
    const form = await openEdit('テスト太郎');
    const add = within(form).getByRole('button', { name: 'Add a commuter pass' });
    await userEvent.click(add);
    fireEvent.change(within(form).getByLabelText('Pass 1 stations'), { target: { value: '新宿 > 代々木\n東京' } });
    fireEvent.change(within(form).getByLabelText('Pass 1 valid to'), { target: { value: '2027-03-31' } });
    await userEvent.click(add);
    await userEvent.click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(form).getByRole('button', { name: 'Remove Pass 3' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Remove Pass 2' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save the employee' }));
    await waitFor(() => expect(calls(request, 'PUT /expense/employees/e1')).toHaveLength(1));
    expect(bodyOf(request, 'PUT /expense/employees/e1')['commuterPasses']).toEqual([{ id: 'pass-1', stations: ['新宿', '代々木', '東京'], validTo: '2027-03-31' }]);
  });

  it('正常: 組織は部門（親・部門長）と承認グループ（メンバー）を編集して保存し、空の名前は保存前に止める', async () => {
    const request = makeTransport({ 'PUT /expense/organization': (body) => ({ organization: { departments: body?.['departments'], approverGroups: body?.['approverGroups'], updatedAt: 'y' } }) });
    renderLedger(request);
    const section = await screen.findByRole('region', { name: 'Organization' });
    await waitFor(() => expect((within(section).getByLabelText('Name of department 1') as HTMLInputElement).value).toBe('営業部'));
    const save = within(section).getByRole('button', { name: 'Save the organization' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await userEvent.click(within(section).getByRole('button', { name: 'Add a department' }));
    expect(within(within(section).getByRole('note', { name: 'Fix before saving the organization' })).getByText('Department 2: enter a name.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    await userEvent.type(within(section).getByLabelText('Name of department 2'), '経理部');
    await userEvent.selectOptions(within(section).getByLabelText('Parent of 経理部'), 'd1');
    await userEvent.selectOptions(within(section).getByLabelText('Head of 経理部'), 'e1');
    await userEvent.click(within(section).getByRole('button', { name: 'Add an approver group' }));
    await userEvent.type(within(section).getByLabelText('Name of group 1'), '経理');
    await userEvent.click(within(within(section).getByRole('group', { name: 'Members of 経理' })).getByLabelText('テスト太郎'));
    await userEvent.click(save);

    await waitFor(() => expect(calls(request, 'PUT /expense/organization')).toHaveLength(1));
    expect(bodyOf(request, 'PUT /expense/organization')).toEqual({
      scope,
      departments: [{ id: 'd1', name: '営業部', enabled: true }, { id: 'dept-2', name: '経理部', enabled: true, parentId: 'd1', headEmployeeId: 'e1' }],
      approverGroups: [{ id: 'group-1', name: '経理', memberEmployeeIds: ['e1'], enabled: true }],
    });
    expect(await within(section).findByText('Saved the organization.')).toBeTruthy();
  });

  it('正常: 貼り付けた CSV の取込結果（件数・飛ばした行）を見せて一覧を読み直し、400 は行番号と足りない列を出す', async () => {
    let count = 0;
    const request = makeTransport({
      'POST /expense/employees/import': () => {
        count += 1;
        if (count === 1) return { result: { created: 2, updated: 1, unchanged: 0, skippedRows: [{ row: 4, reason: 'name is empty' }], warnings: ['manager_code E999 was not found'] } };
        throw new ApiError(400, 'EXPENSE_EMPLOYEE_CSV_IMPORT', 'missing columns', undefined, { details: { row: 3, missingColumns: ['name'] } });
      },
    });
    renderLedger(request);
    const panel = await screen.findByRole('region', { name: 'Employee CSV' });
    expect(within(panel).getByText(/Sample: samples\/expense\/employees\.csv/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Pasted employee CSV'), { target: { value: 'code,name\nE001,テスト太郎' } });
    await userEvent.click(within(panel).getByRole('button', { name: 'Import the pasted CSV' }));
    const result = await within(panel).findByRole('status', { name: 'Import result' });
    expect(within(result).getByText('Created 2, updated 1, unchanged 0.')).toBeTruthy();
    expect(within(result).getByText('Row 4: name is empty')).toBeTruthy();
    expect(within(result).getByText('manager_code E999 was not found')).toBeTruthy();
    expect(bodyOf(request, 'POST /expense/employees/import')).toEqual({ scope, content: 'code,name\nE001,テスト太郎' });
    await waitFor(() => expect(calls(request, 'GET /expense/employees')).toHaveLength(2));

    await userEvent.click(within(panel).getByRole('button', { name: 'Import the pasted CSV' }));
    const alert = await within(panel).findByRole('alert');
    expect(within(alert).getByText('Row 3 of the CSV could not be imported. Fix that row and import again.')).toBeTruthy();
    expect(within(alert).getByText(/^Missing columns: name\./)).toBeTruthy();
  });

  it('異常: 口座つき出力の 403 は承認権限が要ると説明し、開封できない口座はその従業員の口座番号の入れ直しへ導く', async () => {
    let count = 0;
    const request = makeTransport({
      'GET /expense/employees/export': () => ({ content: 'id,code\n', fileName: 'employees.csv' }),
      'GET /expense/employees/export-bank-accounts': () => {
        count += 1;
        if (count === 1) throw new ApiError(403, 'FORBIDDEN', 'forbidden');
        throw new ApiError(400, 'EXPENSE_DOMAIN', 'cannot open the sealed account number', undefined, { details: { employeeId: 'e1' } });
      },
    });
    renderLedger(request);
    const panel = await screen.findByRole('region', { name: 'Employee CSV' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Export employees CSV' }));
    await waitFor(() => expect(within(panel).queryByText('Exported employees.csv.') ?? within(panel).queryByLabelText('Exported employee CSV')).toBeTruthy());

    await userEvent.click(within(panel).getByRole('button', { name: 'Export with account numbers (approvers only)' }));
    expect(await within(panel).findByText('Approval permission is required')).toBeTruthy();
    expect(within(panel).getByText(/Only people who can approve claims can export account numbers/)).toBeTruthy();

    await userEvent.click(within(panel).getByRole('button', { name: 'Export with account numbers (approvers only)' }));
    expect(await within(panel).findByText('An account number could not be opened')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: "Re-enter the account number in that employee's account" }));
    const form = await screen.findByRole('region', { name: 'Edit テスト太郎' });
    expect(within(form).getByLabelText('Account number')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-people-account-number'));
  });

  it('正常: 紐付け候補は社員番号の一致を既定でチェックし、409 は承認中の申請を外す導線を出し、確定の結果を見せて申請一覧を読み直す', async () => {
    const links: readonly ExpenseEmployeeLinkDto[] = [
      { claimId: 'c1', claimant: { name: 'テスト太郎', employeeCode: 'E001' }, status: 'in-approval', match: 'exact-code', candidates: [{ id: 'e1', name: 'テスト太郎', code: 'E001' }] },
      { claimId: 'c2', claimant: { name: '山田' }, status: 'checked', match: 'ambiguous', candidates: [{ id: 'e2', name: '山田 花子' }, { id: 'e3', name: '山田 次郎', department: '経理部' }] },
      { claimId: 'c3', claimant: { name: '未登録' }, status: 'draft', match: 'none', candidates: [] },
    ];
    let count = 0;
    const request = makeTransport({
      'GET /expense/claims/employee-links': () => ({ links }),
      'POST /expense/claims/employee-links': () => {
        count += 1;
        if (count === 1) throw new ApiError(409, 'EXPENSE_TRANSITION', 'claims in approval', undefined, { details: { claims: [{ claimId: 'c1', status: 'in-approval' }] } });
        return { result: { linked: 1, movedToDraft: 1, skipped: [] } };
      },
    });
    const { onClaimsChanged } = renderLedger(request);
    const panel = await screen.findByRole('region', { name: 'Link claims to employees' });
    const c1 = await within(panel).findByLabelText('Link テスト太郎 (c1)') as HTMLInputElement;
    expect(c1.checked).toBe(true);
    expect((within(panel).getByLabelText('Link 山田 (c2)') as HTMLInputElement).checked).toBe(false);
    expect((within(panel).getByLabelText('Link 未登録 (c3)') as HTMLInputElement).disabled).toBe(true);
    expect(within(panel).getByText('Employee code matches')).toBeTruthy();
    expect(calls(request, 'POST /expense/claims/employee-links')).toHaveLength(0);

    await userEvent.click(within(panel).getByRole('button', { name: 'Link the 1 selected claims' }));
    expect(await within(panel).findByText('Claims in approval cannot be linked (nothing was saved)')).toBeTruthy();
    expect(within(panel).getByText('テスト太郎 (c1)')).toBeTruthy();
    expect(onClaimsChanged).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Uncheck the claims in approval' }));
    expect(c1.checked).toBe(false);
    expect((within(panel).getByRole('button', { name: 'Link the 0 selected claims' }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(within(panel).getByLabelText('Employee for 山田 (c2)'), 'e3');
    expect((within(panel).getByLabelText('Link 山田 (c2)') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(panel).getByRole('button', { name: 'Link the 1 selected claims' }));
    expect(await within(panel).findByText(/Linked 1 claims\..*1 checked or returned claims went back to draft; check them again\./)).toBeTruthy();
    expect(bodyOf(request, 'POST /expense/claims/employee-links', 1)).toEqual({ scope, links: [{ claimId: 'c2', employeeId: 'e3' }] });
    expect(onClaimsChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls(request, 'GET /expense/claims/employee-links')).toHaveLength(2));
  });

  it('正常: 導線 employee-commuter / employee はその従業員の編集を開いて定期欄・口座欄へ、organization は部門の行を強調する', async () => {
    renderLedger(makeTransport({}), { tab: 'employees', section: 'employee-commuter', id: 'e1', seq: 1 });
    expect(await screen.findByRole('region', { name: 'Edit テスト太郎' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.closest('#expense-people-commuter')).not.toBeNull());
    cleanup();

    renderLedger(makeTransport({}), { tab: 'employees', section: 'employee', id: 'e1', seq: 2 });
    await screen.findByRole('region', { name: 'Edit テスト太郎' });
    await waitFor(() => expect(document.activeElement?.closest('#expense-people-bank')).not.toBeNull());
    cleanup();

    renderLedger(makeTransport({}), { tab: 'employees', section: 'organization', id: 'd1', seq: 3 });
    await waitFor(() => expect(document.getElementById('expense-people-department-d1')?.className).toContain('expense-people-highlight'));
  });

  it('異常: 導線の従業員が一覧に無く、取得もできなければ原因を出す', async () => {
    const request = makeTransport({ 'GET /expense/employees/e404': () => { throw new ApiError(404, 'EXPENSE_EMPLOYEE_NOT_FOUND', 'not found'); } });
    renderLedger(request, { tab: 'employees', section: 'employee', id: 'e404', seq: 1 });
    expect(await screen.findByText(/^Could not open the employee e404:/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Edit / })).toBeNull();
  });
});

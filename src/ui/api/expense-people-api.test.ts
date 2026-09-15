import { describe, expect, it, vi } from 'vitest';
import { expensePeopleApi, expensePeopleReadinessKnown } from './expense-people-api';

const scope = { tenantId: 't1', workspaceId: 'w1' };

function transportReturning(value: unknown) {
  const request = vi.fn().mockResolvedValue(value);
  return { transport: { request }, request };
}

function call(request: ReturnType<typeof vi.fn>, index = 0): { readonly path: string; readonly query: URLSearchParams; readonly init: RequestInit | undefined; readonly body: unknown } {
  const [path, init] = request.mock.calls[index] as [string, RequestInit | undefined];
  const [base = '', search = ''] = path.split('?');
  return { path: base, query: new URLSearchParams(search), init, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
}

describe('expensePeopleApi', () => {
  it('正常: me / readiness は GET でスコープをクエリに載せ、包みを剥がす', async () => {
    const me = { subject: 'u1', singleUser: true, canApprove: true };
    const { transport, request } = transportReturning({ me });
    expect(await expensePeopleApi(transport).me(scope)).toEqual(me);
    expect(call(request)).toMatchObject({ path: '/expense/me', init: undefined });
    expect(call(request).query.get('tenantId')).toBe('t1');
    expect(call(request).query.get('workspaceId')).toBe('w1');

    const readiness = { employees: { configured: true, enabledCount: 2 }, organization: { saved: false, departmentCount: 0, approverGroupCount: 0 }, payout: { configured: false, saved: false } };
    const second = transportReturning({ readiness });
    expect(await expensePeopleApi(second.transport).readiness(scope)).toEqual(readiness);
    expect(call(second.request).path).toBe('/expense/people/readiness');
  });

  it('正常: listEmployees は絞り込みをクエリにし、空・未指定は載せない', async () => {
    const employees = [{ id: 'e1' }];
    const { transport, request } = transportReturning({ employees });
    const api = expensePeopleApi(transport);
    expect(await api.listEmployees(scope)).toEqual(employees);
    expect([...call(request).query.keys()].sort()).toEqual(['tenantId', 'workspaceId']);
    await api.listEmployees(scope, { query: '山田', departmentId: '', enabled: false, limit: 10 });
    const second = call(request, 1);
    expect(second.path).toBe('/expense/employees');
    expect(second.query.get('query')).toBe('山田');
    expect(second.query.has('departmentId')).toBe(false);
    expect(second.query.get('enabled')).toBe('false');
    expect(second.query.get('limit')).toBe('10');
  });

  it('正常: 従業員の取得・登録・更新はパスの id を符号化し、本文にスコープと入力を載せる', async () => {
    const employee = { id: 'a/b', name: 'テスト' };
    const { transport, request } = transportReturning({ employee });
    const api = expensePeopleApi(transport);
    expect(await api.getEmployee(scope, 'a/b')).toEqual(employee);
    expect(call(request, 0)).toMatchObject({ path: '/expense/employees/a%2Fb', init: undefined });

    const input = { name: 'テスト', bankAccount: { bankCode: '0001', branchCode: '001', accountType: 'ordinary' as const, holderKana: 'ﾃｽﾄ', accountNumber: '1234567' } };
    expect(await api.createEmployee(scope, input)).toEqual(employee);
    expect(call(request, 1)).toMatchObject({ path: '/expense/employees', init: { method: 'POST' }, body: { scope, ...input } });

    expect(await api.updateEmployee(scope, 'a/b', { name: 'テスト', bankAccount: null })).toEqual(employee);
    expect(call(request, 2)).toMatchObject({ path: '/expense/employees/a%2Fb', init: { method: 'PUT' }, body: { scope, name: 'テスト', bankAccount: null } });
  });

  it('正常: CSV の取込は本文で送って result を剥がし、出力は通常と口座つきでパスを分けて応答をそのまま返す', async () => {
    const result = { created: 1, updated: 0, unchanged: 0, skippedRows: [], warnings: [] };
    const imported = transportReturning({ result });
    expect(await expensePeopleApi(imported.transport).importEmployeesCsv(scope, 'code,name')).toEqual(result);
    expect(call(imported.request)).toMatchObject({ path: '/expense/employees/import', init: { method: 'POST' }, body: { scope, content: 'code,name' } });

    const file = { content: 'id\n', fileName: 'employees.csv' };
    const exported = transportReturning(file);
    const api = expensePeopleApi(exported.transport);
    expect(await api.exportEmployeesCsv(scope, false)).toEqual(file);
    expect(await api.exportEmployeesCsv(scope, true)).toEqual(file);
    expect(call(exported.request, 0)).toMatchObject({ path: '/expense/employees/export', init: undefined });
    expect(call(exported.request, 1).path).toBe('/expense/employees/export-bank-accounts');
    expect(call(exported.request, 1).query.get('tenantId')).toBe('t1');
  });

  it('正常: 組織の取得は応答をそのまま返し、保存は部門と承認グループだけを送る', async () => {
    const organization = { departments: [{ id: 'd1', name: '営業', enabled: true }], approverGroups: [], updatedAt: 'x' };
    const got = transportReturning({ organization, saved: true });
    expect(await expensePeopleApi(got.transport).getOrganization(scope)).toEqual({ organization, saved: true });
    expect(call(got.request)).toMatchObject({ path: '/expense/organization', init: undefined });

    const saved = transportReturning({ organization });
    expect(await expensePeopleApi(saved.transport).saveOrganization(scope, { ...organization } as never)).toEqual(organization);
    expect(call(saved.request)).toMatchObject({ path: '/expense/organization', init: { method: 'PUT' } });
    expect(call(saved.request).body).toEqual({ scope, departments: organization.departments, approverGroups: [] });
  });

  it('正常: 紐付け候補は状態をクエリにし、確定は links を送って result を剥がす', async () => {
    const links = [{ claimId: 'c1' }];
    const listed = transportReturning({ links });
    const api = expensePeopleApi(listed.transport);
    expect(await api.listEmployeeLinks(scope)).toEqual(links);
    expect(call(listed.request, 0).query.has('status')).toBe(false);
    await api.listEmployeeLinks(scope, 'checked');
    expect(call(listed.request, 1)).toMatchObject({ path: '/expense/claims/employee-links' });
    expect(call(listed.request, 1).query.get('status')).toBe('checked');

    const result = { linked: 1, movedToDraft: 0, skipped: [] };
    const confirmed = transportReturning({ result });
    expect(await expensePeopleApi(confirmed.transport).confirmEmployeeLinks(scope, [{ claimId: 'c1', employeeId: 'e1' }])).toEqual(result);
    expect(call(confirmed.request)).toMatchObject({ path: '/expense/claims/employee-links', init: { method: 'POST' }, body: { scope, links: [{ claimId: 'c1', employeeId: 'e1' }] } });
  });

  it('正常: 承認の流れは申請 id を符号化して応答をそのまま返し、経路の試算は入力を送って result を剥がす', async () => {
    const view = { plan: { routeName: '承認', steps: [], unresolved: [] }, canAct: true, proxy: false, blockers: [] };
    const flow = transportReturning(view);
    expect(await expensePeopleApi(flow.transport).approvalFlow(scope, 'c 1')).toEqual(view);
    expect(call(flow.request)).toMatchObject({ path: '/expense/claims/c%201/approval-flow', init: undefined });

    const result = { plan: view.plan, firstStepId: 'approve' };
    const previewed = transportReturning({ result });
    const input = { approval: { routes: [], defaultSteps: [], forbidClaimantApproval: true, requireDistinctApprovers: false }, policyCategoryIds: ['meal'], subject: { categoryIds: ['meal'], totalAmount: 1000 } };
    expect(await expensePeopleApi(previewed.transport).previewApprovalRoute(scope, input)).toEqual(result);
    expect(call(previewed.request)).toMatchObject({ path: '/expense/approval-routes/preview', init: { method: 'POST' }, body: { scope, ...input } });
  });
});

describe('expensePeopleReadinessKnown', () => {
  it('正常: 従業員と振込元の設定状況を readinessRows の known の形で返す', async () => {
    const { transport } = transportReturning({ readiness: { employees: { configured: true, enabledCount: 3 }, organization: { saved: true, departmentCount: 1, approverGroupCount: 0 }, payout: { configured: false, saved: true } } });
    expect(await expensePeopleReadinessKnown(transport, scope)).toEqual({ employees: true, payout: false });
  });

  it('異常: 読めなければ未設定として扱い、失敗を投げない', async () => {
    const transport = { request: vi.fn().mockRejectedValue(new Error('offline')) };
    expect(await expensePeopleReadinessKnown(transport, scope)).toEqual({ employees: false, payout: false });
  });
});

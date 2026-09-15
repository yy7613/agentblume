/**
 * /expense の「人と承認」ルート（docs/21 §20.9.2）。createApp({profile:'test'}) + buildServer を `inject()` で検証する。
 * 守りたいもの: UI（`src/ui/api/expense-people-api.ts`）が期待する包み（{ me } / { readiness } / { employees } / { employee } / { result } /
 * { organization, saved } / { links } / 承認の流れ）、400/404/409 の本文の「直す場所」、**口座番号が応答に出ない**こと、認可（approve）と監査。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { fixtureOrganization } from '../adapters/storage/expense-v9.fixtures';
import { InMemoryAuditLogRepository } from '../adapters/storage/in-memory-audit-log-repository';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { EXPENSE_PEOPLE_ROUTE_RULES } from './expense-people-authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const TOKEN = 'p'.repeat(40);
const organization = fixtureOrganization();
const bankAccount = { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: '1', holderKana: 'テスト タロウ' };
const taro = { scope: SCOPE, code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'dept-sales', loginSubjects: ['taro@example.com'], bankAccount };

/** 応答のどこにも口座番号（平文・封緘値）が出ていない。 */
function expectNoAccountNumber(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain('"accountNumber"');
  expect(text).not.toContain('"data"');
  expect(text).not.toContain('0000001');
}

describe('expense people routes', () => {
  let app: App;
  let server: FastifyInstance;
  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    const saved = await inject('PUT', '/expense/organization', { scope: SCOPE, departments: organization.departments, approverGroups: organization.approverGroups });
    expect(saved.statusCode).toBe(200);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('正常: GET /expense/me は単一ユーザーを返し、GET /expense/people/readiness は従業員・振込元の未設定を返す', async () => {
    const me = (await inject('GET', `/expense/me?${scopeQuery}`)).json().me;
    expect(me).toMatchObject({ subject: 'single-user', singleUser: true, canApprove: true });
    expect(me).not.toHaveProperty('employee');
    const readiness = (await inject('GET', `/expense/people/readiness?${scopeQuery}`)).json().readiness;
    expect(readiness).toMatchObject({ employees: { configured: false }, payout: { configured: false }, organization: { saved: true, departmentCount: 3 } });
  });

  it('正常: 従業員の登録・一覧・取得・編集は伏せ字（末尾 4 桁）だけを返し、口座番号を省いた編集は口座を保つ', async () => {
    const created = await inject('POST', '/expense/employees', taro);
    expect(created.statusCode).toBe(200);
    const employee = created.json().employee;
    expect(employee).toMatchObject({ name: 'テスト太郎', departmentName: '営業部', bankAccount: { accountNumberLast4: '0001' }, payoutReadiness: { problems: [], holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ' } });
    expectNoAccountNumber(created.json());

    const listed = await inject('GET', `/expense/employees?${scopeQuery}&query=${encodeURIComponent('太郎')}&enabled=true&departmentId=dept-sales&limit=10`);
    expect(listed.json().employees.map((entry: { id: string }) => entry.id)).toEqual([employee.id]);
    expectNoAccountNumber(listed.json());
    expect((await inject('GET', `/expense/employees?${scopeQuery}&enabled=false`)).json().employees).toEqual([]);

    const { accountNumber: _accountNumber, ...withoutNumber } = bankAccount;
    const updated = await inject('PUT', `/expense/employees/${employee.id}`, { ...taro, note: '異動予定', bankAccount: withoutNumber });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().employee).toMatchObject({ note: '異動予定', bankAccount: { accountNumberLast4: '0001' } });
    expect(updated.json().employee.history.map((event: { type: string }) => event.type)).toEqual(['created', 'edited']);

    const fetched = await inject('GET', `/expense/employees/${employee.id}?${scopeQuery}`);
    expect(fetched.json().employee.id).toBe(employee.id);
    expectNoAccountNumber(fetched.json());
  });

  it('異常: 名義カナ 31 バイトは 400 EXPENSE_DOMAIN（欄と変換結果）、形の崩れは 400 BAD_REQUEST、社員番号の重複は重なった従業員つき、無い従業員は 404', async () => {
    const tooLong = await inject('POST', '/expense/employees', { ...taro, bankAccount: { ...bankAccount, holderKana: `${'ガ'.repeat(15)}ア` } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toMatchObject({ code: 'EXPENSE_DOMAIN', field: 'bankAccount.holderKana', converted: { bytes: 31 } });
    expect((await inject('POST', '/expense/employees', { scope: SCOPE, name: 'x', bankAccount: { ...bankAccount, accountType: 'yen' } })).json().error.code).toBe('BAD_REQUEST');
    const first = (await inject('POST', '/expense/employees', taro)).json().employee;
    expect((await inject('POST', '/expense/employees', { ...taro, loginSubjects: [] })).json().error).toMatchObject({ code: 'EXPENSE_DOMAIN', field: 'code', conflictEmployeeId: first.id });
    expect((await inject('GET', `/expense/employees/emp-ghost?${scopeQuery}`)).json().error.code).toBe('EXPENSE_EMPLOYEE_NOT_FOUND');
    expect((await inject('PUT', '/expense/employees/emp-ghost', taro)).statusCode).toBe(404);
    expect((await inject('GET', `/expense/employees?${scopeQuery}&limit=0`)).statusCode).toBe(400);
  });

  it('正常: CSV 出力は口座番号を空にし、口座つき出力（単一ユーザーは承認権限あり）は口座番号を入れる。取込は { result }、必須の列が無ければ 400', async () => {
    await inject('POST', '/expense/employees', taro);
    const exported = await inject('GET', `/expense/employees/export?${scopeQuery}`);
    expect(exported.json()).toMatchObject({ fileName: 'expense-employees.csv' });
    expect(exported.json().content).not.toContain('0000001');
    const withBank = await inject('GET', `/expense/employees/export-bank-accounts?${scopeQuery}`);
    expect(withBank.json().fileName).toBe('expense-employees-bank-accounts.csv');
    expect(withBank.json().content).toContain('0000001');

    const imported = await inject('POST', '/expense/employees/import', { scope: SCOPE, content: 'code,name,department_id\r\nE002,テスト花子,dept-sales\r\nE003,テスト次郎,dept-ghost\r\n' });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().result).toMatchObject({ created: 1, skippedRows: [{ row: 3 }] });
    const missing = await inject('POST', '/expense/employees/import', { scope: SCOPE, content: 'code\r\nE009\r\n' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', row: 1, missingColumns: ['name'] });
  });

  it('正常: 組織は { organization, saved } で読み、壊れた組織（部門名の重複）は 400', async () => {
    const got = await inject('GET', `/expense/organization?${scopeQuery}`);
    expect(got.json()).toMatchObject({ saved: true, organization: { departments: [{ id: 'dept-admin' }, { id: 'dept-sales' }, { id: 'dept-accounting' }] } });
    const duplicated = await inject('PUT', '/expense/organization', { scope: SCOPE, departments: [{ id: 'a', name: '営業', enabled: true }, { id: 'b', name: '営業', enabled: true }], approverGroups: [] });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().error.code).toBe('EXPENSE_DOMAIN');
  });

  it('正常: 紐付け候補を読み、確定すると申請者が従業員の写しになる。無い申請は 404、本文の崩れは 400', async () => {
    const employee = (await inject('POST', '/expense/employees', taro)).json().employee;
    const claim = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' } })).json().claim;
    const links = await inject('GET', `/expense/claims/employee-links?${scopeQuery}&status=draft`);
    expect(links.json().links).toEqual([{ claimId: claim.id, claimant: { name: 'テスト太郎' }, status: 'draft', match: 'unique-name', candidates: [{ id: employee.id, name: 'テスト太郎', code: 'E001', department: '営業部' }] }]);
    const confirmed = await inject('POST', '/expense/claims/employee-links', { scope: SCOPE, links: [{ claimId: claim.id, employeeId: employee.id }] });
    expect(confirmed.json()).toEqual({ result: { linked: 1, movedToDraft: 0, skipped: [] } });
    expect((await inject('GET', `/expense/claims/${claim.id}?${scopeQuery}`)).json().claim.claimant).toMatchObject({ employeeId: employee.id, employeeCode: 'E001', department: '営業部' });
    expect((await inject('POST', '/expense/claims/employee-links', { scope: SCOPE, links: [{ claimId: 'ghost', employeeId: employee.id }] })).statusCode).toBe(404);
    expect((await inject('POST', '/expense/claims/employee-links', { scope: SCOPE, links: [] })).statusCode).toBe(400);
  });

  it('正常: 承認の流れは計画と押せるかを返し（MVP は 1 段）、経路の試算は保存していない承認設定を解決する。無い申請は 404、壊れた設定は 400', async () => {
    const claim = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'x' }, period: { from: '2026-09-01', to: '2026-09-30' } })).json().claim;
    const flow = await inject('GET', `/expense/claims/${claim.id}/approval-flow?${scopeQuery}`);
    expect(flow.json()).toMatchObject({ canAct: false, proxy: false, blockers: [], plan: { routeName: '既定の承認', steps: [{ approverKind: 'any-approver' }] } });
    expect((await inject('GET', `/expense/claims/ghost/approval-flow?${scopeQuery}`)).statusCode).toBe(404);

    const route = { id: 'r', name: '経理', enabled: true, when: {}, steps: [{ id: 'g', name: '経理', approver: { kind: 'group', groupId: 'group-accounting' } }] };
    const preview = await inject('POST', '/expense/approval-routes/preview', { scope: SCOPE, approval: { routes: [route] }, policyCategoryIds: [], subject: { categoryIds: [], totalAmount: 1000, departmentId: 'dept-sales' } });
    expect(preview.json().result).toMatchObject({ firstStepId: 'g', plan: { routeId: 'r', unresolved: [{ cause: 'group-empty' }] } });
    const broken = await inject('POST', '/expense/approval-routes/preview', { scope: SCOPE, approval: { routes: [{ ...route, steps: [] }] }, policyCategoryIds: [], subject: { categoryIds: [], totalAmount: 0 } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('EXPENSE_DOMAIN');
  });
});

describe('expense people routes の認可と監査', () => {
  let app: App;
  let audit: InMemoryAuditLogRepository;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const servers: FastifyInstance[] = [];

  function serverFor(roles: readonly AuthorizationRole[], subject = 'rita'): FastifyInstance {
    const authentication: AuthenticationPort = {
      mode: 'token', required: true,
      authenticate: async (request) => (request.header('authorization') === `Bearer ${TOKEN}` ? authenticated({ subject, ...SCOPE, roles }) : rejected('missing-credentials')),
    };
    const server = buildServer(app, { authentication, authorization: new RoleMatrixAuthorization(), audit: { sink: audit, fallbackScope: SCOPE } });
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    audit = new InMemoryAuditLogRepository();
    app = createApp({ profile: 'test', auditLogRepository: audit });
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    app.close();
  });

  it('正常: 表は 15 本すべてを workspace で持ち、口座つき出力だけ approve', () => {
    expect(EXPENSE_PEOPLE_ROUTE_RULES).toHaveLength(15);
    expect(EXPENSE_PEOPLE_ROUTE_RULES.every((entry) => entry.kind === 'workspace')).toBe(true);
    expect(EXPENSE_PEOPLE_ROUTE_RULES.filter((entry) => entry.action === 'approve').map((entry) => entry.url)).toEqual(['/expense/employees/export-bank-accounts']);
  });

  it('異常: Viewer は参照だけ（登録は 403）、Editor は口座つき出力が 403、Publisher は出力できる', async () => {
    const viewer = serverFor(['viewer']);
    expect((await viewer.inject({ method: 'GET', url: `/expense/employees?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'POST', url: '/expense/employees', headers: auth, payload: taro })).statusCode).toBe(403);
    const editor = serverFor(['editor']);
    expect((await editor.inject({ method: 'GET', url: `/expense/employees/export-bank-accounts?${scopeQuery}`, headers: auth })).statusCode).toBe(403);
    expect((await editor.inject({ method: 'GET', url: `/expense/employees/export?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    const publisher = serverFor(['publisher']);
    expect((await publisher.inject({ method: 'GET', url: `/expense/employees/export-bank-accounts?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
  });

  it('正常: 従業員の登録は監査に従業員 id だけを残し（氏名・口座は残さない）、参照は記録しない。me はログイン ID で結ばれた従業員を返す', async () => {
    const editor = serverFor(['editor'], 'taro@example.com');
    const departments = await editor.inject({ method: 'PUT', url: '/expense/organization', headers: auth, payload: { scope: SCOPE, departments: organization.departments, approverGroups: [] } });
    expect(departments.statusCode).toBe(200);
    const created = await editor.inject({ method: 'POST', url: '/expense/employees', headers: auth, payload: taro });
    expect(created.statusCode).toBe(200);
    expect((await editor.inject({ method: 'GET', url: `/expense/employees?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    const me = await editor.inject({ method: 'GET', url: `/expense/me?${scopeQuery}`, headers: auth });
    expect(me.json().me).toMatchObject({ subject: 'taro@example.com', singleUser: false, canApprove: false, employee: { id: created.json().employee.id, name: 'テスト太郎' } });
    await new Promise((resolve) => { setImmediate(resolve); });
    const entries = await audit.list(SCOPE);
    expect(entries).toHaveLength(2);
    const employeeEntry = entries.find((entry) => entry.detail?.['employeeId'] !== undefined);
    expect(employeeEntry?.detail).toMatchObject({ employeeId: created.json().employee.id });
    expect(JSON.stringify(entries)).not.toContain('テスト');
  });
});

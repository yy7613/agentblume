/**
 * /expense のお金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）のルートのテスト。
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で検証する。
 * 守りたいのは UI（`src/ui/api/expense-money-api.ts`）が期待する形（包み方・パス・クエリ名）と、409 / 400 / 404 の本文に載る
 * 「直す場所」（`blockingReasons` / `nextStep` / `missingColumns` / `importId`）、認可（仮払の承認は approve）と監査。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { fixtureCardSettings, fixtureEmployees, fixtureOrganization } from '../adapters/storage/expense-v9.fixtures';
import { InMemoryAuditLogRepository } from '../adapters/storage/in-memory-audit-log-repository';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const TOKEN = 'm'.repeat(40);
const HEADER = '利用日,利用店名,利用金額,カード番号下4桁,備考';
const STATEMENT = `﻿${HEADER}\r\n2026/09/10,サンプルマート 霞が関店,3200,1111,\r\n2026/09/12,サンプルホテル,12000,2222,\r\n`;
const advanceBody = { scope: SCOPE, employeeId: 'emp-hanako', purpose: '大阪出張', amount: 30000, neededOn: '2026-09-20', plannedSettleBy: '2026-09-30' };

describe('expense money routes', () => {
  let app: App;
  let server: FastifyInstance;
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    for (const employee of fixtureEmployees(SCOPE)) await app.expenseEmployeeRepo.save(employee);
    await app.expenseSettingsRepo.save(SCOPE, 'organization', fixtureOrganization());
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('仮払', () => {
    it('正常: 申請 → 一覧 → 詳細 → 編集 → 承認 → 支払済み → 精算の事前計算 → 精算（全額返金）→ 返金の受領 → 仕訳下書き の包み方', async () => {
      const created = await inject('POST', '/expense/advances', advanceBody);
      expect(created.statusCode).toBe(200);
      const advance = created.json().advance;
      expect(advance).toMatchObject({ status: 'requested', employeeSnapshot: { name: 'テスト花子' }, department: '営業部', linkedClaimCount: 0, overdue: false });
      expect(advance.tenant).toBeUndefined();
      const id = advance.id as string;

      expect((await inject('GET', `/expense/advances?${scopeQuery}&status=requested`)).json().advances.map((entry: { id: string }) => entry.id)).toEqual([id]);
      expect((await inject('GET', `/expense/advances/${id}?${scopeQuery}`)).json()).toMatchObject({ advance: { id }, claims: [] });
      expect((await inject('PUT', `/expense/advances/${id}`, { ...advanceBody, amount: 20000 })).json().advance.amount).toBe(20000);
      expect((await inject('POST', `/expense/advances/${id}/approve`, { scope: SCOPE, comment: '了解' })).json().advance.status).toBe('approved');
      expect((await inject('POST', `/expense/advances/${id}/mark-paid`, { scope: SCOPE, paidOn: '2026-09-19', method: 'cash' })).json().advance.status).toBe('paid');
      expect((await inject('POST', `/expense/advances/${id}/journal-drafts`, { scope: SCOPE, stage: 'payment' })).json()).toMatchObject({ advance: { journalLink: { paymentEntryId: expect.any(String) } }, entryIds: [expect.any(String)], warnings: [] });

      const preview = await inject('GET', `/expense/advances/${id}/settlement-preview?${scopeQuery}`);
      expect(preview.json().preview).toEqual({ claims: [], claimsTotal: 0, difference: -20000, direction: 'refund', blockers: [] });
      const settled = await inject('POST', `/expense/advances/${id}/settle`, { scope: SCOPE });
      expect(settled.json()).toMatchObject({ advance: { status: 'settling', settlement: { refund: { amount: 20000 } } }, claims: [] });
      // 返金の仮払に追加支給は記録できない（次の一手つき）。
      const wrong = await inject('POST', `/expense/advances/${id}/additional-paid`, { scope: SCOPE, paidOn: '2026-09-25', method: 'transfer' });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', nextStep: expect.stringContaining('返金') });
      expect((await inject('POST', `/expense/advances/${id}/refund-received`, { scope: SCOPE, receivedOn: '2026-09-25' })).json().advance.status).toBe('settled');
      expect((await inject('POST', `/expense/advances/${id}/journal-drafts`, { scope: SCOPE, stage: 'settlement' })).statusCode).toBe(200);
    });

    it('異常: 取消・支払取消の理由が無ければ 400、支払前の支払取消は 409、無い仮払は 404、無い従業員は 404', async () => {
      const id = (await inject('POST', '/expense/advances', advanceBody)).json().advance.id as string;
      expect((await inject('POST', `/expense/advances/${id}/cancel`, { scope: SCOPE })).statusCode).toBe(400);
      expect((await inject('POST', `/expense/advances/${id}/unpay`, { scope: SCOPE, note: '取消' })).json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'advance-status' }] });
      expect((await inject('POST', `/expense/advances/${id}/cancel`, { scope: SCOPE, note: '出張中止' })).json().advance.status).toBe('cancelled');
      expect((await inject('GET', `/expense/advances/adv-none?${scopeQuery}`)).json().error).toMatchObject({ code: 'EXPENSE_ADVANCE_NOT_FOUND' });
      expect((await inject('POST', '/expense/advances', { ...advanceBody, employeeId: 'emp-none' })).json().error).toMatchObject({ code: 'EXPENSE_EMPLOYEE_NOT_FOUND' });
      expect((await inject('POST', '/expense/advances', { ...advanceBody, amount: 0 })).statusCode).toBe(400);
      expect((await inject('GET', `/expense/advances?${scopeQuery}&status=unknown`)).statusCode).toBe(400);
      expect((await inject('POST', `/expense/advances/${id}/journal-drafts`, { scope: SCOPE, stage: 'payment' })).json().error).toMatchObject({ code: 'EXPENSE_JOURNAL_LINK', problems: [{ code: 'advance-not-paid' }] });
    });

    it('正常→異常: 申請への紐付け（PUT /expense/claims/:id/advance）は申請者本人の支払済みの仮払だけ。違えば 409 で理由と次の一手', async () => {
      const id = (await inject('POST', '/expense/advances', advanceBody)).json().advance.id as string;
      await inject('POST', `/expense/advances/${id}/approve`, { scope: SCOPE });
      await inject('POST', `/expense/advances/${id}/mark-paid`, { scope: SCOPE, paidOn: '2026-09-19', method: 'transfer' });
      const period = { from: '2026-09-01', to: '2026-09-30' };
      const hanako = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'x', employeeId: 'emp-hanako' }, period })).json().claim.id as string;
      const taro = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'x', employeeId: 'emp-taro' }, period })).json().claim.id as string;

      const linked = await inject('PUT', `/expense/claims/${hanako}/advance`, { scope: SCOPE, advanceId: id });
      expect(linked.statusCode).toBe(200);
      expect(linked.json().claim).toMatchObject({ id: hanako, advanceId: id, status: 'draft', totalAmount: 0, reimbursableAmount: 0, stale: false, approvalBlockers: [] });
      expect((await inject('GET', `/expense/advances/${id}?${scopeQuery}`)).json().claims.map((claim: { id: string }) => claim.id)).toEqual([hanako]);

      const mismatch = await inject('PUT', `/expense/claims/${taro}/advance`, { scope: SCOPE, advanceId: id });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'advance-employee-mismatch', params: { advanceEmployee: 'テスト花子' } }], nextStep: expect.any(String) });
      expect((await inject('PUT', `/expense/claims/${hanako}/advance`, { scope: SCOPE, advanceId: null })).json().claim.advanceId).toBeUndefined();
      expect((await inject('PUT', `/expense/claims/${hanako}/advance`, { scope: SCOPE })).statusCode).toBe(400);

      // 紐付く申請（未承認）があると精算できない。
      await inject('PUT', `/expense/claims/${hanako}/advance`, { scope: SCOPE, advanceId: id });
      const settle = await inject('POST', `/expense/advances/${id}/settle`, { scope: SCOPE });
      expect(settle.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'advance-claim-not-approved', params: { claimId: hanako } }] });
    });
  });

  describe('法人カード', () => {
    async function saveCards(): Promise<void> {
      const { cards, profiles } = fixtureCardSettings();
      const res = await inject('PUT', '/expense/card-settings', { scope: SCOPE, cards, profiles });
      expect(res.statusCode).toBe(200);
    }

    it('正常: 設定 → プレビュー → 取込 → 一覧 → 照合 → 対象外 / 取消 → 手動の紐付け / 解除 → 取込の削除', async () => {
      expect((await inject('GET', `/expense/card-settings?${scopeQuery}`)).json()).toMatchObject({ saved: false, settings: { cards: [] } });
      await saveCards();
      expect((await inject('GET', `/expense/card-settings?${scopeQuery}`)).json().saved).toBe(true);

      const preview = await inject('POST', '/expense/card-statements/preview', { scope: SCOPE, content: STATEMENT });
      expect(preview.json().result).toMatchObject({ detectedProfileId: 'profile-generic', rowCount: 2, periodFrom: '2026-09-10', periodTo: '2026-09-12', problems: [] });

      const imported = await inject('POST', '/expense/card-statements', { scope: SCOPE, content: STATEMENT, fileName: 'card.csv' });
      expect(imported.json().result).toMatchObject({ imported: 2, duplicates: 0, skippedRows: [] });
      const importId = imported.json().result.importId as string;
      const duplicate = await inject('POST', '/expense/card-statements', { scope: SCOPE, content: STATEMENT, fileName: 'card-again.csv' });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toMatchObject({ code: 'EXPENSE_CARD_DUPLICATE_IMPORT', importId });
      expect((await inject('GET', `/expense/card-statements?${scopeQuery}`)).json().imports).toEqual([expect.objectContaining({ id: importId, fileName: 'card.csv' })]);

      const listed = (await inject('GET', `/expense/card-transactions?${scopeQuery}&status=unmatched`)).json().transactions;
      expect(listed.map((entry: { cardLabel: string; amount: number }) => [entry.cardLabel, entry.amount])).toEqual([['共用カード', 12000], ['営業用カード', 3200]]);
      const hotel = listed[0].id as string;
      expect((await inject('POST', '/expense/card-transactions/match', { scope: SCOPE, from: '2026-09-01', to: '2026-09-30' })).json().result).toEqual({ matched: 0, reimbursementMatches: 0, unmatched: 2, kept: 0 });
      expect((await inject('POST', '/expense/card-transactions/match', { scope: SCOPE, from: '2026-09-30', to: '2026-09-01' })).statusCode).toBe(400);

      expect((await inject('POST', `/expense/card-transactions/${hotel}/exclude`, { scope: SCOPE, reason: '年会費' })).json().transaction).toMatchObject({ status: 'excluded', exclusion: { reason: '年会費' } });
      expect((await inject('POST', `/expense/card-transactions/${hotel}/exclude`, { scope: SCOPE })).statusCode).toBe(400);
      expect((await inject('POST', `/expense/card-transactions/${hotel}/include`, { scope: SCOPE })).json().transaction.status).toBe('unmatched');

      const claimId = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' } })).json().claim.id as string;
      const withItem = await inject('POST', `/expense/claims/${claimId}/items`, { scope: SCOPE, source: { type: 'manual' }, categoryId: 'transport.taxi', facts: { transactionDate: '2026-09-12', payeeName: 'サンプルホテル', amount: 12000 } });
      const itemId = withItem.json().claim.items[0].id as string;
      expect((await inject('POST', `/expense/card-transactions/${hotel}/link`, { scope: SCOPE, claimId, itemId })).json().transaction).toMatchObject({ status: 'matched', claimant: 'テスト太郎', match: { kind: 'reimbursement-item', strength: 'strong', manual: true } });
      expect((await inject('POST', `/expense/card-transactions/${hotel}/unlink`, { scope: SCOPE })).json().transaction.status).toBe('unmatched');
      expect((await inject('POST', `/expense/card-transactions/none/unlink`, { scope: SCOPE })).json().error).toMatchObject({ code: 'EXPENSE_CARD_TRANSACTION_NOT_FOUND' });

      expect((await inject('DELETE', `/expense/card-statements/${importId}?${scopeQuery}`)).statusCode).toBe(204);
      expect((await inject('DELETE', `/expense/card-statements/${importId}?${scopeQuery}`)).json().error).toMatchObject({ code: 'EXPENSE_CARD_IMPORT_NOT_FOUND' });
      expect((await inject('GET', `/expense/card-transactions?${scopeQuery}`)).json().transactions).toEqual([]);
    });

    it('異常: 列の対応が決まらない取込は 400 で足りない項目と推定した対応を返し、プレビューは問題として返す', async () => {
      await saveCards();
      const content = 'ご利用日,ご利用先,ご請求額\r\n2026/09/10,店,100\r\n';
      const mapping = { columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額' }, amountSign: 'charge-positive', skipLinesBefore: 0 };
      const res = await inject('POST', '/expense/card-statements', { scope: SCOPE, content, fileName: 'x.csv', mapping, cardId: 'card-shared' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'EXPENSE_CARD_IMPORT', missingColumns: ['usedOn', 'merchant', 'amount'], suggestedMapping: { usedOn: 'ご利用日' } });
      expect((await inject('POST', '/expense/card-statements/preview', { scope: SCOPE, content, mapping })).json().result.problems).toEqual([expect.objectContaining({ code: 'card-import' })]);
      expect((await inject('PUT', '/expense/card-settings', { scope: SCOPE, cards: [{ id: 'x', label: 'x', last4: '12', enabled: true }], profiles: [] })).statusCode).toBe(400);
    });
  });

  describe('集計・準備状況', () => {
    it('正常: 集計と CSV の包み方。群の指定・状態・基準日をクエリで受ける', async () => {
      const res = await inject('GET', `/expense/summary?${scopeQuery}&from=2026-01&to=2026-12&groupBy=month,department&status=all&basis=transaction`);
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ rows: [], totals: { claimCount: 0 }, groupBy: ['month', 'department'], basis: 'transaction' });
      expect(res.json().result.statuses).toHaveLength(6);
      const csv = await inject('GET', `/expense/summary/export?${scopeQuery}&from=2026-01&to=2026-12`);
      expect(csv.json()).toMatchObject({ fileName: 'expense-summary-2026-01-2026-12-transaction.csv', content: expect.stringMatching(/^﻿month,department_id/u) });
    });

    it('異常: 月の形・群の値・逆順・36 か月超は 400', async () => {
      expect((await inject('GET', `/expense/summary?${scopeQuery}&from=2026-1&to=2026-12`)).statusCode).toBe(400);
      expect((await inject('GET', `/expense/summary?${scopeQuery}&from=2026-01&to=2026-12&groupBy=payee`)).json().error.message).toContain('group_by must be');
      expect((await inject('GET', `/expense/summary?${scopeQuery}&from=2026-12&to=2026-01`)).json().error).toMatchObject({ code: 'EXPENSE_DOMAIN' });
      expect((await inject('GET', `/expense/summary/export?${scopeQuery}&from=2020-01&to=2026-12`)).statusCode).toBe(400);
    });

    it('正常: 準備状況は未設定を false で返し、カードを登録すると true', async () => {
      expect((await inject('GET', `/expense/money-readiness?${scopeQuery}`)).json().readiness).toEqual({ cards: false, cardCount: 0, cardImportCount: 0, cardCoverage: [], payout: false });
      const { cards, profiles } = fixtureCardSettings();
      await inject('PUT', '/expense/card-settings', { scope: SCOPE, cards, profiles });
      expect((await inject('GET', `/expense/money-readiness?${scopeQuery}`)).json().readiness).toMatchObject({ cards: true, cardCount: 2 });
    });
  });
});

describe('expense money routes の認可と監査', () => {
  let app: App;
  let audit: InMemoryAuditLogRepository;
  const auth = { authorization: `Bearer ${TOKEN}` };

  function rolesAuth(roles: readonly AuthorizationRole[]): AuthenticationPort {
    return {
      mode: 'token',
      required: true,
      authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}` ? authenticated({ subject: 'rita', ...SCOPE, roles }) : rejected('missing-credentials'),
    };
  }
  const serverFor = (roles: readonly AuthorizationRole[]): FastifyInstance => buildServer(app, { authentication: rolesAuth(roles), authorization: new RoleMatrixAuthorization(), audit: { sink: audit, fallbackScope: SCOPE } });

  beforeEach(() => {
    audit = new InMemoryAuditLogRepository();
    app = createApp({ profile: 'test', auditLogRepository: audit });
  });
  afterEach(() => { app.close(); });

  it('参照は Viewer、変更は Editor、仮払の承認だけ Publisher 以上（Editor は 403、Publisher は 404 まで届く）', async () => {
    const viewer = serverFor(['viewer']);
    expect((await viewer.inject({ method: 'GET', url: `/expense/advances?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'GET', url: `/expense/summary?${scopeQuery}&from=2026-01&to=2026-02`, headers: auth })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'POST', url: '/expense/advances', headers: auth, payload: advanceBody })).statusCode).toBe(403);
    expect((await viewer.inject({ method: 'POST', url: '/expense/card-statements/preview', headers: auth, payload: { scope: SCOPE, content: STATEMENT } })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'POST', url: '/expense/card-transactions/match', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    const editor = serverFor(['editor']);
    expect((await editor.inject({ method: 'POST', url: '/expense/advances/none/approve', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    expect((await editor.inject({ method: 'POST', url: '/expense/advances/none/mark-paid', headers: auth, payload: { scope: SCOPE, paidOn: '2026-09-01', method: 'cash' } })).statusCode).toBe(404);
    const publisher = serverFor(['publisher']);
    expect((await publisher.inject({ method: 'POST', url: '/expense/advances/none/approve', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(404);
  });

  it('監査対象（カードの設定・集計 CSV）は記録され、参照・照合の実行は記録されない。応答に口座番号は出ない', async () => {
    const editor = serverFor(['editor']);
    const { cards, profiles } = fixtureCardSettings();
    expect((await editor.inject({ method: 'PUT', url: '/expense/card-settings', headers: auth, payload: { scope: SCOPE, cards, profiles } })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'GET', url: `/expense/card-settings?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'POST', url: '/expense/card-transactions/match', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(200);
    const exported = await editor.inject({ method: 'GET', url: `/expense/summary/export?${scopeQuery}&from=2026-01&to=2026-02`, headers: auth });
    expect(exported.statusCode).toBe(200);
    await new Promise((resolve) => { setImmediate(resolve); });
    const entries = await audit.list(SCOPE);
    expect(entries.map((entry) => `${entry.action}:${entry.outcome}`).sort()).toEqual(['edit:succeeded', 'read:succeeded']);
    for (const employee of fixtureEmployees(SCOPE)) await app.expenseEmployeeRepo.save(employee);
    const advance = await editor.inject({ method: 'POST', url: '/expense/advances', headers: auth, payload: advanceBody });
    expect(advance.body).not.toMatch(/accountNumber|bankAccount/u);
  });
});

/**
 * /receivables ルートのテスト。createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で検証する。
 *
 * 守りたいのは **UI（`src/ui/api/receivables-api.ts`）が期待する形**（パス・クエリ名・応答の包み方・削除は 204）と、
 * 「直す場所」を示す本文の項目（violations / row / reason / missing）、登録点の網羅（全ルートが認可の表に載る）、Viewer の 403。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { InMemoryAuditLogRepository } from '../adapters/storage/in-memory-audit-log-repository';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import { defaultReceivablesSettings } from '../domain/receivables/settings';
import { explicitRouteAuthorization } from './authorization';
import { RECEIVABLES_ROUTE_RULES } from './receivables-authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const q = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const settingsBody = () => {
  const { updatedAt: _updatedAt, ...settings } = defaultReceivablesSettings();
  return { scope: SCOPE, settings: { ...settings, issuer: { name: '株式会社サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] } } };
};
const csvBase64 = (rows: readonly string[]) => Buffer.from(['日付,摘要,出金,入金,残高', ...rows].join('\n'), 'utf8').toString('base64');

let app: App;
let server: FastifyInstance;

beforeEach(() => {
  app = createApp({ profile: 'test' });
  server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
});
afterEach(async () => { await server.close(); app.close(); });

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function seedCustomerAndInvoice() {
  expect((await call('PUT', '/receivables/settings', settingsBody())).statusCode).toBe(200);
  const customer = (await call('POST', '/receivables/customers', { scope: SCOPE, name: '株式会社サンプル商事', kana: 'サンプルシヨウジ' })).json().customer;
  const created = (await call('POST', '/receivables/invoices', { scope: SCOPE, customerId: customer.id, issueDate: '2026-09-01', transactionDate: '2026-09-01', dueDate: '2026-09-30', pricing: 'exclusive', lines: [{ description: '開発', amount: 100_000, taxRate: 10 }] })).json();
  return { customer, invoice: created.invoice };
}

describe('receivables routes', () => {
  it('登録点: 全ルートが認可の表に載り、監査は「後から問われる操作」だけ', () => {
    expect(server.unmappedAuthorizationRoutes.filter((route: string) => route.includes('/receivables'))).toEqual([]);
    expect(RECEIVABLES_ROUTE_RULES.filter((entry) => entry.audit).map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'PUT /receivables/settings', 'DELETE /receivables/customers/:id', 'POST /receivables/invoices/:id/issue', 'POST /receivables/invoices/:id/void',
      'DELETE /receivables/bank-transactions/:id', 'POST /receivables/matchings', 'POST /receivables/matchings/confirm-decided', 'POST /receivables/matchings/:id/cancel',
    ]);
    expect(explicitRouteAuthorization('POST', '/receivables/invoices/check')).toMatchObject({ action: 'read' });
  });

  it('設定: 未保存は初期値 + saved=false、保存後は saved=true。範囲外の値は 400 RECEIVABLES_DOMAIN', async () => {
    expect((await call('GET', `/receivables/settings?${q}`)).json()).toMatchObject({ saved: false, settings: { rounding: { mode: 'floor' } } });
    const saved = await call('PUT', '/receivables/settings', settingsBody());
    expect(saved.json().settings.issuer.name).toBe('株式会社サンプルソフト');
    expect((await call('GET', `/receivables/settings?${q}`)).json().saved).toBe(true);
    const invalid = settingsBody();
    const bad = await call('PUT', '/receivables/settings', { ...invalid, settings: { ...invalid.settings, matching: { ...invalid.settings.matching, maxCombinationSize: 6 } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('RECEIVABLES_DOMAIN');
    expect((await call('PUT', '/receivables/settings', { scope: SCOPE })).json().error.code).toBe('BAD_REQUEST');
  });

  it('取引先: 作成・取得・更新（別名の衝突は warnings）・一覧（未入金額つき）・参照ありの削除は 409・削除は 204', async () => {
    const { customer, invoice } = await seedCustomerAndInvoice();
    expect((await call('GET', `/receivables/customers/${customer.id}?${q}`)).json().customer).toMatchObject({ name: '株式会社サンプル商事' });
    const other = (await call('POST', '/receivables/customers', { scope: SCOPE, name: '別会社', payerAliases: [{ text: 'ｻﾝﾌﾟﾙｼﾖｳｼﾞ' }] })).json();
    expect(other.warnings).toEqual([{ normalized: 'サンプルシヨウジ', otherCustomerId: customer.id, otherCustomerName: '株式会社サンプル商事' }]);
    expect(other.customer).not.toHaveProperty('tenant');
    const updated = await call('PUT', `/receivables/customers/${other.customer.id}`, { scope: SCOPE, name: '別会社', enabled: false });
    expect(updated.json()).toMatchObject({ customer: { enabled: false }, warnings: [] });
    await call('POST', `/receivables/invoices/${invoice.id}/issue`, { scope: SCOPE });
    expect((await call('GET', `/receivables/customers?${q}&enabled=true`)).json().customers).toEqual([expect.objectContaining({ id: customer.id, outstanding: 110_000 })]);
    const inUse = await call('DELETE', `/receivables/customers/${customer.id}?${q}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toMatchObject({ code: 'RECEIVABLES_STATE', reason: 'customer-in-use' });
    expect((await call('DELETE', `/receivables/customers/${other.customer.id}?${q}`)).statusCode).toBe(204);
    expect((await call('GET', `/receivables/customers/${other.customer.id}?${q}`)).json().error.code).toBe('RECEIVABLES_CUSTOMER_NOT_FOUND');
  });

  it('請求書: 検査・下書き・更新・一覧・発行（売上仕訳）・違反は violations つき 400・取消・複製・削除', async () => {
    const { customer, invoice } = await seedCustomerAndInvoice();
    const check = (await call('POST', '/receivables/invoices/check', { scope: SCOPE, pricing: 'exclusive', lines: [] })).json().check;
    expect(check.violations.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining(['recipient-missing', 'lines-empty']));
    const updated = await call('PUT', `/receivables/invoices/${invoice.id}`, { scope: SCOPE, customerId: customer.id, issueDate: '2026-09-01', transactionDate: '2026-09-01', dueDate: '2026-09-30', pricing: 'exclusive', lines: [{ description: '開発', amount: 100_000, taxRate: 10 }, { description: '弁当', amount: 1_000, taxRate: 8 }] });
    expect(updated.json()).toMatchObject({ invoice: { totals: { grandTotal: 111_080 } }, check: { violations: [] } });
    expect((await call('GET', `/receivables/invoices/${invoice.id}?${q}`)).json()).toMatchObject({ invoice: { status: 'draft' }, check: { violations: [] }, payments: [] });

    const blank = (await call('POST', '/receivables/invoices', { scope: SCOPE, pricing: 'exclusive', lines: [{ description: 'x', amount: 1, taxRate: 10 }] })).json().invoice;
    const refused = await call('POST', `/receivables/invoices/${blank.id}/issue`, { scope: SCOPE });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'RECEIVABLES_INVOICE_COMPLIANCE', violations: expect.arrayContaining([expect.objectContaining({ code: 'recipient-missing', path: 'customerId' })]) });

    const issued = (await call('POST', `/receivables/invoices/${invoice.id}/issue`, { scope: SCOPE })).json();
    expect(issued).toMatchObject({ invoice: { status: 'issued', number: 'INV-2026-0001' }, journal: { status: 'created' } });
    expect((await app.listJournalEntries.execute(SCOPE)).map((entry) => entry.id)).toEqual([issued.journal.entryId]);
    expect((await call('PUT', `/receivables/invoices/${invoice.id}`, { scope: SCOPE, pricing: 'exclusive', lines: [] })).json().error).toMatchObject({ code: 'RECEIVABLES_STATE', reason: 'invoice-not-draft' });
    expect((await call('GET', `/receivables/invoices?${q}&status=issued`)).json().invoices).toEqual([expect.objectContaining({ id: invoice.id, customerName: '株式会社サンプル商事', outstanding: 111_080, violationCount: 0 })]);
    expect((await call('GET', `/receivables/invoices?${q}&customerId=${customer.id}&from=2026-01-01&to=2026-12-31`)).json().invoices).toHaveLength(1);
    // 期日超過はサーバーの今日で決まるので、ここでは件数ではなくクエリが通ることだけを見る（件数は application のテストが固定の時計で見る）。
    expect((await call('GET', `/receivables/invoices?${q}&overdue=true`)).statusCode).toBe(200);

    const voided = (await call('POST', `/receivables/invoices/${invoice.id}/void`, { scope: SCOPE, reason: '宛名の誤り' })).json();
    expect(voided.invoice).toMatchObject({ status: 'void', voided: { reason: '宛名の誤り' } });
    expect(await app.listJournalEntries.execute(SCOPE)).toEqual([]);
    expect((await call('POST', `/receivables/invoices/${invoice.id}/void`, { scope: SCOPE })).statusCode).toBe(400);
    const copy = (await call('POST', `/receivables/invoices/${invoice.id}/duplicate`, { scope: SCOPE })).json();
    expect(copy.invoice).toMatchObject({ status: 'draft', duplicatedFrom: invoice.id });
    expect((await call('DELETE', `/receivables/invoices/${copy.invoice.id}?${q}`)).statusCode).toBe(204);
    expect((await call('GET', `/receivables/invoices/${copy.invoice.id}?${q}`)).statusCode).toBe(404);
  });

  it('発行: 仕訳の科目が無ければ 409 と足りない設定項目（missing）', async () => {
    const { invoice } = await seedCustomerAndInvoice();
    const body = settingsBody();
    await call('PUT', '/receivables/settings', { ...body, settings: { ...body.settings, journal: { ...body.settings.journal, accounts: { ...body.settings.journal.accounts, sales: 'ghost' } } } });
    const response = await call('POST', `/receivables/invoices/${invoice.id}/issue`, { scope: SCOPE });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING', missing: [{ kind: 'account', id: 'ghost', settingPath: 'journal.accounts.sales' }] });
  });

  it('明細: プロファイル・プレビュー・取込（行番号つき）・判定・候補・確定・一括確定・取消・対象外・削除', async () => {
    const { invoice } = await seedCustomerAndInvoice();
    await call('POST', `/receivables/invoices/${invoice.id}/issue`, { scope: SCOPE });

    const profiles = (await call('GET', `/receivables/bank-csv-profiles?${q}`)).json().profiles;
    expect(profiles.map((profile: { id: string }) => profile.id)).toContain('builtin:generic');
    const saved = (await call('POST', '/receivables/bank-csv-profiles', { scope: SCOPE, name: '地銀', mapping: { date: '取引日', deposit: '入金額' } })).json().profile;
    expect(saved).toMatchObject({ origin: 'user' });
    expect((await call('POST', '/receivables/bank-csv-profiles', { scope: SCOPE, id: 'builtin:generic', name: 'x', mapping: { date: 'd', deposit: 'x' } })).json().error).toMatchObject({ reason: 'profile-builtin' });
    expect((await call('DELETE', `/receivables/bank-csv-profiles/${saved.id}?${q}`)).statusCode).toBe(204);

    const content = csvBase64(['2026/09/30,ﾌﾘｺﾐ ｻﾝﾌﾟﾙｼﾖｳｼﾞ,,110000,1110000', '2026/09/30,ﾌﾘｺﾐ ﾌﾒｲ,,500,1110500', 'bad,x,,1,']);
    expect((await call('POST', '/receivables/bank-transactions/preview', { scope: SCOPE, contentBase64: content })).json().preview).toMatchObject({ profile: { id: 'builtin:generic' }, mappingRequired: false, dataRowCount: 3 });
    const imported = (await call('POST', '/receivables/bank-transactions/import', { scope: SCOPE, contentBase64: content, accountKey: 'main' })).json().result;
    expect(imported).toMatchObject({ profileId: 'builtin:generic', skippedRows: [{ row: 4 }] });
    expect(imported.imported[0]).not.toHaveProperty('tenant');
    const unreadable = await call('POST', '/receivables/bank-transactions/import', { scope: SCOPE, contentBase64: Buffer.from('名前\nx').toString('base64') });
    expect(unreadable.statusCode).toBe(400);
    expect(unreadable.json().error.code).toBe('RECEIVABLES_CSV_IMPORT');

    const [decidedTx, unknownTx] = imported.imported;
    expect((await call('POST', '/receivables/matching/judge', { scope: SCOPE })).json().result.counts).toEqual({ decided: 1, candidate: 0, unmatched: 1 });
    const candidates = (await call('GET', `/receivables/matching/candidates?${q}&transactionId=${decidedTx.id}`)).json();
    expect(candidates).toMatchObject({ transaction: { id: decidedTx.id }, judgment: { stage: 'decided' } });

    // 手数料 1,000 円は初期値の許容範囲（1〜880 円）の外。
    const tooMuch = await call('POST', '/receivables/matchings', { scope: SCOPE, transactionId: unknownTx.id, allocations: [{ invoiceId: invoice.id, amount: 1_500 }], feeAmount: 1_000 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error).toMatchObject({ code: 'RECEIVABLES_STATE', reason: 'fee-out-of-tolerance' });
    const stale = await call('POST', '/receivables/matchings', { scope: SCOPE, transactionId: decidedTx.id, allocations: [{ invoiceId: invoice.id, amount: 110_000 }], feeAmount: 0, expectedOutstanding: { [invoice.id]: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ reason: 'invoice-outstanding-changed' });

    const decided = (await call('POST', '/receivables/matchings/confirm-decided', { scope: SCOPE })).json().result;
    expect(decided).toMatchObject({ confirmed: [{ transactionId: decidedTx.id }], failed: [] });
    expect((await call('GET', `/receivables/matchings?${q}&invoiceId=${invoice.id}`)).json().matchings).toHaveLength(1);
    expect((await call('DELETE', `/receivables/bank-transactions/${decidedTx.id}?${q}`)).statusCode).toBe(409);
    const cancelled = (await call('POST', `/receivables/matchings/${decided.confirmed[0].matchingId}/cancel`, { scope: SCOPE, removeLearnedAlias: true })).json().result;
    expect(cancelled).toMatchObject({ matching: { status: 'cancelled' }, removedAlias: false });
    expect((await call('POST', '/receivables/matchings/missing/cancel', { scope: SCOPE })).statusCode).toBe(404);

    expect((await call('POST', `/receivables/bank-transactions/${unknownTx.id}/ignore`, { scope: SCOPE, note: '不明' })).json().transaction).toMatchObject({ status: 'ignored', ignoredNote: '不明' });
    expect((await call('GET', `/receivables/bank-transactions?${q}&status=ignored&accountKey=main&from=2026-09-01&to=2026-09-30`)).json().transactions).toHaveLength(1);
    expect((await call('POST', `/receivables/bank-transactions/${unknownTx.id}/unignore`, { scope: SCOPE })).json().transaction.status).toBe('unmatched');
    expect((await call('DELETE', `/receivables/bank-transactions/${unknownTx.id}?${q}`)).statusCode).toBe(204);
    expect((await call('POST', `/receivables/bank-transactions/${unknownTx.id}/ignore`)).statusCode).toBe(404);
  });

  it('機能フラグ: /runtime/capabilities に receivables キーを足す（test プロファイルでは使えない）', async () => {
    expect((await call('GET', '/runtime/capabilities')).json().receivables).toEqual({ invoiceDraft: { enabled: false, vision: false } });
  });

  it('認可: Viewer は読めるが、変更（設定の保存・判定・確定）は 403', async () => {
    const TOKEN = 'v'.repeat(40);
    const viewerAuth: AuthenticationPort = {
      mode: 'token', required: true,
      authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}` ? authenticated({ subject: 'vera', ...SCOPE, roles: ['viewer'] }) : rejected('missing-credentials'),
    };
    const viewer = buildServer(app, { authentication: viewerAuth, authorization: new RoleMatrixAuthorization(), audit: { sink: new InMemoryAuditLogRepository(), fallbackScope: SCOPE } });
    const headers = { authorization: `Bearer ${TOKEN}` };
    try {
      expect((await viewer.inject({ method: 'GET', url: `/receivables/invoices?${q}`, headers })).statusCode).toBe(200);
      expect((await viewer.inject({ method: 'POST', url: '/receivables/invoices/check', headers, payload: { pricing: 'exclusive', lines: [] } })).statusCode).toBe(200);
      for (const [method, url, payload] of [['PUT', '/receivables/settings', settingsBody()], ['POST', '/receivables/matching/judge', {}], ['POST', '/receivables/matchings', { transactionId: 'x', allocations: [{ invoiceId: 'i', amount: 1 }], feeAmount: 0 }]] as const) {
        expect((await viewer.inject({ method, url, headers, payload })).statusCode, `${method} ${url}`).toBe(403);
      }
    } finally { await viewer.close(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { receivablesApi } from './receivables-api';

const scope = { tenantId: 'local', workspaceId: 'default' };
const q = 'tenantId=local&workspaceId=default';

function transport(response: unknown = {}) {
  const request = vi.fn(async (_path: string, _init?: RequestInit) => response);
  return { request, api: receivablesApi({ request: request as never }) };
}
const call = (request: ReturnType<typeof transport>['request'], index = 0) => {
  const [path, init] = request.mock.calls[index]!;
  return { path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

describe('receivablesApi（パス・メソッド・本文・応答の包みを外す）', () => {
  it('正常: 設定の取得と保存（updatedAt は送らない）', async () => {
    const { request, api } = transport({ settings: { rounding: {} }, saved: true });
    expect(await api.getSettings(scope)).toEqual({ settings: { rounding: {} }, saved: true });
    expect(call(request)).toEqual({ path: `/receivables/settings?${q}`, method: 'GET', body: undefined });
    expect(await api.saveSettings(scope, { updatedAt: 'x', numbering: { format: 'F' } } as never)).toEqual({ rounding: {} });
    expect(call(request, 1)).toEqual({ path: '/receivables/settings', method: 'PUT', body: { scope, settings: { numbering: { format: 'F' } } } });
  });

  it('正常: 取引先の一覧（絞り込み）・取得・作成 / 更新・削除', async () => {
    const { request, api } = transport({ customers: [{ id: 'c' }], customer: { id: 'c' }, warnings: [] });
    expect(await api.listCustomers(scope, { enabled: true })).toEqual([{ id: 'c' }]);
    expect(await api.listCustomers(scope)).toEqual([{ id: 'c' }]);
    expect(await api.getCustomer(scope, 'c/1')).toEqual({ id: 'c' });
    await api.saveCustomer(scope, { name: 'A' });
    await api.saveCustomer(scope, { name: 'A' }, 'c');
    await api.deleteCustomer(scope, 'c');
    expect(request.mock.calls.map((_, index) => [call(request, index).method, call(request, index).path])).toEqual([
      ['GET', `/receivables/customers?${q}&enabled=true`], ['GET', `/receivables/customers?${q}`], ['GET', `/receivables/customers/c%2F1?${q}`],
      ['POST', '/receivables/customers'], ['PUT', '/receivables/customers/c'], ['DELETE', `/receivables/customers/c?${q}`],
    ]);
    expect(call(request, 3).body).toEqual({ scope, name: 'A' });
  });

  it('正常: 請求書の一覧・検査・保存・取得・削除・発行・取消・複製', async () => {
    const { request, api } = transport({ invoices: [], check: { violations: [] }, invoice: { id: 'i' } });
    await api.listInvoices(scope, { status: 'draft', customerId: 'c', overdue: true });
    expect(await api.checkInvoice(scope, { pricing: 'exclusive', lines: [] })).toEqual({ violations: [] });
    await api.saveInvoice(scope, { pricing: 'exclusive', lines: [] });
    await api.saveInvoice(scope, { pricing: 'exclusive', lines: [] }, 'i');
    await api.getInvoice(scope, 'i');
    await api.deleteInvoice(scope, 'i');
    await api.issueInvoice(scope, 'i');
    await api.voidInvoice(scope, 'i', '誤り');
    await api.duplicateInvoice(scope, 'i');
    await api.listInvoices(scope);
    expect(request.mock.calls.map((_, index) => `${call(request, index).method} ${call(request, index).path}`)).toEqual([
      `GET /receivables/invoices?${q}&status=draft&customerId=c&overdue=true`, 'POST /receivables/invoices/check', 'POST /receivables/invoices', 'PUT /receivables/invoices/i',
      `GET /receivables/invoices/i?${q}`, `DELETE /receivables/invoices/i?${q}`, 'POST /receivables/invoices/i/issue', 'POST /receivables/invoices/i/void', 'POST /receivables/invoices/i/duplicate',
      `GET /receivables/invoices?${q}`,
    ]);
    expect(call(request, 7).body).toEqual({ scope, reason: '誤り' });
  });

  it('正常: プロファイル・プレビュー・取込・明細・判定・候補・消込', async () => {
    const { request, api } = transport({ profiles: [], profile: {}, preview: { headerRow: 1 }, result: { ok: true }, transactions: [], transaction: { id: 't' }, matchings: [] });
    await api.listProfiles(scope);
    await api.saveProfile(scope, { name: 'x', mapping: { date: 'd' } });
    await api.deleteProfile(scope, 'p');
    expect(await api.previewCsv(scope, { contentBase64: 'AA==' })).toEqual({ headerRow: 1 });
    expect(await api.importCsv(scope, { contentBase64: 'AA==', forceRows: [2] })).toEqual({ ok: true });
    await api.listTransactions(scope, { status: 'unmatched' });
    await api.listTransactions(scope);
    await api.deleteTransaction(scope, 't');
    expect(await api.ignoreTransaction(scope, 't', '利息')).toEqual({ id: 't' });
    await api.ignoreTransaction(scope, 't');
    await api.unignoreTransaction(scope, 't');
    await api.judge(scope, ['t']);
    await api.judge(scope);
    await api.candidates(scope, 't');
    await api.confirmMatching(scope, { transactionId: 't', allocations: [], feeAmount: 0 });
    await api.confirmDecided(scope);
    await api.listMatchings(scope, { status: 'confirmed', invoiceId: 'i' });
    await api.listMatchings(scope);
    await api.cancelMatching(scope, 'm', true);
    await api.cancelMatching(scope, 'm');
    expect(request.mock.calls.map((_, index) => `${call(request, index).method} ${call(request, index).path}`)).toEqual([
      `GET /receivables/bank-csv-profiles?${q}`, 'POST /receivables/bank-csv-profiles', `DELETE /receivables/bank-csv-profiles/p?${q}`,
      'POST /receivables/bank-transactions/preview', 'POST /receivables/bank-transactions/import', `GET /receivables/bank-transactions?${q}&status=unmatched`,
      `GET /receivables/bank-transactions?${q}`, `DELETE /receivables/bank-transactions/t?${q}`, 'POST /receivables/bank-transactions/t/ignore', 'POST /receivables/bank-transactions/t/ignore',
      'POST /receivables/bank-transactions/t/unignore', 'POST /receivables/matching/judge', 'POST /receivables/matching/judge', `GET /receivables/matching/candidates?${q}&transactionId=t`,
      'POST /receivables/matchings', 'POST /receivables/matchings/confirm-decided', `GET /receivables/matchings?${q}&status=confirmed&invoiceId=i`, `GET /receivables/matchings?${q}`,
      'POST /receivables/matchings/m/cancel', 'POST /receivables/matchings/m/cancel',
    ]);
    expect(call(request, 4).body).toEqual({ scope, contentBase64: 'AA==', forceRows: [2] });
    expect(call(request, 8).body).toEqual({ scope, note: '利息' });
    expect(call(request, 9).body).toEqual({ scope });
    expect(call(request, 11).body).toEqual({ scope, transactionIds: ['t'] });
    expect(call(request, 18).body).toEqual({ scope, removeLearnedAlias: true });
    expect(call(request, 19).body).toEqual({ scope });
  });

  it('境界: 機能フラグは /runtime/capabilities の receivables キー。無ければ「使えない」', async () => {
    expect(await transport({ receivables: { invoiceDraft: { enabled: true, vision: true } } }).api.capabilities()).toEqual({ invoiceDraft: { enabled: true, vision: true } });
    expect(await transport({ journal: {} }).api.capabilities()).toEqual({ invoiceDraft: { enabled: false, vision: false } });
  });
});

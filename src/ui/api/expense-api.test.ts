import { describe, expect, it, vi } from 'vitest';
import { EXPENSE_CAPABILITIES_DISABLED, expenseApi } from './expense-api';
import type { SaveExpensePolicyDto } from './expense-types';

const SCOPE = { tenantId: 't', workspaceId: 'w' };
const Q = 'tenantId=t&workspaceId=w';

/** 送信口の偽物。応答本文を決め、呼ばれたパスと init を記録する。 */
function transportReturning(body: unknown) {
  const request = vi.fn().mockResolvedValue(body);
  return { request, api: expenseApi({ request }) };
}

function sentBody(request: ReturnType<typeof vi.fn>, call = 0): unknown {
  const init = request.mock.calls[call]?.[1] as RequestInit | undefined;
  return init?.body === undefined ? undefined : JSON.parse(String(init.body));
}

const policy: SaveExpensePolicyDto = {
  categories: [], claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false },
  preApprovalRules: [], severityOverrides: {}, journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '' },
};

describe('expenseApi', () => {
  describe('capabilities', () => {
    it('正常: expense キーを自分の型で読む（読取・追加読取・ヒアリング）', async () => {
      const { request, api } = transportReturning({ journal: {}, expense: { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: true } } });
      await expect(api.capabilities()).resolves.toEqual({ extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: true } });
      expect(request).toHaveBeenCalledWith('/runtime/capabilities');
    });

    it('境界: 古いサーバー（expense キーが無い / 一部だけ）は欠けた機能を使えない側に倒す', async () => {
      await expect(transportReturning({}).api.capabilities()).resolves.toEqual(EXPENSE_CAPABILITIES_DISABLED);
      await expect(transportReturning({ expense: { extraction: { enabled: true } } }).api.capabilities()).resolves.toEqual({ ...EXPENSE_CAPABILITIES_DISABLED, extraction: { enabled: true, vision: false } });
      await expect(transportReturning({ expense: {} }).api.capabilities()).resolves.toEqual(EXPENSE_CAPABILITIES_DISABLED);
      // MVP のサーバーは extraction だけを返す。
      await expect(transportReturning({ expense: { extraction: { enabled: true, vision: true } } }).api.capabilities()).resolves.toEqual({ ...EXPENSE_CAPABILITIES_DISABLED, extraction: { enabled: true, vision: true } });
    });

    it('異常: 形の違う値（true だけ・文字列・null）は使えない側に倒す', async () => {
      const odd = transportReturning({ expense: { extraction: { enabled: 'yes' }, detailExtraction: true, policyHearing: null } });
      await expect(odd.api.capabilities()).resolves.toEqual(EXPENSE_CAPABILITIES_DISABLED);
      const half = transportReturning({ expense: { detailExtraction: { enabled: true }, policyHearing: { enabled: 'true' } } });
      await expect(half.api.capabilities()).resolves.toEqual({ ...EXPENSE_CAPABILITIES_DISABLED, detailExtraction: { enabled: true } });
    });
  });

  describe('規程', () => {
    it('正常: 取得は GET で本文をそのまま返す', async () => {
      const { request, api } = transportReturning({ policy: { ...policy, updatedAt: 'x' }, saved: false });
      await expect(api.getPolicy(SCOPE)).resolves.toEqual({ policy: { ...policy, updatedAt: 'x' }, saved: false });
      expect(request).toHaveBeenCalledWith(`/expense/policy?${Q}`);
    });

    it('正常: 保存は PUT に scope と規程を載せ、policy を剥がす', async () => {
      const { request, api } = transportReturning({ policy: { ...policy, updatedAt: 'y' } });
      await expect(api.savePolicy(SCOPE, policy)).resolves.toEqual({ ...policy, updatedAt: 'y' });
      expect(request.mock.calls[0]?.[0]).toBe('/expense/policy');
      expect((request.mock.calls[0]?.[1] as RequestInit).method).toBe('PUT');
      expect(sentBody(request)).toEqual({ scope: SCOPE, ...policy });
    });

    it('正常: 初期化・CSV 出力・CSV 取込', async () => {
      const reset = transportReturning({ policy: 'p' });
      await expect(reset.api.resetPolicy(SCOPE)).resolves.toBe('p');
      expect(reset.request.mock.calls[0]?.[0]).toBe('/expense/policy/reset');
      expect((reset.request.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
      expect(sentBody(reset.request)).toEqual({ scope: SCOPE });

      const exported = transportReturning({ content: 'id,name', fileName: 'categories.csv' });
      await expect(exported.api.exportPolicyCsv(SCOPE)).resolves.toEqual({ content: 'id,name', fileName: 'categories.csv' });
      expect(exported.request).toHaveBeenCalledWith(`/expense/policy/export?${Q}`);

      const imported = transportReturning({ policy: 'q' });
      await expect(imported.api.importPolicyCsv(SCOPE, 'id,name')).resolves.toBe('q');
      expect(imported.request.mock.calls[0]?.[0]).toBe('/expense/policy/import');
      expect(sentBody(imported.request)).toEqual({ scope: SCOPE, content: 'id,name' });
    });
  });

  describe('申請', () => {
    it('正常: 一覧は絞り込みをクエリにし、空文字と undefined は送らない', async () => {
      const { request, api } = transportReturning({ claims: ['a'] });
      await expect(api.listClaims(SCOPE)).resolves.toEqual(['a']);
      expect(request.mock.calls[0]?.[0]).toBe(`/expense/claims?${Q}`);
      await api.listClaims(SCOPE, { status: 'approved', claimant: '', limit: 20 });
      expect(request.mock.calls[1]?.[0]).toBe(`/expense/claims?${Q}&status=approved&limit=20`);
    });

    it('正常: 実用化の絞り込み（従業員・部門・仮払・自分の承認待ち・未紐付け・承認中）をクエリにする', async () => {
      const { request, api } = transportReturning({ claims: [] });
      await api.listClaims(SCOPE, { status: 'in-approval', employeeId: 'e 1', departmentId: 'd1', advanceId: 'adv-1', awaiting: 'me', unlinked: true });
      expect(request.mock.calls[0]?.[0]).toBe(`/expense/claims?${Q}&status=in-approval&employeeId=e+1&departmentId=d1&advanceId=adv-1&awaiting=me&unlinked=true`);
    });

    it('境界: unlinked=false と空の従業員 id は送らない（絞り込まない）', async () => {
      const { request, api } = transportReturning({ claims: [] });
      await api.listClaims(SCOPE, { unlinked: false, employeeId: '' });
      expect(request.mock.calls[0]?.[0]).toBe(`/expense/claims?${Q}`);
    });

    it('正常: 作成・取得・更新・削除（id は URL エンコードする）', async () => {
      const input = { claimant: { name: '山田' }, period: { from: '2026-09-01', to: '2026-09-30' } };
      const { request, api } = transportReturning({ claim: 'c' });
      await expect(api.createClaim(SCOPE, input)).resolves.toBe('c');
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, ...input });

      await expect(api.getClaim(SCOPE, 'c/1')).resolves.toBe('c');
      expect(request.mock.calls[1]?.[0]).toBe(`/expense/claims/c%2F1?${Q}`);

      await expect(api.updateClaim(SCOPE, 'c1', input)).resolves.toBe('c');
      expect(request.mock.calls[2]?.[0]).toBe('/expense/claims/c1');
      expect((request.mock.calls[2]?.[1] as RequestInit).method).toBe('PUT');
      expect(sentBody(request, 2)).toEqual({ scope: SCOPE, ...input });

      await expect(api.deleteClaim(SCOPE, 'c1')).resolves.toBeUndefined();
      expect(request.mock.calls[3]?.[0]).toBe(`/expense/claims/c1?${Q}`);
      expect((request.mock.calls[3]?.[1] as RequestInit).method).toBe('DELETE');
    });

    it('正常: 明細の保存・削除・領収書の取得', async () => {
      const { request, api } = transportReturning({ claim: 'c', receipt: { dataUrl: 'data:x' } });
      const item = { facts: { amount: 100 }, source: { type: 'manual' as const } };
      await expect(api.saveItem(SCOPE, 'c1', item)).resolves.toBe('c');
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/c1/items');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, ...item });

      await expect(api.deleteItem(SCOPE, 'c1', 'i/1')).resolves.toBe('c');
      expect(request.mock.calls[1]?.[0]).toBe(`/expense/claims/c1/items/i%2F1?${Q}`);
      expect((request.mock.calls[1]?.[1] as RequestInit).method).toBe('DELETE');

      await expect(api.getReceipt(SCOPE, 'c1', 'i1')).resolves.toEqual({ dataUrl: 'data:x' });
      expect(request.mock.calls[2]?.[0]).toBe(`/expense/claims/c1/items/i1/receipt?${Q}`);
    });
  });

  describe('取込・チェック', () => {
    it('正常: CSV 取込と読取は result を剥がす。読取は中断の signal を渡し、無ければキーを作らない', async () => {
      const { request, api } = transportReturning({ result: 'r' });
      const csv = { content: 'a', period: { from: '2026-09-01', to: '2026-09-30' } };
      await expect(api.importCsv(SCOPE, csv)).resolves.toBe('r');
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/import-csv');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, ...csv });

      const controller = new AbortController();
      await expect(api.extractReceipt(SCOPE, { images: ['data:a'] }, controller.signal)).resolves.toBe('r');
      expect(request.mock.calls[1]?.[0]).toBe('/expense/receipts/extract');
      expect((request.mock.calls[1]?.[1] as RequestInit).signal).toBe(controller.signal);
      expect(sentBody(request, 1)).toEqual({ scope: SCOPE, images: ['data:a'] });

      await api.extractReceipt(SCOPE, { images: ['data:b'] });
      expect('signal' in (request.mock.calls[2]?.[1] as RequestInit)).toBe(false);
    });

    it('正常: チェックは id 指定の有無で本文を変える', async () => {
      const { request, api } = transportReturning({ result: { checked: 1 } });
      await expect(api.checkClaims(SCOPE)).resolves.toEqual({ checked: 1 });
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/check');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE });
      await api.checkClaims(SCOPE, ['c1']);
      expect(sentBody(request, 1)).toEqual({ scope: SCOPE, claimIds: ['c1'] });
    });
  });

  describe('確認・差し戻し・承認', () => {
    it('正常: 確認済み・差し戻し文言・差し戻し・承認取消', async () => {
      const { request, api } = transportReturning({ claim: 'c', message: '山田 さん' });
      await expect(api.acknowledge(SCOPE, 'c1', { itemId: 'i1', code: 'payee-missing', note: 'ok' })).resolves.toBe('c');
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/c1/acknowledge');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, itemId: 'i1', code: 'payee-missing', note: 'ok' });

      await expect(api.returnDraft(SCOPE, 'c1')).resolves.toBe('山田 さん');
      expect(request.mock.calls[1]?.[0]).toBe(`/expense/claims/c1/return-draft?${Q}`);

      await expect(api.returnClaim(SCOPE, 'c1', 'msg')).resolves.toBe('c');
      expect(request.mock.calls[2]?.[0]).toBe('/expense/claims/c1/return');
      expect(sentBody(request, 2)).toEqual({ scope: SCOPE, message: 'msg' });

      await expect(api.unapprove(SCOPE, 'c1', 'mistake')).resolves.toBe('c');
      expect(request.mock.calls[3]?.[0]).toBe('/expense/claims/c1/unapprove');
      expect(sentBody(request, 3)).toEqual({ scope: SCOPE, note: 'mistake' });
    });

    it('境界: 承認のコメントは空文字と undefined を送らない', async () => {
      const { request, api } = transportReturning({ claim: 'c' });
      await expect(api.approve(SCOPE, 'c1', 'good')).resolves.toBe('c');
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/c1/approve');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, comment: 'good' });
      await api.approve(SCOPE, 'c1', '');
      expect(sentBody(request, 1)).toEqual({ scope: SCOPE });
      await api.approve(SCOPE, 'c1');
      expect(sentBody(request, 2)).toEqual({ scope: SCOPE });
    });

    it('正常: 承認中の段を進めるときは現在の段の id を送り、空なら送らない', async () => {
      const { request, api } = transportReturning({ claim: 'c' });
      await api.approve(SCOPE, 'c1', '部長の代理で承認', 'head');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE, comment: '部長の代理で承認', stepId: 'head' });
      await api.approve(SCOPE, 'c1', undefined, 'head');
      expect(sentBody(request, 1)).toEqual({ scope: SCOPE, stepId: 'head' });
      await api.approve(SCOPE, 'c1', '', '');
      expect(sentBody(request, 2)).toEqual({ scope: SCOPE });
    });
  });

  describe('出力', () => {
    it('正常: 仕訳下書きは本文の包みを剥がさない（claim / entryIds / warnings を並べて返す）', async () => {
      const body = { claim: 'c', entryIds: ['e1'], warnings: [] };
      const { request, api } = transportReturning(body);
      await expect(api.createJournalDrafts(SCOPE, 'c1')).resolves.toEqual(body);
      expect(request.mock.calls[0]?.[0]).toBe('/expense/claims/c1/journal-drafts');
      expect(sentBody(request, 0)).toEqual({ scope: SCOPE });
    });

    it('正常: 精算 CSV はクエリ、精算済みは POST（ファイル名は任意）', async () => {
      const { request, api } = transportReturning({ result: 'csv', claims: ['c'] });
      await expect(api.exportSettlement(SCOPE, { format: 'payout', status: 'approved' })).resolves.toBe('csv');
      expect(request.mock.calls[0]?.[0]).toBe(`/expense/export?${Q}&format=payout&status=approved`);

      await expect(api.settleClaims(SCOPE, ['c1'], 'payout.csv')).resolves.toEqual(['c']);
      expect(request.mock.calls[1]?.[0]).toBe('/expense/claims/settle');
      expect(sentBody(request, 1)).toEqual({ scope: SCOPE, claimIds: ['c1'], exportFileName: 'payout.csv' });
      await api.settleClaims(SCOPE, ['c1']);
      expect(sentBody(request, 2)).toEqual({ scope: SCOPE, claimIds: ['c1'] });
    });
  });
});

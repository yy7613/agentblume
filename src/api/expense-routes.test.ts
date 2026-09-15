/**
 * /expense ルートのテスト。
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で検証する。
 * 守りたいのは **UI（`src/ui/api/expense-api.ts`）が期待する形**: パス・クエリ名・応答の包み方
 * （`{ policy, saved } / { policy } / { claims } / { claim } / { result } / { message } / { receipt }`、削除は 204）と、
 * 409 の本文に載る「直す場所」（`blockingReasons` / `problems` / `claims`）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { claimFixture } from '../adapters/storage/expense-repository.fixtures';
import { fixtureEmployees, fixtureOrganization } from '../adapters/storage/expense-v9.fixtures';
import { InMemoryAuditLogRepository } from '../adapters/storage/in-memory-audit-log-repository';
import { ExtractReceiptUseCase } from '../application/expense/extract-receipt';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { mvpApprovalPlan } from '../domain/expense/approval';
import { defaultExpensePolicy } from '../domain/expense/default-policy';
import { createExpensePolicy } from '../domain/expense/policy';
import { expenseClaimResponse } from './expense-routes';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const TOKEN = 'e'.repeat(40);

const claimBody = { scope: SCOPE, claimant: { name: 'テスト太郎', employeeCode: 'E001' }, period: { from: '2026-09-01', to: '2026-09-30' }, title: '9 月分' };

/** 規程上なにも出ない明細（電車・バスは領収書不要・3 万円未満は登録番号不要）。 */
const passingItem = {
  scope: SCOPE, categoryId: 'transport.public', source: { type: 'manual' },
  facts: { transactionDate: '2026-09-02', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', description: '霞ケ関→大手町' },
};

describe('expense routes', () => {
  let app: App;
  let server: FastifyInstance;

  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  async function createClaim(): Promise<string> {
    const res = await inject('POST', '/expense/claims', claimBody);
    expect(res.statusCode).toBe(200);
    return res.json().claim.id as string;
  }

  /** 規程を保存済みにする（`policy-unreviewed` を出さないため）。 */
  async function savePolicy(): Promise<void> {
    expect((await inject('POST', '/expense/policy/reset', { scope: SCOPE })).statusCode).toBe(200);
  }

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('規程', () => {
    it('正常: GET /expense/policy は未保存なら初期テンプレートと saved=false を返し、書き込まない', async () => {
      const res = await inject('GET', `/expense/policy?${scopeQuery}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.saved).toBe(false);
      expect(body.policy.categories.map((category: { id: string }) => category.id)).toContain('meal.entertainment');
      expect(await app.expensePolicyRepo.get(SCOPE)).toBeNull();
    });

    it('正常: PUT で全体を保存し、以後は saved=true。reset・CSV 出力・CSV 取込も包みを保つ', async () => {
      const { policy } = (await inject('GET', `/expense/policy?${scopeQuery}`)).json();
      const { updatedAt: _updatedAt, ...draft } = policy;
      const saved = await inject('PUT', '/expense/policy', { scope: SCOPE, ...draft, severityOverrides: { 'payee-missing': 'return' } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().policy.severityOverrides).toEqual({ 'payee-missing': 'return' });
      expect((await inject('GET', `/expense/policy?${scopeQuery}`)).json().saved).toBe(true);

      const exported = await inject('GET', `/expense/policy/export?${scopeQuery}`);
      expect(exported.statusCode).toBe(200);
      expect(exported.json().fileName).toBe('expense-categories.csv');
      expect(exported.json().content.startsWith('﻿id,code,name,enabled')).toBe(true);

      const imported = await inject('POST', '/expense/policy/import', { scope: SCOPE, content: exported.json().content });
      expect(imported.statusCode).toBe(200);
      expect(imported.json().policy.severityOverrides).toEqual({ 'payee-missing': 'return' });

      const reset = await inject('POST', '/expense/policy/reset', { scope: SCOPE });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().policy.severityOverrides).toEqual({});
    });

    it('異常: 変更できない重さは 400 EXPENSE_DOMAIN、形の崩れは 400 BAD_REQUEST、CSV の行の不正は行番号つき', async () => {
      const { policy } = (await inject('GET', `/expense/policy?${scopeQuery}`)).json();
      const { updatedAt: _updatedAt, ...draft } = policy;
      const fixed = await inject('PUT', '/expense/policy', { scope: SCOPE, ...draft, severityOverrides: { 'amount-missing': 'review' } });
      expect(fixed.statusCode).toBe(400);
      expect(fixed.json().error.code).toBe('EXPENSE_DOMAIN');

      const shape = await inject('PUT', '/expense/policy', { scope: SCOPE, ...draft, categories: 'nope' });
      expect(shape.statusCode).toBe(400);
      expect(shape.json().error.code).toBe('BAD_REQUEST');

      const csv = await inject('POST', '/expense/policy/import', { scope: SCOPE, content: 'id,name,enabled\r\nmisc,その他,maybe\r\n' });
      expect(csv.statusCode).toBe(400);
      expect(csv.json().error).toMatchObject({ code: 'EXPENSE_DOMAIN', row: 2 });
    });
  });

  describe('申請と明細', () => {
    it('正常: 作成・取得・一覧・編集・削除の包みを保つ（削除は 204）', async () => {
      const created = await inject('POST', '/expense/claims', claimBody);
      const { claim } = created.json();
      expect(claim).toMatchObject({ status: 'draft', items: [], totalAmount: 0, stale: false, approvalBlockers: [], claimant: { name: 'テスト太郎' } });
      expect(claim).not.toHaveProperty('tenant');

      expect((await inject('GET', `/expense/claims/${claim.id}?${scopeQuery}`)).json().claim.id).toBe(claim.id);
      const list = await inject('GET', `/expense/claims?${scopeQuery}&status=draft&claimant=${encodeURIComponent('太郎')}&limit=10`);
      expect(list.json().claims.map((summary: { id: string }) => summary.id)).toEqual([claim.id]);

      const updated = await inject('PUT', `/expense/claims/${claim.id}`, { ...claimBody, title: '9 月分（修正）' });
      expect(updated.json().claim.title).toBe('9 月分（修正）');

      expect((await inject('DELETE', `/expense/claims/${claim.id}?${scopeQuery}`)).statusCode).toBe(204);
      const missing = await inject('GET', `/expense/claims/${claim.id}?${scopeQuery}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('EXPENSE_CLAIM_NOT_FOUND');
    });

    it('正常: 明細の証憑本体は申請の応答に含めず hasReceipt だけを返し、receipt ルートで本体を返す', async () => {
      const id = await createClaim();
      const saved = await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, source: { type: 'image', fileName: 'metro.png' }, receipt: { dataUrl: PNG, fileName: 'metro.png' } });
      expect(saved.statusCode).toBe(200);
      const item = saved.json().claim.items[0];
      expect(item.hasReceipt).toBe(true);
      expect(JSON.stringify(saved.json())).not.toContain('base64');

      const receipt = await inject('GET', `/expense/claims/${id}/items/${item.id}/receipt?${scopeQuery}`);
      expect(receipt.json().receipt).toEqual({ dataUrl: PNG, fileName: 'metro.png' });

      const plain = (await inject('POST', `/expense/claims/${id}/items`, passingItem)).json().claim.items[1];
      const noReceipt = await inject('GET', `/expense/claims/${id}/items/${plain.id}/receipt?${scopeQuery}`);
      expect(noReceipt.statusCode).toBe(404);
      expect(noReceipt.json().error.code).toBe('EXPENSE_RECEIPT_NOT_FOUND');

      const noItem = await inject('DELETE', `/expense/claims/${id}/items/missing?${scopeQuery}`);
      expect(noItem.statusCode).toBe(404);
      expect(noItem.json().error.code).toBe('EXPENSE_ITEM_NOT_FOUND');

      const removed = await inject('DELETE', `/expense/claims/${id}/items/${item.id}?${scopeQuery}`);
      expect(removed.json().claim.items).toHaveLength(1);
    });

    it('正常: 形の合わない登録番号は 400 にせず落として警告に残す。異常: 外部 URL の証憑は 400', async () => {
      const id = await createClaim();
      const saved = await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, facts: { ...passingItem.facts, registrationNumber: 'T123456789012' } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().claim.items[0].extraction).toMatchObject({ rejectedRegistrationNumber: 'T123456789012' });
      expect(saved.json().claim.items[0].facts.registrationNumber).toBeUndefined();

      const external = await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, receipt: { dataUrl: 'https://example.com/a.png' } });
      expect(external.statusCode).toBe(400);
      expect(external.json().error.code).toBe('BAD_REQUEST');
    });

    it('正常: CSV 取込は { result } で申請と列の対応を返す。異常: 取引日の列が無ければ 400 EXPENSE_CSV_IMPORT', async () => {
      const csv = '申請者,日付,支払先,金額,費目,目的\r\nテスト花子,2026/09/03,東京メトロ,420,電車,客先訪問\r\n';
      const res = await inject('POST', '/expense/claims/import-csv', { scope: SCOPE, content: csv, period: { from: '2026-09-01', to: '2026-09-30' }, fileName: 'claims.csv' });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.claims).toMatchObject([{ claimant: { name: 'テスト花子' }, importedCount: 1, created: true }]);
      expect(result.columnMatches).toContainEqual({ header: '費目', field: 'category' });

      const broken = await inject('POST', '/expense/claims/import-csv', { scope: SCOPE, content: '申請者,金額\r\nx,1\r\n', period: { from: '2026-09-01', to: '2026-09-30' } });
      expect(broken.statusCode).toBe(400);
      expect(broken.json().error.code).toBe('EXPENSE_CSV_IMPORT');
    });
  });

  describe('読取', () => {
    it('例外: test プロファイルはモデルが無いので 409 JOURNAL_EXTRACTION_UNAVAILABLE（仕訳の写像がそのまま効く）', async () => {
      const res = await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [PNG], fileName: 'receipt.png' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOURNAL_EXTRACTION_UNAVAILABLE');
    });

    it('正常: 読取ポートを差し替えると { result } で下書きを返し、保存しない。異常: 画像が無ければ 400', async () => {
      Object.assign(app, {
        extractExpenseReceipt: new ExtractReceiptUseCase({
          read: async () => ({ documentKind: 'receipt', facts: { issuerName: 'サンプルタクシー', transactionDate: '2026-09-10', grandTotal: 3200, description: 'タクシー代' }, warnings: ['登録番号が取れていない'] }),
        }, app.expensePolicyRepo),
      });
      await server.close();
      server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
      const res = await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [PNG], fileName: 'taxi.png' });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.drafts[0]).toMatchObject({ categoryId: 'transport.taxi', facts: { payeeName: 'サンプルタクシー', amount: 3200 }, extraction: { method: 'llm', warnings: ['登録番号が取れていない'] } });
      expect((await inject('GET', `/expense/claims?${scopeQuery}`)).json().claims).toEqual([]);

      expect((await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [] })).statusCode).toBe(400);
    });
  });

  describe('チェック・確認・差し戻し・承認', () => {
    it('正常: 通過した申請を承認し、仕訳下書きを作り、精算 CSV を出して精算済みにする', async () => {
      await savePolicy();
      const id = await createClaim();
      await inject('POST', `/expense/claims/${id}/items`, passingItem);

      const checked = await inject('POST', '/expense/claims/check', { scope: SCOPE });
      expect(checked.json().result).toMatchObject({ checked: 1, pass: 1, needsReview: 0, returned: 0, skipped: 0 });
      expect((await inject('GET', `/expense/claims?${scopeQuery}&verdict=pass`)).json().claims).toHaveLength(1);

      const approved = await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE, comment: '問題なし' });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().claim).toMatchObject({ status: 'approved', approval: { comment: '問題なし' } });

      const drafted = await inject('POST', `/expense/claims/${id}/journal-drafts`, { scope: SCOPE });
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json().entryIds).toHaveLength(1);
      expect(drafted.json().claim.journalLink).toMatchObject({ complete: true });
      const entries = (await inject('GET', `/journal/entries?${scopeQuery}`)).json().entries;
      // 仕訳画面から見える（同じ保管庫）。科目名は科目マスタから写る。
      expect(entries).toMatchObject([{ status: 'draft', tags: ['expense', `expense-claim:${id}`, expect.stringMatching(/^expense-item:/u)], lines: [{ accountId: 'expense.travel', accountName: '旅費交通費' }, { accountId: 'liability.other_payables' }] }]);

      const exported = await inject('GET', `/expense/export?${scopeQuery}&format=payout`);
      expect(exported.statusCode).toBe(200);
      expect(exported.json().result).toMatchObject({ format: 'payout', claimCount: 1, totalAmount: 420 });
      // 出力は状態を変えない。
      expect((await inject('GET', `/expense/claims/${id}?${scopeQuery}`)).json().claim.status).toBe('approved');

      const settled = await inject('POST', '/expense/claims/settle', { scope: SCOPE, claimIds: [id], exportFileName: exported.json().result.fileName });
      expect(settled.json().claims).toMatchObject([{ id, status: 'settled' }]);
      const unapprove = await inject('POST', `/expense/claims/${id}/unapprove`, { scope: SCOPE, note: '戻す' });
      expect(unapprove.statusCode).toBe(409);
      expect(unapprove.json().error.code).toBe('EXPENSE_TRANSITION');
    });

    it('異常: 未確認の要確認が残る承認は 409 に blockingReasons と nextStep を載せ、確認済みにすれば承認できる', async () => {
      await savePolicy();
      const id = await createClaim();
      const item = (await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, facts: { ...passingItem.facts, payeeName: undefined } })).json().claim.items[0];
      await inject('POST', '/expense/claims/check', { scope: SCOPE, claimIds: [id] });
      const claim = (await inject('GET', `/expense/claims/${id}?${scopeQuery}`)).json().claim;
      expect(claim.approvalBlockers).toEqual([{ code: 'payee-missing', itemId: item.id }]);

      const blocked = await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'payee-missing', itemId: item.id }] });
      expect(typeof blocked.json().error.nextStep).toBe('string');

      const acknowledged = await inject('POST', `/expense/claims/${id}/acknowledge`, { scope: SCOPE, itemId: item.id, code: 'payee-missing', note: '券売機の領収書で支払先の印字が無い' });
      expect(acknowledged.json().claim.acknowledgements).toHaveLength(1);
      expect((await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE })).statusCode).toBe(200);
    });

    it('正常: 差し戻し文言の下書きを返し、差し戻すと returned になる。異常: draft の下書き・確認済みは 409', async () => {
      await savePolicy();
      const id = await createClaim();
      await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, facts: { ...passingItem.facts, transactionDate: '2026-08-20' } });
      const early = await inject('GET', `/expense/claims/${id}/return-draft?${scopeQuery}`);
      expect(early.statusCode).toBe(409);
      const earlyAck = await inject('POST', `/expense/claims/${id}/acknowledge`, { scope: SCOPE, code: 'claim-empty', note: 'x' });
      expect(earlyAck.statusCode).toBe(409);

      await inject('POST', '/expense/claims/check', { scope: SCOPE, claimIds: [id] });
      const draft = await inject('GET', `/expense/claims/${id}/return-draft?${scopeQuery}`);
      expect(draft.statusCode).toBe(200);
      expect(draft.json().message).toContain('テスト太郎 さん');
      expect(draft.json().message).toContain('対象外');

      const returned = await inject('POST', `/expense/claims/${id}/return`, { scope: SCOPE, message: draft.json().message });
      expect(returned.json().claim).toMatchObject({ status: 'returned', returnNote: { reasons: [{ code: 'date-outside-period' }] } });
    });

    it('異常: 仕訳連携の問題は 409 EXPENSE_JOURNAL_LINK に problems を載せ、承認済み以外の精算は 409 に claims を載せる', async () => {
      await savePolicy();
      const id = await createClaim();
      await inject('POST', `/expense/claims/${id}/items`, passingItem);
      await inject('POST', '/expense/claims/check', { scope: SCOPE, claimIds: [id] });
      await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE });

      // 承認の後で費目の科目を外す（連携の時点で検証される）。
      const { policy } = (await inject('GET', `/expense/policy?${scopeQuery}`)).json();
      const { updatedAt: _updatedAt, ...draft } = policy;
      const categories = draft.categories.map((category: { id: string; accountId?: string }) => {
        if (category.id !== 'transport.public') return category;
        const { accountId: _accountId, ...rest } = category;
        return rest;
      });
      await inject('PUT', '/expense/policy', { scope: SCOPE, ...draft, categories });
      const linked = await inject('POST', `/expense/claims/${id}/journal-drafts`, { scope: SCOPE });
      expect(linked.statusCode).toBe(409);
      expect(linked.json().error).toMatchObject({ code: 'EXPENSE_JOURNAL_LINK', problems: [{ code: 'account-missing', fixTarget: 'policy-category', categoryId: 'transport.public' }], createdEntryIds: [] });

      const draftClaim = await createClaim();
      const settle = await inject('POST', '/expense/claims/settle', { scope: SCOPE, claimIds: [id, draftClaim] });
      expect(settle.statusCode).toBe(409);
      expect(settle.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', claims: [{ id: draftClaim, status: 'draft' }] });
    });

    it('境界: 任意項目（題名・費目文字列・明細 id・読取メタ・コメント・期間の絞り込み・出力の状態）を付けても省いても形を保つ', async () => {
      await savePolicy();
      const created = (await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'テスト次郎' }, period: { from: '2026-09-01', to: '2026-09-30' } })).json().claim;
      expect(created).not.toHaveProperty('title');
      const updated = (await inject('PUT', `/expense/claims/${created.id}`, { scope: SCOPE, claimant: { name: 'テスト次郎' }, period: { from: '2026-09-01', to: '2026-09-30' } })).json().claim;
      expect(updated).not.toHaveProperty('title');

      const withMeta = await inject('POST', `/expense/claims/${created.id}/items`, {
        ...passingItem, itemId: 'fixed-id', categoryId: undefined, categoryText: '電車',
        extraction: { method: 'llm', model: { provider: 'p', model: 'm' }, confidence: 0.9, warnings: [], documentKind: 'receipt' },
      });
      expect(withMeta.json().claim.items[0]).toMatchObject({ id: 'fixed-id', categoryId: 'transport.public', categoryText: '電車', extraction: { method: 'llm', documentKind: 'receipt' } });

      const csv = '日付,支払先,金額,費目,目的\r\n2026/09/04,東京メトロ,210,電車,客先訪問\r\n';
      const appended = await inject('POST', '/expense/claims/import-csv', { scope: SCOPE, content: csv, period: { from: '2026-09-01', to: '2026-09-30' }, claimId: created.id });
      expect(appended.json().result.claims).toMatchObject([{ id: created.id, created: false, itemCount: 2 }]);

      expect((await inject('POST', '/expense/claims/check', { scope: SCOPE, claimIds: [created.id] })).json().result.checked).toBe(1);
      const filtered = await inject('GET', `/expense/claims?${scopeQuery}&verdict=pass&from=2026-09-15&to=2026-09-15`);
      expect(filtered.json().claims.map((summary: { id: string }) => summary.id)).toEqual([created.id]);

      expect((await inject('POST', `/expense/claims/${created.id}/approve`, { scope: SCOPE })).json().claim.approval).not.toHaveProperty('comment');
      const exported = await inject('GET', `/expense/export?${scopeQuery}&format=detail&status=approved&from=2026-09-01&to=2026-09-30`);
      expect(exported.json().result).toMatchObject({ format: 'detail', itemCount: 2 });
      const settled = await inject('POST', '/expense/claims/settle', { scope: SCOPE, claimIds: [created.id] });
      expect(settled.json().claims[0].settlement).not.toHaveProperty('exportFileName');
      expect((await inject('GET', `/expense/export?${scopeQuery}&format=payout&status=settled`)).json().result.claimCount).toBe(1);
      const unapprove = await inject('POST', `/expense/claims/${created.id}/unapprove`, { scope: SCOPE, note: '' });
      expect(unapprove.statusCode).toBe(409);

      // 読取はテキスト付きでも入口を通る（test プロファイルのモデル不在で 409 まで届く）。
      const withText = await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [PNG], text: 'PDF のテキスト層' });
      expect(withText.statusCode).toBe(409);
    });

    it('正常: GET /runtime/capabilities は expense キーを返す（test プロファイルは使えない側）', async () => {
      const res = await inject('GET', '/runtime/capabilities');
      expect(res.statusCode).toBe(200);
      expect(res.json().expense).toEqual({ extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } });
    });
  });
});

describe('expense routes の認可と監査', () => {
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

  function serverFor(roles: readonly AuthorizationRole[]): FastifyInstance {
    return buildServer(app, { authentication: rolesAuth(roles), authorization: new RoleMatrixAuthorization(), audit: { sink: audit, fallbackScope: SCOPE } });
  }

  beforeEach(() => {
    audit = new InMemoryAuditLogRepository();
    app = createApp({ profile: 'test', auditLogRepository: audit });
  });
  afterEach(() => { app.close(); });

  it('承認と承認取消は approve（Publisher 以上）: Viewer / Editor は 403、Publisher は認可を通って 404 まで届く', async () => {
    const viewer = serverFor(['viewer']);
    expect((await viewer.inject({ method: 'GET', url: `/expense/claims?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'POST', url: '/expense/claims', headers: auth, payload: claimBody })).statusCode).toBe(403);
    const editor = serverFor(['editor']);
    expect((await editor.inject({ method: 'POST', url: '/expense/claims/none/approve', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    expect((await editor.inject({ method: 'POST', url: '/expense/claims/none/unapprove', headers: auth, payload: { scope: SCOPE, note: 'x' } })).statusCode).toBe(403);
    const publisher = serverFor(['publisher']);
    expect((await publisher.inject({ method: 'POST', url: '/expense/claims/none/approve', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(404);
  });

  it('監査対象（規程の保存）は成功が 1 件記録され、参照は記録されない', async () => {
    const editor = serverFor(['editor']);
    expect((await editor.inject({ method: 'POST', url: '/expense/policy/reset', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'GET', url: `/expense/policy?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    await new Promise((resolve) => { setImmediate(resolve); });
    const entries = await audit.list(SCOPE);
    expect(entries).toMatchObject([{ subject: 'rita', action: 'edit', outcome: 'succeeded' }]);
  });
});

describe('expense routes の実用化（§20.9.1）', () => {
  let app: App;
  let server: FastifyInstance;
  const period = { from: '2026-09-01', to: '2026-09-30' };

  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, target: FastifyInstance = server) => target.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  /** 資格情報を検査せず、指定の subject の Publisher として通すトークン認証（「あなたの承認待ち」の主体を切り替える）。 */
  const serverAs = (subject: string): FastifyInstance => buildServer(app, {
    authentication: { mode: 'token', required: true, authenticate: async () => authenticated({ subject, ...SCOPE, roles: ['publisher'] }) },
    authorization: new RoleMatrixAuthorization(),
  });
  const createFor = async (claimant: Record<string, unknown>): Promise<string> => (await inject('POST', '/expense/claims', { scope: SCOPE, claimant, period })).json().claim.id as string;

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

  it('正常: 申請者の employeeId を指定すると氏名・社員番号・部門を従業員マスタから写し、部門 id も持つ。異常: 無い・無効な従業員は 400（直す欄つき）', async () => {
    const created = await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: '偽名', department: '勝手な部門', employeeId: 'emp-taro' }, period });
    expect(created.statusCode).toBe(200);
    expect(created.json().claim.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' });
    const updated = await inject('PUT', `/expense/claims/${created.json().claim.id}`, { scope: SCOPE, claimant: { name: 'x', employeeId: 'emp-hanako' }, period });
    expect(updated.json().claim.claimant).toMatchObject({ name: 'テスト花子', employeeId: 'emp-hanako', departmentId: 'dept-sales' });

    for (const employeeId of ['emp-none', 'emp-shiro']) {
      const invalid = await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: 'x', employeeId }, period });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: 'EXPENSE_DOMAIN', field: 'claimant.employeeId' });
    }
    // 部門 id だけの申告は写さない（本文の形にも無い）。
    expect((await inject('POST', '/expense/claims', { scope: SCOPE, claimant: { name: '手入力', departmentId: 'dept-sales' }, period })).json().claim.claimant).toEqual({ name: '手入力' });
  });

  it('正常: 一覧を employeeId・departmentId・advanceId・unlinked で絞り込む。異常: awaiting の値の誤りは 400', async () => {
    const taro = await createFor({ name: 'x', employeeId: 'emp-taro' });
    const saburo = await createFor({ name: 'x', employeeId: 'emp-saburo' });
    const typed = await createFor({ name: '手入力' });
    await app.expenseClaimRepo.save(claimFixture('with-advance', { tenant: SCOPE, advanceId: 'adv-1' }), new Map());
    const ids = async (query: string): Promise<string[]> => ((await inject('GET', `/expense/claims?${scopeQuery}&${query}`)).json().claims as { id: string }[]).map((summary) => summary.id).sort();
    expect(await ids('employeeId=emp-taro')).toEqual([taro]);
    expect(await ids('departmentId=dept-accounting')).toEqual([saburo]);
    expect(await ids('advanceId=adv-1')).toEqual(['with-advance']);
    expect(await ids('unlinked=true')).toEqual([typed, 'with-advance'].sort());
    expect(await ids('unlinked=false')).toHaveLength(4);
    expect((await inject('GET', `/expense/claims?${scopeQuery}&awaiting=you`)).statusCode).toBe(400);
  });

  it('正常: awaiting=me は単一ユーザーなら checked / in-approval の全件、従業員に結ばれた主体なら自分が現在の段の承認者の申請だけ、結ばれていなければ空', async () => {
    await app.expenseClaimRepo.save(claimFixture('mine', { tenant: SCOPE, status: 'checked' }), new Map(), ['emp-hanako']);
    await app.expenseClaimRepo.save(claimFixture('others', { tenant: SCOPE, status: 'checked' }), new Map(), ['emp-jiro']);
    await app.expenseClaimRepo.save(claimFixture('draft', { tenant: SCOPE }), new Map(), ['emp-hanako']);
    const ids = async (target: FastifyInstance): Promise<string[]> => ((await inject('GET', `/expense/claims?${scopeQuery}&awaiting=me`, undefined, target)).json().claims as { id: string }[]).map((summary) => summary.id).sort();
    expect(await ids(server)).toEqual(['mine', 'others']);
    const hanako = serverAs('hanako@example.com');
    const stranger = serverAs('stranger@example.com');
    try {
      expect(await ids(hanako)).toEqual(['mine']);
      expect(await ids(stranger)).toEqual([]);
    } finally {
      await hanako.close();
      await stranger.close();
    }
  });

  it('正常: 応答は reimbursableAmount と、checked の申請に承認の見通し approvalPlan（MVP は 1 段）を持つ。異常: 承認の stepId が食い違えば 409 approval-step-changed', async () => {
    expect((await inject('POST', '/expense/policy/reset', { scope: SCOPE })).statusCode).toBe(200);
    // beforeEach で従業員マスタを入れている（マスタを使っている）ので、申請者を紐付けておく（未紐付けなら A の claimant-unlinked が承認を止める。§20.3.3）。
    // 通勤定期の無い従業員にする（定期があると C の交通費の照合が動き、区間の無い明細に route-missing が出る）。
    const id = await createFor({ name: 'テスト花子', employeeId: 'emp-hanako' });
    const draft = (await inject('POST', `/expense/claims/${id}/items`, passingItem)).json().claim;
    expect(draft).toMatchObject({ totalAmount: 420, reimbursableAmount: 420, approvalBlockers: [] });
    expect(draft).not.toHaveProperty('approvalPlan');
    await inject('POST', '/expense/claims/check', { scope: SCOPE, claimIds: [id] });
    const checked = (await inject('GET', `/expense/claims/${id}?${scopeQuery}`)).json().claim;
    expect(checked.approvalPlan).toEqual({ routeName: '既定の承認', steps: [{ stepId: 'approve', name: '承認', approverKind: 'any-approver', approvers: [], skipped: false }], unresolved: [] });
    expect(checked.approvalBlockers).toEqual([]);

    const changed = await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE, stepId: 'other-step' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'approval-step-changed', params: { stepName: '承認' } }] });
    expect((await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE, stepId: '' })).statusCode).toBe(400);
    const approved = await inject('POST', `/expense/claims/${id}/approve`, { scope: SCOPE, stepId: 'approve' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().claim).toMatchObject({ status: 'approved', approval: { by: 'single-user' }, reimbursableAmount: 420, approvalBlockers: [] });
    expect(approved.json().claim).not.toHaveProperty('approvalPlan');
  });

  it('正常: PUT /expense/policy の実用化の節は送れば保存し、送らなければ保つ。会社払いを含める運用では reimbursableAmount が会社払いを除く', async () => {
    const { policy } = (await inject('GET', `/expense/policy?${scopeQuery}`)).json();
    const { updatedAt: _updatedAt, approval: _approval, transport: _transport, card, advance: _advance, ...mvp } = policy;
    const withCard = await inject('PUT', '/expense/policy', { scope: SCOPE, ...mvp, card: { ...card, acceptCorporatePaymentItems: true }, transport: { commuterPassDeduction: false, fareToleranceYen: 30, defaultFareType: 'ic' } });
    expect(withCard.statusCode).toBe(200);
    expect(withCard.json().policy.card.acceptCorporatePaymentItems).toBe(true);
    const kept = await inject('PUT', '/expense/policy', { scope: SCOPE, ...mvp, severityOverrides: { 'payee-missing': 'return' } });
    expect(kept.json().policy).toMatchObject({ card: { acceptCorporatePaymentItems: true }, transport: { fareToleranceYen: 30 }, severityOverrides: { 'payee-missing': 'return' } });
    const invalid = await inject('PUT', '/expense/policy', { scope: SCOPE, ...mvp, approval: { routes: 'nope' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('EXPENSE_DOMAIN');

    const id = await createFor({ name: 'テスト太郎' });
    await inject('POST', `/expense/claims/${id}/items`, passingItem);
    const corporate = await inject('POST', `/expense/claims/${id}/items`, { ...passingItem, facts: { ...passingItem.facts, amount: 1000, paymentMethod: 'credit_card', corporatePayment: true } });
    expect(corporate.json().claim).toMatchObject({ totalAmount: 1420, reimbursableAmount: 420 });
  });

  it('例外: 読取の detail: true は追加読取が使えないので、仕訳の読取を回す前に 409 EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE（missing つき）', async () => {
    const res = await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [PNG], detail: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', missing: 'model' });
    // detail: false は従来の読取（test プロファイルのモデル不在）まで届く。
    expect((await inject('POST', '/expense/receipts/extract', { scope: SCOPE, images: [PNG], detail: false })).json().error.code).toBe('JOURNAL_EXTRACTION_UNAVAILABLE');
  });
});

describe('expenseClaimResponse（応答の形）', () => {
  const policy = createExpensePolicy({ ...defaultExpensePolicy('2026-09-14T00:00:00.000Z'), claimRules: { ...defaultExpensePolicy().claimRules, forbidSelfApproval: true } });

  it('正常: 承認の見通し（オブジェクト）を渡すとその拒否理由と計画をそのまま載せる', () => {
    const claim = claimFixture('c1', { status: 'checked' });
    const plan = mvpApprovalPlan();
    const response = expenseClaimResponse(claim, policy, { plan, blockers: [{ code: 'approval-not-current-approver' }] });
    expect(response).toMatchObject({ approvalBlockers: [{ code: 'approval-not-current-approver' }], approvalPlan: plan, totalAmount: 3200, reimbursableAmount: 3200 });
    expect(response).not.toHaveProperty('tenant');
  });

  it('境界: 見ている人（subject の文字列）を渡すと MVP と同じく checked の申請にだけ判定由来の拒否理由（自己承認を含む）を付け、計画は載せない', () => {
    const checked = expenseClaimResponse(claimFixture('c1', { status: 'checked' }), policy, 'tester');
    expect(checked.approvalBlockers).toEqual([{ code: 'judgment-missing' }, { code: 'self-approval' }]);
    expect(checked).not.toHaveProperty('approvalPlan');
    expect(expenseClaimResponse(claimFixture('c2'), policy, 'tester').approvalBlockers).toEqual([]);
    expect(expenseClaimResponse(claimFixture('c3', { status: 'checked' }), policy).approvalBlockers).toEqual([{ code: 'judgment-missing' }]);
  });
});

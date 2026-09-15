/**
 * /expense の振込データ（全銀協。docs/21 §20.9.3 の振込 8 ルート）のテスト。
 *
 * createApp({profile:'test'}) + buildServer で配線する。従業員は系統 A のユースケースで保存し（口座番号をアプリの鍵で封緘する）、
 * 振込データの作成・再ダウンロードで `openAccountNumber` が同じ鍵で開封できることまで通す。
 * 守りたいのは: 応答に口座番号が出ない（末尾 4 桁だけ）、409 `EXPENSE_PAYOUT_BLOCKED` の本文に直す場所（problems / warnings）、
 * ファイルは base64 で届き SHA-256 が再ダウンロードと一致、作成・再ダウンロードは approve、確定・取消の遷移。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { claimFixture } from '../adapters/storage/expense-repository.fixtures';
import { authenticated, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
/** 遠い未来の平日（振込日が過去・土日にならないように）。 */
const TRANSFER_DATE = '2099-01-05';
const approval = { by: 'shonin@example.com', at: '2026-09-15T00:00:00.000Z' };

describe('expense payout routes', () => {
  let app: App;
  let server: FastifyInstance;
  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    await app.expenseSaveEmployee.create(SCOPE, {
      id: 'emp-taro', code: 'E001', name: 'テスト太郎',
      bankAccount: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: '1', holderKana: 'テスト タロウ' },
    }, 'keiri@example.com');
    await app.expenseClaimRepo.save(claimFixture('c-taro', { tenant: SCOPE, claimant: { name: 'テスト太郎', employeeId: 'emp-taro' }, status: 'approved', approval }), new Map());
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('異常: 振込元が未設定なら事前点検に止める理由が出て、作成は 409 EXPENSE_PAYOUT_BLOCKED（ファイルを作らない）', async () => {
    const preview = await inject('POST', '/expense/payouts/preview', { scope: SCOPE, transferDate: TRANSFER_DATE });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().result.problems).toEqual([expect.objectContaining({ code: 'payout-source-missing', fixTarget: 'payout-settings' })]);
    const created = await inject('POST', '/expense/payouts', { scope: SCOPE, transferDate: TRANSFER_DATE, acknowledgedWarnings: [] });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatchObject({ code: 'EXPENSE_PAYOUT_BLOCKED', problems: [expect.objectContaining({ code: 'payout-source-missing' })] });
    expect((await inject('GET', `/expense/payouts?${scopeQuery}`)).json().batches).toEqual([]);
  });

  it('正常: 振込元の設定 → 事前点検 → 警告を確認して作成 → 一覧 → 再ダウンロード（同じ SHA-256）→ 確定で申請が精算済み', async () => {
    const settings = await inject('PUT', '/expense/payout-settings', { scope: SCOPE, source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: '9' }, requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ' });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().settings.source).toEqual({ bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumberLast4: '0009' });
    expect((await inject('GET', `/expense/payout-settings?${scopeQuery}`)).json()).toMatchObject({ saved: true, settings: { requesterCode: '0000000001' } });

    const preview = (await inject('POST', '/expense/payouts/preview', { scope: SCOPE, transferDate: TRANSFER_DATE })).json().result;
    expect(preview.problems).toEqual([]);
    expect(preview.lines).toEqual([expect.objectContaining({ employeeId: 'emp-taro', amount: 3200, holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank: expect.objectContaining({ accountNumberLast4: '0001' }) })]);
    // 申請の仕訳下書きを作っていないので、確認必須の警告が出る。
    const warningCodes = preview.warnings.map((warning: { code: string }) => warning.code);
    expect(warningCodes).toEqual(['payout-no-journal']);

    const unconfirmed = await inject('POST', '/expense/payouts', { scope: SCOPE, transferDate: TRANSFER_DATE, claimIds: ['c-taro'], acknowledgedWarnings: [] });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error).toMatchObject({ code: 'EXPENSE_PAYOUT_BLOCKED', problems: [], warnings: [expect.objectContaining({ code: 'payout-no-journal', fixTarget: 'settle' })] });

    const created = await inject('POST', '/expense/payouts', { scope: SCOPE, transferDate: TRANSFER_DATE, claimIds: ['c-taro'], acknowledgedWarnings: warningCodes });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toMatch(/"accountNumber"/u);
    const { batch, file } = created.json();
    expect(batch).toMatchObject({ status: 'exported', recordCount: 1, totalAmount: 3200, transferDate: TRANSFER_DATE });
    const bytes = Buffer.from(file.contentBase64, 'base64');
    expect(bytes).toHaveLength(file.byteLength);
    expect(bytes.subarray(122 + 43, 122 + 50).toString('latin1')).toBe('0000001');
    expect(bytes.subarray(96, 103).toString('latin1')).toBe('0000009');

    expect((await inject('GET', `/expense/payouts?${scopeQuery}&status=exported`)).json().batches.map((entry: { id: string }) => entry.id)).toEqual([batch.id]);
    const again = await inject('GET', `/expense/payouts/${batch.id}/file?${scopeQuery}`);
    expect(again.json().file).toEqual(file);

    const confirmed = await inject('POST', `/expense/payouts/${batch.id}/confirm`, { scope: SCOPE });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ batch: { status: 'confirmed' }, claims: [{ id: 'c-taro', status: 'settled', settlement: { exportFileName: batch.fileName } }], advances: [], warnings: [] });
    const cancel = await inject('POST', `/expense/payouts/${batch.id}/cancel`, { scope: SCOPE, note: '取消' });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error).toMatchObject({ code: 'EXPENSE_TRANSITION', nextStep: expect.stringContaining('組戻し') });
  });

  it('正常→異常: 取消は理由が必須で、取消後は再ダウンロードできない。無いバッチは 404、振込日の形の違いは 400', async () => {
    await inject('PUT', '/expense/payout-settings', { scope: SCOPE, source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: '9' }, requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ' });
    const preview = (await inject('POST', '/expense/payouts/preview', { scope: SCOPE, transferDate: TRANSFER_DATE })).json().result;
    const { batch } = (await inject('POST', '/expense/payouts', { scope: SCOPE, transferDate: TRANSFER_DATE, acknowledgedWarnings: preview.warnings.map((warning: { code: string }) => warning.code) })).json();
    expect((await inject('POST', `/expense/payouts/${batch.id}/cancel`, { scope: SCOPE })).statusCode).toBe(400);
    expect((await inject('POST', `/expense/payouts/${batch.id}/cancel`, { scope: SCOPE, note: '振込日を変える' })).json().batch).toMatchObject({ status: 'cancelled', cancel: { note: '振込日を変える' } });
    expect((await inject('GET', `/expense/payouts/${batch.id}/file?${scopeQuery}`)).json().error).toMatchObject({ code: 'EXPENSE_TRANSITION' });
    expect((await inject('POST', '/expense/payouts/batch-none/confirm', { scope: SCOPE })).json().error).toMatchObject({ code: 'EXPENSE_PAYOUT_NOT_FOUND' });
    expect((await inject('POST', '/expense/payouts/preview', { scope: SCOPE, transferDate: '2099/01/05' })).statusCode).toBe(400);
    expect((await inject('PUT', '/expense/payout-settings', { scope: SCOPE, requesterCode: '12' })).json().error).toMatchObject({ code: 'EXPENSE_DOMAIN', field: 'requesterCode' });
  });
});

describe('expense payout routes の認可', () => {
  let app: App;
  const auth = { authorization: 'Bearer token' };
  const serverFor = (roles: readonly AuthorizationRole[]): FastifyInstance => {
    const authentication: AuthenticationPort = { mode: 'token', required: true, authenticate: async () => authenticated({ subject: 'rita', ...SCOPE, roles }) };
    return buildServer(app, { authentication, authorization: new RoleMatrixAuthorization() });
  };

  beforeEach(() => { app = createApp({ profile: 'test' }); });
  afterEach(() => { app.close(); });

  it('口座番号を含む出力（作成・再ダウンロード）は approve。Editor は 403、Publisher は認可を通る。点検・一覧は Viewer でも読める', async () => {
    const viewer = serverFor(['viewer']);
    expect((await viewer.inject({ method: 'POST', url: '/expense/payouts/preview', headers: auth, payload: { scope: SCOPE, transferDate: TRANSFER_DATE } })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'GET', url: `/expense/payouts?${scopeQuery}`, headers: auth })).statusCode).toBe(200);
    expect((await viewer.inject({ method: 'PUT', url: '/expense/payout-settings', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    const editor = serverFor(['editor']);
    expect((await editor.inject({ method: 'POST', url: '/expense/payouts', headers: auth, payload: { scope: SCOPE, transferDate: TRANSFER_DATE, acknowledgedWarnings: [] } })).statusCode).toBe(403);
    expect((await editor.inject({ method: 'GET', url: `/expense/payouts/none/file?${scopeQuery}`, headers: auth })).statusCode).toBe(403);
    expect((await editor.inject({ method: 'POST', url: '/expense/payouts/none/confirm', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(404);
    const publisher = serverFor(['publisher']);
    expect((await publisher.inject({ method: 'GET', url: `/expense/payouts/none/file?${scopeQuery}`, headers: auth })).statusCode).toBe(404);
  });
});

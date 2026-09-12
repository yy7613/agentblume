/**
 * 本文の解析・サイズに関する Fastify 自身のエラーが、カスタム errorHandler を通っても
 * 4xx のまま利用者へ返ること、500 だけがログに記録されることを HTTP 経由で検証する。
 *
 * 以前はこれらが全部 500 'internal error' に化けていた（不正な JSON を送っても原因が分からない）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { BODY_LIMIT_BYTES, buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

describe('本文エラーの HTTP 写像', () => {
  let app: App;
  let server: FastifyInstance;
  beforeEach(() => { app = createApp({ profile: 'test' }); server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) }); });
  afterEach(async () => { await server.close(); app.close(); });

  it('不正な JSON 本文は 400 FST_ERR_CTP_INVALID_JSON_BODY（500 に化けない）', async () => {
    const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', headers: { 'content-type': 'application/json' }, payload: '{"scope":' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'FST_ERR_CTP_INVALID_JSON_BODY' } });
  });

  it('content-type だけあって本文が空なら 400（空本文のコード）', async () => {
    const res = await server.inject({ method: 'POST', url: '/tools', headers: { 'content-type': 'application/json' }, payload: '' });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error.code)).toMatch(/^FST_ERR_CTP_/);
  });

  it('境界: 本文上限ちょうどは通り（400 の入力検証へ進む）、1 バイト超えは 413', async () => {
    // 上限ちょうどの JSON: ダミー項目で埋めて長さを合わせる（zod の検証で 400 になれば「本文は受理された」証拠）。
    const shell = '{"scope":{"tenantId":"tenant-a","workspaceId":"ws-1"},"pad":""}';
    const exact = shell.replace('"pad":""', `"pad":"${'x'.repeat(BODY_LIMIT_BYTES - shell.length)}"`);
    expect(Buffer.byteLength(exact)).toBe(BODY_LIMIT_BYTES);
    const ok = await server.inject({ method: 'POST', url: '/tools', headers: { 'content-type': 'application/json' }, payload: exact });
    expect(ok.statusCode).toBe(400);
    expect(ok.json().error.code).toBe('BAD_REQUEST');

    const over = `${exact.slice(0, -2)}x"}`;
    expect(Buffer.byteLength(over)).toBe(BODY_LIMIT_BYTES + 1);
    const tooLarge = await server.inject({ method: 'POST', url: '/tools', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(over)) }, payload: over });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
  });

  it('日本語を含む正しい UTF-8 の本文は問題なく受理される（500 の原因は壊れたバイト列だけ）', async () => {
    const created = await server.inject({ method: 'POST', url: '/tools', payload: {
      scope: SCOPE, internalId: 'jp', workingName: '作業名', displayName: '表示名', publishName: 'jp_tool', owner: '所有者', sideEffect: 'read-only',
      graph: { nodes: [{ id: 'src', type: 'json-source', config: { rows: [{ a: 1 }] } }], edges: [] },
    } });
    expect(created.statusCode).toBe(201);
    const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: { scope: SCOPE, toolId: 'jp', name: 'カタログは1行以上', arguments: {}, expectations: { rowCount: { op: 'gte', value: 1 } } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().case.name).toBe('カタログは1行以上');
  });

  it('未知の例外は 500 のまま詳細を漏らさず、ログには err と reqId が記録される', async () => {
    const logged: unknown[] = [];
    server.get('/__boom', async () => { throw new TypeError('secret detail'); });
    server.addHook('onRequest', async (request) => { request.log = { ...request.log, error: (obj: unknown) => { logged.push(obj); } } as typeof request.log; });
    const res = await server.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ method: 'GET', url: '/__boom', err: expect.objectContaining({ message: 'secret detail' }) });
  });
});

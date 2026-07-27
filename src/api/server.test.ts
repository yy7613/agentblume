/**
 * buildServer のテスト（v4 実装契約 §7）
 *
 * - /health（liveness）が 200 { status: 'ok' } + ビルド情報。
 * - /ready（readiness）が必須依存を叩き、失敗時は 503。
 * - ルート未登録パスは Fastify 標準の 404 をそのまま返す（setErrorHandler は
 *   ハンドラ内の throw のみ対象。Not Found はマッピングしない仕様とする）。
 * - ハンドラの throw は setErrorHandler（toHttpError）経由でマッピングされる。
 * - buildServer は listen しない（inject のみで完結、実ポートは開かない）。
 * - uiRoot を渡したときだけビルド済みUIを配信し、未知パスは index.html へフォールバックする。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../composition/root';
import type { App } from '../composition/root';
import { BODY_LIMIT_BYTES, CONNECTION_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, buildServer } from './server';

describe('buildServer', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('GET /health → 200 { status: "ok" } とビルド情報（依存は叩かない）', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', node: process.version });
    expect(res.json()).toEqual(expect.objectContaining({ uptimeSeconds: expect.any(Number) }));
    // revision 未指定なら載せない。
    expect(res.json()).not.toHaveProperty('revision');
  });

  it('ルート未登録パス → Fastify 標準 404（エラーマッピング対象外）', async () => {
    const res = await server.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    // Fastify 標準の Not Found ボディ（{ error: { code } } 形式ではない）。
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('ハンドラの throw は setErrorHandler 経由で §2 マッピングされる（404 TOOL_NOT_FOUND）', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/tools/no-such-tool',
      query: { tenantId: 't', workspaceId: 'w' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'TOOL_NOT_FOUND', message: expect.stringContaining('no-such-tool') },
    });
  });

  it('未知例外は 500 INTERNAL（message 固定）に落ちる', async () => {
    server.get('/boom', async () => {
      throw new Error('secret detail');
    });
    const res = await server.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  it('listen しない（inject 後も実ポートは開いていない）', async () => {
    await server.inject({ method: 'GET', url: '/health' });
    expect(server.server.listening).toBe(false);
    expect(server.addresses()).toEqual([]);
  });

  it('options.logger 省略時は logger 無効で組み立てられる', () => {
    // Fastify はロガー無効時レベル操作が no-op の抽象ロガーを持つ。
    // ここでは buildServer がオプション無しで正常にインスタンスを返すことを確認する。
    expect(server.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
    expect(server.hasRoute({ method: 'GET', url: '/ready' })).toBe(true);
    expect(server.hasRoute({ method: 'POST', url: '/tools' })).toBe(true);
  });

  it('画像2枚のBase64リクエストに十分なボディ上限を設定する', () => {
    expect(server.initialConfig.bodyLimit).toBe(BODY_LIMIT_BYTES);
    expect(server.initialConfig.bodyLimit).toBe(10 * 1024 * 1024);
  });

  it('HTTPタイムアウトを明示する（長時間ハンドラを殺さない値）', () => {
    // requestTimeout は「リクエストを受信し終えるまで」の上限で、ハンドラの実行時間は含まない。
    // Fastify の initialConfig には出ないため、実際に設定される http.Server 側を見る。
    expect(server.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.initialConfig.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    // connectionTimeout（無通信でソケットを切る）は 0 のまま。有効にすると
    // モデルの長考中に Harness / Agent 実行が切断される。
    expect(server.initialConfig.connectionTimeout).toBe(CONNECTION_TIMEOUT_MS);
    expect(server.server.timeout).toBe(0);
    expect(CONNECTION_TIMEOUT_MS).toBe(0);
  });
});

describe('buildServer readiness', () => {
  let app: App;
  const servers: FastifyInstance[] = [];

  const build = (options: Parameters<typeof buildServer>[1]): FastifyInstance => {
    const instance = buildServer(app, options);
    servers.push(instance);
    return instance;
  };

  beforeEach(() => {
    app = createApp({ profile: 'test' });
  });

  afterEach(async () => {
    for (const instance of servers.splice(0)) await instance.close();
    app.close();
  });

  it('GET /ready → 全チェック成功で 200', async () => {
    const server = build({ readiness: [{ name: 'database', probe: async () => { await app.repo.list({ tenantId: 't', workspaceId: 'w' }); } }] });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: [{ name: 'database', status: 'ok' }] });
  });

  it('GET /ready → 依存が落ちていれば 503 と理由', async () => {
    const server = build({
      revision: 'abc1234',
      readiness: [{ name: 'database', probe: async () => { throw new Error('database is locked'); } }],
    });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'unready',
      revision: 'abc1234',
      checks: [{ name: 'database', status: 'error', error: 'database is locked' }],
    });
  });

  it('Error でない throw と長すぎるメッセージも安全に要約する', async () => {
    const server = build({ readiness: [{ name: 'weird', probe: async () => { throw 'x'.repeat(500); } }] });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const check = (res.json() as { checks: { error: string }[] }).checks[0];
    expect(check?.error).toHaveLength(201);
    expect(check?.error.endsWith('…')).toBe(true);
  });

  it('readiness 未指定なら依存チェック無しで ready を返す', async () => {
    const server = build({ revision: 'rev-9' });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', revision: 'rev-9', checks: [] });
    expect((await server.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ revision: 'rev-9' });
  });
});

describe('buildServer static UI', () => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'agentblume-ui-'));
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    mkdirSync(join(uiRoot, 'assets'), { recursive: true });
    writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>agentblume</title>');
    writeFileSync(join(uiRoot, 'assets', 'app-1234.js'), 'export const answer = 42;');
    app = createApp({ profile: 'test' });
    server = buildServer(app, { uiRoot });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  afterAll(() => {
    rmSync(uiRoot, { recursive: true, force: true });
  });

  it('/ でビルド済み index.html を返す', async () => {
    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('agentblume');
  });

  it('ハッシュ名つきのアセットをそのまま配信する', async () => {
    const res = await server.inject({ method: 'GET', url: '/assets/app-1234.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('answer = 42');
  });

  it('未知のパスは SPA として index.html へフォールバックする', async () => {
    const res = await server.inject({ method: 'GET', url: '/anything/deep' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('agentblume');
  });

  it('APIの接頭辞配下はフォールバックせず JSON 404 を返す', async () => {
    // index.html を返すと UI 側は「JSONでない応答」で失敗し、原因が分からなくなる。
    const res = await server.inject({ method: 'GET', url: '/health/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('GET/HEAD 以外と、拡張子つきの見つからないファイルは JSON 404 を返す', async () => {
    const post = await server.inject({ method: 'POST', url: '/anything/deep' });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });

    // 存在しない JS を index.html で返すと、ブラウザが HTML を JS として実行しようとして壊れる。
    const missingAsset = await server.inject({ method: 'GET', url: '/assets/gone-9999.js' });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('APIルートは静的配信を有効にしても従来どおり動く', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

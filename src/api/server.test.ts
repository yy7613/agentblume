/**
 * buildServer のテスト（v4 実装契約 §7）
 *
 * - /health が 200 { status: 'ok' }。
 * - ルート未登録パスは Fastify 標準の 404 をそのまま返す（setErrorHandler は
 *   ハンドラ内の throw のみ対象。Not Found はマッピングしない仕様とする）。
 * - ハンドラの throw は setErrorHandler（toHttpError）経由でマッピングされる。
 * - buildServer は listen しない（inject のみで完結、実ポートは開かない）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../composition/root';
import type { App } from '../composition/root';
import { buildServer } from './server';

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

  it('GET /health → 200 { status: "ok" }', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
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
    expect(server.hasRoute({ method: 'POST', url: '/tools' })).toBe(true);
  });
});

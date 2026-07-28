/**
 * 認証フックのテスト（HTTP境界での振る舞い）。
 *
 * ここで守りたいのは3つ。
 * 1. 未認証のAPIリクエストは 401 で止まる（ボディを読む前に）。
 * 2. `/health` `/ready` とUIシェルは認証なしで届く（監視とログイン画面が死なない）。
 * 3. **なりすまし不能**: 自分のトークンで別テナントを名乗っても、見えるのは自分のデータだけ。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { TokenAuthentication } from '../adapters/security/token-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';
import { isPublicRequest, pathOf, PUBLIC_PATHS } from './authentication';

const ALICE_TOKEN = 'a'.repeat(40);
const BOB_TOKEN = 'b'.repeat(40);
const ALICE_SCOPE = { tenantId: 'acme', workspaceId: 'ops' };
const BOB_SCOPE = { tenantId: 'globex', workspaceId: 'main' };

function tokenAuth() {
  return new TokenAuthentication([
    { subject: 'alice', token: ALICE_TOKEN, ...ALICE_SCOPE, displayName: 'Alice' },
    { subject: 'bob', token: BOB_TOKEN, ...BOB_SCOPE },
  ]);
}

function toolBody(scope: Record<string, string>, internalId: string) {
  return {
    scope,
    internalId,
    workingName: `${internalId}-working`,
    displayName: internalId,
    publishName: internalId,
    owner: 'test@example.com',
    sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'src', type: 'json-source', config: { rows: [{ id: 1 }] } },
        { id: 'sel', type: 'select', config: { columns: ['id'] } },
      ],
      edges: [{ from: 'src', to: 'sel' }],
    },
  };
}

describe('認証フック（トークン方式）', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: tokenAuth() });
  });

  afterEach(async () => { await server.close(); app.close(); });

  it('資格情報なしのAPIリクエストは 401 と WWW-Authenticate を返す', async () => {
    const res = await server.inject({ method: 'GET', url: '/tools', query: ALICE_SCOPE });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="agentblume"');
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('無効なトークンも 401（理由の文言だけが変わる）', async () => {
    const res = await server.inject({ method: 'GET', url: '/tools', headers: { authorization: 'Bearer wrong-token' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain('rejected');
  });

  it('有効なトークンなら通る', async () => {
    const res = await server.inject({ method: 'GET', url: '/tools', headers: { authorization: `Bearer ${ALICE_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tools: [] });
  });

  it('書き込み系も未認証では届かない（ボディを読む前に落とす）', async () => {
    const res = await server.inject({ method: 'POST', url: '/tools', payload: toolBody(ALICE_SCOPE, 'x') });
    expect(res.statusCode).toBe(401);
    // 401 で止めたのだから、副作用は起きていない。
    const listed = await server.inject({ method: 'GET', url: '/tools', headers: { authorization: `Bearer ${ALICE_TOKEN}` } });
    expect(listed.json().tools).toEqual([]);
  });

  it('/health と /ready は認証不要', async () => {
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('GET /auth/session は認証必須で、通れば Principal と方式を返す', async () => {
    expect((await server.inject({ method: 'GET', url: '/auth/session' })).statusCode).toBe(401);

    const res = await server.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${ALICE_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      session: {
        mode: 'token',
        authenticationRequired: true,
        principal: { subject: 'alice', tenantId: 'acme', workspaceId: 'ops', displayName: 'Alice', roles: ['operator'] },
      },
    });
  });

  describe('なりすまし防止', () => {
    it('別テナントを名乗って保存しても、自分のテナントにしか書けない', async () => {
      // alice のトークンで bob のスコープを申告する。
      const saved = await server.inject({
        method: 'POST', url: '/tools',
        headers: { authorization: `Bearer ${ALICE_TOKEN}` },
        payload: toolBody(BOB_SCOPE, 'stolen'),
      });
      expect(saved.statusCode).toBe(201);
      // 保存されたのは alice のテナント。
      expect(saved.json().tool.metadata.tenant).toEqual(ALICE_SCOPE);

      // bob からは見えない。
      const bobView = await server.inject({
        method: 'GET', url: '/tools',
        headers: { authorization: `Bearer ${BOB_TOKEN}` },
        query: BOB_SCOPE,
      });
      expect(bobView.json().tools).toEqual([]);
    });

    it('別テナントを名乗って読んでも、返るのは自分のデータだけ', async () => {
      await server.inject({
        method: 'POST', url: '/tools',
        headers: { authorization: `Bearer ${BOB_TOKEN}` },
        payload: toolBody(BOB_SCOPE, 'bob-secret'),
      });

      const stolen = await server.inject({
        method: 'GET', url: '/tools/bob-secret',
        headers: { authorization: `Bearer ${ALICE_TOKEN}` },
        query: BOB_SCOPE,
      });
      expect(stolen.statusCode).toBe(404);
      expect(stolen.json().error.code).toBe('TOOL_NOT_FOUND');
    });

    it('別テナントを名乗った削除は相手のデータへ届かない', async () => {
      await server.inject({
        method: 'POST', url: '/tools',
        headers: { authorization: `Bearer ${BOB_TOKEN}` },
        payload: toolBody(BOB_SCOPE, 'bob-secret'),
      });

      const deleted = await server.inject({
        method: 'DELETE', url: '/tools/bob-secret',
        headers: { authorization: `Bearer ${ALICE_TOKEN}` },
        query: BOB_SCOPE,
      });
      expect(deleted.statusCode).toBe(404);

      const stillThere = await server.inject({
        method: 'GET', url: '/tools/bob-secret',
        headers: { authorization: `Bearer ${BOB_TOKEN}` },
      });
      expect(stillThere.statusCode).toBe(200);
    });
  });
});

describe('認証フック（単一ユーザーモード）', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication() });
  });

  afterEach(async () => { await server.close(); app.close(); });

  it('資格情報なしでも全ルートが通る（従来どおりの体験）', async () => {
    expect((await server.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/agents' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('/auth/session が単一ユーザーモードであることを伝える', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/session' });
    expect(res.json().session).toMatchObject({
      mode: 'single-user',
      authenticationRequired: false,
      principal: { subject: 'single-user', tenantId: 'local', workspaceId: 'default' },
    });
  });

  it('buildServer に authentication を渡さない場合も単一ユーザーモードで動く', async () => {
    const fallback = buildServer(app);
    expect((await fallback.inject({ method: 'GET', url: '/auth/session' })).json().session.mode).toBe('single-user');
    await fallback.close();
  });
});

/**
 * ここが閉じていると**トークンを入力する画面自体が開けない**（＝復旧不能な締め出し）。
 * `isPublicRequest` の単体テストと別に、静的配信を有効にした実インスタンスでも確かめる。
 */
describe('認証が必要な構成でもUIシェルは配信する', () => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'agentblume-auth-ui-'));
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    mkdirSync(join(uiRoot, 'assets'), { recursive: true });
    writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>agentblume</title>');
    writeFileSync(join(uiRoot, 'assets', 'app-1234.js'), 'export const answer = 42;');
    app = createApp({ profile: 'test' });
    server = buildServer(app, { uiRoot, authentication: tokenAuth() });
    await server.ready();
  });

  afterEach(async () => { await server.close(); app.close(); });
  afterAll(() => { rmSync(uiRoot, { recursive: true, force: true }); });

  it('資格情報なしで index.html とアセットとSPAフォールバックを返す', async () => {
    expect((await server.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/assets/app-1234.js' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(200);
  });

  it('UIを配信していてもAPIは資格情報を要求する', async () => {
    expect((await server.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    // API接頭辞の下の綴り間違いも素通しにしない（401が先に立つ）。
    expect((await server.inject({ method: 'GET', url: '/tools/typo/nope' })).statusCode).toBe(401);
  });
});

describe('公開パスの判定', () => {
  const apiPrefixes = new Set(['/tools', '/health', '/ready', '/auth']);

  it('/health /ready は常に公開', () => {
    expect(PUBLIC_PATHS).toEqual(new Set(['/health', '/ready']));
    expect(isPublicRequest({ method: 'GET', url: '/health' }, apiPrefixes)).toBe(true);
    expect(isPublicRequest({ method: 'GET', url: '/ready?x=1' }, apiPrefixes)).toBe(true);
  });

  it('APIが所有しない GET はUIシェルとして公開（トークン入力画面を開けなくしない）', () => {
    expect(isPublicRequest({ method: 'GET', url: '/' }, apiPrefixes)).toBe(true);
    expect(isPublicRequest({ method: 'GET', url: '/assets/app-1234.js' }, apiPrefixes)).toBe(true);
    expect(isPublicRequest({ method: 'HEAD', url: '/settings' }, apiPrefixes)).toBe(true);
  });

  it('API接頭辞の下は綴り間違いでも認証する', () => {
    expect(isPublicRequest({ method: 'GET', url: '/tools' }, apiPrefixes)).toBe(false);
    expect(isPublicRequest({ method: 'GET', url: '/tools/typo/nope' }, apiPrefixes)).toBe(false);
    expect(isPublicRequest({ method: 'GET', url: '/auth/session' }, apiPrefixes)).toBe(false);
  });

  it('GET / HEAD 以外は常に認証する（未知のパスでも副作用を通さない）', () => {
    expect(isPublicRequest({ method: 'POST', url: '/anything' }, apiPrefixes)).toBe(false);
    expect(isPublicRequest({ method: 'DELETE', url: '/' }, apiPrefixes)).toBe(false);
  });

  it('pathOf はクエリを落とす', () => {
    expect(pathOf('/health?verbose=1')).toBe('/health');
    expect(pathOf('/health')).toBe('/health');
  });
});

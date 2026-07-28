import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { bucketOf, MAX_RATE_LIMIT_KEYS, RateLimiter, type RateLimitOptions } from './rate-limit';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('bucketOf', () => {
  it.each([
    ['POST', '/web-searches', 'search'],
    ['POST', '/web-searches?x=1', 'search'],
    ['POST', '/mcp-servers/filesystem/test', 'mcp-test'],
    ['POST', '/mcp-servers/fs/test?scope=x', 'mcp-test'],
    ['GET', '/web-searches', 'default'],
    ['POST', '/mcp-servers', 'default'],
    ['GET', '/tools', 'default'],
  ])('%s %s → %s', (method, url, expected) => { expect(bucketOf(method, url)).toBe(expected); });
});

describe('RateLimiter', () => {
  it('上限までは通し、超えたら拒否する', () => {
    const limiter = new RateLimiter({ default: { max: 2, windowMs: 1_000 }, now: () => 0 });
    expect(limiter.hit('alice', 'default').allowed).toBe(true);
    expect(limiter.hit('alice', 'default')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit('alice', 'default')).toMatchObject({ allowed: false, remaining: 0, limit: 2 });
  });

  it('ウィンドウが明けたら回復する', () => {
    let clock = 0;
    const limiter = new RateLimiter({ default: { max: 1, windowMs: 1_000 }, now: () => clock });
    expect(limiter.hit('alice', 'default').allowed).toBe(true);
    expect(limiter.hit('alice', 'default').allowed).toBe(false);
    clock += 1_001;
    expect(limiter.hit('alice', 'default').allowed).toBe(true);
  });

  it('鍵ごと・バケットごとに枠を分ける', () => {
    const limiter = new RateLimiter({ default: { max: 1, windowMs: 1_000 }, search: { max: 1, windowMs: 1_000 }, now: () => 0 });
    expect(limiter.hit('alice', 'default').allowed).toBe(true);
    expect(limiter.hit('alice', 'default').allowed).toBe(false);
    // 別バケットは食い合わない（重い経路が軽い経路の予算を消さない）。
    expect(limiter.hit('alice', 'search').allowed).toBe(true);
    // 別の主体も独立。
    expect(limiter.hit('bob', 'default').allowed).toBe(true);
  });

  it('期限切れのカウンタを掃除する（上限なしに増えない）', () => {
    let clock = 0;
    const limiter = new RateLimiter({ default: { max: 5, windowMs: 1_000 }, now: () => clock });
    for (let i = 0; i < 50; i += 1) limiter.hit(`user-${i}`, 'default');
    expect(limiter.size).toBe(50);
    clock += 2_000;
    limiter.hit('trigger', 'default');
    expect(limiter.size).toBe(1);
  });

  it('鍵数が上限に達したら古いものから捨てる', () => {
    const limiter = new RateLimiter({ default: { max: 5, windowMs: 60_000 }, now: () => 0 });
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS + 20; i += 1) limiter.hit(`user-${i}`, 'default');
    expect(limiter.size).toBeLessThanOrEqual(MAX_RATE_LIMIT_KEYS);
  });

  it('resetSeconds は残り時間を切り上げる', () => {
    let clock = 0;
    const limiter = new RateLimiter({ default: { max: 10, windowMs: 60_000 }, now: () => clock });
    limiter.hit('alice', 'default');
    clock += 30_500;
    expect(limiter.hit('alice', 'default').resetSeconds).toBe(30);
  });
});

describe('レート制限の配線', () => {
  let app: App; let server: FastifyInstance;
  afterEach(async () => { await server.close(); app.close(); });

  function build(rateLimit?: RateLimitOptions | false) {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope), ...(rateLimit === undefined ? {} : { rateLimit }) });
    return server;
  }

  it('上限を超えると429を返し、Retry-After を添える', async () => {
    build({ default: { max: 2, windowMs: 60_000 } });
    expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
    const blocked = await server.inject({ method: 'GET', url: '/tools', query: scope });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit-limit']).toBe('2');
  });

  it('通常利用（既定の上限）は素通りする', async () => {
    build();
    for (let i = 0; i < 30; i += 1) {
      expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
    }
  });

  it('課金APIは別枠かつ厳しい上限で守られる', async () => {
    build({ default: { max: 1_000, windowMs: 60_000 }, search: { max: 1, windowMs: 60_000 } });
    // 1回目は provider 未設定で失敗するが、レート制限の観点では「数えられた」ことが重要。
    const first = await server.inject({ method: 'POST', url: '/web-searches', payload: { scope, provider: 'tavily', query: 'x' } });
    expect(first.statusCode).not.toBe(429);
    expect((await server.inject({ method: 'POST', url: '/web-searches', payload: { scope, provider: 'tavily', query: 'x' } })).statusCode).toBe(429);
    // 別バケットの通常APIは影響を受けない。
    expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
  });

  it('/health /ready は数えない（監視が429で落ちない）', async () => {
    build({ default: { max: 1, windowMs: 60_000 } });
    for (let i = 0; i < 5; i += 1) {
      expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    }
    // 通常APIのほうはちゃんと効いている。
    expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(429);
  });

  it('false を渡すと無効化できる（埋め込み用の逃げ道）', async () => {
    build(false);
    for (let i = 0; i < 20; i += 1) {
      expect((await server.inject({ method: 'GET', url: '/tools', query: scope })).statusCode).toBe(200);
    }
  });
});

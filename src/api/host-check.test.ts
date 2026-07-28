import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { hostNameOf, isAllowedHost, LOOPBACK_HOST_NAMES, registerHostCheck } from './host-check';

describe('hostNameOf', () => {
  it.each([
    ['localhost:3030', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1:3030', '127.0.0.1'],
    ['[::1]:3030', '[::1]'],
    ['[::1]', '[::1]'],
    ['evil.example', 'evil.example'],
    ['  localhost:80 ', 'localhost'],
  ])('%s → %s', (header, expected) => { expect(hostNameOf(header)).toBe(expected); });
});

describe('isAllowedHost', () => {
  it.each(['localhost', 'localhost:3030', '127.0.0.1:3030', '[::1]:3030'])('ループバック %s は許可', (header) => {
    expect(isAllowedHost(header, LOOPBACK_HOST_NAMES)).toBe(true);
  });

  it.each(['evil.example', 'evil.example:3030', '192.168.1.5:3030', 'localhost.evil.example'])('%s は拒否', (header) => {
    expect(isAllowedHost(header, LOOPBACK_HOST_NAMES)).toBe(false);
  });

  it('Host 欠落は拒否する', () => {
    expect(isAllowedHost(undefined, LOOPBACK_HOST_NAMES)).toBe(false);
    expect(isAllowedHost('  ', LOOPBACK_HOST_NAMES)).toBe(false);
  });
});

describe('registerHostCheck', () => {
  async function build() {
    const app = Fastify();
    registerHostCheck(app, { allowedHosts: LOOPBACK_HOST_NAMES });
    app.get('/tools', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('ループバックのHostは通る', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/tools', headers: { host: 'localhost:3030' } })).statusCode).toBe(200);
    await app.close();
  });

  it('別ドメインを名乗るリクエストは403で、副作用の前に切る', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/tools', headers: { host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN_HOST');
    // 受け取った Host を応答へ反射しない。
    expect(response.body).not.toContain('evil.example');
    await app.close();
  });
});

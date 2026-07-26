import { describe, expect, it } from 'vitest';
import { McpValidationError } from './errors';
import { createMcpServerConfig, type McpTransportConfig } from './mcp-server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const updatedAt = '2026-07-26T00:00:00.000Z';
const stdio: McpTransportConfig = { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' } };

function create(overrides: Record<string, unknown> = {}) {
  return createMcpServerConfig({ scope, name: 'filesystem', transport: stdio, updatedAt, ...overrides });
}

describe('createMcpServerConfig', () => {
  it('検証済みの設定を返し、入力配列/レコードを複製して呼び出し側の変更から隔離する', () => {
    const args = ['-y', 'server'];
    const env = { TOKEN: 'secret' };
    const config = create({ transport: { kind: 'stdio', command: ' npx ', args, env } });
    expect(config).toMatchObject({ name: 'filesystem', disabled: false, updatedAt });
    expect(config.transport).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' } });
    args.push('mutated'); env['TOKEN'] = 'mutated';
    expect(config.transport).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' } });
  });

  it('args/env 省略時は空、cwd と disabled は指定時のみ反映する', () => {
    const config = create({ transport: { kind: 'stdio', command: 'node', args: [], env: {}, cwd: '/work' }, disabled: true });
    expect(config.transport).toEqual({ kind: 'stdio', command: 'node', args: [], env: {}, cwd: '/work' });
    expect(config.disabled).toBe(true);
  });

  it('http transport は http(s) のURLだけを受け付ける', () => {
    expect(create({ transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } }).transport)
      .toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    expect(() => create({ transport: { kind: 'http', url: 'ftp://example.com', headers: {} } })).toThrow(McpValidationError);
    expect(() => create({ transport: { kind: 'http', url: 'not a url', headers: {} } })).toThrow(/must be a valid URL/);
  });

  it.each([
    ['名前が空', { name: '  ' }],
    ['名前が記号始まり', { name: '_leading' }],
    ['名前に空白', { name: 'my server' }],
    ['名前に不正文字', { name: 'server/child' }],
    ['名前が65文字', { name: 'a'.repeat(65) }],
    ['scope欠落', { scope: { tenantId: '', workspaceId: 'w' } }],
    ['updatedAt空', { updatedAt: '' }],
    ['transport.kind不正', { transport: { kind: 'sse' } }],
    ['stdio command空', { transport: { kind: 'stdio', command: '', args: [], env: {} } }],
    ['stdio env値が非文字列', { transport: { kind: 'stdio', command: 'node', args: [], env: { KEY: 1 } } }],
    ['stdio env キーが空', { transport: { kind: 'stdio', command: 'node', args: [], env: { '': 'v' } } }],
    ['stdio args が非配列', { transport: { kind: 'stdio', command: 'node', args: 'x', env: {} } }],
    ['stdio args 要素が非文字列', { transport: { kind: 'stdio', command: 'node', args: [1], env: {} } }],
    ['http headers キーが空', { transport: { kind: 'http', url: 'https://e.com', headers: { '': 'v' } } }],
    ['disabled が非boolean', { disabled: 'yes' }],
  ])('%s は McpValidationError', (_label, overrides) => {
    expect(() => create(overrides)).toThrow(McpValidationError);
  });

  it('名前は英数字始まりで _ . - を含められる（64文字まで）', () => {
    for (const name of ['a', 'A1', 'my.server_v1-2', '0start', 'a'.repeat(64)]) {
      expect(create({ name }).name).toBe(name);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { McpValidationError } from './errors';
import { parseMcpServersDocument, toMcpServersDocument } from './mcp-servers-document';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const now = () => new Date('2026-07-26T00:00:00.000Z');

/** Claude Desktop 等が実際に配布している形の設定。 */
const document = {
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'], env: { LOG: 'debug' }, cwd: '/work' },
    minimal: { command: 'node' },
    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
    paused: { url: 'https://example.com/off', disabled: true },
  },
};

describe('parseMcpServersDocument', () => {
  it('標準ドキュメントを name 昇順の設定列へ変換する', () => {
    const configs = parseMcpServersDocument(scope, document, now);
    expect(configs.map((config) => config.name)).toEqual(['filesystem', 'minimal', 'paused', 'remote']);
    expect(configs[0]).toEqual({
      scope, name: 'filesystem', disabled: false, updatedAt: '2026-07-26T00:00:00.000Z',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'], env: { LOG: 'debug' }, cwd: '/work' },
    });
    // 省略キーは既定値へ落ちる。
    expect(configs[1]?.transport).toEqual({ kind: 'stdio', command: 'node', args: [], env: {} });
    expect(configs[2]?.disabled).toBe(true);
    expect(configs[3]?.transport).toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } });
  });

  it('command と url の両方を持つエントリは曖昧なので拒否する', () => {
    expect(() => parseMcpServersDocument(scope, { mcpServers: { both: { command: 'node', url: 'https://e.com' } } }, now))
      .toThrow(/must not define both command and url/);
  });

  it('command も url も無いエントリは transport を決められないので拒否する', () => {
    expect(() => parseMcpServersDocument(scope, { mcpServers: { neither: { args: ['x'] } } }, now))
      .toThrow(/must define either command or url/);
  });

  it.each([
    ['mcpServers 欠落', {}],
    ['mcpServers が配列', { mcpServers: [] }],
    ['args が文字列配列でない', { mcpServers: { a: { command: 'node', args: [1] } } }],
    ['env の値が文字列でない', { mcpServers: { a: { command: 'node', env: { K: 1 } } } }],
    ['disabled が boolean でない', { mcpServers: { a: { command: 'node', disabled: 'yes' } } }],
    ['null', null],
  ])('%s は McpValidationError', (_label, doc) => {
    expect(() => parseMcpServersDocument(scope, doc, now)).toThrow(McpValidationError);
  });

  it('名前が識別子として不正なキーは createMcpServerConfig の検証で弾かれる', () => {
    expect(() => parseMcpServersDocument(scope, { mcpServers: { 'bad name': { command: 'node' } } }, now)).toThrow(McpValidationError);
  });
});

describe('toMcpServersDocument', () => {
  it('既定値（空args/env/headers・cwd未設定・disabled:false）のキーを省略する', () => {
    const configs = parseMcpServersDocument(scope, { mcpServers: { minimal: { command: 'node', args: [], env: {}, disabled: false }, bare: { url: 'https://e.com/mcp', headers: {} } } }, now);
    expect(toMcpServersDocument(configs)).toEqual({ mcpServers: { bare: { url: 'https://e.com/mcp' }, minimal: { command: 'node' } } });
  });

  it('parse → to → parse がロスレス（設定列が完全に一致する）', () => {
    const first = parseMcpServersDocument(scope, document, now);
    const rebuilt = toMcpServersDocument(first);
    const second = parseMcpServersDocument(scope, rebuilt, now);
    expect(second).toEqual(first);
    // ドキュメント自体も安定する（to → parse → to で不動点）。
    expect(toMcpServersDocument(second)).toEqual(rebuilt);
  });

  it('元ドキュメントの明示的な既定値だけが省略され、意味は保たれる', () => {
    const configs = parseMcpServersDocument(scope, document, now);
    const rebuilt = toMcpServersDocument(configs);
    expect(rebuilt.mcpServers['filesystem']).toEqual(document.mcpServers.filesystem);
    expect(rebuilt.mcpServers['minimal']).toEqual({ command: 'node' });
    expect(rebuilt.mcpServers['paused']).toEqual({ url: 'https://example.com/off', disabled: true });
  });
});

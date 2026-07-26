import { describe, expect, it } from 'vitest';
import { McpValidationError } from './errors';
import { createMcpServerConfig } from './mcp-server';
import { deserializeMcpServerConfig, serializeMcpServerConfig } from './serialization';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const updatedAt = '2026-07-26T00:00:00.000Z';

describe('MCPサーバー設定の直列化', () => {
  it.each([
    ['stdio', { kind: 'stdio' as const, command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' }, cwd: '/work' }],
    ['stdio（最小）', { kind: 'stdio' as const, command: 'node', args: [], env: {} }],
    ['http', { kind: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }],
  ])('%s を往復できる', (_label, transport) => {
    const config = createMcpServerConfig({ scope, name: 'server', transport, disabled: true, updatedAt });
    const serialized = serializeMcpServerConfig(config);
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
    expect(deserializeMcpServerConfig(serialized)).toEqual(config);
  });

  it('不正なSerializedはMcpValidationError', () => {
    expect(() => deserializeMcpServerConfig({ scope, name: 'server', transport: { kind: 'sse' }, disabled: false, updatedAt })).toThrow(McpValidationError);
    expect(() => deserializeMcpServerConfig({ name: 'server' })).toThrow(/invalid SerializedMcpServerConfig/);
    expect(() => deserializeMcpServerConfig(null)).toThrow(McpValidationError);
  });

  it('保存済みデータにも生成時と同じ不変条件を課す（不正nameは復元時に弾く）', () => {
    expect(() => deserializeMcpServerConfig({ scope, name: 'bad name', transport: { kind: 'stdio', command: 'node', args: [], env: {} }, disabled: false, updatedAt }))
      .toThrow(McpValidationError);
  });
});

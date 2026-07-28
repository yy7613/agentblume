import { describe, expect, it } from 'vitest';
import { McpValidationError } from './errors';
import { createMcpServerConfig, type McpTransportConfig } from './mcp-server';
import { MCP_SECRET_MASK, isMaskedSecret, maskMcpServerConfig, maskRecord, resolveMaskedRecord, resolveMaskedTransport } from './secret-masking';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
function config(transport: McpTransportConfig) {
  return createMcpServerConfig({ scope, name: 'server', transport, updatedAt: '2026-07-28T00:00:00.000Z' });
}

describe('maskMcpServerConfig', () => {
  it('stdio の env は値だけを伏せ、キー・コマンド・引数・cwd は残す', () => {
    const view = maskMcpServerConfig(config({ kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { GITHUB_TOKEN: 'ghp_realsecret', LOG: 'debug' }, cwd: '/work' }));
    expect(view.transport).toEqual({
      kind: 'stdio', command: 'npx', args: ['-y', 'server'],
      env: { GITHUB_TOKEN: MCP_SECRET_MASK, LOG: MCP_SECRET_MASK }, cwd: '/work',
    });
    expect(JSON.stringify(view)).not.toContain('ghp_realsecret');
  });

  it('http の headers は値だけを伏せ、URLは残す', () => {
    const view = maskMcpServerConfig(config({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer supersecret' } }));
    expect(view.transport).toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: MCP_SECRET_MASK } });
    expect(JSON.stringify(view)).not.toContain('supersecret');
  });

  it('空の env / headers はそのまま空', () => {
    expect(maskMcpServerConfig(config({ kind: 'stdio', command: 'node', args: [], env: {} })).transport).toEqual({ kind: 'stdio', command: 'node', args: [], env: {} });
  });

  it('空文字の値も伏せる（値の長さを漏らさない）', () => {
    expect(maskRecord({ A: '', B: 'x' })).toEqual({ A: MCP_SECRET_MASK, B: MCP_SECRET_MASK });
  });
});

describe('resolveMaskedRecord', () => {
  it('マスク値は保存済みの値へ戻る', () => {
    expect(resolveMaskedRecord({ TOKEN: MCP_SECRET_MASK }, { TOKEN: 'real' }, 'transport.env')).toEqual({ TOKEN: 'real' });
  });

  it('実値が来たら差し替える', () => {
    expect(resolveMaskedRecord({ TOKEN: 'new' }, { TOKEN: 'old' }, 'transport.env')).toEqual({ TOKEN: 'new' });
  });

  it('ドキュメントから消したキーは復活しない', () => {
    expect(resolveMaskedRecord({ A: MCP_SECRET_MASK }, { A: 'a', B: 'b' }, 'transport.env')).toEqual({ A: 'a' });
  });

  it('引き継ぎ元の無いマスク値は拒否する（リテラル *** を保存しない）', () => {
    expect(() => resolveMaskedRecord({ TOKEN: MCP_SECRET_MASK }, undefined, 'transport.env')).toThrow(McpValidationError);
    expect(() => resolveMaskedRecord({ NEW: MCP_SECRET_MASK }, { OLD: 'x' }, 'transport.env')).toThrow(/no stored value to keep/);
  });

  it('エラーメッセージに保存済みの値を載せない', () => {
    const error = (() => { try { resolveMaskedRecord({ NEW: MCP_SECRET_MASK }, { OLD: 'topsecret' }, 'transport.env'); return ''; } catch (cause) { return (cause as Error).message; } })();
    expect(error).not.toContain('topsecret');
  });

  it('isMaskedSecret は完全一致だけを印とみなす', () => {
    expect(isMaskedSecret(MCP_SECRET_MASK)).toBe(true);
    expect(isMaskedSecret('***x')).toBe(false);
    expect(isMaskedSecret('')).toBe(false);
  });
});

describe('resolveMaskedTransport', () => {
  const storedStdio: McpTransportConfig = { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'real' } };
  const storedHttp: McpTransportConfig = { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer real' } };

  it('無編集の往復では保存済みの値が完全に保たれる', () => {
    const masked = maskMcpServerConfig(config(storedStdio)).transport;
    expect(resolveMaskedTransport(masked as McpTransportConfig, storedStdio)).toEqual(storedStdio);
  });

  it('http も無編集の往復で値が保たれる', () => {
    const masked = maskMcpServerConfig(config(storedHttp)).transport;
    expect(resolveMaskedTransport(masked as McpTransportConfig, storedHttp)).toEqual(storedHttp);
  });

  it('transport の種類が変わるとマスクは引き継げない', () => {
    expect(() => resolveMaskedTransport({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: MCP_SECRET_MASK } }, storedStdio)).toThrow(McpValidationError);
  });

  it('保存済みが無い新規サーバーのマスクは拒否される', () => {
    expect(() => resolveMaskedTransport({ kind: 'stdio', command: 'npx', args: [], env: { TOKEN: MCP_SECRET_MASK } }, undefined)).toThrow(McpValidationError);
  });

  it('秘密以外の項目（command / url / args）はそのまま通る', () => {
    expect(resolveMaskedTransport({ kind: 'stdio', command: 'node', args: ['a'], env: {} }, storedStdio)).toEqual({ kind: 'stdio', command: 'node', args: ['a'], env: {} });
  });
});

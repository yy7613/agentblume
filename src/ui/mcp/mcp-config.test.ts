import { describe, expect, it } from 'vitest';
import type { McpServerDto } from '../api/types';
import {
  EMPTY_MCP_SERVER_FORM, formatArgLines, formatEnvLines, formatHeaderLines, formatMcpServersDocument,
  parseArgLines, parseEnvLines, parseHeaderLines, parseMcpServersDocumentText, toMcpServerForm, toMcpServersDocument, toMcpTransport, transportSummary,
} from './mcp-config';

const stdioServer: McpServerDto = {
  scope: { tenantId: 'local', workspaceId: 'default' },
  name: 'filesystem',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], env: { API_TOKEN: 'xxx' }, cwd: 'C:/work' },
  disabled: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const httpServer: McpServerDto = {
  scope: { tenantId: 'local', workspaceId: 'default' },
  name: 'remote',
  transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  disabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('mcp-config 行パース', () => {
  it('argsは1行1引数で空行を落とし前後空白を除去する', () => {
    expect(parseArgLines('-y\n  @scope/server  \n\n.')).toEqual(['-y', '@scope/server', '.']);
    expect(parseArgLines('')).toEqual([]);
    expect(formatArgLines(['-y', '.'])).toBe('-y\n.');
  });

  it('envは最初の=で分割し、値に=を含められる', () => {
    expect(parseEnvLines('API_TOKEN=abc=def\nHOME=/root')).toEqual({ API_TOKEN: 'abc=def', HOME: '/root' });
    expect(formatEnvLines({ API_TOKEN: 'abc' })).toBe('API_TOKEN=abc');
  });

  it('envは区切りの無い行・キーが空の行を無視する', () => {
    expect(parseEnvLines('BROKEN\n=value\n\nOK=1')).toEqual({ OK: '1' });
  });

  it('headersは最初の:で分割し、値のURLを壊さない', () => {
    expect(parseHeaderLines('Authorization: Bearer x\nX-Origin: https://example.com/a')).toEqual({ Authorization: 'Bearer x', 'X-Origin': 'https://example.com/a' });
    expect(formatHeaderLines({ Authorization: 'Bearer x' })).toBe('Authorization: Bearer x');
  });
});

describe('mcp-config フォーム変換', () => {
  it('stdioフォームをtransportへ変換し、空のcwdはキーごと省略する', () => {
    const transport = toMcpTransport({ ...EMPTY_MCP_SERVER_FORM, name: 'fs', command: ' npx ', args: '-y\nserver', env: 'A=1', cwd: '  ' });
    expect(transport).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { A: '1' } });
    expect('cwd' in transport).toBe(false);
  });

  it('httpフォームをtransportへ変換する', () => {
    expect(toMcpTransport({ ...EMPTY_MCP_SERVER_FORM, kind: 'http', url: ' https://example.com/mcp ', headers: 'Authorization: Bearer x' }))
      .toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
  });

  it('DTO → フォーム → transport で往復しても情報が落ちない', () => {
    expect(toMcpTransport(toMcpServerForm(stdioServer))).toEqual(stdioServer.transport);
    expect(toMcpTransport(toMcpServerForm(httpServer))).toEqual(httpServer.transport);
    expect(toMcpServerForm(httpServer).disabled).toBe(true);
  });

  it('一覧行のtransport要約を作る', () => {
    expect(transportSummary(stdioServer.transport)).toBe('npx -y @modelcontextprotocol/server-filesystem .');
    expect(transportSummary(httpServer.transport)).toBe('https://example.com/mcp');
  });
});

describe('mcp-config 標準ドキュメント', () => {
  it('name昇順で並べ、既定値キーを省略する', () => {
    const doc = toMcpServersDocument([
      httpServer,
      stdioServer,
      { ...stdioServer, name: 'bare', transport: { kind: 'stdio', command: 'node', args: [], env: {} } },
    ]);
    expect(Object.keys(doc.mcpServers)).toEqual(['bare', 'filesystem', 'remote']);
    // args/env が空・cwd 未設定・disabled:false はキーごと落ちる。
    expect(doc.mcpServers.bare).toEqual({ command: 'node' });
    expect(doc.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], env: { API_TOKEN: 'xxx' }, cwd: 'C:/work' });
    expect(doc.mcpServers.remote).toEqual({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, disabled: true });
  });

  it('JSONタブ本文は2スペースインデントで生成する', () => {
    expect(formatMcpServersDocument([{ ...stdioServer, name: 'bare', transport: { kind: 'stdio', command: 'node', args: [], env: {} } }]))
      .toBe('{\n  "mcpServers": {\n    "bare": {\n      "command": "node"\n    }\n  }\n}');
  });

  it('本文をパースしてmcpServers部だけを取り出す', () => {
    const result = parseMcpServersDocumentText('{"mcpServers":{"a":{"command":"node"}}}');
    expect(result).toEqual({ ok: true, mcpServers: { a: { command: 'node' } } });
  });

  it('不正JSON・非オブジェクト・mcpServers欠落を理由コードで返す', () => {
    expect(parseMcpServersDocumentText('{ nope').ok).toBe(false);
    expect(parseMcpServersDocumentText('{ nope')).toMatchObject({ reason: 'invalid-json' });
    expect(parseMcpServersDocumentText('[]')).toMatchObject({ ok: false, reason: 'not-an-object' });
    expect(parseMcpServersDocumentText('{"servers":{}}')).toMatchObject({ ok: false, reason: 'missing-mcp-servers' });
  });
});

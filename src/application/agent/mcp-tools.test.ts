import { describe, expect, it } from 'vitest';
import { createMcpServerConfig, type McpServerConfig } from '../../domain/mcp/mcp-server';
import { InMemoryMcpServerRepository } from '../../adapters/storage/in-memory-mcp-server-repository';
import { McpClientError } from '../mcp/mcp-client';
import { FakeMcpClient } from '../mcp/mcp-client.fixtures';
import type { JsonObject } from '../model/model-provider';
import { isMcpToolName, mangleMcpToolName, McpToolset, MCP_TOOL_DESCRIPTION_MAX_CHARS, MCP_TOOL_NAME_MAX_LENGTH } from './mcp-tools';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function config(name: string, disabled = false): McpServerConfig {
  return createMcpServerConfig({
    scope, name, disabled,
    transport: { kind: 'stdio', command: 'node', args: ['server.js'], env: {} },
    updatedAt: '2026-07-11T00:00:00.000Z',
  });
}

const objectSchema: JsonObject = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };

describe('mangleMcpToolName', () => {
  it('mcp__<server>__<tool> を組み立てる', () => {
    expect(mangleMcpToolName('github', 'create_issue', new Set())).toBe('mcp__github__create_issue');
    expect(isMcpToolName('mcp__github__create_issue')).toBe(true);
    expect(isMcpToolName('score_lookup')).toBe(false);
  });

  it('許可外の文字を _ へ置換する', () => {
    expect(mangleMcpToolName('my.server-1', 'get/item v2', new Set())).toBe('mcp__my_server-1__get_item_v2');
  });

  it('64字を超える名前を切り詰める', () => {
    const name = mangleMcpToolName('s'.repeat(40), 't'.repeat(40), new Set()) as string;
    expect(name).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH);
    expect(name.startsWith('mcp__ssss')).toBe(true);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(name)).toBe(true);
  });

  it('衝突は数値サフィックスで避け、64字を超えないよう本体を詰める', () => {
    expect(mangleMcpToolName('srv', 'tool', new Set(['mcp__srv__tool']))).toBe('mcp__srv__tool_2');
    expect(mangleMcpToolName('srv', 'tool', new Set(['mcp__srv__tool', 'mcp__srv__tool_2']))).toBe('mcp__srv__tool_3');
    // 既存ツール名（ETL / ランタイム / ask_*）との衝突も同じ経路で避ける。
    expect(mangleMcpToolName('x', 'score_lookup', new Set(['score_lookup']))).toBe('mcp__x__score_lookup');

    const long = mangleMcpToolName('s'.repeat(40), 't'.repeat(40), new Set()) as string;
    const collided = mangleMcpToolName('s'.repeat(40), 't'.repeat(40), new Set([long])) as string;
    expect(collided).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH);
    expect(collided.endsWith('_2')).toBe(true);
    expect(collided).not.toBe(long);
  });
});

describe('McpToolset.resolve', () => {
  it('複数サーバーのツールをマングル名で定義化し、呼び出しを元のツール名へルーティングする', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('files'));
    await servers.save(config('search'));
    const client = new FakeMcpClient({
      files: [{ name: 'read_file', description: 'Read a file.', inputSchema: objectSchema }],
      search: [{ name: 'query', inputSchema: { type: 'object', properties: {} } }],
    });
    const toolset = await McpToolset.resolve({ scope, serverNames: ['files', 'search', 'files'], servers, client });

    expect(toolset.definitions().map((definition) => definition.name)).toEqual(['mcp__files__read_file', 'mcp__search__query']);
    expect(toolset.definitions()[0]).toMatchObject({ description: 'Read a file.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } });
    // description 未指定はサーバー名を含む既定文へフォールバックする。
    expect(toolset.definitions()[1]?.description).toContain("MCP server 'search'");
    expect(toolset.isMcpTool('mcp__files__read_file')).toBe(true);
    expect(toolset.isMcpTool('read_file')).toBe(false);
    // 重複指定したサーバーは1回だけ解決する。
    expect(client.listed).toEqual(['files', 'search']);

    const result = await toolset.execute({ id: 'c1', name: 'mcp__files__read_file', arguments: { q: 'a.txt' } });
    expect(result).toMatchObject({ content: 'read_file ok', isError: false });
    expect(client.calls).toEqual([{ server: 'files', tool: 'read_file', args: { q: 'a.txt' } }]);
  });

  it('存在しない・disabled・listTools失敗のサーバーをスキップして残りで続行する', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('ok'));
    await servers.save(config('off', true));
    await servers.save(config('broken'));
    const client = new FakeMcpClient({
      ok: [{ name: 'ping', inputSchema: objectSchema }],
      off: [{ name: 'never', inputSchema: objectSchema }],
      broken: new McpClientError("MCP server 'broken' failed to start"),
    });
    const toolset = await McpToolset.resolve({ scope, serverNames: ['ok', 'off', 'broken', 'ghost'], servers, client });

    expect(toolset.definitions().map((definition) => definition.name)).toEqual(['mcp__ok__ping']);
    // disabled と未登録は接続すらしない。
    expect(client.listed).toEqual(['ok', 'broken']);
  });

  it('object でない inputSchema のツールはスキップする', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('mixed'));
    const client = new FakeMcpClient({
      mixed: [
        { name: 'good', inputSchema: objectSchema },
        { name: 'array_schema', inputSchema: { type: 'array', items: { type: 'string' } } },
        { name: 'empty_schema', inputSchema: {} },
        { name: '', inputSchema: objectSchema },
      ],
    });
    const toolset = await McpToolset.resolve({ scope, serverNames: ['mixed'], servers, client });
    expect(toolset.definitions().map((definition) => definition.name)).toEqual(['mcp__mixed__good']);
  });

  it('予約済み名・サーバー間の同名ツールと衝突しないよう名前を割り当てる', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('a'));
    await servers.save(config('b'));
    const client = new FakeMcpClient({
      a: [{ name: 'run', inputSchema: objectSchema }, { name: 'run', inputSchema: objectSchema }],
      b: [{ name: 'run', inputSchema: objectSchema }],
    });
    const toolset = await McpToolset.resolve({ scope, serverNames: ['a', 'b'], servers, client, reservedNames: ['mcp__b__run'] });

    expect(toolset.definitions().map((definition) => definition.name)).toEqual(['mcp__a__run', 'mcp__a__run_2', 'mcp__b__run_2']);
    expect(toolset.find('mcp__b__run_2')).toMatchObject({ server: 'b', originalToolName: 'run' });
  });

  it('長すぎるdescriptionを500字へクリップする', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('verbose'));
    const client = new FakeMcpClient({ verbose: [{ name: 'talk', description: 'd'.repeat(2_000), inputSchema: objectSchema }] });
    const toolset = await McpToolset.resolve({ scope, serverNames: ['verbose'], servers, client });
    expect(toolset.definitions()[0]?.description).toHaveLength(MCP_TOOL_DESCRIPTION_MAX_CHARS);
  });

  it('isError:true をそのまま返し、接続失敗は利用不可メッセージとして返す', async () => {
    const servers = new InMemoryMcpServerRepository();
    await servers.save(config('flaky'));
    const client = new FakeMcpClient(
      { flaky: [{ name: 'fail', inputSchema: objectSchema }, { name: 'drop', inputSchema: objectSchema }] },
      { 'flaky/fail': { content: 'rate limited', isError: true }, 'flaky/drop': new McpClientError('connection closed') },
    );
    const toolset = await McpToolset.resolve({ scope, serverNames: ['flaky'], servers, client });

    expect(await toolset.execute({ id: 'c1', name: 'mcp__flaky__fail', arguments: {} })).toMatchObject({ content: 'rate limited', isError: true });
    expect(await toolset.execute({ id: 'c2', name: 'mcp__flaky__drop', arguments: {} })).toMatchObject({
      content: "MCP server 'flaky' unavailable: connection closed", isError: true,
    });
    await expect(toolset.execute({ id: 'c3', name: 'mcp__flaky__ghost', arguments: {} })).rejects.toThrow(/unknown MCP tool/);
  });

  it('empty() は定義を持たず何も解決しない', async () => {
    const toolset = McpToolset.empty();
    expect(toolset.definitions()).toEqual([]);
    expect(toolset.isMcpTool('mcp__a__b')).toBe(false);
    await expect(toolset.execute({ id: 'c1', name: 'mcp__a__b', arguments: {} })).rejects.toThrow(/unknown MCP tool/);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { McpServerDto } from '../api/types';
import { McpPage } from './McpPage';
afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };
const stdioServer: McpServerDto = {
  scope, name: 'filesystem',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: {} },
  disabled: false, updatedAt: '2026-01-01T00:00:00.000Z',
};
const httpServer: McpServerDto = {
  scope, name: 'remote',
  transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  disabled: true, updatedAt: '2026-01-01T00:00:00.000Z',
};

function mcpClient(servers: readonly McpServerDto[] = []): ToolApiClient {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue(servers),
    saveMcpServer: vi.fn().mockResolvedValue(stdioServer),
    replaceMcpServers: vi.fn().mockResolvedValue(servers),
    deleteMcpServer: vi.fn().mockResolvedValue(undefined),
    testMcpServer: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
  } as unknown as ToolApiClient;
}

describe('McpPage', () => {
  it('選択Toolの固定versionをmanifest previewへ反映し公開は遮断する', async () => {
    const client = { listTools: vi.fn().mockResolvedValue([{ internalId: 'scores', displayName: 'Scores', publishName: 'scores', latestVersion: '1.2.0', state: 'draft' }]) } as unknown as ToolApiClient;
    render(<McpPage client={client} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Scores/ }));
    expect(document.querySelector('.manifest-preview')?.textContent).toContain('scores@1.2.0');
    expect((screen.getByRole('button', { name: 'Publish MCP server' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('読み込み失敗時に再読み込みボタンで再取得できる', async () => {
    const listTools = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([{ internalId: 'scores', displayName: 'Scores', publishName: 'scores', latestVersion: '1.2.0', state: 'draft' }]);
    const client = { listTools } as unknown as ToolApiClient;
    render(<McpPage client={client} />);
    expect(await screen.findByText('boom')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(listTools).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Scores')).toBeTruthy();
    expect(screen.queryByText('boom')).toBeNull();
  });

  describe('MCPクライアント', () => {
    it('登録済みサーバーをtransport要約とdisabledバッジ付きで一覧表示する', async () => {
      render(<McpPage client={mcpClient([stdioServer, httpServer])} />);
      expect(await screen.findByText('filesystem')).toBeTruthy();
      expect(screen.getByText('npx -y @modelcontextprotocol/server-filesystem')).toBeTruthy();
      expect(screen.getByText('https://example.com/mcp')).toBeTruthy();
      // disabled は実行時スキップの警告としてバッジ表示する。
      expect(screen.getByText('disabled')).toBeTruthy();
    });

    it('サーバーが無ければempty stateを表示する', async () => {
      render(<McpPage client={mcpClient()} />);
      expect(await screen.findByText('No MCP servers yet.')).toBeTruthy();
    });

    it('フォーム保存でargs/envの行をパースしたDTOをsaveMcpServerへ渡す', async () => {
      const client = mcpClient();
      render(<McpPage client={client} />);
      await screen.findByText('No MCP servers yet.');

      await userEvent.type(screen.getByLabelText('MCP server name'), 'filesystem');
      await userEvent.type(screen.getByLabelText('MCP command'), 'npx');
      await userEvent.type(screen.getByLabelText('MCP args'), '-y{enter}@modelcontextprotocol/server-filesystem');
      await userEvent.type(screen.getByLabelText('MCP env'), 'API_TOKEN=abc{enter}HOME=/root');
      await userEvent.click(screen.getByRole('button', { name: 'Save server' }));

      await waitFor(() => expect(client.saveMcpServer).toHaveBeenCalledWith({
        scope,
        server: {
          name: 'filesystem',
          transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { API_TOKEN: 'abc', HOME: '/root' } },
          disabled: false,
        },
      }));
      // 保存後は一覧を再読込し、フォームを初期化する。
      expect(client.listMcpServers).toHaveBeenCalledTimes(2);
      expect((screen.getByLabelText('MCP server name') as HTMLInputElement).value).toBe('');
    });

    it('httpを選ぶとURLとヘッダー行をパースして保存する', async () => {
      const client = mcpClient();
      render(<McpPage client={client} />);
      await screen.findByText('No MCP servers yet.');

      await userEvent.click(screen.getByRole('radio', { name: 'http' }));
      await userEvent.type(screen.getByLabelText('MCP server name'), 'remote');
      await userEvent.type(screen.getByLabelText('MCP server URL'), 'https://example.com/mcp');
      await userEvent.type(screen.getByLabelText('MCP headers'), 'Authorization: Bearer x');
      await userEvent.click(screen.getByRole('button', { name: 'Save server' }));

      await waitFor(() => expect(client.saveMcpServer).toHaveBeenCalledWith({
        scope,
        server: { name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }, disabled: false },
      }));
    });

    it('編集ボタンで既存設定をフォームへ復元し、nameは読み取り専用にする', async () => {
      render(<McpPage client={mcpClient([stdioServer])} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

      const name = screen.getByLabelText('MCP server name') as HTMLInputElement;
      expect(name.value).toBe('filesystem');
      expect(name.readOnly).toBe(true);
      expect((screen.getByLabelText('MCP command') as HTMLInputElement).value).toBe('npx');
      expect((screen.getByLabelText('MCP args') as HTMLTextAreaElement).value).toBe('-y\n@modelcontextprotocol/server-filesystem');
    });

    it('テストボタンで接続に成功するとツール一覧をインライン表示する', async () => {
      const client = mcpClient([stdioServer]);
      (client.testMcpServer as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, tools: [{ name: 'read_file', description: 'Read a file' }, { name: 'write_file' }] });
      render(<McpPage client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Test' }));

      expect(await screen.findByText('read_file')).toBeTruthy();
      expect(screen.getByText('Read a file')).toBeTruthy();
      expect(screen.getByText('write_file')).toBeTruthy();
      expect(client.testMcpServer).toHaveBeenCalledWith('filesystem', scope);
    });

    it('接続失敗はHTTPエラーではなくerror本文として表示する', async () => {
      const client = mcpClient([stdioServer]);
      (client.testMcpServer as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'spawn npx ENOENT' });
      render(<McpPage client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
      expect(await screen.findByText('spawn npx ENOENT')).toBeTruthy();
    });

    it('削除は確認ダイアログの承諾後にdeleteMcpServerを呼び一覧を再取得する', async () => {
      const client = mcpClient([stdioServer]);
      (client.listMcpServers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([stdioServer]).mockResolvedValueOnce([]);
      render(<McpPage client={client} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('filesystem');
      expect(client.deleteMcpServer).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      expect(client.deleteMcpServer).toHaveBeenCalledWith('filesystem', scope);
      expect(await screen.findByText('No MCP servers yet.')).toBeTruthy();
    });

    /**
     * 変更系と接続テストは `mcp-server:operate`（operator / workspace-admin）だけが通る。
     * 403 の原文は権限名しか言わないので、画面では「何に・どのロールが要るか」まで出す。
     */
    it('保存の 403（operate 権限なし）は権限名とロールを含む理由をエラー欄に表示する', async () => {
      const client = mcpClient();
      (client.saveMcpServer as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(403, 'FORBIDDEN', "this operation requires the 'mcp-server:operate' permission"));
      render(<McpPage client={client} />);
      await screen.findByText('No MCP servers yet.');
      await userEvent.type(screen.getByLabelText('MCP server name'), 'filesystem');
      await userEvent.type(screen.getByLabelText('MCP command'), 'npx');
      await userEvent.click(screen.getByRole('button', { name: 'Save server' }));
      const shown = await screen.findByText(/requires the 'mcp-server:operate' permission \(operator or workspace-admin role\)/);
      expect(shown.className).toBe('api-error');
      // 保存されていないのでフォームは残る（入力をやり直させない）。
      expect((screen.getByLabelText('MCP server name') as HTMLInputElement).value).toBe('filesystem');
    });

    it('接続テストの 403 も同じ理由を表示する', async () => {
      const client = mcpClient([stdioServer]);
      (client.testMcpServer as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(403, 'FORBIDDEN', "this operation requires the 'mcp-server:operate' permission"));
      render(<McpPage client={client} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
      expect(await screen.findByText(/requires the 'mcp-server:operate' permission/)).toBeTruthy();
    });

    describe('ロールに応じたボタンの無効化（判定はサーバーが行う。ここは先読み）', () => {
      function sessionOf(roles: readonly string[], mode: 'token' | 'single-user' = 'token') {
        return { mode, authenticationRequired: mode === 'token', principal: { subject: 'eve', tenantId: 'local', workspaceId: 'default', roles } };
      }
      function withSession(client: ToolApiClient, getSession: ReturnType<typeof vi.fn>): ToolApiClient {
        (client as unknown as { getSession: unknown }).getSession = getSession;
        return client;
      }

      it('editor のセッションでは保存・テスト・削除・適用を無効化し、理由を title と画面に出す', async () => {
        const client = withSession(mcpClient([stdioServer]), vi.fn().mockResolvedValue(sessionOf(['editor'])));
        render(<McpPage client={client} />);
        await screen.findByText('filesystem');
        await waitFor(() => expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true));
        expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Save server' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole('button', { name: 'Test' }).getAttribute('title')).toContain("'mcp-server:operate'");
        expect(screen.getByText('Read-only')).toBeTruthy();
        // 編集（フォームへの読み込み）は閲覧なので残す。
        expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false);
        await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));
        expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
        expect(client.testMcpServer).not.toHaveBeenCalled();
      });

      it.each<[string, readonly string[], 'token' | 'single-user']>([
        ['operator', ['operator'], 'token'],
        ['workspace-admin', ['workspace-admin'], 'token'],
        ['単一ユーザー（全ロール）', ['viewer', 'editor', 'publisher', 'operator', 'workspace-admin'], 'single-user'],
      ])('%s のセッションでは従来どおり操作できる', async (_label, roles, mode) => {
        const getSession = vi.fn().mockResolvedValue(sessionOf(roles, mode));
        const client = withSession(mcpClient([stdioServer]), getSession);
        render(<McpPage client={client} />);
        await screen.findByText('filesystem');
        await waitFor(() => expect(getSession).toHaveBeenCalled());
        await userEvent.click(screen.getByRole('button', { name: 'Test' }));
        await waitFor(() => expect(client.testMcpServer).toHaveBeenCalledWith('filesystem', scope));
        expect(screen.getByRole('button', { name: 'Test' }).getAttribute('title')).toBeNull();
        expect(screen.queryByText('Read-only')).toBeNull();
      });

      it('セッションが取れない（旧クライアント・取得失敗）ときは無効化しない', async () => {
        render(<McpPage client={mcpClient([stdioServer])} />);
        await screen.findByText('filesystem');
        expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false);
        cleanup();

        const getSession = vi.fn().mockRejectedValue(new Error('offline'));
        render(<McpPage client={withSession(mcpClient([stdioServer]), getSession)} />);
        await screen.findByText('filesystem');
        await waitFor(() => expect(getSession).toHaveBeenCalled());
        expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false);
        expect(screen.queryByText('Read-only')).toBeNull();
      });
    });
  });

  describe('MCPクライアント JSONタブ', () => {
    it('保存済み状態から標準mcpServersドキュメントを生成する', async () => {
      render(<McpPage client={mcpClient([httpServer, stdioServer])} />);
      await screen.findByText('filesystem');
      await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));

      expect(JSON.parse((screen.getByLabelText('mcpServers document') as HTMLTextAreaElement).value)).toEqual({
        mcpServers: {
          // env が空・disabled:false のキーは省略される。
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, disabled: true },
        },
      });
      expect(screen.getByText('Apply replaces every server')).toBeTruthy();
    });

    it('適用でreplaceMcpServersを呼び、結果をフォームタブへ反映する', async () => {
      const client = mcpClient([]);
      (client.replaceMcpServers as ReturnType<typeof vi.fn>).mockResolvedValue([stdioServer]);
      render(<McpPage client={client} />);
      await screen.findByText('No MCP servers yet.');
      await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));

      fireEvent.change(screen.getByLabelText('mcpServers document'), { target: { value: '{"mcpServers":{"filesystem":{"command":"npx","args":["-y"]}}}' } });
      await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(client.replaceMcpServers).toHaveBeenCalledWith({ scope, mcpServers: { filesystem: { command: 'npx', args: ['-y'] } } }));
      await userEvent.click(screen.getByRole('tab', { name: 'Form' }));
      expect(await screen.findByText('filesystem')).toBeTruthy();
    });

    it('不正JSONは適用せずエラーを表示する', async () => {
      const client = mcpClient([]);
      render(<McpPage client={client} />);
      await screen.findByText('No MCP servers yet.');
      await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));

      fireEvent.change(screen.getByLabelText('mcpServers document'), { target: { value: '{ oops' } });
      await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(await screen.findByText(/The document is not valid JSON/)).toBeTruthy();
      expect(client.replaceMcpServers).not.toHaveBeenCalled();

      // mcpServers を持たない正しいJSONも弾く。
      fireEvent.change(screen.getByLabelText('mcpServers document'), { target: { value: '{"servers":{}}' } });
      await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(await screen.findByText('The document must have an "mcpServers" object.')).toBeTruthy();
      expect(client.replaceMcpServers).not.toHaveBeenCalled();
    });
  });
});

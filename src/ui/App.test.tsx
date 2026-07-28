// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from './api/tool-api';
import { App } from './App';

vi.mock('./tool-builder/ToolBuilder', () => ({ ToolBuilder: () => <main>Tool builder</main> }));
vi.mock('./agent-builder/AgentBuilder', () => ({ AgentBuilder: () => <main>Agent builder</main> }));
vi.mock('./skill-builder/SkillBuilder', () => ({ SkillBuilder: () => <main>Skill builder</main> }));
vi.mock('./chat/ChatPage', () => ({ ChatPage: () => <main>Chat page</main> }));
vi.mock('./mcp/McpPage', () => ({ McpPage: () => <main>MCP page</main> }));
vi.mock('./validation/ValidationPage', () => ({ ValidationPage: () => <main>Validation page</main> }));
vi.mock('./settings/SettingsPage', () => ({ SettingsPage: () => <main>Settings page</main> }));
vi.mock('./data-sources/DataSourcesPage', () => ({ DataSourcesPage: () => <main>Data sources page</main> }));
vi.mock('./harness-builder/HarnessBuilder', () => ({ HarnessBuilder: () => <main>Multi-agent builder</main> }));
// hashルーティングを使うため、テスト間でURLを持ち越さない。
beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(cleanup);

describe('App navigation', () => {
  it('初期画面はチャット(サンプルAgentですぐ試せる導線)', () => {
    render(<App client={{} as ToolApiClient} />);
    expect(screen.getByText('Chat page')).toBeTruthy();
  });

  it('ナビを作る/確かめる/運用の3グループで表示する', () => {
    render(<App client={{} as ToolApiClient} />);
    expect(screen.getByText('Build')).toBeTruthy();
    expect(screen.getByText('Check')).toBeTruthy();
    expect(screen.getByText('Operate')).toBeTruthy();
  });

  it('チャットはナビ最上部の独立ボタンとして表示する', () => {
    render(<App client={{} as ToolApiClient} />);
    const [first] = screen.getAllByRole('button');
    expect(first?.textContent).toBe('Chat');
  });

  it('Status画面を有効なナビとして開く', async () => {
    const client = { listRuns: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
    render(<App client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(await screen.findByRole('heading', { name: 'Run status' })).toBeTruthy();
    await waitFor(() => expect(client.listRuns).toHaveBeenCalled());
  });

  it('Agent画面を有効なナビとして開く', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('Agent builder')).toBeTruthy();
  });

  it('Skill画面を有効なナビとして開く', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    expect(screen.getByText('Skill builder')).toBeTruthy();
  });

  it.each([['Chat', 'Chat page'], ['Data', 'Data sources page'], ['MCP', 'MCP page'], ['Validation', 'Validation page'], ['Settings', 'Settings page']] as const)('%s画面を有効なナビとして開く', async (name, content) => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name }));
    expect(await screen.findByText(content)).toBeTruthy();
  });
});

describe('App URLルーティング', () => {
  it('ナビ操作でhashを更新する（ディープリンク可能なURLになる）', async () => {
    render(<App client={{} as ToolApiClient} />);
    expect(window.location.hash).toBe('#/chat');
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(window.location.hash).toBe('#/agent');
    // 表示名を差し替えているMulti-Agentも、routeは画面id（harness）のまま。
    await userEvent.click(screen.getByRole('button', { name: 'Multi-Agent' }));
    expect(window.location.hash).toBe('#/harness');
  });

  it('hash付きで開くとその画面から始まる（リロードで戻らない）', async () => {
    window.history.replaceState(null, '', '#/skill');
    render(<App client={{} as ToolApiClient} />);
    expect(await screen.findByText('Skill builder')).toBeTruthy();
  });

  it('ブラウザの戻る（hashchange）で前の画面へ戻る', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('Agent builder')).toBeTruthy();

    window.history.replaceState(null, '', '#/chat');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByText('Chat page')).toBeTruthy();
  });

  it('不正なhashはChatへフォールバックしURLも揃える', async () => {
    window.history.replaceState(null, '', '#/not-a-screen');
    render(<App client={{} as ToolApiClient} />);
    expect(await screen.findByText('Chat page')).toBeTruthy();
    expect(window.location.hash).toBe('#/chat');
  });
});

describe('App アプリ内ヘルプ', () => {
  it('ヘルプボタンは表示中の画面の説明を出し、Escapeで閉じる', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Data' }));
    await userEvent.click(screen.getByRole('button', { name: 'Help for this screen' }));
    expect(await screen.findByRole('dialog', { name: 'Help' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Data sources' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('画面を変えるとヘルプの内容も変わる', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'MCP' }));
    await userEvent.click(screen.getByRole('button', { name: 'Help for this screen' }));
    expect(await screen.findByRole('heading', { name: 'MCP' })).toBeTruthy();
  });
});

describe('App ウェルカム（初回体験）', () => {
  it('一覧APIを持たないclientでは出さない（既存画面の描画を妨げない）', () => {
    render(<App client={{} as ToolApiClient} />);
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });

  it('Chat画面かつデータが空のときだけ出す', async () => {
    const client = {
      listDataSources: vi.fn().mockResolvedValue([]),
      listTools: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
    } as unknown as ToolApiClient;
    render(<App client={client} />);
    expect(await screen.findByRole('heading', { name: 'Welcome to AgentBlume' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });
});

describe('App 未保存の離脱確認', () => {
  it('未保存を報告する画面が無ければ確認せずに遷移する', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Skill builder')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

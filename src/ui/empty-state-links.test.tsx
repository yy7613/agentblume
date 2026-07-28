// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from './api/tool-api';
import { NavigationProvider } from './navigation';
import { AgentBuilder } from './agent-builder/AgentBuilder';
import { DataSourcesPage } from './data-sources/DataSourcesPage';
import { FactoryPage } from './factory/FactoryPage';
import { HarnessBuilder } from './harness-builder/HarnessBuilder';
import { McpPage } from './mcp/McpPage';
import { ToolBuilder } from './tool-builder/ToolBuilder';

/**
 * 「どこへ行けばいいか」が書いてある空状態から、実際にその画面へ飛べることを画面横断で確認する。
 * 遷移は必ず App の requestScreen（未保存確認つき）へ渡るので、ここでは context 経由の呼び出しだけを見る。
 */

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); });

const emptyClient = {
  listTools: vi.fn().mockResolvedValue([]),
  listSkills: vi.fn().mockResolvedValue([]),
  listAgents: vi.fn().mockResolvedValue([]),
  listWikis: vi.fn().mockResolvedValue([]),
  listMcpServers: vi.fn().mockResolvedValue([]),
  listHarnesses: vi.fn().mockResolvedValue([]),
  listDataSources: vi.fn().mockResolvedValue([]),
  listDatabaseConnections: vi.fn().mockResolvedValue([]),
  listFactoryRuns: vi.fn().mockResolvedValue([]),
} as unknown as ToolApiClient;

function renderWithNavigation(node: React.ReactElement) {
  const navigate = vi.fn();
  render(<NavigationProvider navigate={navigate}>{node}</NavigationProvider>);
  return navigate;
}

describe('空状態からの画面遷移', () => {
  it('Agent Builder: ツール0件・MCP0件・Wiki0件からそれぞれの画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<AgentBuilder client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'New agent' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Open the Tool screen' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    await userEvent.click(screen.getByRole('button', { name: 'Open the Skill screen' }));
    expect(navigate).toHaveBeenCalledWith('Skill');
    await userEvent.click(screen.getByRole('button', { name: 'Open the MCP screen' }));
    expect(navigate).toHaveBeenCalledWith('MCP');
    await userEvent.click(screen.getByRole('button', { name: 'Open the Memory screen' }));
    expect(navigate).toHaveBeenCalledWith('Memory');
  });

  it('Agent Builder 一覧: エージェント0件からFactoryへ飛べる', async () => {
    const navigate = renderWithNavigation(<AgentBuilder client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate one automatically (Factory)' }));
    expect(navigate).toHaveBeenCalledWith('Factory');
  });

  it('Tool Builder 一覧: ツール0件からデータソース画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<ToolBuilder client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Data sources screen' }));
    expect(navigate).toHaveBeenCalledWith('Data');
  });

  it('Factory: データソース0件からデータソース画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<FactoryPage client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Data sources screen' }));
    expect(navigate).toHaveBeenCalledWith('Data');
  });

  it('Factory 強化モード: エージェント0件からエージェント画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<FactoryPage client={emptyClient} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Enhance an existing agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Agent screen' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
  });

  it('Multi-Agent Builder 一覧: 0件からエージェント画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<HarnessBuilder client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Agent screen' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
  });

  it('MCP: 公開候補のツール0件からツール画面へ飛べる', async () => {
    const navigate = renderWithNavigation(<McpPage client={emptyClient} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Tool screen' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
  });

  it('データソース画面: 0件のときはサンプル投入ボタンから一式を読み込める（ウェルカムを閉じた後の入口）', async () => {
    const seedSampleData = vi.fn().mockResolvedValue({ dataSources: ['a'], tools: ['t'], skills: ['s'], agents: ['g'], wikis: ['w'], created: 8 });
    const client = { ...emptyClient, seedSampleData } as unknown as ToolApiClient;
    renderWithNavigation(<DataSourcesPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load sample data' }));
    expect(seedSampleData).toHaveBeenCalledWith({ tenantId: 'local', workspaceId: 'default' });
    expect(await screen.findByText(/Loaded the sample set \(8 new item\(s\)\)/)).toBeTruthy();
  });

  it('データソース画面: 投入済み（created: 0）なら変更なしと伝える（冪等）', async () => {
    const client = { ...emptyClient, seedSampleData: vi.fn().mockResolvedValue({ dataSources: [], tools: [], skills: [], agents: [], wikis: [], created: 0 }) } as unknown as ToolApiClient;
    renderWithNavigation(<DataSourcesPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load sample data' }));
    expect(await screen.findByText('The sample set was already loaded — nothing changed.')).toBeTruthy();
  });

  it('データソース画面: 登録済みがあるときは次の一手（ツール／Factory）へ飛べる', async () => {
    const client = {
      ...emptyClient,
      listDataSources: vi.fn().mockResolvedValue([{ id: 'ds', tenant: { tenantId: 'local', workspaceId: 'default' }, name: 'Sales', createdAt: 'now', updatedAt: 'now', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10 }]),
    } as unknown as ToolApiClient;
    const navigate = renderWithNavigation(<DataSourcesPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the Tool screen' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    await userEvent.click(screen.getByRole('button', { name: 'Open Agent Factory' }));
    expect(navigate).toHaveBeenCalledWith('Factory');
  });
});

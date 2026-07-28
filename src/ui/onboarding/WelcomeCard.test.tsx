// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { SampleDataSummaryDto } from '../api/types';
import { NavigationProvider } from '../navigation';
import { WelcomeCard } from './WelcomeCard';
import { WELCOME_DISMISSED_KEY } from './onboarding-state';

const sample: SampleDataSummaryDto = {
  dataSources: ['sample-products.csv', 'sample-customers.json', 'sample-monthly-sales.csv'],
  tools: ['sample-product-catalog'],
  skills: ['sample-product-analysis'],
  agents: ['sample-product-assistant'],
  wikis: ['sample-product-ops'],
  created: 6,
};

function makeClient(overrides: Partial<ToolApiClient> = {}): ToolApiClient {
  return {
    listDataSources: vi.fn().mockResolvedValue([]),
    listTools: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    getModelSettings: vi.fn().mockResolvedValue({ scope: { tenantId: 'local', workspaceId: 'default' } }),
    seedSampleData: vi.fn().mockResolvedValue(sample),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderCard(client: ToolApiClient, navigate = vi.fn()) {
  render(<NavigationProvider navigate={navigate}><WelcomeCard client={client} /></NavigationProvider>);
  return navigate;
}

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

describe('WelcomeCard 表示条件', () => {
  it('初回（データが空・dismissなし）は表示する', async () => {
    renderCard(makeClient());
    expect(await screen.findByRole('heading', { name: 'Welcome to AgentBlume' })).toBeTruthy();
  });

  it('資産があれば表示しない', async () => {
    const client = makeClient({ listAgents: vi.fn().mockResolvedValue([{ internalId: 'a' }]) as unknown as ToolApiClient['listAgents'] });
    renderCard(client);
    await waitFor(() => expect(client.listAgents).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });

  it('「今後表示しない」を押すとlocalStorageへ記録して消える', async () => {
    renderCard(makeClient());
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    await userEvent.click(screen.getByRole('button', { name: 'Do not show this again' }));
    expect(localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });

  it('dismiss済みなら一覧APIすら叩かない', () => {
    localStorage.setItem(WELCOME_DISMISSED_KEY, 'true');
    const client = makeClient();
    renderCard(client);
    expect(client.listDataSources).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });

  it('一覧APIを持たないclientでは何も描画しない', () => {
    renderCard({} as ToolApiClient);
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });

  it('取得に失敗したら黙って表示しない（初回体験をエラーで潰さない）', async () => {
    const client = makeClient({ listTools: vi.fn().mockRejectedValue(new Error('offline')) as unknown as ToolApiClient['listTools'] });
    renderCard(client);
    await waitFor(() => expect(client.listTools).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Welcome to AgentBlume' })).toBeNull();
  });
});

describe('WelcomeCard 3つの入口', () => {
  it('自分のデータ・自動生成はそれぞれの画面へ遷移する', async () => {
    const navigate = renderCard(makeClient());
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    await userEvent.click(screen.getByRole('button', { name: /Start with my own data/ }));
    expect(navigate).toHaveBeenCalledWith('Data');
    await userEvent.click(screen.getByRole('button', { name: /Generate one automatically/ }));
    expect(navigate).toHaveBeenCalledWith('Factory');
  });

  it('モデル未設定なら最優先で設定画面へ誘導する', async () => {
    const navigate = renderCard(makeClient());
    await screen.findByText('Set the model first');
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
  });

  it('モデル設定済みなら最優先の警告を出さない', async () => {
    const client = makeClient({ getModelSettings: vi.fn().mockResolvedValue({ scope: { tenantId: 'local', workspaceId: 'default' }, main: { source: 'registry', model: 'x' } }) as unknown as ToolApiClient['getModelSettings'] });
    renderCard(client);
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    expect(screen.queryByText('Set the model first')).toBeNull();
  });
});

describe('WelcomeCard サンプル投入', () => {
  it('投入した内容の一覧と件数を表示し、チャットへ誘導する', async () => {
    const client = makeClient();
    const navigate = renderCard(client);
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    await userEvent.click(screen.getByRole('button', { name: /Load the sample and try it/ }));

    expect(client.seedSampleData).toHaveBeenCalledWith({ tenantId: 'local', workspaceId: 'default' });
    expect(await screen.findByText('Loaded the sample (6 new item(s)).')).toBeTruthy();
    expect(screen.getByText('sample-products.csv')).toBeTruthy();
    expect(screen.getByText('sample-product-assistant')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Chat with the sample Agent' }));
    expect(navigate).toHaveBeenCalledWith('Chat');
  });

  it('投入済み（created: 0）なら「変更なし」と伝える（冪等）', async () => {
    const client = makeClient({ seedSampleData: vi.fn().mockResolvedValue({ ...sample, created: 0 }) as unknown as ToolApiClient['seedSampleData'] });
    renderCard(client);
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    await userEvent.click(screen.getByRole('button', { name: /Load the sample and try it/ }));
    expect(await screen.findByText('The sample was already loaded — nothing changed.')).toBeTruthy();
  });

  it('投入に失敗したらカードを閉じずに理由を出す', async () => {
    const client = makeClient({ seedSampleData: vi.fn().mockRejectedValue(new Error('seed failed')) as unknown as ToolApiClient['seedSampleData'] });
    renderCard(client);
    await screen.findByRole('heading', { name: 'Welcome to AgentBlume' });
    await userEvent.click(screen.getByRole('button', { name: /Load the sample and try it/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'seed failed');
  });
});

describe('WelcomeCard 進捗チェックリスト', () => {
  it('到達状況と、各手順の画面への遷移を出す', async () => {
    const navigate = renderCard(makeClient());
    expect(await screen.findByRole('heading', { name: 'Progress 0/4' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Build a Tool' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { MemoryProposalDto, WikiPageDto, WikiPageSummaryDto } from '../api/types';
import { MemoryPage } from './MemoryPage';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

const summary = (id: string, title: string, tags: string[]): WikiPageSummaryDto => ({ id, wikiId: 'customer-a', title, tags, version: 1, updatedAt: '2026-07-08T00:00:00.000Z' });
const page = (id: string, title: string, body: string): WikiPageDto => ({ id, wikiId: 'customer-a', title, body, tags: ['sql'], version: 1, updatedAt: '2026-07-08T00:00:00.000Z', tenant: scope, sourceRuns: [] });

function wikiProposal(id: string): MemoryProposalDto {
  return { id, tenant: scope, target: { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'Cohort', tags: ['sql'], body: 'Filter age>=18.' }, summary: 'capture cohort rule', state: 'draft', createdAt: '2026-07-08T00:00:00.000Z' };
}

function makeClient(overrides: Partial<Record<keyof ToolApiClient, unknown>> = {}) {
  return {
    listWikis: vi.fn().mockResolvedValue([{ id: 'customer-a', name: 'Customer A', description: 'A knowledge', updatedAt: 'now' }]),
    saveWikiSpace: vi.fn().mockResolvedValue({ id: 'customer-b', name: 'Customer B', description: 'B knowledge', tenant: scope, createdAt: 'now', updatedAt: 'now' }),
    deleteWikiSpace: vi.fn().mockResolvedValue(undefined),
    listWikiPages: vi.fn().mockResolvedValue([summary('p1', 'Cohort SQL', ['sql'])]),
    getWikiPage: vi.fn().mockResolvedValue(page('p1', 'Cohort SQL', 'Filter adults.')),
    saveWikiPage: vi.fn().mockResolvedValue(page('p1', 'Cohort SQL', 'Filter adults.')),
    deleteWiki: vi.fn().mockResolvedValue(undefined),
    listWiki: vi.fn().mockResolvedValue([summary('p1', 'Cohort SQL', ['sql'])]),
    getWiki: vi.fn().mockResolvedValue(page('p1', 'Cohort SQL', 'Filter adults.')),
    saveWiki: vi.fn().mockResolvedValue(page('p1', 'Cohort SQL', 'Filter adults.')),
    listProposals: vi.fn().mockResolvedValue([wikiProposal('m1')]),
    approveProposal: vi.fn().mockResolvedValue({ ...wikiProposal('m1'), state: 'approved' }),
    rejectProposal: vi.fn().mockResolvedValue({ ...wikiProposal('m1'), state: 'rejected' }),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('MemoryPage', () => {
  it('Wiki 一覧を表示し、ページを開いて編集フォームに反映する', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await screen.findByRole('button', { name: /Cohort SQL/ });
    await userEvent.click(screen.getByRole('button', { name: /Cohort SQL/ }));
    await waitFor(() => expect(client.getWikiPage).toHaveBeenCalledWith('customer-a', 'p1', scope));
    const title = await screen.findByDisplayValue('Cohort SQL');
    expect(title).toBeTruthy();
    expect(screen.getByDisplayValue('Filter adults.')).toBeTruthy();
  });

  it('Wiki を検索するとクエリ付きで再取得する', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await screen.findByRole('button', { name: /Cohort SQL/ });
    await userEvent.type(screen.getByLabelText('Search wiki'), 'cohort');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(client.listWikiPages).toHaveBeenCalledWith('customer-a', scope, 'cohort'));
  });

  it('新規ページを保存する（title/body 必須）', async () => {
    const client = makeClient({ listWikiPages: vi.fn().mockResolvedValue([]) });
    render(<MemoryPage client={client} />);
    await screen.findByText('No wiki pages yet.');
    const saveBtn = screen.getByRole('button', { name: 'Save page' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Title'), 'New note');
    await userEvent.type(screen.getByLabelText('Body'), 'Some knowledge.');
    await userEvent.type(screen.getByLabelText('Tags (comma-separated)'), 'a, b');
    await userEvent.click(saveBtn);
    await waitFor(() => expect(client.saveWikiPage).toHaveBeenCalledWith('customer-a', expect.objectContaining({ wikiId: 'customer-a', title: 'New note', body: 'Some knowledge.', tags: ['a', 'b'] })));
  });

  it('提案タブで draft を承認すると再取得する', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Proposals' }));
    const card = (await screen.findByText('capture cohort rule')).closest('li') as HTMLElement;
    expect(within(card).getByText('Filter age>=18.')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(client.approveProposal).toHaveBeenCalledWith('m1', scope));
  });

  it('提案タブで却下できる', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Proposals' }));
    await screen.findByText('capture cohort rule');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(client.rejectProposal).toHaveBeenCalledWith('m1', scope));
  });

  it('state フィルタを切り替えると絞り込みで再取得する', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Proposals' }));
    await waitFor(() => expect(client.listProposals).toHaveBeenCalledWith(scope, 'draft'));
    await userEvent.click(screen.getByRole('button', { name: 'Approved' }));
    await waitFor(() => expect(client.listProposals).toHaveBeenCalledWith(scope, 'approved'));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(client.listProposals).toHaveBeenCalledWith(scope, undefined));
  });

  it('読み込み失敗をアラート表示する', async () => {
    const client = makeClient({ listWikiPages: vi.fn().mockRejectedValue(new Error('boom')) });
    render(<MemoryPage client={client} />);
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });

  it('新しいWikiを作成して知識領域を分離できる', async () => {
    const client = makeClient();
    render(<MemoryPage client={client} />);
    await screen.findByRole('option', { name: 'Customer A' });
    await userEvent.click(screen.getByRole('button', { name: 'New wiki' }));
    await userEvent.type(screen.getByLabelText('Wiki ID'), 'customer-b');
    await userEvent.type(screen.getByLabelText('Wiki name'), 'Customer B');
    await userEvent.type(screen.getByLabelText('Description'), 'B knowledge');
    await userEvent.click(screen.getByRole('button', { name: 'Save wiki' }));
    await waitFor(() => expect(client.saveWikiSpace).toHaveBeenCalledWith({ scope, id: 'customer-b', name: 'Customer B', description: 'B knowledge' }));
  });

  it('ページのDeleteでdeleteWikiを呼び、一覧を再取得する', async () => {
    const client = makeClient();
    (client.listWikiPages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([summary('p1', 'Cohort SQL', ['sql'])])
      .mockResolvedValueOnce([]);
    render(<MemoryPage client={client} />);
    await screen.findByRole('button', { name: /Cohort SQL/ });

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(client.deleteWiki).toHaveBeenCalledWith('p1', scope);
    expect(client.listWikiPages).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('No wiki pages yet.')).toBeTruthy();
  });

  it('Wiki空間のDelete wikiでdeleteWikiSpaceを呼び、一覧を再取得する', async () => {
    const client = makeClient();
    (client.listWikis as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 'customer-a', name: 'Customer A', description: 'A knowledge', updatedAt: 'now' }])
      .mockResolvedValueOnce([]);
    render(<MemoryPage client={client} />);
    await screen.findByRole('option', { name: 'Customer A' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete wiki' }));

    expect(client.deleteWikiSpace).toHaveBeenCalledWith('customer-a', scope);
    expect(client.listWikis).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('option', { name: 'Customer A' })).toBeNull();
  });
});

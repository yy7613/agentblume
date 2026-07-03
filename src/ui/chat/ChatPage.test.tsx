// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { ChatPage } from './ChatPage';
afterEach(cleanup);
describe('ChatPage', () => {
  it('保存済みAgent versionを固定して実行し応答を表示する', async () => {
    const client = { listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]), runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', response: 'done', trace: [], usage: {}, mode: 'preview' }) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { internalId: 'agent', version: '2.0.0' }, mode: 'preview' })));
    expect(await screen.findByText('done')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { ValidationPage } from './ValidationPage';
afterEach(cleanup);
describe('ValidationPage', () => {
  it('test mode実行のTool利用を期待値と照合する', async () => {
    const client = { listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }]), runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-v', response: 'ok', tools: [{ internalId: 'scores', publishName: 'score_tool', version: '1.0.0' }], trace: [], usage: {}, mode: 'test' }) } as unknown as ToolApiClient;
    render(<ValidationPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'Expected tool' }), 'score_tool');
    await userEvent.click(screen.getByRole('button', { name: 'Run validation' }));
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'test' })));
    expect(await screen.findByText('PASS')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from './api/tool-api';
import { App } from './App';

vi.mock('./tool-builder/ToolBuilder', () => ({ ToolBuilder: () => <main>Tool builder</main> }));
vi.mock('./agent-builder/AgentBuilder', () => ({ AgentBuilder: () => <main>Agent builder</main> }));
afterEach(cleanup);

describe('App navigation', () => {
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
});

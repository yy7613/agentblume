// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { McpPage } from './McpPage';
afterEach(cleanup);
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
});

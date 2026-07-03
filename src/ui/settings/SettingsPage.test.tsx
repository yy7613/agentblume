// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { SettingsPage } from './SettingsPage';
afterEach(cleanup);
describe('SettingsPage', () => {
  it('API healthと安全ゲートを表示する', async () => {
    const client = { health: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as ToolApiClient;
    render(<SettingsPage client={client} />);
    await waitFor(() => expect(client.health).toHaveBeenCalled());
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(screen.getByText(/MCP publication locked/)).toBeTruthy();
  });
});

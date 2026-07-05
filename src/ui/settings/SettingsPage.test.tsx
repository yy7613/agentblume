// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { SettingsPage } from './SettingsPage';
import { I18nProvider } from '../i18n';
afterEach(() => { cleanup(); localStorage.clear(); });
describe('SettingsPage', () => {
  it('API healthと安全ゲートを表示する', async () => {
    const client = { health: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as ToolApiClient;
    render(<SettingsPage client={client} />);
    await waitFor(() => expect(client.health).toHaveBeenCalled());
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(screen.getByText(/MCP publication locked/)).toBeTruthy();
  });

  it('表示言語を日本語へ切り替えてブラウザに保存する', async () => {
    const client = { health: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as ToolApiClient;
    render(<I18nProvider initialLanguage="en"><SettingsPage client={client} /></I18nProvider>);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'ja');
    expect(await screen.findByRole('heading', { name: '実行環境設定' })).toBeTruthy();
    expect(localStorage.getItem('agentcontext.language')).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });
});

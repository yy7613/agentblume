// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { I18nProvider } from '../i18n';
import { PersonasTab } from './PersonasTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

function makeClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listPersonas: vi.fn().mockResolvedValue([]),
    savePersona: vi.fn().mockResolvedValue({ metadata: { internalId: 'novice-user', version: '1.1.0' } }),
    ...overrides,
  } as unknown as ToolApiClient;
}

// v53 F2: バージョン更新種別セレクトが日本語表示で英語の patch/minor/major のまま残っていた。
describe('PersonasTab のバージョン更新種別（日本語表示で英語のまま残さない）', () => {
  it('正常: セレクトは日本語表示になるが、保存される値は patch/minor/major のまま', async () => {
    const client = makeClient();
    render(<I18nProvider initialLanguage="ja"><PersonasTab client={client} scope={scope} /></I18nProvider>);
    const select = await screen.findByRole('combobox', { name: 'ペルソナのバージョン更新種別' }) as HTMLSelectElement;
    expect(select.value).toBe('patch');
    expect(within(select).getByRole('option', { name: 'パッチ' })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: 'patch' })).toBeNull();
    await userEvent.selectOptions(select, 'マイナー');
    expect(select.value).toBe('minor');
    await userEvent.click(screen.getByRole('button', { name: 'バージョンを保存' }));
    await waitFor(() => expect(client.savePersona).toHaveBeenCalled());
    expect((client.savePersona as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ bump: 'minor' });
  });

  it('境界: 英語表示（既定）では従来どおり patch/minor/major を表示する', async () => {
    render(<PersonasTab client={makeClient()} scope={scope} />);
    const select = await screen.findByRole('combobox', { name: 'Persona version bump' }) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'patch' })).toBeTruthy();
  });

  it('[回帰固定] 異常: 保存に失敗したらエラーを表示する（既存動作の確認）', async () => {
    const client = makeClient({ savePersona: vi.fn().mockRejectedValue(new Error('disk full')) });
    render(<PersonasTab client={client} scope={scope} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save version' }));
    expect((await screen.findByRole('alert')).textContent).toBe('disk full');
  });
});

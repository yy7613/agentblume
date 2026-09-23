// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { I18nProvider } from '../i18n';
import { ScenariosTab } from './ScenariosTab';

afterEach(cleanup);

const scope = { tenantId: 'local', workspaceId: 'default' };

function makeClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listScenarios: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ToolApiClient;
}

// v53 F2: バージョン更新種別・設問型のセレクトが日本語表示で英語のまま残っていた。
describe('ScenariosTab のバージョン更新種別・設問型（日本語表示で英語のまま残さない）', () => {
  it('正常: バージョン更新種別セレクトは日本語表示になるが、値は patch/minor/major のまま', async () => {
    render(<I18nProvider initialLanguage="ja"><ScenariosTab client={makeClient()} scope={scope} onRunCompleted={() => {}} /></I18nProvider>);
    const select = await screen.findByRole('combobox', { name: 'シナリオのバージョン更新種別' }) as HTMLSelectElement;
    expect(select.value).toBe('patch');
    expect(within(select).getByRole('option', { name: 'パッチ' })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: 'patch' })).toBeNull();
    await userEvent.selectOptions(select, 'メジャー');
    expect(select.value).toBe('major');
  });

  it('正常: 設問型（scale/boolean/text）のセレクトは日本語表示で英語のまま残らない', async () => {
    render(<I18nProvider initialLanguage="ja"><ScenariosTab client={makeClient()} scope={scope} onRunCompleted={() => {}} /></I18nProvider>);
    const kindSelect = await screen.findByRole('combobox', { name: '設問 1 型' }) as HTMLSelectElement;
    expect(kindSelect.value).toBe('boolean');
    expect(within(kindSelect).getByRole('option', { name: '尺度' })).toBeTruthy();
    expect(within(kindSelect).getByRole('option', { name: 'はい/いいえ' })).toBeTruthy();
    expect(within(kindSelect).getByRole('option', { name: '自由記述' })).toBeTruthy();
    expect(within(kindSelect).queryByRole('option', { name: 'scale' })).toBeNull();
  });

  it('境界: 英語表示（既定）では従来どおり patch/minor/major・scale/boolean/text を表示する', async () => {
    render(<ScenariosTab client={makeClient()} scope={scope} onRunCompleted={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Scenario version bump' }) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'patch' })).toBeTruthy();
    const kindSelect = screen.getByRole('combobox', { name: 'Question 1 kind' }) as HTMLSelectElement;
    expect(within(kindSelect).getByRole('option', { name: 'boolean' })).toBeTruthy();
  });

  it('[回帰固定] 異常: シナリオ一覧の取得に失敗したらエラーを表示する（既存動作の確認）', async () => {
    const client = makeClient({ listScenarios: vi.fn().mockRejectedValue(new Error('scenarios unavailable')) });
    render(<ScenariosTab client={client} scope={scope} onRunCompleted={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('scenarios unavailable');
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import { SettingsPage } from './SettingsPage';
import { I18nProvider } from '../i18n';

afterEach(() => { cleanup(); localStorage.clear(); });

const scope = { tenantId: 'local', workspaceId: 'default' };
const providers = [
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'lmstudio', name: 'LM Studio', models: ['local-model'] },
];

interface ModelApiMock {
  health: Mock;
  getModelCatalog: Mock;
  getModelSettings: Mock;
  saveModelSettings: Mock;
  testModelSettings: Mock;
  listOpenAiCompatibleModels: Mock;
}

/** SettingsPage が使う全メソッドを備えたモック（既存のhealthだけの用途も内包する）。 */
function createApi(overrides: Partial<ModelApiMock> = {}): ModelApiMock {
  return {
    health: vi.fn().mockResolvedValue({ status: 'ok' }),
    getModelCatalog: vi.fn().mockResolvedValue(providers),
    getModelSettings: vi.fn().mockResolvedValue({ scope }),
    saveModelSettings: vi.fn().mockResolvedValue({ scope }),
    testModelSettings: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12, reply: 'pong' }),
    listOpenAiCompatibleModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function renderPage(api: ModelApiMock): void {
  render(<SettingsPage client={api as unknown as ToolApiClient} />);
}

describe('SettingsPage', () => {
  it('API healthと安全ゲートを表示する', async () => {
    const api = createApi();
    renderPage(api);
    await waitFor(() => expect(api.health).toHaveBeenCalled());
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(screen.getByText(/MCP publication locked/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(api.health).toHaveBeenCalledTimes(2));
  });

  it('表示言語を日本語へ切り替えてブラウザに保存する', async () => {
    const api = createApi();
    render(<I18nProvider initialLanguage="en"><SettingsPage client={api as unknown as ToolApiClient} /></I18nProvider>);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'ja');
    expect(await screen.findByRole('heading', { name: '実行環境設定' })).toBeTruthy();
    expect(localStorage.getItem('agentcontext.language')).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    // モデルセクションも同じ言語で描画される。
    expect(screen.getAllByText('環境変数の既定（LM Studio）を使用中')).toHaveLength(2);
  });

  it('ヘルスチェック失敗時にconsole.errorへ記録し、再確認ボタンで再実行できる', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const health = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ status: 'ok' });
      renderPage(createApi({ health }));
      expect(await screen.findByText('offline')).toBeTruthy();
      expect(consoleError).toHaveBeenCalled();
      const retry = screen.getByRole('button', { name: 'Retry' });
      await userEvent.click(retry);
      await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
      expect(await screen.findByText('ok')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('SettingsPage モデル設定', () => {
  it('未設定スロットはenv既定として表示し、戻すボタンを押せなくする', async () => {
    const api = createApi();
    renderPage(api);
    await waitFor(() => expect(api.getModelSettings).toHaveBeenCalledWith(scope));
    expect(await screen.findAllByText('Using the environment default (LM Studio).')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Main model · Use env default' })).toHaveProperty('disabled', true);
    // モデル未指定なので保存も塞がっている。
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', true);
    // 未設定スロットのキー欄は環境変数名を案内する。
    expect(screen.getByLabelText('Main model · API key')).toHaveProperty('placeholder', 'Not set (env OPENAI_API_KEY also works)');
  });

  it('プロバイダとモデルを選んで保存するとapiKey省略（既存維持）のPUTになる', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'openai');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Model' }), 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({ scope, main: { source: 'registry', model: 'openai/gpt-4o' } }));
    expect(await screen.findByText('Saved: openai/gpt-4o (key: not set)')).toBeTruthy();
  });

  it('カタログに無いモデルは「手入力」に切り替えて指定できる', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-5-preview', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Model' }), '__manual__');
    await userEvent.type(screen.getByRole('textbox', { name: 'Main model · Model name' }), 'gpt-5-preview');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({ scope, main: { source: 'registry', model: 'openai/gpt-5-preview' } }));
    // 保存済みモデルがカタログに無いので、再読込後も手入力欄のまま復元される。
    expect(await screen.findByRole('textbox', { name: 'Main model · Model name' })).toHaveProperty('value', 'gpt-5-preview');
  });

  it('APIキーは平文で送られ、保存後に入力欄をクリアしてマスクサマリへ置き換える', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Model' }), 'gpt-4o');
    const key = screen.getByLabelText('Main model · API key');
    await userEvent.type(key, 'sk-secret-cdef');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-secret-cdef' },
    }));
    expect(await screen.findByText('Saved: openai/gpt-4o (key: …cdef)')).toBeTruthy();
    expect(key).toHaveProperty('value', '');
    expect(screen.getByLabelText('Main model · API key')).toHaveProperty('placeholder', 'Saved: …cdef (leave blank to keep)');
  });

  it('「保存済みキーを削除」を選ぶと空文字を送ってキーを消す', async () => {
    const stored = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({
      getModelSettings: vi.fn().mockResolvedValue(stored),
      saveModelSettings: vi.fn().mockResolvedValue({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' }),
    });
    renderPage(api);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Main model · Remove the saved key' }));
    expect(screen.getByLabelText('Main model · API key')).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: '' },
    }));
    expect(await screen.findByText('Saved: openai/gpt-4o (key: not set)')).toBeTruthy();
  });

  it('テストは入力済みならcandidate付き、未入力なら保存済み設定で実行する', async () => {
    const api = createApi({ testModelSettings: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1234, reply: 'pong' }) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Model' }), 'gpt-4o-mini');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'main', { source: 'registry', model: 'openai/gpt-4o-mini' }));
    expect(await screen.findByText('ok (1234ms): pong')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'judge', undefined));
  });

  it('env既定に戻すとスロットnullでPUTする', async () => {
    const stored = { scope, judge: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ getModelSettings: vi.fn().mockResolvedValue(stored), saveModelSettings: vi.fn().mockResolvedValue({ scope }) });
    renderPage(api);

    await userEvent.click(await screen.findByRole('button', { name: 'Judge model · Use env default' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({ scope, judge: null }));
    expect(await screen.findByText('Reverted to the environment default.')).toBeTruthy();
    expect(await screen.findAllByText('Using the environment default (LM Studio).')).toHaveLength(2);
  });

  it('OpenAI互換はモデル一覧を取得してselectから選べる', async () => {
    const api = createApi({
      listOpenAiCompatibleModels: vi.fn().mockResolvedValue(['gemma-3', 'qwen/qwen3-4b']),
      saveModelSettings: vi.fn().mockResolvedValue({ scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b', apiKey: { configured: false } }, updatedAt: 'now' }),
    });
    renderPage(api);

    await userEvent.click(await screen.findByRole('radio', { name: 'Judge model · OpenAI-compatible endpoint' }));
    // 一覧取得前はベースURLが空なので取得ボタンは押せない。
    expect(screen.getByRole('button', { name: 'Judge model · Fetch model list' })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Judge model · Base URL' }), 'http://127.0.0.1:1234/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Fetch model list' }));

    await waitFor(() => expect(api.listOpenAiCompatibleModels).toHaveBeenCalledWith(scope, 'http://127.0.0.1:1234/v1', 'judge'));
    expect(await screen.findByText('Fetched 2 model(s).')).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Judge model · Model' }), 'qwen/qwen3-4b');
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' },
    }));
    expect(await screen.findByText('Saved: qwen/qwen3-4b @ http://127.0.0.1:1234/v1 (key: not set)')).toBeTruthy();
  });

  it('モデル一覧の取得が失敗・0件でもエラーを出して手入力を続けられる', async () => {
    const api = createApi({
      listOpenAiCompatibleModels: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('connect ECONNREFUSED')),
    });
    renderPage(api);

    await userEvent.click(await screen.findByRole('radio', { name: 'Main model · OpenAI-compatible endpoint' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Main model · Base URL' }), 'http://127.0.0.1:1234/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));
    expect(await screen.findByText('The endpoint returned no models.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));
    expect(await screen.findByText('connect ECONNREFUSED')).toBeTruthy();
    // 一覧が取れなくてもモデル名は手入力できる。
    await userEvent.type(screen.getByRole('textbox', { name: 'Main model · Model name' }), 'qwen');
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', false);

    // レジストリへ戻すと入力欄もレジストリ用に切り替わる。
    await userEvent.click(screen.getByRole('radio', { name: 'Main model · Provider registry' }));
    expect(screen.getByRole('combobox', { name: 'Main model · Provider' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Main model · Base URL' })).toBeNull();
  });

  it('疎通テストの失敗と409（鍵の変更）をインラインで表示する', async () => {
    const api = createApi({
      testModelSettings: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401 from provider' }),
      saveModelSettings: vi.fn().mockRejectedValue(new ApiError(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted with the current key file.')),
    });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Model' }), 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    expect(await screen.findByText('HTTP 401 from provider')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));
    expect(await screen.findByText('The encryption key changed. Enter the API key again, then save.')).toBeTruthy();
  });

  it('設定の読み込みに失敗したらセクション先頭にエラーを出す', async () => {
    const api = createApi({ getModelSettings: vi.fn().mockRejectedValue(new Error('API offline')) });
    renderPage(api);
    expect(await screen.findByText('API offline')).toBeTruthy();
    // 読み込めなくても既存セクションは表示され続ける。
    expect(screen.getByText(/MCP publication locked/)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import { SettingsPage } from './SettingsPage';
import { I18nProvider } from '../i18n';

afterEach(() => { cleanup(); localStorage.clear(); });

const scope = { tenantId: 'local', workspaceId: 'default' };
// v36のカタログ見出しはモデル一覧を持たない（modelCountのみ）。name昇順なので先頭は 302ai。
const providers = [
  { id: '302ai', name: '302.AI', envVar: 'AI302_API_KEY', modelCount: 3 },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', modelCount: 2 },
  { id: 'lmstudio', name: 'LM Studio', modelCount: 1 },
];
const modelsByProvider: Readonly<Record<string, readonly string[]>> = {
  '302ai': ['gpt-4o-302', 'llama-302'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  lmstudio: ['local-model'],
};

interface ModelApiMock {
  health: Mock;
  getModelCatalog: Mock;
  getProviderModels: Mock;
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
    getProviderModels: vi.fn().mockImplementation((providerId: string) => Promise.resolve(modelsByProvider[providerId] ?? [])),
    getModelSettings: vi.fn().mockResolvedValue({ scope }),
    saveModelSettings: vi.fn().mockResolvedValue({ scope }),
    testModelSettings: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12, reply: 'pong', usedStoredKey: false }),
    listOpenAiCompatibleModels: vi.fn().mockResolvedValue({ models: [], usedStoredKey: false }),
    ...overrides,
  };
}

function renderPage(api: ModelApiMock): void {
  render(<SettingsPage client={api as unknown as ToolApiClient} />);
}

/** モデル一覧はプロバイダ選択後に非同期で届くので、選択肢が生えるまで待ってから選ぶ。 */
async function selectModel(slot: string, model: string): Promise<HTMLElement> {
  const select = await screen.findByRole('combobox', { name: `${slot} · Model` });
  await waitFor(() => expect(within(select).getByRole('option', { name: model })).toBeTruthy());
  await userEvent.selectOptions(select, model);
  return select;
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
    await waitFor(() => expect(api.getModelSettings).toHaveBeenCalledWith(scope, expect.anything()));
    expect(await screen.findAllByText('Using the environment default (LM Studio).')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Main model · Use env default' })).toHaveProperty('disabled', true);
    // モデル未指定なので保存も塞がっている。
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', true);
    // 未設定スロットのキー欄は環境変数名を案内する。
    expect(screen.getByLabelText('Main model · API key')).toHaveProperty('placeholder', 'Not set (env OPENAI_API_KEY also works)');
    // パスワードマネージャの誤保存を防ぐ。
    expect(screen.getByLabelText('Main model · API key')).toHaveProperty('autocomplete', 'new-password');
  });

  it('既定プロバイダは name昇順の先頭(302ai)ではなく openai を選ぶ', async () => {
    const api = createApi();
    renderPage(api);
    expect(await screen.findByRole('combobox', { name: 'Main model · Provider' })).toHaveProperty('value', 'openai');
    // モデル一覧はプロバイダを選んだ時点で個別に取得する（カタログ見出しには含まれない）。
    await waitFor(() => expect(api.getProviderModels).toHaveBeenCalledWith('openai', expect.anything()));
    // main / judge の両方に候補が並ぶが、同じプロバイダなので取得は1回だけ。
    expect(await screen.findAllByRole('option', { name: 'gpt-4o-mini' })).toHaveLength(2);
    expect(api.getProviderModels.mock.calls.filter((call) => call[0] === 'openai')).toHaveLength(1);
  });

  it('プロバイダを切り替えるとその一覧を取得し、同じプロバイダへ戻ると再取得しない', async () => {
    const api = createApi();
    renderPage(api);
    const provider = await screen.findByRole('combobox', { name: 'Main model · Provider' });
    await waitFor(() => expect(api.getProviderModels).toHaveBeenCalledWith('openai', expect.anything()));
    const main = screen.getByRole('combobox', { name: 'Main model · Model' });

    await userEvent.selectOptions(provider, '302ai');
    await waitFor(() => expect(within(main).getByRole('option', { name: 'llama-302' })).toBeTruthy());

    const callsBefore = api.getProviderModels.mock.calls.length;
    await userEvent.selectOptions(provider, 'openai');
    await waitFor(() => expect(within(main).getByRole('option', { name: 'gpt-4o-mini' })).toBeTruthy());
    // キャッシュ済みなので再取得は起きない。
    expect(api.getProviderModels.mock.calls.length).toBe(callsBefore);
  });

  it('モデル一覧の取得に失敗しても手入力でモデルを指定できる', async () => {
    const api = createApi({ getProviderModels: vi.fn().mockRejectedValue(new Error('catalog offline')) });
    renderPage(api);
    // main / judge それぞれのスロットに出る。
    expect(await screen.findAllByText(/Could not load this provider/)).toHaveLength(2);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Model' }), '__manual__');
    await userEvent.type(screen.getByRole('textbox', { name: 'Main model · Model name' }), 'gpt-4o');
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', false);
  });

  it('プロバイダとモデルを選んで保存するとapiKey省略（既存維持）のPUTになる', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'openai');
    await selectModel('Main model', 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({ scope, main: { source: 'registry', model: 'openai/gpt-4o' } }));
    expect(await screen.findByText('Saved: openai/gpt-4o (key: not set)')).toBeTruthy();
    // 保存後もキャッシュ済みの一覧が復元される（選択肢が消えない）。
    expect(screen.getByRole('combobox', { name: 'Main model · Model' })).toHaveProperty('value', 'gpt-4o');
  });

  it('カタログに無いモデルは「手入力」に切り替えて指定できる', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-5-preview', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await selectModel('Main model', 'Enter manually');
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

    await selectModel('Main model', 'gpt-4o');
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

  it('テストは入力済みならcandidate付き、未編集なら保存済み設定で実行する', async () => {
    const api = createApi({ testModelSettings: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1234, reply: 'pong', usedStoredKey: true }) });
    renderPage(api);

    await selectModel('Main model', 'gpt-4o-mini');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'main', { source: 'registry', model: 'openai/gpt-4o-mini' }, expect.anything()));
    expect(await screen.findByText('ok (1234ms): pong')).toBeTruthy();

    // judge は未編集なので「保存済み設定（ここではenv既定）をテストする」と明示した上で実行できる。
    expect(screen.getByText('Tests the environment default (this slot is unset).')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'judge', undefined, expect.anything()));
  });

  it('編集済みなのに候補を送れないフォームではテストボタンを塞ぐ（嘘の成功を防ぐ）', async () => {
    const stored = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({ getModelSettings: vi.fn().mockResolvedValue(stored) });
    renderPage(api);

    // 保存済みと同じ入力ならテストできる。
    const test = await screen.findByRole('button', { name: 'Main model · Test' });
    await waitFor(() => expect(test).toHaveProperty('disabled', false));

    // プロバイダだけ変えるとモデルが未選択になり、候補として送れない = 保存済みLM Studioが ok を返す状態。
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Provider' }), 'lmstudio');
    expect(screen.getByRole('button', { name: 'Main model · Test' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Finish the model selection to test it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main model · Test' }).getAttribute('title')).toContain('Finish the model selection');
    expect(api.testModelSettings).not.toHaveBeenCalled();

    // モデルを選べば候補として送れる。
    await selectModel('Main model', 'local-model');
    expect(screen.getByRole('button', { name: 'Main model · Test' })).toHaveProperty('disabled', false);
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'main', { source: 'registry', model: 'lmstudio/local-model' }, expect.anything()));
  });

  it('保存済みキーが宛先違いで使われなかったことを注記する', async () => {
    const stored = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({
      getModelSettings: vi.fn().mockResolvedValue(stored),
      testModelSettings: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401', usedStoredKey: false }),
    });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'lmstudio');
    await selectModel('Main model', 'local-model');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));

    expect(await screen.findByText(/The saved API key was not used/)).toBeTruthy();
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

  it('OpenAI互換はモデル一覧をPOSTで取得してselectから選べる', async () => {
    const api = createApi({
      listOpenAiCompatibleModels: vi.fn().mockResolvedValue({ models: ['gemma-3', 'qwen/qwen3-4b'], usedStoredKey: false }),
      saveModelSettings: vi.fn().mockResolvedValue({ scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b', apiKey: { configured: false } }, updatedAt: 'now' }),
    });
    renderPage(api);

    await userEvent.click(await screen.findByRole('radio', { name: 'Judge model · OpenAI-compatible endpoint' }));
    // OpenAI互換では登録簿の envVar を案内しない（宛先が別サーバーなので誤誘導になる）。
    expect(screen.getByLabelText('Judge model · API key')).toHaveProperty('placeholder', 'Not set (env LM_STUDIO_API_KEY also works)');
    // 一覧取得前はベースURLが空なので取得ボタンは押せない。
    expect(screen.getByRole('button', { name: 'Judge model · Fetch model list' })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Judge model · Base URL' }), 'http://127.0.0.1:1234/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Fetch model list' }));

    await waitFor(() => expect(api.listOpenAiCompatibleModels).toHaveBeenCalledWith(scope, 'http://127.0.0.1:1234/v1', 'judge', expect.anything()));
    expect(await screen.findByText('Fetched 2 model(s).')).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Judge model · Model' }), 'qwen/qwen3-4b');
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' },
    }));
    expect(await screen.findByText('Saved: qwen/qwen3-4b @ http://127.0.0.1:1234/v1 (key: not set)')).toBeTruthy();
  });

  it('取得中にベースURLを変えたら古い応答を捨てる', async () => {
    let release: (value: { models: string[]; usedStoredKey: boolean }) => void = () => {};
    const pending = new Promise<{ models: string[]; usedStoredKey: boolean }>((resolve) => { release = resolve; });
    const api = createApi({ listOpenAiCompatibleModels: vi.fn().mockReturnValue(pending) });
    renderPage(api);

    await userEvent.click(await screen.findByRole('radio', { name: 'Main model · OpenAI-compatible endpoint' }));
    const baseUrl = screen.getByRole('textbox', { name: 'Main model · Base URL' });
    await userEvent.type(baseUrl, 'http://127.0.0.1:1234/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));

    // 応答を待つ間に宛先を変更する（入力は非同期処理中も止めない）。
    await userEvent.type(baseUrl, '2');
    release({ models: ['stale-model'], usedStoredKey: false });

    expect(await screen.findByText(/the fetched list was discarded/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'stale-model' })).toBeNull();
    // 打鍵は巻き戻らない。
    expect(baseUrl).toHaveProperty('value', 'http://127.0.0.1:1234/v12');
  });

  it('モデル一覧の取得が失敗・0件でもエラーを出して手入力を続けられる', async () => {
    const api = createApi({
      listOpenAiCompatibleModels: vi.fn()
        .mockResolvedValueOnce({ models: [], usedStoredKey: false })
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED')),
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
      testModelSettings: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401 from provider', usedStoredKey: false }),
      saveModelSettings: vi.fn().mockRejectedValue(new ApiError(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted with the current key file.')),
    });
    renderPage(api);

    await selectModel('Main model', 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    const failure = await screen.findByText('HTTP 401 from provider');
    expect(failure.getAttribute('role')).toBe('alert');

    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));
    expect(await screen.findByText('The saved API key could not be decrypted. Enter the API key again, then save.')).toBeTruthy();
  });

  it('鍵ファイル不正（500）は再入力では直らない旨を出す', async () => {
    const api = createApi({
      saveModelSettings: vi.fn().mockRejectedValue(new ApiError(500, 'SECRET_CIPHER', 'Secret key file is unreadable')),
    });
    renderPage(api);

    await selectModel('Main model', 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));
    expect(await screen.findByText(/AGENTCONTEXT_SECRET_KEY_PATH/)).toBeTruthy();
  });

  it('揮発ストレージなら再起動で消える旨を警告し、保存後も出し続ける', async () => {
    const api = createApi({
      getModelSettings: vi.fn().mockResolvedValue({ scope, storage: 'ephemeral' }),
      saveModelSettings: vi.fn().mockResolvedValue({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' }),
    });
    renderPage(api);

    expect(await screen.findByText(/ephemeral storage/)).toBeTruthy();

    // PUT の応答には storage が付かないので、保存しても警告が消えてはいけない。
    await selectModel('Main model', 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));
    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalled());
    expect(screen.getByText(/ephemeral storage/)).toBeTruthy();
  });

  it('永続ストレージなら警告を出さない', async () => {
    const api = createApi({ getModelSettings: vi.fn().mockResolvedValue({ scope, storage: 'persistent' }) });
    renderPage(api);
    await waitFor(() => expect(api.getModelSettings).toHaveBeenCalled());
    expect(screen.queryByText(/ephemeral storage/)).toBeNull();
  });

  it('設定の読み込みに失敗したらセクション先頭にエラーを出す', async () => {
    const api = createApi({ getModelSettings: vi.fn().mockRejectedValue(new Error('API offline')) });
    renderPage(api);
    const failure = await screen.findByText('API offline');
    expect(failure.getAttribute('role')).toBe('alert');
    // 読み込めなくても既存セクションは表示され続ける。
    expect(screen.getByText(/MCP publication locked/)).toBeTruthy();
  });
});

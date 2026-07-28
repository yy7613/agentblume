// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import { SettingsPage } from './SettingsPage';
import { I18nProvider } from '../i18n';

afterEach(() => { cleanup(); localStorage.clear(); });

const scope = { tenantId: 'local', workspaceId: 'default' };
// カタログは主要プロバイダの見出しだけを返す（モデル名は含まない）。
const providers = [
  { id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY', docUrl: 'https://platform.openai.com/docs/models' },
  { id: 'anthropic', name: 'Anthropic', source: 'registry', envVar: 'ANTHROPIC_API_KEY' },
  {
    id: 'azure-ai-foundry', name: 'Microsoft Azure AI Foundry', source: 'openai-compatible',
    baseUrlTemplate: 'https://<resource>.services.ai.azure.com/openai/v1', baseUrlHosts: ['.services.ai.azure.com'],
  },
  { id: 'openai-compatible', name: 'OpenAI-compatible endpoint', source: 'openai-compatible', baseUrlTemplate: 'http://127.0.0.1:1234/v1' },
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
    testModelSettings: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12, reply: 'pong', usedStoredKey: false }),
    listOpenAiCompatibleModels: vi.fn().mockResolvedValue({ models: [], usedStoredKey: false }),
    ...overrides,
  };
}

function renderPage(api: ModelApiMock): void {
  render(<SettingsPage client={api as unknown as ToolApiClient} />);
}

/** モデルは常に手入力（候補一覧は出さない）。 */
async function typeModel(slot: string, model: string): Promise<HTMLElement> {
  const input = await screen.findByLabelText(`${slot} · Model ID / deployment name`);
  await userEvent.type(input, model);
  return input;
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

  it('プロバイダは主要どころだけを出し、既定は openai を選ぶ', async () => {
    const api = createApi();
    renderPage(api);
    const provider = await screen.findByRole('combobox', { name: 'Main model · Provider' });
    expect(provider).toHaveProperty('value', 'openai');
    expect(within(provider).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'OpenAI · OPENAI_API_KEY', 'Anthropic · ANTHROPIC_API_KEY', 'Microsoft Azure AI Foundry', 'OpenAI-compatible endpoint (LM Studio, vLLM, …)',
    ]);
    // モデル名の候補は一切出さない（固定値は陳腐化し、デプロイ済みのものしか使えないため）。
    expect(screen.queryByRole('combobox', { name: 'Main model · Model ID / deployment name' })).toBeNull();
    expect(screen.getAllByText(/only models you have deployed or enabled/)).toHaveLength(2);
    // 一次情報への導線だけ出す。
    expect(screen.getAllByRole('link', { name: 'OpenAI model list' })[0]?.getAttribute('href')).toBe('https://platform.openai.com/docs/models');
  });

  it('モデルIDを手入力して保存するとapiKey省略（既存維持）のPUTになる', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'openai');
    await typeModel('Main model', 'gpt-4o');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({ scope, main: { source: 'registry', model: 'openai/gpt-4o' } }));
    expect(await screen.findByText('Saved: openai/gpt-4o (key: not set)')).toBeTruthy();
    // 保存後は応答の値がそのまま入力欄へ戻る。
    expect(screen.getByLabelText('Main model · Model ID / deployment name')).toHaveProperty('value', 'gpt-4o');
  });

  it('プロバイダを変えるとモデル入力を引き継がない（別プロバイダのモデル名を保存させない）', async () => {
    const api = createApi();
    renderPage(api);

    await typeModel('Main model', 'gpt-4o');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Provider' }), 'anthropic');

    expect(screen.getByLabelText('Main model · Model ID / deployment name')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', true);
  });

  it('カタログを絞る前に保存したプロバイダは選択肢に残す', async () => {
    const stored = { scope, main: { source: 'registry', model: 'openrouter/qwen3', apiKey: { configured: false } }, updatedAt: 'now' };
    const api = createApi({ getModelSettings: vi.fn().mockResolvedValue(stored) });
    renderPage(api);

    const provider = await screen.findByRole('combobox', { name: 'Main model · Provider' });
    await waitFor(() => expect(provider).toHaveProperty('value', 'openrouter'));
    expect(screen.getByLabelText('Main model · Model ID / deployment name')).toHaveProperty('value', 'qwen3');
    // judge 側（未設定）には足さない。
    expect(within(screen.getByRole('combobox', { name: 'Judge model · Provider' })).queryByRole('option', { name: 'openrouter' })).toBeNull();
  });

  it('APIキーは平文で送られ、保存後に入力欄をクリアしてマスクサマリへ置き換える', async () => {
    const saved = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({ saveModelSettings: vi.fn().mockResolvedValue(saved) });
    renderPage(api);

    await typeModel('Main model', 'gpt-4o');
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

    await typeModel('Main model', 'gpt-4o-mini');
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

    // プロバイダだけ変えるとモデルが未入力になり、候補として送れない = 保存済みLM Studioが ok を返す状態。
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Provider' }), 'anthropic');
    expect(screen.getByRole('button', { name: 'Main model · Test' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Fill in the model \(and the base URL\) to test it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main model · Test' }).getAttribute('title')).toContain('Fill in the model');
    expect(api.testModelSettings).not.toHaveBeenCalled();

    // モデルを入れれば候補として送れる。
    await typeModel('Main model', 'claude-sonnet');
    expect(screen.getByRole('button', { name: 'Main model · Test' })).toHaveProperty('disabled', false);
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Test' }));
    await waitFor(() => expect(api.testModelSettings).toHaveBeenCalledWith(scope, 'main', { source: 'registry', model: 'anthropic/claude-sonnet' }, expect.anything()));
  });

  it('保存済みキーが宛先違いで使われなかったことを注記する', async () => {
    const stored = { scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'cdef' } }, updatedAt: 'now' };
    const api = createApi({
      getModelSettings: vi.fn().mockResolvedValue(stored),
      testModelSettings: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401', usedStoredKey: false }),
    });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'anthropic');
    await typeModel('Main model', 'claude-sonnet');
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

  it('OpenAI互換は実エンドポイントへ問い合わせた候補だけを補完に出す', async () => {
    const api = createApi({
      listOpenAiCompatibleModels: vi.fn().mockResolvedValue({ models: ['gemma-3', 'qwen/qwen3-4b'], usedStoredKey: false }),
      saveModelSettings: vi.fn().mockResolvedValue({ scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-3', apiKey: { configured: false } }, updatedAt: 'now' }),
    });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Judge model · Provider' }), 'openai-compatible');
    // OpenAI互換では特定の環境変数を案内しない（宛先がローカルにもクラウドにもなり得る）。
    expect(screen.getByLabelText('Judge model · API key')).toHaveProperty('placeholder', 'Not set (leave blank if the endpoint needs no key)');
    // ベースURLは雛形が入った状態で始まる（ローカルの既定値はそのまま使える）。
    expect(screen.getByLabelText('Judge model · Base URL')).toHaveProperty('value', 'http://127.0.0.1:1234/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Fetch model list' }));

    await waitFor(() => expect(api.listOpenAiCompatibleModels).toHaveBeenCalledWith(scope, 'http://127.0.0.1:1234/v1', 'judge', expect.anything()));
    expect(await screen.findByText('Fetched 2 model(s).')).toBeTruthy();
    // 空欄だったので先頭が入り、候補は datalist として添えられる。
    const model = screen.getByLabelText('Judge model · Model ID / deployment name');
    expect(model).toHaveProperty('value', 'gemma-3');
    expect(document.querySelectorAll('#model-options-judge option')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Judge model · Save' }));

    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-3' },
    }));
    expect(await screen.findByText('Saved: gemma-3 @ http://127.0.0.1:1234/v1 (key: not set)')).toBeTruthy();
  });

  it('クラウドのプリセットはベースURLの雛形を入れ、穴が残る間は保存・取得を塞ぐ', async () => {
    const api = createApi();
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'azure-ai-foundry');
    const baseUrl = screen.getByLabelText('Main model · Base URL');
    expect(baseUrl).toHaveProperty('value', 'https://<resource>.services.ai.azure.com/openai/v1');
    await userEvent.type(screen.getByLabelText('Main model · Model ID / deployment name'), 'my-deployment');
    // 雛形のまま送ると 400 になるだけなので、ここで止めて置き換えを促す。
    expect(screen.getByText(/Replace the <…> parts/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Main model · Fetch model list' })).toHaveProperty('disabled', true);

    await userEvent.clear(baseUrl);
    await userEvent.type(baseUrl, 'https://contoso.services.ai.azure.com/openai/v1');
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', false);
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Save' }));
    await waitFor(() => expect(api.saveModelSettings).toHaveBeenCalledWith({
      scope, main: { source: 'openai-compatible', baseUrl: 'https://contoso.services.ai.azure.com/openai/v1', model: 'my-deployment' },
    }));
  });

  it('取得中にベースURLを変えたら古い応答を捨てる', async () => {
    let release: (value: { models: string[]; usedStoredKey: boolean }) => void = () => {};
    const pending = new Promise<{ models: string[]; usedStoredKey: boolean }>((resolve) => { release = resolve; });
    const api = createApi({ listOpenAiCompatibleModels: vi.fn().mockReturnValue(pending) });
    renderPage(api);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'openai-compatible');
    const baseUrl = screen.getByLabelText('Main model · Base URL');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));

    // 応答を待つ間に宛先を変更する（入力は非同期処理中も止めない）。
    await userEvent.type(baseUrl, '2');
    release({ models: ['stale-model'], usedStoredKey: false });

    expect(await screen.findByText(/the fetched list was discarded/)).toBeTruthy();
    expect(document.querySelector('#model-options-main')).toBeNull();
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

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Main model · Provider' }), 'openai-compatible');
    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));
    expect(await screen.findByText('The endpoint returned no models.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Main model · Fetch model list' }));
    expect(await screen.findByText('connect ECONNREFUSED')).toBeTruthy();
    // 一覧が取れなくてもモデル名は手入力できる。
    await userEvent.type(screen.getByLabelText('Main model · Model ID / deployment name'), 'qwen');
    expect(screen.getByRole('button', { name: 'Main model · Save' })).toHaveProperty('disabled', false);

    // レジストリのプロバイダへ戻すとベースURL欄は消える。
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Main model · Provider' }), 'openai');
    expect(screen.queryByLabelText('Main model · Base URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Main model · Fetch model list' })).toBeNull();
  });

  it('疎通テストの失敗と409（鍵の変更）をインラインで表示する', async () => {
    const api = createApi({
      testModelSettings: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401 from provider', usedStoredKey: false }),
      saveModelSettings: vi.fn().mockRejectedValue(new ApiError(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted with the current key file.')),
    });
    renderPage(api);

    await typeModel('Main model', 'gpt-4o');
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

    await typeModel('Main model', 'gpt-4o');
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
    await typeModel('Main model', 'gpt-4o');
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

import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ModelCatalogProviderDto, ModelSettingsDto, ModelSlotNameDto } from '../api/types';
import { useI18n } from '../i18n';
import {
  EMPTY_MODEL_SLOT_FORM, MANUAL_MODEL_OPTION, apiKeyPlaceholder, applyFetchedModels, modelChoiceSelectValue,
  modelSettingsErrorText, modelSlotSaveBlocked, modelSlotSummary, modelTestSummary, providerModels,
  providerOptionLabel, selectModelChoice, toModelSlotForm, toModelSlotInput, withProvider,
  type ModelSlotFormValue,
} from './model-settings-form';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

interface SlotFeedback { readonly kind: 'ok' | 'error'; readonly message: string }
type SlotForms = Readonly<Record<ModelSlotNameDto, ModelSlotFormValue>>;

/**
 * モデル設定（main / judge）。2スロットを同じフォームで扱う。
 *
 * **平文APIキーをこの画面が持つのは入力欄の state だけ**である。保存に成功したら入力欄を捨てて
 * マスク済みサマリを再取得し、以後は `…abcd` のヒントしか画面に残らない。
 */
function ModelSettingsSection({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [providers, setProviders] = useState<readonly ModelCatalogProviderDto[]>([]);
  const [settings, setSettings] = useState<ModelSettingsDto>();
  const [forms, setForms] = useState<SlotForms>({ main: EMPTY_MODEL_SLOT_FORM, judge: EMPTY_MODEL_SLOT_FORM });
  const [feedback, setFeedback] = useState<Readonly<Partial<Record<ModelSlotNameDto, SlotFeedback>>>>({});
  const [busy, setBusy] = useState(false);
  // 読み込み失敗は原因のまま持ち、表示時にローカライズする（言語切替で再取得しないため）。
  const [loadFailure, setLoadFailure] = useState<unknown>();

  const load = useCallback(async () => {
    try {
      const [catalog, saved] = await Promise.all([client.getModelCatalog(), client.getModelSettings(scope)]);
      setProviders(catalog);
      setSettings(saved);
      setForms({ main: toModelSlotForm(saved.main, catalog), judge: toModelSlotForm(saved.judge, catalog) });
    } catch (cause) { setLoadFailure(cause); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  function replaceForm(slot: ModelSlotNameDto, next: ModelSlotFormValue): void {
    setForms((current) => ({ ...current, [slot]: next }));
  }
  function updateForm(slot: ModelSlotNameDto, patch: Partial<ModelSlotFormValue>): void {
    setForms((current) => ({ ...current, [slot]: { ...current[slot], ...patch } }));
  }
  function note(slot: ModelSlotNameDto, value: SlotFeedback | undefined): void {
    setFeedback((current) => ({ ...current, [slot]: value }));
  }

  /** テスト・保存中は全スロットを busy にする（同じ設定を並行更新させない）。 */
  async function runAction(slot: ModelSlotNameDto, action: () => Promise<SlotFeedback>): Promise<void> {
    setBusy(true);
    note(slot, undefined);
    try { note(slot, await action()); }
    catch (cause) { note(slot, { kind: 'error', message: modelSettingsErrorText(cause, text) }); }
    finally { setBusy(false); }
  }

  /** 保存前のフォーム値で試す。未入力（保存できない状態）のときだけ candidate を省き、保存済み/env既定を試す。 */
  async function testSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const form = forms[slot];
      const candidate = modelSlotSaveBlocked(form) ? undefined : toModelSlotInput(form);
      const result = await client.testModelSettings(scope, slot, candidate);
      return { kind: result.ok ? 'ok' : 'error', message: modelTestSummary(result, text) };
    });
  }

  async function saveSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const value = toModelSlotInput(forms[slot]);
      const saved = await client.saveModelSettings(slot === 'main' ? { scope, main: value } : { scope, judge: value });
      setSettings(saved);
      replaceForm(slot, toModelSlotForm(saved[slot], providers));
      return { kind: 'ok', message: text('Saved. The API key field was cleared.', '保存しました。APIキー欄はクリアしました。') };
    });
  }

  async function resetSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const saved = await client.saveModelSettings(slot === 'main' ? { scope, main: null } : { scope, judge: null });
      setSettings(saved);
      replaceForm(slot, toModelSlotForm(saved[slot], providers));
      return { kind: 'ok', message: text('Reverted to the environment default.', '環境変数の既定に戻しました。') };
    });
  }

  /** 保存済みキーが要るエンドポイントもあるので slot を渡す（キーはクエリに載せない）。 */
  async function fetchModels(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const form = forms[slot];
      const models = await client.listOpenAiCompatibleModels(scope, form.baseUrl.trim(), slot);
      replaceForm(slot, applyFetchedModels(form, models));
      return models.length === 0
        ? { kind: 'error', message: text('The endpoint returned no models.', 'モデルを取得できませんでした。') }
        : { kind: 'ok', message: text(`Fetched ${models.length} model(s).`, `モデルを${models.length}件取得しました。`) };
    });
  }

  function renderSlot(slot: ModelSlotNameDto, title: string) {
    const form = forms[slot];
    const saved = settings?.[slot];
    const provider = providers.find((candidate) => candidate.id === form.providerId);
    const result = feedback[slot];
    const label = (field: string): string => `${title} · ${field}`;
    return <article className="model-slot" key={slot}>
      <header><h3>{title}</h3><code>{slot}</code></header>
      <p className="model-slot-summary">{modelSlotSummary(saved, text)}</p>
      <fieldset className="model-source-kind">
        <legend>{text('Source', 'ソース')}</legend>
        <label>
          <input type="radio" name={`model-source-${slot}`} aria-label={label(text('Provider registry', 'プロバイダレジストリ'))}
            checked={form.source === 'registry'} onChange={() => updateForm(slot, { source: 'registry' })} />
          {text('Provider registry', 'プロバイダレジストリ')}
        </label>
        <label>
          <input type="radio" name={`model-source-${slot}`} aria-label={label(text('OpenAI-compatible endpoint', 'OpenAI互換エンドポイント'))}
            checked={form.source === 'openai-compatible'} onChange={() => updateForm(slot, { source: 'openai-compatible' })} />
          {text('OpenAI-compatible endpoint', 'OpenAI互換エンドポイント')}
        </label>
      </fieldset>
      {form.source === 'registry' ? <>
        <label>{text('Provider', 'プロバイダ')}
          <select aria-label={label(text('Provider', 'プロバイダ'))} value={form.providerId}
            onChange={(event) => replaceForm(slot, withProvider(form, event.target.value))}>
            {providers.map((entry) => <option key={entry.id} value={entry.id}>{providerOptionLabel(entry)}</option>)}
          </select>
        </label>
        <label>{text('Model', 'モデル')}
          <select aria-label={label(text('Model', 'モデル'))} value={modelChoiceSelectValue(form.registryModel)}
            onChange={(event) => updateForm(slot, { registryModel: selectModelChoice(form.registryModel, event.target.value) })}>
            <option value="">{text('Select a model', 'モデルを選択')}</option>
            {providerModels(providers, form.providerId).map((model) => <option key={model} value={model}>{model}</option>)}
            <option value={MANUAL_MODEL_OPTION}>{text('Enter manually', '手入力')}</option>
          </select>
        </label>
        {form.registryModel.manual && <label>{text('Model name', 'モデル名')}
          <input aria-label={label(text('Model name', 'モデル名'))} value={form.registryModel.value} placeholder="gpt-4o"
            onChange={(event) => updateForm(slot, { registryModel: { value: event.target.value, manual: true } })} />
        </label>}
      </> : <>
        <label>{text('Base URL', 'ベースURL')}
          <input aria-label={label(text('Base URL', 'ベースURL'))} value={form.baseUrl} placeholder="http://127.0.0.1:1234/v1"
            onChange={(event) => updateForm(slot, { baseUrl: event.target.value })} />
        </label>
        <button type="button" className="secondary" aria-label={label(text('Fetch model list', 'モデル一覧を取得'))}
          disabled={busy || form.baseUrl.trim() === ''} onClick={() => void fetchModels(slot)}>{text('Fetch model list', 'モデル一覧を取得')}</button>
        {form.compatModels.length > 0 && <label>{text('Model', 'モデル')}
          <select aria-label={label(text('Model', 'モデル'))} value={modelChoiceSelectValue(form.compatModel)}
            onChange={(event) => updateForm(slot, { compatModel: selectModelChoice(form.compatModel, event.target.value) })}>
            {form.compatModels.map((model) => <option key={model} value={model}>{model}</option>)}
            <option value={MANUAL_MODEL_OPTION}>{text('Enter manually', '手入力')}</option>
          </select>
        </label>}
        {(form.compatModels.length === 0 || form.compatModel.manual) && <label>{text('Model name', 'モデル名')}
          <input aria-label={label(text('Model name', 'モデル名'))} value={form.compatModel.value} placeholder="qwen/qwen3-4b"
            onChange={(event) => updateForm(slot, { compatModel: { value: event.target.value, manual: form.compatModels.length > 0 } })} />
        </label>}
      </>}
      <label>{text('API key', 'APIキー')}
        <input type="password" aria-label={label(text('API key', 'APIキー'))} value={form.apiKey} disabled={form.clearKey}
          placeholder={apiKeyPlaceholder(saved, provider, text)} onChange={(event) => updateForm(slot, { apiKey: event.target.value })} />
      </label>
      <label className="structured-output-toggle">
        <input type="checkbox" aria-label={label(text('Remove the saved key', '保存済みキーを削除'))} checked={form.clearKey}
          onChange={(event) => updateForm(slot, { clearKey: event.target.checked, apiKey: '' })} />
        {text('Remove the saved key', '保存済みキーを削除')}
      </label>
      <div className="save-actions">
        <button type="button" className="secondary" aria-label={label(text('Test', 'テスト'))}
          disabled={busy} onClick={() => void testSlot(slot)}>{text('Test', 'テスト')}</button>
        <button type="button" className="primary" aria-label={label(text('Save', '保存'))}
          disabled={busy || modelSlotSaveBlocked(form)} onClick={() => void saveSlot(slot)}>{text('Save', '保存')}</button>
        <button type="button" className="secondary" aria-label={label(text('Use env default', 'env既定に戻す'))}
          disabled={busy || saved === undefined} onClick={() => void resetSlot(slot)}>{text('Use env default', 'env既定に戻す')}</button>
      </div>
      {result !== undefined && <p className={result.kind === 'error' ? 'field-error' : 'model-slot-ok'}>{result.message}</p>}
    </article>;
  }

  return <section className="workspace-card model-settings-card">
    <h2>{text('Model provider', 'モデルプロバイダ')}</h2>
    <p className="empty-state">{text('Choose the model per slot: main runs Agents, judge runs LLM-as-judge evaluations. An unset slot keeps the environment default. API keys are stored write-only and never sent back to the browser.', 'スロットごとにモデルを選びます。main はエージェント実行、judge は評価（LLM judge）に使います。未設定のスロットは環境変数の既定のままです。APIキーは書き込み専用で保存され、ブラウザへ戻されることはありません。')}</p>
    {loadFailure !== undefined && <div className="api-error">{modelSettingsErrorText(loadFailure, text)}</div>}
    <div className="model-slot-grid">
      {renderSlot('main', text('Main model', 'メインモデル'))}
      {renderSlot('judge', text('Judge model', '評価モデル'))}
    </div>
  </section>;
}

export function SettingsPage({ client }: { readonly client: ToolApiClient }) {
  const [health, setHealth] = useState<'checking' | 'ok' | 'offline'>('checking');
  const { language, setLanguage, text } = useI18n();
  const refresh = useCallback(async () => {
    setHealth('checking');
    try { await client.health(); setHealth('ok'); }
    catch (cause) { console.error('Health check failed', cause); setHealth('offline'); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  const healthLabel = health === 'checking' ? text('checking', '確認中') : health === 'ok' ? text('ok', '正常') : text('offline', 'オフライン');
  return <main className="workspace-page">
    <header className="workspace-header">
      <div>
        <span className="eyebrow">{text('Settings', '設定')}</span>
        <h1>{text('Runtime settings', '実行環境設定')}</h1>
        <p>{text('Review the local runtime and its safety boundaries.', 'ローカル実行環境と安全境界を確認します。')}</p>
      </div>
      <button type="button" className="secondary" onClick={() => void refresh()}>{text('Refresh status', '状態を更新')}</button>
    </header>
    <div className="settings-grid">
      <section className="workspace-card">
        <h2>{text('Language', '言語')}</h2>
        <label>{text('Display language', '表示言語')}
          <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'ja')}>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <p className="empty-state">{text('The selection is saved in this browser.', '選択内容はこのブラウザに保存されます。')}</p>
      </section>
      <section className="workspace-card">
        <h2>{text('Connection', '接続')}</h2>
        <dl className="settings-list">
          <div><dt>API</dt><dd><span className={`health-dot ${health}`} />{healthLabel}{health === 'offline' && <button type="button" className="ghost" onClick={() => void refresh()}>{text('Retry', '再確認')}</button>}</dd></div>
          <div><dt>{text('Scope', 'スコープ')}</dt><dd><code>local / default</code></dd></div>
          <div><dt>{text('Mode', 'モード')}</dt><dd><code>LOCAL · PREVIEW</code></dd></div>
        </dl>
      </section>
      <section className="workspace-card">
        <h2>{text('Environment defaults', '環境変数の既定')}</h2>
        <dl className="settings-list">
          <div><dt>{text('Provider', 'プロバイダー')}</dt><dd>LM Studio · OpenAI compatible</dd></div>
          <div><dt>{text('Endpoint', 'エンドポイント')}</dt><dd><code>LM_STUDIO_BASE_URL</code></dd></div>
          <div><dt>{text('Model', 'モデル')}</dt><dd><code>LM_STUDIO_MODEL</code></dd></div>
          <div><dt>{text('Timeout', 'タイムアウト')}</dt><dd><code>LM_STUDIO_TIMEOUT_MS</code></dd></div>
        </dl>
        <p className="empty-state">{text('These apply to any slot left unset below. Server-side environment variables are intentionally not editable from the browser.', '下のスロットが未設定のときに使われます。サーバー側の環境変数はブラウザから変更できません。')}</p>
      </section>
      <section className="workspace-card">
        <h2>{text('Security gates', '安全ゲート')}</h2>
        <ul className="gate-list">
          <li className="ready">{text('Preview blocks write Tools', 'プレビューでは書き込みToolを遮断')}</li>
          <li className="ready">{text('Run trace persistence enabled', '実行トレースの永続化が有効')}</li>
          <li className="locked">{text('MCP publication locked until auth/audit adapters exist', '認証・監査アダプター実装までMCP公開をロック')}</li>
          <li className="locked">{text('Production execution unavailable', '本番実行は利用不可')}</li>
        </ul>
      </section>
    </div>
    <ModelSettingsSection client={client} />
  </main>;
}

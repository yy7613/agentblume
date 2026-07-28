import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AuthSessionDto, ModelCatalogProviderDto, ModelSettingsDto, ModelSlotNameDto, ModelSlotSettingsDto } from '../api/types';
import { clearAuthToken, writeAuthToken } from '../api/auth-token';
import { useI18n } from '../i18n';
import {
  EMPTY_MODEL_SLOT_FORM, MANUAL_MODEL_OPTION, apiKeyPlaceholder, applyFetchedModels, applyRegistryModels,
  modelChoiceSelectValue, modelSettingsErrorText, modelSlotSaveBlocked, modelSlotSummary, modelTestMode,
  modelTestModeNote, modelTestSummary, providerOptionLabel, selectModelChoice, shouldWarnStoredKeyUnused,
  storageWarning, storedKeyUnusedNote, toModelSlotForm, toModelSlotInput, withProvider,
  type ModelSlotFormValue,
} from './model-settings-form';
import { scope } from '../scope';

interface SlotFeedback { readonly kind: 'ok' | 'error'; readonly message: string; readonly note?: string }
type SlotForms = Readonly<Record<ModelSlotNameDto, ModelSlotFormValue>>;

/**
 * モデル設定（main / judge）。2スロットを同じフォームで扱う。
 *
 * **平文APIキーをこの画面が持つのは入力欄の state だけ**である。保存に成功したら入力欄を捨てて
 * マスク済みサマリを再取得し、以後は `…abcd` のヒントしか画面に残らない。
 *
 * カタログは2段構成（`/model-catalog` は見出しのみ、モデル一覧はプロバイダ単位で別取得）なので、
 * プロバイダを選んだ時点で一覧を遅延fetchし、同じ providerId の再取得はキャッシュで省く。
 *
 * 非同期処理中もテキスト入力は止めない（打鍵を邪魔しない）。そのぶん**古い応答で入力を巻き戻さない**
 * ことが要になるため、(1) 反映は必ず関数型setStateで最新stateへマージし、(2) リクエスト時の
 * providerId / baseUrl と現在値が違う応答は捨てる。
 */
function ModelSettingsSection({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [providers, setProviders] = useState<readonly ModelCatalogProviderDto[]>([]);
  const [settings, setSettings] = useState<ModelSettingsDto>();
  const [forms, setForms] = useState<SlotForms>({ main: EMPTY_MODEL_SLOT_FORM, judge: EMPTY_MODEL_SLOT_FORM });
  const [feedback, setFeedback] = useState<Readonly<Partial<Record<ModelSlotNameDto, SlotFeedback>>>>({});
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState<Readonly<Partial<Record<ModelSlotNameDto, boolean>>>>({});
  // 読み込み失敗は原因のまま持ち、表示時にローカライズする（言語切替で再取得しないため）。
  const [loadFailure, setLoadFailure] = useState<unknown>();

  // 非同期ハンドラは「クリック時のstate」ではなく常に最新のフォーム値を読む（stale closure対策）。
  const formsRef = useRef(forms);
  formsRef.current = forms;
  /** providerId → モデル一覧。同じプロバイダへ戻ったときに再取得しない。 */
  const modelCache = useRef(new Map<string, readonly string[]>());
  /** 取得中の providerId → 進行中リクエスト。main / judge が同じプロバイダでも1回で済ませる。 */
  const pendingModels = useRef(new Map<string, Promise<readonly string[]>>());
  /** 実行中リクエスト。アンマウント時に全部abortしてsetStateを防ぐ。 */
  const inFlight = useRef(new Set<AbortController>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const running = inFlight.current;
    return () => {
      mounted.current = false;
      for (const controller of running) controller.abort();
      running.clear();
    };
  }, []);

  function begin(): AbortController {
    const controller = new AbortController();
    inFlight.current.add(controller);
    return controller;
  }

  /** 保存済みDTO → フォーム。取得済みの一覧があれば即座に当てて選択欄が空になる瞬間を作らない。 */
  const formFrom = useCallback((slot: ModelSlotSettingsDto | undefined, catalog: readonly ModelCatalogProviderDto[]): ModelSlotFormValue => {
    const form = toModelSlotForm(slot, catalog);
    const cached = modelCache.current.get(form.providerId);
    return cached === undefined ? form : applyRegistryModels(form, cached);
  }, []);

  const load = useCallback(async () => {
    const controller = begin();
    try {
      const [catalog, saved] = await Promise.all([client.getModelCatalog(controller.signal), client.getModelSettings(scope, controller.signal)]);
      if (!mounted.current) return;
      setProviders(catalog);
      setSettings(saved);
      setForms({ main: formFrom(saved.main, catalog), judge: formFrom(saved.judge, catalog) });
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setLoadFailure(cause); }
    finally { inFlight.current.delete(controller); }
  }, [client, formFrom]);
  useEffect(() => { void load(); }, [load]);

  function updateForm(slot: ModelSlotNameDto, patch: Partial<ModelSlotFormValue>): void {
    setForms((current) => ({ ...current, [slot]: { ...current[slot], ...patch } }));
  }
  function note(slot: ModelSlotNameDto, value: SlotFeedback | undefined): void {
    setFeedback((current) => ({ ...current, [slot]: value }));
  }
  /** PUT の応答には storage が付かないので、GET で得た値を持ち越す。 */
  function mergeSettings(saved: ModelSettingsDto): void {
    setSettings((current) => (saved.storage === undefined && current?.storage !== undefined ? { ...saved, storage: current.storage } : saved));
  }

  /** 選択中プロバイダのモデル一覧を（キャッシュ経由で）フォームへ反映する。 */
  async function ensureProviderModels(slot: ModelSlotNameDto, providerId: string): Promise<void> {
    if (providerId === '') return;
    const apply = (models: readonly string[]): void => {
      // 取得中にプロバイダを変えていたら捨てる（古い一覧で選択を巻き戻さない）。
      setForms((current) => (current[slot].providerId !== providerId ? current : { ...current, [slot]: applyRegistryModels(current[slot], models) }));
    };
    const cached = modelCache.current.get(providerId);
    if (cached !== undefined) { apply(cached); return; }
    let request = pendingModels.current.get(providerId);
    if (request === undefined) {
      const controller = begin();
      request = client.getProviderModels(providerId, controller.signal)
        .then((models) => { modelCache.current.set(providerId, models); return models; })
        .finally(() => { inFlight.current.delete(controller); pendingModels.current.delete(providerId); });
      pendingModels.current.set(providerId, request);
    }
    setLoadingModels((current) => ({ ...current, [slot]: true }));
    try {
      const models = await request;
      if (mounted.current) apply(models);
    } catch (cause) {
      // アンマウント（=abort）由来の失敗は表示しない。
      if (!mounted.current) return;
      // 一覧が引けなくてもモデル名は手入力で指定できる。
      apply([]);
      note(slot, { kind: 'error', message: text('Could not load this provider’s model list. Enter the model name manually.', 'このプロバイダのモデル一覧を取得できませんでした。モデル名は手入力できます。'), note: modelSettingsErrorText(cause, text) });
    } finally {
      if (mounted.current) setLoadingModels((current) => ({ ...current, [slot]: false }));
    }
  }

  // プロバイダ選択（と registry への切り替え）でモデル一覧を遅延取得する。
  // 依存はプロバイダIDだけ（ensureProviderModels は ref と関数型setStateしか触らないので毎レンダー作り直してよい）。
  const mainProvider = forms.main.source === 'registry' ? forms.main.providerId : '';
  const judgeProvider = forms.judge.source === 'registry' ? forms.judge.providerId : '';
  useEffect(() => { void ensureProviderModels('main', mainProvider); }, [mainProvider]);
  useEffect(() => { void ensureProviderModels('judge', judgeProvider); }, [judgeProvider]);

  /** テスト・保存中は全スロットを busy にする（同じ設定を並行更新させない）。 */
  async function runAction(slot: ModelSlotNameDto, action: (signal: AbortSignal) => Promise<SlotFeedback>): Promise<void> {
    const controller = begin();
    setBusy(true);
    note(slot, undefined);
    try {
      const result = await action(controller.signal);
      if (mounted.current) note(slot, result);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) note(slot, { kind: 'error', message: modelSettingsErrorText(cause, text) });
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * 疎通テスト。**編集済みなのに候補として送れないフォームではボタンを塞ぐ**（modelTestMode）。
   * candidate を省くとサーバーは保存済み/env既定（ローカルLM Studio）を試すため、
   * 「別プロバイダを選んだつもりが ok」という嘘の成功になる。
   */
  async function testSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (signal): Promise<SlotFeedback> => {
      const form = formsRef.current[slot];
      const saved = settings?.[slot];
      const candidate = modelTestMode(form, saved) === 'candidate' ? toModelSlotInput(form) : undefined;
      const result = await client.testModelSettings(scope, slot, candidate, signal);
      return {
        kind: result.ok ? 'ok' : 'error',
        message: modelTestSummary(result, text),
        ...(shouldWarnStoredKeyUnused(result.usedStoredKey, form, saved) ? { note: storedKeyUnusedNote(text) } : {}),
      };
    });
  }

  async function saveSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const value = toModelSlotInput(formsRef.current[slot]);
      const saved = await client.saveModelSettings(slot === 'main' ? { scope, main: value } : { scope, judge: value });
      if (!mounted.current) return { kind: 'ok', message: '' };
      mergeSettings(saved);
      // 保存後は「サーバーが受け取った内容」が真なので、そのスロットだけを応答で置き換える。
      setForms((current) => ({ ...current, [slot]: formFrom(saved[slot], providers) }));
      return { kind: 'ok', message: text('Saved. The API key field was cleared.', '保存しました。APIキー欄はクリアしました。') };
    });
  }

  async function resetSlot(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (): Promise<SlotFeedback> => {
      const saved = await client.saveModelSettings(slot === 'main' ? { scope, main: null } : { scope, judge: null });
      if (!mounted.current) return { kind: 'ok', message: '' };
      mergeSettings(saved);
      setForms((current) => ({ ...current, [slot]: formFrom(saved[slot], providers) }));
      return { kind: 'ok', message: text('Reverted to the environment default.', '環境変数の既定に戻しました。') };
    });
  }

  /** 保存済みキーが要るエンドポイントもあるので slot を渡す（キーは本文にも載せない）。 */
  async function fetchModels(slot: ModelSlotNameDto): Promise<void> {
    await runAction(slot, async (signal): Promise<SlotFeedback> => {
      const form = formsRef.current[slot];
      const saved = settings?.[slot];
      const requested = form.baseUrl.trim();
      const result = await client.listOpenAiCompatibleModels(scope, requested, slot, signal);
      // 応答を待つ間にベースURLが変わっていたら、別サーバーの一覧なので捨てる。
      if (formsRef.current[slot].baseUrl.trim() !== requested) {
        return { kind: 'error', message: text('The base URL changed while loading, so the fetched list was discarded.', '取得中にベースURLが変わったため、取得した一覧は破棄しました。') };
      }
      setForms((current) => (current[slot].baseUrl.trim() !== requested ? current : { ...current, [slot]: applyFetchedModels(current[slot], result.models) }));
      const storedKeyNote = shouldWarnStoredKeyUnused(result.usedStoredKey, form, saved) ? { note: storedKeyUnusedNote(text) } : {};
      return result.models.length === 0
        ? { kind: 'error', message: text('The endpoint returned no models.', 'モデルを取得できませんでした。'), ...storedKeyNote }
        : { kind: 'ok', message: text(`Fetched ${result.models.length} model(s).`, `モデルを${result.models.length}件取得しました。`), ...storedKeyNote };
    });
  }

  function renderSlot(slot: ModelSlotNameDto, title: string) {
    const form = forms[slot];
    const saved = settings?.[slot];
    const provider = providers.find((candidate) => candidate.id === form.providerId);
    const result = feedback[slot];
    const testMode = modelTestMode(form, saved);
    const testNote = modelTestModeNote(testMode, saved, text);
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
            onChange={(event) => setForms((current) => ({ ...current, [slot]: withProvider(current[slot], event.target.value) }))}>
            {providers.map((entry) => <option key={entry.id} value={entry.id}>{providerOptionLabel(entry)}</option>)}
          </select>
        </label>
        <label>{text('Model', 'モデル')}
          <select aria-label={label(text('Model', 'モデル'))} value={modelChoiceSelectValue(form.registryModel)}
            onChange={(event) => updateForm(slot, { registryModel: selectModelChoice(form.registryModel, event.target.value) })}>
            <option value="">{text('Select a model', 'モデルを選択')}</option>
            {form.registryModels.map((model) => <option key={model} value={model}>{model}</option>)}
            <option value={MANUAL_MODEL_OPTION}>{text('Enter manually', '手入力')}</option>
          </select>
        </label>
        {loadingModels[slot] === true && <p className="model-slot-note" role="status">{text('Loading the model list…', 'モデル一覧を取得中…')}</p>}
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
        {/* 保存失敗時も入力を捨てない（再入力の手間を避ける）ぶん、パスワードマネージャの誤保存を防ぐ。 */}
        <input type="password" autoComplete="new-password" aria-label={label(text('API key', 'APIキー'))} value={form.apiKey} disabled={form.clearKey}
          placeholder={apiKeyPlaceholder(saved, provider, form.source, text)} onChange={(event) => updateForm(slot, { apiKey: event.target.value })} />
      </label>
      <label className="structured-output-toggle">
        <input type="checkbox" aria-label={label(text('Remove the saved key', '保存済みキーを削除'))} checked={form.clearKey}
          onChange={(event) => updateForm(slot, { clearKey: event.target.checked, apiKey: '' })} />
        {text('Remove the saved key', '保存済みキーを削除')}
      </label>
      <div className="save-actions">
        <button type="button" className="secondary" aria-label={label(text('Test', 'テスト'))} {...(testNote === undefined ? {} : { title: testNote })}
          disabled={busy || testMode === 'blocked'} onClick={() => void testSlot(slot)}>{text('Test', 'テスト')}</button>
        <button type="button" className="primary" aria-label={label(text('Save', '保存'))}
          disabled={busy || modelSlotSaveBlocked(form)} onClick={() => void saveSlot(slot)}>{text('Save', '保存')}</button>
        <button type="button" className="secondary" aria-label={label(text('Use env default', 'env既定に戻す'))}
          disabled={busy || saved === undefined} onClick={() => void resetSlot(slot)}>{text('Use env default', 'env既定に戻す')}</button>
      </div>
      {testNote !== undefined && <p className="model-slot-note">{testNote}</p>}
      {result !== undefined && <p className={result.kind === 'error' ? 'field-error' : 'model-slot-ok'} role={result.kind === 'error' ? 'alert' : 'status'}>{result.message}</p>}
      {result?.note !== undefined && <p className="model-slot-note" role="status">{result.note}</p>}
    </article>;
  }

  return <section className="workspace-card model-settings-card">
    <h2>{text('Model provider', 'モデルプロバイダ')}</h2>
    <p className="empty-state">{text('Choose the model per slot: main runs Agents, judge runs LLM-as-judge evaluations. An unset slot keeps the environment default. API keys are stored write-only and never sent back to the browser.', 'スロットごとにモデルを選びます。main はエージェント実行、judge は評価（LLM judge）に使います。未設定のスロットは環境変数の既定のままです。APIキーは書き込み専用で保存され、ブラウザへ戻されることはありません。')}</p>
    {storageWarning(settings?.storage, text) !== undefined && <p className="model-storage-warning" role="status">{storageWarning(settings?.storage, text)}</p>}
    {loadFailure !== undefined && <div className="api-error" role="alert">{modelSettingsErrorText(loadFailure, text)}</div>}
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
          {/* スコープはサーバー（認証済みPrincipal）が決める。ここは現在地の表示だけで、変更手段は無い。 */}
          <div><dt>{text('Scope', 'スコープ')}</dt><dd><code>{scope.tenantId} / {scope.workspaceId}</code></dd></div>
        </dl>
      </section>
      <AccessSection client={client} />
      <SettingsTail />
    </div>
    <ModelSettingsSection client={client} />
  </main>;
}

/**
 * アクセストークンの管理。
 *
 * 単一ユーザーモードでは何も入力させない（入れても意味が無く、「認証しているつもり」を作るだけ）。
 * 代わりに**認証していないこと**を明記する。共有するなら `AGENTCONTEXT_AUTH_TOKENS` を設定する、
 * という次の一手まで書く。
 */
function AccessSection({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [session, setSession] = useState<AuthSessionDto>();
  const [token, setToken] = useState('');
  const [feedback, setFeedback] = useState<{ readonly kind: 'ok' | 'error'; readonly message: string }>();

  const load = useCallback(async () => {
    try { setSession(await client.getSession()); }
    catch { setSession(undefined); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  async function apply(): Promise<void> {
    writeAuthToken(token);
    try {
      const next = await client.getSession();
      setSession(next);
      setToken('');
      setFeedback({ kind: 'ok', message: text(`Signed in as ${next.principal.subject}.`, `${next.principal.subject} として認証しました。`) });
    } catch (cause) {
      setFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  function signOut(): void {
    clearAuthToken();
    setSession(undefined);
    setFeedback({ kind: 'ok', message: text('The token was removed from this browser. Reload to sign in again.', 'このブラウザからトークンを削除しました。再読み込みしてサインインし直してください。') });
  }

  const singleUser = session?.mode === 'single-user';
  return <section className="workspace-card">
    <h2>{text('Access', 'アクセス')}</h2>
    {singleUser
      ? <>
        <p className="empty-state">
          {text(
            'Single-user mode: requests are not authenticated. The server refuses to start in this mode unless it is bound to 127.0.0.1.',
            '単一ユーザーモードです。リクエストは認証されていません。この状態では 127.0.0.1 以外へバインドするとサーバーは起動しません。',
          )}
        </p>
        <p className="empty-state">
          {text('To share this instance with your team, set AGENTCONTEXT_AUTH_TOKENS on the server and restart.', 'チームで共有する場合は、サーバーに AGENTCONTEXT_AUTH_TOKENS を設定して再起動してください。')}
        </p>
      </>
      : <>
        <dl className="settings-list">
          <div><dt>{text('Signed in as', '認証中')}</dt><dd><code>{session === undefined ? text('not signed in', '未認証') : session.principal.displayName ?? session.principal.subject}</code></dd></div>
        </dl>
        <label>{text('Access token', 'アクセストークン')}
          <input type="password" autoComplete="off" aria-label={text('Access token', 'アクセストークン')} value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <div className="save-actions">
          <button type="button" className="primary" disabled={token.trim() === ''} onClick={() => void apply()}>{text('Save token', 'トークンを保存')}</button>
          {session !== undefined && <button type="button" className="secondary" onClick={signOut}>{text('Sign out', 'サインアウト')}</button>}
        </div>
        <p className="empty-state">{text('The token is stored in this browser only.', 'トークンはこのブラウザにのみ保存されます。')}</p>
      </>}
    {feedback !== undefined && <p className={feedback.kind === 'error' ? 'api-error' : 'empty-state'} role={feedback.kind === 'error' ? 'alert' : undefined}>{feedback.message}</p>}
  </section>;
}

/** 参照情報だけのカード群（env 既定と安全ゲート）。状態を持たないので独立したコンポーネントにする。 */
function SettingsTail() {
  const { text } = useI18n();
  return <>
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
        <li className="ready">{text('Tenant scope comes from the authenticated principal', 'テナントスコープは認証済みPrincipalから決まる')}</li>
        <li className="locked">{text('MCP publication locked until audit adapters exist', '監査アダプター実装までMCP公開をロック')}</li>
        <li className="locked">{text('Role-based authorization not implemented yet', 'ロールベースの認可は未実装')}</li>
        <li className="locked">{text('Production execution unavailable', '本番実行は利用不可')}</li>
      </ul>
    </section>
  </>;
}

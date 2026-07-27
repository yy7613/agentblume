/**
 * モデル設定フォームの値 ⇔ DTO 変換（純関数・React非依存）。
 *
 * main / judge の2スロットは同じ形のフォームで扱う。画面（SettingsPage）は入力の保持と
 * API呼び出しだけを担当し、「保存できる形か」「何を送るか」の判断はすべてここに集める。
 *
 * **秘密の扱いがこのモジュールの要**である。
 * - 応答（ModelSlotSettingsDto）の apiKey はマスク済み（`{ configured, hint? }`）で、平文は含まれない。
 * - 保存入力の apiKey は write-only の平文で、**入力欄に文字が入っているときだけ**送る。
 *   空のまま保存 = フィールドごと省略 = 既存キーを維持。明示的な削除は clearKey（空文字送信）。
 *
 * **モデル一覧は静的参照では作れない**（v36でカタログが2段構成になり、`/model-catalog` は
 * `modelCount` だけを返す）。よってこのモジュールは一覧を「引く」責務を持たず、
 * 画面が遅延fetchした配列を受け取ってフォームへ適用する（applyRegistryModels / applyFetchedModels）。
 */
import { ApiError } from '../api/tool-api';
import type {
  MaskedApiKeyDto,
  ModelCatalogProviderDto,
  ModelSettingsSourceDto,
  ModelSettingsStorageDto,
  ModelSlotSettingsDto,
  ModelSlotSettingsInputDto,
  ModelSettingsTestResultDto,
} from '../api/types';

export type Translate = (english: string, japanese: string) => string;

/** モデル選択 `<select>` の「手入力」オプション値（カタログに無い新モデル用）。 */
export const MANUAL_MODEL_OPTION = '__manual__';

/** モデル名の入力状態。manual のときはフリーテキスト入力へ切り替える。 */
export interface ModelChoiceValue {
  readonly value: string;
  readonly manual: boolean;
}

export interface ModelSlotFormValue {
  readonly source: ModelSettingsSourceDto;
  /** registry のときのプロバイダID（設定値は `${providerId}/${model}`）。 */
  readonly providerId: string;
  /** registry のモデル（provider接頭辞なし）。 */
  readonly registryModel: ModelChoiceValue;
  /** 選択中プロバイダのモデル候補（遅延fetch結果）。未取得なら空。 */
  readonly registryModels: readonly string[];
  /** openai-compatible のエンドポイント。 */
  readonly baseUrl: string;
  readonly compatModel: ModelChoiceValue;
  /** 「モデル一覧を取得」で得た候補。空なら手入力のみ。 */
  readonly compatModels: readonly string[];
  /** write-only の平文。空文字 = 既存キーを維持。 */
  readonly apiKey: string;
  /** 明示的にキーを消す（空文字を送る）。 */
  readonly clearKey: boolean;
}

export const EMPTY_MODEL_SLOT_FORM: ModelSlotFormValue = {
  source: 'registry',
  providerId: '',
  registryModel: { value: '', manual: false },
  registryModels: [],
  baseUrl: '',
  compatModel: { value: '', manual: false },
  compatModels: [],
  apiKey: '',
  clearKey: false,
};

/**
 * 未設定スロットの既定プロバイダ。
 * カタログは name 昇順なので先頭は `302ai` のような無名プロバイダになりがちで、
 * 「何も選んでいないのに 302ai が選択済み」に見える。最も一般的な `openai` を優先する。
 */
export const PREFERRED_DEFAULT_PROVIDER = 'openai';

export function defaultProviderId(providers: readonly ModelCatalogProviderDto[]): string {
  return providers.some((provider) => provider.id === PREFERRED_DEFAULT_PROVIDER)
    ? PREFERRED_DEFAULT_PROVIDER
    : (providers[0]?.id ?? '');
}

/** `'openai/gpt-4o'` → `['openai', 'gpt-4o']`。最初の `/` で分ける（モデル名側の `/` は残す）。 */
export function splitRegistryModel(model: string): readonly [provider: string, name: string] {
  const slash = model.indexOf('/');
  return slash <= 0 ? ['', model] : [model.slice(0, slash), model.slice(slash + 1)];
}

/**
 * 保存済み設定（マスク済み）→ フォーム値。未設定（env既定）のスロットは
 * 既定プロバイダを選んだ空フォームにする。APIキー入力欄は常に空で始める（平文は保持しない）。
 *
 * モデル候補は非同期に取るため、ここでは `manual` を立てない。
 * 一覧が届いた時点で applyRegistryModels が「カタログに無いモデル = 手入力」を確定させる。
 */
export function toModelSlotForm(slot: ModelSlotSettingsDto | undefined, providers: readonly ModelCatalogProviderDto[]): ModelSlotFormValue {
  const fallback = defaultProviderId(providers);
  if (slot === undefined) return { ...EMPTY_MODEL_SLOT_FORM, providerId: fallback };
  if (slot.source === 'registry') {
    const [providerId, name] = splitRegistryModel(slot.model);
    return {
      ...EMPTY_MODEL_SLOT_FORM,
      source: 'registry',
      providerId: providerId === '' ? fallback : providerId,
      registryModel: { value: name, manual: false },
    };
  }
  return {
    ...EMPTY_MODEL_SLOT_FORM,
    source: 'openai-compatible',
    providerId: fallback,
    baseUrl: slot.baseUrl,
    compatModel: { value: slot.model, manual: false },
  };
}

/**
 * プロバイダを変えたらモデル選択と候補はリセットする（別プロバイダの候補は無効なため）。
 * 同じプロバイダを選び直したときは何もしない（一覧の再取得は走らないので、消すと復旧できない）。
 */
export function withProvider(form: ModelSlotFormValue, providerId: string): ModelSlotFormValue {
  if (form.providerId === providerId) return form;
  return { ...form, providerId, registryModel: { value: '', manual: false }, registryModels: [] };
}

/** `<select>` の選択 → モデル入力状態。「手入力」を選んだら値を保ったままテキスト入力へ切り替える。 */
export function selectModelChoice(current: ModelChoiceValue, selected: string): ModelChoiceValue {
  return selected === MANUAL_MODEL_OPTION ? { value: current.value, manual: true } : { value: selected, manual: false };
}

/** `<select>` に表示すべき値（手入力中は番兵値）。 */
export function modelChoiceSelectValue(choice: ModelChoiceValue): string {
  return choice.manual ? MANUAL_MODEL_OPTION : choice.value;
}

/**
 * 取得したプロバイダのモデル一覧を反映する（registry 側）。
 * 現在値は消さない（保存済みモデルを勝手に付け替えない）。一覧に無ければ手入力状態へ倒し、
 * 既に手入力中なら手入力のまま保つ（fetch中に打った文字を巻き戻さない）。
 */
export function applyRegistryModels(form: ModelSlotFormValue, models: readonly string[]): ModelSlotFormValue {
  const value = form.registryModel.value;
  const manual = form.registryModel.manual || (value !== '' && !models.includes(value));
  return { ...form, registryModels: models, registryModel: { value, manual } };
}

/** 取得したモデル一覧を反映する（openai-compatible 側）。現在の入力が一覧にあれば維持し、無ければ先頭を選ぶ。 */
export function applyFetchedModels(form: ModelSlotFormValue, models: readonly string[]): ModelSlotFormValue {
  const keep = models.includes(form.compatModel.value);
  return {
    ...form,
    compatModels: models,
    compatModel: { value: keep ? form.compatModel.value : (models[0] ?? form.compatModel.value), manual: false },
  };
}

/** 保存・テストに使うモデル文字列。registry は `${providerId}/${model}` へ組み立てる。 */
export function modelSlotModelValue(form: ModelSlotFormValue): string {
  if (form.source === 'registry') {
    const name = form.registryModel.value.trim();
    return form.providerId === '' || name === '' ? '' : `${form.providerId}/${name}`;
  }
  return form.compatModel.value.trim();
}

/** 保存できない状態（モデル未指定、OpenAI互換でベースURL未入力）。 */
export function modelSlotSaveBlocked(form: ModelSlotFormValue): boolean {
  if (modelSlotModelValue(form) === '') return true;
  return form.source === 'openai-compatible' && form.baseUrl.trim() === '';
}

/**
 * フォームが保存済み設定から動いているか。
 * 「テストが何をテストしたか」を決めるために要る（editedなのに候補を送れない = テスト不能）。
 */
export function modelSlotFormEdited(form: ModelSlotFormValue, saved: ModelSlotSettingsDto | undefined): boolean {
  if (form.apiKey !== '' || form.clearKey) return true;
  const model = modelSlotModelValue(form);
  if (saved === undefined) return model !== '' || form.source !== 'registry' || form.baseUrl.trim() !== '';
  if (form.source !== saved.source) return true;
  if (saved.source === 'openai-compatible' && form.baseUrl.trim() !== saved.baseUrl) return true;
  return model !== saved.model;
}

/**
 * テストボタンの意味。
 * - `candidate` … 画面の入力値をそのまま試す。
 * - `saved` … 入力が保存済み設定と同じ（=未編集）なので、保存済み/env既定を試す。
 * - `blocked` … 編集済みだが候補として送れない（モデル未選択など）。**押させない**。
 *
 * blocked を押せてしまうと candidate が省かれ、サーバーは保存済み/env既定（ローカルLM Studio）を
 * テストして ok を返す。「Anthropicを選んだつもりが成功した」という嘘の成功になるため塞ぐ。
 */
export type ModelTestMode = 'candidate' | 'saved' | 'blocked';

export function modelTestMode(form: ModelSlotFormValue, saved: ModelSlotSettingsDto | undefined): ModelTestMode {
  if (!modelSlotSaveBlocked(form)) return 'candidate';
  return modelSlotFormEdited(form, saved) ? 'blocked' : 'saved';
}

/** テストボタンの補足（何をテストするか / なぜ押せないか）。candidate は自明なので注記なし。 */
export function modelTestModeNote(mode: ModelTestMode, saved: ModelSlotSettingsDto | undefined, text: Translate): string | undefined {
  if (mode === 'blocked') {
    return text(
      'Finish the model selection to test it. The edited values cannot be sent yet, and testing now would only check the saved settings.',
      'モデルの選択を完了するとテストできます。編集中の値はまだ送れないため、いま実行しても保存済み設定を試すことになります。',
    );
  }
  if (mode === 'saved') {
    return saved === undefined
      ? text('Tests the environment default (this slot is unset).', '環境変数の既定をテストします（このスロットは未設定です）。')
      : text('Tests the saved settings (the form is unchanged).', '保存済み設定をテストします（フォームは未編集です）。');
  }
  return undefined;
}

/**
 * フォーム値 → PUT / テスト用のスロット入力。
 * apiKey は「入力あり = 平文で送る」「空 = フィールドごと省略（既存維持）」「削除指定 = 空文字」。
 */
export function toModelSlotInput(form: ModelSlotFormValue): ModelSlotSettingsInputDto {
  const key = form.clearKey ? { apiKey: '' } : form.apiKey === '' ? {} : { apiKey: form.apiKey };
  const model = modelSlotModelValue(form);
  return form.source === 'registry'
    ? { source: 'registry', model, ...key }
    : { source: 'openai-compatible', baseUrl: form.baseUrl.trim(), model, ...key };
}

function keyLabel(apiKey: MaskedApiKeyDto, text: Translate): string {
  const label = text('key', 'キー');
  if (!apiKey.configured) return `${label}: ${text('not set', '未設定')}`;
  return `${label}: ${apiKey.hint === undefined ? text('set', '設定済み') : `…${apiKey.hint}`}`;
}

/** 現在の状態サマリ。スロット未設定なら「環境変数の既定を使用中」。 */
export function modelSlotSummary(slot: ModelSlotSettingsDto | undefined, text: Translate): string {
  if (slot === undefined) return text('Using the environment default (LM Studio).', '環境変数の既定（LM Studio）を使用中');
  const key = keyLabel(slot.apiKey, text);
  return slot.source === 'registry'
    ? text(`Saved: ${slot.model} (${key})`, `保存済み: ${slot.model}（${key}）`)
    : text(`Saved: ${slot.model} @ ${slot.baseUrl} (${key})`, `保存済み: ${slot.model} @ ${slot.baseUrl}（${key}）`);
}

/**
 * APIキー入力欄のプレースホルダ。
 * - 保存済み: 「空のままで維持」。**4文字以下のキーは hint が付かない**ので、その場合はヒント欄を出さない。
 * - 未設定 + registry: そのプロバイダの環境変数名を案内する。
 * - 未設定 + openai-compatible: プロバイダ登録簿とは無関係な宛先なので、**選択中プロバイダの
 *   envVar は案内しない**（OpenAI互換のローカル宛に OPENAI_API_KEY を促すのは誤誘導）。
 */
export function apiKeyPlaceholder(
  slot: ModelSlotSettingsDto | undefined,
  provider: ModelCatalogProviderDto | undefined,
  source: ModelSettingsSourceDto,
  text: Translate,
): string {
  if (slot?.apiKey.configured === true) {
    return slot.apiKey.hint === undefined
      ? text('Saved (leave blank to keep)', '保存済み（空のままで維持）')
      : text(`Saved: …${slot.apiKey.hint} (leave blank to keep)`, `保存済み: …${slot.apiKey.hint}（空のままで維持）`);
  }
  if (source === 'openai-compatible') return text('Not set (env LM_STUDIO_API_KEY also works)', '未設定（環境変数 LM_STUDIO_API_KEY でも可）');
  if (provider?.envVar === undefined) return text('Not set', '未設定');
  return text(`Not set (env ${provider.envVar} also works)`, `未設定（環境変数 ${provider.envVar} でも可）`);
}

/**
 * 疎通テストの失敗文（`result.error`）の日本語化。
 *
 * 失敗は 200 + `ok:false` で返るので ApiError を通らず、localizeApiErrorMessage の対象外になる。
 * よく出るパターンだけを日本語にし、**未知は原文のまま**返す（詳細を握りつぶさない）。
 * 日本語でも原文を括弧で残す（error-messages.ts と同じ流儀）。
 */
export function localizeModelTestError(raw: string, text: Translate): string {
  const message = raw.trim();
  if (message === '') return text('Test failed', 'テストに失敗しました');
  const detail = text('', `（${message}）`);
  if (/decrypt|secret could not|sealed/i.test(message)) {
    return text(message, `保存済みAPIキーを復号できませんでした。APIキーを再入力して保存し直してください。${detail}`);
  }
  if (/\b(401|403)\b|unauthorized|forbidden|invalid api key|authentication|api key/i.test(message)) {
    return text(message, `認証に失敗しました。APIキーを確認してください。${detail}`);
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return text(message, `タイムアウトしました。モデルサーバーの応答とモデルのロード状況を確認してください。${detail}`);
  }
  if (/econnrefused|enotfound|eai_again|fetch failed|connect|network|socket/i.test(message)) {
    return text(message, `モデルサーバーに接続できませんでした。エンドポイントと稼働状況を確認してください。${detail}`);
  }
  return message;
}

/** 疎通テスト結果の表示文言。成功は latency と応答の先頭を出す。 */
export function modelTestSummary(result: ModelSettingsTestResultDto, text: Translate): string {
  return result.ok ? `ok (${result.latencyMs}ms): ${result.reply}` : localizeModelTestError(result.error, text);
}

/**
 * 「保存済みキーを使わなかった」を注記すべきか。
 *
 * `usedStoredKey:false` は「キーが無い」ときも立つため、そのまま出すと未設定スロットで
 * 毎回警告が出てしまう。**保存済みキーがあるのに使われなかった**（= 宛先が保存済み設定と違う）
 * ときだけ注記する。自分でキーを入力した場合は当然使われないので対象外。
 */
export function shouldWarnStoredKeyUnused(usedStoredKey: boolean, form: ModelSlotFormValue, saved: ModelSlotSettingsDto | undefined): boolean {
  if (usedStoredKey || form.apiKey !== '' || form.clearKey) return false;
  return saved?.apiKey.configured === true;
}

export function storedKeyUnusedNote(text: Translate): string {
  return text(
    'The saved API key was not used because the destination differs from the saved settings. Enter the key for this destination.',
    '宛先が保存済み設定と異なるため、保存済みキーは使用しませんでした。この宛先向けのキーを入力してください。',
  );
}

/** 揮発ストレージ（`:memory:` DB）で動作中の警告。再起動で保存内容が消える。 */
export function storageWarning(storage: ModelSettingsStorageDto | undefined, text: Translate): string | undefined {
  if (storage !== 'ephemeral') return undefined;
  return text(
    'This workspace runs on ephemeral storage. Saved model settings are lost on restart — set AGENTCONTEXT_DB_PATH to keep them.',
    'このワークスペースは揮発ストレージで動作中です。保存したモデル設定は再起動で消えます（AGENTCONTEXT_DB_PATH を設定してください）。',
  );
}

/**
 * 失敗の表示文言。SECRET_CIPHER は status で意味が違う（409=再入力で直る / 500=鍵ファイル不正で直らない）。
 * それ以外は ApiError が既にローカライズ済みの message を持つのでそのまま使う。
 */
export function modelSettingsErrorText(cause: unknown, text: Translate): string {
  if (cause instanceof ApiError && cause.code === 'SECRET_CIPHER' && cause.status === 500) {
    return text(
      'The encryption key file could not be read. Check AGENTCONTEXT_SECRET_KEY_PATH (re-entering the API key will not fix this).',
      '鍵ファイルが読めない、または不正です。AGENTCONTEXT_SECRET_KEY_PATH を確認してください（APIキーの再入力では復旧しません）。',
    );
  }
  if (cause instanceof ApiError && cause.status === 409) {
    return text('The saved API key could not be decrypted. Enter the API key again, then save.', '保存済みAPIキーを復号できません。APIキーを再入力してください。');
  }
  return cause instanceof Error ? cause.message : text('Request failed', 'リクエストに失敗しました');
}

/** プロバイダ `<option>` のラベル（id + 必要な環境変数名）。 */
export function providerOptionLabel(provider: ModelCatalogProviderDto): string {
  return provider.envVar === undefined ? provider.id : `${provider.id} · ${provider.envVar}`;
}

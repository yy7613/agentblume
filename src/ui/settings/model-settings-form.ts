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
 * **モデル名の候補は持たない**。カタログが返すのは接続先の見出しだけで、モデルは常に手入力である
 * （OpenAI互換エンドポイントに限り、実際に問い合わせた `/models` の結果を補完候補として添える）。
 * 提供元のモデルは頻繁に入れ替わり、Azure / Bedrock / Vertex ではデプロイ済みのものしか
 * 使えないため、こちらが固定の一覧を見せると必ず嘘になる。
 *
 * 「ソース（registry / openai-compatible）」は利用者に選ばせず、**選んだプロバイダに従属**させる。
 * form.source はプロバイダ選択（withProvider / toModelSlotForm）だけが更新する派生値である。
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

/** どのプリセットにも当てはまらないOpenAI互換エンドポイント（ローカル含む）の受け皿。 */
export const GENERIC_OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';

export interface ModelSlotFormValue {
  /** 選択中プロバイダの接続方式（プロバイダ選択から導出する派生値）。 */
  readonly source: ModelSettingsSourceDto;
  /** カタログの見出しID。registry のときは設定値の provider 部になる。 */
  readonly providerId: string;
  /** モデルID / デプロイ名。常に手入力（候補があっても上書きしない）。 */
  readonly model: string;
  /** openai-compatible のエンドポイント。 */
  readonly baseUrl: string;
  /** 「モデル一覧を取得」で**実際に問い合わせて**得た候補。空なら補完なし。 */
  readonly fetchedModels: readonly string[];
  /** write-only の平文。空文字 = 既存キーを維持。 */
  readonly apiKey: string;
  /** 明示的にキーを消す（空文字を送る）。 */
  readonly clearKey: boolean;
}

export const EMPTY_MODEL_SLOT_FORM: ModelSlotFormValue = {
  source: 'registry',
  providerId: '',
  model: '',
  baseUrl: '',
  fetchedModels: [],
  apiKey: '',
  clearKey: false,
};

/** 未設定スロットの既定プロバイダ。最も一般的な `openai` を優先する。 */
export const PREFERRED_DEFAULT_PROVIDER = 'openai';

export function defaultProviderId(providers: readonly ModelCatalogProviderDto[]): string {
  return providers.some((provider) => provider.id === PREFERRED_DEFAULT_PROVIDER)
    ? PREFERRED_DEFAULT_PROVIDER
    : (providers[0]?.id ?? '');
}

export function providerFor(providers: readonly ModelCatalogProviderDto[], providerId: string): ModelCatalogProviderDto | undefined {
  return providers.find((provider) => provider.id === providerId);
}

/** `'openai/gpt-4o'` → `['openai', 'gpt-4o']`。最初の `/` で分ける（モデル名側の `/` は残す）。 */
export function splitRegistryModel(model: string): readonly [provider: string, name: string] {
  const slash = model.indexOf('/');
  return slash <= 0 ? ['', model] : [model.slice(0, slash), model.slice(slash + 1)];
}

/**
 * 選択肢に、保存済みだがカタログに無いプロバイダを足す。
 *
 * カタログは主要プロバイダだけに絞ってあるので、以前に保存した `openrouter/...` のような
 * 設定はそのままでは選択肢に現れない。黙って別プロバイダへ付け替えると**保存時に設定が化ける**ため、
 * 保存済みの値だけは選択肢として残す（見出しは登録簿を引けないのでIDをそのまま名前にする）。
 */
export function providerOptionsFor(
  providers: readonly ModelCatalogProviderDto[],
  saved: ModelSlotSettingsDto | undefined,
): readonly ModelCatalogProviderDto[] {
  if (saved?.source !== 'registry') return providers;
  const [providerId] = splitRegistryModel(saved.model);
  if (providerId === '' || providers.some((provider) => provider.id === providerId)) return providers;
  return [...providers, { id: providerId, name: providerId, source: 'registry' }];
}

/** 保存済み baseUrl のホストからプリセットを引き当てる（見つからなければ undefined）。 */
export function matchOpenAiCompatibleProvider(providers: readonly ModelCatalogProviderDto[], baseUrl: string): ModelCatalogProviderDto | undefined {
  let host: string;
  try { host = new URL(baseUrl.trim()).hostname.toLowerCase(); } catch { return undefined; }
  return providers.find((provider) => provider.baseUrlHosts?.some((suffix) => host.endsWith(suffix.toLowerCase())) === true);
}

/** OpenAI互換の受け皿（プリセットに当てはまらない宛先の行き先）。 */
function genericCompatProvider(providers: readonly ModelCatalogProviderDto[]): ModelCatalogProviderDto | undefined {
  return providers.find((provider) => provider.id === GENERIC_OPENAI_COMPATIBLE_PROVIDER)
    ?? providers.find((provider) => provider.source === 'openai-compatible' && provider.baseUrlHosts === undefined);
}

/**
 * 保存済み設定（マスク済み）→ フォーム値。未設定（env既定）のスロットは既定プロバイダを選んだ空フォームにする。
 * APIキー入力欄は常に空で始める（平文は保持しない）。
 */
export function toModelSlotForm(slot: ModelSlotSettingsDto | undefined, providers: readonly ModelCatalogProviderDto[]): ModelSlotFormValue {
  if (slot === undefined) return withProvider(EMPTY_MODEL_SLOT_FORM, defaultProviderId(providers), providers);
  if (slot.source === 'registry') {
    const [providerId, name] = splitRegistryModel(slot.model);
    return {
      ...EMPTY_MODEL_SLOT_FORM,
      source: 'registry',
      providerId: providerId === '' ? defaultProviderId(providers) : providerId,
      model: name,
    };
  }
  const preset = matchOpenAiCompatibleProvider(providers, slot.baseUrl) ?? genericCompatProvider(providers);
  return {
    ...EMPTY_MODEL_SLOT_FORM,
    source: 'openai-compatible',
    providerId: preset?.id ?? GENERIC_OPENAI_COMPATIBLE_PROVIDER,
    model: slot.model,
    baseUrl: slot.baseUrl,
  };
}

/**
 * プロバイダを変えたらモデル・取得済み候補・ベースURLを引き継がない（別の宛先の値は無効なため）。
 * OpenAI互換のプロバイダでは baseUrl に雛形を入れておく（`<resource>` は利用者が埋める）。
 * 同じプロバイダを選び直したときは何もしない（入力を消さない）。
 */
export function withProvider(form: ModelSlotFormValue, providerId: string, providers: readonly ModelCatalogProviderDto[]): ModelSlotFormValue {
  if (form.providerId === providerId) return form;
  const provider = providerFor(providers, providerId);
  const source = provider?.source ?? 'registry';
  return {
    ...form,
    providerId,
    source,
    model: '',
    fetchedModels: [],
    baseUrl: source === 'openai-compatible' ? (provider?.baseUrlTemplate ?? '') : '',
  };
}

/**
 * 雛形の穴（`<resource>` など）が残っているか。
 * 残ったまま送ると `new URL()` が弾いて 400 になるだけなので、保存前に画面側で止める。
 */
export function baseUrlHasPlaceholder(baseUrl: string): boolean {
  return /[<>]/.test(baseUrl);
}

/**
 * 取得したモデル一覧を補完候補として反映する。
 * **入力済みのモデル名は上書きしない**（打鍵を巻き戻さない）。空のときだけ先頭を入れて一手減らす。
 */
export function applyFetchedModels(form: ModelSlotFormValue, models: readonly string[]): ModelSlotFormValue {
  return {
    ...form,
    fetchedModels: models,
    model: form.model.trim() === '' ? (models[0] ?? form.model) : form.model,
  };
}

/** 保存・テストに使うモデル文字列。registry は `${providerId}/${model}` へ組み立てる。 */
export function modelSlotModelValue(form: ModelSlotFormValue): string {
  const model = form.model.trim();
  if (form.source !== 'registry') return model;
  return form.providerId === '' || model === '' ? '' : `${form.providerId}/${model}`;
}

/** 保存できない状態（モデル未入力、OpenAI互換でベースURL未入力・雛形のまま）。 */
export function modelSlotSaveBlocked(form: ModelSlotFormValue): boolean {
  if (modelSlotModelValue(form) === '') return true;
  if (form.source !== 'openai-compatible') return false;
  const baseUrl = form.baseUrl.trim();
  return baseUrl === '' || baseUrlHasPlaceholder(baseUrl);
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
 * - `blocked` … 編集済みだが候補として送れない（モデル未入力など）。**押させない**。
 *
 * blocked を押せてしまうと candidate が省かれ、サーバーは保存済み/env既定（ローカルLM Studio）を
 * テストして ok を返す。「Azureを選んだつもりが成功した」という嘘の成功になるため塞ぐ。
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
      'Fill in the model (and the base URL) to test it. The edited values cannot be sent yet, and testing now would only check the saved settings.',
      'モデル（とベースURL）の入力を終えるとテストできます。編集中の値はまだ送れないため、いま実行しても保存済み設定を試すことになります。',
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
 * - 未設定 + openai-compatible: 宛先はローカルにも各社クラウドにもなり得るので、
 *   **特定の環境変数名は案内しない**（LM Studio 決め打ちの案内は Azure 等では誤誘導になる）。
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
  if (source === 'openai-compatible') return text('Not set (leave blank if the endpoint needs no key)', '未設定（キー不要のエンドポイントは空のままでよい）');
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

/** プロバイダ `<option>` のラベル（表示名 + registry が読む環境変数名）。 */
export function providerOptionLabel(provider: ModelCatalogProviderDto, text: Translate): string {
  const name = provider.id === GENERIC_OPENAI_COMPATIBLE_PROVIDER
    ? text('OpenAI-compatible endpoint (LM Studio, vLLM, …)', 'OpenAI互換エンドポイント（LM Studio・vLLM など）')
    : provider.name;
  return provider.envVar === undefined ? name : `${name} · ${provider.envVar}`;
}

/**
 * モデル欄の説明。**固定のモデル名を出さない代わりに、どこを見ればよいかを言う。**
 * 提供元でデプロイ・有効化したモデルしか使えないため、正解を知っているのは提供元だけである。
 */
export function modelFieldNote(text: Translate): string {
  return text(
    'Model names change often, and only models you have deployed or enabled at the provider can be used. Enter the ID shown by your provider.',
    'モデル名は頻繁に変わり、提供元でデプロイ・有効化したモデルしか使えません。提供元に表示されているIDを入力してください。',
  );
}

/** モデル一覧ドキュメントへのリンク文言（docUrl を持つプロバイダのみ）。 */
export function modelDocLinkLabel(provider: ModelCatalogProviderDto, text: Translate): string {
  return text(`${provider.name} model list`, `${provider.name} のモデル一覧`);
}

/** 雛形の穴が残っているときの案内（保存を塞ぐ理由を言う）。 */
export function baseUrlPlaceholderNote(form: ModelSlotFormValue, text: Translate): string | undefined {
  if (form.source !== 'openai-compatible' || !baseUrlHasPlaceholder(form.baseUrl)) return undefined;
  return text(
    'Replace the <…> parts of the base URL with your own resource, region, or project.',
    'ベースURLの <…> の部分を、自分のリソース名・リージョン・プロジェクトに置き換えてください。',
  );
}

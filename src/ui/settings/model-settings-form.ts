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
 */
import { ApiError } from '../api/tool-api';
import type {
  MaskedApiKeyDto,
  ModelCatalogProviderDto,
  ModelSettingsSourceDto,
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
  baseUrl: '',
  compatModel: { value: '', manual: false },
  compatModels: [],
  apiKey: '',
  clearKey: false,
};

function providerOf(providers: readonly ModelCatalogProviderDto[], id: string): ModelCatalogProviderDto | undefined {
  return providers.find((provider) => provider.id === id);
}

/** 選択中プロバイダのモデル候補（未選択・未知プロバイダなら空）。 */
export function providerModels(providers: readonly ModelCatalogProviderDto[], id: string): readonly string[] {
  return providerOf(providers, id)?.models ?? [];
}

/** `'openai/gpt-4o'` → `['openai', 'gpt-4o']`。最初の `/` で分ける（モデル名側の `/` は残す）。 */
export function splitRegistryModel(model: string): readonly [provider: string, name: string] {
  const slash = model.indexOf('/');
  return slash <= 0 ? ['', model] : [model.slice(0, slash), model.slice(slash + 1)];
}

/**
 * 保存済み設定（マスク済み）→ フォーム値。未設定（env既定）のスロットは
 * 先頭プロバイダを選んだ空フォームにする。APIキー入力欄は常に空で始める（平文は保持しない）。
 */
export function toModelSlotForm(slot: ModelSlotSettingsDto | undefined, providers: readonly ModelCatalogProviderDto[]): ModelSlotFormValue {
  const firstProvider = providers[0]?.id ?? '';
  if (slot === undefined) return { ...EMPTY_MODEL_SLOT_FORM, providerId: firstProvider };
  if (slot.source === 'registry') {
    const [providerId, name] = splitRegistryModel(slot.model);
    const resolved = providerId === '' ? firstProvider : providerId;
    return {
      ...EMPTY_MODEL_SLOT_FORM,
      source: 'registry',
      providerId: resolved,
      registryModel: { value: name, manual: !providerModels(providers, resolved).includes(name) },
    };
  }
  return {
    ...EMPTY_MODEL_SLOT_FORM,
    source: 'openai-compatible',
    providerId: firstProvider,
    baseUrl: slot.baseUrl,
    compatModel: { value: slot.model, manual: false },
  };
}

/** プロバイダを変えたらモデル選択はリセットする（別プロバイダの候補は無効なため）。 */
export function withProvider(form: ModelSlotFormValue, providerId: string): ModelSlotFormValue {
  return { ...form, providerId, registryModel: { value: '', manual: false } };
}

/** `<select>` の選択 → モデル入力状態。「手入力」を選んだら値を保ったままテキスト入力へ切り替える。 */
export function selectModelChoice(current: ModelChoiceValue, selected: string): ModelChoiceValue {
  return selected === MANUAL_MODEL_OPTION ? { value: current.value, manual: true } : { value: selected, manual: false };
}

/** `<select>` に表示すべき値（手入力中は番兵値）。 */
export function modelChoiceSelectValue(choice: ModelChoiceValue): string {
  return choice.manual ? MANUAL_MODEL_OPTION : choice.value;
}

/** 取得したモデル一覧を反映する。現在の入力が一覧にあれば維持し、無ければ先頭を選ぶ。 */
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

/** APIキー入力欄のプレースホルダ。保存済みなら「空のままで維持」、未設定なら環境変数名を案内する。 */
export function apiKeyPlaceholder(slot: ModelSlotSettingsDto | undefined, provider: ModelCatalogProviderDto | undefined, text: Translate): string {
  if (slot?.apiKey.configured === true) {
    const hint = slot.apiKey.hint === undefined ? '' : `…${slot.apiKey.hint}`;
    return text(`Saved: ${hint} (leave blank to keep)`, `保存済み: ${hint}（空のままで維持）`);
  }
  if (provider?.envVar === undefined) return text('Not set', '未設定');
  return text(`Not set (env ${provider.envVar} also works)`, `未設定（環境変数 ${provider.envVar} でも可）`);
}

/** 疎通テスト結果の表示文言。成功は latency と応答の先頭を出す。 */
export function modelTestSummary(result: ModelSettingsTestResultDto, text: Translate): string {
  return result.ok ? `ok (${result.latencyMs}ms): ${result.reply}` : result.error === '' ? text('Test failed', 'テストに失敗しました') : result.error;
}

/**
 * 失敗の表示文言。409（鍵ファイル変更などで復号不能）はキー再入力へ誘導する。
 * それ以外は ApiError が既にローカライズ済みの message を持つのでそのまま使う。
 */
export function modelSettingsErrorText(cause: unknown, text: Translate): string {
  if (cause instanceof ApiError && cause.status === 409) {
    return text('The encryption key changed. Enter the API key again, then save.', '鍵が変わっています。APIキーを再入力してください。');
  }
  return cause instanceof Error ? cause.message : text('Request failed', 'リクエストに失敗しました');
}

/** プロバイダ `<option>` のラベル（id + 必要な環境変数名）。 */
export function providerOptionLabel(provider: ModelCatalogProviderDto): string {
  return provider.envVar === undefined ? provider.id : `${provider.id} · ${provider.envVar}`;
}

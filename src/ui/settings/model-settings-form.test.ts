import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/tool-api';
import type { ModelCatalogProviderDto, ModelSlotSettingsDto } from '../api/types';
import {
  EMPTY_MODEL_SLOT_FORM, MANUAL_MODEL_OPTION, apiKeyPlaceholder, applyFetchedModels, applyRegistryModels,
  defaultProviderId, localizeModelTestError, modelChoiceSelectValue, modelSettingsErrorText, modelSlotFormEdited,
  modelSlotSaveBlocked, modelSlotModelValue, modelSlotSummary, modelTestMode, modelTestModeNote, modelTestSummary,
  providerOptionLabel, selectModelChoice, shouldWarnStoredKeyUnused, splitRegistryModel, storageWarning,
  storedKeyUnusedNote, toModelSlotForm, toModelSlotInput, withProvider,
} from './model-settings-form';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

// v36のカタログは2段構成。見出し（このDTO）はモデル一覧を持たず modelCount だけを返す。
const providers: readonly ModelCatalogProviderDto[] = [
  { id: '302ai', name: '302.AI', envVar: 'AI302_API_KEY', modelCount: 12 },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', modelCount: 2 },
  { id: 'local', name: 'Local', modelCount: 1 },
];
const openaiModels = ['gpt-4o', 'gpt-4o-mini'];

describe('モデル設定フォームの値変換', () => {
  it('未設定スロットは既定プロバイダを選んだ空フォームになる', () => {
    expect(toModelSlotForm(undefined, providers)).toEqual({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' });
    // カタログが空でも壊れない（プロバイダ未選択のまま）。
    expect(toModelSlotForm(undefined, [])).toEqual(EMPTY_MODEL_SLOT_FORM);
  });

  it('既定プロバイダは name昇順の先頭（302ai）ではなく openai を優先する', () => {
    expect(defaultProviderId(providers)).toBe('openai');
    // openai が無いカタログでは先頭へフォールバックする。
    expect(defaultProviderId([{ id: '302ai', name: '302.AI', modelCount: 1 }])).toBe('302ai');
    expect(defaultProviderId([])).toBe('');
  });

  it('registry設定は provider/model を分解する（手入力判定は一覧取得後に決まる）', () => {
    const known: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } };
    expect(toModelSlotForm(known, providers)).toMatchObject({ source: 'registry', providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false }, registryModels: [] });

    // provider を欠いた壊れた値でも既定プロバイダへフォールバックする（手入力で直せる）。
    const broken: ModelSlotSettingsDto = { source: 'registry', model: 'gpt-4o', apiKey: { configured: false } };
    expect(toModelSlotForm(broken, providers)).toMatchObject({ providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } });
  });

  it('openai-compatible設定はbaseUrlとモデル名をそのまま持つ', () => {
    const slot: ModelSlotSettingsDto = { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b', apiKey: { configured: false } };
    expect(toModelSlotForm(slot, providers)).toMatchObject({
      source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', compatModel: { value: 'qwen/qwen3-4b', manual: false },
    });
  });

  it('splitRegistryModelは最初の / だけで分ける', () => {
    expect(splitRegistryModel('openai/gpt-4o')).toEqual(['openai', 'gpt-4o']);
    expect(splitRegistryModel('vendor/family/model')).toEqual(['vendor', 'family/model']);
    expect(splitRegistryModel('/leading')).toEqual(['', '/leading']);
  });

  it('プロバイダ変更はモデル選択と取得済み候補をリセットする', () => {
    const form = applyRegistryModels({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } }, openaiModels);
    expect(withProvider(form, 'local')).toMatchObject({ providerId: 'local', registryModel: { value: '', manual: false }, registryModels: [] });
    // 同じプロバイダの選び直しは無視する（再取得が走らないので候補を消すと戻せない）。
    expect(withProvider(form, 'openai')).toBe(form);
  });

  it('取得したプロバイダのモデル一覧は現在値を保ち、一覧に無ければ手入力へ倒す', () => {
    const saved = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } };
    expect(applyRegistryModels(saved, openaiModels)).toMatchObject({ registryModels: openaiModels, registryModel: { value: 'gpt-4o', manual: false } });

    const unknown = { ...saved, registryModel: { value: 'gpt-5-preview', manual: false } };
    expect(applyRegistryModels(unknown, openaiModels).registryModel).toEqual({ value: 'gpt-5-preview', manual: true });

    // 未選択（空）は手入力にしない。
    expect(applyRegistryModels({ ...saved, registryModel: { value: '', manual: false } }, openaiModels).registryModel).toEqual({ value: '', manual: false });
    // 手入力中に一覧が届いても手入力のまま（打鍵を巻き戻さない）。
    expect(applyRegistryModels({ ...saved, registryModel: { value: 'gpt-4o', manual: true } }, openaiModels).registryModel).toEqual({ value: 'gpt-4o', manual: true });
    // 取得に失敗した（空一覧）ときも現在値は消さない。
    expect(applyRegistryModels(saved, []).registryModel).toEqual({ value: 'gpt-4o', manual: true });
  });

  it('「手入力」選択は現在値を保ったままテキスト入力へ切り替える', () => {
    expect(selectModelChoice({ value: 'gpt-4o', manual: false }, MANUAL_MODEL_OPTION)).toEqual({ value: 'gpt-4o', manual: true });
    expect(selectModelChoice({ value: 'gpt-4o', manual: true }, 'gpt-4o-mini')).toEqual({ value: 'gpt-4o-mini', manual: false });
    expect(modelChoiceSelectValue({ value: 'gpt-4o', manual: true })).toBe(MANUAL_MODEL_OPTION);
    expect(modelChoiceSelectValue({ value: 'gpt-4o', manual: false })).toBe('gpt-4o');
  });

  it('取得したモデル一覧は現在の入力を維持し、無ければ先頭を選ぶ', () => {
    const form = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, compatModel: { value: 'b', manual: true } };
    expect(applyFetchedModels(form, ['a', 'b'])).toMatchObject({ compatModels: ['a', 'b'], compatModel: { value: 'b', manual: false } });
    expect(applyFetchedModels(form, ['x', 'y']).compatModel).toEqual({ value: 'x', manual: false });
    // 0件なら現在値を消さない（手入力を続けられる）。
    expect(applyFetchedModels(form, []).compatModel).toEqual({ value: 'b', manual: false });
  });

  it('モデル文字列は registry のとき provider/model へ組み立てる', () => {
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: ' gpt-4o ', manual: true } })).toBe('openai/gpt-4o');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: '', registryModel: { value: 'gpt-4o', manual: false } })).toBe('');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' })).toBe('');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible', compatModel: { value: ' qwen ', manual: false } })).toBe('qwen');
  });

  it('モデル未指定・OpenAI互換のbaseUrl未入力は保存できない', () => {
    expect(modelSlotSaveBlocked(EMPTY_MODEL_SLOT_FORM)).toBe(true);
    expect(modelSlotSaveBlocked({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } })).toBe(false);
    const compat = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, compatModel: { value: 'qwen', manual: false } };
    expect(modelSlotSaveBlocked(compat)).toBe(true);
    expect(modelSlotSaveBlocked({ ...compat, baseUrl: ' http://127.0.0.1:1234/v1 ' })).toBe(false);
  });

  it('apiKeyは入力ありのときだけ平文で送り、空は省略・削除指定は空文字にする', () => {
    const registry = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } };
    expect(toModelSlotInput(registry)).toEqual({ source: 'registry', model: 'openai/gpt-4o' });
    expect(toModelSlotInput({ ...registry, apiKey: 'sk-secret' })).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-secret' });
    expect(toModelSlotInput({ ...registry, apiKey: 'sk-secret', clearKey: true })).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: '' });

    const compat = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, baseUrl: ' http://127.0.0.1:1234/v1 ', compatModel: { value: 'qwen', manual: false } };
    expect(toModelSlotInput(compat)).toEqual({ source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' });
  });
});

describe('テストボタンが何を試すか（嘘の成功を防ぐ）', () => {
  const savedRegistry: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } };
  const savedCompat: ModelSlotSettingsDto = { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen', apiKey: { configured: false } };

  it('未設定スロットの未編集フォームは「env既定をテスト」になる', () => {
    const form = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' };
    expect(modelSlotFormEdited(form, undefined)).toBe(false);
    expect(modelTestMode(form, undefined)).toBe('saved');
    expect(modelTestModeNote('saved', undefined, ja)).toContain('環境変数の既定');
  });

  it('保存済みと同じ値なら「保存済み設定をテスト」、送れる入力なら候補をテストする', () => {
    const same = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } };
    expect(modelSlotFormEdited(same, savedRegistry)).toBe(false);
    // 送れる形なので候補として送る（結果として保存済みと同じ宛先）。
    expect(modelTestMode(same, savedRegistry)).toBe('candidate');
    expect(modelTestModeNote('candidate', savedRegistry, ja)).toBeUndefined();

    const blank = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' };
    expect(modelTestMode(blank, undefined)).toBe('saved');
    expect(modelTestModeNote('saved', savedRegistry, en)).toContain('saved settings');
  });

  it('編集済みなのに候補として送れないフォームは blocked（=ボタンを塞ぐ）', () => {
    // プロバイダだけ変えてモデル未選択: 送ると保存済みLM Studioが ok を返し「嘘の成功」になる。
    const switched = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'anthropic' };
    expect(modelSlotFormEdited(switched, savedRegistry)).toBe(true);
    expect(modelTestMode(switched, savedRegistry)).toBe('blocked');
    expect(modelTestModeNote('blocked', savedRegistry, ja)).toContain('モデルの選択を完了');
    expect(modelTestModeNote('blocked', savedRegistry, en)).toContain('cannot be sent');

    // ソースを変えただけ（baseUrl・モデル未入力）も blocked。
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' }, undefined)).toBe('blocked');
    // キーだけ入力してモデル未選択も blocked。
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', apiKey: 'sk-x' }, undefined)).toBe('blocked');
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', clearKey: true }, undefined)).toBe('blocked');
  });

  it('openai-compatible の編集判定はbaseUrlの差も見る', () => {
    const same = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1234/v1', compatModel: { value: 'qwen', manual: false } };
    expect(modelSlotFormEdited(same, savedCompat)).toBe(false);
    expect(modelSlotFormEdited({ ...same, baseUrl: 'https://api.openai.com/v1' }, savedCompat)).toBe(true);
    expect(modelSlotFormEdited({ ...same, compatModel: { value: 'other', manual: false } }, savedCompat)).toBe(true);
    // ソース違いも編集済み。
    expect(modelSlotFormEdited({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } }, savedCompat)).toBe(true);
  });
});

describe('保存済みキーが使われなかったときの注記', () => {
  const savedWithKey: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } };
  const form = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'anthropic', registryModel: { value: 'claude', manual: false } };

  it('保存済みキーがあるのに使われなかったときだけ注記する', () => {
    expect(shouldWarnStoredKeyUnused(false, form, savedWithKey)).toBe(true);
    expect(storedKeyUnusedNote(ja)).toContain('保存済みキーは使用しませんでした');
    expect(storedKeyUnusedNote(en)).toContain('saved API key was not used');
  });

  it('キーを使った・自分で入力した・そもそも保存済みキーが無いときは注記しない', () => {
    expect(shouldWarnStoredKeyUnused(true, form, savedWithKey)).toBe(false);
    expect(shouldWarnStoredKeyUnused(false, { ...form, apiKey: 'sk-typed' }, savedWithKey)).toBe(false);
    expect(shouldWarnStoredKeyUnused(false, { ...form, clearKey: true }, savedWithKey)).toBe(false);
    expect(shouldWarnStoredKeyUnused(false, form, undefined)).toBe(false);
    expect(shouldWarnStoredKeyUnused(false, form, { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } })).toBe(false);
  });
});

describe('モデル設定フォームの表示文言', () => {
  it('未設定はenv既定、設定済みはモデルとキーヒントを示す', () => {
    expect(modelSlotSummary(undefined, en)).toContain('environment default');
    expect(modelSlotSummary(undefined, ja)).toContain('環境変数の既定');
    expect(modelSlotSummary({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } }, en)).toBe('Saved: openai/gpt-4o (key: …abcd)');
    expect(modelSlotSummary({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, ja)).toBe('保存済み: openai/gpt-4o（キー: 設定済み）');
    expect(modelSlotSummary({ source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen', apiKey: { configured: false } }, en))
      .toBe('Saved: qwen @ http://127.0.0.1:1234/v1 (key: not set)');
  });

  it('APIキーのプレースホルダは保存済みなら維持、未設定なら環境変数名を案内する', () => {
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } }, providers[1], 'registry', en)).toBe('Saved: …abcd (leave blank to keep)');
    // 4文字以下のキーは hint が付かない。空のヒントを出さない。
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, providers[1], 'registry', en)).toBe('Saved (leave blank to keep)');
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, providers[1], 'registry', ja)).toBe('保存済み（空のままで維持）');
    expect(apiKeyPlaceholder(undefined, providers[1], 'registry', ja)).toBe('未設定（環境変数 OPENAI_API_KEY でも可）');
    expect(apiKeyPlaceholder(undefined, providers[2], 'registry', en)).toBe('Not set');
    expect(apiKeyPlaceholder(undefined, undefined, 'registry', en)).toBe('Not set');
  });

  it('OpenAI互換モードでは選択中プロバイダの環境変数を案内しない', () => {
    // 宛先はローカルのOpenAI互換サーバーなので OPENAI_API_KEY の案内は誤誘導。
    expect(apiKeyPlaceholder(undefined, providers[1], 'openai-compatible', en)).toBe('Not set (env LM_STUDIO_API_KEY also works)');
    expect(apiKeyPlaceholder(undefined, providers[1], 'openai-compatible', ja)).toBe('未設定（環境変数 LM_STUDIO_API_KEY でも可）');
  });

  it('プロバイダのoptionラベルはidと必要な環境変数名を出す', () => {
    expect(providerOptionLabel({ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', modelCount: 2 })).toBe('openai · OPENAI_API_KEY');
    expect(providerOptionLabel({ id: 'local', name: 'Local', modelCount: 0 })).toBe('local');
  });

  it('疎通テストの結果は成功でlatencyと応答、失敗でエラー文を出す', () => {
    expect(modelTestSummary({ ok: true, latencyMs: 1234, reply: 'pong', usedStoredKey: true }, en)).toBe('ok (1234ms): pong');
    expect(modelTestSummary({ ok: false, error: 'HTTP 401', usedStoredKey: false }, en)).toBe('HTTP 401');
    expect(modelTestSummary({ ok: false, error: '', usedStoredKey: false }, ja)).toBe('テストに失敗しました');
  });

  it('テスト失敗の頻出パターンは日本語化し、未知は原文のまま出す', () => {
    // 200 + ok:false なので localizeApiErrorMessage を通らない。ここで日本語にする。
    expect(localizeModelTestError('Stored secret could not be decrypted', ja)).toContain('復号できませんでした');
    expect(localizeModelTestError('Model request failed with HTTP 401', ja)).toContain('認証に失敗しました');
    expect(localizeModelTestError('request timed out', ja)).toContain('タイムアウト');
    expect(localizeModelTestError('connect ECONNREFUSED 127.0.0.1:1234', ja)).toContain('接続できませんでした');
    // 原文は括弧で残す（詳細を握りつぶさない）。
    expect(localizeModelTestError('connect ECONNREFUSED 127.0.0.1:1234', ja)).toContain('connect ECONNREFUSED 127.0.0.1:1234');
    // 未知・英語UIは原文のまま。
    expect(localizeModelTestError('something odd happened', ja)).toBe('something odd happened');
    expect(localizeModelTestError('connect ECONNREFUSED', en)).toBe('connect ECONNREFUSED');
    expect(localizeModelTestError('   ', ja)).toBe('テストに失敗しました');
  });

  it('揮発ストレージのときだけ再起動で消える旨を警告する', () => {
    expect(storageWarning('ephemeral', ja)).toContain('AGENTCONTEXT_DB_PATH');
    expect(storageWarning('ephemeral', en)).toContain('ephemeral storage');
    expect(storageWarning('persistent', ja)).toBeUndefined();
    expect(storageWarning(undefined, ja)).toBeUndefined();
  });

  it('SECRET_CIPHERは409（再入力で直る）と500（鍵ファイル不正）で文言を分ける', () => {
    expect(modelSettingsErrorText(new ApiError(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted'), ja)).toBe('保存済みAPIキーを復号できません。APIキーを再入力してください。');
    expect(modelSettingsErrorText(new ApiError(500, 'SECRET_CIPHER', 'key file unavailable'), ja)).toContain('AGENTCONTEXT_SECRET_KEY_PATH');
    expect(modelSettingsErrorText(new ApiError(500, 'SECRET_CIPHER', 'key file unavailable'), en)).toContain('will not fix this');
    // 500でも他コードならローカライズ済みmessageをそのまま使う。
    expect(modelSettingsErrorText(new ApiError(500, 'INTERNAL', 'internal error'), en)).toContain('internal error');
    expect(modelSettingsErrorText(new ApiError(409, 'HTTP_ERROR', 'Conflict'), en)).toContain('Enter the API key again');
    expect(modelSettingsErrorText(new Error('boom'), en)).toBe('boom');
    expect(modelSettingsErrorText('not an error', ja)).toBe('リクエストに失敗しました');
  });
});

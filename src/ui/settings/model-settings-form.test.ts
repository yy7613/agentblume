import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/tool-api';
import type { ModelCatalogProviderDto, ModelSlotSettingsDto } from '../api/types';
import {
  EMPTY_MODEL_SLOT_FORM, MANUAL_MODEL_OPTION, apiKeyPlaceholder, applyFetchedModels, modelChoiceSelectValue,
  modelSettingsErrorText, modelSlotSaveBlocked, modelSlotModelValue, modelSlotSummary, modelTestSummary,
  providerModels, providerOptionLabel, selectModelChoice, splitRegistryModel, toModelSlotForm, toModelSlotInput,
  withProvider,
} from './model-settings-form';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

const providers: readonly ModelCatalogProviderDto[] = [
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'local', name: 'Local', models: ['tiny'] },
];

describe('モデル設定フォームの値変換', () => {
  it('未設定スロットは先頭プロバイダを選んだ空フォームになる', () => {
    expect(toModelSlotForm(undefined, providers)).toEqual({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' });
    // カタログが空でも壊れない（プロバイダ未選択のまま）。
    expect(toModelSlotForm(undefined, [])).toEqual(EMPTY_MODEL_SLOT_FORM);
  });

  it('registry設定は provider/model を分解し、カタログに無いモデルは手入力状態にする', () => {
    const known: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } };
    expect(toModelSlotForm(known, providers)).toMatchObject({ source: 'registry', providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } });

    const unknown: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-5-preview', apiKey: { configured: false } };
    expect(toModelSlotForm(unknown, providers).registryModel).toEqual({ value: 'gpt-5-preview', manual: true });

    // provider を欠いた壊れた値でも先頭プロバイダへフォールバックする（手入力で直せる）。
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

  it('プロバイダ変更はモデル選択をリセットする', () => {
    const form = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', registryModel: { value: 'gpt-4o', manual: false } };
    expect(withProvider(form, 'local')).toMatchObject({ providerId: 'local', registryModel: { value: '', manual: false } });
    expect(providerModels(providers, 'local')).toEqual(['tiny']);
    expect(providerModels(providers, 'missing')).toEqual([]);
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
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } }, providers[0], en)).toBe('Saved: …abcd (leave blank to keep)');
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, providers[0], en)).toBe('Saved:  (leave blank to keep)');
    expect(apiKeyPlaceholder(undefined, providers[0], ja)).toBe('未設定（環境変数 OPENAI_API_KEY でも可）');
    expect(apiKeyPlaceholder(undefined, providers[1], en)).toBe('Not set');
    expect(apiKeyPlaceholder(undefined, undefined, en)).toBe('Not set');
  });

  it('プロバイダのoptionラベルはidと必要な環境変数名を出す', () => {
    expect(providerOptionLabel({ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: [] })).toBe('openai · OPENAI_API_KEY');
    expect(providerOptionLabel({ id: 'local', name: 'Local', models: [] })).toBe('local');
  });

  it('疎通テストの結果は成功でlatencyと応答、失敗でエラー文を出す', () => {
    expect(modelTestSummary({ ok: true, latencyMs: 1234, reply: 'pong' }, en)).toBe('ok (1234ms): pong');
    expect(modelTestSummary({ ok: false, error: 'HTTP 401' }, en)).toBe('HTTP 401');
    expect(modelTestSummary({ ok: false, error: '' }, ja)).toBe('テストに失敗しました');
  });

  it('409は鍵の変更としてキー再入力を促し、他はApiErrorのローカライズ済みmessageを使う', () => {
    expect(modelSettingsErrorText(new ApiError(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted'), ja)).toBe('鍵が変わっています。APIキーを再入力してください。');
    expect(modelSettingsErrorText(new ApiError(409, 'HTTP_ERROR', 'Conflict'), en)).toContain('Enter the API key again');
    expect(modelSettingsErrorText(new Error('boom'), en)).toBe('boom');
    expect(modelSettingsErrorText('not an error', ja)).toBe('リクエストに失敗しました');
  });
});

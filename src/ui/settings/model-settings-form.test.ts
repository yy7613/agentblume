import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/tool-api';
import type { ModelCatalogProviderDto, ModelSlotSettingsDto } from '../api/types';
import {
  EMPTY_MODEL_SLOT_FORM, apiKeyPlaceholder, applyFetchedModels, baseUrlHasPlaceholder, baseUrlPlaceholderNote,
  defaultProviderId, localizeModelTestError, matchOpenAiCompatibleProvider, modelDocLinkLabel, modelFieldNote,
  modelSettingsErrorText, modelSlotFormEdited, modelSlotSaveBlocked, modelSlotModelValue, modelSlotSummary,
  modelTestMode, modelTestModeNote, modelTestSummary, providerFor, providerOptionLabel, providerOptionsFor,
  shouldWarnStoredKeyUnused, splitRegistryModel, storageWarning, storedKeyUnusedNote, toModelSlotForm,
  toModelSlotInput, withProvider,
} from './model-settings-form';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

/** カタログは主要プロバイダの見出しだけを返す（モデル名は含まない）。 */
const providers: readonly ModelCatalogProviderDto[] = [
  { id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY', docUrl: 'https://platform.openai.com/docs/models' },
  { id: 'anthropic', name: 'Anthropic', source: 'registry', envVar: 'ANTHROPIC_API_KEY' },
  {
    id: 'azure-ai-foundry', name: 'Microsoft Azure AI Foundry', source: 'openai-compatible',
    baseUrlTemplate: 'https://<resource>.services.ai.azure.com/openai/v1', baseUrlHosts: ['.services.ai.azure.com'],
    docUrl: 'https://learn.microsoft.com/azure/ai-foundry/concepts/models-featured',
  },
  { id: 'openai-compatible', name: 'OpenAI-compatible endpoint', source: 'openai-compatible', baseUrlTemplate: 'http://127.0.0.1:1234/v1' },
];

describe('モデル設定フォームの値変換', () => {
  it('未設定スロットは既定プロバイダを選んだ空フォームになる', () => {
    expect(toModelSlotForm(undefined, providers)).toEqual({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', source: 'registry' });
    // カタログが空でも壊れない（プロバイダ未選択のまま）。
    expect(toModelSlotForm(undefined, [])).toEqual(EMPTY_MODEL_SLOT_FORM);
  });

  it('既定プロバイダは openai を優先し、無ければ先頭へ落ちる', () => {
    expect(defaultProviderId(providers)).toBe('openai');
    expect(defaultProviderId([{ id: 'anthropic', name: 'Anthropic', source: 'registry' }])).toBe('anthropic');
    expect(defaultProviderId([])).toBe('');
  });

  it('registry設定は provider/model を分解する', () => {
    const known: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } };
    expect(toModelSlotForm(known, providers)).toMatchObject({ source: 'registry', providerId: 'openai', model: 'gpt-4o', fetchedModels: [] });

    // provider を欠いた壊れた値でも既定プロバイダへフォールバックする（手入力で直せる）。
    const broken: ModelSlotSettingsDto = { source: 'registry', model: 'gpt-4o', apiKey: { configured: false } };
    expect(toModelSlotForm(broken, providers)).toMatchObject({ providerId: 'openai', model: 'gpt-4o' });
  });

  it('openai-compatible設定はホストからプリセットを引き当てる', () => {
    const azure: ModelSlotSettingsDto = { source: 'openai-compatible', baseUrl: 'https://contoso.services.ai.azure.com/openai/v1', model: 'my-gpt-deployment', apiKey: { configured: false } };
    expect(toModelSlotForm(azure, providers)).toMatchObject({
      source: 'openai-compatible', providerId: 'azure-ai-foundry', baseUrl: 'https://contoso.services.ai.azure.com/openai/v1', model: 'my-gpt-deployment',
    });

    // どのプリセットにも当てはまらない宛先は受け皿（汎用のOpenAI互換）になる。
    const local: ModelSlotSettingsDto = { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b', apiKey: { configured: false } };
    expect(toModelSlotForm(local, providers)).toMatchObject({ providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' });
  });

  it('ホスト一致は接尾辞で見る（URLとして壊れていれば一致しない）', () => {
    expect(matchOpenAiCompatibleProvider(providers, 'https://CONTOSO.SERVICES.AI.AZURE.COM/openai/v1')?.id).toBe('azure-ai-foundry');
    expect(matchOpenAiCompatibleProvider(providers, 'https://example.com/v1')).toBeUndefined();
    expect(matchOpenAiCompatibleProvider(providers, 'not a url')).toBeUndefined();
  });

  it('カタログに無い保存済みプロバイダは選択肢として残す（保存時に化けさせない）', () => {
    const legacy: ModelSlotSettingsDto = { source: 'registry', model: 'openrouter/qwen3', apiKey: { configured: false } };
    const options = providerOptionsFor(providers, legacy);
    expect(options.map((provider) => provider.id)).toContain('openrouter');
    expect(providerFor(options, 'openrouter')).toMatchObject({ id: 'openrouter', name: 'openrouter', source: 'registry' });
    expect(toModelSlotForm(legacy, options)).toMatchObject({ providerId: 'openrouter', model: 'qwen3' });
    // 保存時も選択がそのまま復元される。
    expect(modelSlotModelValue(toModelSlotForm(legacy, options))).toBe('openrouter/qwen3');

    // カタログにあるプロバイダ・openai-compatible・未設定では足さない。
    expect(providerOptionsFor(providers, { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } })).toBe(providers);
    expect(providerOptionsFor(providers, { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'x', apiKey: { configured: false } })).toBe(providers);
    expect(providerOptionsFor(providers, undefined)).toBe(providers);
    expect(providerOptionsFor(providers, { source: 'registry', model: 'no-slash', apiKey: { configured: false } })).toBe(providers);
  });

  it('splitRegistryModelは最初の / だけで分ける', () => {
    expect(splitRegistryModel('openai/gpt-4o')).toEqual(['openai', 'gpt-4o']);
    expect(splitRegistryModel('vendor/family/model')).toEqual(['vendor', 'family/model']);
    expect(splitRegistryModel('/leading')).toEqual(['', '/leading']);
  });

  it('プロバイダ変更はモデル・候補・ベースURLを引き継がず、雛形を入れる', () => {
    const form = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: 'gpt-4o' };
    expect(withProvider(form, 'azure-ai-foundry', providers)).toEqual({
      ...EMPTY_MODEL_SLOT_FORM, providerId: 'azure-ai-foundry', source: 'openai-compatible',
      baseUrl: 'https://<resource>.services.ai.azure.com/openai/v1',
    });
    // OpenAI互換 → registry ではベースURLを捨てる。
    const compat = withProvider(form, 'openai-compatible', providers);
    expect(withProvider(compat, 'anthropic', providers)).toEqual({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'anthropic', source: 'registry' });
    // 同じプロバイダの選び直しは何もしない（入力を消さない）。
    expect(withProvider(form, 'openai', providers)).toBe(form);
    // 未知のプロバイダは registry 扱い（保存済みの旧設定を選び直せる）。
    expect(withProvider(form, 'openrouter', providers)).toMatchObject({ providerId: 'openrouter', source: 'registry', baseUrl: '' });
  });

  it('取得したモデル候補は入力済みの値を上書きしない（空のときだけ先頭を入れる）', () => {
    const form = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, providerId: 'openai-compatible', model: 'typed-by-hand' };
    expect(applyFetchedModels(form, ['a', 'b'])).toMatchObject({ fetchedModels: ['a', 'b'], model: 'typed-by-hand' });
    expect(applyFetchedModels({ ...form, model: '' }, ['a', 'b']).model).toBe('a');
    // 0件でも現在値は消さない。
    expect(applyFetchedModels(form, [])).toMatchObject({ fetchedModels: [], model: 'typed-by-hand' });
  });

  it('モデル文字列は registry のとき provider/model へ組み立てる', () => {
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: ' gpt-4o ' })).toBe('openai/gpt-4o');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: '', model: 'gpt-4o' })).toBe('');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' })).toBe('');
    expect(modelSlotModelValue({ ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible', model: ' qwen ' })).toBe('qwen');
  });

  it('モデル未入力・ベースURL未入力・雛形の穴が残っている間は保存できない', () => {
    expect(modelSlotSaveBlocked(EMPTY_MODEL_SLOT_FORM)).toBe(true);
    expect(modelSlotSaveBlocked({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: 'gpt-4o' })).toBe(false);

    const compat = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, providerId: 'openai-compatible', model: 'qwen' };
    expect(modelSlotSaveBlocked(compat)).toBe(true);
    expect(modelSlotSaveBlocked({ ...compat, baseUrl: ' http://127.0.0.1:1234/v1 ' })).toBe(false);
    // 雛形のまま送ると 400 になるだけなので画面側で止める。
    expect(modelSlotSaveBlocked({ ...compat, baseUrl: 'https://<resource>.services.ai.azure.com/openai/v1' })).toBe(true);
    expect(baseUrlHasPlaceholder('https://<resource>.services.ai.azure.com/openai/v1')).toBe(true);
    expect(baseUrlHasPlaceholder('https://contoso.services.ai.azure.com/openai/v1')).toBe(false);
  });

  it('雛形の穴が残っているときだけ置き換えを促す', () => {
    const compat = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, baseUrl: 'https://<resource>.services.ai.azure.com/openai/v1' };
    expect(baseUrlPlaceholderNote(compat, ja)).toContain('置き換えて');
    expect(baseUrlPlaceholderNote(compat, en)).toContain('Replace the <…> parts');
    expect(baseUrlPlaceholderNote({ ...compat, baseUrl: 'https://contoso.services.ai.azure.com/openai/v1' }, ja)).toBeUndefined();
    expect(baseUrlPlaceholderNote({ ...EMPTY_MODEL_SLOT_FORM, baseUrl: '<x>' }, ja)).toBeUndefined();
  });

  it('apiKeyは入力ありのときだけ平文で送り、空は省略・削除指定は空文字にする', () => {
    const registry = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: 'gpt-4o' };
    expect(toModelSlotInput(registry)).toEqual({ source: 'registry', model: 'openai/gpt-4o' });
    expect(toModelSlotInput({ ...registry, apiKey: 'sk-secret' })).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-secret' });
    expect(toModelSlotInput({ ...registry, apiKey: 'sk-secret', clearKey: true })).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: '' });

    const compat = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, baseUrl: ' http://127.0.0.1:1234/v1 ', model: 'qwen' };
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
    const same = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: 'gpt-4o' };
    expect(modelSlotFormEdited(same, savedRegistry)).toBe(false);
    // 送れる形なので候補として送る（結果として保存済みと同じ宛先）。
    expect(modelTestMode(same, savedRegistry)).toBe('candidate');
    expect(modelTestModeNote('candidate', savedRegistry, ja)).toBeUndefined();

    const blank = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai' };
    expect(modelTestMode(blank, undefined)).toBe('saved');
    expect(modelTestModeNote('saved', savedRegistry, en)).toContain('saved settings');
  });

  it('編集済みなのに候補として送れないフォームは blocked（=ボタンを塞ぐ）', () => {
    // プロバイダだけ変えてモデル未入力: 送ると保存済みLM Studioが ok を返し「嘘の成功」になる。
    const switched = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'anthropic' };
    expect(modelSlotFormEdited(switched, savedRegistry)).toBe(true);
    expect(modelTestMode(switched, savedRegistry)).toBe('blocked');
    expect(modelTestModeNote('blocked', savedRegistry, ja)).toContain('モデル（とベースURL）の入力');
    expect(modelTestModeNote('blocked', savedRegistry, en)).toContain('cannot be sent');

    // OpenAI互換へ切り替えただけ（モデル未入力）も blocked。
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' }, undefined)).toBe('blocked');
    // ベースURLが雛形のままなら、モデルを入れても blocked。
    const template = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, providerId: 'azure-ai-foundry', model: 'my-deployment', baseUrl: 'https://<resource>.services.ai.azure.com/openai/v1' };
    expect(modelTestMode(template, undefined)).toBe('blocked');
    // キーだけ入力してモデル未入力も blocked。
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', apiKey: 'sk-x' }, undefined)).toBe('blocked');
    expect(modelTestMode({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', clearKey: true }, undefined)).toBe('blocked');
  });

  it('openai-compatible の編集判定はbaseUrlの差も見る', () => {
    const same = { ...EMPTY_MODEL_SLOT_FORM, source: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' };
    expect(modelSlotFormEdited(same, savedCompat)).toBe(false);
    expect(modelSlotFormEdited({ ...same, baseUrl: 'https://api.openai.com/v1' }, savedCompat)).toBe(true);
    expect(modelSlotFormEdited({ ...same, model: 'other' }, savedCompat)).toBe(true);
    // ソース違いも編集済み。
    expect(modelSlotFormEdited({ ...EMPTY_MODEL_SLOT_FORM, providerId: 'openai', model: 'gpt-4o' }, savedCompat)).toBe(true);
  });
});

describe('保存済みキーが使われなかったときの注記', () => {
  const savedWithKey: ModelSlotSettingsDto = { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } };
  const form = { ...EMPTY_MODEL_SLOT_FORM, providerId: 'anthropic', model: 'claude' };

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
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true, hint: 'abcd' } }, providers[0], 'registry', en)).toBe('Saved: …abcd (leave blank to keep)');
    // 4文字以下のキーは hint が付かない。空のヒントを出さない。
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, providers[0], 'registry', en)).toBe('Saved (leave blank to keep)');
    expect(apiKeyPlaceholder({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: true } }, providers[0], 'registry', ja)).toBe('保存済み（空のままで維持）');
    expect(apiKeyPlaceholder(undefined, providers[0], 'registry', ja)).toBe('未設定（環境変数 OPENAI_API_KEY でも可）');
    expect(apiKeyPlaceholder(undefined, providers[3], 'registry', en)).toBe('Not set');
    expect(apiKeyPlaceholder(undefined, undefined, 'registry', en)).toBe('Not set');
  });

  it('OpenAI互換モードでは特定の環境変数名を案内しない（宛先がクラウドにもローカルにもなり得る）', () => {
    expect(apiKeyPlaceholder(undefined, providers[2], 'openai-compatible', en)).toBe('Not set (leave blank if the endpoint needs no key)');
    expect(apiKeyPlaceholder(undefined, providers[0], 'openai-compatible', ja)).toBe('未設定（キー不要のエンドポイントは空のままでよい）');
  });

  it('プロバイダのoptionラベルは表示名と環境変数名を出し、汎用の受け皿は言語に合わせる', () => {
    expect(providerOptionLabel(providers[0]!, en)).toBe('OpenAI · OPENAI_API_KEY');
    expect(providerOptionLabel(providers[2]!, en)).toBe('Microsoft Azure AI Foundry');
    expect(providerOptionLabel(providers[3]!, en)).toBe('OpenAI-compatible endpoint (LM Studio, vLLM, …)');
    expect(providerOptionLabel(providers[3]!, ja)).toBe('OpenAI互換エンドポイント（LM Studio・vLLM など）');
  });

  it('モデル欄の注記は固定のモデル名を出さず、提供元を見るよう促す', () => {
    expect(modelFieldNote(ja)).toContain('デプロイ・有効化したモデルしか使えません');
    expect(modelFieldNote(en)).toContain('only models you have deployed or enabled');
    expect(modelDocLinkLabel(providers[0]!, ja)).toBe('OpenAI のモデル一覧');
    expect(modelDocLinkLabel(providers[2]!, en)).toBe('Microsoft Azure AI Foundry model list');
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

/**
 * 契約の組み立て（composeContract）の機能フラグ。LLM の可否は「設定の有無」と「能力」で決め、test プロファイルは使えない側へ倒す。
 */
import { describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import type { ModelCapability } from '../application/model/model-provider';
import { NOOP_LOGGER } from '../application/operations/logger';
import { NoopUnitOfWork } from '../application/persistence/unit-of-work';
import type { BusinessCompositionContext } from './business';
import { composeContract } from './contract';

function context(overrides: Partial<BusinessCompositionContext> = {}): BusinessCompositionContext {
  return {
    profile: 'local',
    pickRepository: (_sqlite, memory) => memory(),
    unitOfWork: new NoopUnitOfWork(),
    modelProvider: new ScriptedModelProvider(),
    mainModelConfigured: async () => true,
    mainModelCapabilities: async () => ['chat', 'structured-output', 'vision'],
    errorLogger: NOOP_LOGGER,
    ...overrides,
  };
}

describe('composeContract: 機能フラグ', () => {
  it('正常: モデルが設定済みで構造化出力と画像読取があれば、抽出・文字起こし・LLM 基準が使える', async () => {
    const { feature } = composeContract(context());
    expect(await feature.contractCapabilities.execute()).toEqual({ extraction: { enabled: true, vision: true }, review: { llm: true } });
  });

  it.each([
    ['test プロファイル', { profile: 'test' as const }],
    ['モデル未設定', { mainModelConfigured: async () => false }],
  ])('境界: %s は使えない側へ倒す（能力を見に行かない）', async (_label, overrides) => {
    const capabilities = vi.fn(async (): Promise<readonly ModelCapability[]> => ['structured-output', 'vision']);
    const { feature } = composeContract(context({ ...overrides, mainModelCapabilities: capabilities }));
    expect(await feature.contractCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, review: { llm: false } });
    expect(capabilities).not.toHaveBeenCalled();
  });

  it('境界: 構造化出力が無ければ抽出も LLM 基準も使えず、画像読取だけでは vision も立てない', async () => {
    const { feature } = composeContract(context({ mainModelCapabilities: async () => ['chat', 'vision'] }));
    expect(await feature.contractCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, review: { llm: false } });
  });

  it('例外: 能力の読み出しが壊れても画面を止めず、使えない側へ倒して握り潰したことを残す', async () => {
    const warn = vi.fn();
    const { feature } = composeContract(context({ mainModelCapabilities: async () => { throw new Error('decrypt failed'); }, errorLogger: { ...NOOP_LOGGER, warn, error: warn } }));
    expect(await feature.contractCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, review: { llm: false } });
    expect(warn).toHaveBeenCalled();
  });

  it('正常: 業務の全ノード型を行ソースとして登録する（未配線を理由付きで拒否するため）', () => {
    expect(composeContract(context()).rowSources.map((source) => [source.nodeType, source.requirement])).toEqual([
      ['contract-review-draft', 'attachments-or-documents'], ['contract-deadlines', 'none'], ['contract-clauses', 'none'],
    ]);
  });
});

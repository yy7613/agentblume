// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WELCOME_DISMISSED_KEY, dismissWelcome, isWelcomeDismissed, isWorkspaceEmpty,
  nextOnboardingStep, onboardingProgressRatio, onboardingSteps, shouldShowWelcome,
  type OnboardingProgress,
} from './onboarding-state';

const empty: OnboardingProgress = { modelConfigured: false, dataSources: 0, tools: 0, agents: 0 };

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('onboardingSteps', () => {
  it('モデル → データソース → ツール → エージェント → 試す の順に並べる', () => {
    expect(onboardingSteps(empty).map((step) => step.id)).toEqual(['model', 'data', 'tool', 'agent', 'try']);
  });

  it('件数から到達状況を判定する', () => {
    const steps = onboardingSteps({ modelConfigured: true, dataSources: 2, tools: 1, agents: 0 });
    expect(steps.map((step) => step.done)).toEqual([true, true, true, false, false]);
  });

  it('各ステップは進めるための画面IDを持つ', () => {
    expect(onboardingSteps(empty).map((step) => step.screen)).toEqual(['Settings', 'Data', 'Tool', 'Agent', 'Chat']);
  });
});

describe('nextOnboardingStep', () => {
  it('最初の未完了ステップを返す', () => {
    expect(nextOnboardingStep({ modelConfigured: true, dataSources: 1, tools: 0, agents: 0 }).id).toBe('tool');
  });

  it('作るところまで揃っていれば「試す」へ誘導する', () => {
    expect(nextOnboardingStep({ modelConfigured: true, dataSources: 1, tools: 1, agents: 1 }).id).toBe('try');
  });
});

describe('onboardingProgressRatio', () => {
  it('「試す」を分母から外して数える', () => {
    expect(onboardingProgressRatio(empty)).toEqual({ done: 0, total: 4 });
    expect(onboardingProgressRatio({ modelConfigured: true, dataSources: 1, tools: 1, agents: 1 })).toEqual({ done: 4, total: 4 });
  });
});

describe('shouldShowWelcome', () => {
  it('未dismissかつワークスペースが空なら表示する', () => {
    expect(isWorkspaceEmpty(empty)).toBe(true);
    expect(shouldShowWelcome({ dismissed: false, progress: empty })).toBe(true);
  });

  it('dismiss済みなら表示しない', () => {
    expect(shouldShowWelcome({ dismissed: true, progress: empty })).toBe(false);
  });

  it('資産が1つでもあれば（dismissしていなくても）表示しない', () => {
    expect(shouldShowWelcome({ dismissed: false, progress: { ...empty, agents: 1 } })).toBe(false);
    expect(shouldShowWelcome({ dismissed: false, progress: { ...empty, dataSources: 1 } })).toBe(false);
    expect(shouldShowWelcome({ dismissed: false, progress: { ...empty, tools: 1 } })).toBe(false);
  });

  it('モデル未設定だけでは「空でない」とみなさない（設定はデータではない）', () => {
    expect(isWorkspaceEmpty({ ...empty, modelConfigured: true })).toBe(true);
  });
});

describe('dismissWelcome', () => {
  it('localStorageへ記録し、次回以降は非表示になる', () => {
    expect(isWelcomeDismissed()).toBe(false);
    dismissWelcome();
    expect(localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe('true');
    expect(isWelcomeDismissed()).toBe(true);
  });

  it('localStorageが使えなくても例外を投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => dismissWelcome()).not.toThrow();
    expect(isWelcomeDismissed()).toBe(false);
  });
});

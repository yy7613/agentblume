/**
 * 初回体験（オンボーディング）の判定ロジック。
 *
 * 「ウェルカムを出すか」「次に何をすべきか」を、画面から独立した純関数と localStorage アクセスに切り出す。
 * 描画は WelcomeCard.tsx が担当する。
 */
import type { ScreenName } from '../screens';

/** 「今後表示しない」を覚えるキー。 */
export const WELCOME_DISMISSED_KEY = 'agentblume.onboarding.welcome-dismissed';

/** ワークスペースの到達状況。API から取得した件数をそのまま入れる。 */
export interface OnboardingProgress {
  /** main スロットにモデルが保存されている、または env 既定で動く見込みがあるか。 */
  readonly modelConfigured: boolean;
  readonly dataSources: number;
  readonly tools: number;
  readonly agents: number;
}

export type OnboardingStepId = 'model' | 'data' | 'tool' | 'agent' | 'try';

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly done: boolean;
  /** この手順を進めるために開く画面。 */
  readonly screen: ScreenName;
}

/** データソース → ツール → エージェント → 試す。モデル未設定は何よりも先に潰す必要があるので先頭。 */
export function onboardingSteps(progress: OnboardingProgress): readonly OnboardingStep[] {
  return [
    { id: 'model', done: progress.modelConfigured, screen: 'Settings' },
    { id: 'data', done: progress.dataSources > 0, screen: 'Data' },
    { id: 'tool', done: progress.tools > 0, screen: 'Tool' },
    { id: 'agent', done: progress.agents > 0, screen: 'Agent' },
    { id: 'try', done: false, screen: 'Chat' },
  ];
}

/** 最初の未完了ステップ（全て完了なら 'try'）。 */
export function nextOnboardingStep(progress: OnboardingProgress): OnboardingStep {
  const steps = onboardingSteps(progress);
  // 'try' は done: false 固定なので、必ずどれかに当たる（末尾が既定の到達先）。
  return steps.find((step) => !step.done) ?? steps[steps.length - 1] as OnboardingStep;
}

/** 完了したステップ数（'try' は常に未完了なので分母から外す）。 */
export function onboardingProgressRatio(progress: OnboardingProgress): { readonly done: number; readonly total: number } {
  const steps = onboardingSteps(progress).filter((step) => step.id !== 'try');
  return { done: steps.filter((step) => step.done).length, total: steps.length };
}

/** データが1件も無い＝初回起動とみなせる状態か。 */
export function isWorkspaceEmpty(progress: OnboardingProgress): boolean {
  return progress.dataSources === 0 && progress.tools === 0 && progress.agents === 0;
}

/**
 * ウェルカムを表示するか。
 *
 * 「今後表示しない」を押していないことが前提。そのうえで**ワークスペースが空のとき**だけ出す。
 * 資産を作り始めた利用者にとってウェルカムはただの邪魔なので、明示的に消していなくても自動で引っ込む。
 */
export function shouldShowWelcome(options: { readonly dismissed: boolean; readonly progress: OnboardingProgress }): boolean {
  return !options.dismissed && isWorkspaceEmpty(options.progress);
}

export function isWelcomeDismissed(): boolean {
  try { return localStorage.getItem(WELCOME_DISMISSED_KEY) === 'true'; }
  catch { return false; } // 埋め込みブラウザ等で localStorage が使えないときは「未dismiss」扱い。
}

export function dismissWelcome(): void {
  try { localStorage.setItem(WELCOME_DISMISSED_KEY, 'true'); }
  catch { /* 保存できなくても今回のセッションでは閉じられる（state 側で閉じる）。 */ }
}

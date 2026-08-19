/**
 * application層: Agent Factory Stage 6（検証実行）用の `ScenarioRunnerPort`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §5, §7）。
 *
 * `RunFactoryUseCase` を `RunScenarioUseCase` の内部実装から切り離し、テストではcanned
 * `ScenarioRun` を返すフェイクへ差し替え可能にする（疑似ユーザー会話全体をscriptedで再現しなくてよい）。
 * `RunScenarioUseCase.execute` はこのPortを構造的に満たす（実運用ではcompositionで実体を注入する）。
 * Factory自身の検証実行は既存Experimentと同じ非対話の自動実行のため、呼び出し側は常に `mode: 'test'` を渡す。
 */
import type { AgentId } from '../../domain/agent/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import type { ScenarioId } from '../../domain/validation/ids';
import type { ScenarioRun } from '../../domain/validation/scenario-run';

export interface ScenarioRunnerInput {
  readonly scope: TenantScope;
  readonly scenarioId: ScenarioId;
  /** 省略時は latest。Stage 5でSaveScenarioUseCaseが返した版を固定で渡す。 */
  readonly version?: SemVer;
  readonly mode: 'test';
  /**
   * 対象Agent版の上書き（M4改善ループ）。`RunScenarioUseCase.execute` の `input.target` にそのまま渡る。
   * 省略時は `Scenario.target`（Stage 5でイテレーション1の生成Agent版に固定済み）を使う。
   * イテレーション2以降は改訂後の新Agent版を明示的に渡し、凍結したScenario集合はそのまま再検証する。
   */
  readonly target?: { readonly agentId: AgentId; readonly version: SemVer };
}

export interface ScenarioRunnerPort {
  execute(input: ScenarioRunnerInput, signal?: AbortSignal): Promise<ScenarioRun>;
}

/**
 * application層: 段階的ツール生成（v42 実装契約 §6 / ADR-0048）の**受け口の型**だけを持つ file。
 *
 * なぜ型だけを別 file に置くか: 実装（`staged-tool-generation.ts`）は、一括経路と同じ決定的検査
 * （`describeGraphShapeViolations` / `describeToolSemanticViolations` / 溢れガード）を
 * `generate-agent-assets.ts` から**再利用**する。逆に `generate-agent-assets.ts` は段階的経路を
 * 呼び出す側なので、実装 file 同士が互いを import すると循環になる。呼び出し規約（この file）を
 * 葉として切り出し、依存を「実装 → 規約」の一方向に保つ。
 */
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import type { ToolSpec } from '../../domain/factory/tool-spec';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { CompiledTool } from './compile-tool-spec';
import type { DataProfile } from './profile-data-sources';

/** 新規作成するTool 1本ぶんの依頼。 */
export interface StagedToolGenerationRequest {
  readonly scope: TenantScope;
  readonly plan: FactoryToolPlan;
  /** Run全体のプロファイル（このツールが読むぶんは `toolSpecProfilesOf` が選ぶ）。 */
  readonly profiles: readonly DataProfile[];
  readonly goal: FactoryGoalInput;
  /**
   * やり直しの予算。全体で `maxRepairAttempts + 1` 回のコンパイルを超えたら諦める（v42 §6）。
   * 契約 §6 の signature には無いが、一括経路と同じ `budget.maxRepairAttempts` を効かせるために受ける。
   */
  readonly maxRepairAttempts?: number;
  readonly signal?: AbortSignal;
  /** モデル呼び出しごとに 1 回呼ばれる（Run の `maxRoleCalls` 会計用）。 */
  readonly onRoleCall: () => void;
  /** タスクのやり直し・計算列の取り下げなど、記録に残す出来事（呼び出し側がイベントへ載せる）。 */
  readonly onEvent: (note: string) => void;
}

/**
 * 結果。`ok: false` でも例外にしないのは、呼び出し側が**従来の一括 ToolSmith へフォールバック**
 * できるようにするため（中断と本物のプログラミング誤りだけが例外で抜ける。v42 §7）。
 */
export type StagedToolResult =
  | {
    readonly ok: true;
    readonly compiled: CompiledTool;
    readonly spec: ToolSpec;
    /** `tool_generated` の message へ載せる注記（走ったタスク / やり直し / 落とした計算列）。 */
    readonly notes: readonly string[];
  }
  | { readonly ok: false; readonly reason: string; readonly spec?: ToolSpec };

/** `GenerateAgentAssetsUseCase` が段階的経路を呼ぶときの規約（実装は `StagedToolGeneration`）。 */
export interface StagedToolGenerationPort {
  generate(request: StagedToolGenerationRequest): Promise<StagedToolResult>;
}

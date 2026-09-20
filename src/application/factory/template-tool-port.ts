/**
 * application層: テンプレート経路（v43 実装契約 §4 / ADR-0049）の**受け口の型**だけを持つ file。
 *
 * 型だけを別 file に置く理由は `staged-tool-port.ts` と同じ: 実装
 * （`template-tool-generation.ts`）は一括経路・段階的経路と同じ決定的検査を
 * `generate-agent-assets.ts` から再利用し、`generate-agent-assets.ts` はテンプレート経路を
 * 呼ぶ側なので、実装 file 同士が互いを import すると循環になる。呼び出し規約をこの葉へ切り出し、
 * 依存を「実装 → 規約」の一方向に保つ（`depcruise` の循環禁止）。
 */
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { InstantiatedTemplate, TemplateSlotValues } from '../../domain/tool-template/instantiate';
import type { DataProfile } from './profile-data-sources';

/** 新規作成する Tool 1 本ぶんの依頼（段階的経路と同じ形にそろえてある）。 */
export interface TemplateToolGenerationRequest {
  readonly scope: TenantScope;
  readonly plan: FactoryToolPlan;
  /** Run 全体のプロファイル（このツールが読むぶんは実装が計画から選ぶ）。 */
  readonly profiles: readonly DataProfile[];
  readonly goal: FactoryGoalInput;
  /** エージェントへ公開する function 名（呼び出し側が計画から決める）。 */
  readonly toolName: string;
  readonly signal?: AbortSignal;
  /** モデル呼び出しごとに 1 回呼ばれる（Run の `maxRoleCalls` 会計用）。 */
  readonly onRoleCall: () => void;
  /** スロットのやり直しなど、記録に残す出来事（呼び出し側がイベントへ載せる）。 */
  readonly onEvent: (note: string) => void;
}

/** 使ったテンプレート（`tool_generated` の message と監査に残す）。 */
export interface UsedToolTemplate {
  readonly id: string;
  readonly version: string;
}

/**
 * 結果。`ok: false` でも例外にしないのは、呼び出し側が**段階的生成へフォールバック**できるように
 * するため（中断と本物のプログラミング誤りだけが例外で抜ける。v43 §4-5）。
 */
export type TemplateToolResult =
  | {
    readonly ok: true;
    /** 実体化の結果（`graph` / `inputSchema` / `agentTool` をそのまま保存経路へ渡せる）。 */
    readonly instantiated: InstantiatedTemplate;
    readonly template: UsedToolTemplate;
    readonly slots: TemplateSlotValues;
    /** `tool_generated` の message へ載せる注記（テンプレート・スロット・やり直し）。 */
    readonly notes: readonly string[];
  }
  | {
    readonly ok: false;
    readonly reason: string;
    /** 選ばれたテンプレート（選ぶ前に諦めたときは未設定）。イベントの文面に出す。 */
    readonly template?: UsedToolTemplate;
    /**
     * モデルを 1 回でも呼んだか。false は「当てはまるテンプレートが 1 つも無い / 配線されていない」
     * ため**何も試していない**という意味で、呼び出し側はイベントを出さずに静かに次の経路へ進む。
     */
    readonly attempted: boolean;
  };

/** `GenerateAgentAssetsUseCase` がテンプレート経路を呼ぶときの規約（実装は `TemplateToolGeneration`）。 */
export interface TemplateToolGenerationPort {
  generate(request: TemplateToolGenerationRequest): Promise<TemplateToolResult>;
}

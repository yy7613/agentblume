/**
 * ドメイン: Agent Factory の改訂提案 `ImprovementProposal`（v33 実装契約 §1 / docs/16-agent-factory.md §5.3）— 型のみ。
 *
 * Analystロールの構造化出力を受け取る型付きunion。適用前にアプリ側（application層）が
 * `tool-graph-revision` / `add-tool` はStage 2と同じエンジン検証・修復ループを、その他は各Save系
 * ユースケースの検証を通す（本ファイルは型のみを定義し、適用ロジックは持たない）。
 *
 * `add-tool` / `add-skill` は「既存Agentに無い能力を足す」提案で、適用すると新しいTool/Skillが
 * 保存され、Agent新版の `tools` / `skills` へ**追加**される（既存参照のバージョン差替とは別経路）。
 */
import type { ToolGraph } from '../etl/graph';
import type { FactoryAddSkillPlan, FactoryToolPlan } from './factory-plan';
import type { VersionRef } from './refs';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly area: string;
  readonly detail: string;
}

export type ImprovementProposal =
  | { readonly kind: 'system-prompt-revision'; readonly agentId: string; readonly sections: { readonly role?: string; readonly rules?: string }; readonly rationale: string }
  | { readonly kind: 'skill-instructions-revision'; readonly skillId: string; readonly instructions: string; readonly activationCondition?: string; readonly rationale: string }
  | { readonly kind: 'tool-contract-revision'; readonly toolId: string; readonly agentTool: { readonly name?: string; readonly description?: string }; readonly rationale: string }
  | { readonly kind: 'tool-graph-revision'; readonly toolId: string; readonly graph: ToolGraph; readonly rationale: string }
  | { readonly kind: 'add-tool'; readonly plan: FactoryToolPlan; readonly rationale: string }
  | { readonly kind: 'add-skill'; readonly plan: FactoryAddSkillPlan; readonly rationale: string };

/** 適用に成功した提案と、その結果生じた新版の参照。 */
export interface AppliedProposal {
  readonly proposal: ImprovementProposal;
  readonly resultingVersion: VersionRef;
}

/** 検証に落ちて破棄された提案と、その理由。 */
export interface RejectedProposal {
  readonly proposal: ImprovementProposal;
  readonly reason: string;
}

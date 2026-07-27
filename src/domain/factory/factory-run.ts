/**
 * ドメイン: Agent Factory 実行 `FactoryRun`（v33 実装契約 §1 / docs/16-agent-factory.md §6）。
 *
 * `harness-run.ts` と同じ規律に従う: 状態遷移関数はすべて非mutateで新しいオブジェクトを返し、
 * イベントは append-only の `FactoryEvent`（sequence付き）としてRunレコードへ埋め込む。
 * checkpointはRun record内へ埋め込み、TTL 24時間・型付き応答のみ受け付ける（Harness checkpointと同じ規則）。
 */
import type { TenantScope } from '../tool/ids';
import type { FactoryPlan } from './factory-plan';
import type { AppliedProposal, Finding, ImprovementProposal, RejectedProposal } from './improvement-proposal';
import type { VersionRef } from './refs';

export const FACTORY_RUN_STATUSES = ['queued', 'running', 'waiting-approval', 'succeeded', 'failed', 'cancelled'] as const;
export type FactoryRunStatus = (typeof FACTORY_RUN_STATUSES)[number];

export const FACTORY_STAGES = [
  'profiling', 'planning', 'generating-tools', 'generating-skills',
  'assembling-agent', 'generating-validation', 'validating', 'analyzing', 'improving', 'reporting',
] as const;
export type FactoryStage = (typeof FACTORY_STAGES)[number];

export const FACTORY_EVENT_KINDS = [
  'stage_started', 'stage_completed', 'plan_proposed', 'approval_requested', 'approval_resolved',
  'tool_generated', 'tool_reused', 'tool_repair_attempted', 'artifact_saved', 'scenario_run_completed',
  'analysis_completed', 'proposal_applied', 'proposal_rejected', 'iteration_completed',
  'budget_exceeded', 'run_completed', 'run_failed', 'run_cancelled',
] as const;
export type FactoryEventKind = (typeof FACTORY_EVENT_KINDS)[number];

export interface FactoryEvent {
  readonly sequence: number;
  readonly kind: FactoryEventKind;
  readonly at: string;
  readonly stage?: FactoryStage;
  readonly iteration?: number;
  readonly message?: string;
  readonly ref?: VersionRef;
}

export interface FactoryGoalInput {
  readonly goal: string;
  readonly targetUsers?: string;
  readonly constraints?: string;
  readonly language: 'ja' | 'en';
}

export interface FactoryTargets {
  readonly minGoalAchievedRate: number;
  readonly minAvgSatisfaction: number;
}

export interface FactoryBudgetLimits {
  readonly maxDurationMs: number;
  readonly maxRoleCalls: number;
  readonly maxScenarioRuns: number;
  readonly maxRepairAttempts: number;
  readonly maxProposalsPerIteration: number;
}

export interface FactoryBudgetSnapshot {
  readonly roleCalls: number;
  readonly scenarioRuns: number;
  readonly elapsedMs: number;
}

/**
 * 既存Agent強化モードでの systemPrompt の扱い（docs/16-agent-factory.md §4.1）。
 *
 * - `preserve`: 既存の役割文・実行規則・利用者が書き足した節を保ち、Skillガイド / Tool使用ガイドの
 *   2節だけを決定的に差し替える（LLM呼び出しなし）。
 * - `rewrite`: Assemblerロールへ既存プロンプトを渡し、役割文・実行規則を書き直させる。
 */
export const FACTORY_PROMPT_STRATEGIES = ['preserve', 'rewrite'] as const;
export type FactoryPromptStrategy = (typeof FACTORY_PROMPT_STRATEGIES)[number];

export interface FactoryOptions {
  readonly maxIterations: number;
  readonly personaCount: number;
  readonly scenarioCount: number;
  readonly requirePlanApproval: boolean;
  readonly targets: FactoryTargets;
  readonly budget: FactoryBudgetLimits;
  /**
   * 強化モード（`input.baseAgent` 指定）での systemPrompt の扱い。
   * `'preserve'`（既定）= 既存の役割文・実行規則を保ち、ガイド2節だけ決定的に差し替える（LLM呼び出しなし）。
   * `'rewrite'` = Assemblerロールに既存プロンプトを渡して役割文・実行規則を書き直させる（ロール呼び出しが1回増える）。
   *
   * 生成モード（0→1）では無関係な設定として無視される（元からAssemblerが役割文・実行規則を起草するため）。
   */
  readonly promptStrategy: FactoryPromptStrategy;
}

export interface IterationMetrics {
  readonly iteration: number;
  readonly goalAchievedRate: number;
  readonly avgSatisfaction: number;
  readonly toolHitRate: number;
  readonly errorRate: number;
  readonly avgUserTurns: number;
  readonly scenarioCount: number;
  readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
  readonly durationMs: number;
}

export interface FactoryIteration {
  readonly index: number;
  readonly agentVersion: string;
  readonly scenarioRunIds: readonly string[];
  readonly metrics: IterationMetrics;
  readonly analysis?: { readonly findings: readonly Finding[]; readonly applied: readonly AppliedProposal[]; readonly rejected: readonly RejectedProposal[] };
}

export interface FactoryArtifacts {
  readonly tools: readonly VersionRef[];
  readonly skills: readonly VersionRef[];
  readonly agentVersions: readonly VersionRef[];
  readonly personas: readonly VersionRef[];
  readonly pseudoUsers: readonly VersionRef[];
  readonly scenarios: readonly VersionRef[];
}

export interface FactoryReport {
  readonly bestIteration: number;
  readonly candidate: { readonly agentId: string; readonly version: string };
  readonly summary: string;
  readonly openFindings: readonly Finding[];
  readonly metricsByIteration: readonly IterationMetrics[];
}

export interface FactoryPlanCheckpoint {
  readonly kind: 'plan-approval';
  readonly expiresAt: string;
  readonly prompt: string;
  readonly plan: FactoryPlan;
}

/**
 * 強化対象の既存Agent（docs/16-agent-factory.md §4.1 既存Agent強化モード）。
 *
 * 指定するとRunは「0→1生成」ではなく「既存Agentの強化」として走る: Stage 0でこのAgentをロードして
 * 現在の能力を把握し、Stage 1のPlannerには不足分だけを計画させ、Stage 4は新しいAgentを作らずこのAgentの
 * patch新版を作る。未指定なら従来どおりの生成モード。
 */
export interface FactoryBaseAgentRef {
  readonly internalId: string;
  /** 省略時は最新版を起点にする。指定するとその版を起点にする（過去版からの分岐）。 */
  readonly version?: string;
}

export interface FactoryRun {
  readonly id: string;
  readonly scope: TenantScope;
  readonly input: {
    readonly goal: FactoryGoalInput;
    readonly dataSourceIds: readonly string[];
    readonly options: FactoryOptions;
    /** 強化対象の既存Agent。未指定は0→1生成モード。 */
    readonly baseAgent?: FactoryBaseAgentRef;
  };
  readonly status: FactoryRunStatus;
  readonly stage: FactoryStage;
  readonly plan?: FactoryPlan;
  readonly artifacts: FactoryArtifacts;
  readonly iterations: readonly FactoryIteration[];
  readonly report?: FactoryReport;
  /** waiting-approval 状態だけで保持する、再開に必要な永続実行コンテキスト。 */
  readonly checkpoint?: FactoryPlanCheckpoint;
  readonly budget: { readonly consumed: FactoryBudgetSnapshot; readonly limits: FactoryBudgetLimits };
  readonly failure?: { readonly stage: FactoryStage; readonly reason: string };
  readonly events: readonly FactoryEvent[];
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/** docs/16-agent-factory.md §9 既定値。 */
export const DEFAULT_FACTORY_TARGETS: FactoryTargets = { minGoalAchievedRate: 0.75, minAvgSatisfaction: 4 };
export const DEFAULT_FACTORY_BUDGET_LIMITS: FactoryBudgetLimits = { maxDurationMs: 30 * 60 * 1000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 };
export const DEFAULT_FACTORY_OPTIONS: FactoryOptions = {
  maxIterations: 3,
  personaCount: 2,
  scenarioCount: 4,
  requirePlanApproval: false,
  targets: DEFAULT_FACTORY_TARGETS,
  budget: DEFAULT_FACTORY_BUDGET_LIMITS,
  // 既定は「既存プロンプトを保つ」: 本番Agentのペルソナ・業務ルールがLLMの再起草で黙って変わらない側へ倒す。
  promptStrategy: 'preserve',
};

function cloneFactoryOptions(options: FactoryOptions): FactoryOptions {
  return { ...options, targets: { ...options.targets }, budget: { ...options.budget } };
}

export function startFactoryRun(
  input: Omit<FactoryRun, 'status' | 'stage' | 'plan' | 'artifacts' | 'iterations' | 'report' | 'checkpoint' | 'budget' | 'failure' | 'events' | 'finishedAt'>,
): FactoryRun {
  return {
    id: input.id,
    scope: { ...input.scope },
    input: {
      goal: { ...input.input.goal },
      dataSourceIds: [...input.input.dataSourceIds],
      options: cloneFactoryOptions(input.input.options),
      ...(input.input.baseAgent === undefined ? {} : { baseAgent: { ...input.input.baseAgent } }),
    },
    status: 'queued',
    stage: 'profiling',
    artifacts: { tools: [], skills: [], agentVersions: [], personas: [], pseudoUsers: [], scenarios: [] },
    iterations: [],
    budget: { consumed: { roleCalls: 0, scenarioRuns: 0, elapsedMs: 0 }, limits: { ...input.input.options.budget } },
    events: [],
    startedAt: input.startedAt,
  };
}

export function beginFactoryRun(run: FactoryRun): FactoryRun {
  if (run.status !== 'queued') throw new Error(`Factory run '${run.id}' is already ${run.status}`);
  return { ...run, status: 'running' };
}

export function appendFactoryEvent(run: FactoryRun, event: Omit<FactoryEvent, 'sequence'>): FactoryRun {
  return { ...run, events: [...run.events, { ...event, sequence: run.events.length + 1 }] };
}

export function advanceStage(run: FactoryRun, stage: FactoryStage): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  return { ...run, stage };
}

export function setPlan(run: FactoryRun, plan: FactoryPlan): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  return { ...run, plan: cloneFactoryPlan(plan) };
}

export function recordIteration(run: FactoryRun, iteration: FactoryIteration): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  return { ...run, iterations: [...run.iterations, cloneIteration(iteration)] };
}

/**
 * 直近（最後）のイテレーションへ分析結果（findings/applied/rejected）を付与した複製を返す（M4、改善ループ用）。
 * 非mutate: `iterations` 配列の最後の要素だけを analysis 付きで置き換える。既存のanalysisは上書きする。
 */
export function attachAnalysisToLastIteration(
  run: FactoryRun,
  analysis: { readonly findings: readonly Finding[]; readonly applied: readonly AppliedProposal[]; readonly rejected: readonly RejectedProposal[] },
): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  if (run.iterations.length === 0) throw new Error(`Factory run '${run.id}' has no iterations to attach analysis to`);
  const lastIndex = run.iterations.length - 1;
  const iterations = run.iterations.map((iteration, index) =>
    index === lastIndex
      ? cloneIteration({
          ...iteration,
          analysis: { findings: [...analysis.findings], applied: [...analysis.applied], rejected: [...analysis.rejected] },
        })
      : cloneIteration(iteration),
  );
  return { ...run, iterations };
}

export function updateBudget(run: FactoryRun, consumed: FactoryBudgetSnapshot): FactoryRun {
  return { ...run, budget: { ...run.budget, consumed: { ...consumed } } };
}

/** 生成資産の出所台帳を差し替える（M2 Stage 2-4）。非mutate・複製して保存する。 */
export function setArtifacts(run: FactoryRun, artifacts: FactoryArtifacts): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  return { ...run, artifacts: cloneArtifacts(artifacts) };
}

export function waitForPlanApproval(run: FactoryRun, checkpoint: FactoryPlanCheckpoint): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is not running`);
  return { ...run, status: 'waiting-approval', checkpoint: cloneCheckpoint(checkpoint) };
}

export function resumeFactoryRun(run: FactoryRun): FactoryRun {
  if (run.status !== 'waiting-approval') throw new Error(`Factory run '${run.id}' is not waiting for approval`);
  return { ...run, status: 'running', checkpoint: undefined };
}

export function succeedFactoryRun(run: FactoryRun, report: FactoryReport, finishedAt: string): FactoryRun {
  if (run.status !== 'running') throw new Error(`Factory run '${run.id}' is already ${run.status}`);
  return { ...run, status: 'succeeded', report: cloneReport(report), finishedAt };
}

export function failFactoryRun(run: FactoryRun, failure: { readonly stage: FactoryStage; readonly reason: string }, finishedAt: string): FactoryRun {
  if (run.status !== 'running' && run.status !== 'waiting-approval') throw new Error(`Factory run '${run.id}' is already ${run.status}`);
  return { ...run, status: 'failed', failure: { ...failure }, checkpoint: undefined, finishedAt };
}

export function cancelFactoryRun(run: FactoryRun, finishedAt: string): FactoryRun {
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') throw new Error(`Factory run '${run.id}' is already ${run.status}`);
  return { ...run, status: 'cancelled', checkpoint: undefined, finishedAt };
}

function cloneArtifacts(artifacts: FactoryArtifacts): FactoryArtifacts {
  return {
    tools: artifacts.tools.map((ref) => ({ ...ref })),
    skills: artifacts.skills.map((ref) => ({ ...ref })),
    agentVersions: artifacts.agentVersions.map((ref) => ({ ...ref })),
    personas: artifacts.personas.map((ref) => ({ ...ref })),
    pseudoUsers: artifacts.pseudoUsers.map((ref) => ({ ...ref })),
    scenarios: artifacts.scenarios.map((ref) => ({ ...ref })),
  };
}

function cloneFactoryPlan(plan: FactoryPlan): FactoryPlan {
  return {
    agentBrief: { ...plan.agentBrief },
    tools: plan.tools.map((tool) => ({ ...tool, ...(tool.reuse === undefined ? {} : { reuse: { ...tool.reuse } }) })),
    skills: plan.skills.map((skill) => ({ ...skill, toolKeys: [...skill.toolKeys] })),
    personas: plan.personas.map((persona) => ({ ...persona })),
    scenarios: plan.scenarios.map((scenario) => ({ ...scenario, expectedToolKeys: [...scenario.expectedToolKeys] })),
  };
}

function cloneProposal(proposal: ImprovementProposal): ImprovementProposal {
  switch (proposal.kind) {
    case 'system-prompt-revision':
      return { ...proposal, sections: { ...proposal.sections } };
    case 'skill-instructions-revision':
      return { ...proposal };
    case 'tool-contract-revision':
      return { ...proposal, agentTool: { ...proposal.agentTool } };
    case 'tool-graph-revision':
      return { ...proposal, graph: { nodes: proposal.graph.nodes.map((node) => ({ ...node })), edges: proposal.graph.edges.map((edge) => ({ ...edge })) } };
    case 'add-tool':
      return { ...proposal, plan: { ...proposal.plan, ...(proposal.plan.reuse === undefined ? {} : { reuse: { ...proposal.plan.reuse } }) } };
    case 'add-skill':
      return { ...proposal, plan: { ...proposal.plan, toolRefs: [...proposal.plan.toolRefs] } };
  }
}

function cloneIteration(iteration: FactoryIteration): FactoryIteration {
  return {
    ...iteration,
    scenarioRunIds: [...iteration.scenarioRunIds],
    metrics: { ...iteration.metrics, usage: { ...iteration.metrics.usage } },
    ...(iteration.analysis !== undefined
      ? {
          analysis: {
            findings: iteration.analysis.findings.map((finding) => ({ ...finding })),
            applied: iteration.analysis.applied.map((applied): AppliedProposal => ({ proposal: cloneProposal(applied.proposal), resultingVersion: { ...applied.resultingVersion } })),
            rejected: iteration.analysis.rejected.map((rejected): RejectedProposal => ({ proposal: cloneProposal(rejected.proposal), reason: rejected.reason })),
          },
        }
      : {}),
  };
}

function cloneReport(report: FactoryReport): FactoryReport {
  return {
    ...report,
    candidate: { ...report.candidate },
    openFindings: report.openFindings.map((finding) => ({ ...finding })),
    metricsByIteration: report.metricsByIteration.map((metrics) => ({ ...metrics, usage: { ...metrics.usage } })),
  };
}

function cloneCheckpoint(checkpoint: FactoryPlanCheckpoint): FactoryPlanCheckpoint {
  return { ...checkpoint, plan: cloneFactoryPlan(checkpoint.plan) };
}

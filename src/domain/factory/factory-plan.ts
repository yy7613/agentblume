/**
 * ドメイン: Agent Factory の構成計画 `FactoryPlan`（v33 実装契約 §1 / docs/16-agent-factory.md §6, §4 Stage 1）。
 *
 * Plannerロールの構造化出力を受け取る型と、その検証関数 `validateFactoryPlan` を提供する。
 * 検証規則は docs/16-agent-factory.md §4「Stage 1: 構成計画」に従う: データソース参照整合・
 * 副作用制限（write / external-action 拒否）・件数上限・キー参照整合。
 */
import type { SideEffect } from '../tool/metadata';
import { FactoryValidationError } from './errors';

/**
 * 「新規作成せず既存Toolを再利用する」という計画（docs/16-agent-factory.md §4 Stage 1 再利用判断）。
 * Plannerへ渡した既存ツールカタログ（`ExistingToolCatalogEntry`）の `internalId` を指す。
 * 生成段（Stage 2）は再利用先を解決できればToolSmithを呼ばず、解決できなければ新規生成へフォールバックする。
 */
export interface FactoryToolReuse {
  readonly internalId: string;
  /** なぜその既存Toolで足りるのか（人間がレビューするための理由）。 */
  readonly rationale?: string;
}

export interface FactoryToolPlan {
  readonly key: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly dataSourceId: string;
  readonly sideEffect: SideEffect;
  readonly outputShape?: string;
  readonly argumentSummary?: string;
  readonly reuse?: FactoryToolReuse;
}

export interface FactorySkillPlan {
  readonly key: string;
  readonly displayName: string;
  readonly responsibility: string;
  readonly activationCondition: string;
  readonly toolKeys: readonly string[];
}

/**
 * 既存Agentへ「Skillを1件追加する」計画（改訂提案 `add-skill`。docs/16-agent-factory.md §5.3）。
 *
 * `FactorySkillPlan` を再利用せず別型にする理由:
 * 1. `FactorySkillPlan.toolKeys` は **Stage 1 の計画内でだけ意味を持つRunローカルなキー空間** で、
 *    `validateFactoryPlan` が `plan.tools[].key` との参照整合を強制している。改訂提案が指したいのは
 *    「既に保存済みのTool」であり、同じフィールドへ別の名前空間を混ぜるとStage 1の検証規則が壊れる。
 *    そこで名前を `toolRefs` に変え、解決規則（下記）を型のドキュメントとして固定する。
 * 2. Skillの保存には `instructions` / `inputDescription` / `outputDescription` が要る。生成フロー
 *    （Stage 3）はSkillWriterロールがそれらを書くが、改善ループでは `skill-instructions-revision` と
 *    同じ流儀でAnalystが本文まで書く（ロール呼び出しとロール依存を増やさない）。
 */
export interface FactoryAddSkillPlan {
  readonly key: string;
  readonly displayName: string;
  readonly responsibility: string;
  readonly activationCondition: string;
  /** 未指定なら適用側が `responsibility` から決定的に補う（ローカルモデルの出力欠落に耐える）。 */
  readonly inputDescription?: string;
  /** 未指定なら適用側が `responsibility` から決定的に補う。 */
  readonly outputDescription?: string;
  readonly instructions: string;
  /**
   * このSkillが使うToolの参照。適用側（`ApplyImprovementsUseCase`）が次の順で解決する:
   * 対象Agentが現に持つToolの `internalId` → `publishName` → Tool契約名（`agentTool.name`）→
   * 同一イテレーションの `add-tool` 提案の `plan.key`。1つでも解決できなければ提案ごと却下する。
   */
  readonly toolRefs: readonly string[];
}

/** Persona種別プリセット（docs/11-scenario-validation.md §2）。 */
export const FACTORY_PERSONA_ARCHETYPES = ['novice', 'expert', 'busy', 'vague', 'skeptical', 'custom'] as const;
export type FactoryPersonaArchetype = (typeof FACTORY_PERSONA_ARCHETYPES)[number];

export interface FactoryPersonaPlan {
  readonly key: string;
  readonly archetype: FactoryPersonaArchetype;
  readonly knowledgeLevel: 'low' | 'mid' | 'high';
  readonly patience: 'low' | 'mid' | 'high';
  readonly tone: string;
  readonly verbosity: 'terse' | 'normal' | 'chatty';
  readonly language: 'ja' | 'en';
  readonly extraInstructions?: string;
}

export interface FactoryScenarioPlan {
  readonly key: string;
  readonly goal: string;
  readonly context?: string;
  readonly personaKey: string;
  readonly expectedToolKeys: readonly string[];
  readonly maxUserTurns: number;
}

export interface FactoryAgentBrief {
  readonly displayName: string;
  readonly role: string;
}

export interface FactoryPlan {
  readonly agentBrief: FactoryAgentBrief;
  readonly tools: readonly FactoryToolPlan[];
  readonly skills: readonly FactorySkillPlan[];
  readonly personas: readonly FactoryPersonaPlan[];
  readonly scenarios: readonly FactoryScenarioPlan[];
}

export interface FactoryPlanLimits {
  readonly maxTools: number;
  readonly maxSkills: number;
  readonly maxPersonas: number;
  readonly maxScenarios: number;
}

export const DEFAULT_FACTORY_PLAN_LIMITS: FactoryPlanLimits = { maxTools: 4, maxSkills: 3, maxPersonas: 3, maxScenarios: 6 };

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new FactoryValidationError(`${field} must be a non-empty string`);
}

/**
 * `FactoryPlan` を検証する。不正な計画は `FactoryValidationError` を投げる（副作用なし・不変）。
 * 規則（docs/16-agent-factory.md §4 Stage 1）:
 * - Tool参照は `ctx.dataSourceIds` 内のみ。`write` / `external-action` の副作用は拒否。
 *   ただし既存Toolの再利用計画（`reuse`）は `dataSourceId: ''`（データソースを読まないTool）を許し、
 *   代わりに `reuse.internalId` の非空を要求する。
 * - Tool / Skill / Persona / Scenario の件数は各上限（既定 `DEFAULT_FACTORY_PLAN_LIMITS`）以内。
 * - 各コレクション内でキー重複禁止。Skill.toolKeys / Scenario.personaKey / Scenario.expectedToolKeys は既知キーのみ参照可。
 * - 必須文字列は空・空白のみを禁止。Scenario.maxUserTurns は 1..8。
 */
export function validateFactoryPlan(plan: FactoryPlan, ctx: { readonly dataSourceIds: readonly string[]; readonly limits?: FactoryPlanLimits }): void {
  const limits = ctx.limits ?? DEFAULT_FACTORY_PLAN_LIMITS;
  nonEmpty(plan.agentBrief?.displayName, 'validateFactoryPlan: agentBrief.displayName');
  nonEmpty(plan.agentBrief?.role, 'validateFactoryPlan: agentBrief.role');

  if (plan.tools.length > limits.maxTools) throw new FactoryValidationError(`validateFactoryPlan: tools count ${plan.tools.length} exceeds limit ${limits.maxTools}`);
  if (plan.skills.length > limits.maxSkills) throw new FactoryValidationError(`validateFactoryPlan: skills count ${plan.skills.length} exceeds limit ${limits.maxSkills}`);
  if (plan.personas.length > limits.maxPersonas) throw new FactoryValidationError(`validateFactoryPlan: personas count ${plan.personas.length} exceeds limit ${limits.maxPersonas}`);
  if (plan.scenarios.length > limits.maxScenarios) throw new FactoryValidationError(`validateFactoryPlan: scenarios count ${plan.scenarios.length} exceeds limit ${limits.maxScenarios}`);

  const dataSourceIds = new Set(ctx.dataSourceIds);
  const toolKeys = new Set<string>();
  plan.tools.forEach((tool, index) => {
    nonEmpty(tool.key, `validateFactoryPlan: tools.${index}.key`);
    if (toolKeys.has(tool.key)) throw new FactoryValidationError(`validateFactoryPlan: duplicate tool key: ${tool.key}`);
    toolKeys.add(tool.key);
    nonEmpty(tool.displayName, `validateFactoryPlan: tools.${index}.displayName`);
    nonEmpty(tool.purpose, `validateFactoryPlan: tools.${index}.purpose`);
    // 再利用計画（reuse付き）は既存Toolのグラフをそのまま使うため、データソースを読まないTool
    // （例: 組み込みの現在日時）も選べるよう `dataSourceId: ''` を許す。新規作成計画は従来どおり必須。
    const reuse = tool.reuse;
    if (reuse === undefined) nonEmpty(tool.dataSourceId, `validateFactoryPlan: tools.${index}.dataSourceId`);
    else nonEmpty(reuse.internalId, `validateFactoryPlan: tools.${index}.reuse.internalId`);
    const omitsDataSource = reuse !== undefined && tool.dataSourceId === '';
    if (!omitsDataSource && !dataSourceIds.has(tool.dataSourceId)) throw new FactoryValidationError(`validateFactoryPlan: tools.${index}.dataSourceId references unknown data source: ${tool.dataSourceId}`);
    if (tool.sideEffect === 'write' || tool.sideEffect === 'external-action') throw new FactoryValidationError(`validateFactoryPlan: tools.${index}.sideEffect must be 'read-only' or 'session-write', got '${tool.sideEffect}'`);
  });

  const skillKeys = new Set<string>();
  plan.skills.forEach((skill, index) => {
    nonEmpty(skill.key, `validateFactoryPlan: skills.${index}.key`);
    if (skillKeys.has(skill.key)) throw new FactoryValidationError(`validateFactoryPlan: duplicate skill key: ${skill.key}`);
    skillKeys.add(skill.key);
    nonEmpty(skill.displayName, `validateFactoryPlan: skills.${index}.displayName`);
    nonEmpty(skill.responsibility, `validateFactoryPlan: skills.${index}.responsibility`);
    nonEmpty(skill.activationCondition, `validateFactoryPlan: skills.${index}.activationCondition`);
    skill.toolKeys.forEach((toolKey, toolIndex) => {
      if (!toolKeys.has(toolKey)) throw new FactoryValidationError(`validateFactoryPlan: skills.${index}.toolKeys.${toolIndex} references unknown tool key: ${toolKey}`);
    });
  });

  const personaKeys = new Set<string>();
  plan.personas.forEach((persona, index) => {
    nonEmpty(persona.key, `validateFactoryPlan: personas.${index}.key`);
    if (personaKeys.has(persona.key)) throw new FactoryValidationError(`validateFactoryPlan: duplicate persona key: ${persona.key}`);
    personaKeys.add(persona.key);
    if (!(FACTORY_PERSONA_ARCHETYPES as readonly string[]).includes(persona.archetype)) throw new FactoryValidationError(`validateFactoryPlan: personas.${index}.archetype is invalid: ${String(persona.archetype)}`);
    if (!['low', 'mid', 'high'].includes(persona.knowledgeLevel)) throw new FactoryValidationError(`validateFactoryPlan: personas.${index}.knowledgeLevel is invalid: ${String(persona.knowledgeLevel)}`);
    if (!['low', 'mid', 'high'].includes(persona.patience)) throw new FactoryValidationError(`validateFactoryPlan: personas.${index}.patience is invalid: ${String(persona.patience)}`);
    nonEmpty(persona.tone, `validateFactoryPlan: personas.${index}.tone`);
    if (!['terse', 'normal', 'chatty'].includes(persona.verbosity)) throw new FactoryValidationError(`validateFactoryPlan: personas.${index}.verbosity is invalid: ${String(persona.verbosity)}`);
    if (persona.language !== 'ja' && persona.language !== 'en') throw new FactoryValidationError(`validateFactoryPlan: personas.${index}.language is invalid: ${String(persona.language)}`);
  });

  const scenarioKeys = new Set<string>();
  plan.scenarios.forEach((scenario, index) => {
    nonEmpty(scenario.key, `validateFactoryPlan: scenarios.${index}.key`);
    if (scenarioKeys.has(scenario.key)) throw new FactoryValidationError(`validateFactoryPlan: duplicate scenario key: ${scenario.key}`);
    scenarioKeys.add(scenario.key);
    nonEmpty(scenario.goal, `validateFactoryPlan: scenarios.${index}.goal`);
    nonEmpty(scenario.personaKey, `validateFactoryPlan: scenarios.${index}.personaKey`);
    if (!personaKeys.has(scenario.personaKey)) throw new FactoryValidationError(`validateFactoryPlan: scenarios.${index}.personaKey references unknown persona key: ${scenario.personaKey}`);
    scenario.expectedToolKeys.forEach((toolKey, toolIndex) => {
      if (!toolKeys.has(toolKey)) throw new FactoryValidationError(`validateFactoryPlan: scenarios.${index}.expectedToolKeys.${toolIndex} references unknown tool key: ${toolKey}`);
    });
    if (!Number.isInteger(scenario.maxUserTurns) || scenario.maxUserTurns < 1 || scenario.maxUserTurns > 8) throw new FactoryValidationError(`validateFactoryPlan: scenarios.${index}.maxUserTurns must be an integer between 1 and 8, got ${String(scenario.maxUserTurns)}`);
  });
}

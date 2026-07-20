/**
 * ドメイン: `FactoryRun` の永続化用シリアライズ（v33 実装契約 §1 / docs/16-agent-factory.md §6）。
 *
 * `FactoryRun` は内部にドメイン値オブジェクト（SemVer等）を持たない（バージョンは harness-run と
 * 同様に文字列で保持する）ため、Zodスキーマで構造を検証しつつ JSON文字列との相互変換を行う。
 * `src/domain/harness/serialization.ts` の safeParse → issues整形 → ドメインエラー、というパターンを踏襲する。
 */
import { z } from 'zod';
import type { SideEffect } from '../tool/metadata';
import { SIDE_EFFECTS } from '../tool/metadata';
import { FactoryValidationError } from './errors';
import { FACTORY_EVENT_KINDS, FACTORY_RUN_STATUSES, FACTORY_STAGES, type FactoryRun } from './factory-run';
import { FACTORY_PERSONA_ARCHETYPES } from './factory-plan';

const scopeSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });
const versionRefSchema = z.object({ internalId: z.string(), version: z.string() });

const factoryToolPlanSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  purpose: z.string(),
  dataSourceId: z.string(),
  sideEffect: z.enum(SIDE_EFFECTS as [SideEffect, ...SideEffect[]]),
  outputShape: z.string().optional(),
  argumentSummary: z.string().optional(),
});
const factorySkillPlanSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  responsibility: z.string(),
  activationCondition: z.string(),
  toolKeys: z.array(z.string()),
});
const factoryPersonaPlanSchema = z.object({
  key: z.string(),
  archetype: z.enum(FACTORY_PERSONA_ARCHETYPES),
  knowledgeLevel: z.enum(['low', 'mid', 'high']),
  patience: z.enum(['low', 'mid', 'high']),
  tone: z.string(),
  verbosity: z.enum(['terse', 'normal', 'chatty']),
  language: z.enum(['ja', 'en']),
  extraInstructions: z.string().optional(),
});
const factoryScenarioPlanSchema = z.object({
  key: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  personaKey: z.string(),
  expectedToolKeys: z.array(z.string()),
  maxUserTurns: z.number(),
});
const factoryAgentBriefSchema = z.object({ displayName: z.string(), role: z.string() });
const factoryPlanSchema = z.object({
  agentBrief: factoryAgentBriefSchema,
  tools: z.array(factoryToolPlanSchema),
  skills: z.array(factorySkillPlanSchema),
  personas: z.array(factoryPersonaPlanSchema),
  scenarios: z.array(factoryScenarioPlanSchema),
});

const toolGraphSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), type: z.string(), config: z.unknown() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), toInput: z.number().optional() })),
});

const findingSchema = z.object({ id: z.string(), severity: z.enum(['info', 'warning', 'critical']), area: z.string(), detail: z.string() });

const improvementProposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system-prompt-revision'), agentId: z.string(), sections: z.object({ role: z.string().optional(), rules: z.string().optional() }), rationale: z.string() }),
  z.object({ kind: z.literal('skill-instructions-revision'), skillId: z.string(), instructions: z.string(), activationCondition: z.string().optional(), rationale: z.string() }),
  z.object({ kind: z.literal('tool-contract-revision'), toolId: z.string(), agentTool: z.object({ name: z.string().optional(), description: z.string().optional() }), rationale: z.string() }),
  z.object({ kind: z.literal('tool-graph-revision'), toolId: z.string(), graph: toolGraphSchema, rationale: z.string() }),
  z.object({ kind: z.literal('add-tool'), plan: factoryToolPlanSchema, rationale: z.string() }),
]);
const appliedProposalSchema = z.object({ proposal: improvementProposalSchema, resultingVersion: versionRefSchema });
const rejectedProposalSchema = z.object({ proposal: improvementProposalSchema, reason: z.string() });

const factoryEventSchema = z.object({
  sequence: z.number(),
  kind: z.enum(FACTORY_EVENT_KINDS),
  at: z.string(),
  stage: z.enum(FACTORY_STAGES).optional(),
  iteration: z.number().optional(),
  message: z.string().optional(),
  ref: versionRefSchema.optional(),
});

const factoryGoalInputSchema = z.object({ goal: z.string(), targetUsers: z.string().optional(), constraints: z.string().optional(), language: z.enum(['ja', 'en']) });
const factoryTargetsSchema = z.object({ minGoalAchievedRate: z.number(), minAvgSatisfaction: z.number() });
const factoryBudgetLimitsSchema = z.object({ maxDurationMs: z.number(), maxRoleCalls: z.number(), maxScenarioRuns: z.number(), maxRepairAttempts: z.number(), maxProposalsPerIteration: z.number() });
const factoryBudgetSnapshotSchema = z.object({ roleCalls: z.number(), scenarioRuns: z.number(), elapsedMs: z.number() });
const factoryOptionsSchema = z.object({ maxIterations: z.number(), personaCount: z.number(), scenarioCount: z.number(), requirePlanApproval: z.boolean(), targets: factoryTargetsSchema, budget: factoryBudgetLimitsSchema });

const usageSchema = z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional(), totalTokens: z.number().optional() });
const iterationMetricsSchema = z.object({ iteration: z.number(), goalAchievedRate: z.number(), avgSatisfaction: z.number(), toolHitRate: z.number(), errorRate: z.number(), avgUserTurns: z.number(), scenarioCount: z.number(), usage: usageSchema, durationMs: z.number() });

const factoryIterationSchema = z.object({
  index: z.number(),
  agentVersion: z.string(),
  scenarioRunIds: z.array(z.string()),
  metrics: iterationMetricsSchema,
  analysis: z.object({ findings: z.array(findingSchema), applied: z.array(appliedProposalSchema), rejected: z.array(rejectedProposalSchema) }).optional(),
});

const factoryArtifactsSchema = z.object({
  tools: z.array(versionRefSchema),
  skills: z.array(versionRefSchema),
  agentVersions: z.array(versionRefSchema),
  personas: z.array(versionRefSchema),
  pseudoUsers: z.array(versionRefSchema),
  scenarios: z.array(versionRefSchema),
});

const factoryReportSchema = z.object({
  bestIteration: z.number(),
  candidate: z.object({ agentId: z.string(), version: z.string() }),
  summary: z.string(),
  openFindings: z.array(findingSchema),
  metricsByIteration: z.array(iterationMetricsSchema),
});

const factoryPlanCheckpointSchema = z.object({ kind: z.literal('plan-approval'), expiresAt: z.string(), prompt: z.string(), plan: factoryPlanSchema });

const factoryRunSchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  input: z.object({ goal: factoryGoalInputSchema, dataSourceIds: z.array(z.string()), options: factoryOptionsSchema }),
  status: z.enum(FACTORY_RUN_STATUSES),
  stage: z.enum(FACTORY_STAGES),
  plan: factoryPlanSchema.optional(),
  artifacts: factoryArtifactsSchema,
  iterations: z.array(factoryIterationSchema),
  report: factoryReportSchema.optional(),
  checkpoint: factoryPlanCheckpointSchema.optional(),
  budget: z.object({ consumed: factoryBudgetSnapshotSchema, limits: factoryBudgetLimitsSchema }),
  failure: z.object({ stage: z.enum(FACTORY_STAGES), reason: z.string() }).optional(),
  events: z.array(factoryEventSchema),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

export type SerializedFactoryRun = z.infer<typeof factoryRunSchema>;

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function serializeFactoryRun(run: FactoryRun): string {
  const parsed = factoryRunSchema.safeParse(run);
  if (!parsed.success) throw new FactoryValidationError(`serializeFactoryRun: invalid FactoryRun: ${issues(parsed.error)}`);
  return JSON.stringify(parsed.data);
}

export function deserializeFactoryRun(text: string): FactoryRun {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FactoryValidationError(`deserializeFactoryRun: invalid JSON: ${String(error)}`);
  }
  const parsed = factoryRunSchema.safeParse(value);
  if (!parsed.success) throw new FactoryValidationError(`deserializeFactoryRun: invalid SerializedFactoryRun: ${issues(parsed.error)}`);
  return parsed.data;
}

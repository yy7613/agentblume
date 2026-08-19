/**
 * ドメイン: 検証コンテキストの直列化（v16 実装契約 §2.5）
 *
 * skill の serialization と同形式: Zod 検証 + SemVer 文字列化。
 * deserialize は create* を通して不変条件を再検証する。
 */
import { z } from 'zod';
import {
  deserializePublishableMetadata,
  serializePublishableMetadata,
  serializedPublishableMetadataSchema,
  type SerializedPublishableMetadata,
} from '../shared/publishable';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import {
  createPersona,
  PERSONA_ARCHETYPES,
  PERSONA_LANGUAGES,
  PERSONA_LEVELS,
  PERSONA_VERBOSITIES,
  type Persona,
  type PersonaArchetype,
  type PersonaLanguage,
  type PersonaLevel,
  type PersonaVerbosity,
} from './persona';
import { createScenario, type Scenario } from './scenario';
import { createScenarioRun, SCENARIO_RUN_STATUSES, type ScenarioRun, type ScenarioRunStatus } from './scenario-run';
import { SURVEY_QUESTION_KINDS, type SurveyQuestion } from './survey';

export interface SerializedPersona {
  readonly metadata: SerializedPublishableMetadata;
  readonly archetype: PersonaArchetype;
  readonly knowledgeLevel: PersonaLevel;
  readonly patience: PersonaLevel;
  readonly tone: string;
  readonly verbosity: PersonaVerbosity;
  readonly language: PersonaLanguage;
  readonly extraInstructions?: string;
  readonly promptOverride?: string;
}

export interface SerializedScenario {
  readonly metadata: SerializedPublishableMetadata;
  readonly target: { readonly agentId: string; readonly version: string };
  readonly persona?: { readonly personaId: string; readonly version: string };
  readonly pseudoUser?: { readonly agentId: string; readonly version: string };
  readonly goal: string;
  readonly context?: string;
  readonly maxUserTurns: number;
  readonly expectedTools?: readonly string[];
  readonly survey: readonly SurveyQuestion[];
}

export interface SerializedScenarioRun {
  readonly id: string;
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly scenario: { readonly id: string; readonly version: string };
  readonly pseudoUserRef?: { readonly type: 'persona' | 'agent'; readonly id: string; readonly version: string };
  readonly status: ScenarioRunStatus;
  readonly goalAchieved: boolean | null;
  readonly transcript: readonly { readonly speaker: 'user' | 'agent'; readonly message: string; readonly runId?: string }[];
  readonly survey: readonly { readonly questionId: string; readonly value: number | boolean | string }[];
  readonly impressions: string;
  readonly metrics: {
    readonly userTurns: number; readonly agentRuns: number; readonly totalToolCalls: number;
    readonly expectedToolHit?: { readonly expected: readonly string[]; readonly called: readonly string[]; readonly hitRate: number };
    readonly durationMs: number;
    readonly usage: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
  };
  readonly startedAt: string;
  readonly finishedAt: string;
}

const surveyQuestionSchema = z.object({
  id: z.string(), textJa: z.string(), textEn: z.string(),
  kind: z.enum(SURVEY_QUESTION_KINDS),
  min: z.number().optional(), max: z.number().optional(),
});

const personaSchema = z.object({
  metadata: serializedPublishableMetadataSchema,
  archetype: z.enum(PERSONA_ARCHETYPES),
  knowledgeLevel: z.enum(PERSONA_LEVELS),
  patience: z.enum(PERSONA_LEVELS),
  tone: z.string(),
  verbosity: z.enum(PERSONA_VERBOSITIES),
  language: z.enum(PERSONA_LANGUAGES),
  extraInstructions: z.string().optional(),
  promptOverride: z.string().optional(),
});

const scenarioSchema = z.object({
  metadata: serializedPublishableMetadataSchema,
  target: z.object({ agentId: z.string(), version: z.string() }),
  persona: z.object({ personaId: z.string(), version: z.string() }).optional(),
  pseudoUser: z.object({ agentId: z.string(), version: z.string() }).optional(),
  goal: z.string(),
  context: z.string().optional(),
  maxUserTurns: z.number(),
  expectedTools: z.array(z.string()).optional(),
  survey: z.array(surveyQuestionSchema),
});

const scenarioRunSchema = z.object({
  id: z.string(),
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  scenario: z.object({ id: z.string(), version: z.string() }),
  pseudoUserRef: z.object({ type: z.enum(['persona', 'agent']), id: z.string(), version: z.string() }).optional(),
  status: z.enum(SCENARIO_RUN_STATUSES),
  goalAchieved: z.boolean().nullable(),
  transcript: z.array(z.object({ speaker: z.enum(['user', 'agent']), message: z.string(), runId: z.string().optional() })),
  survey: z.array(z.object({ questionId: z.string(), value: z.union([z.number(), z.boolean(), z.string()]) })),
  impressions: z.string(),
  metrics: z.object({
    userTurns: z.number(), agentRuns: z.number(), totalToolCalls: z.number(),
    expectedToolHit: z.object({ expected: z.array(z.string()), called: z.array(z.string()), hitRate: z.number() }).optional(),
    durationMs: z.number(),
    usage: z.object({
      promptTokens: z.number().optional(), completionTokens: z.number().optional(), totalTokens: z.number().optional(),
    }),
  }),
  startedAt: z.string(),
  finishedAt: z.string(),
});

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export function serializePersona(persona: Persona): SerializedPersona {
  return {
    metadata: serializePublishableMetadata(persona.metadata),
    archetype: persona.archetype,
    knowledgeLevel: persona.knowledgeLevel,
    patience: persona.patience,
    tone: persona.tone,
    verbosity: persona.verbosity,
    language: persona.language,
    ...(persona.extraInstructions !== undefined ? { extraInstructions: persona.extraInstructions } : {}),
    ...(persona.promptOverride !== undefined ? { promptOverride: persona.promptOverride } : {}),
  };
}

export function deserializePersona(value: unknown): Persona {
  const parsed = personaSchema.safeParse(value);
  if (!parsed.success) throw new ValidationDomainError(`deserializePersona: ${issues(parsed.error)}`);
  const persona = parsed.data;
  return createPersona({
    ...persona,
    metadata: deserializePublishableMetadata(persona.metadata, (text) => SemVer.parse(text)),
  });
}

export function serializeScenario(scenario: Scenario): SerializedScenario {
  return {
    metadata: serializePublishableMetadata(scenario.metadata),
    target: { agentId: scenario.target.agentId, version: scenario.target.version.toString() },
    ...(scenario.persona !== undefined ? { persona: { personaId: scenario.persona.personaId, version: scenario.persona.version.toString() } } : {}),
    ...(scenario.pseudoUser !== undefined ? { pseudoUser: { agentId: scenario.pseudoUser.agentId, version: scenario.pseudoUser.version.toString() } } : {}),
    goal: scenario.goal,
    ...(scenario.context !== undefined ? { context: scenario.context } : {}),
    maxUserTurns: scenario.maxUserTurns,
    ...(scenario.expectedTools !== undefined ? { expectedTools: [...scenario.expectedTools] } : {}),
    survey: scenario.survey.map((question) => ({ ...question })),
  };
}

export function deserializeScenario(value: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(value);
  if (!parsed.success) throw new ValidationDomainError(`deserializeScenario: ${issues(parsed.error)}`);
  const scenario = parsed.data;
  const { persona, pseudoUser, ...rest } = scenario;
  return createScenario({
    ...rest,
    metadata: deserializePublishableMetadata(scenario.metadata, (text) => SemVer.parse(text)),
    target: { agentId: scenario.target.agentId, version: SemVer.parse(scenario.target.version) },
    ...(persona !== undefined ? { persona: { personaId: persona.personaId, version: SemVer.parse(persona.version) } } : {}),
    ...(pseudoUser !== undefined ? { pseudoUser: { agentId: pseudoUser.agentId, version: SemVer.parse(pseudoUser.version) } } : {}),
  });
}

export function serializeScenarioRun(run: ScenarioRun): SerializedScenarioRun {
  return structuredClone({
    id: run.id,
    scope: { ...run.scope },
    scenario: { id: run.scenario.id, version: run.scenario.version.toString() },
    ...(run.pseudoUserRef !== undefined ? { pseudoUserRef: { ...run.pseudoUserRef } } : {}),
    status: run.status,
    goalAchieved: run.goalAchieved,
    transcript: run.transcript.map((turn) => ({ ...turn })),
    survey: run.survey.map((answer) => ({ ...answer })),
    impressions: run.impressions,
    metrics: {
      userTurns: run.metrics.userTurns,
      agentRuns: run.metrics.agentRuns,
      totalToolCalls: run.metrics.totalToolCalls,
      ...(run.metrics.expectedToolHit !== undefined
        ? { expectedToolHit: { expected: [...run.metrics.expectedToolHit.expected], called: [...run.metrics.expectedToolHit.called], hitRate: run.metrics.expectedToolHit.hitRate } }
        : {}),
      durationMs: run.metrics.durationMs,
      usage: { ...run.metrics.usage },
    },
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }) as SerializedScenarioRun;
}

export function deserializeScenarioRun(value: unknown): ScenarioRun {
  const parsed = scenarioRunSchema.safeParse(value);
  if (!parsed.success) throw new ValidationDomainError(`deserializeScenarioRun: ${issues(parsed.error)}`);
  const run = parsed.data;
  return createScenarioRun({
    ...run,
    scenario: { id: run.scenario.id, version: SemVer.parse(run.scenario.version) },
  });
}

/**
 * application層: シナリオ実行オーケストレータ（v16 実装契約 §3.2 / docs/11 §4）
 *
 * 決定的な会話ループ: 疑似ユーザー（Persona prompt + 構造化出力）と対象Agent
 * （既存の保存済みAgent実行）を交互に呼び、終了後にアンケートへ回答させる。
 * 終了条件は「endConversation」「maxUserTurns 到達」「エラー」の3つのみ。
 * エラー時も途中経過（transcript / metrics）を status:'error' で保存して返す。
 */
import { randomUUID } from 'node:crypto';
import type { RunUsage } from '../../domain/run/run';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { PersonaNotFoundError, ScenarioNotFoundError, ValidationDomainError } from '../../domain/validation/errors';
import { buildPersonaSystemPrompt, composeScenarioPrompt, type PersonaLanguage } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import { createScenarioRun, type ExpectedToolHit, type ScenarioRun, type ScenarioRunPseudoUserRef, type ScenarioRunStatus, type Turn } from '../../domain/validation/scenario-run';
import type { ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import { buildSurveySchema, validateSurveyAnswers, type SurveyAnswer } from '../../domain/validation/survey';
import type { AgentHistoryMessage, AgentPreviewRun, RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import type { JsonSchemaObject, ModelMessage, ModelProviderPort, ModelUsage } from '../model/model-provider';

export interface RunScenarioInput {
  readonly scope: TenantScope;
  readonly scenarioId: string;
  /** 省略時は latest。 */
  readonly version?: SemVer;
  readonly mode: 'preview' | 'test';
  /** 評価実験から候補Agent版を差し替える。通常のScenario実行では未指定。 */
  readonly target?: { readonly agentId: string; readonly version: SemVer };
}

/** 疑似ユーザー1ターンの構造化出力スキーマ（required 全部・additionalProperties:false）。 */
export const PSEUDO_USER_TURN_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Your next utterance as the user.' },
    endConversation: { type: 'boolean', description: 'true to end the conversation (goal achieved or giving up).' },
    goalAchieved: { type: 'boolean', description: 'true if you judge the goal achieved.' },
  },
  required: ['message', 'endConversation', 'goalAchieved'],
  additionalProperties: false,
};

interface PseudoUserTurn {
  readonly message: string;
  readonly endConversation: boolean;
  readonly goalAchieved: boolean;
}

/** JSON parse + 形状検証。失敗は null（呼び出し側で1回だけ再試行）。 */
function parsePseudoUserTurn(content: string | null): PseudoUserTurn | null {
  if (content === null) return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['message'] !== 'string') return null;
  if (typeof record['endConversation'] !== 'boolean') return null;
  if (typeof record['goalAchieved'] !== 'boolean') return null;
  return { message: record['message'], endConversation: record['endConversation'], goalAchieved: record['goalAchieved'] };
}

/** 会話中に蓄積する可変状態。 */
interface ConversationState {
  readonly transcript: Turn[];
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  agentRuns: number;
  totalToolCalls: number;
  readonly calledTools: Set<string>;
  goalAchieved: boolean | null;
}

export class RunScenarioUseCase {
  constructor(
    private readonly scenarios: ScenarioRepository,
    private readonly personas: PersonaRepository,
    /** 対象Agentの1ターン = 既存の保存済みAgent実行1 Run。 */
    private readonly runAgent: RunAgentPreviewUseCase,
    /** 疑似ユーザー（発話・アンケート）用。 */
    private readonly model: ModelProviderPort,
    private readonly scenarioRuns: ScenarioRunRepository,
    /** 疑似ユーザーAgent（kind==='pseudo-user'）解決用（v18）。 */
    private readonly agents: AgentRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: RunScenarioInput, signal?: AbortSignal): Promise<ScenarioRun> {
    const scenario = input.version === undefined
      ? await this.scenarios.findLatest(input.scope, input.scenarioId)
      : await this.scenarios.findVersion(input.scope, input.scenarioId, input.version);
    if (scenario === null) {
      throw new ScenarioNotFoundError(`RunScenario: scenario not found: ${input.scenarioId}${input.version === undefined ? '' : `@${input.version.toString()}`}`);
    }
    const { systemPrompt, language, ref } = await this.resolvePseudoUser(input.scope, scenario);
    const startedAt = this.now();
    const state: ConversationState = { transcript: [], usage: {}, agentRuns: 0, totalToolCalls: 0, calledTools: new Set(), goalAchieved: null };
    let status: ScenarioRunStatus = 'max-turns';
    let survey: SurveyAnswer[] = [];

    try {
      for (let turn = 0; turn < scenario.maxUserTurns; turn += 1) {
        const reply = await this.pseudoUserTurn(systemPrompt, state, signal);
        state.goalAchieved = reply.goalAchieved;
        if (reply.endConversation) {
          // 初回発話前の終了も許容する（userTurns=0・transcript空）。
          status = 'completed';
          break;
        }
        const history: AgentHistoryMessage[] = state.transcript.map((entry) => ({
          role: entry.speaker === 'user' ? 'user' : 'assistant',
          content: entry.message,
        }));
        state.transcript.push({ speaker: 'user', message: reply.message });
        const target = input.target ?? scenario.target;
        const run = await this.runAgent.executeSaved({
          scope: input.scope,
          agentId: target.agentId,
          version: target.version,
          message: reply.message,
          mode: input.mode,
          purpose: input.target === undefined ? 'scenario' : 'evaluation',
          ...(history.length > 0 ? { history } : {}),
        }, signal);
        this.collectAgentRun(state, run);
        state.transcript.push({ speaker: 'agent', message: run.response, runId: run.runId });
      }
      // アンケートは completed / max-turns の双方で実施する。
      survey = await this.surveyTurn(systemPrompt, language, scenario, state, signal);
    } catch {
      // エラー時も途中経過（会話まで）を status:'error' で記録する。
      status = 'error';
      survey = [];
    }

    const finishedAt = this.now();
    const impressionsAnswer = survey.find((answer) => answer.questionId === 'impressions');
    const run = createScenarioRun({
      id: this.makeId(),
      scope: input.scope,
      scenario: { id: scenario.metadata.internalId, version: scenario.metadata.version },
      pseudoUserRef: ref,
      status,
      goalAchieved: state.goalAchieved,
      transcript: state.transcript,
      survey,
      impressions: typeof impressionsAnswer?.value === 'string' ? impressionsAnswer.value : '',
      metrics: {
        userTurns: state.transcript.filter((entry) => entry.speaker === 'user').length,
        agentRuns: state.agentRuns,
        totalToolCalls: state.totalToolCalls,
        ...(scenario.expectedTools !== undefined ? { expectedToolHit: this.expectedToolHit(scenario.expectedTools, state.calledTools) } : {}),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        usage: { ...state.usage },
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
    await this.scenarioRuns.save(run);
    return run;
  }

  /** 疑似ユーザー呼び出し。会話をユーザー視点で role 反転して渡す。不正JSONは1回だけ再試行。 */
  private async pseudoUserTurn(systemPrompt: string, state: ConversationState, signal?: AbortSignal): Promise<PseudoUserTurn> {
    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      ...state.transcript.map((entry): ModelMessage => ({
        role: entry.speaker === 'user' ? 'assistant' : 'user',
        content: entry.message,
      })),
    ];
    const request = { messages, responseFormat: { name: 'pseudo_user_turn', strict: true, schema: PSEUDO_USER_TURN_SCHEMA } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = await this.model.complete(request, signal);
      this.addUsage(state, completion.usage);
      const parsed = parsePseudoUserTurn(completion.message.content);
      if (parsed !== null) return parsed;
    }
    throw new ValidationDomainError('RunScenario: pseudo user returned invalid JSON twice');
  }

  /** 疑似ユーザー（persona または pseudo-user Agent）を解決し、system prompt・ラベル言語・参照を返す。 */
  private async resolvePseudoUser(scope: TenantScope, scenario: Scenario): Promise<{ systemPrompt: string; language: PersonaLanguage; ref: ScenarioRunPseudoUserRef }> {
    if (scenario.pseudoUser !== undefined) {
      const agent = await this.agents.findVersion(scope, scenario.pseudoUser.agentId, scenario.pseudoUser.version);
      if (agent === null) {
        throw new ValidationDomainError(`RunScenario: pseudo-user agent not found: ${scenario.pseudoUser.agentId}@${scenario.pseudoUser.version.toString()}`);
      }
      if (agent.kind !== 'pseudo-user') {
        throw new ValidationDomainError(`RunScenario: agent '${agent.metadata.internalId}' is not a pseudo-user agent`);
      }
      return {
        systemPrompt: composeScenarioPrompt(agent.systemPrompt, scenario.goal, scenario.context),
        language: 'ja',
        ref: { type: 'agent', id: agent.metadata.internalId, version: agent.metadata.version.toString() },
      };
    }
    if (scenario.persona !== undefined) {
      const persona = await this.personas.findVersion(scope, scenario.persona.personaId, scenario.persona.version);
      if (persona === null) {
        throw new PersonaNotFoundError(`RunScenario: persona not found: ${scenario.persona.personaId}@${scenario.persona.version.toString()}`);
      }
      return {
        systemPrompt: buildPersonaSystemPrompt(persona, scenario.goal, scenario.context),
        language: persona.language,
        ref: { type: 'persona', id: persona.metadata.internalId, version: persona.metadata.version.toString() },
      };
    }
    throw new ValidationDomainError('RunScenario: scenario has neither persona nor pseudoUser');
  }

  /** 会話終了後のアンケート回答（疑似ユーザーとして self-report）。検証失敗は1回だけ再試行。 */
  private async surveyTurn(systemPrompt: string, language: PersonaLanguage, scenario: Scenario, state: ConversationState, signal?: AbortSignal): Promise<SurveyAnswer[]> {
    const ja = language === 'ja';
    const conversation = state.transcript.length === 0
      ? (ja ? '（会話なし）' : '(no conversation)')
      : state.transcript.map((entry) => `${entry.speaker}: ${entry.message}`).join('\n');
    const content = [
      systemPrompt,
      '',
      ja ? '会話全文:' : 'Conversation transcript:',
      conversation,
      '',
      ja
        ? '上記の会話を踏まえ、この人物として各設問へ回答する。指定されたJSONスキーマに従い全設問へ回答すること。'
        : 'Based on the conversation above, answer every question as this persona, following the given JSON schema.',
    ].join('\n');
    const request = {
      messages: [{ role: 'system', content } satisfies ModelMessage],
      responseFormat: { name: 'scenario_survey', strict: true, schema: buildSurveySchema(scenario.survey) },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = await this.model.complete(request, signal);
      this.addUsage(state, completion.usage);
      try {
        return validateSurveyAnswers(scenario.survey, JSON.parse(completion.message.content ?? ''));
      } catch {
        // 1回だけ再試行する。
      }
    }
    throw new ValidationDomainError('RunScenario: pseudo user returned invalid survey answers twice');
  }

  /** 対象Agent 1 Run の usage / Tool call を集計へ反映する。 */
  private collectAgentRun(state: ConversationState, run: AgentPreviewRun): void {
    state.agentRuns += 1;
    this.addUsage(state, run.usage);
    for (const event of run.trace) {
      if (event.kind === 'tool-call') {
        state.totalToolCalls += 1;
        state.calledTools.add(event.name);
      }
    }
  }

  private addUsage(state: ConversationState, usage: ModelUsage | RunUsage | undefined): void {
    if (usage === undefined) return;
    const add = (current: number | undefined, value: number | undefined): number | undefined =>
      value === undefined ? current : (current ?? 0) + value;
    const promptTokens = add(state.usage.promptTokens, usage.promptTokens);
    const completionTokens = add(state.usage.completionTokens, usage.completionTokens);
    const totalTokens = add(state.usage.totalTokens, usage.totalTokens);
    state.usage = {
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  /** 期待Tool集合 vs 実呼び出し公開名集合。hitRate = |積| / |期待|。 */
  private expectedToolHit(expected: readonly string[], called: ReadonlySet<string>): ExpectedToolHit {
    const hit = expected.filter((name) => called.has(name)).length;
    return { expected: [...expected], called: [...called], hitRate: hit / expected.length };
  }
}

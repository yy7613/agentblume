/**
 * application層: シナリオ実行オーケストレータ（v16 実装契約 §3.2 / docs/11 §4）
 *
 * 決定的な会話ループ: 疑似ユーザー（Persona prompt + 構造化出力）と対象Agent
 * （既存の保存済みAgent実行）を交互に呼び、終了後にアンケートへ回答させる。
 * 終了条件は「endConversation」「maxUserTurns 到達」「エラー」の3つのみ。
 * エラー時も途中経過（transcript / metrics）を status:'error' で保存して返す。
 *
 * ## 失敗の記録（v41）
 *
 * かつては会話ループもアンケートも同じ空 catch へ落ち、status:'error' / survey:[] だけが残った。
 * 会話が5ターン成立していてもアンケートの1回の検証違反で全部 error になり、しかも**理由がどこにも
 * 残らなかった**ため、Factory の分析役が「Agentが悪い」と誤診していた。そこで、
 *
 * - アンケートの失敗は会話の結末（completed / max-turns）と goalAchieved を壊さない。
 *   回収できなかった事実は `error.stage='survey'` として残す。
 * - 会話中の失敗は status:'error' のまま、疑似ユーザー側（'pseudo-user'）か対象Agent側（'agent'）かを残す。
 * - 中断（AbortSignal）は失敗ではないのでそのまま投げ直す。
 * - 握り潰した例外は `logSwallowed` で1行残す。
 */
import { randomUUID } from 'node:crypto';
import type { AgentId } from '../../domain/agent/ids';
import type { RunUsage } from '../../domain/run/run';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { PersonaNotFoundError, ScenarioNotFoundError, ValidationDomainError } from '../../domain/validation/errors';
import type { ScenarioId } from '../../domain/validation/ids';
import { buildPersonaSystemPrompt, composeScenarioPrompt, type PersonaLanguage } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import type { PromptCatalogPort, PromptSpec } from '../prompt/prompt-catalog-port';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import { createScenarioRun, type ExpectedToolHit, type ScenarioRun, type ScenarioRunError, type ScenarioRunErrorStage, type ScenarioRunPseudoUserRef, type ScenarioRunStatus, type Turn } from '../../domain/validation/scenario-run';
import type { ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import { buildSurveySchema, validateSurveyAnswers, type SurveyAnswer } from '../../domain/validation/survey';
import { ToolExecutionError } from '../agent/errors';
import type { AgentHistoryMessage, AgentPreviewRun, RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import type { JsonSchemaObject, ModelMessage, ModelProviderPort, ModelUsage } from '../model/model-provider';
import { describeError, logSwallowed, type LoggerPort } from '../operations/logger';

export interface RunScenarioInput {
  readonly scope: TenantScope;
  readonly scenarioId: ScenarioId;
  /** 省略時は latest。 */
  readonly version?: SemVer;
  readonly mode: 'preview' | 'test';
  /** 評価実験から候補Agent版を差し替える。通常のScenario実行では未指定。 */
  readonly target?: { readonly agentId: AgentId; readonly version: SemVer };
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

/** 会話ループ内の失敗に「どの段で起きたか」を添えて外側の catch まで運ぶ内部例外。 */
class ScenarioStageError extends Error {
  constructor(readonly stage: ScenarioRunErrorStage, reason: string, override readonly cause: unknown) {
    super(reason);
    this.name = 'ScenarioStageError';
  }
}

/**
 * 疑似ユーザーのアンケート回答（v48 / ADR-0052）。アンケートの指示文・検証落ちの再依頼文・
 * 評点の向き（数が大きいほど高評価）を明示する一文は `prompts/validation/pseudo-user.md` にある。
 * 実測: 自由記述は「正確で明瞭」と好意的なのに scale へ 1〜2 を付ける疑似ユーザーがいた
 * （1 を「1位」と読んでいた）。評点の向きの一文はアンケートの指示文と検証落ちの再依頼文の
 * 両方へ添える（後者だけ抜けても同じ取り違えが再現するため）。
 */
export const PSEUDO_USER_PROMPT: PromptSpec = {
  id: 'validation/pseudo-user',
  sections: ['instruction.ja', 'instruction.en', 'direction.ja', 'direction.en', 'repair.ja', 'repair.en'],
};

/** 空の理由は記録側（createScenarioRun）で弾かれ、記録そのものを失う。必ず1文にする。 */
function reason(text: string): string {
  return text.trim() === '' ? 'unknown failure' : text;
}

/** 中断は「壊れた」のではなく「利用者が止めた」。失敗理由へ化けさせず投げ直すために見分ける。 */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

/** Tool実行由来の失敗は、どのTool・どのノードで落ちたかまで理由に残す（Factory の分析役が読む）。 */
function describeAgentFailure(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof ToolExecutionError) {
      const where = [`tool ${current.tool.publishName ?? current.tool.internalId}`, ...(current.nodeId === undefined ? [] : [`node ${current.nodeId}`])].join(' / ');
      return `${describeError(error)} (${where})`;
    }
    current = current.cause;
  }
  return describeError(error);
}

/** アンケート回収の結果。失敗しても会話の結末は壊さない。 */
type SurveyOutcome =
  | { readonly ok: true; readonly answers: SurveyAnswer[] }
  | { readonly ok: false; readonly message: string; readonly cause: unknown };

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
    /** アンケートの指示文・再依頼文・評点の向きの一文（v48 / ADR-0052）。 */
    private readonly prompts: PromptCatalogPort,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    /** 握り潰した失敗の痕跡（未配線なら何も出さない）。 */
    private readonly logger?: LoggerPort,
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
    let failure: ScenarioRunError | undefined;

    try {
      for (let turn = 0; turn < scenario.maxUserTurns; turn += 1) {
        const reply = await this.pseudoUserTurn(systemPrompt, state, signal)
          .catch((error: unknown) => { throw this.stageError('pseudo-user', error, signal); });
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
        }, signal).catch((error: unknown) => { throw this.stageError('agent', error, signal); });
        this.collectAgentRun(state, run);
        state.transcript.push({ speaker: 'agent', message: run.response, runId: run.runId });
      }
    } catch (error) {
      // 中断は失敗ではない（「AIが壊れた」と記録されると利用者が止めたのか分からなくなる）。
      if (isAbort(error, signal)) throw error;
      // エラー時も途中経過（会話まで）を status:'error' で記録する。理由は error に残す。
      status = 'error';
      survey = [];
      const stage = error instanceof ScenarioStageError ? error.stage : 'pseudo-user';
      failure = { stage, message: reason(error instanceof Error ? error.message : String(error)) };
      logSwallowed(this.logger, `RunScenario: the conversation of scenario '${scenario.metadata.internalId}' failed at the ${stage} stage`, error instanceof ScenarioStageError ? error.cause : error, { scenarioId: scenario.metadata.internalId, stage });
    }

    // アンケートは completed / max-turns の双方で実施する。
    // 回収できなくても会話の結末（status / goalAchieved）は壊さない: 理由だけ残す。
    if (status !== 'error') {
      const outcome = await this.surveyTurn(systemPrompt, language, scenario, state, signal);
      if (outcome.ok) {
        survey = outcome.answers;
      } else {
        failure = { stage: 'survey', message: reason(outcome.message) };
        logSwallowed(this.logger, `RunScenario: the survey of scenario '${scenario.metadata.internalId}' could not be collected; keeping the conversation result`, outcome.cause, { scenarioId: scenario.metadata.internalId, stage: 'survey' });
      }
    }

    const finishedAt = this.now();
    const impressionsAnswer = survey.find((answer) => answer.questionId === 'impressions');
    const run = createScenarioRun({
      id: this.makeId(),
      scope: input.scope,
      scenario: { id: scenario.metadata.internalId, version: scenario.metadata.version },
      pseudoUserRef: ref,
      status,
      ...(failure !== undefined ? { error: failure } : {}),
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

  /** 会話ループの失敗を段つきの例外へ包む。中断だけはそのまま投げ直す。 */
  private stageError(stage: ScenarioRunErrorStage, error: unknown, signal: AbortSignal | undefined): unknown {
    if (isAbort(error, signal)) return error;
    return new ScenarioStageError(stage, stage === 'agent' ? describeAgentFailure(error) : describeError(error), error);
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

  /**
   * 会話終了後のアンケート回答（疑似ユーザーとして self-report）。
   *
   * 検証に落ちたときは**同じ依頼をもう一度送らない**（同じ答えが返るだけだった）。
   * 直前の回答と「どの検証に落ちたか」を添えて1回だけ直してもらう
   * （`application/contract/llm-criteria.ts` の completeWithRepair と同じ型）。
   * それでも駄目なら回収を諦め、理由を返す（会話の結末は呼び出し側が保つ）。
   */
  private async surveyTurn(systemPrompt: string, language: PersonaLanguage, scenario: Scenario, state: ConversationState, signal?: AbortSignal): Promise<SurveyOutcome> {
    const ja = language === 'ja';
    const template = this.prompts.get(PSEUDO_USER_PROMPT.id);
    const direction = template.render(ja ? 'direction.ja' : 'direction.en');
    const conversation = state.transcript.length === 0
      ? (ja ? '（会話なし）' : '(no conversation)')
      : state.transcript.map((entry) => `${entry.speaker}: ${entry.message}`).join('\n');
    const content = [
      systemPrompt,
      '',
      ja ? '会話全文:' : 'Conversation transcript:',
      conversation,
      '',
      template.render(ja ? 'instruction.ja' : 'instruction.en'),
      direction,
    ].join('\n');
    const request = {
      messages: [{ role: 'system', content } satisfies ModelMessage],
      responseFormat: { name: 'scenario_survey', strict: true, schema: buildSurveySchema(scenario.survey) },
    };
    try {
      const first = await this.model.complete(request, signal);
      this.addUsage(state, first.usage);
      const parsedFirst = this.parseSurvey(scenario, first.message.content);
      if (parsedFirst.ok) return { ok: true, answers: parsedFirst.answers };

      const repair: ModelMessage[] = [
        ...request.messages,
        { role: 'assistant', content: first.message.content ?? '' },
        {
          role: 'user',
          content: template.render(ja ? 'repair.ja' : 'repair.en', { reason: parsedFirst.message, direction }),
        },
      ];
      const second = await this.model.complete({ ...request, messages: repair }, signal);
      this.addUsage(state, second.usage);
      const parsedSecond = this.parseSurvey(scenario, second.message.content);
      if (parsedSecond.ok) return { ok: true, answers: parsedSecond.answers };
      return { ok: false, message: parsedSecond.message, cause: parsedSecond.cause };
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return { ok: false, message: describeError(error), cause: error };
    }
  }

  /** アンケート応答のJSON parse + 設問に対する検証。失敗の説明は修復依頼へそのまま載せる。 */
  private parseSurvey(scenario: Scenario, content: string | null): { ok: true; answers: SurveyAnswer[] } | { ok: false; message: string; cause: unknown } {
    try {
      return { ok: true, answers: validateSurveyAnswers(scenario.survey, JSON.parse(content ?? '')) };
    } catch (error) {
      const message = error instanceof ValidationDomainError ? error.message : `survey answers were not valid JSON: ${describeError(error)}`;
      return { ok: false, message, cause: error };
    }
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

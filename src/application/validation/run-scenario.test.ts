import { describe, expect, it } from 'vitest';
import { createAgent, type Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import type { Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { RunRecord } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { PersonaNotFoundError, ScenarioNotFoundError } from '../../domain/validation/errors';
import { createPersona, type Persona } from '../../domain/validation/persona';
import type { PersonaRepository, PersonaSummary } from '../../domain/validation/persona-repository';
import { createScenario, type Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository, ScenarioSummary } from '../../domain/validation/scenario-repository';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunFilter, ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import type { SurveyQuestion } from '../../domain/validation/survey';
import { bundledPrompts } from '../../test-support/prompts';
import { EtlEngine } from '../etl/engine';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import { RunFailedError, ToolExecutionError } from '../agent/errors';
import type { LogContext, LoggerPort } from '../operations/logger';
import { RunScenarioUseCase } from './run-scenario';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const v1 = SemVer.of(1, 0, 0);

const inputSchema: Schema = { columns: [
  { name: 'name', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: false },
] };

function makeTool(): Tool {
  return createTool({
    metadata: { internalId: 'score-tool', workingName: 'score-draft', displayName: 'Score lookup', publishName: 'score_lookup', version: SemVer.parse('1.2.0'), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect: 'read-only',
    graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema: inputSchema, sample: { name: 'sample', score: 0 } } }], edges: [] },
    inputSchema,
    outputSchema: inputSchema,
  });
}

function makeAgent(withTool: boolean): Agent {
  return createAgent({
    metadata: { internalId: 'agent-1', workingName: 'agent', displayName: 'Agent', publishName: 'agent_one', version: v1, owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'Help the user.',
    tools: withTool ? [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }] : [],
  });
}

function makePseudoUserAgent(): Agent {
  return createAgent({
    metadata: { internalId: 'pseudo-1', workingName: 'pu', displayName: 'Pseudo User', publishName: 'pseudo_one', version: v1, owner: 'owner', state: 'draft', tenant: scope },
    kind: 'pseudo-user', systemPrompt: 'あなたは疑似ユーザーである。', tools: [], skills: [], agents: [],
    persona: { personaId: 'persona-1', version: v1 },
  });
}

const SURVEY: readonly SurveyQuestion[] = [
  { id: 'q1', textJa: '目的達成?', textEn: 'Achieved?', kind: 'boolean' },
  { id: 'q2', textJa: '満足度', textEn: 'Satisfaction', kind: 'scale', min: 1, max: 5 },
  { id: 'impressions', textJa: '感想', textEn: 'Impressions', kind: 'text' },
];

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return createPersona({
    metadata: { internalId: 'persona-1', workingName: 'p', displayName: 'Novice', publishName: 'novice_user', version: v1, owner: 'owner', state: 'draft', tenant: scope },
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja',
    ...overrides,
  });
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return createScenario({
    metadata: { internalId: 'scenario-1', workingName: 's', displayName: 'Scenario', publishName: 'scenario_one', version: v1, owner: 'owner', state: 'draft', tenant: scope },
    target: { agentId: 'agent-1', version: v1 },
    persona: { personaId: 'persona-1', version: v1 },
    goal: '先月の売上サマリを得る',
    maxUserTurns: 4,
    survey: SURVEY,
    ...overrides,
  });
}

class QueueModel implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  /** キューが尽きたときに投げる例外（中断の再現に差し替える）。 */
  exhausted: () => Error = () => new Error('missing completion');
  constructor(private readonly queue: ModelCompletion[], private readonly caps: readonly ModelCapability[] = ['chat', 'tool-calling', 'structured-output']) {}
  capabilities(): readonly ModelCapability[] { return this.caps; }
  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    this.requests.push(structuredClone(request));
    const item = this.queue.shift();
    if (item === undefined) throw this.exhausted();
    return item;
  }
}

class FakeLogger implements LoggerPort {
  readonly warnings: { readonly message: string; readonly context?: LogContext }[] = [];
  info(): void {}
  warn(message: string, context?: LogContext): void { this.warnings.push({ message, ...(context === undefined ? {} : { context }) }); }
  error(): void {}
}

class MemoryRuns implements RunRepository {
  readonly records = new Map<string, RunRecord>();
  async save(record: RunRecord): Promise<void> { this.records.set(record.runId, structuredClone(record)); }
  async find(_scope: TenantScope, runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async list(): Promise<RunRecord[]> { return [...this.records.values()]; }
  async listAllByStatus(status: RunRecord['status']): Promise<RunRecord[]> { return [...this.records.values()].filter((record) => record.status === status); }
  async listScopes(): Promise<TenantScope[]> { return [...new Map([...this.records.values()].map((record) => [`${record.scope.tenantId} ${record.scope.workspaceId}`, record.scope])).values()]; }
}

class StaticTools implements ToolRepository {
  constructor(private readonly tool: Tool | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Tool | null> { return this.tool; }
  async findLatest(): Promise<Tool | null> { return this.tool; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ToolSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

class StaticAgents implements AgentRepository {
  constructor(private readonly agent: Agent | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Agent | null> { return this.agent; }
  async findLatest(): Promise<Agent | null> { return this.agent; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

class StaticPersonas implements PersonaRepository {
  constructor(private readonly persona: Persona | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Persona | null> { return this.persona; }
  async findLatest(): Promise<Persona | null> { return this.persona; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<PersonaSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

class StaticScenarios implements ScenarioRepository {
  readonly findVersionCalls: SemVer[] = [];
  constructor(private readonly scenario: Scenario | null) {}
  async save(): Promise<void> {}
  async findVersion(_scope: TenantScope, _id: string, version: SemVer): Promise<Scenario | null> { this.findVersionCalls.push(version); return this.scenario; }
  async findLatest(): Promise<Scenario | null> { return this.scenario; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ScenarioSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

class MemoryScenarioRuns implements ScenarioRunRepository {
  readonly saved: ScenarioRun[] = [];
  async save(run: ScenarioRun): Promise<void> { this.saved.push(run); }
  async find(_scope: TenantScope, id: string): Promise<ScenarioRun | null> { return this.saved.find((run) => run.id === id) ?? null; }
  async list(_scope: TenantScope, _filter?: ScenarioRunFilter): Promise<ScenarioRun[]> { return [...this.saved]; }
}

/** 疑似ユーザーの1ターン応答（構造化出力）。 */
function puTurn(message: string, endConversation: boolean, goalAchieved: boolean): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify({ message, endConversation, goalAchieved }) }, finishReason: 'stop', usage: { totalTokens: 10 } };
}

function surveyOk(): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 4, impressions: '概ね良かった' }) }, finishReason: 'stop', usage: { totalTokens: 7 } };
}

function agentSay(content: string): ModelCompletion {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: { totalTokens: 5 } };
}

interface Harness {
  readonly useCase: RunScenarioUseCase;
  readonly puModel: QueueModel;
  readonly agentModel: QueueModel;
  readonly scenarioRuns: MemoryScenarioRuns;
  readonly scenarios: StaticScenarios;
  readonly logger: FakeLogger;
}

function harness(options: {
  scenario?: Scenario | null; persona?: Persona | null; pseudoUserAgent?: Agent | null;
  pu: ModelCompletion[]; agent: ModelCompletion[]; withTool?: boolean;
  /** 対象Agent実行を差し替える（Tool実行失敗の再現用）。 */
  runAgent?: RunAgentPreviewUseCase;
}): Harness {
  const puModel = new QueueModel(options.pu);
  const agentModel = new QueueModel(options.agent);
  const scenarioRuns = new MemoryScenarioRuns();
  const logger = new FakeLogger();
  let agentRunSeq = 0;
  const runAgent = options.runAgent ?? new RunAgentPreviewUseCase(
    new StaticTools(makeTool()), new EtlEngine(createDefaultRegistry()), agentModel, new MemoryRuns(),
    () => `agent-run-${(agentRunSeq += 1)}`, undefined, new StaticAgents(makeAgent(options.withTool ?? false)),
  );
  const scenarios = new StaticScenarios(options.scenario === undefined ? makeScenario() : options.scenario);
  let tick = 0;
  const useCase = new RunScenarioUseCase(
    scenarios,
    new StaticPersonas(options.persona === undefined ? makePersona() : options.persona),
    runAgent, puModel, scenarioRuns,
    new StaticAgents(options.pseudoUserAgent ?? null),
    bundledPrompts(),
    () => 'scenario-run-1',
    () => new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0) + (tick += 1) * 1000),
    logger,
  );
  return { useCase, puModel, agentModel, scenarioRuns, scenarios, logger };
}

const input = { scope, scenarioId: 'scenario-1', mode: 'preview' as const };

describe('RunScenarioUseCase', () => {
  it('2ターンで目標達成 → completed・survey保存・metrics正確・履歴注入とrole反転', async () => {
    const h = harness({
      pu: [puTurn('質問1', false, false), puTurn('質問2', false, false), puTurn('ありがとう', true, true), surveyOk()],
      agent: [agentSay('回答1'), agentSay('回答2')],
    });
    const run = await h.useCase.execute(input);

    expect(run.status).toBe('completed');
    expect(run.goalAchieved).toBe(true);
    expect(run.transcript).toEqual([
      { speaker: 'user', message: '質問1' },
      { speaker: 'agent', message: '回答1', runId: 'agent-run-1' },
      { speaker: 'user', message: '質問2' },
      { speaker: 'agent', message: '回答2', runId: 'agent-run-2' },
    ]);
    expect(run.survey).toEqual([
      { questionId: 'q1', value: true },
      { questionId: 'q2', value: 4 },
      { questionId: 'impressions', value: '概ね良かった' },
    ]);
    expect(run.impressions).toBe('概ね良かった');
    expect(run.metrics).toEqual({
      userTurns: 2, agentRuns: 2, totalToolCalls: 0,
      durationMs: 1000,
      usage: { totalTokens: 10 * 3 + 7 + 5 * 2 },
    });
    expect(run.startedAt).toBe('2026-07-01T00:00:01.000Z');
    expect(run.finishedAt).toBe('2026-07-01T00:00:02.000Z');
    expect(run.scenario).toMatchObject({ id: 'scenario-1' });
    expect(run.scenario.version.toString()).toBe('1.0.0');

    // 結果は ScenarioRunRepository へ保存される。
    expect(h.scenarioRuns.saved).toEqual([run]);

    // 疑似ユーザーへは会話をユーザー視点で role 反転して渡す（自発話=assistant / Agent応答=user）。
    expect(h.puModel.requests[1]?.messages.map((message) => message.role)).toEqual(['system', 'assistant', 'user']);
    expect(h.puModel.requests[1]?.messages[1]).toMatchObject({ role: 'assistant', content: '質問1' });
    expect(h.puModel.requests[1]?.messages[2]).toMatchObject({ role: 'user', content: '回答1' });
    expect(h.puModel.requests[0]?.responseFormat).toMatchObject({ name: 'pseudo_user_turn', strict: true });

    // 対象Agentの2ターン目には会話履歴が system 直後へ注入される。
    expect(h.agentModel.requests[1]?.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(h.agentModel.requests[1]?.messages[1]).toMatchObject({ role: 'user', content: '質問1' });
    expect(h.agentModel.requests[1]?.messages[2]).toMatchObject({ role: 'assistant', content: '回答1' });
    expect(h.agentModel.requests[1]?.messages[3]).toMatchObject({ role: 'user', content: '質問2' });

    // アンケートは設問から構築したスキーマの構造化出力で回収する。
    const surveyRequest = h.puModel.requests[3];
    expect(surveyRequest?.responseFormat).toMatchObject({ name: 'scenario_survey', strict: true });
    expect(surveyRequest?.responseFormat?.schema.required).toEqual(['q1', 'q2', 'impressions']);
    expect(surveyRequest?.messages).toHaveLength(1);
    expect(surveyRequest?.messages[0]?.content).toContain('質問1');
    expect(surveyRequest?.messages[0]?.content).toContain('回答2');
  });

  it('pseudoUser Agent経路: agentのsystemPromptを基底に合成しpseudoUserRefを記録する（v18）', async () => {
    const scenario = makeScenario({ persona: undefined, pseudoUser: { agentId: 'pseudo-1', version: v1 } });
    const h = harness({
      scenario, persona: null, pseudoUserAgent: makePseudoUserAgent(),
      pu: [puTurn('質問', false, false), puTurn('done', true, true), surveyOk()],
      agent: [agentSay('回答')],
    });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('completed');
    expect(run.pseudoUserRef).toEqual({ type: 'agent', id: 'pseudo-1', version: '1.0.0' });
    const puSystem = h.puModel.requests[0]?.messages[0]?.content;
    expect(puSystem).toContain('あなたは疑似ユーザーである。');
    expect(puSystem).toContain('目標: 先月の売上サマリを得る');
  });

  it('pseudoUser Agentがkind不一致なら実行を拒否する（v18）', async () => {
    const scenario = makeScenario({ persona: undefined, pseudoUser: { agentId: 'agent-1', version: v1 } });
    const h = harness({ scenario, persona: null, pseudoUserAgent: makeAgent(false), pu: [], agent: [] });
    await expect(h.useCase.execute(input)).rejects.toThrow(/not a pseudo-user/);
  });

  it('persona経路でも pseudoUserRef(type:persona) を記録する（v18）', async () => {
    const h = harness({ pu: [puTurn('done', true, true), surveyOk()], agent: [] });
    const run = await h.useCase.execute(input);
    expect(run.pseudoUserRef).toEqual({ type: 'persona', id: 'persona-1', version: '1.0.0' });
  });

  it('maxUserTurns 到達 → max-turns（アンケートは実施する）', async () => {
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), surveyOk()],
      agent: [agentSay('回答1')],
    });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('max-turns');
    expect(run.metrics.userTurns).toBe(1);
    expect(run.survey).toHaveLength(3);
    expect(h.puModel.requests).toHaveLength(2);
  });

  it('疑似ユーザーの不正JSONは1回だけ再試行して復帰する', async () => {
    const h = harness({
      pu: [
        { message: { role: 'assistant', content: 'not-json' }, finishReason: 'stop', usage: { totalTokens: 1 } },
        puTurn('やめます', true, false),
        surveyOk(),
      ],
      agent: [],
    });
    const run = await h.useCase.execute(input);
    // 初回発話前の終了も許容: userTurns=0・transcript空。goalAchieved=false が伝搬する。
    expect(run.status).toBe('completed');
    expect(run.goalAchieved).toBe(false);
    expect(run.transcript).toEqual([]);
    expect(run.metrics.userTurns).toBe(0);
    expect(run.metrics.agentRuns).toBe(0);
    expect(h.puModel.requests).toHaveLength(3);
  });

  it('疑似ユーザーの不正JSONが2回続くと status:error（途中経過は保存）', async () => {
    const bad: ModelCompletion = { message: { role: 'assistant', content: '{"message":1}' }, finishReason: 'stop' };
    const h = harness({ pu: [bad, bad], agent: [] });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('error');
    expect(run.goalAchieved).toBeNull();
    expect(run.survey).toEqual([]);
    expect(run.impressions).toBe('');
    expect(h.scenarioRuns.saved).toEqual([run]);
    // 理由を残す: 疑似ユーザー段の失敗。
    expect(run.error).toMatchObject({ stage: 'pseudo-user' });
    expect(run.error?.message).toContain('invalid JSON twice');
    expect(h.logger.warnings[0]?.message).toContain('pseudo-user');
  });

  it('expectedToolHit を期待集合と実呼び出し公開名集合から計算する', async () => {
    const h = harness({
      scenario: makeScenario({ expectedTools: ['score_lookup', 'missing_tool'] }),
      withTool: true,
      pu: [puTurn('スコアは?', false, false), puTurn('わかった', true, true), surveyOk()],
      agent: [
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls', usage: { totalTokens: 5 } },
        agentSay('Alice は 42 点です'),
      ],
    });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('completed');
    expect(run.metrics.totalToolCalls).toBe(1);
    expect(run.metrics.expectedToolHit).toEqual({ expected: ['score_lookup', 'missing_tool'], called: ['score_lookup'], hitRate: 0.5 });
  });

  it('Agent実行の失敗時も途中経過を status:error で保存して返す', async () => {
    const h = harness({ pu: [puTurn('質問1', false, false)], agent: [] });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('error');
    expect(run.transcript).toEqual([{ speaker: 'user', message: '質問1' }]);
    expect(run.metrics.userTurns).toBe(1);
    expect(run.metrics.agentRuns).toBe(0);
    expect(run.goalAchieved).toBe(false);
    expect(run.survey).toEqual([]);
    expect(h.scenarioRuns.saved).toEqual([run]);
    expect(run.error?.stage).toBe('agent');
  });

  it('異常: Tool実行の失敗は stage:agent として、どのTool・どのノードかまで理由に残す', async () => {
    const failure = new ToolExecutionError(
      { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' },
      Object.assign(new Error('列 score が見つからない'), { nodeId: 'filter-1' }),
    );
    const runAgent = {
      executeSaved: async (): Promise<never> => { throw new RunFailedError('agent-run-1', failure); },
    } as unknown as RunAgentPreviewUseCase;
    const h = harness({ pu: [puTurn('質問1', false, false)], agent: [], runAgent });

    const run = await h.useCase.execute(input);
    expect(run.status).toBe('error');
    expect(run.error?.stage).toBe('agent');
    expect(run.error?.message).toContain('列 score が見つからない');
    expect(run.error?.message).toContain('score_lookup');
    expect(run.error?.message).toContain('filter-1');
    // 握り潰した例外はログにも1行残す。
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]?.context).toMatchObject({ stage: 'agent', scenarioId: 'scenario-1' });
  });

  it('境界: アンケートの範囲外回答は「何に落ちたか」と前回の回答を添えて1回だけ直させる', async () => {
    const badSurvey: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 0, impressions: 'x' }) }, finishReason: 'stop' };
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), badSurvey, surveyOk()],
      agent: [agentSay('回答1')],
    });
    const run = await h.useCase.execute(input);

    expect(run.status).toBe('max-turns');
    expect(run.survey).toHaveLength(3);
    expect(run.error).toBeUndefined();
    // 修復依頼: 直前の回答（assistant）+ 失敗した検証の文言を添えて送り直す。
    const repair = h.puModel.requests[2];
    expect(repair?.messages.map((message) => message.role)).toEqual(['system', 'assistant', 'user']);
    expect(repair?.messages[1]?.content).toBe(JSON.stringify({ q1: true, q2: 0, impressions: 'x' }));
    expect(repair?.messages[2]?.content).toContain("survey answer 'q2' must be between 1 and 5");
    expect(repair?.responseFormat?.schema.properties['q2']).toMatchObject({ minimum: 1, maximum: 5 });
  });

  it('正常: アンケートの指示文と検証落ちの再依頼文の両方に評点の向き（大きいほど高評価）を明示する一文が入る（実測: 自由記述は好意的なのにscaleへ低い点を付ける取り違えがあった）', async () => {
    const badSurvey: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 0, impressions: 'x' }) }, finishReason: 'stop' };
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), badSurvey, surveyOk()],
      agent: [agentSay('回答1')],
    });
    await h.useCase.execute(input);

    const direction = '評点は数が大きいほど高評価である（最小値 = 最も悪い、最大値 = 最も良い）。自由記述の内容と評点を一致させること。';
    const firstRequest = h.puModel.requests[1];
    expect(firstRequest?.messages[0]?.content).toContain(direction);
    const repair = h.puModel.requests[2];
    expect(repair?.messages[2]?.content).toContain(direction);
  });

  it('正常: 疑似ユーザーが英語（persona.language=en）なら、指示文と再依頼文の向きの一文も英語になる', async () => {
    const badSurvey: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 0, impressions: 'x' }) }, finishReason: 'stop' };
    const h = harness({
      persona: makePersona({ language: 'en' }),
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('question', false, false), badSurvey, surveyOk()],
      agent: [agentSay('answer')],
    });
    await h.useCase.execute(input);

    const direction = 'Higher scores mean a better evaluation (the minimum value is the worst, the maximum value is the best). Keep your free-text answers consistent with your scores.';
    const firstRequest = h.puModel.requests[1];
    expect(firstRequest?.messages[0]?.content).toContain(direction);
    const repair = h.puModel.requests[2];
    expect(repair?.messages[2]?.content).toContain(direction);
  });

  it('従来どおり: アンケート初回依頼のsystem文（ja）はプロンプトファイル移行後も完全一致する（v48移行のfixture）', async () => {
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), surveyOk()],
      agent: [agentSay('回答1')],
    });
    await h.useCase.execute(input);
    const content = String(h.puModel.requests[1]?.messages[0]?.content);
    const tail = [
      '',
      '会話全文:',
      'user: 質問1\nagent: 回答1',
      '',
      '上記の会話を踏まえ、この人物として各設問へ回答する。指定されたJSONスキーマに従い全設問へ回答すること。',
      '評点は数が大きいほど高評価である（最小値 = 最も悪い、最大値 = 最も良い）。自由記述の内容と評点を一致させること。',
    ].join('\n');
    expect(content.endsWith(tail)).toBe(true);
  });

  it('従来どおり: アンケート初回依頼のsystem文（en）はプロンプトファイル移行後も完全一致する（v48移行のfixture）', async () => {
    const h = harness({
      persona: makePersona({ language: 'en' }),
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('question', false, false), surveyOk()],
      agent: [agentSay('answer')],
    });
    await h.useCase.execute(input);
    const content = String(h.puModel.requests[1]?.messages[0]?.content);
    const tail = [
      '',
      'Conversation transcript:',
      'user: question\nagent: answer',
      '',
      'Based on the conversation above, answer every question as this persona, following the given JSON schema.',
      'Higher scores mean a better evaluation (the minimum value is the worst, the maximum value is the best). Keep your free-text answers consistent with your scores.',
    ].join('\n');
    expect(content.endsWith(tail)).toBe(true);
  });

  it('従来どおり: アンケート検証落ちの再依頼文（ja/en）はプロンプトファイル移行後も完全一致する（v48移行のfixture）', async () => {
    const badSurveyJa: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 0, impressions: 'x' }) }, finishReason: 'stop' };
    const ja = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), badSurveyJa, surveyOk()],
      agent: [agentSay('回答1')],
    });
    await ja.useCase.execute(input);
    const jaRepair = String(ja.puModel.requests[2]?.messages[2]?.content);
    expect(jaRepair).toBe(
      "前回の回答は検証に通らなかった: survey answer 'q2' must be between 1 and 5。指定のJSONスキーマ（範囲も含む）を満たすJSONだけを返し直すこと。"
      + '評点は数が大きいほど高評価である（最小値 = 最も悪い、最大値 = 最も良い）。自由記述の内容と評点を一致させること。',
    );

    const badSurveyEn: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 0, impressions: 'x' }) }, finishReason: 'stop' };
    const en = harness({
      persona: makePersona({ language: 'en' }),
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('question', false, false), badSurveyEn, surveyOk()],
      agent: [agentSay('answer')],
    });
    await en.useCase.execute(input);
    const enRepair = String(en.puModel.requests[2]?.messages[2]?.content);
    expect(enRepair).toBe(
      "Your previous answer failed validation: survey answer 'q2' must be between 1 and 5. Return only JSON that satisfies the given schema, including the allowed ranges. "
      + 'Higher scores mean a better evaluation (the minimum value is the worst, the maximum value is the best). Keep your free-text answers consistent with your scores.',
    );
  });

  it('異常: アンケートが2回とも不正でも会話の結末は壊さず、理由を stage:survey で残す', async () => {
    const badSurvey: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 99, impressions: 'x' }) }, finishReason: 'stop' };
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), badSurvey, badSurvey],
      agent: [agentSay('回答1')],
    });
    const run = await h.useCase.execute(input);

    // 会話は5ターン分の証拠を持っている。アンケート1問の違反で捨てない。
    expect(run.status).toBe('max-turns');
    expect(run.goalAchieved).toBe(false);
    expect(run.transcript).toHaveLength(2);
    expect(run.survey).toEqual([]);
    expect(run.impressions).toBe('');
    expect(run.error).toEqual({ stage: 'survey', message: "survey answer 'q2' must be between 1 and 5" });
    expect(h.puModel.requests).toHaveLength(3);
    expect(h.logger.warnings[0]?.context).toMatchObject({ stage: 'survey' });
    expect(h.scenarioRuns.saved).toEqual([run]);
  });

  it('異常: アンケート呼び出し自体が失敗しても会話は completed のまま理由だけ残す', async () => {
    const h = harness({ pu: [puTurn('もう十分', true, true)], agent: [] });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('completed');
    expect(run.goalAchieved).toBe(true);
    expect(run.error?.stage).toBe('survey');
    expect(run.error?.message).toContain('missing completion');
  });

  it('例外: 中断は失敗理由へ化けさせずそのまま投げ直す（会話中・アンケート中とも）', async () => {
    const controller = new AbortController();
    const h = harness({ pu: [], agent: [] });
    h.puModel.exhausted = () => { controller.abort(); return new DOMException('aborted', 'AbortError') as unknown as Error; };
    // 疑似ユーザー段で中断（「AIが壊れた」と記録されると利用者が止めたのか分からなくなる）。
    await expect(h.useCase.execute(input, controller.signal)).rejects.toThrow(/abort/i);
    expect(h.scenarioRuns.saved).toEqual([]);

    // アンケート段。
    const surveyController = new AbortController();
    const s = harness({ pu: [puTurn('done', true, true)], agent: [] });
    s.puModel.exhausted = () => { surveyController.abort(); return new DOMException('aborted', 'AbortError') as unknown as Error; };
    await expect(s.useCase.execute(input, surveyController.signal)).rejects.toThrow(/abort/i);
    expect(s.scenarioRuns.saved).toEqual([]);
  });

  it('version 指定時は findVersion で解決し、未存在は NotFound 系を投げる', async () => {
    const versioned = harness({ pu: [puTurn('', true, true), surveyOk()], agent: [] });
    await versioned.useCase.execute({ ...input, version: SemVer.of(1, 0, 0) });
    expect(versioned.scenarios.findVersionCalls.map(String)).toEqual(['1.0.0']);

    const noScenario = harness({ scenario: null, pu: [], agent: [] });
    await expect(noScenario.useCase.execute(input)).rejects.toBeInstanceOf(ScenarioNotFoundError);
    const noPersona = harness({ persona: null, pu: [], agent: [] });
    await expect(noPersona.useCase.execute(input)).rejects.toBeInstanceOf(PersonaNotFoundError);
    expect(noScenario.scenarioRuns.saved).toEqual([]);
  });
});

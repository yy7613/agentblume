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
import { EtlEngine } from '../etl/engine';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
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

const SURVEY: readonly SurveyQuestion[] = [
  { id: 'q1', textJa: '目的達成?', textEn: 'Achieved?', kind: 'boolean' },
  { id: 'q2', textJa: '満足度', textEn: 'Satisfaction', kind: 'scale', min: 1, max: 5 },
  { id: 'impressions', textJa: '感想', textEn: 'Impressions', kind: 'text' },
];

function makePersona(): Persona {
  return createPersona({
    metadata: { internalId: 'persona-1', workingName: 'p', displayName: 'Novice', publishName: 'novice_user', version: v1, owner: 'owner', state: 'draft', tenant: scope },
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja',
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
  constructor(private readonly queue: ModelCompletion[], private readonly caps: readonly ModelCapability[] = ['chat', 'tool-calling', 'structured-output']) {}
  capabilities(): readonly ModelCapability[] { return this.caps; }
  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    this.requests.push(structuredClone(request));
    const item = this.queue.shift();
    if (item === undefined) throw new Error('missing completion');
    return item;
  }
}

class MemoryRuns implements RunRepository {
  readonly records = new Map<string, RunRecord>();
  async save(record: RunRecord): Promise<void> { this.records.set(record.runId, structuredClone(record)); }
  async find(_scope: TenantScope, runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async list(): Promise<RunRecord[]> { return [...this.records.values()]; }
}

class StaticTools implements ToolRepository {
  constructor(private readonly tool: Tool | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Tool | null> { return this.tool; }
  async findLatest(): Promise<Tool | null> { return this.tool; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ToolSummary[]> { return []; }
}

class StaticAgents implements AgentRepository {
  constructor(private readonly agent: Agent | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Agent | null> { return this.agent; }
  async findLatest(): Promise<Agent | null> { return this.agent; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
}

class StaticPersonas implements PersonaRepository {
  constructor(private readonly persona: Persona | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Persona | null> { return this.persona; }
  async findLatest(): Promise<Persona | null> { return this.persona; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<PersonaSummary[]> { return []; }
}

class StaticScenarios implements ScenarioRepository {
  readonly findVersionCalls: SemVer[] = [];
  constructor(private readonly scenario: Scenario | null) {}
  async save(): Promise<void> {}
  async findVersion(_scope: TenantScope, _id: string, version: SemVer): Promise<Scenario | null> { this.findVersionCalls.push(version); return this.scenario; }
  async findLatest(): Promise<Scenario | null> { return this.scenario; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ScenarioSummary[]> { return []; }
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
}

function harness(options: {
  scenario?: Scenario | null; persona?: Persona | null;
  pu: ModelCompletion[]; agent: ModelCompletion[]; withTool?: boolean;
}): Harness {
  const puModel = new QueueModel(options.pu);
  const agentModel = new QueueModel(options.agent);
  const scenarioRuns = new MemoryScenarioRuns();
  let agentRunSeq = 0;
  const runAgent = new RunAgentPreviewUseCase(
    new StaticTools(makeTool()), new EtlEngine(createDefaultRegistry()), agentModel, new MemoryRuns(),
    () => `agent-run-${(agentRunSeq += 1)}`, undefined, new StaticAgents(makeAgent(options.withTool ?? false)),
  );
  const scenarios = new StaticScenarios(options.scenario === undefined ? makeScenario() : options.scenario);
  let tick = 0;
  const useCase = new RunScenarioUseCase(
    scenarios,
    new StaticPersonas(options.persona === undefined ? makePersona() : options.persona),
    runAgent, puModel, scenarioRuns,
    () => 'scenario-run-1',
    () => new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0) + (tick += 1) * 1000),
  );
  return { useCase, puModel, agentModel, scenarioRuns, scenarios };
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
  });

  it('アンケート検証失敗は1回再試行し、再失敗で status:error（会話は保存）', async () => {
    const badSurvey: ModelCompletion = { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 99, impressions: 'x' }) }, finishReason: 'stop' };
    const h = harness({
      scenario: makeScenario({ maxUserTurns: 1 }),
      pu: [puTurn('質問1', false, false), badSurvey, badSurvey],
      agent: [agentSay('回答1')],
    });
    const run = await h.useCase.execute(input);
    expect(run.status).toBe('error');
    expect(run.transcript).toHaveLength(2);
    expect(run.survey).toEqual([]);
    expect(h.puModel.requests).toHaveLength(3);
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

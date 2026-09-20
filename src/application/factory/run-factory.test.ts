import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { InMemoryPersonaRepository } from '../../adapters/storage/in-memory-persona-repository';
import { InMemoryRunRepository } from '../../adapters/storage/in-memory-run-repository';
import { InMemoryScenarioRepository } from '../../adapters/storage/in-memory-scenario-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createAgent, type AgentRuntimeHarness } from '../../domain/agent/agent';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { FactoryAbortedError, FactoryValidationError } from '../../domain/factory/errors';
import { appendFactoryEvent, cancelFactoryRun, type FactoryIteration, type FactoryRun, type IterationMetrics } from '../../domain/factory/factory-run';
import type { RunRecord } from '../../domain/run/run';
import { createSkill } from '../../domain/skill/skill';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { createScenarioRun, type ScenarioRun } from '../../domain/validation/scenario-run';
import type { FactoryWorkerPort } from './factory-worker';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { EtlEngine } from '../etl/engine';
import { ModelProviderError, type ModelCompletion, type ModelCompletionRequest } from '../model/model-provider';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { SavePersonaUseCase } from '../validation/save-persona';
import { RegisterPseudoUserAgentUseCase } from '../validation/register-pseudo-user-agent';
import { SaveScenarioUseCase } from '../validation/save-scenario';
import { SHUTDOWN_ABORT_MESSAGE, USER_CANCEL_MESSAGE } from './abort';
import { ApplyImprovementsUseCase, type ApplyImprovementsInput } from './apply-improvements';
import { CancelFactoryRunUseCase } from './cancel-factory-run';
import { CreateFactoryRunUseCase } from './create-factory-run';
import { GenerateAgentAssetsUseCase } from './generate-agent-assets';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';
import { AnalystRole } from './roles/analyst-role';
import { AssemblerRole } from './roles/assembler-role';
import { PlannerRole } from './roles/planner-role';
import { SkillWriterRole } from './roles/skill-writer-role';
import { ToolSmithRole } from './roles/tool-smith-role';
import { ResumeFactoryRunUseCase } from './resume-factory-run';
import { assessReportQuality, candidateSourceSets, describeRegressions, LOOP_STOPPED_NO_PROPOSALS, RunFactoryUseCase, selectBestIteration } from './run-factory';
import { MAX_TOOL_CALLS } from '../agent/run-agent-preview';
import type { ScenarioRunnerInput, ScenarioRunnerPort } from './scenario-runner-port';

const scope = { tenantId: 't', workspaceId: 'w' };

/** 実adapterの中断挙動を模す: signal が abort されたら reject する（abort 済みなら即 reject）。signal 無しは配線漏れなので即失敗させる。 */
function rejectOnAbort(signal: AbortSignal | undefined, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal === undefined) { reject(new Error(`${label}: no AbortSignal was passed`)); return; }
    const fail = (): void => { reject(new ModelProviderError(`${label} aborted`)); };
    if (signal.aborted) { fail(); return; }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/** テスト用のcanned `ScenarioRunnerPort`: 疑似ユーザー会話全体をscriptedで再現せず、固定のScenarioRunを返す。 */
class FakeScenarioRunner implements ScenarioRunnerPort {
  readonly calls: ScenarioRunnerInput[] = [];
  /** 呼び出しごとに受け取った signal（RunFactoryUseCase が検証実行へ中断を伝えていることの確認用）。 */
  readonly signals: (AbortSignal | undefined)[] = [];
  private hang: (() => void) | undefined;
  constructor(private readonly makeRun: (input: ScenarioRunnerInput) => ScenarioRun) {}
  /** 次の1回の実行を「signal が abort されるまで返らない」にする（実 `RunScenarioUseCase` の中断挙動を模す）。 */
  hangOnce(onHang?: () => void): void { this.hang = onHang ?? ((): void => {}); }
  async execute(input: ScenarioRunnerInput, signal?: AbortSignal): Promise<ScenarioRun> {
    this.calls.push(input);
    this.signals.push(signal);
    const onHang = this.hang;
    if (onHang !== undefined) {
      this.hang = undefined;
      onHang();
      await rejectOnAbort(signal, 'scenario run');
    }
    return this.makeRun(input);
  }
}

/** 決定的にID列を発行する（Analystの提案でGenerateAgentAssetsUseCaseが払い出したid「asset-N」を直接参照できるようにする）。 */
function makeSequentialId(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

function cannedScenarioRun(
  scope: TenantScope,
  scenarioId: string,
  version: SemVer,
  outcome: { readonly goalAchieved: boolean; readonly satisfaction: number } = { goalAchieved: true, satisfaction: 5 },
): ScenarioRun {
  return createScenarioRun({
    id: `scenario-run-${scenarioId}-${version.toString()}-${outcome.goalAchieved ? 'ok' : 'ng'}`,
    scope,
    scenario: { id: scenarioId, version },
    status: 'completed',
    goalAchieved: outcome.goalAchieved,
    transcript: [{ speaker: 'user', message: 'find total sales' }, { speaker: 'agent', message: 'total is 300', runId: 'run-x' }],
    survey: [{ questionId: 'q1', value: outcome.goalAchieved }, { questionId: 'q2', value: outcome.satisfaction }, { questionId: 'impressions', value: outcome.goalAchieved ? 'great' : 'could not find the answer' }],
    impressions: outcome.goalAchieved ? 'great' : 'could not find the answer',
    metrics: {
      userTurns: 1, agentRuns: 1, totalToolCalls: 1,
      expectedToolHit: { expected: ['lookup_sales'], called: outcome.goalAchieved ? ['lookup_sales'] : [], hitRate: outcome.goalAchieved ? 1 : 0 },
      durationMs: 250, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:00:01.000Z',
  });
}

function validPlanJson(agentDisplayName = 'Sales Assistant'): string {
  return JSON.stringify({
    agentBrief: { displayName: agentDisplayName, role: 'Answers sales questions using the sales data source.' },
    tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
  });
}

/** 既存の組み込みツール（現在日時）を再利用し、新規Toolは1件だけ作る計画。 */
const BUILTIN_DATETIME_ID = 'builtin-current-datetime';

function reusePlanJson(): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
    tools: [
      { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
      { key: 'today', displayName: 'Current Datetime', purpose: 'Resolve "this month".', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId: BUILTIN_DATETIME_ID, rationale: 'builtin tool already returns now/date/yearMonth' } },
    ],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup', 'today'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales this month', personaKey: 'accountant', expectedToolKeys: ['lookup', 'today'], maxUserTurns: 3 }],
  });
}

/** 組み込みツール（`src/builtin-tools.ts` と同じ契約）を、Factory実行前から存在する既存Toolとして置く。 */
async function seedBuiltinDatetimeTool(toolRepo: InMemoryToolRepository): Promise<void> {
  await toolRepo.save(createTool({
    metadata: {
      internalId: BUILTIN_DATETIME_ID, workingName: 'Current datetime draft', displayName: 'Current Datetime', publishName: 'current_datetime',
      version: SemVer.of(1, 0, 0), owner: 'builtin', state: 'draft', tenant: scope,
    },
    sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'now', type: 'current-datetime', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 4096, overflow: 'error' } },
      ],
      edges: [{ from: 'now', to: 'agent-result' }],
    },
    agentTool: { name: 'current_datetime', description: 'Returns the current date and time (now, date, yearMonth, time, weekday).' },
  }));
}

function validToolProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

function validSkillProposalJson(): string {
  return JSON.stringify({
    responsibility: 'Summarize sales trends.',
    activationCondition: 'user asks for a summary',
    inputDescription: 'A question about sales.',
    outputDescription: 'A concise summary of sales rows.',
    instructions: 'Use the lookup_sales tool to fetch sales rows, then summarize the trend.',
  });
}

function validAssemblerProposalJson(): string {
  return JSON.stringify({
    role: '# Role\nYou are the Sales Assistant, helping accountants understand sales data.',
    rules: '# Extra rules\nAlways cite the rows returned by the lookup tool.',
  });
}

/** 1件のskill-instructions-revision提案。skillIdはGenerateAgentAssetsUseCase発行順で2番目（"asset-2"）に固定する。 */
function validAnalystProposalJson(): string {
  return JSON.stringify({
    findings: [{ id: 'f1', severity: 'warning', area: 'skill', detail: 'instructions did not double-check totals' }],
    proposals: [{ kind: 'skill-instructions-revision', skillId: 'asset-2', instructions: 'Use lookup_sales, then double-check totals before summarizing.', activationCondition: 'user asks for a summary', rationale: 'improve accuracy' }],
    summary: 'Iteration 1 missed the goal; revised skill instructions to double-check totals.',
  });
}

const noopWorker: FactoryWorkerPort = { enqueue: () => {}, cancel: () => {}, drainInFlight: async () => true, shutdown: () => {} };

async function setup(options?: {
  readonly makeScenarioRun?: (input: ScenarioRunnerInput) => ScenarioRun;
  /** 台本モデルの差し替え（中断挙動を持つ `HangingModelProvider` など）。 */
  readonly model?: ScriptedModelProvider;
  /** Run リポジトリの差し替え（保存の直前に処理を差し込む `InterposingFactoryRunRepository` など）。 */
  readonly repo?: InMemoryFactoryRunRepository;
  readonly scenarioRunner?: FakeScenarioRunner;
  /** Agent Run のトレース置き場（Analystへ渡すツール呼び出しの材料）。 */
  readonly runRepo?: InMemoryRunRepository;
}): Promise<{
  repo: FactoryRunRepository; model: ScriptedModelProvider; runFactory: RunFactoryUseCase;
  createFactoryRun: CreateFactoryRunUseCase; resumeFactoryRun: ResumeFactoryRunUseCase;
  personaRepo: InMemoryPersonaRepository; scenarioRepo: InMemoryScenarioRepository; scenarioRunner: FakeScenarioRunner;
  agentRepo: InMemoryAgentRepository; skillRepo: InMemorySkillRepository; toolRepo: InMemoryToolRepository;
  applyCalls: ApplyImprovementsInput[]; runRepo: InMemoryRunRepository;
}> {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, 'id,amount\n1,100\n2,200');
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  const model = options?.model ?? new ScriptedModelProvider();
  const planner = new PlannerRole(model);
  const toolSmith = new ToolSmithRole(model);
  const skillWriter = new SkillWriterRole(model);
  const assembler = new AssemblerRole(model);
  const analyst = new AnalystRole(model);

  const toolRepo = new InMemoryToolRepository();
  const skillRepo = new InMemorySkillRepository();
  const agentRepo = new InMemoryAgentRepository();
  const personaRepo = new InMemoryPersonaRepository();
  const scenarioRepo = new InMemoryScenarioRepository();
  const saveTool = new SaveToolUseCase(toolRepo, engine, resolver);
  const saveSkill = new SaveSkillUseCase(skillRepo, toolRepo);
  const saveAgent = new SaveAgentUseCase(agentRepo, toolRepo, skillRepo);
  const generateAgentPrompt = new GenerateAgentPromptUseCase(toolRepo, skillRepo, agentRepo);
  // 決定的id発行: 1件のtool/skill/plan構成では tool="asset-1" / skill="asset-2" / agent="asset-3" に固定される。
  // 第10・11引数（段階的経路 / テンプレート経路）は未注入 = 従来どおり一括 ToolSmith だけを使う。
  const generateAgentAssets = new GenerateAgentAssetsUseCase(toolSmith, skillWriter, assembler, saveTool, saveSkill, saveAgent, generateAgentPrompt, engine, resolver, undefined, undefined, makeSequentialId('asset'));
  const savePersona = new SavePersonaUseCase(personaRepo);
  const registerPseudoUser = new RegisterPseudoUserAgentUseCase(personaRepo, saveAgent);
  const saveScenario = new SaveScenarioUseCase(scenarioRepo, agentRepo, personaRepo);
  const scenarioRunner = options?.scenarioRunner ?? new FakeScenarioRunner(options?.makeScenarioRun ?? ((input) => cannedScenarioRun(scope, input.scenarioId, input.version ?? SemVer.of(1, 0, 0))));
  const realApplyImprovements = new ApplyImprovementsUseCase(agentRepo, skillRepo, toolRepo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine);
  // `RunFactoryUseCase` が渡す引数（maxRepairAttempts 等）を検証できるよう、実物を薄く包んで記録する。
  const applyCalls: ApplyImprovementsInput[] = [];
  const applyImprovements = {
    execute: async (input: ApplyImprovementsInput) => { applyCalls.push(input); return realApplyImprovements.execute(input); },
  } as unknown as ApplyImprovementsUseCase;

  const repo = options?.repo ?? new InMemoryFactoryRunRepository();
  const runRepo = options?.runRepo ?? new InMemoryRunRepository();
  const runFactory = new RunFactoryUseCase(repo, profiler, planner, generateAgentAssets, scenarioRunner, savePersona, registerPseudoUser, saveScenario, analyst, applyImprovements, agentRepo, skillRepo, toolRepo, runRepo);
  const createFactoryRun = new CreateFactoryRunUseCase(repo, noopWorker);
  const resumeFactoryRun = new ResumeFactoryRunUseCase(repo, runFactory, noopWorker);
  return { repo, model, runFactory, createFactoryRun, resumeFactoryRun, personaRepo, scenarioRepo, scenarioRunner, agentRepo, skillRepo, toolRepo, applyCalls, runRepo };
}

// ─── 既存Agent強化モードのフィクスチャ ───────────────────────────────────────────────

const BASE_AGENT_ID = 'base-agent';
const BASE_TOOL_ID = 'base-tool';
const BASE_SKILL_ID = 'base-skill';
const BASE_AGENT_HARNESS: AgentRuntimeHarness = {
  fileMemory: true, todoProvider: false, compaction: true, webSearch: false, toolApproval: false, functionInvocation: true,
};

/**
 * 利用者がBuilderで作った既存Agent（Factory生成物ではない）を模す。systemPromptは決定的合成の書式に
 * 利用者が独自セクションを足したもので、強化モードのsystemPrompt再合成がそれを保つことを検証できる。
 */
const BASE_AGENT_PROMPT = [
  '# 役割\nあなたは「Base Assistant」です。経理担当者の売上の質問に、社内の言葉づかいで答えてください。',
  '# Skillガイド\n- base_skill@1.0.0: 過去の売上を説明する\n  発火条件: 売上の質問\n  instructions: base_tool を使って答える。',
  '# Tool使用ガイド\n- base_tool@1.0.0（過去の売上を引く）: input [なし] / output [なし] / side-effect read-only',
  '# 独自メモ\n利用者が手で書いたセクション。Factoryの強化で消えてはならない。',
  '# 実行規則\n- 数字は必ず出典を添える。',
].join('\n\n');

/**
 * 既存Agent一式（Tool + Skill + Agent）を、Factory実行前から存在する資産としてリポジトリへ置く。
 * `overrides.version` を変えて再度呼ぶと、同じTool/Skillを指すAgentの別版だけを追加できる。
 */
async function seedBaseAgent(
  toolRepo: InMemoryToolRepository, skillRepo: InMemorySkillRepository, agentRepo: InMemoryAgentRepository,
  overrides?: { readonly version?: SemVer; readonly systemPrompt?: string },
): Promise<void> {
  if (await toolRepo.findVersion(scope, BASE_TOOL_ID, SemVer.of(1, 0, 0)) === null) {
    await seedBaseCapabilities(toolRepo, skillRepo);
  }
  await agentRepo.save(createAgent({
    metadata: {
      internalId: BASE_AGENT_ID, workingName: 'Base agent draft', displayName: 'Base Assistant', publishName: 'base_assistant',
      version: overrides?.version ?? SemVer.of(1, 0, 0), owner: 'alice', state: 'draft', tenant: scope,
    },
    kind: 'normal',
    systemPrompt: overrides?.systemPrompt ?? BASE_AGENT_PROMPT,
    skills: [{ internalId: BASE_SKILL_ID, version: SemVer.of(1, 0, 0) }],
    tools: [{ internalId: BASE_TOOL_ID, version: SemVer.of(1, 0, 0) }],
    agents: [],
    mcpServers: ['sales-mcp'],
    harness: BASE_AGENT_HARNESS,
  }));
}

async function seedBaseCapabilities(toolRepo: InMemoryToolRepository, skillRepo: InMemorySkillRepository): Promise<void> {
  await toolRepo.save(createTool({
    metadata: {
      internalId: BASE_TOOL_ID, workingName: 'Base tool draft', displayName: 'Base Sales Lookup', publishName: 'base_sales_lookup',
      version: SemVer.of(1, 0, 0), owner: 'alice', state: 'draft', tenant: scope,
    },
    sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'now', type: 'current-datetime', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 4096, overflow: 'error' } },
      ],
      edges: [{ from: 'now', to: 'agent-result' }],
    },
    agentTool: { name: 'base_tool', description: '過去の売上を引く' },
  }));
  await skillRepo.save(createSkill({
    metadata: {
      internalId: BASE_SKILL_ID, workingName: 'Base skill draft', displayName: 'Base Sales Skill', publishName: 'base_skill',
      version: SemVer.of(1, 0, 0), owner: 'alice', state: 'draft', tenant: scope,
    },
    responsibility: '過去の売上を説明する',
    activationCondition: '売上の質問',
    inputDescription: '売上に関する質問',
    outputDescription: '売上の説明',
    instructions: 'base_tool を使って答える。',
    tools: [{ internalId: BASE_TOOL_ID, version: SemVer.of(1, 0, 0) }],
  }));
}

/** 強化モードで「追加は0件、検証と改善だけ」を計画する（データソースを1つも使わない計画）。 */
function noAdditionPlanJson(): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Base Assistant', role: 'Existing agent that answers sales questions.' },
    tools: [],
    skills: [],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: [], maxUserTurns: 3 }],
  });
}

/** 既存Agentのsystem promptを丸ごと置き換える改訂提案（強化モードの「プロンプト改善だけ」ループ用）。 */
function baseAgentPromptRevisionJson(): string {
  return JSON.stringify({
    findings: [{ id: 'f1', severity: 'warning', area: 'prompt', detail: 'the agent did not state which rows it used' }],
    proposals: [{
      kind: 'system-prompt-revision',
      agentId: BASE_AGENT_ID,
      sections: { role: '# 役割\nあなたは「Base Assistant」です。根拠の行を必ず示してください。', rules: '# 実行規則\n- 使用した行を必ず引用する。' },
      rationale: 'cite the rows that back the answer',
    }],
    summary: 'Revised the existing system prompt to cite source rows.',
  });
}

/** Planner → ToolSmith → SkillWriter → Assembler の順にScriptedModelProviderへ積む（M2生成まで通す共通台本）。 */
function enqueueGenerationScript(model: ScriptedModelProvider, agentDisplayName?: string): void {
  model.enqueue(
    { message: { role: 'assistant', content: validPlanJson(agentDisplayName) }, finishReason: 'stop' },
    { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
    { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
    { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
  );
}

describe('RunFactoryUseCase', () => {
  it('queued → running → waiting-approval（requirePlanApproval:true） → running（approve後、M2でTool/Skill/Agent、M3でPersona/pseudo-user/Scenario+1イテレーションを生成し、目標達成済みでsucceeded）', async () => {
    const { repo, model, runFactory, createFactoryRun, resumeFactoryRun, personaRepo, scenarioRepo, scenarioRunner } = await setup();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'], options: { requirePlanApproval: true } });
    expect(created.status).toBe('queued');

    await runFactory.execute(scope, created.id);
    const waiting = await repo.find(scope, created.id);
    expect(waiting).toMatchObject({ status: 'waiting-approval', stage: 'planning' });
    expect(waiting?.plan?.agentBrief.displayName).toBe('Sales Assistant');
    expect(waiting?.checkpoint?.kind).toBe('plan-approval');
    expect(waiting?.events.map((event) => event.kind)).toEqual([
      'stage_started', 'stage_completed', 'stage_started', 'plan_proposed', 'stage_completed', 'approval_requested',
    ]);
    expect(waiting?.budget.consumed.roleCalls).toBe(1);

    const approved = await resumeFactoryRun.execute({ scope, runId: created.id, decision: 'approve' });
    expect(approved.status).toBe('running');
    expect(approved.checkpoint).toBeUndefined();

    // M2: Stage 2-4（Tool/Skill/Agent生成）が動く。Stage 5-6はLLMを使わず決定的に進み、疑似ユーザー検証は
    // FakeScenarioRunnerの既定（goalAchieved:true, 満足度5）で既定目標を満たすため、Analystは呼ばれずsucceededで終わる。
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    await runFactory.execute(scope, created.id);
    const succeeded = await repo.find(scope, created.id);
    expect(succeeded?.status).toBe('succeeded');
    expect(succeeded?.failure).toBeUndefined();
    expect(succeeded?.report).toBeDefined();
    expect(succeeded?.report?.bestIteration).toBe(1);
    expect(succeeded?.events.at(-1)).toMatchObject({ kind: 'run_completed' });

    // Tool/Skill/Agentのdraftが生成資産として記録されている（M2）。
    expect(succeeded?.artifacts.tools).toHaveLength(1);
    expect(succeeded?.artifacts.skills).toHaveLength(1);
    expect(succeeded?.artifacts.agentVersions).toHaveLength(1);

    // Stage 5: Persona/pseudo-user Agent/Scenarioのdraftが決定的に保存されている。
    expect(succeeded?.artifacts.personas).toHaveLength(1);
    expect(succeeded?.artifacts.pseudoUsers).toHaveLength(1);
    expect(succeeded?.artifacts.scenarios).toHaveLength(1);
    expect(await personaRepo.list(scope)).toHaveLength(1);
    expect(await scenarioRepo.list(scope)).toHaveLength(1);

    // Stage 6: 凍結したScenario集合を1回ずつ実行し、1イテレーション分のIterationMetricsを記録する。
    expect(scenarioRunner.calls).toHaveLength(1);
    expect(succeeded?.iterations).toHaveLength(1);
    const iteration = succeeded?.iterations[0];
    expect(iteration?.index).toBe(1);
    expect(iteration?.scenarioRunIds).toHaveLength(1);
    expect(iteration?.metrics).toMatchObject({ scenarioCount: 1, goalAchievedRate: 1, avgSatisfaction: 5, toolHitRate: 1, errorRate: 0, avgUserTurns: 1 });
    expect(succeeded?.budget.consumed.scenarioRuns).toBe(1);
    expect(succeeded?.events.map((event) => event.kind)).toContain('scenario_run_completed');
    expect(succeeded?.events.map((event) => event.kind)).toContain('iteration_completed');
  });

  it('requirePlanApproval:false（既定）はStage1完了後そのまま生成継続へ進み、M2-3で資産生成・1イテレーション検証し、目標達成済みでsucceededになる', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner } = await setup();
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'] });

    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.plan).toBeDefined();
    expect(finished?.checkpoint).toBeUndefined();
    expect(finished?.failure).toBeUndefined();
    expect(finished?.artifacts.tools).toHaveLength(1);
    expect(finished?.artifacts.skills).toHaveLength(1);
    expect(finished?.artifacts.agentVersions).toHaveLength(1);
    expect(finished?.artifacts.personas).toHaveLength(1);
    expect(finished?.artifacts.pseudoUsers).toHaveLength(1);
    expect(finished?.artifacts.scenarios).toHaveLength(1);
    expect(finished?.budget.consumed.roleCalls).toBe(4); // planner(1) + tool-smith(1) + skill-writer(1) + assembler(1)（目標達成済みのためAnalystは呼ばれない）
    expect(finished?.budget.consumed.scenarioRuns).toBe(1);
    expect(finished?.iterations).toHaveLength(1);
    expect(scenarioRunner.calls).toHaveLength(1);
    expect(finished?.stage).toBe('reporting');
    expect(finished?.report).toMatchObject({ bestIteration: 1, candidate: { agentId: 'asset-3', version: '1.0.0' } });
  });

  it('既存ツールカタログを計画へ渡し、reuse指定のToolは新規生成せず既存Toolを参照する', async () => {
    const { repo, model, runFactory, createFactoryRun, toolRepo, scenarioRepo } = await setup();
    await seedBuiltinDatetimeTool(toolRepo);
    model.enqueue(
      { message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' }, // lookup（新規）だけToolSmithを呼ぶ
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions about this month', language: 'ja' }, dataSourceIds: ['ds-1'] });
    await runFactory.execute(scope, created.id);

    // Plannerには保存済みToolのカタログが渡っている（untrusted data側）。
    const plannerUserMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(plannerUserMessage).toContain(BUILTIN_DATETIME_ID);
    expect(plannerUserMessage).toContain('current_datetime');

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.budget.consumed.roleCalls).toBe(4); // planner + tool-smith(1件のみ) + skill-writer + assembler
    expect(finished?.events.map((event) => event.kind)).toContain('tool_reused');
    expect(finished?.artifacts.tools).toHaveLength(2);
    expect(finished?.artifacts.tools).toContainEqual({ internalId: BUILTIN_DATETIME_ID, version: '1.0.0' });
    // 既存Toolには新しいバージョンを作らない（再利用であって改訂ではない）。
    expect(await toolRepo.listVersions(scope, BUILTIN_DATETIME_ID)).toHaveLength(1);
    // ScenarioのexpectedToolsは再利用Toolの公開名も解決できる。
    const scenarios = await scenarioRepo.list(scope);
    const scenarioRef = scenarios[0];
    if (scenarioRef === undefined) throw new Error('expected a scenario');
    const scenario = await scenarioRepo.findVersion(scope, scenarioRef.internalId, scenarioRef.latestVersion);
    expect(scenario?.expectedTools).toContain('current_datetime');
  });

  it('reject応答はcancelledとして確定する（再計画はしない）', async () => {
    const { repo, model, runFactory, createFactoryRun, resumeFactoryRun } = await setup();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'], options: { requirePlanApproval: true } });
    await runFactory.execute(scope, created.id);

    const rejected = await resumeFactoryRun.execute({ scope, runId: created.id, decision: 'reject', feedback: 'not aligned with goal' });
    expect(rejected.status).toBe('cancelled');
    expect(rejected.events.at(-1)).toMatchObject({ kind: 'run_cancelled', message: 'not aligned with goal' });
    expect(await repo.find(scope, created.id)).toMatchObject({ status: 'cancelled' });
  });

  it('revise応答は再プロファイル・再計画し、新しいcheckpointでwaiting-approvalへ戻る', async () => {
    const { repo, model, runFactory, createFactoryRun, resumeFactoryRun } = await setup();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson('Sales Assistant v1') }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'], options: { requirePlanApproval: true } });
    await runFactory.execute(scope, created.id);
    const firstCheckpoint = (await repo.find(scope, created.id))?.checkpoint;

    model.enqueue({ message: { role: 'assistant', content: validPlanJson('Sales Assistant v2') }, finishReason: 'stop' });
    const revised = await resumeFactoryRun.execute({ scope, runId: created.id, decision: 'revise', feedback: 'add a persona who is an expert' });

    expect(revised.status).toBe('waiting-approval');
    expect(revised.plan?.agentBrief.displayName).toBe('Sales Assistant v2');
    expect(revised.checkpoint?.prompt).not.toBe(firstCheckpoint?.prompt);
    expect(revised.budget.consumed.roleCalls).toBe(2);
    expect(revised.events.filter((event) => event.kind === 'plan_proposed')).toHaveLength(2);
    expect(revised.events.filter((event) => event.kind === 'approval_requested')).toHaveLength(2);
    expect(await repo.find(scope, created.id)).toMatchObject({ status: 'waiting-approval' });
  });

  it('存在しないrunIdは無視する（noop）', async () => {
    const { runFactory } = await setup();
    await expect(runFactory.execute(scope, 'missing')).resolves.toBeUndefined();
  });

  it('改善ループ: イテレーション1が未達 → Analyst提案を適用 → 新Agent版を再検証 → 目標達成でsucceeded', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner, agentRepo, skillRepo } = await setup({
      makeScenarioRun: (input) => {
        const version = input.target?.version ?? input.version ?? SemVer.of(1, 0, 0);
        const improved = version.toString() !== '1.0.0';
        return cannedScenarioRun(scope, input.scenarioId, version, improved ? { goalAchieved: true, satisfaction: 5 } : { goalAchieved: false, satisfaction: 2 });
      },
    });
    enqueueGenerationScript(model);
    model.enqueue({ message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'] });
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.failure).toBeUndefined();
    expect(finished?.iterations).toHaveLength(2);
    expect(finished?.iterations[0]?.metrics.goalAchievedRate).toBe(0);
    expect(finished?.iterations[0]?.metrics.avgSatisfaction).toBe(2);
    expect(finished?.iterations[1]?.metrics.goalAchievedRate).toBe(1);
    expect(finished?.iterations[1]?.metrics.avgSatisfaction).toBe(5);

    // イテレーション1のanalysisにfindings/appliedが記録されている。
    expect(finished?.iterations[0]?.analysis?.findings).toHaveLength(1);
    expect(finished?.iterations[0]?.analysis?.applied).toHaveLength(1);
    expect(finished?.iterations[0]?.analysis?.applied[0]?.proposal.kind).toBe('skill-instructions-revision');
    expect(finished?.iterations[0]?.analysis?.rejected).toHaveLength(0);

    // 再検証は新Agent版を明示的targetで受けている（イテレーション2はイテレーション1と異なる版）。
    expect(scenarioRunner.calls).toHaveLength(2);
    expect(scenarioRunner.calls[0]?.target?.agentId).toBe('asset-3');
    expect(scenarioRunner.calls[0]?.target?.version.toString()).toBe('1.0.0');
    expect(scenarioRunner.calls[1]?.target?.agentId).toBe('asset-3');
    expect(scenarioRunner.calls[1]?.target?.version.toString()).toBe('1.0.1');
    expect(scenarioRunner.calls[1]?.target?.version.toString()).not.toBe(scenarioRunner.calls[0]?.target?.version.toString());

    // レポート: 最良イテレーションはイテレーション2、候補はそのAgent版。
    expect(finished?.report?.bestIteration).toBe(2);
    expect(finished?.report?.candidate).toEqual({ agentId: 'asset-3', version: '1.0.1' });
    expect(finished?.report?.metricsByIteration).toHaveLength(2);
    expect(finished?.report?.summary).toContain('double-check totals');

    // Skill/Agentの新版が実際に保存されている（draft、既存版は不変）。
    const newSkill = await skillRepo.findVersion(scope, 'asset-2', SemVer.of(1, 0, 1));
    expect(newSkill?.instructions).toContain('double-check totals');
    const oldSkill = await skillRepo.findVersion(scope, 'asset-2', SemVer.of(1, 0, 0));
    expect(oldSkill).not.toBeNull(); // 既存版は不変。
    const newAgent = await agentRepo.findVersion(scope, 'asset-3', SemVer.of(1, 0, 1));
    expect(newAgent?.skills[0]?.version.toString()).toBe('1.0.1');

    const eventKinds = finished?.events.map((event) => event.kind) ?? [];
    expect(eventKinds).toContain('analysis_completed');
    expect(eventKinds).toContain('proposal_applied');
    expect(eventKinds).toContain('run_completed');
    expect(eventKinds).not.toContain('budget_exceeded');
  });

  it('改善停滞: 2イテレーション目も改善しなければ、succeededのまま打ち切りレポートを作る', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner } = await setup({
      makeScenarioRun: (input) => cannedScenarioRun(scope, input.scenarioId, input.target?.version ?? input.version ?? SemVer.of(1, 0, 0), { goalAchieved: false, satisfaction: 2 }),
    });
    enqueueGenerationScript(model);
    model.enqueue({ message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'] });
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.iterations).toHaveLength(2); // 改善を1回試みてから停滞で打ち切る。
    expect(finished?.iterations[0]?.metrics.goalAchievedRate).toBe(0);
    expect(finished?.iterations[1]?.metrics.goalAchievedRate).toBe(0);
    expect(scenarioRunner.calls).toHaveLength(2);

    // 同点の場合は先行イテレーション（1）が最良として選ばれる。
    expect(finished?.report?.bestIteration).toBe(1);
    expect(finished?.report?.candidate).toEqual({ agentId: 'asset-3', version: '1.0.0' });
    expect(finished?.report?.metricsByIteration).toHaveLength(2);
  });

  it('maxIterations=1: ループ本体（Analyst/Improve）は一切実行されず、単一イテレーションのレポートでsucceededになる', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner } = await setup({
      makeScenarioRun: (input) => cannedScenarioRun(scope, input.scenarioId, input.target?.version ?? input.version ?? SemVer.of(1, 0, 0), { goalAchieved: false, satisfaction: 2 }),
    });
    enqueueGenerationScript(model); // Analyst用の台本は積まない: maxIterations到達で即打ち切るため呼ばれないはず。

    const created = await createFactoryRun.execute({ scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'], options: { maxIterations: 1 } });
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.iterations).toHaveLength(1);
    expect(scenarioRunner.calls).toHaveLength(1);
    expect(finished?.budget.consumed.roleCalls).toBe(4); // Analystは呼ばれない: planner+tool-smith+skill-writer+assemblerのみ。
    expect(model.requests).toHaveLength(4);

    expect(finished?.report).toMatchObject({ bestIteration: 1, candidate: { agentId: 'asset-3', version: '1.0.0' }, openFindings: [] });
    expect(finished?.report?.metricsByIteration).toHaveLength(1);
    expect(finished?.events.map((event) => event.kind)).toContain('budget_exceeded');
    expect(finished?.iterations[0]?.analysis).toBeUndefined();
  });

  it('Analystへ Stage 0 のデータソース要約（availableDataSources）と Runの maxRepairAttempts が渡る', async () => {
    const { model, runFactory, createFactoryRun, applyCalls } = await setup({
      makeScenarioRun: (input) => {
        const version = input.target?.version ?? input.version ?? SemVer.of(1, 0, 0);
        return cannedScenarioRun(scope, input.scenarioId, version, version.toString() === '1.0.0' ? { goalAchieved: false, satisfaction: 2 } : { goalAchieved: true, satisfaction: 5 });
      },
    });
    enqueueGenerationScript(model);
    model.enqueue({ message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({
      scope, goal: { goal: 'Answer sales questions', language: 'ja' }, dataSourceIds: ['ds-1'],
      options: { budget: { maxDurationMs: 60_000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 3, maxProposalsPerIteration: 4 } },
    });
    await runFactory.execute(scope, created.id);

    // Analyst呼び出し（5件目）のuntrusted payloadに、Stage 0でプロファイルしたデータソースの要約が載る。
    const analystUserMessage = String(model.requests[4]?.messages.find((message) => message.role === 'user')?.content);
    expect(analystUserMessage).toContain('availableDataSources');
    expect(analystUserMessage).toContain('ds-1');
    expect(analystUserMessage).toContain('amount:number');

    // 改訂適用にはRunの予算（maxRepairAttempts）がそのまま伝播する（add-toolの再提案回数）。
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.maxRepairAttempts).toBe(3);
    expect(applyCalls[0]?.maxProposals).toBe(4);
  });
});

describe('RunFactoryUseCase（既存Agent強化モード: input.baseAgent）', () => {
  it('baseAgent指定 + データソース0件: 新Agentを作らず、既存Agentのプロンプト改善ループが回る', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner, agentRepo, toolRepo, skillRepo } = await setup({
      makeScenarioRun: (input) => {
        const version = input.target?.version ?? input.version ?? SemVer.of(1, 0, 0);
        return cannedScenarioRun(scope, input.scenarioId, version, version.toString() === '1.0.0' ? { goalAchieved: false, satisfaction: 2 } : { goalAchieved: true, satisfaction: 5 });
      },
    });
    await seedBaseAgent(toolRepo, skillRepo, agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: noAdditionPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: baseAgentPromptRevisionJson() }, finishReason: 'stop' },
    );

    const created = await createFactoryRun.execute({
      scope, goal: { goal: '売上の質問に、根拠を示して答えられるようにする', language: 'ja' },
      dataSourceIds: [], baseAgent: { internalId: BASE_AGENT_ID },
    });
    expect(created.input.baseAgent).toEqual({ internalId: BASE_AGENT_ID });

    await runFactory.execute(scope, created.id);
    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.failure).toBeUndefined();

    // Stage 2-4: 追加が0件なのでTool/Skillは生成されず、Agentの新版も作られない（既存版が起点）。
    expect(finished?.artifacts.tools).toEqual([]);
    expect(finished?.artifacts.skills).toEqual([]);
    expect(finished?.artifacts.agentVersions[0]).toEqual({ internalId: BASE_AGENT_ID, version: '1.0.0' });
    // Assemblerは呼ばれない（planner + analyst のみ）。
    expect(finished?.budget.consumed.roleCalls).toBe(2);

    // 検証 → 分析 → 改善ループは通常どおり回り、既存Agentのpatch新版が検証される。
    expect(finished?.iterations).toHaveLength(2);
    expect(scenarioRunner.calls.map((call) => `${String(call.target?.agentId)}@${String(call.target?.version.toString())}`))
      .toEqual([`${BASE_AGENT_ID}@1.0.0`, `${BASE_AGENT_ID}@1.0.1`]);
    expect(finished?.artifacts.agentVersions).toEqual([
      { internalId: BASE_AGENT_ID, version: '1.0.0' },
      { internalId: BASE_AGENT_ID, version: '1.0.1' },
    ]);

    // 改訂後も既存Agentのメタデータ・設定は保たれる（ownerをFACTORY_OWNERで潰さない）。
    const revised = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    expect(revised?.metadata.owner).toBe('alice');
    expect(revised?.metadata.publishName).toBe('base_assistant');
    expect(revised?.harness).toEqual(BASE_AGENT_HARNESS);
    expect(revised?.mcpServers).toEqual(['sales-mcp']);
    expect(revised?.systemPrompt).toContain('根拠の行を必ず示してください');

    // 強化モードであることがイベント・レポートから分かる（新しいkindは増やさない）。
    expect(finished?.events[0]).toMatchObject({ kind: 'stage_started', stage: 'profiling', message: 'enhancing agent Base Assistant@1.0.0' });
    expect(finished?.report?.summary).toContain('Enhanced existing agent Base Assistant@1.0.0.');
    expect(finished?.report?.candidate).toEqual({ agentId: BASE_AGENT_ID, version: '1.0.1' });

    // Plannerには既存Agentの現状（ギャップ計画の材料）が untrusted payload として渡る。
    const plannerUserMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(plannerUserMessage).toContain('currentAgent');
    expect(plannerUserMessage).toContain('base_tool');
    expect(plannerUserMessage).toContain('Base Sales Skill');
    // データソース0件なので、Analystへは availableDataSources を渡さない（add-toolを提案させない）。
    const analystUserMessage = String(model.requests[1]?.messages.find((message) => message.role === 'user')?.content);
    expect(analystUserMessage).not.toContain('availableDataSources');
  });

  it('追加されたTool/Skillは既存Agentの新版へ統合され、既存の参照・設定・手書きのsystem promptセクションが残る', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner, agentRepo, toolRepo, skillRepo } = await setup();
    await seedBaseAgent(toolRepo, skillRepo, agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: validPlanJson('Base Assistant') }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
    );

    const created = await createFactoryRun.execute({
      scope, goal: { goal: '今月の売上も引けるようにする', language: 'ja' },
      dataSourceIds: ['ds-1'], baseAgent: { internalId: BASE_AGENT_ID },
    });
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    // Assemblerは呼ばれない: planner + tool-smith + skill-writer の3回だけ（目標達成済みでAnalystも不要）。
    expect(finished?.budget.consumed.roleCalls).toBe(3);
    expect(model.requests).toHaveLength(3);

    // 生成物は既存Agentのpatch新版へ統合される（新しいAgentは作られない）。
    expect(finished?.artifacts.tools).toEqual([{ internalId: 'asset-1', version: '1.0.0' }]);
    expect(finished?.artifacts.skills).toEqual([{ internalId: 'asset-2', version: '1.0.0' }]);
    expect(finished?.artifacts.agentVersions).toEqual([{ internalId: BASE_AGENT_ID, version: '1.0.1' }]);
    expect(await agentRepo.listVersions(scope, BASE_AGENT_ID)).toHaveLength(2);

    const enhanced = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    // 既存のTool/Skillは残り、新規分が和集合として足される。
    expect(enhanced?.tools.map((ref) => ref.internalId)).toEqual([BASE_TOOL_ID, 'asset-1']);
    expect(enhanced?.skills.map((ref) => ref.internalId)).toEqual([BASE_SKILL_ID, 'asset-2']);
    // 既存のメタデータ・設定は保たれる。
    expect(enhanced?.metadata.owner).toBe('alice');
    expect(enhanced?.metadata.displayName).toBe('Base Assistant');
    expect(enhanced?.metadata.publishName).toBe('base_assistant');
    expect(enhanced?.kind).toBe('normal');
    expect(enhanced?.metadata.state).toBe('draft');
    expect(enhanced?.harness).toEqual(BASE_AGENT_HARNESS);
    expect(enhanced?.mcpServers).toEqual(['sales-mcp']);

    // systemPrompt: 役割文・独自セクション・実行規則はそのまま、ガイド2節だけが新しい構成へ差し替わる。
    const prompt = enhanced?.systemPrompt ?? '';
    expect(prompt).toContain('# 役割\nあなたは「Base Assistant」です。経理担当者の売上の質問に、社内の言葉づかいで答えてください。');
    expect(prompt).toContain('# 独自メモ\n利用者が手で書いたセクション。Factoryの強化で消えてはならない。');
    expect(prompt).toContain('# 実行規則\n- 数字は必ず出典を添える。');
    expect(prompt).toContain('base_tool@1.0.0');   // 既存Toolのガイドは残る
    expect(prompt).toContain('lookup_sales@1.0.0'); // 追加Toolのガイドが入る
    expect(prompt).toContain('base_skill@1.0.0');
    // 差し替えであって追記ではない（ガイド見出しは1つずつのまま）。
    expect(prompt.match(/^# Tool使用ガイド$/gm)).toHaveLength(1);
    expect(prompt.match(/^# Skillガイド$/gm)).toHaveLength(1);

    // Stage 5以降は無改修で流用され、Scenarioのtargetは統合後の新版になる。
    expect(scenarioRunner.calls[0]?.target).toMatchObject({ agentId: BASE_AGENT_ID });
    expect(scenarioRunner.calls[0]?.target?.version.toString()).toBe('1.0.1');
    expect(finished?.events.map((event) => event.message)).toContain(`enhanced existing agent ${BASE_AGENT_ID}@1.0.1`);
  });

  it('options.promptStrategy=rewrite: Assemblerが既存プロンプトを受け取って役割文・実行規則を書き直す', async () => {
    const { repo, model, runFactory, createFactoryRun, agentRepo, toolRepo, skillRepo } = await setup();
    await seedBaseAgent(toolRepo, skillRepo, agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: validPlanJson('Base Assistant') }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const created = await createFactoryRun.execute({
      scope, goal: { goal: '今月の売上も引けるようにする', language: 'ja' },
      dataSourceIds: ['ds-1'], baseAgent: { internalId: BASE_AGENT_ID }, options: { promptStrategy: 'rewrite' },
    });
    expect(created.input.options.promptStrategy).toBe('rewrite');
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    // planner + tool-smith + skill-writer + assembler。rewriteの1回分が予算へ正しく反映される。
    expect(finished?.budget.consumed.roleCalls).toBe(4);
    expect(model.requests).toHaveLength(4);

    const enhanced = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    expect(enhanced?.systemPrompt.startsWith('# Role\nYou are the Sales Assistant')).toBe(true);
    expect(enhanced?.systemPrompt).not.toContain('独自メモ'); // 書き直しなので手書きの節は引き継がれない
    expect(enhanced?.systemPrompt).toContain('lookup_sales@1.0.0');
    // 既存のメタデータ・設定はrewriteでも保たれる（プロンプトだけが対象）。
    expect(enhanced?.metadata.owner).toBe('alice');
    expect(enhanced?.harness).toEqual(BASE_AGENT_HARNESS);
    expect(finished?.events.map((event) => event.message)).toContain('enhanced Base Assistant (prompt rewritten by assembler)');

    // Assemblerには既存のsystemPromptが untrusted data として渡る。
    expect(String(model.requests[3]?.messages.find((message) => message.role === 'user')?.content)).toContain('独自メモ');
  });

  it('存在しないbaseAgentはRunをfailedにする（0→1生成へ黙ってフォールバックしない）', async () => {
    const { repo, runFactory, createFactoryRun, model } = await setup();
    const created = await createFactoryRun.execute({
      scope, goal: { goal: '強化したい', language: 'ja' }, dataSourceIds: [], baseAgent: { internalId: 'missing-agent' },
    });

    await runFactory.execute(scope, created.id);

    const failed = await repo.find(scope, created.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.failure?.stage).toBe('profiling');
    expect(failed?.failure?.reason).toContain('base agent not found: missing-agent');
    expect(failed?.events.at(-1)).toMatchObject({ kind: 'run_failed' });
    expect(model.requests).toHaveLength(0); // Plannerまで到達しない。
  });

  it('baseAgent.version 指定でその版を起点にできる（最新版ではなく指定版を検証する）', async () => {
    const { repo, model, runFactory, createFactoryRun, scenarioRunner, agentRepo, toolRepo, skillRepo } = await setup();
    await seedBaseAgent(toolRepo, skillRepo, agentRepo);
    await seedBaseAgent(toolRepo, skillRepo, agentRepo, { version: SemVer.of(1, 0, 1), systemPrompt: `${BASE_AGENT_PROMPT}\n\n# 新しめの版\n最新版だけが持つ節。` });
    expect(await agentRepo.listVersions(scope, BASE_AGENT_ID)).toHaveLength(2);
    model.enqueue({ message: { role: 'assistant', content: noAdditionPlanJson() }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({
      scope, goal: { goal: '1.0.0 を起点に強化する', language: 'ja' },
      dataSourceIds: [], baseAgent: { internalId: BASE_AGENT_ID, version: '1.0.0' },
    });
    await runFactory.execute(scope, created.id);

    const finished = await repo.find(scope, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.artifacts.agentVersions).toEqual([{ internalId: BASE_AGENT_ID, version: '1.0.0' }]);
    expect(scenarioRunner.calls[0]?.target?.version.toString()).toBe('1.0.0');
    expect(finished?.events[0]?.message).toBe('enhancing agent Base Assistant@1.0.0');
    // 起点は指定版なので、最新版(1.0.1)だけが持つ節はPlannerへ渡らない。
    const plannerUserMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(plannerUserMessage).not.toContain('新しめの版');
  });

  it('requirePlanApproval: 強化モードの承認プロンプトは「既存Agentへ何件足すか」を示す', async () => {
    const { repo, model, runFactory, createFactoryRun, agentRepo, toolRepo, skillRepo } = await setup();
    await seedBaseAgent(toolRepo, skillRepo, agentRepo);
    model.enqueue({ message: { role: 'assistant', content: validPlanJson('Base Assistant') }, finishReason: 'stop' });

    const created = await createFactoryRun.execute({
      scope, goal: { goal: '今月の売上も引けるようにする', language: 'ja' },
      dataSourceIds: ['ds-1'], baseAgent: { internalId: BASE_AGENT_ID }, options: { requirePlanApproval: true },
    });
    await runFactory.execute(scope, created.id);

    const waiting = await repo.find(scope, created.id);
    expect(waiting?.status).toBe('waiting-approval');
    expect(waiting?.checkpoint?.prompt).toContain('add 1 tool(s) and 1 skill(s) to the existing agent "Base Assistant"');
  });

  it('CreateFactoryRun: 強化モードは dataSourceIds 0件を許し、生成モードは1件必須のまま', async () => {
    const { createFactoryRun } = await setup();
    await expect(createFactoryRun.execute({ scope, goal: { goal: 'x', language: 'ja' }, dataSourceIds: [] }))
      .rejects.toThrow('dataSourceIds must contain 1..5 entries');
    const enhancing = await createFactoryRun.execute({ scope, goal: { goal: 'x', language: 'ja' }, dataSourceIds: [], baseAgent: { internalId: BASE_AGENT_ID } });
    expect(enhancing.input.dataSourceIds).toEqual([]);
    await expect(createFactoryRun.execute({ scope, goal: { goal: 'x', language: 'ja' }, dataSourceIds: ['a', 'b', 'c', 'd', 'e', 'f'], baseAgent: { internalId: BASE_AGENT_ID } }))
      .rejects.toThrow('dataSourceIds must contain 0..5 entries');
  });
});

// ─── cancel / abort ───────────────────────────────────────────────────────────────────

/** N回目のモデル呼び出しで「abort されるまで返らない」台本モデル（利用者が cancel を押す瞬間を決定的に作る）。 */
class HangingModelProvider extends ScriptedModelProvider {
  /** 中断で失敗した呼び出しも含めた試行回数（`requests` は成功した呼び出しだけを記録する）。 */
  attempts = 0;
  private hangAt = Number.POSITIVE_INFINITY;
  private onHang: (() => void) | undefined;
  hangOn(call: number, onHang?: () => void): void { this.hangAt = call; this.onHang = onHang; }
  override async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    this.attempts += 1;
    if (this.attempts === this.hangAt) {
      this.onHang?.();
      await rejectOnAbort(signal, `model call #${this.attempts}`);
    }
    return super.complete(request, signal);
  }
}

/** `saveIfStatus` の直前へ1回だけ処理を差し込める InMemory リポジトリ（「保存の直前に cancel が割り込んだ」を決定的に再現する）。 */
class InterposingFactoryRunRepository extends InMemoryFactoryRunRepository {
  private readonly hooks: { when: (run: FactoryRun) => boolean; action: () => Promise<void> }[] = [];
  interposeBeforeSave(when: (run: FactoryRun) => boolean, action: () => Promise<void>): void { this.hooks.push({ when, action }); }
  override async saveIfStatus(run: FactoryRun, expected: readonly FactoryRun['status'][]): Promise<boolean> {
    const index = this.hooks.findIndex((hook) => hook.when(run));
    if (index >= 0) await this.hooks.splice(index, 1)[0]!.action();
    return super.saveIfStatus(run, expected);
  }
}

/** `CancelFactoryRunUseCase` → worker.cancel → AbortSignal の関係を1本の AbortController で模す（保存してから abort する順序も同じ）。 */
class CancelHarness {
  readonly controller = new AbortController();
  workerCancels = 0;
  readonly useCase: CancelFactoryRunUseCase;
  constructor(repo: FactoryRunRepository) {
    const worker: FactoryWorkerPort = { ...noopWorker, cancel: () => { this.workerCancels += 1; this.controller.abort(new FactoryAbortedError(USER_CANCEL_MESSAGE)); } };
    this.useCase = new CancelFactoryRunUseCase(repo, worker);
  }
  get signal(): AbortSignal { return this.controller.signal; }
}

/** cancelled で確定し、`run_cancelled` がちょうど1件・最後のイベントであることを確かめる（以降のイベントが無い = running へ戻っていない）。 */
function expectCancelledOnce(run: FactoryRun | null, message: string = USER_CANCEL_MESSAGE): void {
  expect(run?.status).toBe('cancelled');
  expect(run?.finishedAt).toBeDefined();
  expect(run?.checkpoint).toBeUndefined();
  expect(run?.failure).toBeUndefined();
  expect(run?.events.filter((event) => event.kind === 'run_cancelled')).toHaveLength(1);
  expect(run?.events.at(-1)).toMatchObject({ kind: 'run_cancelled', message });
}

/** 遅れて流れてくる保存（イベントチェーン）が流れ切るのを待つ。 */
const settle = async (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

const goalInput = { goal: 'Answer sales questions', language: 'ja' } as const;

describe('RunFactoryUseCase（cancel / abort: 中断はモデル呼び出し1回分以内に効き、記録は必ず cancelled で確定する）', () => {
  it('Tool生成中（ToolSmith呼び出し中）の cancel: ロールが中断を観測し、以降のLLM呼び出しは無く、run_cancelled が1件だけ最後に残る', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun } = await setup({ model });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const harness = new CancelHarness(repo);
    let cancelRequest: Promise<FactoryRun> | undefined;
    model.hangOn(2, () => { cancelRequest = harness.useCase.execute(scope, created.id); });

    await runFactory.execute(scope, created.id, harness.signal);

    expect(harness.signal.aborted).toBe(true);
    expect(harness.workerCancels).toBe(1);
    expect((await cancelRequest)?.status).toBe('cancelled');
    // planner + 中断された tool-smith の2回だけ。skill-writer / assembler は呼ばれない。
    expect(model.attempts).toBe(2);
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.stage).toBe('generating-tools');
    expect(stored?.artifacts.tools).toEqual([]);
    // 遅れて流れてくる保存が running を蘇らせない。
    await settle();
    expect(await repo.find(scope, created.id)).toEqual(stored);
    expect(model.attempts).toBe(2);
  });

  it('計画中（Planner呼び出し中）の cancel: 計画は保存されず、planning 段で cancelled に確定する', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun } = await setup({ model });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const harness = new CancelHarness(repo);
    model.hangOn(1, () => { void harness.useCase.execute(scope, created.id); });

    await runFactory.execute(scope, created.id, harness.signal);

    expect(model.attempts).toBe(1);
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.stage).toBe('planning');
    expect(stored?.plan).toBeUndefined();
    expect(stored?.budget.consumed.roleCalls).toBe(0);
  });

  it('検証中（ScenarioRunner実行中）の cancel: signal が ScenarioRunner まで届き、イテレーションは記録されず cancelled で確定する', async () => {
    const model = new HangingModelProvider();
    const scenarioRunner = new FakeScenarioRunner((input) => cannedScenarioRun(scope, input.scenarioId, input.version ?? SemVer.of(1, 0, 0)));
    const { repo, runFactory, createFactoryRun } = await setup({ model, scenarioRunner });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const harness = new CancelHarness(repo);
    scenarioRunner.hangOnce(() => { void harness.useCase.execute(scope, created.id); });

    await runFactory.execute(scope, created.id, harness.signal);

    expect(scenarioRunner.calls).toHaveLength(1);
    expect(scenarioRunner.signals[0]).toBe(harness.signal);
    expect(model.attempts).toBe(4); // Analyst は呼ばれない。
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.stage).toBe('validating');
    expect(stored?.iterations).toEqual([]);
    expect(stored?.budget.consumed.scenarioRuns).toBe(0);
  });

  it('改善ループ中（Analyst呼び出し中）の cancel: 分析は記録されず、Agent の新版も作られず cancelled で確定する', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun, agentRepo } = await setup({
      model,
      makeScenarioRun: (input) => cannedScenarioRun(scope, input.scenarioId, input.target?.version ?? input.version ?? SemVer.of(1, 0, 0), { goalAchieved: false, satisfaction: 2 }),
    });
    enqueueGenerationScript(model);
    model.enqueue({ message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const harness = new CancelHarness(repo);
    model.hangOn(5, () => { void harness.useCase.execute(scope, created.id); });

    await runFactory.execute(scope, created.id, harness.signal);

    expect(model.attempts).toBe(5);
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.stage).toBe('analyzing');
    expect(stored?.iterations).toHaveLength(1);
    expect(stored?.iterations[0]?.analysis).toBeUndefined();
    expect(await agentRepo.listVersions(scope, 'asset-3')).toHaveLength(1);
  });

  it('改善適用（ApplyImprovements）へも Run の signal がそのまま渡る', async () => {
    const { repo, model, runFactory, createFactoryRun, applyCalls } = await setup({
      makeScenarioRun: (input) => {
        const version = input.target?.version ?? input.version ?? SemVer.of(1, 0, 0);
        return cannedScenarioRun(scope, input.scenarioId, version, version.toString() === '1.0.0' ? { goalAchieved: false, satisfaction: 2 } : { goalAchieved: true, satisfaction: 5 });
      },
    });
    enqueueGenerationScript(model);
    model.enqueue({ message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const controller = new AbortController();

    await runFactory.execute(scope, created.id, controller.signal);

    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.signal).toBe(controller.signal);
    // abort されない signal は実行に影響しない（従来どおり succeeded で終わる）。
    expect((await repo.find(scope, created.id))?.status).toBe('succeeded');
  });

  it('waiting-approval 中の cancel: 実行は走らず cancelled で確定し、checkpoint は消え、以降の execute は何もせず、承認応答は拒否される', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun, resumeFactoryRun } = await setup({ model });
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { requirePlanApproval: true } });
    await runFactory.execute(scope, created.id);
    expect(await repo.find(scope, created.id)).toMatchObject({ status: 'waiting-approval' });
    const harness = new CancelHarness(repo);

    const cancelled = await harness.useCase.execute(scope, created.id);

    expectCancelledOnce(cancelled);
    expect(cancelled.plan).toBeDefined(); // 計画は監査のため残る（checkpoint だけ消える）。
    expect(harness.workerCancels).toBe(1);
    expectCancelledOnce(await repo.find(scope, created.id));

    // 終端の Run は worker が拾っても何もしない（モデル呼び出しも保存も無い）。
    await runFactory.execute(scope, created.id, new AbortController().signal);
    expect(model.attempts).toBe(1);
    expectCancelledOnce(await repo.find(scope, created.id));

    // cancel 済みの Run への承認応答（approve / revise / reject）はいずれも拒否され、記録は変わらない。
    await expect(resumeFactoryRun.execute({ scope, runId: created.id, decision: 'approve' })).rejects.toBeInstanceOf(FactoryValidationError);
    await expect(resumeFactoryRun.execute({ scope, runId: created.id, decision: 'revise', feedback: 'x' })).rejects.toThrow(/not waiting for approval/);
    await expect(resumeFactoryRun.execute({ scope, runId: created.id, decision: 'reject' })).rejects.toThrow(/not waiting for approval/);
    expectCancelledOnce(await repo.find(scope, created.id));
    expect(model.attempts).toBe(1);
  });

  it('承認応答の処理中（find と保存の間）に cancel が入っても、cancelled を running で上書きせず拒否する', async () => {
    const repo = new InterposingFactoryRunRepository();
    const model = new HangingModelProvider();
    const { runFactory, createFactoryRun, resumeFactoryRun } = await setup({ model, repo });
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { requirePlanApproval: true } });
    await runFactory.execute(scope, created.id);
    const harness = new CancelHarness(repo);
    repo.interposeBeforeSave((run) => run.events.at(-1)?.kind === 'approval_resolved', async () => { await harness.useCase.execute(scope, created.id); });

    await expect(resumeFactoryRun.execute({ scope, runId: created.id, decision: 'approve' })).rejects.toThrow(/not waiting for approval/);

    expectCancelledOnce(await repo.find(scope, created.id));
  });

  it('cancel 後に遅れて流れてきた onEvent の保存は saveIfStatus が false になり、実行は中断して記録は cancelled のまま（running へ戻らない）', async () => {
    const repo = new InterposingFactoryRunRepository();
    const model = new HangingModelProvider();
    const { runFactory, createFactoryRun } = await setup({ model, repo });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const cancelledAt = '2026-08-01T00:00:00.000Z';
    // ToolSmith の結果イベント（tool_generated）が保存される直前に、別経路の cancel が cancelled を書き込んだ状況
    // （signal は abort されていない = 通知がまだ届いていない）を作る。
    repo.interposeBeforeSave((run) => run.events.at(-1)?.kind === 'tool_generated', async () => {
      const stored = await repo.find(scope, created.id);
      if (stored === null) throw new Error('run must exist');
      let cancelled = cancelFactoryRun(stored, cancelledAt);
      cancelled = appendFactoryEvent(cancelled, { kind: 'run_cancelled', at: cancelledAt, stage: stored.stage, message: USER_CANCEL_MESSAGE });
      await repo.save(cancelled);
    });

    await runFactory.execute(scope, created.id);

    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.finishedAt).toBe(cancelledAt);
    expect(stored?.events.map((event) => event.kind)).not.toContain('tool_generated');
    expect(stored?.events.map((event) => event.kind)).not.toContain('artifact_saved');
    expect(stored?.artifacts.tools).toEqual([]);
    expect(stored?.artifacts.agentVersions).toEqual([]);
    await settle();
    expect(await repo.find(scope, created.id)).toEqual(stored);
  });

  it('worker の shutdown による abort（利用者の cancel ではない）: running を残さず、shutdown の理由付きで cancelled に確定する', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun } = await setup({ model });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const controller = new AbortController();
    model.hangOn(2, () => { controller.abort(new FactoryAbortedError(SHUTDOWN_ABORT_MESSAGE)); });

    await runFactory.execute(scope, created.id, controller.signal);

    expect(model.attempts).toBe(2);
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored, SHUTDOWN_ABORT_MESSAGE);
    expect(stored?.stage).toBe('generating-tools');
  });

  it('理由の無い abort も「利用者の cancel ではない中断」として shutdown 扱いで cancelled に確定する', async () => {
    const model = new HangingModelProvider();
    const { repo, runFactory, createFactoryRun } = await setup({ model });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const controller = new AbortController();
    model.hangOn(1, () => { controller.abort(); });

    await runFactory.execute(scope, created.id, controller.signal);

    expectCancelledOnce(await repo.find(scope, created.id), SHUTDOWN_ABORT_MESSAGE);
  });

  it('境界: abort 確認を通過した直後・保存の直前に cancel が割り込んでも、その保存は通らず cancelled で終わる', async () => {
    const repo = new InterposingFactoryRunRepository();
    const model = new HangingModelProvider();
    const { runFactory, createFactoryRun } = await setup({ model, repo });
    enqueueGenerationScript(model);
    const created = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'] });
    const harness = new CancelHarness(repo);
    // Stage 2 の完了イベント（generating-tools の stage_completed）は throwIfAborted(signal) を通過した直後に保存される。
    // その保存の直前で cancel を完了させる（保存済み: cancelled、signal: abort 済み）。
    repo.interposeBeforeSave(
      (run) => run.events.at(-1)?.kind === 'stage_completed' && run.events.at(-1)?.stage === 'generating-tools',
      async () => { await harness.useCase.execute(scope, created.id); },
    );

    await runFactory.execute(scope, created.id, harness.signal);

    expect(harness.signal.aborted).toBe(true);
    expect(model.attempts).toBe(4); // planner / tool-smith / skill-writer / assembler まで。以降は何も呼ばれない。
    const stored = await repo.find(scope, created.id);
    expectCancelledOnce(stored);
    expect(stored?.stage).toBe('generating-tools');
    expect(stored?.events.filter((event) => event.kind === 'stage_completed' && event.stage === 'generating-tools')).toHaveLength(0);
    await settle();
    expect(await repo.find(scope, created.id)).toEqual(stored);
  });
});

// ─── ADR-0047: 期待Tool名・Analystの材料・提案0件・レポートの品質判定 ──────────────────────
/** Analyst が受け取った user message（untrusted payload）をJSONとして取り出す。 */
function analystPayloadOf(model: ScriptedModelProvider): Record<string, unknown> {
  const request = model.requests.find((candidate) => candidate.responseFormat?.name === 'factory_analyst_proposal');
  const content = String(request?.messages.find((message) => message.role === 'user')?.content ?? '');
  const json = content.split('\n')[1] ?? '{}';
  return JSON.parse(json) as Record<string, unknown>;
}

function analystRequestsOf(model: ScriptedModelProvider): ModelCompletionRequest[] {
  return model.requests.filter((candidate) => candidate.responseFormat?.name === 'factory_analyst_proposal');
}

/** proposals が空の Analyst 応答（「直します」と書いておきながら何も返さない実測の失敗）。 */
function emptyProposalsAnalysisJson(summary = 'I am revising the system prompt.'): string {
  return JSON.stringify({
    findings: [{ id: 'f1', severity: 'critical', area: 'agent', detail: 'the agent never calls the tool' }],
    proposals: [],
    summary,
  });
}

/** 検証の見かけを作るための ScenarioRun（失敗の段・アンケート欠測・期待Tool名を指定できる）。 */
function scenarioRunWith(
  input: ScenarioRunnerInput,
  options: {
    readonly status?: 'completed' | 'max-turns' | 'error';
    readonly goalAchieved?: boolean | null;
    readonly error?: { readonly stage: 'pseudo-user' | 'agent' | 'survey'; readonly message: string };
    readonly survey?: boolean;
    readonly satisfaction?: number;
    readonly expected?: readonly string[];
    readonly called?: readonly string[];
    readonly agentRunId?: string;
  } = {},
): ScenarioRun {
  const survey = options.survey === false
    ? []
    : [{ questionId: 'q2', value: options.satisfaction ?? 2 }, { questionId: 'impressions', value: 'numbers looked made up' }];
  return createScenarioRun({
    id: `scenario-run-${input.scenarioId}`,
    scope,
    scenario: { id: input.scenarioId, version: input.version ?? SemVer.of(1, 0, 0) },
    status: options.status ?? 'completed',
    ...(options.error === undefined ? {} : { error: options.error }),
    goalAchieved: options.goalAchieved ?? false,
    transcript: [
      { speaker: 'user', message: '2008年から2010年の推移は？' },
      { speaker: 'agent', message: '約300万人でした。', runId: options.agentRunId ?? 'agent-run-1' },
    ],
    survey,
    impressions: survey.length === 0 ? '' : 'numbers looked made up',
    metrics: {
      userTurns: 1, agentRuns: 1, totalToolCalls: 1,
      expectedToolHit: { expected: [...(options.expected ?? ['lookup_sales'])], called: [...(options.called ?? [])], hitRate: 0 },
      durationMs: 250, usage: { totalTokens: 15 },
    },
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:00:01.000Z',
  });
}

/** 「0行のツール結果 → 数字入りの回答」を含む Agent Run のトレース。 */
function zeroRowAgentRun(runId: string): RunRecord {
  return {
    runId,
    scope,
    status: 'succeeded',
    mode: 'test',
    purpose: 'scenario',
    agent: { internalId: 'asset-3', version: '0.1.0' },
    startedAt: '2026-07-20T00:00:00.000Z',
    trace: [
      { sequence: 1, kind: 'tool-call', name: 'lookup_sales', arguments: { period: '2015年12月31日' } },
      { sequence: 2, kind: 'tool-result', name: 'lookup_sales', terminalId: 'out', nodes: [{ nodeId: 'out', rowCount: 0, truncated: false }], outputPreview: [] },
      { sequence: 3, kind: 'model-response', content: '2008年から2010年は約300万人でした。' },
    ],
  };
}

describe('RunFactoryUseCase（期待Tool名はエージェントが呼ぶ関数名で固定する）', () => {
  it('正常: Scenario.expectedTools には agentTool.name が入る（publishName ではない）', async () => {
    const { model, runFactory, createFactoryRun, scenarioRepo, toolRepo } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const run = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 1 } });

    await runFactory.execute(scope, run.id);

    const scenario = (await scenarioRepo.list(scope)).map((summary) => summary.internalId)[0];
    const saved = await scenarioRepo.findLatest(scope, scenario ?? '');
    const tool = await toolRepo.findLatest(scope, 'asset-1');
    expect(saved?.expectedTools).toEqual(['lookup_sales']);
    expect(tool?.agentTool?.name).toBe('lookup_sales');
    // publishName は factory_tool_... であり、実行時の calledTools とは一致しない。
    expect(tool?.metadata.publishName).not.toBe('lookup_sales');
  });

  it('正常: 再利用した既存Toolも、その Tool契約名で expectedTools に入る', async () => {
    const { model, runFactory, createFactoryRun, scenarioRepo, toolRepo } = await setup();
    await seedBuiltinDatetimeTool(toolRepo);
    model.enqueue(
      { message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const run = await createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 1 } });

    await runFactory.execute(scope, run.id);

    const scenario = (await scenarioRepo.list(scope)).map((summary) => summary.internalId)[0];
    const saved = await scenarioRepo.findLatest(scope, scenario ?? '');
    expect(saved?.expectedTools).toContain('current_datetime');
  });
});

describe('RunFactoryUseCase（Analystへ渡す材料）', () => {
  /** 目標未達で1イテレーション目の分析まで進むRunを組み立てる（分析結果は呼び出し側が enqueue する）。 */
  async function runToAnalysis(options: {
    readonly makeScenarioRun: (input: ScenarioRunnerInput) => ScenarioRun;
    readonly analyses: readonly string[];
    readonly runRecords?: readonly RunRecord[];
  }): Promise<{ model: ScriptedModelProvider; repo: FactoryRunRepository; runId: string }> {
    const context = await setup({ makeScenarioRun: options.makeScenarioRun });
    for (const record of options.runRecords ?? []) await context.runRepo.save(record);
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      ...options.analyses.map((content) => ({ message: { role: 'assistant' as const, content }, finishReason: 'stop' as const })),
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2 } });
    await context.runFactory.execute(scope, run.id);
    return { model: context.model, repo: context.repo, runId: run.id };
  }

  it('正常: 失敗した段・期待Tool名と実呼び出し名・アンケート欠測をScenario別サマリへ載せる', async () => {
    const { model } = await runToAnalysis({
      makeScenarioRun: (input) => scenarioRunWith(input, {
        status: 'completed', error: { stage: 'survey', message: 'survey could not be collected' }, survey: false,
        expected: ['lookup_sales'], called: ['fetch_unemployment_data'],
      }),
      analyses: [validAnalystProposalJson()],
    });

    const payload = analystPayloadOf(model);
    const summary = (payload['scenarioSummaries'] as Record<string, unknown>[])[0]!;
    expect(summary['errorStage']).toBe('survey');
    expect(summary['errorMessage']).toMatch(/survey could not be collected/);
    expect(summary['surveyCollected']).toBe(false);
    expect(summary['expectedTools']).toEqual(['lookup_sales']);
    expect(summary['calledTools']).toEqual(['fetch_unemployment_data']);
    // アンケート欠測はメトリクスにも出る（満足度0を「不満」と読み違えないため）。
    expect((payload['metrics'] as Record<string, unknown>)['surveyMissingCount']).toBe(1);
  });

  it('正常: 実際のツール呼び出し（引数と返却行数）と「0行なのに数字で答えた」フラグを載せる', async () => {
    const { model } = await runToAnalysis({
      makeScenarioRun: (input) => scenarioRunWith(input, { called: ['lookup_sales'], agentRunId: 'agent-run-1' }),
      analyses: [validAnalystProposalJson()],
      runRecords: [zeroRowAgentRun('agent-run-1')],
    });

    const payload = analystPayloadOf(model);
    const summary = (payload['scenarioSummaries'] as Record<string, unknown>[])[0]!;
    const calls = summary['toolCalls'] as Record<string, unknown>[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'lookup_sales', arguments: { period: '2015年12月31日' }, rowCount: 0 });
    expect(summary['answeredWithNumbersAfterZeroRows']).toBe(true);
  });

  it('境界: トレースが読めない（Runレコードが無い）場合でも分析は続き、toolCallsを省く', async () => {
    const { model } = await runToAnalysis({
      makeScenarioRun: (input) => scenarioRunWith(input, { agentRunId: 'missing-run' }),
      analyses: [validAnalystProposalJson()],
    });

    const summary = (analystPayloadOf(model)['scenarioSummaries'] as Record<string, unknown>[])[0]!;
    expect(summary['toolCalls']).toBeUndefined();
    expect(summary['answeredWithNumbersAfterZeroRows']).toBeUndefined();
  });

  it('正常: サマリの読み方（errorStage / surveyCollected / 0行で数字）をsystemプロンプトで指示する', async () => {
    const { model } = await runToAnalysis({
      makeScenarioRun: (input) => scenarioRunWith(input),
      analyses: [validAnalystProposalJson()],
    });

    const system = String(analystRequestsOf(model)[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(system).toMatch(/surveyCollected: false means the satisfaction score is MISSING, not low/);
    expect(system).toMatch(/expectedTools vs calledTools/);
    expect(system).toMatch(/answeredWithNumbersAfterZeroRows/);
  });
});

describe('RunFactoryUseCase（提案0件のロール失敗）', () => {
  it('異常: proposals が空なら明示的な差し戻しで1回だけ再依頼する', async () => {
    const context = await setup({ makeScenarioRun: (input) => scenarioRunWith(input) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2 } });

    await context.runFactory.execute(scope, run.id);

    const analystRequests = analystRequestsOf(context.model);
    expect(analystRequests).toHaveLength(2);
    // 再依頼はuntrusted payload側にフィードバックを載せる（system命令を書き換えない）。
    expect(String(analystRequests[1]?.messages.find((message) => message.role === 'user')?.content)).toContain('EMPTY proposals array');
    // 2回目で提案が出たので改善ループは続く（イテレーション2が走る）。
    const stored = await context.repo.find(scope, run.id);
    expect(stored?.iterations).toHaveLength(2);
    expect(stored?.budget.consumed.roleCalls).toBeGreaterThanOrEqual(6);
  });

  it('異常: 再依頼しても空なら no_proposals の理由をイベントへ残して打ち切る（黙って終わらない）', async () => {
    const context = await setup({ makeScenarioRun: (input) => scenarioRunWith(input) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2 } });

    await context.runFactory.execute(scope, run.id);

    const stored = await context.repo.find(scope, run.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.iterations).toHaveLength(1);
    const reason = stored?.events.find((event) => event.message?.startsWith(LOOP_STOPPED_NO_PROPOSALS) === true);
    expect(reason?.message).toMatch(/even after an explicit re-ask/);
    expect(reason?.stage).toBe('analyzing');
  });

  it('境界: 予算(maxRoleCalls)に余裕が無ければ再依頼しない', async () => {
    const context = await setup({ makeScenarioRun: (input) => scenarioRunWith(input) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
    );
    // plan(1) + toolSmith(1) + skillWriter(1) + assembler(1) = 4 消費済み。上限5なら再依頼の余地が無い。
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2, budget: { maxDurationMs: 1_800_000, maxRoleCalls: 5, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 } } });

    await context.runFactory.execute(scope, run.id);

    expect(analystRequestsOf(context.model)).toHaveLength(1);
    const stored = await context.repo.find(scope, run.id);
    expect(stored?.events.some((event) => event.message?.startsWith(LOOP_STOPPED_NO_PROPOSALS) === true)).toBe(true);
  });
});

describe('assessReportQuality（statusとは別に成果物の質を決定的に判定する）', () => {
  const targets = { minGoalAchievedRate: 0.75, minAvgSatisfaction: 4 };
  const metrics = (overrides: Partial<IterationMetrics>): IterationMetrics => ({
    iteration: 1, goalAchievedRate: 1, avgSatisfaction: 5, toolHitRate: 1, errorRate: 0,
    avgUserTurns: 1, scenarioCount: 2, surveyMissingCount: 0, usage: {}, durationMs: 1, ...overrides,
  });

  it('正常: 目標を満たしていれば met-targets（理由なし）', () => {
    expect(assessReportQuality(metrics({}), targets)).toEqual({ quality: 'met-targets', reasons: [] });
  });

  it('異常: 測れたうえで目標に届かなければ below-targets（どの指標が足りないかを添える）', () => {
    const verdict = assessReportQuality(metrics({ goalAchievedRate: 0.5, avgSatisfaction: 3 }), targets);
    expect(verdict.quality).toBe('below-targets');
    expect(verdict.reasons.join(' ')).toMatch(/goalAchievedRate 0.50 is below the target 0.75/);
    expect(verdict.reasons.join(' ')).toMatch(/avgSatisfaction 3.00 is below the target 4/);
  });

  it('異常: 全シナリオがエラー・アンケート全欠測は unverified（未達とは断定しない）', () => {
    expect(assessReportQuality(metrics({ errorRate: 1, goalAchievedRate: 0 }), targets)).toEqual({
      quality: 'unverified',
      reasons: ['every scenario ended in an error, so no behaviour was actually observed'],
    });
    expect(assessReportQuality(metrics({ surveyMissingCount: 2, avgSatisfaction: 0 }), targets).quality).toBe('unverified');
  });

  it('境界: シナリオ0件・メトリクス未定義も unverified', () => {
    expect(assessReportQuality(metrics({ scenarioCount: 0 }), targets).quality).toBe('unverified');
    expect(assessReportQuality(undefined, targets).quality).toBe('unverified');
  });

  it('境界: 一部だけアンケート欠測でも、目標を満たしていれば met-targets のまま理由だけ残す', () => {
    const verdict = assessReportQuality(metrics({ surveyMissingCount: 1 }), targets);
    expect(verdict.quality).toBe('met-targets');
    expect(verdict.reasons.join(' ')).toMatch(/1 of 2 scenario\(s\) returned no satisfaction survey/);
  });

  it('正常: レポートへ quality と理由が載る（statusがsucceededでも品質は別に読める）', async () => {
    const context = await setup({ makeScenarioRun: (input) => scenarioRunWith(input, { status: 'error', error: { stage: 'agent', message: 'tool overflowed' }, survey: false, goalAchieved: null }) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: emptyProposalsAnalysisJson() }, finishReason: 'stop' },
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2 } });

    await context.runFactory.execute(scope, run.id);

    const stored = await context.repo.find(scope, run.id);
    expect(stored?.status).toBe('succeeded'); // パイプラインは完走した…
    expect(stored?.report?.quality).toBe('unverified'); // …が、成果物は検証できていない。
    expect(stored?.report?.qualityReasons.join(' ')).toMatch(/every scenario ended in an error/);
  });
});

// ─── ADR-0047 round 2: 悪化の決定的な列挙と、最良イテレーションの選び方 ──────────────────
describe('describeRegressions（前イテレーションからの悪化を事実として列挙する）', () => {
  const metricsOf = (overrides: Partial<IterationMetrics>): IterationMetrics => ({
    iteration: 1, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 1, errorRate: 0,
    avgUserTurns: 1, scenarioCount: 2, surveyMissingCount: 0, usage: {}, durationMs: 1, ...overrides,
  });
  const at = (metrics: IterationMetrics, stages: readonly string[] = []) => ({ metrics, errorStages: new Set(stages) });

  it('正常: 主指標・満足度・ツール命中率の低下と、エラー率・アンケート欠測の増加を挙げる', () => {
    const regressions = describeRegressions(
      at(metricsOf({ goalAchievedRate: 0, avgSatisfaction: 2, toolHitRate: 0.5, errorRate: 0.5, surveyMissingCount: 1 })),
      at(metricsOf({})),
    );

    expect(regressions.join(' ')).toMatch(/goalAchievedRate fell from 0.50 to 0.00/);
    expect(regressions.join(' ')).toMatch(/avgSatisfaction fell from 3.00 to 2.00/);
    expect(regressions.join(' ')).toMatch(/toolHitRate fell from 1.00 to 0.50/);
    expect(regressions.join(' ')).toMatch(/errorRate rose from 0.00 to 0.50/);
    expect(regressions.join(' ')).toMatch(/surveyMissingCount rose from 0.00 to 1.00/);
  });

  it('正常: 前になかった失敗の段（新しい壊れ方）は必ず挙げる', () => {
    const regressions = describeRegressions(at(metricsOf({}), ['agent']), at(metricsOf({}), ['survey']));

    expect(regressions).toEqual(["scenarios now fail at the 'agent' stage, which did not happen in the previous iteration"]);
  });

  it('境界: 改善・横ばいは悪化として挙げない', () => {
    expect(describeRegressions(at(metricsOf({ goalAchievedRate: 1 })), at(metricsOf({})))).toEqual([]);
    expect(describeRegressions(at(metricsOf({}), ['agent']), at(metricsOf({}), ['agent']))).toEqual([]);
  });

  it('例外: 比較対象（前イテレーション）が無ければ空（イテレーション1では悪化を語らない）', () => {
    expect(describeRegressions(at(metricsOf({ goalAchievedRate: 0, errorRate: 1 }), ['agent']), undefined)).toEqual([]);
  });
});

describe('selectBestIteration（errorRateまで含めた最良版の選び方）', () => {
  const iteration = (index: number, overrides: Partial<IterationMetrics>): FactoryIteration => ({
    index,
    agentVersion: `0.1.${index}`,
    scenarioRunIds: [],
    metrics: {
      iteration: index, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 1, errorRate: 0,
      avgUserTurns: 1, scenarioCount: 2, surveyMissingCount: 0, usage: {}, durationMs: 1, ...overrides,
    },
  });

  it('正常: 主指標（goalAchievedRate）が最大のイテレーションを選ぶ', () => {
    expect(selectBestIteration([iteration(1, { goalAchievedRate: 0.5 }), iteration(2, { goalAchievedRate: 0 })]).index).toBe(1);
  });

  it('正常: 主指標が同点ならエラー率の低い方を選ぶ（落ちた会話は「満足度が高い」ではない）', () => {
    const best = selectBestIteration([
      iteration(1, { errorRate: 0.5, avgSatisfaction: 5 }),
      iteration(2, { errorRate: 0, avgSatisfaction: 3 }),
    ]);
    expect(best.index).toBe(2);
  });

  it('境界: 主指標もエラー率も同点なら満足度、それも同点なら先のイテレーションを残す', () => {
    expect(selectBestIteration([iteration(1, { avgSatisfaction: 3 }), iteration(2, { avgSatisfaction: 4 })]).index).toBe(2);
    expect(selectBestIteration([iteration(1, {}), iteration(2, {})]).index).toBe(1);
  });

  it('例外: イテレーションが1件も無ければ FactoryValidationError', () => {
    expect(() => selectBestIteration([])).toThrow(FactoryValidationError);
  });
});

describe('RunFactoryUseCase（悪化と呼び出し予算をAnalystへ渡す）', () => {
  /**
   * イテレーション1は目標を達成、イテレーション2で主指標だけが落ちる台本。
   * 満足度は上げておく（両方が横ばい以下だと「改善停滞」で2回目の分析まで進まない）。
   */
  function worseningRun(input: ScenarioRunnerInput, attempt: { count: number }): ScenarioRun {
    attempt.count += 1;
    return attempt.count === 1
      ? scenarioRunWith(input, { goalAchieved: true, satisfaction: 2, called: ['lookup_sales'] })
      : scenarioRunWith(input, { goalAchieved: false, satisfaction: 3, called: ['lookup_sales'] });
  }

  it('正常: 2回目の分析には、前イテレーションからの悪化が事実として渡る', async () => {
    const attempt = { count: 0 };
    const context = await setup({ makeScenarioRun: (input) => worseningRun(input, attempt) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 3 } });

    await context.runFactory.execute(scope, run.id);

    const analystRequests = context.model.requests.filter((request) => request.responseFormat?.name === 'factory_analyst_proposal');
    expect(analystRequests.length).toBeGreaterThanOrEqual(2);
    const first = String(analystRequests[0]?.messages.find((message) => message.role === 'user')?.content);
    const second = String(analystRequests[1]?.messages.find((message) => message.role === 'user')?.content);
    // イテレーション1には比較対象が無いので悪化を語らない。
    expect(first).not.toContain('"regressions"');
    expect(second).toContain('"regressions"');
    expect(second).toMatch(/goalAchievedRate fell from 1.00 to 0.00/);
    // 上がった指標は悪化として挙げない。
    expect(second).not.toMatch(/avgSatisfaction fell/);
  });

  it('正常: Analystへ会話あたりのツール呼び出し上限を渡す（1対象1呼び出しの提案を止める）', async () => {
    const context = await setup({ makeScenarioRun: (input) => scenarioRunWith(input) });
    context.model.enqueue(
      { message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAnalystProposalJson() }, finishReason: 'stop' },
    );
    const run = await context.createFactoryRun.execute({ scope, goal: goalInput, dataSourceIds: ['ds-1'], options: { maxIterations: 2 } });

    await context.runFactory.execute(scope, run.id);

    const analystRequest = context.model.requests.find((request) => request.responseFormat?.name === 'factory_analyst_proposal');
    expect(String(analystRequest?.messages.find((message) => message.role === 'user')?.content)).toContain(`"toolCallBudget":${MAX_TOOL_CALLS}`);
  });
});

describe('candidateSourceSets: テンプレートの適用可否を数えるソースの組み（v43 / ADR-0049）', () => {
  /** 結合候補だけを持つ最小のプロファイル（この関数は id と joinCandidates しか見ない）。 */
  function profileOf(dataSourceId: string, joinCandidates: DataProfile['joinCandidates'] = []): DataProfile {
    return {
      dataSourceId, name: dataSourceId, kind: 'file', columns: [], sampleRowCount: 0, sampleRows: [],
      rowCount: 0, periodColumns: [], categoricalColumns: [], joinCandidates,
    };
  }
  function candidate(left: string, right: string): DataProfile['joinCandidates'][number] {
    return { leftDataSourceId: left, rightDataSourceId: right, keys: ['時点'], overlap: { 時点: 1 }, uniqueLeft: true, uniqueRight: true };
  }

  it('正常: 結合候補が無ければ、1 ソースずつの組だけを返す', () => {
    expect(candidateSourceSets([profileOf('ds-1'), profileOf('ds-2')])).toEqual([['ds-1'], ['ds-2']]);
  });

  it('正常: 結合候補が挙げた組だけを 2 ソースの組として足す（総当たりにしない）', () => {
    const joins = [candidate('ds-1', 'ds-2')];
    const profiles = [profileOf('ds-1', joins), profileOf('ds-2', joins), profileOf('ds-3', joins)];
    expect(candidateSourceSets(profiles)).toEqual([['ds-1'], ['ds-2'], ['ds-3'], ['ds-1', 'ds-2']]);
  });

  it('境界: 結合できるソースが 3 件以上あれば、先頭 3 件の組も 1 つだけ足す', () => {
    const joins = [candidate('ds-1', 'ds-2'), candidate('ds-2', 'ds-3')];
    const profiles = [profileOf('ds-1', joins), profileOf('ds-2', joins), profileOf('ds-3', joins)];
    expect(candidateSourceSets(profiles)).toEqual([
      ['ds-1'], ['ds-2'], ['ds-3'], ['ds-1', 'ds-2'], ['ds-2', 'ds-3'], ['ds-1', 'ds-2', 'ds-3'],
    ]);
  });

  it('異常: このRunに無いデータソースを指す結合候補は無視する', () => {
    const joins = [candidate('ds-1', 'ds-gone')];
    expect(candidateSourceSets([profileOf('ds-1', joins)])).toEqual([['ds-1']]);
  });
});

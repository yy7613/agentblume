import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { InMemoryPersonaRepository } from '../../adapters/storage/in-memory-persona-repository';
import { InMemoryScenarioRepository } from '../../adapters/storage/in-memory-scenario-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createAgent, type AgentRuntimeHarness } from '../../domain/agent/agent';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { createSkill } from '../../domain/skill/skill';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { createScenarioRun, type ScenarioRun } from '../../domain/validation/scenario-run';
import type { FactoryWorkerPort } from './factory-worker';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { EtlEngine } from '../etl/engine';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { SavePersonaUseCase } from '../validation/save-persona';
import { RegisterPseudoUserAgentUseCase } from '../validation/register-pseudo-user-agent';
import { SaveScenarioUseCase } from '../validation/save-scenario';
import { ApplyImprovementsUseCase, type ApplyImprovementsInput } from './apply-improvements';
import { CreateFactoryRunUseCase } from './create-factory-run';
import { GenerateAgentAssetsUseCase } from './generate-agent-assets';
import { ProfileDataSourcesUseCase } from './profile-data-sources';
import { AnalystRole } from './roles/analyst-role';
import { AssemblerRole } from './roles/assembler-role';
import { PlannerRole } from './roles/planner-role';
import { SkillWriterRole } from './roles/skill-writer-role';
import { ToolSmithRole } from './roles/tool-smith-role';
import { ResumeFactoryRunUseCase } from './resume-factory-run';
import { RunFactoryUseCase } from './run-factory';
import type { ScenarioRunnerInput, ScenarioRunnerPort } from './scenario-runner-port';

const scope = { tenantId: 't', workspaceId: 'w' };

/** テスト用のcanned `ScenarioRunnerPort`: 疑似ユーザー会話全体をscriptedで再現せず、固定のScenarioRunを返す。 */
class FakeScenarioRunner implements ScenarioRunnerPort {
  readonly calls: ScenarioRunnerInput[] = [];
  constructor(private readonly makeRun: (input: ScenarioRunnerInput) => ScenarioRun) {}
  async execute(input: ScenarioRunnerInput): Promise<ScenarioRun> {
    this.calls.push(input);
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

const noopWorker: FactoryWorkerPort = { enqueue: () => {}, cancel: () => {}, shutdown: () => {} };

async function setup(options?: { readonly makeScenarioRun?: (input: ScenarioRunnerInput) => ScenarioRun }): Promise<{
  repo: FactoryRunRepository; model: ScriptedModelProvider; runFactory: RunFactoryUseCase;
  createFactoryRun: CreateFactoryRunUseCase; resumeFactoryRun: ResumeFactoryRunUseCase;
  personaRepo: InMemoryPersonaRepository; scenarioRepo: InMemoryScenarioRepository; scenarioRunner: FakeScenarioRunner;
  agentRepo: InMemoryAgentRepository; skillRepo: InMemorySkillRepository; toolRepo: InMemoryToolRepository;
  applyCalls: ApplyImprovementsInput[];
}> {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, 'id,amount\n1,100\n2,200');
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  const model = new ScriptedModelProvider();
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
  const generateAgentAssets = new GenerateAgentAssetsUseCase(toolSmith, skillWriter, assembler, saveTool, saveSkill, saveAgent, generateAgentPrompt, engine, resolver, makeSequentialId('asset'));
  const savePersona = new SavePersonaUseCase(personaRepo);
  const registerPseudoUser = new RegisterPseudoUserAgentUseCase(personaRepo, saveAgent);
  const saveScenario = new SaveScenarioUseCase(scenarioRepo, agentRepo, personaRepo);
  const scenarioRunner = new FakeScenarioRunner(options?.makeScenarioRun ?? ((input) => cannedScenarioRun(scope, input.scenarioId, input.version ?? SemVer.of(1, 0, 0))));
  const realApplyImprovements = new ApplyImprovementsUseCase(agentRepo, skillRepo, toolRepo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine);
  // `RunFactoryUseCase` が渡す引数（maxRepairAttempts 等）を検証できるよう、実物を薄く包んで記録する。
  const applyCalls: ApplyImprovementsInput[] = [];
  const applyImprovements = {
    execute: async (input: ApplyImprovementsInput) => { applyCalls.push(input); return realApplyImprovements.execute(input); },
  } as unknown as ApplyImprovementsUseCase;

  const repo = new InMemoryFactoryRunRepository();
  const runFactory = new RunFactoryUseCase(repo, profiler, planner, generateAgentAssets, scenarioRunner, savePersona, registerPseudoUser, saveScenario, analyst, applyImprovements, agentRepo, skillRepo, toolRepo);
  const createFactoryRun = new CreateFactoryRunUseCase(repo, noopWorker);
  const resumeFactoryRun = new ResumeFactoryRunUseCase(repo, runFactory, noopWorker);
  return { repo, model, runFactory, createFactoryRun, resumeFactoryRun, personaRepo, scenarioRepo, scenarioRunner, agentRepo, skillRepo, toolRepo, applyCalls };
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

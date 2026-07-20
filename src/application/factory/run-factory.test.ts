import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { InMemoryPersonaRepository } from '../../adapters/storage/in-memory-persona-repository';
import { InMemoryScenarioRepository } from '../../adapters/storage/in-memory-scenario-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
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
import { ApplyImprovementsUseCase } from './apply-improvements';
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
  const applyImprovements = new ApplyImprovementsUseCase(agentRepo, skillRepo, toolRepo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine);

  const repo = new InMemoryFactoryRunRepository();
  const runFactory = new RunFactoryUseCase(repo, profiler, planner, generateAgentAssets, scenarioRunner, savePersona, registerPseudoUser, saveScenario, analyst, applyImprovements, agentRepo, skillRepo, toolRepo);
  const createFactoryRun = new CreateFactoryRunUseCase(repo, noopWorker);
  const resumeFactoryRun = new ResumeFactoryRunUseCase(repo, runFactory, noopWorker);
  return { repo, model, runFactory, createFactoryRun, resumeFactoryRun, personaRepo, scenarioRepo, scenarioRunner, agentRepo, skillRepo, toolRepo };
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
});

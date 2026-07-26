/**
 * application層: Agent Factory `RunFactoryUseCase`（v33 実装契約 §3 / docs/16-agent-factory.md §4, §5, §7）。
 *
 * `InProcessFactoryWorker` から呼ばれる、Runの「現在の状態から続きを駆動する」実行本体。
 * Stage 0（Profile）→ Stage 1（Plan）→（`requirePlanApproval` なら waiting-approval で停止）→
 * Stage 2-4（`GenerateAgentAssetsUseCase` によるTool/Skill/Agent生成、M2）→
 * Stage 5（検証資産の決定的マテリアライズ: Persona/pseudo-user Agent/Scenario）→
 * イテレーション1の検証（`runValidationIteration`）→ 改善ループ・レポート（`finalizeOrImprove`、M4）:
 * Analyst分析 → 改訂提案の検証・適用（`ApplyImprovementsUseCase`）→ 新Agent版の再検証 …を、
 * 目標達成 / 改善停滞 / 予算上限のいずれかに達するまで繰り返し、`FactoryReport` を添えて succeeded で終える。
 */
import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { DEFAULT_SURVEY } from '../../domain/validation/survey';
import {
  advanceStage,
  appendFactoryEvent,
  attachAnalysisToLastIteration,
  beginFactoryRun,
  failFactoryRun,
  recordIteration,
  setArtifacts,
  setPlan,
  succeedFactoryRun,
  updateBudget,
  waitForPlanApproval,
  type FactoryEvent,
  type FactoryGoalInput,
  type FactoryIteration,
  type FactoryPlanCheckpoint,
  type FactoryReport,
  type FactoryRun,
} from '../../domain/factory/factory-run';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { VersionRef } from '../../domain/factory/refs';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import { ApplyImprovementsUseCase } from './apply-improvements';
import { FACTORY_OWNER, GenerateAgentAssetsUseCase, makePublishName, type GenerateAgentAssetsResult } from './generate-agent-assets';
import { aggregateIterationMetrics } from './metrics';
import { ProfileDataSourcesUseCase } from './profile-data-sources';
import { buildExistingToolCatalog } from './tool-catalog';
import { AnalystRole, type AnalystScenarioSummary } from './roles/analyst-role';
import { PlannerRole } from './roles/planner-role';
import type { ScenarioRunnerPort } from './scenario-runner-port';
import type { SavePersonaUseCase } from '../validation/save-persona';
import type { RegisterPseudoUserAgentUseCase } from '../validation/register-pseudo-user-agent';
import type { SaveScenarioUseCase } from '../validation/save-scenario';

/** 計画承認checkpointのTTL（Harness checkpointと同じ24時間・docs/16 §6）。 */
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export class RunFactoryUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly profiler: ProfileDataSourcesUseCase,
    private readonly planner: PlannerRole,
    private readonly generateAgentAssets: GenerateAgentAssetsUseCase,
    private readonly scenarioRunner: ScenarioRunnerPort,
    private readonly savePersona: SavePersonaUseCase,
    private readonly registerPseudoUser: RegisterPseudoUserAgentUseCase,
    private readonly saveScenario: SaveScenarioUseCase,
    private readonly analyst: AnalystRole,
    private readonly applyImprovements: ApplyImprovementsUseCase,
    private readonly agents: AgentRepository,
    private readonly skills: SkillRepository,
    private readonly tools: ToolRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Worker entrypoint: Runを現在の状態から進める。終端・存在しないRunは無視する。 */
  async execute(scope: TenantScope, runId: string, signal?: AbortSignal): Promise<void> {
    const loaded = await this.runs.find(scope, runId);
    if (loaded === null) return;
    if (loaded.status !== 'queued' && loaded.status !== 'running') return;

    let run = loaded;
    try {
      if (run.status === 'queued') {
        run = beginFactoryRun(run);
        run = advanceStage(run, 'profiling');
        await this.runs.save(run);

        run = await this.event(run, { kind: 'stage_started', at: this.now().toISOString(), stage: 'profiling' });
        const profiles = await this.profiler.executeAll(scope, run.input.dataSourceIds);
        this.assertNotAborted(signal);
        run = await this.event(run, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'profiling' });

        run = advanceStage(run, 'planning');
        await this.runs.save(run);
        run = await this.event(run, { kind: 'stage_started', at: this.now().toISOString(), stage: 'planning' });
        // 「作成済みのToolで足りるか」をPlannerに考えさせるための再利用候補（docs/16 §4 Stage 1）。
        const existingTools = await buildExistingToolCatalog(this.tools, scope);
        const plan = await this.planner.propose({ goal: run.input.goal, profiles, dataSourceIds: run.input.dataSourceIds, options: run.input.options, existingTools }, signal);
        this.assertNotAborted(signal);

        run = setPlan(run, plan);
        run = updateBudget(run, { ...run.budget.consumed, roleCalls: run.budget.consumed.roleCalls + 1 });
        await this.runs.save(run);
        run = await this.event(run, { kind: 'plan_proposed', at: this.now().toISOString(), stage: 'planning' });
        run = await this.event(run, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'planning' });

        if (run.input.options.requirePlanApproval) {
          const checkpoint = this.buildCheckpoint(plan, run.input.goal);
          run = waitForPlanApproval(run, checkpoint);
          await this.runs.save(run);
          run = await this.event(run, { kind: 'approval_requested', at: this.now().toISOString(), stage: 'planning', message: checkpoint.prompt });
          return;
        }
      }

      // running（`requirePlanApproval:false` での続行、または approve 後の再開）: 生成継続。
      await this.runGeneration(run, signal);
    } catch (error) {
      if (signal?.aborted === true) return; // cancel は CancelFactoryRunUseCase が別途、状態を確定する。
      const current = await this.runs.find(scope, runId);
      if (current === null || current.status !== 'running') return; // 既に終端/waiting-approvalへ確定済み。
      const reason = error instanceof Error ? error.message : 'Factory run failed';
      let failed = failFactoryRun(current, { stage: current.stage, reason }, this.now().toISOString());
      failed = appendFactoryEvent(failed, { kind: 'run_failed', at: this.now().toISOString(), stage: current.stage, message: reason });
      await this.runs.save(failed);
    }
  }

  /**
   * `waiting-approval` から `revise` された Run を再プロファイル・再計画する。
   * 呼び出し側（`ResumeFactoryRunUseCase`）が `resumeFactoryRun` 適用済みの `running` Runを渡すこと。
   * 戻り値は新しい checkpoint で `waiting-approval` に戻った Run（保存は呼び出し側の責務）。
   */
  async replan(run: FactoryRun, feedback: string | undefined, signal?: AbortSignal): Promise<FactoryRun> {
    let next = run;
    const profiles = await this.profiler.executeAll(next.scope, next.input.dataSourceIds);
    const existingTools = await buildExistingToolCatalog(this.tools, next.scope);
    const plan = await this.planner.propose({
      goal: next.input.goal,
      profiles,
      dataSourceIds: next.input.dataSourceIds,
      options: next.input.options,
      existingTools,
      ...(feedback === undefined ? {} : { feedback }),
    }, signal);
    next = setPlan(next, plan);
    next = updateBudget(next, { ...next.budget.consumed, roleCalls: next.budget.consumed.roleCalls + 1 });
    next = appendFactoryEvent(next, { kind: 'plan_proposed', at: this.now().toISOString(), stage: 'planning', message: 'revised' });
    const checkpoint = this.buildCheckpoint(plan, next.input.goal);
    next = waitForPlanApproval(next, checkpoint);
    next = appendFactoryEvent(next, { kind: 'approval_requested', at: this.now().toISOString(), stage: 'planning', message: checkpoint.prompt });
    return next;
  }

  /**
   * Stage 2-4（Tool/Skill/Agent生成）。`GenerateAgentAssetsUseCase` へ委譲し、返された参照で
   * `run.artifacts`/`budget` を更新してから Stage 5以降（`runValidationAndImprove`）へ進む。
   */
  private async runGeneration(run: FactoryRun, signal?: AbortSignal): Promise<void> {
    const plan = run.plan;
    if (plan === undefined) throw new FactoryValidationError('runGeneration: run has no plan');

    let current = advanceStage(run, 'generating-tools');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-tools' });

    const profiles = await this.profiler.executeAll(current.scope, current.input.dataSourceIds);
    // 計画の `reuse` を解決する集合。Stage 1でPlannerへ提示したのと同じ規則で組み立て直す
    // （承認待ちを挟んだ再開でも、その時点で有効な既存Toolだけを参照する）。
    const existingTools = await buildExistingToolCatalog(this.tools, current.scope);
    this.assertNotAborted(signal);

    // `onEvent` は generateAgentAssets 内の逐次awaitの合間に同期的に呼ばれる。永続化(save)は非同期のため、
    // 発生順を保証する直列プロミスチェーンへ積み、execute() 完了後にまとめてflushする。
    let chain: Promise<void> = Promise.resolve();
    const onEvent = (event: Omit<FactoryEvent, 'sequence'>): void => {
      chain = chain.then(async () => {
        current = appendFactoryEvent(current, event);
        await this.runs.save(current);
      });
    };

    const assets: GenerateAgentAssetsResult = await this.generateAgentAssets.execute({
      scope: current.scope,
      runId: current.id,
      goal: current.input.goal,
      plan,
      profiles,
      maxRepairAttempts: current.input.options.budget.maxRepairAttempts,
      existingTools: existingTools.entries,
      onEvent,
    });
    await chain;
    this.assertNotAborted(signal);

    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-tools' });

    current = advanceStage(current, 'generating-skills');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-skills' });
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-skills' });

    current = advanceStage(current, 'assembling-agent');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'assembling-agent' });

    current = setArtifacts(current, {
      tools: assets.toolRefs,
      skills: assets.skillRefs,
      agentVersions: [assets.agentRef],
      personas: current.artifacts.personas,
      pseudoUsers: current.artifacts.pseudoUsers,
      scenarios: current.artifacts.scenarios,
    });
    current = updateBudget(current, { ...current.budget.consumed, roleCalls: current.budget.consumed.roleCalls + assets.roleCallsUsed });
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'assembling-agent' });

    await this.runValidationAndImprove(current, assets, signal);
  }

  /**
   * Stage 5（検証資産の決定的マテリアライズ）+ イテレーション1の検証実行。ScenarioDesignerロールは導入せず、
   * Stage 1 Plannerの `plan.personas`/`plan.scenarios` をそのままSave系ユースケースへ渡す
   * （docs/16 §4 Stage 5: 決定的マテリアライズ、新規LLM呼び出しなし）。
   * 完了後は改善ループ・レポート（`finalizeOrImprove`）へ委譲する。
   */
  private async runValidationAndImprove(run: FactoryRun, assets: GenerateAgentAssetsResult, signal?: AbortSignal): Promise<void> {
    const plan = run.plan;
    if (plan === undefined) throw new FactoryValidationError('runValidationAndImprove: run has no plan');

    let current = advanceStage(run, 'generating-validation');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-validation' });

    // Persona → 疑似ユーザーAgent化（docs/16 §4 Stage 5）。personaKey → {agentId, version} を後段のScenario保存で使う。
    const personaRefs: VersionRef[] = [];
    const pseudoUserRefs: VersionRef[] = [];
    const personaKeyToPseudoUser = new Map<string, { agentId: string; version: SemVer }>();

    for (const personaPlan of plan.personas) {
      this.assertNotAborted(signal);
      const persona = await this.savePersona.execute({
        scope: current.scope,
        internalId: this.makeId(),
        workingName: `${personaPlan.key} (factory draft)`,
        displayName: `${personaPlan.key} persona (Factory)`,
        publishName: makePublishName('persona', personaPlan.key, current.id, personaPlan.key),
        owner: FACTORY_OWNER,
        archetype: personaPlan.archetype,
        knowledgeLevel: personaPlan.knowledgeLevel,
        patience: personaPlan.patience,
        tone: personaPlan.tone,
        verbosity: personaPlan.verbosity,
        language: personaPlan.language,
        ...(personaPlan.extraInstructions !== undefined ? { extraInstructions: personaPlan.extraInstructions } : {}),
      });
      const personaRef: VersionRef = { internalId: persona.metadata.internalId, version: persona.metadata.version.toString() };
      personaRefs.push(personaRef);
      current = await this.event(current, { kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-validation', ref: personaRef });

      const pseudoUserAgent = await this.registerPseudoUser.execute({
        scope: current.scope,
        personaId: persona.metadata.internalId,
        personaVersion: persona.metadata.version,
      });
      const pseudoUserRef: VersionRef = { internalId: pseudoUserAgent.metadata.internalId, version: pseudoUserAgent.metadata.version.toString() };
      pseudoUserRefs.push(pseudoUserRef);
      personaKeyToPseudoUser.set(personaPlan.key, { agentId: pseudoUserAgent.metadata.internalId, version: pseudoUserAgent.metadata.version });
      current = await this.event(current, { kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-validation', ref: pseudoUserRef });
    }

    // Scenario保存。target は生成Agent版、pseudoUser は対応する疑似ユーザーAgent版へSemVer固定（docs/16 §4 Stage 5）。
    const scenarioRefs: VersionRef[] = [];
    for (const scenarioPlan of plan.scenarios) {
      this.assertNotAborted(signal);
      const pseudoUser = personaKeyToPseudoUser.get(scenarioPlan.personaKey);
      if (pseudoUser === undefined) continue; // personaKeyが解決できないScenarioは欠落として除外して続行する。

      const expectedTools = scenarioPlan.expectedToolKeys
        .map((key) => assets.toolKeyToPublishName.get(key))
        .filter((publishName): publishName is string => publishName !== undefined);

      const scenario = await this.saveScenario.execute({
        scope: current.scope,
        internalId: this.makeId(),
        workingName: `${scenarioPlan.key} (factory draft)`,
        displayName: `${scenarioPlan.key} scenario (Factory)`,
        publishName: makePublishName('scenario', scenarioPlan.key, current.id, scenarioPlan.key),
        owner: FACTORY_OWNER,
        target: { agentId: assets.agentRef.internalId, version: SemVer.parse(assets.agentRef.version) },
        pseudoUser,
        goal: scenarioPlan.goal,
        ...(scenarioPlan.context !== undefined ? { context: scenarioPlan.context } : {}),
        maxUserTurns: scenarioPlan.maxUserTurns,
        ...(expectedTools.length > 0 ? { expectedTools } : {}),
        survey: DEFAULT_SURVEY,
      });
      const scenarioRef: VersionRef = { internalId: scenario.metadata.internalId, version: scenario.metadata.version.toString() };
      scenarioRefs.push(scenarioRef);
      current = await this.event(current, { kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-validation', ref: scenarioRef });
    }

    // Scenario集合はRun内で凍結する（docs/16 §4: 以降のイテレーションでScenarioを書き換えない）。
    current = setArtifacts(current, {
      tools: current.artifacts.tools,
      skills: current.artifacts.skills,
      agentVersions: current.artifacts.agentVersions,
      personas: personaRefs,
      pseudoUsers: pseudoUserRefs,
      scenarios: scenarioRefs,
    });
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-validation' });

    const { run: afterIteration1, scenarioRuns } = await this.runValidationIteration(current, assets.agentRef, signal);
    await this.finalizeOrImprove(afterIteration1, scenarioRuns, signal);
  }

  /**
   * 1イテレーション分の検証実行（docs/16 §5）。凍結したScenario集合（`run.artifacts.scenarios`）を
   * `agentRef` に対して1回ずつ実行し、`IterationMetrics` を集計・記録する。`target` を常に明示するため、
   * イテレーション1（初回生成Agent版）・2以降（改訂後の新Agent版）とも同じ経路で再検証できる。
   */
  private async runValidationIteration(run: FactoryRun, agentRef: VersionRef, signal?: AbortSignal): Promise<{ run: FactoryRun; scenarioRuns: readonly ScenarioRun[] }> {
    let current = advanceStage(run, 'validating');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'validating' });

    const scenarioRuns: ScenarioRun[] = [];
    for (const scenarioRef of current.artifacts.scenarios) {
      this.assertNotAborted(signal);
      const scenarioRun = await this.scenarioRunner.execute({
        scope: current.scope,
        scenarioId: scenarioRef.internalId,
        version: SemVer.parse(scenarioRef.version),
        mode: 'test',
        target: { agentId: agentRef.internalId, version: SemVer.parse(agentRef.version) },
      }, signal);
      scenarioRuns.push(scenarioRun);
      current = await this.event(current, { kind: 'scenario_run_completed', at: this.now().toISOString(), stage: 'validating', message: `${scenarioRef.internalId}: ${scenarioRun.status}` });
    }

    const iterationIndex = current.iterations.length + 1;
    const durationMs = scenarioRuns.reduce((sum, scenarioRun) => sum + scenarioRun.metrics.durationMs, 0);
    const metrics = aggregateIterationMetrics({ iteration: iterationIndex, runs: scenarioRuns, durationMs });
    const iteration: FactoryIteration = {
      index: iterationIndex,
      agentVersion: agentRef.version,
      scenarioRunIds: scenarioRuns.map((scenarioRun) => scenarioRun.id),
      metrics,
    };
    current = recordIteration(current, iteration);
    current = updateBudget(current, { ...current.budget.consumed, scenarioRuns: current.budget.consumed.scenarioRuns + scenarioRuns.length });
    await this.runs.save(current);
    current = await this.event(current, { kind: 'iteration_completed', at: this.now().toISOString(), stage: 'validating', iteration: iteration.index });
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'validating' });

    return { run: current, scenarioRuns };
  }

  /**
   * 改善ループ・停止判定・レポート生成（docs/16 §5, M4）。`latestScenarioRuns` は直近イテレーション
   * （`run.iterations` の最後の要素）が検証した `ScenarioRun[]`（Analyst入力のScenario別サマリに使う）。
   * 停止条件（docs/16 §5.2）: (a) 目標達成、(b) 改善停滞（主指標・満足度がともに前イテレーションから改善せず）、
   * (c) 予算・上限到達（`maxIterations` またはbudget消費）。(c) では `budget_exceeded` を記録する。
   * 正常系では必ず succeeded で終わる（例外を投げない）。真の異常のみ呼び出し元のcatchでfailedへ落ちる。
   */
  private async finalizeOrImprove(run: FactoryRun, latestScenarioRuns: readonly ScenarioRun[], signal?: AbortSignal): Promise<void> {
    let current = run;
    let scenarioRuns = latestScenarioRuns;
    let lastSummary: string | undefined;

    for (;;) {
      const latest = current.iterations[current.iterations.length - 1];
      if (latest === undefined) throw new FactoryValidationError('finalizeOrImprove: run has no iterations');
      const previous = current.iterations.length >= 2 ? current.iterations[current.iterations.length - 2] : undefined;

      const targets = current.input.options.targets;
      const targetMet = latest.metrics.goalAchievedRate >= targets.minGoalAchievedRate && latest.metrics.avgSatisfaction >= targets.minAvgSatisfaction;
      const stalled = previous !== undefined
        && latest.metrics.goalAchievedRate <= previous.metrics.goalAchievedRate
        && latest.metrics.avgSatisfaction <= previous.metrics.avgSatisfaction;
      const budget = current.input.options.budget;
      const elapsedMs = this.now().getTime() - new Date(current.startedAt).getTime();
      const limitReached = current.iterations.length >= current.input.options.maxIterations
        || current.budget.consumed.roleCalls >= budget.maxRoleCalls
        || current.budget.consumed.scenarioRuns >= budget.maxScenarioRuns
        || elapsedMs >= budget.maxDurationMs;

      if (targetMet || stalled || limitReached) {
        if (limitReached && !targetMet) {
          current = await this.event(current, { kind: 'budget_exceeded', at: this.now().toISOString(), stage: current.stage, iteration: latest.index });
        }
        break;
      }

      const agentRef: VersionRef = { internalId: this.resolveAgentInternalId(current), version: latest.agentVersion };

      // Analyze（Analystロール）。
      current = advanceStage(current, 'analyzing');
      await this.runs.save(current);
      current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'analyzing' });

      const agent = await this.agents.findVersion(current.scope, agentRef.internalId, SemVer.parse(agentRef.version));
      if (agent === null) throw new FactoryValidationError(`finalizeOrImprove: agent version not found: ${agentRef.internalId}@${agentRef.version}`);
      const currentSkills = await this.loadCurrentSkillContracts(current.scope, agent.skills);
      const currentTools = await this.loadCurrentToolContracts(current.scope, agent.tools);

      const analystResult = await this.analyst.propose({
        goal: current.input.goal,
        metrics: latest.metrics,
        scenarioSummaries: buildScenarioSummaries(scenarioRuns),
        currentAgent: { id: agent.metadata.internalId, systemPrompt: agent.systemPrompt },
        currentSkills,
        currentTools,
      }, signal);
      this.assertNotAborted(signal);
      lastSummary = analystResult.summary;

      current = updateBudget(current, { ...current.budget.consumed, roleCalls: current.budget.consumed.roleCalls + 1 });
      current = attachAnalysisToLastIteration(current, { findings: analystResult.findings, applied: [], rejected: [] });
      await this.runs.save(current);
      current = await this.event(current, { kind: 'analysis_completed', at: this.now().toISOString(), stage: 'analyzing', iteration: latest.index });
      current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'analyzing' });

      // Improve（改訂提案の検証・適用）。
      current = advanceStage(current, 'improving');
      await this.runs.save(current);
      current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'improving' });

      const applyResult = await this.applyImprovements.execute({
        scope: current.scope,
        agentRef,
        proposals: analystResult.proposals,
        maxProposals: budget.maxProposalsPerIteration,
      });

      current = attachAnalysisToLastIteration(current, { findings: analystResult.findings, applied: applyResult.applied, rejected: applyResult.rejected });
      for (const item of applyResult.applied) {
        current = await this.event(current, { kind: 'proposal_applied', at: this.now().toISOString(), stage: 'improving', iteration: latest.index, ref: item.resultingVersion });
      }
      for (const item of applyResult.rejected) {
        current = await this.event(current, { kind: 'proposal_rejected', at: this.now().toISOString(), stage: 'improving', iteration: latest.index, message: item.reason });
      }

      const noChange = applyResult.newAgentRef.internalId === agentRef.internalId && applyResult.newAgentRef.version === agentRef.version;
      if (noChange) {
        await this.runs.save(current);
        current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'improving' });
        break; // 適用できる提案がなかった（全て却下）→ これ以上変化しないため打ち切る。
      }

      current = setArtifacts(current, { ...current.artifacts, agentVersions: [...current.artifacts.agentVersions, applyResult.newAgentRef] });
      await this.runs.save(current);
      current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'improving' });

      const iterationResult = await this.runValidationIteration(current, applyResult.newAgentRef, signal);
      current = iterationResult.run;
      scenarioRuns = iterationResult.scenarioRuns;
    }

    // Report（docs/16 §6）: 最良イテレーション（goalAchievedRate最大、同点はavgSatisfaction最大）を候補にする。
    current = advanceStage(current, 'reporting');
    await this.runs.save(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'reporting' });

    const bestIteration = selectBestIteration(current.iterations);
    const agentInternalId = this.resolveAgentInternalId(current);
    const lastIteration = current.iterations[current.iterations.length - 1];

    const report: FactoryReport = {
      bestIteration: bestIteration.index,
      candidate: { agentId: agentInternalId, version: bestIteration.agentVersion },
      summary: lastSummary ?? defaultSummary(current.iterations),
      openFindings: lastIteration?.analysis?.findings ?? [],
      metricsByIteration: current.iterations.map((iteration) => iteration.metrics),
    };

    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'reporting' });
    current = succeedFactoryRun(current, report, this.now().toISOString());
    await this.runs.save(current);
    current = await this.event(current, { kind: 'run_completed', at: this.now().toISOString(), stage: current.stage });
  }

  private resolveAgentInternalId(run: FactoryRun): string {
    const ref = run.artifacts.agentVersions[0];
    if (ref === undefined) throw new FactoryValidationError('finalizeOrImprove: run has no agent artifact');
    return ref.internalId;
  }

  private async loadCurrentSkillContracts(scope: TenantScope, refs: readonly { readonly internalId: string; readonly version: SemVer }[]): Promise<{ id: string; instructions: string }[]> {
    const results: { id: string; instructions: string }[] = [];
    for (const ref of refs) {
      const skill = await this.skills.findVersion(scope, ref.internalId, ref.version);
      if (skill !== null) results.push({ id: ref.internalId, instructions: skill.instructions });
    }
    return results;
  }

  private async loadCurrentToolContracts(scope: TenantScope, refs: readonly { readonly internalId: string; readonly version: SemVer }[]): Promise<{ id: string; name: string; description: string }[]> {
    const results: { id: string; name: string; description: string }[] = [];
    for (const ref of refs) {
      const tool = await this.tools.findVersion(scope, ref.internalId, ref.version);
      if (tool !== null) results.push({ id: ref.internalId, name: tool.agentTool?.name ?? tool.metadata.publishName, description: tool.agentTool?.description ?? tool.metadata.displayName });
    }
    return results;
  }

  private buildCheckpoint(plan: FactoryPlan, goal: FactoryGoalInput): FactoryPlanCheckpoint {
    const prompt = `Review the proposed plan for "${goal.goal}": agent "${plan.agentBrief.displayName}" with ${plan.tools.length} tool(s), ${plan.skills.length} skill(s), ${plan.personas.length} persona(s), ${plan.scenarios.length} scenario(s).`;
    return { kind: 'plan-approval', expiresAt: new Date(this.now().getTime() + CHECKPOINT_TTL_MS).toISOString(), prompt, plan };
  }

  private async event(run: FactoryRun, event: Omit<FactoryEvent, 'sequence'>): Promise<FactoryRun> {
    const next = appendFactoryEvent(run, event);
    await this.runs.save(next);
    return next;
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw new FactoryValidationError('Factory run aborted');
  }
}

/** Analyst入力用のScenario別サマリを構築する（`q2` = 総合満足度。docs/16 §5.1と同じ規約）。 */
function buildScenarioSummaries(scenarioRuns: readonly ScenarioRun[]): AnalystScenarioSummary[] {
  return scenarioRuns.map((scenarioRun) => {
    const satisfactionAnswer = scenarioRun.survey.find((answer) => answer.questionId === 'q2');
    const toolHitRate = scenarioRun.metrics.expectedToolHit?.hitRate;
    return {
      scenarioId: scenarioRun.scenario.id,
      status: scenarioRun.status,
      goalAchieved: scenarioRun.goalAchieved,
      ...(typeof satisfactionAnswer?.value === 'number' ? { satisfaction: satisfactionAnswer.value } : {}),
      impressions: scenarioRun.impressions,
      ...(toolHitRate !== undefined ? { toolHitRate } : {}),
    };
  });
}

/** goalAchievedRate最大、同点はavgSatisfaction最大のイテレーションを選ぶ（docs/16 §5.2: 最終イテレーションが最良とは限らない）。 */
function selectBestIteration(iterations: readonly FactoryIteration[]): FactoryIteration {
  let best: FactoryIteration | undefined;
  for (const iteration of iterations) {
    if (best === undefined
      || iteration.metrics.goalAchievedRate > best.metrics.goalAchievedRate
      || (iteration.metrics.goalAchievedRate === best.metrics.goalAchievedRate && iteration.metrics.avgSatisfaction > best.metrics.avgSatisfaction)) {
      best = iteration;
    }
  }
  if (best === undefined) throw new FactoryValidationError('finalizeOrImprove: run has no iterations to select a best candidate from');
  return best;
}

/** Analystの総括が一度も得られなかった場合（例: maxIterations到達で分析すら行わなかった）の決定的フォールバック。 */
function defaultSummary(iterations: readonly FactoryIteration[]): string {
  const last = iterations[iterations.length - 1];
  if (last === undefined) return 'Factory run stopped with no iterations.';
  return `Factory run stopped after ${iterations.length} iteration(s); latest goalAchievedRate=${last.metrics.goalAchievedRate.toFixed(2)}, avgSatisfaction=${last.metrics.avgSatisfaction.toFixed(2)}.`;
}

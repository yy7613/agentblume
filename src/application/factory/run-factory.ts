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
 *
 * `input.baseAgent` があるRunは**既存Agent強化モード**で走る（docs/16 §4.1）。ステージ構成は同じで、
 * 読み替えだけが変わる: Stage 0 は起点Agentのロード（+ データソースが0件ならプロファイルは空）、
 * Stage 1 は「不足分だけのギャップ計画」、Stage 4 は新規Agentではなく起点Agentのpatch新版、
 * Stage 5以降は無改修で流用する。新しい `FactoryStage` / `FactoryEventKind` は増やさない。
 */
import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { DEFAULT_SURVEY } from '../../domain/validation/survey';
import {
  advanceStage,
  appendFactoryEvent,
  attachAnalysisToLastIteration,
  beginFactoryRun,
  cancelFactoryRun,
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
  type FactoryRunStatus,
} from '../../domain/factory/factory-run';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import type { VersionRef } from '../../domain/factory/refs';
import { FactoryAbortedError, FactoryValidationError } from '../../domain/factory/errors';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import { describeAbort, throwIfAborted } from './abort';
import { ApplyImprovementsUseCase } from './apply-improvements';
import { FACTORY_OWNER, GenerateAgentAssetsUseCase, makePublishName, type GenerateAgentAssetsResult } from './generate-agent-assets';
import { aggregateIterationMetrics } from './metrics';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';
import { buildExistingToolCatalog } from './tool-catalog';
import { AnalystRole, type AnalystDataSourceSummary, type AnalystScenarioSummary } from './roles/analyst-role';
import { PlannerRole, type PlannerCurrentAgent } from './roles/planner-role';
import type { ScenarioRunnerPort } from './scenario-runner-port';
import type { SavePersonaUseCase } from '../validation/save-persona';
import type { RegisterPseudoUserAgentUseCase } from '../validation/register-pseudo-user-agent';
import type { SaveScenarioUseCase } from '../validation/save-scenario';

/** 計画承認checkpointのTTL（Harness checkpointと同じ24時間・docs/16 §6）。 */
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Stage 2以降で使い回す実行コンテキスト。Stage 0で1度だけ解決し、Stage 5・改善ループへ引き回す
 * （プロファイルの再取得・起点Agentの再ロードを避け、Run内で同じ値を見せるため）。
 */
interface FactoryRunContext {
  readonly profiles: readonly DataProfile[];
  /** 既存Agent強化モードの起点Agent（生成モードでは未設定）。 */
  readonly baseAgent?: Agent;
}

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
  async execute(scope: TenantScope, runId: FactoryRunId, signal?: AbortSignal): Promise<void> {
    const loaded = await this.runs.find(scope, runId);
    if (loaded === null) return;
    if (loaded.status !== 'queued' && loaded.status !== 'running') return;

    let run = loaded;
    try {
      throwIfAborted(signal);
      if (run.status === 'queued') {
        run = beginFactoryRun(run);
        run = advanceStage(run, 'profiling');
        // queued → running だけは queued を期待して書く（この間に cancel されていれば通らず、そのまま中断する）。
        await this.transition(run, ['queued']);

        // Stage 0: 強化モードなら起点Agentを先に解決する（存在しなければRunを失敗させる）。
        // 解決できて初めて「何を強化するRunなのか」をイベントへ残せるため、stage_started より前に行う。
        const baseAgent = await this.loadBaseAgent(scope, run.input.baseAgent);
        run = await this.event(run, {
          kind: 'stage_started', at: this.now().toISOString(), stage: 'profiling',
          ...(baseAgent === undefined ? {} : { message: `enhancing agent ${describeAgent(baseAgent)}` }),
        });
        const profiles = await this.profiler.executeAll(scope, run.input.dataSourceIds, signal);
        throwIfAborted(signal);
        run = await this.event(run, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'profiling' });

        run = advanceStage(run, 'planning');
        await this.persist(run);
        run = await this.event(run, { kind: 'stage_started', at: this.now().toISOString(), stage: 'planning' });
        // 「作成済みのToolで足りるか」をPlannerに考えさせるための再利用候補（docs/16 §4 Stage 1）。
        const existingTools = await buildExistingToolCatalog(this.tools, scope);
        // 強化モードでは「既にAgentが持っている能力」を渡し、不足分だけを計画させる（ギャップ計画）。
        const currentAgent = baseAgent === undefined ? undefined : await this.describeCurrentAgent(scope, baseAgent);
        const plan = await this.planner.propose({
          goal: run.input.goal, profiles, dataSourceIds: run.input.dataSourceIds, options: run.input.options, existingTools,
          ...(currentAgent === undefined ? {} : { currentAgent }),
        }, signal);
        throwIfAborted(signal);

        run = setPlan(run, plan);
        run = updateBudget(run, { ...run.budget.consumed, roleCalls: run.budget.consumed.roleCalls + 1 });
        await this.persist(run);
        run = await this.event(run, { kind: 'plan_proposed', at: this.now().toISOString(), stage: 'planning' });
        run = await this.event(run, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'planning' });

        if (run.input.options.requirePlanApproval) {
          const checkpoint = this.buildCheckpoint(plan, run.input.goal, baseAgent);
          run = waitForPlanApproval(run, checkpoint);
          run = appendFactoryEvent(run, { kind: 'approval_requested', at: this.now().toISOString(), stage: 'planning', message: checkpoint.prompt });
          // running → waiting-approval はイベントごと1回で書く（この時点で cancel 済みなら上書きせず中断する）。
          await this.transition(run, ['running']);
          return;
        }
      }

      // running（`requirePlanApproval:false` での続行、または approve 後の再開）: 生成継続。
      await this.runGeneration(run, signal);
    } catch (error) {
      await this.conclude(scope, runId, error, signal);
    }
  }

  /**
   * 実行が例外で抜けた後の確定処理。running のまま次回起動（`recoverInterruptedRuns`）まで放置しない:
   * 止まったことを知っているのはこのプロセスだけなので、ここで必ず終端へ寄せる。
   *
   * - 中断（signal の abort / `FactoryAbortedError`）: 利用者の cancel なら `CancelFactoryRunUseCase` が既に cancelled を
   *   書いているので触らない。まだ running / queued のまま（worker の shutdown 猶予切れなど）なら cancelled で確定し、
   *   理由（`Cancelled by user` / `Aborted by worker shutdown`）を `run_cancelled` イベントに残す。
   * - それ以外の例外: running のままなら failed で確定する。別経路で確定済みなら触らない。
   *
   * どちらも compare-and-set で書くため、終端同士が上書きし合うことはない。
   */
  private async conclude(scope: TenantScope, runId: FactoryRunId, error: unknown, signal: AbortSignal | undefined): Promise<void> {
    const current = await this.runs.find(scope, runId);
    if (current === null) return;
    const at = this.now().toISOString();

    if (signal?.aborted === true || error instanceof FactoryAbortedError) {
      if (current.status !== 'running' && current.status !== 'queued') return; // cancel 等で確定済み。
      const message = signal?.aborted === true ? describeAbort(signal) : (error instanceof Error ? error.message : 'Factory run aborted');
      let cancelled = cancelFactoryRun(current, at);
      cancelled = appendFactoryEvent(cancelled, { kind: 'run_cancelled', at, stage: current.stage, message });
      await this.runs.saveIfStatus(cancelled, ['queued', 'running']);
      return;
    }

    if (current.status !== 'running') return; // 既に終端/waiting-approvalへ確定済み。
    const reason = error instanceof Error ? error.message : 'Factory run failed';
    let failed = failFactoryRun(current, { stage: current.stage, reason }, at);
    failed = appendFactoryEvent(failed, { kind: 'run_failed', at, stage: current.stage, message: reason });
    await this.runs.saveIfStatus(failed, ['running']);
  }

  /**
   * `waiting-approval` から `revise` された Run を再プロファイル・再計画する。
   * 呼び出し側（`ResumeFactoryRunUseCase`）が `resumeFactoryRun` 適用済みの `running` Runを渡すこと。
   * 戻り値は新しい checkpoint で `waiting-approval` に戻った Run（保存は呼び出し側の責務）。
   */
  async replan(run: FactoryRun, feedback: string | undefined, signal?: AbortSignal): Promise<FactoryRun> {
    let next = run;
    const profiles = await this.profiler.executeAll(next.scope, next.input.dataSourceIds, signal);
    const existingTools = await buildExistingToolCatalog(this.tools, next.scope);
    const baseAgent = await this.loadBaseAgent(next.scope, next.input.baseAgent);
    const currentAgent = baseAgent === undefined ? undefined : await this.describeCurrentAgent(next.scope, baseAgent);
    const plan = await this.planner.propose({
      goal: next.input.goal,
      profiles,
      dataSourceIds: next.input.dataSourceIds,
      options: next.input.options,
      existingTools,
      ...(currentAgent === undefined ? {} : { currentAgent }),
      ...(feedback === undefined ? {} : { feedback }),
    }, signal);
    next = setPlan(next, plan);
    next = updateBudget(next, { ...next.budget.consumed, roleCalls: next.budget.consumed.roleCalls + 1 });
    next = appendFactoryEvent(next, { kind: 'plan_proposed', at: this.now().toISOString(), stage: 'planning', message: 'revised' });
    const checkpoint = this.buildCheckpoint(plan, next.input.goal, baseAgent);
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
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-tools' });

    const profiles = await this.profiler.executeAll(current.scope, current.input.dataSourceIds, signal);
    // 計画の `reuse` を解決する集合。Stage 1でPlannerへ提示したのと同じ規則で組み立て直す
    // （承認待ちを挟んだ再開でも、その時点で有効な既存Toolだけを参照する）。
    const existingTools = await buildExistingToolCatalog(this.tools, current.scope);
    // 承認を挟んだ再開でも起点Agentを解決し直す（承認待ちの間に版が進んでいれば、指定が無い限り最新版を使う）。
    const baseAgent = await this.loadBaseAgent(current.scope, current.input.baseAgent);
    const context: FactoryRunContext = { profiles, ...(baseAgent === undefined ? {} : { baseAgent }) };
    throwIfAborted(signal);

    // `onEvent` は generateAgentAssets 内の逐次awaitの合間に同期的に呼ばれる。永続化(save)は非同期のため、
    // 発生順を保証する直列プロミスチェーンへ積み、execute() 完了後にまとめてflushする。
    // 保存は compare-and-set（running 期待）: cancel 済みなら失敗してチェーンごと止まり、遅れて流れてきた
    // イベントが cancelled を running へ戻すことはない。
    let chain: Promise<void> = Promise.resolve();
    const onEvent = (event: Omit<FactoryEvent, 'sequence'>): void => {
      chain = chain.then(async () => {
        current = appendFactoryEvent(current, event);
        await this.persist(current);
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
      ...(baseAgent === undefined ? {} : { baseAgent }),
      // 強化モードでのsystemPromptの扱い（生成モードでは無視される）。
      promptStrategy: current.input.options.promptStrategy,
      onEvent,
      ...(signal === undefined ? {} : { signal }),
      // execute() が例外で抜けても積んだ保存を必ず待ち切る（保存順序を崩さない・未処理の rejection を残さない）。
      // チェーン側が cancel を検出して失敗していれば、その中断が優先して伝わる。
    }).finally(() => chain);
    throwIfAborted(signal);

    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-tools' });

    current = advanceStage(current, 'generating-skills');
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-skills' });
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-skills' });

    current = advanceStage(current, 'assembling-agent');
    await this.persist(current);
    current = await this.event(current, {
      kind: 'stage_started', at: this.now().toISOString(), stage: 'assembling-agent',
      // 強化モードは「新規Agentを作らない」ことがイベントから読み取れるようにする（新しいkindは足さない）。
      ...(baseAgent === undefined
        ? {}
        : { message: assets.agentChanged ? `enhanced existing agent ${assets.agentRef.internalId}@${assets.agentRef.version}` : `existing agent ${assets.agentRef.internalId}@${assets.agentRef.version} kept as-is (no capability added)` }),
    });

    current = setArtifacts(current, {
      tools: assets.toolRefs,
      skills: assets.skillRefs,
      agentVersions: [assets.agentRef],
      personas: current.artifacts.personas,
      pseudoUsers: current.artifacts.pseudoUsers,
      scenarios: current.artifacts.scenarios,
    });
    current = updateBudget(current, { ...current.budget.consumed, roleCalls: current.budget.consumed.roleCalls + assets.roleCallsUsed });
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'assembling-agent' });

    await this.runValidationAndImprove(current, assets, context, signal);
  }

  /**
   * Stage 5（検証資産の決定的マテリアライズ）+ イテレーション1の検証実行。ScenarioDesignerロールは導入せず、
   * Stage 1 Plannerの `plan.personas`/`plan.scenarios` をそのままSave系ユースケースへ渡す
   * （docs/16 §4 Stage 5: 決定的マテリアライズ、新規LLM呼び出しなし）。
   * 完了後は改善ループ・レポート（`finalizeOrImprove`）へ委譲する。
   */
  private async runValidationAndImprove(run: FactoryRun, assets: GenerateAgentAssetsResult, context: FactoryRunContext, signal?: AbortSignal): Promise<void> {
    const plan = run.plan;
    if (plan === undefined) throw new FactoryValidationError('runValidationAndImprove: run has no plan');

    let current = advanceStage(run, 'generating-validation');
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'generating-validation' });

    // Persona → 疑似ユーザーAgent化（docs/16 §4 Stage 5）。personaKey → {agentId, version} を後段のScenario保存で使う。
    const personaRefs: VersionRef[] = [];
    const pseudoUserRefs: VersionRef[] = [];
    const personaKeyToPseudoUser = new Map<string, { agentId: string; version: SemVer }>();

    for (const personaPlan of plan.personas) {
      throwIfAborted(signal);
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
      throwIfAborted(signal);
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
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'generating-validation' });

    const { run: afterIteration1, scenarioRuns } = await this.runValidationIteration(current, assets.agentRef, signal);
    await this.finalizeOrImprove(afterIteration1, scenarioRuns, context, signal);
  }

  /**
   * 1イテレーション分の検証実行（docs/16 §5）。凍結したScenario集合（`run.artifacts.scenarios`）を
   * `agentRef` に対して1回ずつ実行し、`IterationMetrics` を集計・記録する。`target` を常に明示するため、
   * イテレーション1（初回生成Agent版）・2以降（改訂後の新Agent版）とも同じ経路で再検証できる。
   */
  private async runValidationIteration(run: FactoryRun, agentRef: VersionRef, signal?: AbortSignal): Promise<{ run: FactoryRun; scenarioRuns: readonly ScenarioRun[] }> {
    let current = advanceStage(run, 'validating');
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'validating' });

    const scenarioRuns: ScenarioRun[] = [];
    for (const scenarioRef of current.artifacts.scenarios) {
      throwIfAborted(signal);
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
    await this.persist(current);
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
  private async finalizeOrImprove(run: FactoryRun, latestScenarioRuns: readonly ScenarioRun[], context: FactoryRunContext, signal?: AbortSignal): Promise<void> {
    let current = run;
    let scenarioRuns = latestScenarioRuns;
    let lastSummary: string | undefined;
    // Analystの `add-tool` 提案はこの一覧に載っているデータソースだけを対象にできる（未指定なら提案させない）。
    // 生成モード・強化モードとも Stage 0 のプロファイルをそのまま要約して渡す。
    const availableDataSources = toAnalystDataSources(context.profiles);

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
      await this.persist(current);
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
        ...(availableDataSources.length === 0 ? {} : { availableDataSources }),
      }, signal);
      throwIfAborted(signal);
      lastSummary = analystResult.summary;

      current = updateBudget(current, { ...current.budget.consumed, roleCalls: current.budget.consumed.roleCalls + 1 });
      current = attachAnalysisToLastIteration(current, { findings: analystResult.findings, applied: [], rejected: [] });
      await this.persist(current);
      current = await this.event(current, { kind: 'analysis_completed', at: this.now().toISOString(), stage: 'analyzing', iteration: latest.index });
      current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'analyzing' });

      // Improve（改訂提案の検証・適用）。
      current = advanceStage(current, 'improving');
      await this.persist(current);
      current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'improving' });

      const applyResult = await this.applyImprovements.execute({
        scope: current.scope,
        agentRef,
        proposals: analystResult.proposals,
        maxProposals: budget.maxProposalsPerIteration,
        // `add-tool` のToolSmith再提案回数はRunの予算に従わせる（適用側の既定値へ落とさない）。
        maxRepairAttempts: budget.maxRepairAttempts,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);

      current = attachAnalysisToLastIteration(current, { findings: analystResult.findings, applied: applyResult.applied, rejected: applyResult.rejected });
      for (const item of applyResult.applied) {
        current = await this.event(current, { kind: 'proposal_applied', at: this.now().toISOString(), stage: 'improving', iteration: latest.index, ref: item.resultingVersion });
      }
      for (const item of applyResult.rejected) {
        current = await this.event(current, { kind: 'proposal_rejected', at: this.now().toISOString(), stage: 'improving', iteration: latest.index, message: item.reason });
      }

      const noChange = applyResult.newAgentRef.internalId === agentRef.internalId && applyResult.newAgentRef.version === agentRef.version;
      if (noChange) {
        await this.persist(current);
        current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'improving' });
        break; // 適用できる提案がなかった（全て却下）→ これ以上変化しないため打ち切る。
      }

      current = setArtifacts(current, { ...current.artifacts, agentVersions: [...current.artifacts.agentVersions, applyResult.newAgentRef] });
      await this.persist(current);
      current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'improving' });

      const iterationResult = await this.runValidationIteration(current, applyResult.newAgentRef, signal);
      current = iterationResult.run;
      scenarioRuns = iterationResult.scenarioRuns;
    }

    // Report（docs/16 §6）: 最良イテレーション（goalAchievedRate最大、同点はavgSatisfaction最大）を候補にする。
    current = advanceStage(current, 'reporting');
    await this.persist(current);
    current = await this.event(current, { kind: 'stage_started', at: this.now().toISOString(), stage: 'reporting' });

    const bestIteration = selectBestIteration(current.iterations);
    const agentInternalId = this.resolveAgentInternalId(current);
    const lastIteration = current.iterations[current.iterations.length - 1];

    // 強化モードであることをレポートからも読み取れるようにする（UIはsummaryをそのまま表示する）。
    const summary = lastSummary ?? defaultSummary(current.iterations);
    const report: FactoryReport = {
      bestIteration: bestIteration.index,
      candidate: { agentId: agentInternalId, version: bestIteration.agentVersion },
      summary: context.baseAgent === undefined ? summary : `Enhanced existing agent ${describeAgent(context.baseAgent)}. ${summary}`,
      openFindings: lastIteration?.analysis?.findings ?? [],
      metricsByIteration: current.iterations.map((iteration) => iteration.metrics),
    };

    current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'reporting' });
    current = succeedFactoryRun(current, report, this.now().toISOString());
    current = appendFactoryEvent(current, { kind: 'run_completed', at: this.now().toISOString(), stage: current.stage });
    // running → succeeded は完了イベントごと1回で書く（この時点で cancel 済みなら終端を上書きしない）。
    await this.transition(current, ['running']);
  }

  private resolveAgentInternalId(run: FactoryRun): string {
    const ref = run.artifacts.agentVersions[0];
    if (ref === undefined) throw new FactoryValidationError('finalizeOrImprove: run has no agent artifact');
    return ref.internalId;
  }

  /**
   * 既存Agent強化モードの起点Agentを解決する（`baseAgent` 未指定なら生成モードとして `undefined`）。
   * `version` 省略時は最新版。存在しない・強化対象にできない種別のAgentは `FactoryValidationError` で
   * Runを失敗させる（黙って0→1生成へフォールバックしない）。
   */
  private async loadBaseAgent(scope: TenantScope, ref: FactoryRun['input']['baseAgent']): Promise<Agent | undefined> {
    if (ref === undefined) return undefined;
    const label = `${ref.internalId}${ref.version === undefined ? '' : `@${ref.version}`}`;
    let agent: Agent | null;
    try {
      agent = ref.version === undefined
        ? await this.agents.findLatest(scope, ref.internalId)
        : await this.agents.findVersion(scope, ref.internalId, SemVer.parse(ref.version));
    } catch (error) {
      throw new FactoryValidationError(`base agent could not be loaded: ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (agent === null) throw new FactoryValidationError(`base agent not found: ${label}`);
    // 疑似ユーザー/評価者Agentは能力（Tool/Skill）を持てない・持たせる意味がないため強化対象にしない。
    if (agent.kind !== 'normal') throw new FactoryValidationError(`base agent must be a normal agent, got kind '${agent.kind}': ${label}`);
    return agent;
  }

  /** Plannerへ渡す「既存Agentが今できること」。Tool/Skillの実体を読んで契約だけを要約する。 */
  private async describeCurrentAgent(scope: TenantScope, agent: Agent): Promise<PlannerCurrentAgent> {
    const tools: { publishName: string; description: string }[] = [];
    for (const ref of agent.tools) {
      const tool = await this.tools.findVersion(scope, ref.internalId, ref.version);
      if (tool !== null) {
        tools.push({
          publishName: tool.agentTool?.name ?? tool.metadata.publishName,
          description: tool.agentTool?.description ?? tool.metadata.displayName,
        });
      }
    }
    const skills: { displayName: string; responsibility: string }[] = [];
    for (const ref of agent.skills) {
      const skill = await this.skills.findVersion(scope, ref.internalId, ref.version);
      if (skill !== null) skills.push({ displayName: skill.metadata.displayName, responsibility: skill.responsibility });
    }
    return { displayName: agent.metadata.displayName, systemPrompt: agent.systemPrompt, tools, skills };
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

  private buildCheckpoint(plan: FactoryPlan, goal: FactoryGoalInput, baseAgent?: Agent): FactoryPlanCheckpoint {
    const prompt = baseAgent === undefined
      ? `Review the proposed plan for "${goal.goal}": agent "${plan.agentBrief.displayName}" with ${plan.tools.length} tool(s), ${plan.skills.length} skill(s), ${plan.personas.length} persona(s), ${plan.scenarios.length} scenario(s).`
      : `Review the proposed enhancement for "${goal.goal}": add ${plan.tools.length} tool(s) and ${plan.skills.length} skill(s) to the existing agent "${baseAgent.metadata.displayName}" (${describeAgent(baseAgent)}), then validate it with ${plan.scenarios.length} scenario(s) across ${plan.personas.length} persona(s).`;
    return { kind: 'plan-approval', expiresAt: new Date(this.now().getTime() + CHECKPOINT_TTL_MS).toISOString(), prompt, plan };
  }

  private async event(run: FactoryRun, event: Omit<FactoryEvent, 'sequence'>): Promise<FactoryRun> {
    const next = appendFactoryEvent(run, event);
    await this.persist(next);
    return next;
  }

  /** running 中の進捗保存（イベント追記・stage 更新）。保存済みが running でなくなっていれば中断する。 */
  private persist(run: FactoryRun): Promise<void> {
    return this.transition(run, ['running']);
  }

  /**
   * compare-and-set で保存する。保存済みの status が `expected` に無ければ、その間に別経路（利用者の cancel）が
   * 記録を確定させているので、上書きせず `FactoryAbortedError` で実行を打ち切る（`conclude` が何も書かずに終える）。
   */
  private async transition(run: FactoryRun, expected: readonly FactoryRunStatus[]): Promise<void> {
    if (await this.runs.saveIfStatus(run, expected)) return;
    const stored = await this.runs.find(run.scope, run.id);
    throw new FactoryAbortedError(`Factory run '${run.id}' is ${stored === null ? 'gone' : stored.status}; execution stopped without overwriting it`);
  }
}

/** Runのイベント・レポートで既存Agentを一意に示すラベル。 */
function describeAgent(agent: Agent): string {
  return `${agent.metadata.displayName}@${agent.metadata.version.toString()}`;
}

/**
 * Stage 0 の `DataProfile[]` を Analyst の `availableDataSources` へ要約する（dataSourceId + 列名程度）。
 * これを渡さないとAnalystは `add-tool` を一切提案しない（`isValidTarget` でも破棄される）。
 */
function toAnalystDataSources(profiles: readonly DataProfile[]): AnalystDataSourceSummary[] {
  return profiles.map((profile) => ({
    dataSourceId: profile.dataSourceId,
    name: profile.name,
    ...(profile.format === undefined ? {} : { format: profile.format }),
    columns: profile.columns.map((column) => `${column.name}:${column.type}`),
  }));
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

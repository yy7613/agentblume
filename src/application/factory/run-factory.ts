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
import type { RunRepository } from '../../domain/run/run-repository';
import type { RunTraceEvent } from '../../domain/run/run';
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
  type FactoryReportQuality,
  type FactoryRun,
  type FactoryRunStatus,
  type IterationMetrics,
} from '../../domain/factory/factory-run';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import type { VersionRef } from '../../domain/factory/refs';
import { FactoryAbortedError, FactoryValidationError } from '../../domain/factory/errors';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import { applicableTemplates } from '../../domain/tool-template/instantiate';
import type { ToolTemplate } from '../../domain/tool-template/template';
import type { ToolTemplateCatalogPort } from '../tool-template/catalog-port';
import { templateContextOf } from '../tool-template/template-context';
import { describeAbort, throwIfAborted } from './abort';
import { ApplyImprovementsUseCase } from './apply-improvements';
import { MAX_TOOL_CALLS } from '../agent/run-agent-preview';
import { FACTORY_OWNER, GenerateAgentAssetsUseCase, makePublishName, type GenerateAgentAssetsResult } from './generate-agent-assets';
import { aggregateIterationMetrics } from './metrics';
import { ProfileDataSourcesUseCase, type DataProfile } from './profile-data-sources';
import { composeScenarioContext, describeScenarioGrounding } from './scenario-grounding';
import { buildExistingToolCatalog } from './tool-catalog';
import { AnalystRole, EMPTY_PROPOSALS_FEEDBACK, type AnalystDataSourceSummary, type AnalystScenarioSummary, type AnalystToolCallSummary } from './roles/analyst-role';
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
    /**
     * Agent Run のトレース置き場（`ScenarioRun.transcript[].runId` の参照先）。Analystへ「実際に
     * 呼ばれたTool・その引数・返ってきた行数」を渡すためだけに読む（ADR-0047）。未注入の配線では
     * Analyst入力がツール呼び出しの詳細を欠くだけで、Run自体は従来どおり動く。
     */
    private readonly agentRuns?: RunRepository,
    /**
     * ツールテンプレートの置き場所（v43 / ADR-0049）。Stage 1 の Planner へ「このデータで使える
     * テンプレート」を材料として渡すためだけに読む。未注入なら従来どおり（Planner の材料が
     * 1 項目少ないだけで、Run は同じように動く）。
     */
    private readonly toolTemplates?: ToolTemplateCatalogPort,
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
        const templates = await this.describeApplicableTemplates(profiles, run.input.goal.language);
        const plan = await this.planner.propose({
          goal: run.input.goal, profiles, dataSourceIds: run.input.dataSourceIds, options: run.input.options, existingTools,
          ...(templates.length === 0 ? {} : { templates }),
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
    const templates = await this.describeApplicableTemplates(profiles, next.input.goal.language);
    const plan = await this.planner.propose({
      goal: next.input.goal,
      profiles,
      dataSourceIds: next.input.dataSourceIds,
      options: next.input.options,
      existingTools,
      ...(templates.length === 0 ? {} : { templates }),
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
   * このRunのデータで使えるツールテンプレートの `id` と要約（Stage 1 の Planner への材料。v43 §4）。
   *
   * 適用判定は**決定的で小さく**保つ: ソースの組み合わせを全通り試すのではなく、
   * 「1 ソースずつ」「結合候補が挙げた 2 件」「結合できるソースの先頭 3 件」だけを見る
   * （テンプレートは 1〜3 ソースのものしか同梱していない）。読めない置き場所は付加情報なので
   * 黙って空にする — テンプレートが無くても計画は従来どおり立てられる。
   */
  private async describeApplicableTemplates(
    profiles: readonly DataProfile[],
    language: 'ja' | 'en',
  ): Promise<{ readonly id: string; readonly summary: string }[]> {
    const catalog = this.toolTemplates;
    if (catalog === undefined || profiles.length === 0) return [];
    let templates: readonly ToolTemplate[];
    try {
      templates = (await catalog.list()).templates;
    } catch {
      return [];
    }
    if (templates.length === 0) return [];
    const found = new Map<string, ToolTemplate>();
    for (const dataSourceIds of candidateSourceSets(profiles)) {
      for (const template of applicableTemplates(templates, templateContextOf({ dataSourceIds }, profiles))) {
        if (!found.has(template.id)) found.set(template.id, template);
      }
    }
    return [...found.values()].map((template) => ({ id: template.id, summary: template.summary[language] }));
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
      // 新規Toolの作り方（段階的生成 / 従来の一括生成）。段階的が失敗したら自動で一括へ落ちる。
      toolGeneration: current.input.options.toolGeneration,
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
    // `context` には Stage 0 のプロファイルから作った「検証の前提」を決定的に足す（v44 / ADR-0050）。
    // 実測では、相手が何のデータを持つかを知らされていない擬似ユーザーが、自分で作った数値を渡して
    // エージェントを電卓として使おうとし、正しく動いている構成が `below-targets` になっていた。
    const scenarioLanguage = current.input.goal.language === 'en' ? 'en' : 'ja';
    const scenarioRefs: VersionRef[] = [];
    for (const scenarioPlan of plan.scenarios) {
      throwIfAborted(signal);
      const pseudoUser = personaKeyToPseudoUser.get(scenarioPlan.personaKey);
      if (pseudoUser === undefined) continue; // personaKeyが解決できないScenarioは欠落として除外して続行する。

      const expectedTools = scenarioPlan.expectedToolKeys
        .map((key) => assets.toolKeyToToolName.get(key))
        .filter((publishName): publishName is string => publishName !== undefined);

      const scenarioContext = composeScenarioContext(
        scenarioPlan.context,
        describeScenarioGrounding({ plan, scenario: scenarioPlan, profiles: context.profiles, language: scenarioLanguage }),
      );

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
        ...(scenarioContext !== undefined ? { context: scenarioContext } : {}),
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
    /** 直前に分析したイテレーションで観測された失敗の段（新しい壊れ方の検出に使う）。 */
    let previousErrorStages: ReadonlySet<string> | undefined;
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

      // 前イテレーションからの悪化は決定的に列挙して渡す（Analystに数字の比較をさせない・ADR-0047 round 2）。
      const latestErrorStages = errorStagesOf(scenarioRuns);
      const regressions = describeRegressions(
        { metrics: latest.metrics, errorStages: latestErrorStages },
        previous === undefined || previousErrorStages === undefined ? undefined : { metrics: previous.metrics, errorStages: previousErrorStages },
      );
      const analystInput = {
        goal: current.input.goal,
        metrics: latest.metrics,
        scenarioSummaries: await buildScenarioSummaries(scenarioRuns, this.agentRuns, current.scope),
        currentAgent: { id: agent.metadata.internalId, systemPrompt: agent.systemPrompt },
        currentSkills,
        currentTools,
        // 「対象ごとに1回ずつ呼ぶ」設計を提案させないため、会話あたりのツール呼び出し上限を渡す。
        toolCallBudget: MAX_TOOL_CALLS,
        ...(regressions.length === 0 ? {} : { regressions }),
        ...(availableDataSources.length === 0 ? {} : { availableDataSources }),
      };
      previousErrorStages = latestErrorStages;
      let analystResult = await this.analyst.propose(analystInput, signal);
      throwIfAborted(signal);
      let analystCalls = 1;

      // 「改訂すると書きながら proposals が空」はロールの失敗（ADR-0047）。黙ってループを終わらせず、
      // 明示的な差し戻し文言で1回だけ再依頼する（予算 `maxRoleCalls` に余裕があるときだけ）。
      if (analystResult.proposals.length === 0 && current.budget.consumed.roleCalls + analystCalls < budget.maxRoleCalls) {
        analystResult = await this.analyst.propose({ ...analystInput, feedback: EMPTY_PROPOSALS_FEEDBACK }, signal);
        throwIfAborted(signal);
        analystCalls += 1;
      }
      lastSummary = analystResult.summary;

      current = updateBudget(current, { ...current.budget.consumed, roleCalls: current.budget.consumed.roleCalls + analystCalls });
      current = attachAnalysisToLastIteration(current, { findings: analystResult.findings, applied: [], rejected: [] });
      await this.persist(current);
      current = await this.event(current, { kind: 'analysis_completed', at: this.now().toISOString(), stage: 'analyzing', iteration: latest.index });
      current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'analyzing' });

      // 再依頼しても提案が0件 = 改善ループはこれ以上進めない。理由を必ずイベントへ残してから抜ける
      // （黙って break すると「maxIterations 2 なのに1回で終わった」理由がRunのどこにも残らない）。
      if (analystResult.proposals.length === 0) {
        current = await this.event(current, {
          kind: 'proposal_rejected', at: this.now().toISOString(), stage: 'analyzing', iteration: latest.index,
          message: `${LOOP_STOPPED_NO_PROPOSALS}: the analyst returned no proposals${analystCalls > 1 ? ' even after an explicit re-ask' : ''}, so the improvement loop stopped after iteration ${latest.index}`,
        });
        break;
      }

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
        // 提案はあったが1件も適用できなかった（全て却下）→ これ以上変化しないため打ち切る。理由を残す。
        current = await this.event(current, {
          kind: 'proposal_rejected', at: this.now().toISOString(), stage: 'improving', iteration: latest.index,
          message: `${LOOP_STOPPED_NO_APPLIED_PROPOSALS}: all ${analystResult.proposals.length} proposal(s) were rejected, so the improvement loop stopped after iteration ${latest.index}`,
        });
        current = await this.event(current, { kind: 'stage_completed', at: this.now().toISOString(), stage: 'improving' });
        break;
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
    // Runのstatusは「パイプラインが最後まで走ったか」でしかない。成果物が目標を満たしたかは
    // メトリクス vs targets から決定的に判定して別に載せる（ADR-0047）。
    const verdict = assessReportQuality(bestIteration.metrics, current.input.options.targets);
    const report: FactoryReport = {
      bestIteration: bestIteration.index,
      candidate: { agentId: agentInternalId, version: bestIteration.agentVersion },
      summary: context.baseAgent === undefined ? summary : `Enhanced existing agent ${describeAgent(context.baseAgent)}. ${summary}`,
      openFindings: lastIteration?.analysis?.findings ?? [],
      metricsByIteration: current.iterations.map((iteration) => iteration.metrics),
      quality: verdict.quality,
      qualityReasons: verdict.reasons,
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
 * テンプレートの適用可否を数える「ソースの組み」（決定的・小さい）。
 *
 * 単一ソースのテンプレートはソースごとに、複数ソースのテンプレートは**結合候補が実際に挙げた**
 * 組み合わせでだけ判定する（総当たりにすると組み合わせ爆発するうえ、結べないソースの組で
 * 「使える」と言ってしまう）。
 */
export function candidateSourceSets(profiles: readonly DataProfile[]): string[][] {
  const ids = new Set(profiles.map((profile) => profile.dataSourceId));
  const sets: string[][] = profiles.map((profile) => [profile.dataSourceId]);
  const joinable: string[] = [];
  for (const candidate of profiles[0]?.joinCandidates ?? []) {
    if (!ids.has(candidate.leftDataSourceId) || !ids.has(candidate.rightDataSourceId)) continue;
    sets.push([candidate.leftDataSourceId, candidate.rightDataSourceId]);
    for (const id of [candidate.leftDataSourceId, candidate.rightDataSourceId]) {
      if (!joinable.includes(id)) joinable.push(id);
    }
  }
  if (joinable.length >= 3) sets.push(joinable.slice(0, 3));
  return sets;
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

/** 数字（半角・全角）を含む回答か。「0行なのに数字で答えた」の判定に使う。 */
function containsNumber(text: string): boolean {
  return /[0-9０-９]/.test(text);
}

/**
 * Agent Run のトレース1本を Analyst 用のツール呼び出し要約へ畳む。
 *
 * トレースは**防御的に**読む: `tool-result` の `nodes[].rowCount` も、別途追加されつつある `noMatch`
 * 要約も、古いRunには無い（形が違えば黙って落とす）。
 */
function summarizeTrace(trace: readonly RunTraceEvent[]): { calls: AnalystToolCallSummary[]; zeroRowThenNumericAnswer: boolean } {
  const calls: AnalystToolCallSummary[] = [];
  let pendingZeroRows = false;
  let zeroRowThenNumericAnswer = false;
  for (const event of trace) {
    if (event.kind === 'tool-call') {
      calls.push({ name: event.name, arguments: { ...event.arguments } });
      continue;
    }
    if (event.kind === 'tool-result') {
      const last = calls[calls.length - 1];
      const nodes = Array.isArray(event.nodes) ? event.nodes : [];
      const terminal = nodes[nodes.length - 1];
      const rowCount = typeof terminal?.rowCount === 'number' ? terminal.rowCount : undefined;
      const noMatch = (event as { noMatch?: unknown }).noMatch;
      const noMatchSummary = noMatch !== null && typeof noMatch === 'object' && !Array.isArray(noMatch)
        ? { ...(noMatch as Record<string, unknown>) }
        : undefined;
      if (last !== undefined && last.name === event.name && last.rowCount === undefined && last.error === undefined) {
        calls[calls.length - 1] = {
          ...last,
          ...(rowCount === undefined ? {} : { rowCount }),
          ...(noMatchSummary === undefined ? {} : { noMatch: noMatchSummary }),
        };
      }
      if (rowCount === 0 || noMatchSummary !== undefined) pendingZeroRows = true;
      continue;
    }
    if (event.kind === 'error') {
      const last = calls[calls.length - 1];
      if (last !== undefined && last.error === undefined) calls[calls.length - 1] = { ...last, error: event.message };
      continue;
    }
    if (event.kind === 'model-response') {
      if (pendingZeroRows && containsNumber(event.content)) zeroRowThenNumericAnswer = true;
      continue;
    }
  }
  return { calls, zeroRowThenNumericAnswer };
}

/**
 * Analyst入力用のScenario別サマリを構築する（`q2` = 総合満足度。docs/16 §5.1と同じ規約）。
 *
 * ADR-0047: status/goalAchieved/感想だけでは、Analystは「なぜ失敗したか」を推測するしかなく、
 * 実測では毎回「Toolを呼んでいない → プロンプトを簡素化」という誤診に落ちた。失敗した段・期待Tool名と
 * 実呼び出し名・ツールへ渡した引数と返った行数・アンケート欠測までを載せる。
 */
async function buildScenarioSummaries(scenarioRuns: readonly ScenarioRun[], runs: RunRepository | undefined, scope: TenantScope): Promise<AnalystScenarioSummary[]> {
  const summaries: AnalystScenarioSummary[] = [];
  for (const scenarioRun of scenarioRuns) {
    const satisfactionAnswer = scenarioRun.survey.find((answer) => answer.questionId === 'q2');
    const toolHitRate = scenarioRun.metrics.expectedToolHit?.hitRate;

    const toolCalls: AnalystToolCallSummary[] = [];
    let zeroRowThenNumericAnswer = false;
    if (runs !== undefined) {
      for (const turn of scenarioRun.transcript) {
        if (turn.runId === undefined) continue;
        let record: Awaited<ReturnType<RunRepository['find']>> = null;
        try {
          record = await runs.find(scope, turn.runId);
        } catch {
          record = null; // トレースが読めないことで分析全体を落とさない（分析は補助情報）。
        }
        if (record === null || !Array.isArray(record.trace)) continue;
        const summarized = summarizeTrace(record.trace);
        toolCalls.push(...summarized.calls);
        zeroRowThenNumericAnswer = zeroRowThenNumericAnswer || summarized.zeroRowThenNumericAnswer;
      }
    }

    summaries.push({
      scenarioId: scenarioRun.scenario.id,
      status: scenarioRun.status,
      goalAchieved: scenarioRun.goalAchieved,
      ...(typeof satisfactionAnswer?.value === 'number' ? { satisfaction: satisfactionAnswer.value } : {}),
      impressions: scenarioRun.impressions,
      ...(toolHitRate !== undefined ? { toolHitRate } : {}),
      ...(scenarioRun.metrics.expectedToolHit === undefined
        ? {}
        : { expectedTools: [...scenarioRun.metrics.expectedToolHit.expected], calledTools: [...scenarioRun.metrics.expectedToolHit.called] }),
      ...(scenarioRun.error === undefined ? {} : { errorStage: scenarioRun.error.stage, errorMessage: scenarioRun.error.message }),
      surveyCollected: typeof satisfactionAnswer?.value === 'number',
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(zeroRowThenNumericAnswer ? { answeredWithNumbersAfterZeroRows: true } : {}),
    });
  }
  return summaries;
}

/**
 * 最良イテレーションの選択規則（docs/16 §5.2。最終イテレーションが最良とは限らない）。
 *
 * 優先順に **goalAchievedRate 大 → errorRate 小 → avgSatisfaction 大 → index 小**。
 * `errorRate` を満足度より先に見るのは、会話が落ちたイテレーションは「観測できていない」のであって
 * 「満足度が高い」わけではないため（実測では改訂後に1件が `agent` 段で落ち、主指標が 0.5→0 になった）。
 * 同点なら早いイテレーションを採る（同じ成績なら改訂の少ない版の方が安全）。
 */
export function selectBestIteration(iterations: readonly FactoryIteration[]): FactoryIteration {
  let best: FactoryIteration | undefined;
  for (const iteration of iterations) {
    if (best === undefined || comparesBetter(iteration.metrics, best.metrics)) best = iteration;
  }
  if (best === undefined) throw new FactoryValidationError('finalizeOrImprove: run has no iterations to select a best candidate from');
  return best;
}

/** `candidate` が `incumbent` より良いか（同点は false = 先に見たイテレーションを残す）。 */
function comparesBetter(candidate: IterationMetrics, incumbent: IterationMetrics): boolean {
  if (candidate.goalAchievedRate !== incumbent.goalAchievedRate) return candidate.goalAchievedRate > incumbent.goalAchievedRate;
  if (candidate.errorRate !== incumbent.errorRate) return candidate.errorRate < incumbent.errorRate;
  return candidate.avgSatisfaction > incumbent.avgSatisfaction;
}

/**
 * 前イテレーションからの悪化を決定的に列挙する（ADR-0047 round 2）。
 *
 * Analystは「良くなった/悪くなった」を数字の羅列から読み取れず、実測では主指標が半減したうえに
 * 会話が1件落ちたイテレーションで findings を0件返した。悪化は**事実として**渡す。
 * `errorStages` は各イテレーションで観測された `ScenarioRun.error.stage` の集合で、
 * 新しく現れた段は「前は起きていなかった壊れ方」なので必ず挙げる。
 */
export function describeRegressions(
  latest: { readonly metrics: IterationMetrics; readonly errorStages: ReadonlySet<string> },
  previous: { readonly metrics: IterationMetrics; readonly errorStages: ReadonlySet<string> } | undefined,
): string[] {
  if (previous === undefined) return [];
  const regressions: string[] = [];
  const dropped = (name: string, now: number, before: number): void => {
    if (now < before) regressions.push(`${name} fell from ${before.toFixed(2)} to ${now.toFixed(2)} since the previous iteration`);
  };
  const rose = (name: string, now: number, before: number): void => {
    if (now > before) regressions.push(`${name} rose from ${before.toFixed(2)} to ${now.toFixed(2)} since the previous iteration`);
  };
  dropped('goalAchievedRate', latest.metrics.goalAchievedRate, previous.metrics.goalAchievedRate);
  dropped('avgSatisfaction', latest.metrics.avgSatisfaction, previous.metrics.avgSatisfaction);
  dropped('toolHitRate', latest.metrics.toolHitRate, previous.metrics.toolHitRate);
  rose('errorRate', latest.metrics.errorRate, previous.metrics.errorRate);
  rose('surveyMissingCount', latest.metrics.surveyMissingCount, previous.metrics.surveyMissingCount);
  for (const stage of latest.errorStages) {
    if (previous.errorStages.has(stage)) continue;
    regressions.push(`scenarios now fail at the '${stage}' stage, which did not happen in the previous iteration`);
  }
  return regressions;
}

/** 1イテレーションで観測された失敗の段の集合（`ScenarioRun.error.stage`）。 */
function errorStagesOf(runs: readonly ScenarioRun[]): Set<string> {
  const stages = new Set<string>();
  for (const run of runs) {
    if (run.error !== undefined) stages.add(run.error.stage);
  }
  return stages;
}

/** 改善ループが「提案0件」で止まったことを示すイベント文言の接頭辞（テストとUIが同じ語で照合できるようにする）。 */
export const LOOP_STOPPED_NO_PROPOSALS = 'no_proposals';
/** 提案はあったが1件も適用できずに止まった場合の接頭辞。 */
export const LOOP_STOPPED_NO_APPLIED_PROPOSALS = 'no_applied_proposals';

/**
 * レポートの品質判定（docs/16 §6）。最良イテレーションのメトリクスと `options.targets` だけから
 * 決定的に決める（LLMの総括は一切見ない）。
 *
 * - シナリオを1件も回せていない / 全シナリオが会話段で失敗 / 満足度を1件も回収できていない場合は、
 *   目標との比較自体が成り立たないので `unverified`（「未達」と断定もしない）。
 * - 測れたうえで両目標を満たしていれば `met-targets`、満たさなければ `below-targets`。
 */
export function assessReportQuality(
  metrics: IterationMetrics | undefined,
  targets: { readonly minGoalAchievedRate: number; readonly minAvgSatisfaction: number },
): { quality: FactoryReportQuality; reasons: string[] } {
  if (metrics === undefined || metrics.scenarioCount === 0) {
    return { quality: 'unverified', reasons: ['no scenario was validated'] };
  }
  const reasons: string[] = [];
  if (metrics.errorRate >= 1) reasons.push('every scenario ended in an error, so no behaviour was actually observed');
  if (metrics.surveyMissingCount >= metrics.scenarioCount) reasons.push('no satisfaction survey could be collected, so avgSatisfaction is missing rather than low');
  if (reasons.length > 0) return { quality: 'unverified', reasons };

  if (metrics.goalAchievedRate < targets.minGoalAchievedRate) {
    reasons.push(`goalAchievedRate ${metrics.goalAchievedRate.toFixed(2)} is below the target ${targets.minGoalAchievedRate}`);
  }
  if (metrics.avgSatisfaction < targets.minAvgSatisfaction) {
    reasons.push(`avgSatisfaction ${metrics.avgSatisfaction.toFixed(2)} is below the target ${targets.minAvgSatisfaction}`);
  }
  if (metrics.surveyMissingCount > 0) {
    reasons.push(`${metrics.surveyMissingCount} of ${metrics.scenarioCount} scenario(s) returned no satisfaction survey`);
  }
  if (reasons.length === 0) return { quality: 'met-targets', reasons: [] };
  // 満足度は測れているのに欠測が一部ある、というだけでは「未達」にしない（目標自体は満たしうる）。
  const belowTarget = metrics.goalAchievedRate < targets.minGoalAchievedRate || metrics.avgSatisfaction < targets.minAvgSatisfaction;
  return { quality: belowTarget ? 'below-targets' : 'met-targets', reasons };
}

/** Analystの総括が一度も得られなかった場合（例: maxIterations到達で分析すら行わなかった）の決定的フォールバック。 */
function defaultSummary(iterations: readonly FactoryIteration[]): string {
  const last = iterations[iterations.length - 1];
  if (last === undefined) return 'Factory run stopped with no iterations.';
  return `Factory run stopped after ${iterations.length} iteration(s); latest goalAchievedRate=${last.metrics.goalAchievedRate.toFixed(2)}, avgSatisfaction=${last.metrics.avgSatisfaction.toFixed(2)}.`;
}

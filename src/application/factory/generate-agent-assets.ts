/**
 * application層: Agent Factory Stage 2-4 資産生成 `GenerateAgentAssetsUseCase`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §4 Stage 2-4）。
 *
 * ToolSmith（+修復ループ）→ SkillWriter → Assembler（+ `GenerateAgentPromptUseCase` の決定的合成）の
 * 順に既存Save系ユースケースへ委譲し、Tool/Skill/Agentをdraftとして保存する。`FactoryRun` レコードには
 * 触れない（`RunFactoryUseCase` が呼び出し後に `artifacts`/`budget` を更新する）。
 *
 * Stage 2 既存Tool再利用: 計画に `reuse.internalId` があり、渡された既存ツールカタログ（`existingTools`）で
 * 解決できる場合はToolSmithを呼ばず、その既存Toolの最新版をAgent/Skillの参照へそのまま載せる
 * （`tool_reused` イベント）。解決できない場合は理由をイベントへ残して新規生成へフォールバックする。
 *
 * Stage 2 修復ループ: ToolSmithの提案を `ResolveDataSourceGraphUseCase` + `EtlEngine.propagateSchemas`/
 * `preview` で検証し、失敗したらエラーメッセージを添えて再提案させる（`maxRepairAttempts` 回まで）。
 * 修復上限まで失敗したToolは欠落として記録し、計画から除外して続行する（依存するSkillは残る依存Toolだけへ
 * 縮退する。依存Toolを全て失ったSkillはドロップする）。全Toolが欠落した場合はRunを失敗させる。
 *
 * その修復ループ本体は `generateToolWithRepair` として切り出してあり、改善ループの `add-tool` 適用
 * （`ApplyImprovementsUseCase`）からも同じ規律で再利用する。
 *
 * 既存Agent強化モード（`input.baseAgent` 指定）では Stage 2-3 は同じだが、Stage 4 で新しいAgentを作らず
 * `integrateAssetsIntoAgent` で既存Agentのpatch新版を作る（メタデータ・設定は必ず引き継ぐ）。systemPromptの
 * 扱いは `promptStrategy` で選べる: `preserve`（既定・人手記述を保ちガイド2節だけ差し替え）/ `rewrite`
 * （Assemblerに既存プロンプトを渡して役割文・実行規則を再起草させる）。
 */
import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/agent/agent';
import type { Column, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { operatorBindingsOf, valueBindingsOf } from '../../domain/etl/nodes/filter';
import { PARSE_PERIOD_TYPE } from '../../domain/etl/nodes/parse-period';
import type { FactoryAgentBrief, FactoryPlan, FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { FactoryEvent, FactoryGoalInput, FactoryPromptStrategy } from '../../domain/factory/factory-run';
import { FactoryAbortedError, FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryRunId } from '../../domain/factory/ids';
import type { VersionRef } from '../../domain/factory/refs';
import type { SkillId } from '../../domain/skill/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ToolId } from '../../domain/tool/ids';
import type { SideEffect } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { EtlEngine, PreviewResult, PropagationResult } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { SaveAgentUseCase } from '../agent/save-agent';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { MAX_TOOL_CALLS } from '../agent/run-agent-preview';
import { validateToolArguments } from '../agent/tool-schema';
import { graphWithArguments } from '../tool/tool-execution';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { throwIfAborted } from './abort';
import type { DataProfile } from './profile-data-sources';
import { isReusableSideEffect, type ExistingToolCatalogEntry } from './tool-catalog';
import { AssemblerRole } from './roles/assembler-role';
import { SkillWriterRole, type SkillWriterToolContract } from './roles/skill-writer-role';
import { SAFE_TRANSFORM_TYPES, ToolSmithRole } from './roles/tool-smith-role';

/** Factory生成物の owner（docs/16 §8: 既存資産の名前空間を汚染しない出所ラベル）。`run-factory.ts` のStage 5でも再利用する。 */
export const FACTORY_OWNER = 'agent-factory';

/**
 * 生成Agentのsystem promptへ決定的に差し込む「回答の規律」ブロックの見出し（ADR-0047）。
 *
 * 言語に依らない不変の目印にしてある: `ApplyImprovementsUseCase` が
 * `system-prompt-revision`（役割文・実行規則をまるごと差し替える提案）を適用するときに、
 * この見出しでブロックを見つけて必ず残す（Analystの書き直しで規律が消えないようにする）。
 */
export const FACTORY_ANSWER_GUARD_HEADING = '# Answer discipline / 回答の規律 (factory-managed)';

const ANSWER_GUARD_RULES_JA: readonly string[] = [
  '- 数値・件数・順位は、必ずツールが返した行から引き写す。記憶や推測で数字を書かない。',
  '- ツールが 0 件（または該当なし）を返したら、まず「その条件に当てはまる行が無い」と伝える。そのうえで、ツールの説明や返却内容にある実在の値（期間の書式・選べる地域や区分など）を挙げて、次に試す条件を提案する。0 件を「値が 0 である」と書き換えない。',
  '- 数値を答えるときは、その行の時点（期間）と単位を必ず併記する。期間の粒度（月次・四半期・年次・年度）が混ざりうるデータでは、どの粒度の値かも書く。',
  '- 行に注記（備考）が付いていたら、その内容をそのまま引用して添える。',
  '- ツールの引数は、ツールの説明が示す書式・値のとおりに渡す。当てはまる値が分からないときは、勝手に作らず利用者に確認する。',
];

const ANSWER_GUARD_RULES_EN: readonly string[] = [
  '- Take every number, count and ranking verbatim from a row a tool returned. Never answer a number from memory or by guessing.',
  '- When a tool returns no rows (or reports no match), say first that nothing matches those conditions. Then offer the values that do exist (the accepted period format, the selectable regions or categories) and suggest what to try next. Never turn "no rows" into "the value is 0".',
  '- When you state a number, always cite the period (時点) and the unit from that same row. When the data mixes period granularities (monthly / quarterly / yearly / fiscal year), say which granularity the number is.',
  '- When a row carries a note (注記 / remarks), quote it alongside the number.',
  '- Pass tool arguments exactly in the format and values the tool description gives. If you do not know a valid value, ask the user instead of inventing one.',
];

/**
 * 「絞り込み引数を省略できるToolがある」ときだけ足す規律（ADR-0047 round 2 / Defect C）。
 *
 * 1回の会話で呼べるツールは `MAX_TOOL_CALLS` 回までなので、「東京都・大阪府・北海道を比較」を
 * 県ごとに1回ずつ呼ぶ設計は上限で必ず落ちる。絞り込み引数を省略すれば全カテゴリが1回で返るなら、
 * そちらを使わせる。Tool契約が省略を許さないなら書かない（守れない指示を書くと他の規律も薄まる）。
 */
const ANSWER_GUARD_MULTI_CATEGORY_JA = '- 複数の対象（複数の地域・区分など）を比べるときは、対象ごとにツールを呼び分けない。絞り込み引数を省略して1回だけ呼び、返ってきた行から必要な対象を選ぶ（1回の会話で呼べるツールの回数には上限がある）。';
const ANSWER_GUARD_MULTI_CATEGORY_EN = '- To compare several items (several regions, categories, …), do NOT call the tool once per item. Omit the narrowing argument, call the tool ONCE, and pick the rows you need out of the result (the number of tool calls per conversation is capped).';

/** `factoryAnswerGuardBlock` の任意の調整。 */
export interface AnswerGuardOptions {
  /**
   * 絞り込み引数を省略できるToolがこのAgentにあるか（`inputSchema` の nullable 列から決定的に導く）。
   * true のときだけ「1回だけ呼んで行を選ぶ」規律を足す。
   */
  readonly omittableFilters?: boolean;
}

/**
 * 回答の規律ブロック（決定的・LLM非関与）。
 *
 * e-Stat 実データの検証で、生成Agentは 0 行のツール結果を受けても数字を作文し、時点・単位・注記を
 * 落として答えた（ADR-0047）。この規律は Assembler の起草物ではなく決定的合成側に置き、
 * Analyst のプロンプト書き直しでも落ちないようにする。
 */
export function factoryAnswerGuardBlock(language: 'ja' | 'en' = 'ja', options: AnswerGuardOptions = {}): string {
  const english = language === 'en';
  const rules = english ? ANSWER_GUARD_RULES_EN : ANSWER_GUARD_RULES_JA;
  const extra = options.omittableFilters === true
    ? [english ? ANSWER_GUARD_MULTI_CATEGORY_EN : ANSWER_GUARD_MULTI_CATEGORY_JA]
    : [];
  return [FACTORY_ANSWER_GUARD_HEADING, ...rules, ...extra].join('\n');
}

/**
 * このRunで保存したToolの引数宣言から「絞り込みを省略できるか」を決定的に判定する。
 * Factory生成Toolは `makeArgumentsOptional` で全引数が nullable になるため、実質は
 * 「引数を1つ以上宣言したToolがあるか」と同じだが、判定の根拠は宣言そのものに置く。
 */
export function hasOmittableFilters(tools: readonly Tool[]): boolean {
  return tools.some((tool) => (tool.inputSchema?.columns ?? []).some((column) => column.nullable));
}

/**
 * system prompt から「回答の規律」ブロックを取り出す（無ければ undefined）。
 * セクション境界は `replaceGuideSections` と同じトップレベル見出し行（`# `）とする。
 */
export function extractAnswerGuardBlock(systemPrompt: string): string | undefined {
  const lines = systemPrompt.split('\n');
  const start = lines.findIndex((line) => line.trim() === FACTORY_ANSWER_GUARD_HEADING);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^# \S/.test(line));
  const body = end === -1 ? rest : rest.slice(0, end);
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  return [lines[start]!.trim(), ...body].join('\n');
}

/**
 * 「役割文 → ガイド → 実行規則」の合成結果へ回答の規律ブロックを必ず付ける。
 * 既に同じ見出しのブロックが本文中にあればそれを採用し（利用者/Analystが手を入れた版を尊重する）、
 * 二重に付けない。
 */
export function withAnswerGuard(
  sections: readonly string[],
  options: AnswerGuardOptions & { readonly language?: 'ja' | 'en'; readonly existing?: string | undefined } = {},
): string {
  const joined = sections.join('\n\n');
  if (extractAnswerGuardBlock(joined) !== undefined) return joined;
  return [joined, options.existing ?? factoryAnswerGuardBlock(options.language ?? 'ja', options)].join('\n\n');
}

export interface GenerateAgentAssetsInput {
  readonly scope: TenantScope;
  readonly runId: FactoryRunId;
  readonly goal: FactoryGoalInput;
  readonly plan: FactoryPlan;
  readonly profiles: readonly DataProfile[];
  readonly maxRepairAttempts: number;
  /**
   * 再利用候補の既存Tool（`buildExistingToolCatalog` の結果 `entries`）。計画の `reuse.internalId` は
   * このカタログ内でだけ解決する（Stage 1でPlannerへ提示した集合と、実際に参照する集合を一致させる）。
   */
  readonly existingTools?: readonly ExistingToolCatalogEntry[];
  /**
   * 既存Agent強化モードの起点Agent（`RunFactoryUseCase` がStage 0でロードして渡す）。
   * 指定すると Stage 4 は新規Agentを作らず、このAgentへ生成物を統合したpatch新版を作る。
   * 未指定なら従来どおりの0→1生成（挙動は一切変わらない）。
   */
  readonly baseAgent?: Agent;
  /**
   * 強化モードでの systemPrompt の扱い（`FactoryOptions.promptStrategy`）。省略時は `'preserve'`。
   * 生成モード（`baseAgent` 未指定）では無視される（0→1は元からAssemblerが役割文・実行規則を起草する）。
   */
  readonly promptStrategy?: FactoryPromptStrategy;
  readonly onEvent?: (event: Omit<FactoryEvent, 'sequence'>) => void;
  /**
   * Run の中断シグナル（利用者の cancel / worker の shutdown）。各ロール呼び出しへ渡し、Tool→Skill→Agent の
   * 各ステップの合間でも確認する。中断は `FactoryAbortedError` で抜け、修復ループの再試行へは丸めない
   * （cancel が「多くてもモデル呼び出し1回分」で効くようにする）。
   */
  readonly signal?: AbortSignal;
}

export interface GenerateAgentAssetsResult {
  readonly toolRefs: readonly VersionRef[];
  readonly skillRefs: readonly VersionRef[];
  readonly agentRef: VersionRef;
  readonly toolKeyToRef: Map<string, VersionRef>;
  /**
   * Tool計画キー → **エージェントがそのToolを呼ぶときの関数名**（`agentTool.name`、未設定なら `publishName`）。
   *
   * Stage 5 の `Scenario.expectedTools` はこの名前でなければならない: `RunScenarioUseCase` が
   * `calledTools` へ記録するのはトレースの `tool-call` イベント名 = `toolToModelDefinition` が
   * 公開する関数名であり、`publishName` を期待名に入れると必ず hitRate が 0 になる（ADR-0047）。
   * 再利用した既存Toolもカタログの `toolName`（= 同じ導出）で入れる。
   */
  readonly toolKeyToToolName: ReadonlyMap<string, string>;
  readonly roleCallsUsed: number;
  /**
   * 既存Agent強化モードで、実際にAgentの新版を作ったか。`false` は「追加が0件でAgentに変化がない」ため
   * 既存版のRefをそのまま `agentRef` として返した場合（Stage 5以降は既存版を起点に検証・改善する）。
   * 生成モードでは常に `true`。
   */
  readonly agentChanged: boolean;
}

export class GenerateAgentAssetsUseCase {
  constructor(
    private readonly toolSmith: ToolSmithRole,
    private readonly skillWriter: SkillWriterRole,
    private readonly assembler: AssemblerRole,
    private readonly saveTool: SaveToolUseCase,
    private readonly saveSkill: SaveSkillUseCase,
    private readonly saveAgent: SaveAgentUseCase,
    private readonly generateAgentPrompt: GenerateAgentPromptUseCase,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources: ResolveDataSourceGraphUseCase,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: GenerateAgentAssetsInput): Promise<GenerateAgentAssetsResult> {
    let roleCallsUsed = 0;
    const signal = input.signal;
    const emit = (event: Omit<FactoryEvent, 'sequence'>): void => { input.onEvent?.(event); };
    const profileByDataSourceId = new Map(input.profiles.map((profile) => [profile.dataSourceId, profile] as const));

    // Stage 2: Tool生成（ToolSmith + 修復ループ）。
    const toolRefs: VersionRef[] = [];
    const toolKeyToRef = new Map<string, VersionRef>();
    const toolKeyToToolName = new Map<string, string>();
    const toolKeyToContract = new Map<string, SkillWriterToolContract>();
    /** このRunで保存したToolの実体（回答の規律ブロックの「引数を省略できるか」を決定的に導くために持つ）。 */
    const savedTools: Tool[] = [];
    const reusable = input.existingTools ?? [];

    for (const toolPlan of input.plan.tools) {
      throwIfAborted(signal);
      // 再利用計画（Stage 1の「既存Toolで足りるか」の判断結果）は、ToolSmithを呼ばずに既存Toolを参照する。
      // 解決できない（削除済み・カタログ外・許可されない副作用）場合は理由を記録して新規生成へフォールバックする。
      const reuse = toolPlan.reuse;
      if (reuse !== undefined) {
        const existing = resolveReuseTarget(reusable, reuse.internalId);
        if (existing !== undefined && isReusableSideEffect(existing.sideEffect)) {
          const ref: VersionRef = { internalId: existing.internalId, version: existing.latestVersion };
          toolRefs.push(ref);
          toolKeyToRef.set(toolPlan.key, ref);
          // 期待Tool名は「エージェントが呼ぶ関数名」で揃える（カタログの `toolName` = agentTool.name ?? publishName）。
          toolKeyToToolName.set(toolPlan.key, existing.toolName);
          toolKeyToContract.set(toolPlan.key, { name: existing.toolName, description: existing.description });
          emit({ kind: 'tool_reused', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: ${existing.publishName}`, ref });
          continue;
        }
        emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: reuse target '${reuse.internalId}' is not available for reuse; generating a new tool instead` });
      }

      const profile = profileByDataSourceId.get(toolPlan.dataSourceId);
      if (profile === undefined) {
        emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: no data profile available for dataSourceId '${toolPlan.dataSourceId}'` });
        continue;
      }
      // 保存前に read-only/session-write のみへ強制する（docs/16 §8: write/external-actionは保存前に拒否）。
      const sideEffect = toolPlan.sideEffect === 'read-only' || toolPlan.sideEffect === 'session-write' ? toolPlan.sideEffect : 'read-only';
      const outcome = await generateToolWithRepair(
        { toolSmith: this.toolSmith, resolveDataSources: this.resolveDataSources, engine: this.engine, saveTool: this.saveTool },
        {
          scope: input.scope,
          toolPlan,
          profile,
          sideEffect,
          maxRepairAttempts: input.maxRepairAttempts,
          identity: () => ({
            internalId: this.makeId(),
            workingName: `${toolPlan.displayName} (factory draft)`,
            displayName: `${toolPlan.displayName} (Factory)`,
            publishName: makePublishName('tool', toolPlan.displayName, input.runId, toolPlan.key),
            owner: FACTORY_OWNER,
          }),
          onAttemptFailed: ({ attempt, attempts, message }) =>
            emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key} attempt ${attempt}/${attempts}: ${message}` }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      roleCallsUsed += outcome.roleCallsUsed;
      const saved = outcome.tool;

      if (saved === undefined) continue; // 修復上限まで失敗 → 欠落として記録し計画から除外して続行。

      const ref: VersionRef = { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() };
      toolRefs.push(ref);
      savedTools.push(saved);
      toolKeyToRef.set(toolPlan.key, ref);
      // `toolToModelDefinition` と同じ導出（agentTool.name ?? publishName）。publishName を入れると
      // `ScenarioRun.metrics.expectedToolHit` が必ず 0 になる（ADR-0047）。
      toolKeyToToolName.set(toolPlan.key, saved.agentTool?.name ?? saved.metadata.publishName);
      toolKeyToContract.set(toolPlan.key, { name: saved.agentTool?.name ?? saved.metadata.publishName, description: saved.agentTool?.description ?? saved.metadata.displayName });
      emit({ kind: 'tool_generated', at: this.now().toISOString(), stage: 'generating-tools', message: toolPlan.key, ref });
      emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-tools', ref });
    }

    // 0→1生成では1件もToolが作れなければAgentが成立しないためRunを失敗させる。既存Agent強化では
    // 「今あるAgentはそのまま動く」ので失敗させず、追加が0件のまま（プロンプト改善だけのRunとして）続行する。
    if (toolRefs.length === 0 && input.baseAgent === undefined) throw new FactoryValidationError('GenerateAgentAssets: no tools could be generated');

    // Stage 3: Skill生成（SkillWriter）。依存Toolを全て失ったSkillはドロップし、一部生存なら縮退する。
    const skillRefs: VersionRef[] = [];
    for (const skillPlan of input.plan.skills) {
      throwIfAborted(signal);
      const resolvedToolKeys = skillPlan.toolKeys.filter((key) => toolKeyToRef.has(key));
      if (skillPlan.toolKeys.length > 0 && resolvedToolKeys.length === 0) continue;

      const toolContracts = resolvedToolKeys
        .map((key) => toolKeyToContract.get(key))
        .filter((contract): contract is SkillWriterToolContract => contract !== undefined);
      const skillToolRefs = resolvedToolKeys
        .map((key) => toolKeyToRef.get(key))
        .filter((ref): ref is VersionRef => ref !== undefined)
        .map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));

      roleCallsUsed += 1;
      const proposal = await this.skillWriter.propose({ skillPlan, toolContracts }, signal);
      throwIfAborted(signal);
      const savedSkill = await this.saveSkill.execute({
        scope: input.scope,
        internalId: this.makeId(),
        workingName: `${skillPlan.displayName} (factory draft)`,
        displayName: `${skillPlan.displayName} (Factory)`,
        publishName: makePublishName('skill', skillPlan.displayName, input.runId, skillPlan.key),
        owner: FACTORY_OWNER,
        responsibility: proposal.responsibility,
        activationCondition: proposal.activationCondition,
        inputDescription: proposal.inputDescription,
        outputDescription: proposal.outputDescription,
        instructions: proposal.instructions,
        tools: skillToolRefs,
      });
      const ref: VersionRef = { internalId: savedSkill.metadata.internalId, version: savedSkill.metadata.version.toString() };
      skillRefs.push(ref);
      emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-skills', ref });
    }

    // Stage 4: Agent組み立て（決定的合成 + Assembler）。
    throwIfAborted(signal);
    const skillPromptRefs = skillRefs.map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));
    const toolPromptRefs = toolRefs.map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));

    // 既存Agent強化モード: 新規Agentを作らず、既存Agentへ生成物を統合したpatch新版を作る。
    // systemPromptの扱いは `promptStrategy` で選ぶ（既定 `preserve` = Assemblerを呼ばない）。
    if (input.baseAgent !== undefined) {
      const promptStrategy = input.promptStrategy ?? 'preserve';
      // 計画された追加が0件（プロンプト改善だけのRun）で `preserve` なら、プロンプトも変わらないため
      // 既存Agentをそのまま起点にし、新版を作らない。`rewrite` はプロンプト自体を改訂するので統合へ進む。
      if (toolPromptRefs.length === 0 && skillPromptRefs.length === 0 && promptStrategy === 'preserve') {
        const baseRef: VersionRef = { internalId: input.baseAgent.metadata.internalId, version: input.baseAgent.metadata.version.toString() };
        return { toolRefs, skillRefs, agentRef: baseRef, toolKeyToRef, toolKeyToToolName, roleCallsUsed, agentChanged: false };
      }
      const integrated = await integrateAssetsIntoAgent(
        { saveAgent: this.saveAgent, generateAgentPrompt: this.generateAgentPrompt, assembler: this.assembler },
        {
          scope: input.scope, baseAgent: input.baseAgent, toolRefs: toolPromptRefs, skillRefs: skillPromptRefs, promptStrategy,
          // 強化モードのbriefは「既存Agentの名前」+「今回の目標に対するPlannerの役割記述」で組む
          // （displayNameは既存を維持し、Factoryが本番Agentの名前を勝手に変えないため）。
          rewriteContext: { goal: input.goal, agentBrief: { displayName: input.baseAgent.metadata.displayName, role: input.plan.agentBrief.role } },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      roleCallsUsed += integrated.roleCallsUsed;
      // 書き直しに失敗して preserve へ倒した場合は、Runを落とさず理由をイベントへ残す。
      if (integrated.fallbackReason !== undefined) {
        emit({ kind: 'proposal_rejected', at: this.now().toISOString(), stage: 'assembling-agent', message: `prompt rewrite failed, kept the existing prompt: ${integrated.fallbackReason}` });
      }
      if (integrated.changed) {
        emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'assembling-agent', message: `enhanced ${input.baseAgent.metadata.displayName} (${describePromptStrategy(integrated.promptStrategy)})`, ref: integrated.agentRef });
      }
      return { toolRefs, skillRefs, agentRef: integrated.agentRef, toolKeyToRef, toolKeyToToolName, roleCallsUsed, agentChanged: integrated.changed };
    }

    const promptDraft = await this.generateAgentPrompt.execute({
      scope: input.scope,
      displayName: input.plan.agentBrief.displayName,
      kind: 'normal',
      skills: skillPromptRefs,
      tools: toolPromptRefs,
    });

    roleCallsUsed += 1;
    const assembled = await this.assembler.propose({
      goal: input.goal,
      agentBrief: input.plan.agentBrief,
      skillGuide: promptDraft.sections.skillGuide,
      toolUsageGuide: promptDraft.sections.toolUsageGuide,
      // 「対象ごとに1回ずつ呼ぶ」規則を書かせないため、会話あたりのツール呼び出し上限を渡す（ADR-0047）。
      toolCallBudget: MAX_TOOL_CALLS,
    }, signal);
    throwIfAborted(signal);

    // Tool使用ガイド・Skillガイドはassemblerが上書き生成しない（出所を機械的に追跡できる部分を保つ）。
    // 回答の規律（ADR-0047）も決定的合成側に置く: LLMの起草物ではないので、Analystの書き直しでも消えない。
    const systemPrompt = withAnswerGuard(
      [assembled.role, promptDraft.sections.skillGuide, promptDraft.sections.toolUsageGuide, assembled.rules],
      { language: input.goal.language, omittableFilters: hasOmittableFilters(savedTools) },
    );

    const savedAgent = await this.saveAgent.execute({
      scope: input.scope,
      internalId: this.makeId(),
      workingName: `${input.plan.agentBrief.displayName} (factory draft)`,
      displayName: `${input.plan.agentBrief.displayName} (Factory)`,
      publishName: makePublishName('agent', input.plan.agentBrief.displayName, input.runId, 'agent'),
      owner: FACTORY_OWNER,
      kind: 'normal',
      systemPrompt,
      skills: skillPromptRefs,
      tools: toolPromptRefs,
    });
    const agentRef: VersionRef = { internalId: savedAgent.metadata.internalId, version: savedAgent.metadata.version.toString() };
    emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'assembling-agent', ref: agentRef });

    return { toolRefs, skillRefs, agentRef, toolKeyToRef, toolKeyToToolName, roleCallsUsed, agentChanged: true };
  }
}

/** `integrateAssetsIntoAgent` が使う協働者（Stage 4の決定的合成と保存）。 */
export interface IntegrateAgentAssetsDeps {
  readonly saveAgent: SaveAgentUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
  /** `promptStrategy: 'rewrite'` のときだけ使う。未注入なら rewrite 指定でも `preserve` として振る舞う。 */
  readonly assembler?: AssemblerRole;
}

export interface IntegrateAgentAssetsRequest {
  readonly scope: TenantScope;
  /** 統合先の既存Agent（`RunFactoryUseCase` がロードした起点版）。 */
  readonly baseAgent: Agent;
  /** このRunで生成・再利用したTool（既存Agentの参照との和集合を取る。同 internalId は新版優先）。 */
  readonly toolRefs: readonly { readonly internalId: ToolId; readonly version: SemVer }[];
  readonly skillRefs: readonly { readonly internalId: SkillId; readonly version: SemVer }[];
  /** systemPromptの扱い。省略時は `'preserve'`（ガイド2節だけを決定的に差し替える従来の挙動）。 */
  readonly promptStrategy?: FactoryPromptStrategy;
  /** `'rewrite'` でAssemblerへ渡す材料。無ければ rewrite できないため `preserve` へ倒す。 */
  readonly rewriteContext?: { readonly goal: FactoryGoalInput; readonly agentBrief: FactoryAgentBrief };
  /** Run の中断シグナル。Assembler へ渡し、中断は `preserve` フォールバックへ丸めず `FactoryAbortedError` で抜ける。 */
  readonly signal?: AbortSignal;
}

export interface IntegrateAgentAssetsResult {
  readonly agentRef: VersionRef;
  /** 新版を保存したか。`false` は「参照もsystemPromptも変わらないため既存版をそのまま起点にした」。 */
  readonly changed: boolean;
  /** systemPromptの合成方法（監査用）。`spliced` = 既存の見出しを差し替え、`appended` = 見出しが無く追記した、`rewritten` = Assemblerが役割文・実行規則を再起草した。 */
  readonly promptStrategy: 'unchanged' | 'spliced' | 'appended' | 'rewritten';
  /** 消費したロール呼び出し回数（`rewrite` を試みたら1、失敗した試行も `generateToolWithRepair` と同じく消費として数える）。 */
  readonly roleCallsUsed: number;
  /** `rewrite` を試みて失敗し `preserve` へ倒した理由（成功時・`preserve` 時は未設定）。 */
  readonly fallbackReason?: string;
}

/**
 * 既存Agentへ、このRunで作ったTool/Skillを統合した**patch新版**を作る（Stage 4の強化モード版）。
 *
 * 規律:
 * - Tool/Skill参照は既存との**和集合**（同 internalId は新版優先、既存の並び順を保つ）。既存の参照は落とさない。
 * - systemPrompt は `promptStrategy` で選ぶ:
 *   - `preserve`（既定）: `GenerateAgentPromptUseCase` が決定的に合成する Skillガイド / Tool使用ガイドの
 *     **2セクションだけ**を差し替え、役割文・実行規則・利用者が書き足した節はそのまま残す
 *     （`AssemblerRole` を呼ばない = 既存Agentの役割文をLLMに書き直させない）。
 *   - `rewrite`: `AssemblerRole` へ既存プロンプトを渡して役割文・実行規則を再起草させ、生成モードと同じ
 *     組み立て（役割文 → Skillガイド → Tool使用ガイド →〈協働者ガイド〉→ 実行規則）で作り直す。
 *     利用者が書き足した独自の節は引き継がれない（Assemblerが本文として読んだうえで取捨する）。
 *     協働者ガイドは既存Agentがサブエージェントを持つ場合だけ挟む（`preserve` で残る節を落とさないため）。
 *     Assemblerが失敗した場合は Run を落とさず `preserve` へフォールバックし、理由を `fallbackReason` で返す。
 * - `displayName` / `publishName` / `owner` / `kind` / `state` / サブエージェント / `mcpServers` /
 *   `harness` / `output` / `persona` / `wikis` は既存値をそのまま引き継ぐ（`FACTORY_OWNER` で潰さない）。
 * - 参照もプロンプトも変わらない場合は保存せず既存版のRefを返す（無意味な版を増やさない。`rewrite` で
 *   Assemblerの結果が既存と完全一致した場合もここで保存をスキップする）。
 */
export async function integrateAssetsIntoAgent(deps: IntegrateAgentAssetsDeps, request: IntegrateAgentAssetsRequest): Promise<IntegrateAgentAssetsResult> {
  const base = request.baseAgent;
  const tools = mergeVersionRefs(base.tools, request.toolRefs);
  const skills = mergeVersionRefs(base.skills, request.skillRefs);

  const promptDraft = await deps.generateAgentPrompt.execute({
    scope: request.scope,
    displayName: base.metadata.displayName,
    kind: base.kind,
    skills,
    tools,
    agents: base.agents,
  });

  let roleCallsUsed = 0;
  let rewritten: string | undefined;
  let fallbackReason: string | undefined;
  const assembler = deps.assembler;
  const rewriteContext = request.rewriteContext;
  if (request.promptStrategy === 'rewrite' && assembler !== undefined && rewriteContext !== undefined) {
    roleCallsUsed += 1;
    throwIfAborted(request.signal);
    try {
      const assembled = await assembler.propose({
        goal: rewriteContext.goal,
        agentBrief: rewriteContext.agentBrief,
        skillGuide: promptDraft.sections.skillGuide,
        toolUsageGuide: promptDraft.sections.toolUsageGuide,
        toolCallBudget: MAX_TOOL_CALLS,
        currentPrompt: base.systemPrompt,
      }, request.signal);
      // 書き直しでも回答の規律（ADR-0047）は落とさない。起点Agentが既に持っていればその文面を引き継ぐ。
      rewritten = withAnswerGuard([
        assembled.role,
        promptDraft.sections.skillGuide,
        promptDraft.sections.toolUsageGuide,
        ...(base.agents.length === 0 ? [] : [promptDraft.sections.collaboratorGuide]),
        assembled.rules,
      ], { language: rewriteContext.goal.language, existing: extractAnswerGuardBlock(base.systemPrompt) });
    } catch (error) {
      // 中断はフォールバック（preserve で保存を続ける）ではなく打ち切り: cancel 後に新版を作ってはならない。
      if (error instanceof FactoryAbortedError) throw error;
      throwIfAborted(request.signal);
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  const preserved = replaceGuideSections(base.systemPrompt, {
    skillGuide: promptDraft.sections.skillGuide,
    toolUsageGuide: promptDraft.sections.toolUsageGuide,
  });
  const systemPrompt = rewritten ?? preserved.systemPrompt;
  const strategy: IntegrateAgentAssetsResult['promptStrategy'] = rewritten === undefined ? preserved.strategy : 'rewritten';
  const fallback = fallbackReason === undefined ? {} : { fallbackReason };

  const refsUnchanged = sameVersionRefs(base.tools, tools) && sameVersionRefs(base.skills, skills);
  if (refsUnchanged && systemPrompt === base.systemPrompt) {
    return { agentRef: { internalId: base.metadata.internalId, version: base.metadata.version.toString() }, changed: false, promptStrategy: 'unchanged', roleCallsUsed, ...fallback };
  }

  const saved = await deps.saveAgent.execute({
    scope: request.scope,
    internalId: base.metadata.internalId,
    workingName: base.metadata.workingName,
    displayName: base.metadata.displayName,
    publishName: base.metadata.publishName,
    owner: base.metadata.owner,
    kind: base.kind,
    systemPrompt,
    skills,
    tools,
    agents: base.agents,
    wikis: base.wikis ?? [],
    ...(base.mcpServers === undefined ? {} : { mcpServers: base.mcpServers }),
    ...(base.harness === undefined ? {} : { harness: base.harness }),
    ...(base.persona === undefined ? {} : { persona: base.persona }),
    ...(base.output === undefined ? {} : { output: base.output }),
    state: base.metadata.state,
    bump: 'patch',
  });
  return {
    agentRef: { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() },
    changed: true,
    promptStrategy: strategy,
    roleCallsUsed,
    ...fallback,
  };
}

/** `artifact_saved` イベントで「systemPromptをどう作ったか」を一目で分かる文言にする（監査用）。 */
function describePromptStrategy(strategy: IntegrateAgentAssetsResult['promptStrategy']): string {
  return strategy === 'rewritten' ? 'prompt rewritten by assembler' : `prompt guides ${strategy}`;
}

/** 既存参照の並び順を保ったまま、同 internalId は新版で置換し、新規分を末尾へ足す。 */
function mergeVersionRefs(
  base: readonly { readonly internalId: string; readonly version: SemVer }[],
  added: readonly { readonly internalId: string; readonly version: SemVer }[],
): { internalId: string; version: SemVer }[] {
  const overrides = new Map(added.map((ref) => [ref.internalId, ref.version] as const));
  const merged = base.map((ref) => ({ internalId: ref.internalId, version: overrides.get(ref.internalId) ?? ref.version }));
  const seen = new Set(base.map((ref) => ref.internalId));
  for (const ref of added) {
    if (seen.has(ref.internalId)) continue;
    seen.add(ref.internalId);
    merged.push({ internalId: ref.internalId, version: ref.version });
  }
  return merged;
}

function sameVersionRefs(
  left: readonly { readonly internalId: string; readonly version: SemVer }[],
  right: readonly { readonly internalId: string; readonly version: SemVer }[],
): boolean {
  return left.length === right.length
    && left.every((ref, index) => ref.internalId === right[index]?.internalId && ref.version.equals(right[index]!.version));
}

/** `GenerateAgentPromptUseCase` が決定的に合成する、差し替え対象のガイド見出し。 */
const SKILL_GUIDE_HEADING = 'Skillガイド';
const TOOL_GUIDE_HEADING = 'Tool使用ガイド';
/** 挿入位置の基準（この見出しがあれば、その手前へ不足ガイドを差し込む）。 */
const RULES_HEADING = '実行規則';

interface PromptSection { readonly heading: string; readonly lines: string[] }

/**
 * systemPrompt のうち「Skillガイド」「Tool使用ガイド」セクションだけを新しい合成結果へ差し替える。
 *
 * 既存AgentのsystemPromptは利用者が編集しうるため、機械的に再合成できる2セクション以外
 * （役割文・実行規則・独自に書き足した節）は一字一句そのまま残す。見出しが見つからない
 * （Builder標準の書式で書かれていない）場合は、`# 実行規則` の手前、無ければ末尾へ追記する。
 *
 * セクション境界はトップレベル見出し行（`# ` で始まる行）とする。利用者が書いた節を巻き込んで
 * 消さないための選択で、逆にSkillのinstructions本文がH1見出しを含む場合は差し替え範囲がそこで
 * 切れる（生成物の一部が孤立ブロックとして残る）が、利用者の記述を失うよりは安全側とする。
 */
export function replaceGuideSections(systemPrompt: string, guides: { readonly skillGuide: string; readonly toolUsageGuide: string }): { systemPrompt: string; strategy: 'spliced' | 'appended' } {
  const preamble: string[] = [];
  const sections: PromptSection[] = [];
  for (const line of systemPrompt.split('\n')) {
    if (/^# \S/.test(line)) sections.push({ heading: line.slice(2).trim(), lines: [line] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1]!.lines.push(line);
  }

  let appended = false;
  const replace = (heading: string, replacement: string): void => {
    const index = sections.findIndex((section) => section.heading === heading);
    if (index === -1) {
      appended = true;
      return;
    }
    const body = [...sections[index]!.lines];
    const trailingBlanks: string[] = [];
    while (body.length > 0 && body[body.length - 1]!.trim() === '') trailingBlanks.unshift(body.pop()!);
    sections[index] = { heading, lines: [...replacement.split('\n'), ...trailingBlanks] };
  };
  replace(SKILL_GUIDE_HEADING, guides.skillGuide);
  replace(TOOL_GUIDE_HEADING, guides.toolUsageGuide);

  if (appended) {
    const missing = [
      ...(sections.some((section) => section.heading === SKILL_GUIDE_HEADING) ? [] : [guides.skillGuide]),
      ...(sections.some((section) => section.heading === TOOL_GUIDE_HEADING) ? [] : [guides.toolUsageGuide]),
    ];
    const rulesIndex = sections.findIndex((section) => section.heading === RULES_HEADING);
    const inserted: PromptSection[] = missing.map((guide) => ({ heading: guide.split('\n')[0]?.slice(2).trim() ?? '', lines: [...guide.split('\n'), ''] }));
    if (rulesIndex === -1) sections.push(...inserted.map((section) => ({ heading: section.heading, lines: ['', ...section.lines.slice(0, -1)] })));
    else sections.splice(rulesIndex, 0, ...inserted);
  }

  return { systemPrompt: [...preamble, ...sections.flatMap((section) => section.lines)].join('\n'), strategy: appended ? 'appended' : 'spliced' };
}

/** `generateToolWithRepair` が使う協働者（Stage 2の修復ループと同じ4点セット）。 */
export interface ToolRepairLoopDeps {
  readonly toolSmith: ToolSmithRole;
  readonly resolveDataSources: ResolveDataSourceGraphUseCase;
  readonly engine: EtlEngine;
  readonly saveTool: SaveToolUseCase;
}

/** 保存するToolの識別情報。試行ごとに払い出す（再試行では新しい internalId を採る）。 */
export interface ToolSaveIdentity {
  readonly internalId: ToolId;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
}

export interface ToolRepairLoopRequest {
  readonly scope: TenantScope;
  readonly toolPlan: FactoryToolPlan;
  readonly profile: DataProfile;
  /** 呼び出し側が既に read-only/session-write へ解決済みの副作用（強制/却下の方針は呼び出し側の責務）。 */
  readonly sideEffect: SideEffect;
  readonly maxRepairAttempts: number;
  /** グラフ検証を通過し保存直前になった時点でのみ呼ばれる（idの払い出しを無駄にしない）。 */
  readonly identity: () => ToolSaveIdentity;
  readonly onAttemptFailed?: (info: { readonly attempt: number; readonly attempts: number; readonly message: string }) => void;
  /** Run の中断シグナル。ToolSmith へ渡し、中断は「失敗した試行」として再提案へ回さず `FactoryAbortedError` で抜ける。 */
  readonly signal?: AbortSignal;
}

export interface ToolRepairLoopResult {
  /** 保存できたTool。修復上限まで失敗した場合は未設定。 */
  readonly tool?: Tool;
  /** 消費したToolSmith呼び出し回数（試行回数と同じ）。 */
  readonly roleCallsUsed: number;
  /** 最後の試行の失敗理由（`tool` が未設定のときに設定される）。 */
  readonly lastError?: string;
}

/**
 * Tool 1件を「ToolSmith提案 → 正規化 → データソース解決 → スキーマ伝播/プレビュー検証 →
 * `SaveToolUseCase`」で作る修復ループ（docs/16-agent-factory.md §4 Stage 2）。
 *
 * Stage 2の新規生成（`GenerateAgentAssetsUseCase`）と改善ループの `add-tool` 適用
 * （`ApplyImprovementsUseCase`）の両方から使う。同じ規律を1箇所に閉じ込めるための共有ヘルパで、
 * イベント発行・欠落時の扱い（続行するか却下するか）は呼び出し側の責務として外に出している。
 */
export async function generateToolWithRepair(deps: ToolRepairLoopDeps, request: ToolRepairLoopRequest): Promise<ToolRepairLoopResult> {
  const attempts = 1 + Math.max(0, request.maxRepairAttempts);
  let priorError: string | undefined;
  let roleCallsUsed = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(request.signal);
    roleCallsUsed += 1;
    try {
      const proposal = await deps.toolSmith.propose({ toolPlan: request.toolPlan, profile: request.profile, ...(priorError === undefined ? {} : { priorError }) }, request.signal);
      throwIfAborted(request.signal);
      const graph = makeArgumentsOptional(mergeAgentInputDeclarations(proposal.graph));
      // ノード語彙・単一チェーンの構造検査（エンジンより手前で、修復の当て先が分かる文面で返す）。
      const shapeViolation = describeGraphShapeViolations(graph, {
        sourceType: request.profile.format === 'json' ? 'json-source' : 'csv-source',
        dataSourceId: request.toolPlan.dataSourceId,
      });
      if (shapeViolation !== undefined) throw new FactoryValidationError(shapeViolation);
      const resolvedGraph = await deps.resolveDataSources.execute(request.scope, graph);
      const propagation = deps.engine.propagateSchemas(resolvedGraph);
      if (propagation.hasErrors) throw new FactoryValidationError(describePropagationErrors(propagation));
      const designTimePreview = deps.engine.preview(resolvedGraph);

      const inputSchema = agentToolArgumentsOf(graph);
      // 意味の検査（証拠列の保全・期間引数の型と範囲・時系列の並べ替え）。構造が通ってスキーマが
      // 確定して初めて列の型と終端スキーマが引けるので、ここで回す（ADR-0047 round 2）。
      const semanticViolation = describeToolSemanticViolations({ graph, profile: request.profile, toolPlan: request.toolPlan, inputSchema, propagation });
      if (semanticViolation !== undefined) throw new FactoryValidationError(semanticViolation);
      // 設計時プレビューは agent-input の sample を束縛した「引数を全部渡した呼び出し」でしかない。
      // 実際にエージェントが最初にやるのは「引数なしの呼び出し」なので、実行時と同じ `graphWithArguments`
      // で全引数を省略した2本目のプレビューを回し、終端 agent-output が溢れないことまで確かめる（ADR-0047）。
      const overflow = await describeDefaultCallOverflow(deps, request.scope, graph, inputSchema, designTimePreview);
      if (overflow !== undefined) throw new FactoryValidationError(overflow);
      const identity = request.identity();
      const tool = await deps.saveTool.execute({
        scope: request.scope,
        internalId: identity.internalId,
        workingName: identity.workingName,
        displayName: identity.displayName,
        publishName: identity.publishName,
        owner: identity.owner,
        sideEffect: request.sideEffect,
        graph,
        ...(inputSchema === undefined ? {} : { inputSchema }),
        agentTool: proposal.agentTool,
      });
      return { tool, roleCallsUsed };
    } catch (error) {
      // 中断は修復対象の失敗ではない: 次の試行（= 次のモデル呼び出し）へ進まず、そのまま打ち切る。
      // モデルadapterが中断を自前の例外で報告してきた場合も signal を見て同じ扱いにする。
      if (error instanceof FactoryAbortedError) throw error;
      throwIfAborted(request.signal);
      const message = error instanceof Error ? error.message : String(error);
      priorError = message;
      request.onAttemptFailed?.({ attempt, attempts, message });
    }
  }

  return { roleCallsUsed, ...(priorError === undefined ? {} : { lastError: priorError }) };
}

/** Tool引数として宣言できる列型（Tool Callingの引数へそのまま写せるものだけ）。 */
const AGENT_ARGUMENT_TYPES: readonly string[] = ['string', 'number', 'boolean', 'date'];

/** ToolSmithが置いてよいsourceノード種別（計画のデータソース形式で1つに決まる）。 */
const TOOL_SOURCE_TYPES: readonly string[] = ['csv-source', 'json-source'];
/** データ経路の外に置く宣言ノード / 終端。 */
const TOOL_ARGUMENT_NODE_TYPE = 'agent-input';
const TOOL_SINK_TYPE = 'agent-output';

/**
 * ToolSmithの提案グラフが Stage 2 の構造契約（docs/16 §4 Stage 2）を満たすかを決定的に検査する。
 * 違反があれば**修復ループへそのまま渡せる文面**（何が違反で、どう直すか）を返す。
 *
 * エンジン（`propagateSchemas` / `preview`）は閉路・入次数・終端数は見るが「どのノード型を使ってよいか」
 * 「source が計画どおりのデータソースを読んでいるか」「データ経路が枝分かれしていないか」は見ない。
 * そこを外すと、実測では join や database-source を混ぜた提案や、agent-input をチェーンへ繋いだ提案が
 * 曖昧なスキーマエラーだけを返して修復が空回りした（ADR-0047）。
 */
export function describeGraphShapeViolations(
  graph: ToolGraph,
  expected: { readonly sourceType: string; readonly dataSourceId: string },
): string | undefined {
  const allowed = new Set<string>([expected.sourceType, TOOL_ARGUMENT_NODE_TYPE, TOOL_SINK_TYPE, ...SAFE_TRANSFORM_TYPES]);
  const problems: string[] = [];

  const unknownTypes = [...new Set(graph.nodes.filter((node) => !allowed.has(node.type)).map((node) => node.type))];
  if (unknownTypes.length > 0) {
    problems.push(`node type(s) not allowed: ${unknownTypes.join(', ')}. Use only '${expected.sourceType}' for the source, one of ${SAFE_TRANSFORM_TYPES.join(', ')} for transforms, '${TOOL_ARGUMENT_NODE_TYPE}' to declare the tool arguments, and '${TOOL_SINK_TYPE}' as the single terminal node`);
  }

  const sources = graph.nodes.filter((node) => TOOL_SOURCE_TYPES.includes(node.type));
  if (sources.length !== 1) {
    problems.push(`the graph must contain exactly one source node of type '${expected.sourceType}', found ${sources.length}`);
  } else {
    const source = sources[0]!;
    if (source.type !== expected.sourceType) {
      problems.push(`the source node '${source.id}' has type '${source.type}', but this data source is ${expected.sourceType === 'json-source' ? 'JSON' : 'CSV'}: use '${expected.sourceType}'`);
    }
    const dataSourceId = (source.config as { dataSourceId?: unknown } | null)?.dataSourceId;
    if (expected.dataSourceId !== '' && dataSourceId !== expected.dataSourceId) {
      problems.push(`the source node '${source.id}' must read config.dataSourceId "${expected.dataSourceId}" exactly, got ${JSON.stringify(dataSourceId ?? null)}`);
    }
  }

  const sinks = graph.nodes.filter((node) => node.type === TOOL_SINK_TYPE);
  if (sinks.length !== 1) {
    problems.push(`the graph must end in exactly one '${TOOL_SINK_TYPE}' node, found ${sinks.length}`);
  }

  // データ経路は source → … → agent-output の単一チェーン。agent-input はその外側（未接続）に置く。
  const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  for (const node of graph.nodes.filter((node) => node.type === TOOL_ARGUMENT_NODE_TYPE)) {
    if (connected.has(node.id)) {
      problems.push(`the '${TOOL_ARGUMENT_NODE_TYPE}' node '${node.id}' must stay unconnected: it declares the tool call parameters, it is not a data source. Remove every edge that starts or ends at it`);
    }
  }
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const branching = [...outDegree.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const merging = [...inDegree.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (branching.length > 0 || merging.length > 0) {
    problems.push(`the data path must be a single linear chain from the source to '${TOOL_SINK_TYPE}': ${[...branching.map((id) => `node '${id}' feeds more than one node`), ...merging.map((id) => `node '${id}' receives more than one input`)].join('; ')}`);
  }
  const chainNodes = graph.nodes.filter((node) => node.type !== TOOL_ARGUMENT_NODE_TYPE);
  const orphans = chainNodes.filter((node) => !connected.has(node.id)).map((node) => node.id);
  if (chainNodes.length > 1 && orphans.length > 0) {
    problems.push(`node(s) ${orphans.join(', ')} are not connected to the data path; every node except the '${TOOL_ARGUMENT_NODE_TYPE}' declaration must sit on the chain`);
  }

  return problems.length === 0 ? undefined : `tool graph shape is invalid: ${problems.join('. ')}`;
}

/** 集計してしまうノード（行がそのまま出てこないので、証拠列・並べ替えの検査対象から外す）。 */
const AGGREGATING_NODE_TYPES: readonly string[] = ['summary-statistics', 'group-by'];
/** 行をそのまま載せる `agent-output.shape`（ここだけが「証拠列が残っているか」を問える形）。 */
const ROW_SHAPES: readonly string[] = ['rows', 'first-row'];
/** 下限・上限の比較演算子（同じ引数を両方へ束縛すると「範囲」ではなく完全一致になる）。 */
const LOWER_BOUND_OPS: readonly string[] = ['gt', 'gte'];
const UPPER_BOUND_OPS: readonly string[] = ['lt', 'lte'];
/**
 * 「最新・直近」を求める計画かを見るキーワード。並べ替えの向き（desc）を強制する条件で、
 * ここに無い言い回しは強制しない（取りこぼしはプロンプト規則が拾う）。
 */
const LATEST_INTENT_PATTERN = /最新|直近|最近|latest|most recent|newest/i;

/** 値バインドされた filter 条件 1 件（引数名・対象列・設計時の演算子）。 */
interface BoundConditionSite {
  readonly field: string;
  readonly column: string;
  readonly op: string;
}

/** filter config（フラット1条件 / `conditions` 配列）から、valueBinding を持つ条件を取り出す。 */
function boundConditionsOf(config: unknown): BoundConditionSite[] {
  const raw = (config as { conditions?: unknown } | null)?.conditions;
  const conditions: unknown[] = Array.isArray(raw) ? raw : [config];
  const sites: BoundConditionSite[] = [];
  for (const condition of conditions) {
    if (condition === null || typeof condition !== 'object') continue;
    const record = condition as { column?: unknown; op?: unknown; valueBinding?: { source?: unknown; field?: unknown } };
    const binding = record.valueBinding;
    if (binding?.source !== 'agent-input' || typeof binding.field !== 'string' || binding.field === '') continue;
    sites.push({
      field: binding.field,
      column: typeof record.column === 'string' ? record.column : '',
      op: typeof record.op === 'string' ? record.op : 'eq',
    });
  }
  return sites;
}

export interface ToolSemanticContext {
  readonly graph: ToolGraph;
  readonly profile: DataProfile;
  readonly toolPlan: FactoryToolPlan;
  /** `agentToolArgumentsOf` で導出済みの引数スキーマ（引数なしToolは undefined）。 */
  readonly inputSchema: Schema | undefined;
  /** `EtlEngine.propagateSchemas` の結果（列の型と終端スキーマを引く）。 */
  readonly propagation: PropagationResult;
}

/**
 * 生成Toolの**意味**の検査（ADR-0047 round 2）。構造（`describeGraphShapeViolations`）とエンジンの
 * スキーマ検証を通っても、「答えに使えないTool」はできてしまう。実測で起きた3つを決定的に塞ぐ。
 *
 * A. 証拠列の欠落: `select` が `時点` を落としたため、エージェントは期間を引用できず
 *    「2023年12月 14,212,596人」と年次データに無い月を作文した。期間ラベル列の保全は**必須検査**、
 *    注記列の保全はプロンプト規則（目的次第で落として良い場合があるため）。
 * B. 範囲が引けない: 同じ引数を gte と lte の両方へ束縛した「完全一致の変装」、`date` 列に
 *    `string` 引数、期間列を扱うのに `sort` が無い（「最新」が出せない）。
 *
 * 違反は修復ループへそのまま渡せる文面（何が違反で、どう直すか）で返す。
 */
export function describeToolSemanticViolations(context: ToolSemanticContext): string | undefined {
  const { graph, profile, toolPlan, inputSchema, propagation } = context;
  const problems: string[] = [];

  const sink = graph.nodes.find((node) => node.type === TOOL_SINK_TYPE);
  const shape = (sink?.config as { shape?: unknown } | null)?.shape;
  const rowShaped = sink !== undefined && (shape === undefined || ROW_SHAPES.includes(String(shape)));
  const aggregates = graph.nodes.some((node) => AGGREGATING_NODE_TYPES.includes(node.type));
  const terminalSchema = propagation.nodes[propagation.terminalId]?.schema;
  const terminalColumns = new Set((terminalSchema?.columns ?? []).map((column) => column.name));
  const parsePeriod = graph.nodes.find((node) => node.type === PARSE_PERIOD_TYPE);
  const parsePeriodConfig = (parsePeriod?.config ?? {}) as { column?: unknown; startColumn?: unknown };
  const startColumn = typeof parsePeriodConfig.startColumn === 'string' && parsePeriodConfig.startColumn !== ''
    ? parsePeriodConfig.startColumn
    : 'periodStart';

  // ── A. 行を返すToolは、答えの根拠になる列を落としてはならない ───────────────────────────
  if (rowShaped && !aggregates && profile.periodColumns.length > 0) {
    // parse-period が読んだ列を最優先に見る（無ければプロファイルが検出した期間列のいずれか）。
    const required = typeof parsePeriodConfig.column === 'string' && parsePeriodConfig.column !== ''
      ? [parsePeriodConfig.column]
      : profile.periodColumns.map((column) => column.column);
    if (!required.some((column) => terminalColumns.has(column))) {
      problems.push(`the rows this tool returns do not contain the period column ${required.map((column) => `'${column}'`).join(' or ')}, so the agent cannot state WHEN a number is from and will invent a period. Keep that original label column in the output (add it to select.columns, or drop the select node). Adding '${startColumn}' is not a replacement: the agent quotes the label the data uses`);
    }
    // 値の列（数値）も一緒に落ちていれば、そもそも答えるものが無い。
    const numericSourceColumns = profile.columns.filter((column) => column.type === 'number').map((column) => column.name);
    if (numericSourceColumns.length > 0 && !graph.nodes.some((node) => node.type === 'distinct')
      && !numericSourceColumns.some((column) => terminalColumns.has(column))) {
      problems.push(`the rows this tool returns contain none of the value columns (${numericSourceColumns.map((column) => `'${column}'`).join(', ')}), so there is no number to answer with. Keep at least the value column the purpose asks about`);
    }
  }

  // ── B. 期間を「範囲」で引けること ────────────────────────────────────────────────────
  const declared = new Map((inputSchema?.columns ?? []).map((column) => [column.name, column] as const));
  const bound = graph.nodes
    .filter((node) => node.type === 'filter')
    .flatMap((node) => boundConditionsOf(node.config).map((site) => ({ ...site, nodeId: node.id })));

  // B1: date 列を絞る引数は date 型で宣言する（string だと ISO 文字列の比較が文字列比較になる）。
  for (const site of bound) {
    const columnType = propagation.nodes[site.nodeId]?.schema.columns.find((column) => column.name === site.column)?.type;
    const argument = declared.get(site.field);
    if (columnType !== 'date' || argument === undefined || argument.type === 'date') continue;
    problems.push(`argument '${site.field}' filters the date column '${site.column}' but is declared "type": "${argument.type}". Declare it as { "name": "${site.field}", "type": "date", "nullable": true }: the agent then passes an ISO date such as "2008-01-01" and the tool compares dates, not text`);
  }

  // B2: 同じ引数を下限と上限の両方へ束縛すると、範囲ではなく完全一致になる。
  for (const [field, sites] of groupBy(bound, (site) => site.field)) {
    const lower = sites.filter((site) => LOWER_BOUND_OPS.includes(site.op));
    const upper = sites.filter((site) => UPPER_BOUND_OPS.includes(site.op));
    if (lower.length === 0 || upper.length === 0) continue;
    problems.push(`argument '${field}' is bound to both a lower bound (${lower[0]?.op}) and an upper bound (${upper[0]?.op}) on '${lower[0]?.column}', which only ever matches one exact point in time — a range is impossible. Declare TWO nullable arguments instead (for example '${field}_from' bound to the gte condition and '${field}_to' bound to the lte condition), so the agent can ask for a span, for one end of it, or for neither`);
  }

  // B3: 期間を開いたなら、開始日で並べ替えてから絞る（並べ替えが無いと「最新」が取れない）。
  if (parsePeriod !== undefined && rowShaped && !aggregates) {
    const sortKeys = graph.nodes
      .filter((node) => node.type === 'sort')
      .flatMap((node) => {
        const keys = (node.config as { keys?: unknown } | null)?.keys;
        return Array.isArray(keys) ? keys as { column?: unknown; direction?: unknown }[] : [];
      });
    const onStart = sortKeys.filter((key) => key.column === startColumn);
    if (onStart.length === 0) {
      problems.push(`this tool parses periods but never sorts by '${startColumn}', so the rows it returns are in file order and the agent cannot tell which period is the latest. Add a 'sort' node with { "keys": [{ "column": "${startColumn}", "direction": "desc" }] } before the limit / ${TOOL_SINK_TYPE}, so that omitting the date arguments returns the most recent periods first`);
    } else if (LATEST_INTENT_PATTERN.test(`${toolPlan.displayName} ${toolPlan.purpose} ${toolPlan.argumentSummary ?? ''} ${toolPlan.outputShape ?? ''}`)
      && !onStart.some((key) => key.direction === 'desc')) {
      problems.push(`this tool is meant to answer about the latest period, but it sorts '${startColumn}' ascending, so a limit keeps the OLDEST rows. Use { "column": "${startColumn}", "direction": "desc" }`);
    }
  }

  return problems.length === 0 ? undefined : `tool cannot answer the plan: ${problems.join('. ')}`;
}

/** 小さな groupBy（このファイル内の検査だけで使う）。 */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket === undefined) grouped.set(key(item), [item]);
    else bucket.push(item);
  }
  return grouped;
}

/**
 * 「引数を1つも渡さない呼び出し」で終端 `agent-output` が溢れないかを、実行時と同じ束縛で確かめる。
 *
 * 溢れる（`shape: 'rows'` かつ `overflow: 'error'` で `rows > maxRows`）なら、修復ループへ渡す
 * 具体的な直し方を添えた文面を返す。Factory生成Toolの引数はすべて省略可能（`makeArgumentsOptional`）
 * なので、「既定の呼び出し = 全引数省略」で必ず成立していなければならない。
 */
async function describeDefaultCallOverflow(
  deps: Pick<ToolRepairLoopDeps, 'engine' | 'resolveDataSources'>,
  scope: TenantScope,
  graph: ToolGraph,
  inputSchema: Schema | undefined,
  designTimePreview: PreviewResult,
): Promise<string | undefined> {
  const sink = graph.nodes.find((node) => node.type === TOOL_SINK_TYPE);
  if (sink === undefined) return undefined;
  const config = (sink.config ?? {}) as { shape?: unknown; maxRows?: unknown; overflow?: unknown };
  // 行をそのまま返す形だけが溢れる（summary / first-row / single-value は件数か1行しか載せない）。
  if (config.overflow !== 'error') return undefined;
  if (config.shape !== undefined && config.shape !== 'rows') return undefined;
  const maxRows = typeof config.maxRows === 'number' && Number.isFinite(config.maxRows) ? config.maxRows : 100;

  let preview = designTimePreview;
  if (inputSchema !== undefined && inputSchema.columns.length > 0) {
    try {
      // 実行時（`RunAgentPreviewUseCase`）と同じ経路: 引数を空オブジェクトで正規化し、グラフへ束縛する。
      const row = validateToolArguments(inputSchema, {});
      const defaultCallGraph = graphWithArguments({ graph, inputSchema } as unknown as Tool, row);
      preview = deps.engine.preview(await deps.resolveDataSources.execute(scope, defaultCallGraph));
    } catch {
      // 引数宣言そのものが壊れている（未宣言fieldへのbinding等）ケース。ここで握りつぶすのは、直後の
      // `SaveToolUseCase` が同じ不整合をより具体的な文言で拒否し、そちらを修復フィードバックにしたいため。
      // この関数の責務は「溢れるかどうか」だけに閉じる。
      return undefined;
    }
  }
  const rowCount = preview.nodes[sink.id]?.rowCount ?? preview.fullOutput.rows.length;
  if (rowCount <= maxRows) return undefined;
  return `calling this tool with no arguments returns ${rowCount} rows, which overflows the terminal '${TOOL_SINK_TYPE}' (maxRows ${maxRows}, overflow "error"), so the very first tool call the agent makes fails. Every declared argument is optional at run time, so the tool must bound its own output: append a 'limit' node with count <= ${maxRows} at the end of the chain (put a 'sort' before it so the rows that are kept are the meaningful ones), or aggregate the rows with 'summary-statistics', or set the ${TOOL_SINK_TYPE} "shape" to "summary".`;
}

/**
 * 未接続の `agent-input` ノードが宣言する Tool引数スキーマを取り出す（宣言が無ければ `undefined`）。
 *
 * これを `SaveToolUseCase.inputSchema` に渡すことで Tool Calling契約（`toolToModelDefinition` が
 * inputSchema から導出するJSON Schema）と Tool使用ガイドの `input [...]` 表記が引数付きになり、
 * 実行時は `RunAgentPreviewUseCase` が filter条件の `valueBinding`（値）/ `opBinding`（演算子）を
 * 実引数へ差し替える。
 *
 * 宣言が壊れている場合は `FactoryValidationError` を投げ、呼び出し側の修復ループへ回す:
 * - agent-input が2つ以上（実行時に inputSchema と一致検査するノードは1つに限る）
 * - schema.columns / sample が無い、引数型が扱えない、非nullable引数のサンプル値が無い
 * - 宣言したのに filter の valueBinding / opBinding のどちらからも参照されない引数がある
 *   （エージェントに無意味な引数を要求しない）
 *
 * サンプル値の型不一致は `EtlEngine.propagateSchemas`/`preview`（agent-input ノード自身の検証）が
 * 先に検出するため、ここでは存在確認だけを行う。
 */
/**
 * Factory生成Toolの全引数を省略可能(nullable)へ正規化する。ローカルモデルはnullable宣言の
 * 指示に従わないことがあり（実測: 全引数をnullable: falseで宣言）、read-only検索Toolでは
 * 「全引数optional・省略した条件は実行時にスキップされ全件が対象」が一貫した契約として
 * 望ましいため、プロンプトに頼らず決定的に強制する。sampleは変更しない（プレビューの
 * 決定性を保つ）。手作りToolビルダーの保存経路には影響しない（Factory生成/改訂のみ）。
 */
export function makeArgumentsOptional(graph: ToolGraph): ToolGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.type !== 'agent-input') return node;
    const config = (node.config ?? {}) as { schema?: { columns?: unknown }; sample?: unknown };
    const columns = config.schema?.columns;
    if (!Array.isArray(columns) || columns.length === 0) return node;
    const optionalColumns = columns.map((column) =>
      column !== null && typeof column === 'object' ? { ...(column as Record<string, unknown>), nullable: true } : column);
    changed = true;
    return { ...node, config: { ...config, schema: { ...(config.schema ?? {}), columns: optionalColumns } } };
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}

/**
 * 計画の `reuse.internalId` をカタログから寛容に解決する。モデルは internalId と publishName /
 * Tool契約名を混同しやすい（実測: `builtin-current-datetime` を `builtin-current_datetime` と書く）ため、
 * 完全一致(internalId → publishName → toolName) → 正規化一致(小文字化+英数字以外を除去)の順で探す。
 * 正規化一致が複数候補に当たる場合は誤参照を避けるため解決しない。
 */
export function resolveReuseTarget(catalog: readonly ExistingToolCatalogEntry[], requested: string): ExistingToolCatalogEntry | undefined {
  const exact = catalog.find((entry) => entry.internalId === requested)
    ?? catalog.find((entry) => entry.publishName === requested)
    ?? catalog.find((entry) => entry.toolName === requested);
  if (exact !== undefined) return exact;
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = normalize(requested);
  if (wanted === '') return undefined;
  const matches = catalog.filter((entry) =>
    normalize(entry.internalId) === wanted || normalize(entry.publishName) === wanted || normalize(entry.toolName) === wanted);
  const unique = new Set(matches.map((entry) => entry.internalId));
  return unique.size === 1 ? matches[0] : undefined;
}

/**
 * モデルが「引数1つにつき agent-input ノード1つ」と誤解して複数ノードを生成するケースを
 * 決定的に正規化する: **未接続の** agent-input が2つ以上あれば、schema.columns と sample を
 * 先勝ちマージして1ノードへ統合する（同名列は先の宣言を採用）。エッジで接続された agent-input が
 * 混ざっている場合はデータ経路を変えないよう正規化を行わず、そのまま検証エラーに委ねる。
 */
export function mergeAgentInputDeclarations(graph: ToolGraph): ToolGraph {
  const declarations = graph.nodes.filter((node) => node.type === 'agent-input');
  if (declarations.length <= 1) return graph;
  const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  if (declarations.some((node) => connected.has(node.id))) return graph;

  const mergedColumns: unknown[] = [];
  const seenNames = new Set<string>();
  const mergedSample: Record<string, unknown> = {};
  for (const node of declarations) {
    const config = (node.config ?? {}) as { schema?: { columns?: unknown }; sample?: unknown };
    const columns = Array.isArray(config.schema?.columns) ? config.schema.columns : [];
    for (const column of columns) {
      const name = (column as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || seenNames.has(name)) continue;
      seenNames.add(name);
      mergedColumns.push(column);
    }
    const sample = config.sample;
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
      for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(mergedSample, key)) mergedSample[key] = value;
      }
    }
  }

  const first = declarations[0]!;
  const rest = new Set(declarations.slice(1).map((node) => node.id));
  return {
    nodes: graph.nodes
      .filter((node) => !rest.has(node.id))
      .map((node) => node.id === first.id ? { ...node, config: { schema: { columns: mergedColumns }, sample: mergedSample } } : node),
    edges: graph.edges,
  };
}

export function agentToolArgumentsOf(graph: ToolGraph): Schema | undefined {
  const declarations = graph.nodes.filter((node) => node.type === 'agent-input');
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new FactoryValidationError('tool graph declares Tool arguments more than once: keep exactly one agent-input node');
  }
  const config = (declarations[0]?.config ?? {}) as { schema?: { columns?: unknown }; sample?: unknown };
  const columns = config.schema?.columns;
  const sample = config.sample;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new FactoryValidationError('agent-input node must declare config.schema.columns with at least one argument');
  }
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
    throw new FactoryValidationError('agent-input node must declare a config.sample object with one representative value per argument');
  }
  const schema: Schema = { columns: columns.map((column) => toArgumentColumn(column, sample as Record<string, unknown>)) };
  const bound = new Set(graph.nodes.filter((node) => node.type === 'filter').flatMap((node) => agentInputBindingFields(node.config)));
  const unused = schema.columns.filter((column) => !bound.has(column.name)).map((column) => column.name);
  if (unused.length > 0) {
    throw new FactoryValidationError(`agent-input argument(s) never used by a filter: ${unused.join(', ')}. Bind each argument with valueBinding { "source": "agent-input", "field": "<argument name>" } (or opBinding for an operator argument)`);
  }
  return schema;
}

/** agent-input の宣言列1つを Tool引数の列へ写す（型・サンプル値の存在を検査する）。 */
function toArgumentColumn(raw: unknown, sample: Record<string, unknown>): Column {
  const column = (raw ?? {}) as { name?: unknown; type?: unknown; nullable?: unknown };
  if (typeof column.name !== 'string' || column.name.trim() === '') {
    throw new FactoryValidationError('agent-input argument requires a non-empty name');
  }
  if (typeof column.type !== 'string' || !AGENT_ARGUMENT_TYPES.includes(column.type)) {
    throw new FactoryValidationError(`agent-input argument '${column.name}' must use type ${AGENT_ARGUMENT_TYPES.join('|')}`);
  }
  const nullable = column.nullable === true;
  if (!nullable && !Object.prototype.hasOwnProperty.call(sample, column.name)) {
    throw new FactoryValidationError(`agent-input sample is missing a representative value for '${column.name}'`);
  }
  return { name: column.name, type: column.type as Column['type'], nullable };
}

/**
 * filter config（旧形式のフラット1条件 / 新形式の conditions）が valueBinding（値）/
 * opBinding（演算子）で参照する agent-input のfield名。走査は domain の
 * `valueBindingsOf` / `operatorBindingsOf`（実行時に差し替わる対象・保存検証と同じ集合）へ委譲する。
 * opBinding だけで消費される演算子引数も「filter から参照される引数」なので、
 * 未使用引数エラーの対象から外れる。
 */
function agentInputBindingFields(config: unknown): string[] {
  return [
    ...valueBindingsOf(config).map((site) => site.field),
    ...operatorBindingsOf(config).map((site) => site.field),
  ];
}

function describePropagationErrors(propagation: PropagationResult): string {
  const messages = Object.values(propagation.nodes)
    .flatMap((node) => node.issues.filter((issue) => issue.severity === 'error').map((issue) => `${node.nodeId}: ${issue.message}`))
    .join('; ');
  return `graph validation failed: ${messages}`;
}

/**
 * 決定的slug（a-z0-9_のみ）+ runId由来の短い連番でFactory生成物のpublishName衝突を避ける（docs/16 §8）。
 * `run-factory.ts` のStage 5（Persona/Scenario materialize）でも同じ命名規約を再利用する。
 */
export function slugify(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'asset';
}

export function makePublishName(kind: 'tool' | 'skill' | 'agent' | 'persona' | 'scenario', displayName: string, runId: string, key: string): string {
  const runSuffix = slugify(runId).slice(-8) || 'run';
  return `factory_${kind}_${slugify(displayName)}_${slugify(key)}_${runSuffix}`.slice(0, 80);
}

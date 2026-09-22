/**
 * application層: 段階的ツール生成のオーケストレーション（v42 実装契約 §5-§7 / ADR-0048）。
 *
 * 1 本の Tool を「小さな目的別タスク → 宣言的な仕様（`ToolSpec`）→ 決定的コンパイラ → 式の作成 →
 * 既存の決定的検査」の順で作る。モデルが書くのは**決定だけ**（何で絞るか・何を計算したいか・
 * 何を返すか）で、グラフの JSON は 1 バイトも書かせない。
 *
 * 失敗したときの扱いが、この file の肝である:
 * - 検査の違反は**担当タスクへ 1 回だけ**差し戻す（v42 §6 の対応表）。どのタスクの決定でもない違反
 *   （コンパイラのバグ）は差し戻さずに諦める。
 * - 式が書けなかった計算列は**その列だけ**落として、ツールは作る（ツール全体を落とさない）。
 * - 諦めるときも例外にせず `ok: false` を返す。呼び出し側（`GenerateAgentAssetsUseCase`）が
 *   従来の一括 ToolSmith へフォールバックできるようにするため。中断（`FactoryAbortedError`）だけは
 *   そのまま抜ける（cancel 後に新しいモデル呼び出しへ進まない）。
 */
import { FactoryAbortedError } from '../../domain/factory/errors';
import {
  MAX_TOOL_SPEC_LIMIT,
  TOOL_SPEC_VERSION,
  validateToolSpec,
  type ToolSpec,
  type ToolSpecCategoryFilter,
  type ToolSpecComputation,
  type ToolSpecIssue,
  type ToolSpecJoin,
  type ToolSpecOutput,
  type ToolSpecPeriod,
  type ToolSpecTaskName,
} from '../../domain/factory/tool-spec';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { ModelProviderPort } from '../model/model-provider';
import type { PromptCatalogPort } from '../prompt/prompt-catalog-port';
import type { SuggestCalculateExpressionUseCase } from '../tool/suggest-calculate-expression';
import { throwIfAborted } from './abort';
import {
  COMPILED_EXTRA_TRANSFORM_TYPES,
  columnsAfterJoinAndCompute,
  compileToolSpec,
  toolSpecContextOf,
  toolSpecProfilesOf,
  withExpression,
  withoutComputation,
  type CompiledTool,
} from './compile-tool-spec';
import { describeCompiledToolViolations, type CompiledToolCheckViolation } from './generate-agent-assets';
import { JOIN_NODE_TYPE } from './roles/tool-smith-role';
import type { StagedToolGenerationPort, StagedToolGenerationRequest, StagedToolResult } from './staged-tool-port';
import {
  decideComputationsTaskOf,
  decideFiltersTaskOf,
  decideJoinTaskOf,
  decideOutputTaskOf,
  runRoleTask,
  type RoleTask,
} from './tasks';

export type { StagedToolGenerationPort, StagedToolGenerationRequest, StagedToolResult } from './staged-tool-port';

/** `maxRepairAttempts` を渡されなかったときの既定（`DEFAULT_FACTORY_BUDGET_LIMITS` と同じ）。 */
const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/** `decide-output` の前に列一覧を数えるためだけの仮の出力（`toolSpecColumns` は output を見ない）。 */
const PLACEHOLDER_OUTPUT: ToolSpecOutput = { columns: [], sort: 'none', limit: MAX_TOOL_SPEC_LIMIT };

/**
 * 省略できない引数（段階的経路では `granularity`）へ渡す設計時サンプル。
 *
 * 必須引数を持つ Tool に「引数なしの呼び出し」は存在しない（実行前に弾かれる）ので、
 * 溢れガードは**必須引数だけをサンプル値で埋めた呼び出し**で見る（v42 実装時の確定事項）。
 */
function requiredArgumentsOf(compiled: CompiledTool): Record<string, unknown> {
  const required = (compiled.inputSchema?.columns ?? []).filter((column) => !column.nullable).map((column) => column.name);
  if (required.length === 0) return {};
  const declaration = compiled.graph.nodes.find((node) => node.type === 'agent-input');
  const sample = ((declaration?.config ?? {}) as { sample?: Record<string, unknown> }).sample ?? {};
  const args: Record<string, unknown> = {};
  for (const name of required) {
    if (Object.prototype.hasOwnProperty.call(sample, name)) args[name] = sample[name];
  }
  return args;
}

/**
 * 決定的検査の違反を「どのタスクの決定が悪いか」へ引く（v42 §6 の対応表）。
 *
 * - 溢れ → `decide-output`（`limit`）。それでも溢れるなら呼び出し側が `decide-filters` へ回す。
 * - 結合の問題（キーが無い・型が違う・行が増えた）→ `decide-join`。
 * - それ以外（形・スキーマ伝播・証拠列の欠落）は**コンパイラのバグ**なので差し戻さない
 *   （モデルにやり直させても直らない。単体テストで防ぐ側の問題）。
 */
export function routeViolation(violation: CompiledToolCheckViolation, spec: ToolSpec): ToolSpecTaskName | undefined {
  if (violation.kind === 'overflow') return 'decide-output';
  if (violation.kind === 'semantic' && spec.join !== undefined && violation.message.includes(`'${JOIN_NODE_TYPE}' node`)) return 'decide-join';
  return undefined;
}

/** 式の作成で使ったモデル呼び出し回数（ユースケースは失敗しても 1 回、差し戻したら 2 回呼ぶ）。 */
function expressionCallsOf(repaired: boolean): number {
  return repaired ? 2 : 1;
}

export class StagedToolGeneration implements StagedToolGenerationPort {
  constructor(
    private readonly model: ModelProviderPort,
    private readonly engine: EtlEngine,
    /** 計算列の式を書く専用経路（v41）。未注入 / 利用不可なら計算列は全て落とす。 */
    private readonly suggestExpression: SuggestCalculateExpressionUseCase | undefined,
    /** 検査と式の標本行に要る（未注入なら段階的経路は使えない）。 */
    private readonly resolveDataSources: ResolveDataSourceGraphUseCase | undefined,
    /** モデルへ送る文の置き場所（v48）。4 つのタスクの目的文・規則はここから読む。 */
    private readonly prompts: PromptCatalogPort,
  ) {}

  async generate(request: StagedToolGenerationRequest): Promise<StagedToolResult> {
    const resolveDataSources = this.resolveDataSources;
    if (resolveDataSources === undefined) {
      return { ok: false, reason: 'staged tool generation needs a data source resolver, which is not configured' };
    }

    const { plan, goal, scope, signal } = request;
    const onEvent = request.onEvent;
    /** やり直しを1回だけに保つための記録（差し戻し済みのタスク）。 */
    const rerun = new Set<ToolSpecTaskName>();
    /** モデルを2回以上呼んだタスク（内部のやり直し + 差し戻し）。`tool_generated` の注記に出す。 */
    const repairedTasks = new Set<ToolSpecTaskName>();
    const dropped: string[] = [];
    let expressionAttempts = 0;

    let spec: ToolSpec | undefined;
    try {
      const profiles = toolSpecProfilesOf(plan, request.profiles);
      const primary = profiles[0];
      if (primary === undefined) return { ok: false, reason: `tool plan '${plan.key}' has no primary data profile` };
      const context = toolSpecContextOf(plan, request.profiles);
      const joins = (plan.additionalDataSourceIds ?? []).length > 0;

      const decideJoinTask = decideJoinTaskOf(this.prompts);
      const decideFiltersTask = decideFiltersTaskOf(this.prompts);
      const decideComputationsTask = decideComputationsTaskOf(this.prompts);
      const decideOutputTask = decideOutputTaskOf(this.prompts);

      const run = async <I, O>(task: RoleTask<I, O>, input: I, feedback?: string): Promise<O> => {
        throwIfAborted(signal);
        const result = await runRoleTask(this.model, this.prompts, task, input, {
          ...(feedback === undefined ? {} : { feedback }),
          ...(signal === undefined ? {} : { signal }),
          onCall: request.onRoleCall,
        });
        // 段階的経路が回すのは v42 の設計タスクだけ（ランナーの名前はテンプレート経路ぶん広い）。
        if (result.repaired) repairedTasks.add(task.name as ToolSpecTaskName);
        return result.value;
      };

      // ── 1. 決定を集める（結合があるときだけ decide-join を先頭に足す） ──────────────────
      let join: ToolSpecJoin | undefined = joins ? await run(decideJoinTask, { plan, profiles }) : undefined;
      const filters = await run(decideFiltersTask, { plan, goal, profiles });
      let period: ToolSpecPeriod | undefined = filters.period;
      let categoryFilters: readonly ToolSpecCategoryFilter[] = filters.categoryFilters;
      let computations: readonly ToolSpecComputation[] = (await run(decideComputationsTask, { plan, goal, profiles })).computations;

      const buildSpec = (output: ToolSpecOutput): ToolSpec => ({
        version: TOOL_SPEC_VERSION,
        ...(join === undefined ? {} : { join }),
        ...(period === undefined ? {} : { period }),
        categoryFilters,
        computations,
        output,
      });
      const availableColumns = (): string[] => columnsAfterJoinAndCompute(buildSpec(PLACEHOLDER_OUTPUT), plan, request.profiles);
      const decideOutput = async (feedback?: string): Promise<ToolSpecOutput> =>
        run(decideOutputTask, { plan, availableColumns: availableColumns(), estimatedRows: primary.rowCount }, feedback);

      let output = await decideOutput();
      /** 結合・絞り込み・計算をやり直した後、消えた列が `output.columns` に残らないようにする。 */
      const pruneOutputColumns = (): void => {
        const available = new Set(availableColumns());
        output = { ...output, columns: output.columns.filter((column) => available.has(column)) };
      };

      const rerunTask = async (task: ToolSpecTaskName, feedback: string): Promise<void> => {
        rerun.add(task);
        repairedTasks.add(task);
        onEvent(`re-running ${task}: ${feedback}`);
        switch (task) {
          case 'decide-join':
            join = await run(decideJoinTask, { plan, profiles }, feedback);
            pruneOutputColumns();
            return;
          case 'decide-filters': {
            const revised = await run(decideFiltersTask, { plan, goal, profiles }, feedback);
            period = revised.period;
            categoryFilters = revised.categoryFilters;
            pruneOutputColumns();
            return;
          }
          case 'decide-computations':
            computations = (await run(decideComputationsTask, { plan, goal, profiles }, feedback)).computations;
            pruneOutputColumns();
            return;
          case 'decide-output':
            output = await decideOutput(feedback);
            return;
          default:
            // `write-expression` は式の作成側で扱う（ここへは来ない）。
            return;
        }
      };

      /** `validateToolSpec` の違反を担当タスクへ配る。差し戻せなければ理由を返す。 */
      const repairSpec = async (issues: readonly ToolSpecIssue[]): Promise<string | undefined> => {
        const byTask = new Map<ToolSpecTaskName, string[]>();
        for (const issue of issues) {
          const bucket = byTask.get(issue.task);
          if (bucket === undefined) byTask.set(issue.task, [issue.message]);
          else bucket.push(issue.message);
        }
        let progressed = false;
        for (const [task, messages] of byTask) {
          if (rerun.has(task)) continue;
          await rerunTask(task, messages.join(' '));
          progressed = true;
        }
        return progressed
          ? undefined
          : `the tool spec is invalid and every responsible task was already re-run once: ${issues.map((issue) => `${issue.task}: ${issue.message}`).join('; ')}`;
      };

      // ── 2. 「検証を通る spec → コンパイル → 式 → 決定的検査」を予算の範囲で回す ───────────
      const maxCompilations = 1 + Math.max(0, request.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS);
      let lastViolation = '';
      for (let compilation = 1; compilation <= maxCompilations; compilation += 1) {
        spec = buildSpec(output);
        let issues = validateToolSpec(spec, context);
        // 1 タスク 1 回までしか差し戻さないので、このループはタスク数で必ず止まる。
        while (issues.length > 0) {
          const blocked = await repairSpec(issues);
          if (blocked !== undefined) return { ok: false, reason: blocked, spec };
          spec = buildSpec(output);
          issues = validateToolSpec(spec, context);
        }

        const compiled = compileToolSpec(spec, plan, request.profiles, { language: goal.language });
        const filled = await this.fillExpressions({
          compiled, computations, scope, resolveDataSources,
          ...(signal === undefined ? {} : { signal }),
          onRoleCall: request.onRoleCall,
        });
        expressionAttempts += filled.attempts;
        for (const note of filled.dropped) {
          dropped.push(note);
          onEvent(`dropped computation: ${note}`);
        }
        if (filled.kept.length !== computations.length) {
          // 落とした計算列は仕様からも外す（やり直しで同じ式をもう一度頼まないため）。
          computations = filled.kept;
          pruneOutputColumns();
          spec = buildSpec(output);
        }

        const violation = await describeCompiledToolViolations(
          { engine: this.engine, resolveDataSources },
          {
            scope,
            graph: filled.compiled.graph,
            inputSchema: filled.compiled.inputSchema,
            toolPlan: plan,
            profile: primary,
            additionalProfiles: profiles.slice(1),
            extraTransformTypes: COMPILED_EXTRA_TRANSFORM_TYPES,
            requiredArguments: requiredArgumentsOf(filled.compiled),
          },
        );
        if (violation === undefined) {
          return {
            ok: true,
            compiled: filled.compiled,
            spec,
            notes: describeNotes({ joins, expressionAttempts, repairedTasks, dropped }),
          };
        }

        lastViolation = `${violation.kind}: ${violation.message}`;
        let target = routeViolation(violation, spec);
        // 溢れは `limit` を直しても駄目なら、絞り込み（返る行そのもの）を見直す（§6 の対応表）。
        if (target === 'decide-output' && rerun.has('decide-output')) target = 'decide-filters';
        if (target === undefined || rerun.has(target)) {
          return { ok: false, reason: lastViolation, spec };
        }
        // コンパイルの予算を使い切っているなら、やり直しても試せない（モデル呼び出しを無駄にしない）。
        if (compilation === maxCompilations) break;
        await rerunTask(target, violation.message);
      }
      return { ok: false, reason: `gave up after ${maxCompilations} compilations: ${lastViolation}`, ...(spec === undefined ? {} : { spec }) };
    } catch (error) {
      // 中断は失敗ではない（フォールバックへ回さずそのまま抜ける）。
      if (error instanceof FactoryAbortedError) throw error;
      throwIfAborted(signal);
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason, ...(spec === undefined ? {} : { spec }) };
    }
  }

  /**
   * 計算列の式を 1 つずつ埋める（v42 §5）。
   *
   * 式提案ユースケースは渡されたグラフを**そのまま実行して**上流の標本行を取り、提案を当てた版で
   * スキーマ伝播まで確かめる。したがって渡すグラフは
   * 1. データソース解決済み（`csv-source` の中身が読める）で、
   * 2. 対象より**後ろの計算列は落としてある**（式が空のノードが残っていると伝播が必ず落ちる）
   * 必要がある。前の計算列は既に式が入っているのでそのまま残す（上流として正しい）。
   *
   * 辞退・検証失敗・モデル失敗はその計算列だけを落として続ける（ツール全体は作る）。
   */
  private async fillExpressions(input: {
    readonly compiled: CompiledTool;
    readonly computations: readonly ToolSpecComputation[];
    readonly scope: StagedToolGenerationRequest['scope'];
    readonly resolveDataSources: ResolveDataSourceGraphUseCase;
    readonly signal?: AbortSignal;
    readonly onRoleCall: () => void;
  }): Promise<{ readonly compiled: CompiledTool; readonly kept: readonly ToolSpecComputation[]; readonly dropped: readonly string[]; readonly attempts: number }> {
    const dropped: string[] = [];
    const kept: ToolSpecComputation[] = [];
    let current = input.compiled;
    if (current.calculateNodeIds.length === 0) return { compiled: current, kept: [...input.computations], dropped, attempts: 0 };

    const assistant = this.suggestExpression;
    const usable = assistant !== undefined && await assistant.available();
    let attempts = 0;
    let position = 0;

    for (const computation of input.computations) {
      const nodeId = current.calculateNodeIds[position];
      if (nodeId === undefined) {
        // コンパイラが置いたノード数と計算列の数は一致するので、ここへは来ない（防御的）。
        dropped.push(`${computation.outputColumn} (no calculate node was compiled for it)`);
        continue;
      }
      if (!usable || assistant === undefined) {
        current = withoutComputation(current, position);
        dropped.push(`${computation.outputColumn} (the calculate expression assistant is not available)`);
        continue;
      }

      // 対象より後ろの計算列（まだ式が空）を落とした複製で提案させる。
      let probe = current;
      for (let index = probe.calculateNodeIds.length - 1; index > position; index -= 1) probe = withoutComputation(probe, index);

      attempts += 1;
      try {
        throwIfAborted(input.signal);
        const resolved = await input.resolveDataSources.execute(input.scope, probe.graph);
        const proposal = await assistant.execute({ graph: resolved, nodeId, intent: computation.intent }, input.signal);
        for (let call = 0; call < expressionCallsOf(proposal.repaired); call += 1) input.onRoleCall();
        const expression = proposal.config.expression.trim();
        if (expression === '') throw new Error('the assistant returned an empty expression');
        current = withExpression(current, position, expression);
        kept.push(computation);
        position += 1;
      } catch (error) {
        if (error instanceof FactoryAbortedError) throw error;
        throwIfAborted(input.signal);
        const message = error instanceof Error ? error.message : String(error);
        // ユースケースは差し戻しを 1 回だけ使う。使ったかどうかは失敗の文言から決定的に読める。
        for (let call = 0; call < expressionCallsOf(message.includes('after one repair')); call += 1) input.onRoleCall();
        current = withoutComputation(current, position);
        dropped.push(`${computation.outputColumn} (${message})`);
      }
    }
    return { compiled: current, kept, dropped, attempts };
  }
}

/** `tool_generated` の message へ載せる注記（v42 §7 の書式）。 */
function describeNotes(input: {
  readonly joins: boolean;
  readonly expressionAttempts: number;
  readonly repairedTasks: ReadonlySet<ToolSpecTaskName>;
  readonly dropped: readonly string[];
}): string[] {
  const tasks: string[] = [
    ...(input.joins ? ['decide-join'] : []),
    'decide-filters',
    'decide-computations',
    'decide-output',
    ...(input.expressionAttempts > 0 ? [`write-expression×${input.expressionAttempts}`] : []),
  ];
  return [
    `staged: ${tasks.join(', ')}`,
    ...(input.repairedTasks.size === 0 ? [] : [`repaired: ${[...input.repairedTasks].join(', ')}`]),
    ...input.dropped.map((note) => `dropped computation: ${note}`),
  ];
}

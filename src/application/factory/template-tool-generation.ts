/**
 * application層: テンプレート経路のオーケストレーション（v43 実装契約 §4 / ADR-0049）。
 *
 * 1 本の Tool を「当てはまるテンプレートを決定的に絞る → モデルが 1 つ選ぶ（`select-template`）→
 * モデルがスロットを候補から埋める（`fill-slots`）→ 純関数で実体化 →（意図文があれば式提案）→
 * 段階的経路・一括経路と**同じ**決定的検査」の順で作る。
 *
 * この file の肝は 3 つ:
 * - **抜け道を作らない**。実体化したグラフは `validateInstantiatedTemplate`（スキーマ伝播・設計時
 *   プレビュー）と `describeCompiledToolViolations`（形・結合・意味・溢れ）を必ず通す。テンプレートが
 *   使うノード種別（`calculate` / `time-series-analysis` / …）は `extraTransformTypes` で明示的に
 *   通し、それ以外の形の規則（ソースを 1 回ずつ・終端は 1 つ・合流は join だけ）はそのまま効かせる。
 * - **差し戻しは 1 回だけ、スロットへ**。違反が「どのスロットの選択が悪いか」へ引けるときだけ
 *   `fill-slots` をやり直す。引けない・2 回目も駄目なら諦める。
 * - **諦めるときも例外にしない**。呼び出し側（`GenerateAgentAssetsUseCase`）が段階的生成へ
 *   フォールバックできるよう `ok: false` を返す。中断（`FactoryAbortedError`）だけはそのまま抜ける。
 */
import { FactoryAbortedError } from '../../domain/factory/errors';
import type { ToolGraph } from '../../domain/etl/graph';
import {
  applicableTemplates,
  instantiateTemplate,
  withPendingExpression,
  type InstantiatedTemplate,
  type TemplateSlotValues,
} from '../../domain/tool-template/instantiate';
import type { ToolTemplate } from '../../domain/tool-template/template';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { ModelProviderPort } from '../model/model-provider';
import type { PromptCatalogPort } from '../prompt/prompt-catalog-port';
import type { SuggestCalculateExpressionUseCase } from '../tool/suggest-calculate-expression';
import type { ToolTemplateCatalogPort } from '../tool-template/catalog-port';
import { templateContextOf } from '../tool-template/template-context';
import { validateInstantiatedTemplate } from '../tool-template/validate-instantiated';
import { throwIfAborted } from './abort';
import { describeCompiledToolViolations } from './generate-agent-assets';
import type { DataProfile } from './profile-data-sources';
import type {
  TemplateToolGenerationPort,
  TemplateToolGenerationRequest,
  TemplateToolResult,
  UsedToolTemplate,
} from './template-tool-port';
import { fillSlotsTaskOf, runRoleTask, selectTemplateTaskOf, type FillSlotsInput } from './tasks';

export type {
  TemplateToolGenerationPort,
  TemplateToolGenerationRequest,
  TemplateToolResult,
  UsedToolTemplate,
} from './template-tool-port';

/** データ経路の外に置くノード種別（`extraTransformTypes` へ足さない）。 */
const NON_TRANSFORM_TYPES: readonly string[] = ['csv-source', 'json-source', 'agent-input', 'agent-output'];

/**
 * 実体化したグラフが使っている変換ノード種別。
 *
 * テンプレートが使ってよいノード種別は**登録済みの全種別**（v43 §3）で、一括 ToolSmith の許可リスト
 * （`SAFE_TRANSFORM_TYPES`）には縛られない。カタログは読み込み時に registry で種別を検査済みなので、
 * ここに現れる種別はすべて登録済みである。形の検査には「この種別も許す」とだけ伝え、残りの規則
 * （ソースを 1 回ずつ・終端 1 つ・合流は join だけ・枝分かれ禁止）はそのまま効かせる。
 */
export function templateTransformTypes(graph: ToolGraph): string[] {
  return [...new Set(graph.nodes.map((node) => node.type).filter((type) => !NON_TRANSFORM_TYPES.includes(type)))];
}

/**
 * 省略できない引数へ渡す設計時サンプル（段階的経路の `requiredArgumentsOf` と同じ考え方）。
 * 必須引数を持つ Tool に「引数なしの呼び出し」は存在しないので、溢れガードは**必須引数だけを
 * サンプル値で埋めた呼び出し**で見る。
 */
export function requiredArgumentsOf(instantiated: InstantiatedTemplate): Record<string, unknown> {
  const required = (instantiated.inputSchema?.columns ?? []).filter((column) => !column.nullable).map((column) => column.name);
  if (required.length === 0) return {};
  const declaration = instantiated.graph.nodes.find((node) => node.type === 'agent-input');
  const sample = ((declaration?.config ?? {}) as { sample?: Record<string, unknown> }).sample ?? {};
  const args: Record<string, unknown> = {};
  for (const name of required) {
    if (Object.prototype.hasOwnProperty.call(sample, name)) args[name] = sample[name];
  }
  return args;
}

/**
 * 問題文に出てくる列名から、その列を選んだスロットを引き当てる（長い名前から順に見る）。
 * `validateInstantiatedTemplate` が自分の問題へ付けるのと同じ規則を、外側の検査にも当てる。
 */
export function slotForMessage(message: string, columnSlots: Readonly<Record<string, string>>): string | undefined {
  const names = Object.keys(columnSlots).sort((a, b) => b.length - a.length);
  const hit = names.find((name) => name !== '' && message.includes(name));
  return hit === undefined ? undefined : columnSlots[hit];
}

/** 結合の違反だと分かる文言（`describeJoinProblems` / `describeJoinDesignViolations` の言い回し）。 */
const JOIN_VIOLATION_PATTERN = /'join' node|rows multiplied|join also on|declares no keys|joins on/;

/**
 * 結合の違反は**結合キーのスロット**へ戻す。
 *
 * 「行が増えた」の文面は足すべきキー列の名前（`'時点'` など）を挙げるので、列名だけで引くと
 * その列を選んだ別のスロット（期間の列）に当たってしまう。直すべきなのは結合キーなので、
 * 結合の違反だと分かるときは先に `joinKeys` スロットを見る。
 */
export function joinSlotFor(template: ToolTemplate, message: string): string | undefined {
  if (!JOIN_VIOLATION_PATTERN.test(message)) return undefined;
  return template.slots.find((slot) => slot.kind === 'joinKeys')?.name;
}

/** `tool_generated` の message へ載せるスロットの書き方（`a=…, b=[…]`）。 */
export function describeSlots(template: ToolTemplate, values: TemplateSlotValues): string {
  const parts: string[] = [];
  for (const slot of template.slots) {
    if (slot.kind === 'dataSource') continue;
    const value = values[slot.name];
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
    parts.push(`${slot.name}=${Array.isArray(value) ? `[${(value as readonly string[]).join(', ')}]` : String(value)}`);
  }
  return parts.join(', ');
}

/** 式の作成で使ったモデル呼び出し回数（段階的経路と同じ数え方）。 */
function expressionCallsOf(repaired: boolean): number {
  return repaired ? 2 : 1;
}

export class TemplateToolGeneration implements TemplateToolGenerationPort {
  constructor(
    private readonly model: ModelProviderPort,
    private readonly engine: EtlEngine,
    /** テンプレートの置き場所。未注入の配線ではテンプレート経路そのものが使われない。 */
    private readonly catalog: ToolTemplateCatalogPort,
    /** `intent` スロットの式を書く専用経路（v41）。使えなければ意図文を持つテンプレートは諦める。 */
    private readonly suggestExpression: SuggestCalculateExpressionUseCase | undefined,
    /** 検査と式の標本行に要る（未注入ならテンプレート経路は使えない）。 */
    private readonly resolveDataSources: ResolveDataSourceGraphUseCase | undefined,
    /** モデルへ送る文の置き場所（v48）。2 つのタスクの目的文・規則はここから読む。 */
    private readonly prompts: PromptCatalogPort,
  ) {}

  async generate(request: TemplateToolGenerationRequest): Promise<TemplateToolResult> {
    const resolveDataSources = this.resolveDataSources;
    if (resolveDataSources === undefined) {
      return { ok: false, reason: 'template generation needs a data source resolver, which is not configured', attempted: false };
    }
    const { plan, goal, scope, signal } = request;
    /** 選んだテンプレート。例外で抜けたときも「どの構成で躓いたか」をイベントへ残せるよう外に持つ。 */
    let used: UsedToolTemplate | undefined;

    try {
      const dataSourceIds = [plan.dataSourceId, ...(plan.additionalDataSourceIds ?? [])];
      const profiles = dataSourceIds
        .map((id) => request.profiles.find((profile) => profile.dataSourceId === id))
        .filter((profile): profile is DataProfile => profile !== undefined);
      const primary = profiles[0];
      if (primary === undefined || profiles.length !== dataSourceIds.length) {
        return { ok: false, reason: `tool plan '${plan.key}' has no data profile for one of its data sources`, attempted: false };
      }

      const context = templateContextOf({ dataSourceIds }, request.profiles);
      const { templates } = await this.catalog.list();
      const applicable = applicableTemplates(templates, context);
      if (applicable.length === 0) {
        return {
          ok: false,
          reason: templates.length === 0
            ? 'no tool templates are available'
            : 'no tool template fits this tool plan (its data has no column for one of the required slots)',
          attempted: false,
        };
      }

      // ── 1. テンプレートを選ぶ ──────────────────────────────────────────────────────
      throwIfAborted(signal);
      const selection = await runRoleTask(this.model, this.prompts, selectTemplateTaskOf(this.prompts), { plan, goal, templates: applicable }, {
        ...(signal === undefined ? {} : { signal }),
        onCall: request.onRoleCall,
      });
      const template = selection.value.template;
      if (template === undefined) {
        return { ok: false, reason: `the model chose no template: ${selection.value.reason}`, attempted: true };
      }
      used = { id: template.id, version: template.version };

      // ── 2. スロットを埋める（`dataSource` は計画から決定的に割り当てる） ─────────────
      const dataSources: Record<string, string> = {};
      template.slots
        .filter((slot) => slot.kind === 'dataSource')
        .forEach((slot, index) => {
          const source = context.sources[index];
          if (source !== undefined) dataSources[slot.name] = source.dataSourceId;
        });
      const fillInput: FillSlotsInput = { template, context, profiles, plan, goal, dataSources };

      const fill = async (feedback?: string): Promise<TemplateSlotValues> => {
        throwIfAborted(signal);
        const result = await runRoleTask(this.model, this.prompts, fillSlotsTaskOf(this.prompts), fillInput, {
          ...(feedback === undefined ? {} : { feedback }),
          ...(signal === undefined ? {} : { signal }),
          onCall: request.onRoleCall,
        });
        return result.value;
      };

      let values = await fill();
      let repaired = false;

      // ── 3.「実体化 → 式 → 検査」を、スロットの差し戻し 1 回ぶんまで回す ──────────────
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const built = await this.build({ template, values, context, scope, resolveDataSources, request, profiles });
        if (built.ok) {
          return {
            ok: true,
            instantiated: built.instantiated,
            template: used,
            slots: values,
            notes: [
              `template: ${used.id}@${used.version}`,
              ...(describeSlots(template, values) === '' ? [] : [`slots: ${describeSlots(template, values)}`]),
              ...(repaired ? ['repaired: fill-slots'] : []),
            ],
          };
        }
        // 差し戻せない（どのスロットの選択でもない）／既に 1 回やり直した → 諦めて段階的生成へ。
        if (built.slot === undefined || attempt === 1) {
          return { ok: false, reason: built.reason, template: used, attempted: true };
        }
        request.onEvent(`re-running fill-slots for template ${used.id}: ${built.reason}`);
        values = await fill(`The slot '${built.slot}' produced a tool that does not work: ${built.reason} Choose a different value for that slot (and for any slot that depends on it).`);
        repaired = true;
      }
      // ループは必ず return で抜ける（防御的）。
      return { ok: false, reason: 'the template path ran out of repair attempts', template: used, attempted: true };
    } catch (error) {
      // 中断は失敗ではない（フォールバックへ回さずそのまま抜ける）。
      if (error instanceof FactoryAbortedError) throw error;
      throwIfAborted(signal);
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(used === undefined ? {} : { template: used }),
        attempted: true,
      };
    }
  }

  /**
   * スロット値 1 組ぶんを「実体化 → 式 → 検査」に掛ける。
   * 失敗は理由と、分かれば**やり直すべきスロット**を添えて返す（差し戻し先の判断は呼び出し側）。
   */
  private async build(input: {
    readonly template: ToolTemplate;
    readonly values: TemplateSlotValues;
    readonly context: ReturnType<typeof templateContextOf>;
    readonly scope: TemplateToolGenerationRequest['scope'];
    readonly resolveDataSources: ResolveDataSourceGraphUseCase;
    readonly request: TemplateToolGenerationRequest;
    /** このツールが読むプロファイル（主ソースが先頭）。 */
    readonly profiles: readonly DataProfile[];
  }): Promise<{ readonly ok: true; readonly instantiated: InstantiatedTemplate } | { readonly ok: false; readonly reason: string; readonly slot?: string }> {
    const { template, values, context, scope, resolveDataSources, request } = input;
    const signal = request.signal;

    let instantiated: InstantiatedTemplate;
    try {
      instantiated = instantiateTemplate(template, values, context, { toolName: request.toolName, language: request.goal.language });
    } catch (error) {
      if (error instanceof FactoryAbortedError) throw error;
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    // 意図文（`$intent`）の calculate ノードへ式を書く。書けなければ**このツールの**テンプレート経路を
    // 失敗にする（契約 §4 step 4）。計算列だけを落とすことはしない: 式はテンプレートの中心だからである。
    const filled = await this.fillExpressions(instantiated, { scope, resolveDataSources, request });
    if (!filled.ok) return { ok: false, reason: filled.reason };
    instantiated = filled.instantiated;

    // 手で組んだ Tool と同じ検査 1: スキーマ伝播 + 設計時プレビュー（問題はスロットへ戻る）。
    const problems = await validateInstantiatedTemplate(this.engine, instantiated, (graph) => resolveDataSources.execute(scope, graph));
    const first = problems[0];
    if (first !== undefined) {
      return { ok: false, reason: first.message, ...(first.slot === undefined ? {} : { slot: first.slot }) };
    }

    // 同じ検査 2: 形・結合の設計・意味・引数なし（必須引数だけ）呼び出しの溢れ。
    throwIfAborted(signal);
    const violation = await describeCompiledToolViolations(
      { engine: this.engine, resolveDataSources },
      {
        scope,
        graph: instantiated.graph,
        inputSchema: instantiated.inputSchema,
        toolPlan: request.plan,
        profile: input.profiles[0]!,
        additionalProfiles: input.profiles.slice(1),
        extraTransformTypes: templateTransformTypes(instantiated.graph),
        requiredArguments: requiredArgumentsOf(instantiated),
      },
    );
    if (violation === undefined) return { ok: true, instantiated };
    const slot = joinSlotFor(template, violation.message) ?? slotForMessage(violation.message, instantiated.columnSlots);
    return { ok: false, reason: `${violation.kind}: ${violation.message}`, ...(slot === undefined ? {} : { slot }) };
  }

  /**
   * `$intent` の calculate ノードへ式を入れる（v41 の式提案を再利用）。
   *
   * 式提案は渡されたグラフをそのまま走らせて上流の標本行を取り、提案を当てた版でスキーマ伝播まで
   * 確かめる。したがって渡すグラフは (1) データソース解決済みで、(2) **まだ式が空のほかのノードが
   * 残っていない**必要がある。ほかの意図文ノードは検分のあいだだけ無害な定数式へ置き換える。
   */
  private async fillExpressions(
    instantiated: InstantiatedTemplate,
    deps: {
      readonly scope: TemplateToolGenerationRequest['scope'];
      readonly resolveDataSources: ResolveDataSourceGraphUseCase;
      readonly request: TemplateToolGenerationRequest;
    },
  ): Promise<{ readonly ok: true; readonly instantiated: InstantiatedTemplate } | { readonly ok: false; readonly reason: string }> {
    let current = instantiated;
    if (current.pendingExpressions.length === 0) return { ok: true, instantiated: current };

    const assistant = this.suggestExpression;
    if (assistant === undefined || !(await assistant.available())) {
      return { ok: false, reason: 'this template needs a calculated column, but the calculate expression assistant is not available' };
    }

    while (current.pendingExpressions.length > 0) {
      const pending = current.pendingExpressions[0]!;
      const others = new Set(current.pendingExpressions.slice(1).map((entry) => entry.nodeId));
      const probe: ToolGraph = others.size === 0
        ? current.graph
        : {
          nodes: current.graph.nodes.map((node) =>
            others.has(node.id) ? { ...node, config: { ...(node.config as Record<string, unknown>), expression: '0' } } : node),
          edges: current.graph.edges,
        };
      try {
        throwIfAborted(deps.request.signal);
        const resolved = await deps.resolveDataSources.execute(deps.scope, probe);
        const proposal = await assistant.execute({ graph: resolved, nodeId: pending.nodeId, intent: pending.intent }, deps.request.signal);
        for (let call = 0; call < expressionCallsOf(proposal.repaired); call += 1) deps.request.onRoleCall();
        const expression = proposal.config.expression.trim();
        if (expression === '') throw new Error('the assistant returned an empty expression');
        current = withPendingExpression(current, pending.nodeId, expression);
      } catch (error) {
        if (error instanceof FactoryAbortedError) throw error;
        throwIfAborted(deps.request.signal);
        const message = error instanceof Error ? error.message : String(error);
        // ユースケースは差し戻しを 1 回だけ使う。使ったかどうかは失敗の文言から決定的に読める。
        for (let call = 0; call < expressionCallsOf(message.includes('after one repair')); call += 1) deps.request.onRoleCall();
        return { ok: false, reason: `the formula for "${pending.intent}" could not be written: ${message}` };
      }
    }
    return { ok: true, instantiated: current };
  }
}

/**
 * ドメイン: ツールテンプレートの候補算出・スロット検証・実体化（v43 実装契約 §3 / ADR-0049）。
 *
 * すべて**純関数**（同じ入力なら同じ出力・副作用なし・LLM も時計も使わない）。テンプレートの
 * 役割は「構成を持つこと」で、モデル（や人）がするのはスロットを選ぶことだけなので、
 * 選択肢の作り方も実体化も決定的でなければならない。
 *
 * 実体化の結果（`ToolGraph` / `inputSchema` / `agentTool`）は、手で組んだ Tool と**同じ**検査
 * （構造・列の存在・設計時プレビュー・保存検証）を通す前提で作る。テンプレート経路だけの
 * 抜け道は作らない。
 */
import type { Column, Schema } from '../data/types';
import type { GraphEdge, GraphNode, ToolGraph } from '../etl/graph';
import {
  TEMPLATE_ARGUMENTS_NODE_ID,
  TEMPLATE_FUNCTION_NAME_PATTERN,
  ToolTemplateError,
  collectReferences,
  directiveKeyOf,
  interpolationNamesOf,
  nodeTypeNameOf,
  parseProfileExpression,
  type TemplateColumnSlot,
  type TemplateContext,
  type TemplateProfileFacts,
  type TemplateSourceContext,
  type TemplateWhen,
  type ToolTemplate,
  type ToolTemplateArgument,
  type ToolTemplateNode,
  type ToolTemplateSlot,
} from './template';

/** スロットへ入れる値。配列は `multiple` の列・結合キー。 */
export interface TemplateSlotValues {
  readonly [slot: string]: string | number | readonly string[] | undefined;
}

/** 実体化の結果。 */
export interface InstantiatedTemplate {
  readonly graph: ToolGraph;
  /** 引数が 1 つも残らなければ undefined（`agent-input` ノードも置かない）。 */
  readonly inputSchema?: Schema;
  readonly agentTool: { readonly name: string; readonly description: string };
  /** `$intent` を持つ calculate ノード（式は空）。実体化後に式提案が埋める。 */
  readonly pendingExpressions: readonly { readonly nodeId: string; readonly intent: string }[];
  /**
   * 実体化後の列名 → その列を供給したスロット名。検証の問題（「列が無い」）を
   * **どのスロットの選択が悪かったか**へ戻すために application 層が使う。
   */
  readonly columnSlots: Readonly<Record<string, string>>;
}

/** 引数名 → nullable（作成画面でテンプレートの既定から切り替えた引数だけ。v46 §B）。 */
export type ArgumentNullability = Readonly<Record<string, boolean>>;

export interface InstantiateTemplateOptions {
  /** エージェントへ公開する function 名（`toolFunctionNameOf` などで呼び出し側が作る）。 */
  readonly toolName: string;
  readonly language: 'ja' | 'en';
  /**
   * 引数の必須 / 任意の上書き。省略時はテンプレートの既定のまま（Agent Factory はこれを渡さない）。
   * 検査（`argumentNullabilityViolations`）を通らない指定は `ToolTemplateError` で止める。
   */
  readonly argumentNullability?: ArgumentNullability;
}

/** 実体化後に残る引数 1 つ（作成画面が「必須」チェックボックスの行として描く形）。 */
export interface TemplateArgumentView {
  readonly name: string;
  readonly type: ToolTemplateArgument['type'];
  /** テンプレートの既定（上書き前）。画面のチェックボックスの初期値になる。 */
  readonly nullable: boolean;
  /** 切り替えられない理由（表示言語で埋め込み済み）。 */
  readonly lock?: string;
  /** 表示言語で、スロットの値を埋め込んだ説明。 */
  readonly description: string;
}

/** スロット 1 つぶんの選択肢（契約 §3 の形）。 */
export type SlotCandidates = readonly string[] | { readonly min: number; readonly max: number } | 'free-text';

/** スロット違反 1 件（どのスロットを直せばよいかを必ず持つ）。 */
export interface SlotViolation {
  readonly slot: string;
  readonly message: string;
}

/** 期間ラベルが 1 件も解釈できなかったときに使う広い既定（`compileToolSpec` と同じ値）。 */
const WIDE_PERIOD_START = '1000-01-01';
const WIDE_PERIOD_END = '9999-12-31';

/** コードらしい列名（「値の列」から外す）。`profile-data-sources` の `CODE_LIKE_COLUMN` と同じ語彙。 */
const CODE_LIKE_COLUMN = /コード|code|id$|_id|番号/i;

/** `parse-period` が足す列（「値の列」から外す）。 */
const PERIOD_DERIVED_COLUMNS: readonly string[] = ['periodStart', 'periodGranularity'];

/** `join` の既定 suffix（`join` ノードの `DEFAULT_RIGHT_SUFFIX` と同じ）。 */
const DEFAULT_RIGHT_SUFFIX = '_right';

// ── スロット値のならし ───────────────────────────────────────────────────────────

function slotMapOf(template: ToolTemplate): ReadonlyMap<string, ToolTemplateSlot> {
  return new Map(template.slots.map((slot) => [slot.name, slot] as const));
}

function isEmpty(value: string | number | readonly string[] | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 既定値を当てはめたスロット値。`choice` / `number` / `text` は既定を持つので、
 * 埋めなかったスロットもここで値が入る（候補提示・検証・実体化が同じ値を見る）。
 */
export function withSlotDefaults(template: ToolTemplate, values: TemplateSlotValues): TemplateSlotValues {
  const resolved: Record<string, string | number | readonly string[] | undefined> = {};
  for (const slot of template.slots) {
    const given = values[slot.name];
    if (!isEmpty(given)) {
      resolved[slot.name] = given;
      continue;
    }
    if (slot.kind === 'choice' && slot.default !== undefined) resolved[slot.name] = slot.default;
    else if (slot.kind === 'number') resolved[slot.name] = slot.default;
    else if (slot.kind === 'text') resolved[slot.name] = slot.default;
  }
  return resolved;
}

function isPresent(values: TemplateSlotValues, name: string): boolean {
  return !isEmpty(values[name]);
}

/**
 * `when` を評価する。
 *
 * `notEquals` は「埋まっていて、かつその値ではない」とする（`equals` と対称）。空のスロットを
 * 「その値ではない」と読むと、値を参照するノードが値なしで残ってしまう。
 */
export function evaluateWhen(when: TemplateWhen | undefined, values: TemplateSlotValues): boolean {
  if (when === undefined) return true;
  if (typeof when === 'string') return isPresent(values, when);
  if ('not' in when) return !evaluateWhen(when.not, values);
  if (!isPresent(values, when.slot)) return false;
  const actual = String(values[when.slot]);
  return 'equals' in when ? actual === when.equals : actual !== when.notEquals;
}

// ── 候補 ─────────────────────────────────────────────────────────────────────────

/** `dataSource` スロットの宣言順（そのまま文脈のソース順に対応させる）。 */
function dataSourceSlotOrder(template: ToolTemplate): string[] {
  return template.slots.filter((slot) => slot.kind === 'dataSource').map((slot) => slot.name);
}

/** その `dataSource` スロットが指すソース（値があればその id、無ければ宣言順で対応するソース）。 */
function sourceOf(template: ToolTemplate, context: TemplateContext, values: TemplateSlotValues, slotName: string): TemplateSourceContext | undefined {
  const chosen = values[slotName];
  if (typeof chosen === 'string' && chosen !== '') {
    return context.sources.find((source) => source.dataSourceId === chosen);
  }
  const index = dataSourceSlotOrder(template).indexOf(slotName);
  return index < 0 ? undefined : context.sources[index];
}

/** 列の型（プロファイルが持つ `DataType` の文字列）。 */
function columnTypeOf(source: TemplateSourceContext, name: string): string | undefined {
  return source.columns.find((column) => column.name === name)?.type;
}

/** `column` スロットの候補（role と types で決定的に絞る）。 */
export function columnCandidatesOf(slot: TemplateColumnSlot, source: TemplateSourceContext | undefined): string[] {
  if (source === undefined) return [];
  const byRole = ((): string[] => {
    switch (slot.role) {
      case 'period':
        return source.periodColumns.map((column) => column.column);
      case 'category':
        return source.categoricalColumns.map((column) => column.column);
      case 'value':
        return source.columns
          .filter((column) => column.type === 'number')
          .map((column) => column.name)
          .filter((name) => !CODE_LIKE_COLUMN.test(name) && !PERIOD_DERIVED_COLUMNS.includes(name));
      case 'text':
        return source.columns.filter((column) => column.type === 'string' || column.type === 'unknown').map((column) => column.name);
      default:
        return source.columns.map((column) => column.name);
    }
  })();
  if (slot.types === undefined) return byRole;
  const types = new Set(slot.types);
  return byRole.filter((name) => {
    const type = columnTypeOf(source, name);
    return type !== undefined && types.has(type);
  });
}

/** 2 つのソースの間で結合キーに選んでよい列（向きは問わない）。 */
function joinKeyCandidatesOf(context: TemplateContext, left: TemplateSourceContext | undefined, right: TemplateSourceContext | undefined): string[] {
  if (left === undefined || right === undefined) return [];
  const keys: string[] = [];
  for (const candidate of context.joinCandidates) {
    const matches =
      (candidate.leftDataSourceId === left.dataSourceId && candidate.rightDataSourceId === right.dataSourceId) ||
      (candidate.leftDataSourceId === right.dataSourceId && candidate.rightDataSourceId === left.dataSourceId);
    if (!matches) continue;
    for (const key of candidate.keys) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * スロットごとの選択肢を決定的に作る。
 *
 * `values` は任意で、既に決まっているスロット（どのデータソースか・どの期間列か）を渡すと
 * それに依存する候補（列・結合キー・`granularities:`）がそのソース／その列に合わせて絞られる。
 * 渡さないときは `dataSource` スロットの宣言順と文脈のソース順を対応させる。
 */
export function slotCandidates(template: ToolTemplate, context: TemplateContext, values: TemplateSlotValues = {}): Record<string, SlotCandidates> {
  const resolved = withSlotDefaults(template, values);
  const candidates: Record<string, SlotCandidates> = {};
  for (const slot of template.slots) {
    switch (slot.kind) {
      case 'dataSource':
        candidates[slot.name] = context.sources.map((source) => source.dataSourceId);
        break;
      case 'column':
        candidates[slot.name] = columnCandidatesOf(slot, sourceOf(template, context, resolved, slot.source));
        break;
      case 'joinKeys':
        candidates[slot.name] = joinKeyCandidatesOf(
          context,
          sourceOf(template, context, resolved, slot.left),
          sourceOf(template, context, resolved, slot.right),
        );
        break;
      case 'choice': {
        if (slot.options !== undefined) {
          candidates[slot.name] = slot.options.map((option) => option.value);
          break;
        }
        const target = (slot.optionsFrom ?? '').split(':')[1] ?? '';
        const columnSlot = template.slots.find((candidate) => candidate.name === target);
        const source = columnSlot?.kind === 'column' ? sourceOf(template, context, resolved, columnSlot.source) : undefined;
        const chosen = resolved[target];
        const periodColumns = (source?.periodColumns ?? []).filter((column) => typeof chosen !== 'string' || chosen === '' || column.column === chosen);
        const granularities: string[] = [];
        for (const column of periodColumns) {
          for (const granularity of column.granularities) {
            if (granularity !== 'unknown' && !granularities.includes(granularity)) granularities.push(granularity);
          }
        }
        candidates[slot.name] = granularities;
        break;
      }
      case 'number':
        candidates[slot.name] = { min: slot.min, max: slot.max };
        break;
      default:
        candidates[slot.name] = 'free-text';
        break;
    }
  }
  return candidates;
}

/** そのスロットに候補が 1 つも無い（= 必須なら適用不可）か。 */
function hasNoCandidate(candidate: SlotCandidates): boolean {
  return Array.isArray(candidate) && candidate.length === 0;
}

/**
 * この文脈（ソース数・プロファイル）に当てはまるテンプレートだけを決定的に絞る。
 * 必須スロットに候補が 1 つも無いテンプレートは選択肢に出さない（選んでも埋められない）。
 */
export function applicableTemplates(templates: readonly ToolTemplate[], context: TemplateContext): ToolTemplate[] {
  return templates.filter((template) => {
    if (context.sources.length < template.sources.min || context.sources.length > template.sources.max) return false;
    const candidates = slotCandidates(template, context);
    return template.slots.every((slot) => slot.optional === true || !hasNoCandidate(candidates[slot.name] ?? []));
  });
}

// ── スロット検証 ─────────────────────────────────────────────────────────────────

/** `calculate` の式に `{{slot}}` で埋め込まれるスロット（列名に `]` を含められない）。 */
function slotsUsedInExpressions(template: ToolTemplate): Set<string> {
  const used = new Set<string>();
  for (const node of template.nodes) {
    if (nodeTypeNameOf(node) !== 'calculate') continue;
    const expression = (node.config as { expression?: unknown } | null)?.expression;
    if (typeof expression !== 'string') continue;
    for (const name of interpolationNamesOf(expression)) used.add(name);
  }
  return used;
}

function asArray(value: string | number | readonly string[] | undefined): readonly string[] | undefined {
  if (Array.isArray(value)) return value as readonly string[];
  return undefined;
}

/**
 * スロットの値がこのデータに対して成立するかを決定的に見る。
 * 返す違反は**どのスロットを直せばよいか**を必ず持つ（`fill-slots` へそのまま差し戻せる）。
 */
export function validateSlotValues(template: ToolTemplate, values: TemplateSlotValues, context: TemplateContext): SlotViolation[] {
  const resolved = withSlotDefaults(template, values);
  const candidates = slotCandidates(template, context, resolved);
  const expressionSlots = slotsUsedInExpressions(template);
  const violations: SlotViolation[] = [];
  const slots = slotMapOf(template);

  for (const name of Object.keys(values)) {
    if (slots.has(name)) continue;
    violations.push({ slot: name, message: `this template has no slot named '${name}'; remove it — the slots are ${[...slots.keys()].join(', ')}` });
  }

  for (const slot of template.slots) {
    const value = resolved[slot.name];
    const options = candidates[slot.name] ?? [];
    if (isEmpty(value)) {
      if (slot.optional === true) continue;
      const hint = Array.isArray(options)
        ? (options.length === 0 ? 'this data source offers no column that fits, so this template cannot be used here' : `choose one of ${options.join(', ')}`)
        : 'fill it in';
      violations.push({ slot: slot.name, message: `slot '${slot.name}' (${slot.label.en}) has no value; ${hint}` });
      continue;
    }

    switch (slot.kind) {
      case 'dataSource': {
        const ids = context.sources.map((source) => source.dataSourceId);
        if (typeof value !== 'string' || !ids.includes(value)) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is set to '${String(value)}', which is not one of this tool's data sources; choose one of ${ids.join(', ')}` });
        }
        break;
      }
      case 'column': {
        const allowed = Array.isArray(options) ? options : [];
        const list = asArray(value);
        if (slot.multiple !== undefined) {
          if (list === undefined) {
            violations.push({ slot: slot.name, message: `slot '${slot.name}' takes a list of column names, got ${JSON.stringify(value)}; pass an array such as ["${allowed[0] ?? 'column'}"]` });
            break;
          }
          if (list.length < slot.multiple.min || list.length > slot.multiple.max) {
            violations.push({ slot: slot.name, message: `slot '${slot.name}' has ${list.length} column(s), but it takes between ${slot.multiple.min} and ${slot.multiple.max}; add or remove columns from ${allowed.join(', ')}` });
          }
          if (new Set(list).size !== list.length) {
            violations.push({ slot: slot.name, message: `slot '${slot.name}' lists the same column twice; keep each column once` });
          }
        } else if (list !== undefined) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' takes a single column name, got a list; pass one of ${allowed.join(', ')} as a string` });
          break;
        }
        const chosen = list ?? [String(value)];
        for (const column of chosen) {
          if (!allowed.includes(column)) {
            violations.push({ slot: slot.name, message: `slot '${slot.name}' is set to '${column}', which is not a ${slot.role} column of that data source; choose one of ${allowed.join(', ') || 'none — this template does not fit this data'}` });
            continue;
          }
          if (column.includes(']') && expressionSlots.has(slot.name)) {
            violations.push({ slot: slot.name, message: `the column '${column}' cannot be used in a formula because its name contains ']'; rename the column upstream (a 'rename' node before the calculation) and pick the new name here` });
          }
        }
        for (const other of slot.distinctFrom ?? []) {
          const otherValue = resolved[other];
          if (otherValue === undefined) continue;
          const overlap = chosen.filter((column) => (Array.isArray(otherValue) ? (otherValue as readonly string[]).includes(column) : String(otherValue) === column));
          if (overlap.length === 0) continue;
          violations.push({ slot: slot.name, message: `slot '${slot.name}' and slot '${other}' both use ${overlap.map((column) => `'${column}'`).join(', ')}; pick a different column for one of them` });
        }
        break;
      }
      case 'joinKeys': {
        const allowed = Array.isArray(options) ? options : [];
        const list = asArray(value);
        if (list === undefined) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' takes a list of key columns, got ${JSON.stringify(value)}; pass an array such as ${JSON.stringify(allowed.slice(0, 2))}` });
          break;
        }
        if (list.length < slot.multiple.min || list.length > slot.multiple.max) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' has ${list.length} key(s), but it takes between ${slot.multiple.min} and ${slot.multiple.max}; the shared key columns are ${allowed.join(', ') || 'none — these two sources cannot be joined'}` });
        }
        if (new Set(list).size !== list.length) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' lists the same key twice; keep each key once` });
        }
        for (const key of list) {
          if (allowed.includes(key)) continue;
          violations.push({ slot: slot.name, message: `slot '${slot.name}' joins on '${key}', which the data profile did not list as a shared key of those two sources; choose from ${allowed.join(', ') || 'none — these two sources cannot be joined'}` });
        }
        break;
      }
      case 'choice': {
        const allowed = Array.isArray(options) ? options : [];
        if (typeof value !== 'string' || !allowed.includes(value)) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is set to '${String(value)}', which is not one of its options; choose one of ${allowed.join(', ') || 'none — the data has no value for this choice'}` });
        }
        break;
      }
      case 'number': {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is set to '${String(value)}', which is not a number; pass a number between ${slot.min} and ${slot.max}` });
          break;
        }
        if (slot.integer === true && !Number.isInteger(numeric)) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is ${numeric}, but it must be a whole number; round it to an integer between ${slot.min} and ${slot.max}` });
        }
        if (numeric < slot.min || numeric > slot.max) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is ${numeric}, which is outside ${slot.min}..${slot.max}; pass a value inside that range` });
        }
        break;
      }
      case 'text': {
        const text = String(value);
        if (text.length > slot.maxLength) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is ${text.length} characters long, at most ${slot.maxLength} are allowed; shorten it` });
        }
        if (slot.pattern !== undefined && !new RegExp(slot.pattern).test(text)) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is '${text}', which does not match ${slot.pattern}; rewrite it to match that shape` });
        }
        break;
      }
      default: {
        const text = String(value);
        if (text.length > slot.maxLength) {
          violations.push({ slot: slot.name, message: `slot '${slot.name}' is ${text.length} characters long, at most ${slot.maxLength} are allowed; say what to compute in one shorter sentence` });
        }
        break;
      }
    }
  }
  return violations;
}

// ── 引数の必須 / 任意（v46 §B） ─────────────────────────────────────────────────────

/** 引数の違反が載る `slot` の形（422 の封筒で、画面がその引数の行の真下へ出すための鍵）。 */
export function argumentSlotOf(name: string): string {
  return `argument:${name}`;
}

/**
 * その引数の効く nullable（上書き → テンプレートの既定）。入力スキーマの列・説明文の「必須 / 省略可」・
 * 設計時サンプルの要否は**すべてこれ**を見る（1 か所でも既定を直に見ると、画面では必須なのに
 * 説明文は「省略可」のような食い違いになる）。
 */
export function effectiveNullable(argument: ToolTemplateArgument, overrides: ArgumentNullability | undefined): boolean {
  return overrides?.[argument.name] ?? argument.nullable;
}

/** そのスロット値で `when` を満たし、実体化後に残る引数。 */
function survivingArguments(template: ToolTemplate, values: TemplateSlotValues): ToolTemplateArgument[] {
  const resolved = withSlotDefaults(template, values);
  return template.arguments.filter((argument) => evaluateWhen(argument.when, resolved));
}

/** 設計時の見本を書いていない引数か（`sample` が無い・null）。 */
function hasNoSample(argument: ToolTemplateArgument): boolean {
  return argument.sample === undefined || argument.sample === null;
}

/**
 * 引数の必須 / 任意の上書きが成立するかを見る。違反は `slot: 'argument:<name>'` を持つ。
 *
 * - テンプレートに無い名前は、使える名前を挙げて止める（打ち間違いを黙って無視しない）。
 * - `lock` のある引数は既定と違う値にできない（既定と同じ値を送るのは可）。
 * - 任意 → 必須にするには設計時の見本が要る（`agent-input` の設計時プレビューに値が要るため）。
 * - `when` で落ちた引数への指定は**無視する**（その引数は作られないので、効かせる先が無い）。
 *   画面は今のスロットで残る引数しか出さないが、スロットを変えた直後の古い指定は来うる。
 */
export function argumentNullabilityViolations(
  template: ToolTemplate,
  values: TemplateSlotValues,
  overrides: ArgumentNullability,
): SlotViolation[] {
  const declared = new Map(template.arguments.map((argument) => [argument.name, argument] as const));
  const surviving = new Set(survivingArguments(template, values).map((argument) => argument.name));
  const violations: SlotViolation[] = [];
  for (const [name, nullable] of Object.entries(overrides)) {
    const argument = declared.get(name);
    if (argument === undefined) {
      const known = [...declared.keys()].join(', ') || 'none — this template declares no arguments';
      violations.push({ slot: argumentSlotOf(name), message: `argument '${name}' is not in this template; choose one of ${known}` });
      continue;
    }
    if (!surviving.has(name) || nullable === argument.nullable) continue;
    if (argument.lock !== undefined) {
      violations.push({
        slot: argumentSlotOf(name),
        message: `argument '${name}' cannot be changed: ${argument.lock.en}; leave it ${argument.nullable ? 'optional' : 'required'}`,
      });
      continue;
    }
    if (!nullable && hasNoSample(argument)) {
      violations.push({
        slot: argumentSlotOf(name),
        message: `argument '${name}' has no design-time sample, so it cannot be made required; write a "sample" for it in the template, or leave it optional`,
      });
    }
  }
  return violations;
}

/** 説明文の `{{slot}}` を埋める。まだ選ばれていないスロットはそのスロットの表示名で読ませる。 */
function interpolateForDisplay(text: string, template: ToolTemplate, values: TemplateSlotValues, language: 'ja' | 'en'): string {
  return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (match, name: string) => {
    const value = values[name];
    if (!isEmpty(value)) return textOf(value);
    const slot = template.slots.find((candidate) => candidate.name === name);
    return slot === undefined ? match : slot.label[language];
  });
}

/**
 * 今のスロット値で残る引数を、作成画面がそのまま描ける形で返す（`when` の評価を画面に持たせない）。
 * 候補の取得はスロットを選び終える前にも呼ばれるので、説明文の未選択のスロットは例外にせず
 * 表示名で埋める（実体化の説明文とは違い、ここは人が読むための下書きである）。
 */
export function templateArgumentViews(template: ToolTemplate, values: TemplateSlotValues, language: 'ja' | 'en'): TemplateArgumentView[] {
  const resolved = withSlotDefaults(template, values);
  return survivingArguments(template, resolved).map((argument) => ({
    name: argument.name,
    type: argument.type,
    nullable: argument.nullable,
    ...(argument.lock === undefined ? {} : { lock: argument.lock[language] }),
    description: interpolateForDisplay(argument.description[language], template, resolved, language),
  }));
}

// ── 実体化 ───────────────────────────────────────────────────────────────────────

interface SubstitutionScope {
  /** このノードで見えるスロット値（結合後の読み替えを適用済み）。 */
  readonly values: TemplateSlotValues;
  /** 読み替え前の値（`$profile` はプロファイルを引くので必ず素の列名で見る）。 */
  readonly raw: TemplateSlotValues;
  /** `$each` のループ変数。 */
  readonly loop: Readonly<Record<string, string>>;
}

function textOf(value: string | number | readonly string[] | undefined): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return (value as readonly string[]).join(', ');
  return String(value);
}

function interpolate(text: string, scope: SubstitutionScope, where: string): string {
  return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_match, name: string) => {
    if (name in scope.loop) return scope.loop[name]!;
    if (!(name in scope.values)) {
      throw new ToolTemplateError(`${where}: the slot '${name}' has no value, so "${text}" cannot be filled in; fill the slot or guard the node with "when": "${name}"`);
    }
    return textOf(scope.values[name]);
  });
}

class Instantiator {
  constructor(
    private readonly template: ToolTemplate,
    private readonly facts: TemplateProfileFacts,
  ) {}

  /** `$profile` / `$sourceType` が引くソース（そのスロットが属するデータソース）。 */
  private sourceOfColumnSlot(slotName: string, raw: TemplateSlotValues, where: string): TemplateSourceContext {
    const slot = this.template.slots.find((candidate) => candidate.name === slotName);
    if (slot === undefined || slot.kind !== 'column') {
      throw new ToolTemplateError(`${where}: '${slotName}' is not a column slot, so no profile fact can be read from it; point the $profile at a column slot`);
    }
    return this.sourceOfDataSourceSlot(slot.source, raw, where);
  }

  private sourceOfDataSourceSlot(slotName: string, raw: TemplateSlotValues, where: string): TemplateSourceContext {
    const id = raw[slotName];
    const source = this.facts.sources.find((candidate) => candidate.dataSourceId === id);
    if (source === undefined) {
      throw new ToolTemplateError(`${where}: the data source slot '${slotName}' is set to '${String(id)}', which is not among the profiled sources (${this.facts.sources.map((candidate) => candidate.dataSourceId).join(', ')}); choose one of them`);
    }
    return source;
  }

  private profileValue(expression: string, scope: SubstitutionScope, where: string): unknown {
    const parsed = parseProfileExpression(expression);
    if (parsed === undefined) {
      throw new ToolTemplateError(`${where}: $profile "${expression}" is not understood; use "periodMin:<slot>", "periodMax:<slot>", "firstValues:<slot>:<n>" or "firstValuesCsv:<slot>:<n>"`);
    }
    const source = this.sourceOfColumnSlot(parsed.slot, scope.raw, where);
    const column = textOf(scope.raw[parsed.slot]);
    if (parsed.fn === 'periodMin' || parsed.fn === 'periodMax') {
      const period = source.periodColumns.find((candidate) => candidate.column === column);
      const fallback = parsed.fn === 'periodMin' ? WIDE_PERIOD_START : WIDE_PERIOD_END;
      return (parsed.fn === 'periodMin' ? period?.minStart : period?.maxStart) ?? fallback;
    }
    const values = source.categoricalColumns.find((candidate) => candidate.column === column)?.values ?? [];
    const head = values.slice(0, parsed.count ?? 1);
    return parsed.fn === 'firstValuesCsv' ? head.join(',') : [...head];
  }

  substitute(value: unknown, scope: SubstitutionScope, where: string): unknown {
    if (typeof value === 'string') return interpolate(value, scope, where);
    if (Array.isArray(value)) return value.map((item, index) => this.substitute(item, scope, `${where}[${index}]`));
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const directive = directiveKeyOf(value);
    switch (directive) {
      case '$slot': {
        const name = String(record['$slot']);
        if (name in scope.loop) return scope.loop[name];
        if (!(name in scope.values)) {
          throw new ToolTemplateError(`${where}: the slot '${name}' has no value; fill it, or guard this node with "when": "${name}" so it is dropped instead`);
        }
        const resolved = scope.values[name];
        return Array.isArray(resolved) ? [...(resolved as readonly string[])] : resolved;
      }
      case '$number': {
        const name = String(record['$number']);
        const resolved = name in scope.loop ? scope.loop[name] : scope.values[name];
        const numeric = Number(Array.isArray(resolved) ? Number.NaN : resolved);
        if (!Number.isFinite(numeric)) {
          throw new ToolTemplateError(`${where}: $number cannot turn the value of slot '${name}' (${JSON.stringify(resolved ?? null)}) into a number; give that slot a numeric option value`);
        }
        return numeric;
      }
      case '$argument':
        return { source: 'agent-input', field: String(record['$argument']) };
      case '$profile':
        return this.profileValue(String(record['$profile']), scope, where);
      case '$sourceType': {
        const source = this.sourceOfDataSourceSlot(String(record['$sourceType']), scope.raw, where);
        return source.format === 'json' ? 'json-source' : 'csv-source';
      }
      // 式は空のまま置く（実体化後に式提案が埋める。v42 のコンパイラと同じ約束）。
      // どのノードがどの意図文を待っているかは `pendingExpressionsOf` が別に数える
      // （置換は 2 度走ることがあるので、ここで数えると重複する）。
      case '$intent':
        return '';
      case '$concat': {
        const parts = record['$concat'] as readonly unknown[];
        const merged: unknown[] = [];
        parts.forEach((part, index) => {
          const resolved = this.substitute(part, scope, `${where}.$concat[${index}]`);
          const items = Array.isArray(resolved) ? resolved : [resolved];
          for (const item of items) {
            if (item === undefined) continue;
            if (!merged.some((existing) => existing === item)) merged.push(item);
          }
        });
        return merged;
      }
      case '$each': {
        const name = String(record['$each']);
        const as = String(record['as']);
        const source = name in scope.loop ? scope.loop[name] : scope.values[name];
        const items = Array.isArray(source) ? (source as readonly string[]) : (isEmpty(source) ? [] : [textOf(source)]);
        return items.map((item, index) =>
          this.substitute(record['item'], { ...scope, loop: { ...scope.loop, [as]: item } }, `${where}.item[${index}]`));
      }
      default: {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(record)) out[key] = this.substitute(item, scope, `${where}.${key}`);
        return out;
      }
    }
  }
}

/** `when` を評価したあとに残るノード id。 */
function survivingNodeIds(template: ToolTemplate, values: TemplateSlotValues): Set<string> {
  return new Set(template.nodes.filter((node) => evaluateWhen(node.when, values)).map((node) => node.id));
}

/**
 * 条件で落ちたノードを外し、**入次数 1・出次数 1** のものだけ前後を繋ぎ直す。
 * （繋ぎ直せない形は読み込み時に弾いてあるので、ここへは来ない。）
 */
function bridgedEdges(template: ToolTemplate, values: TemplateSlotValues, surviving: ReadonlySet<string>): GraphEdge[] {
  let edges: GraphEdge[] = template.edges
    .filter((edge) => evaluateWhen(edge.when, values))
    .map((edge) => ({ from: edge.from, to: edge.to, ...(edge.toInput === undefined ? {} : { toInput: edge.toInput }) }));
  for (const node of template.nodes) {
    if (surviving.has(node.id)) continue;
    const incoming = edges.filter((edge) => edge.to === node.id);
    const outgoing = edges.filter((edge) => edge.from === node.id);
    const kept = edges.filter((edge) => edge.to !== node.id && edge.from !== node.id);
    if (incoming.length === 1 && outgoing.length === 1) {
      const before = incoming[0]!;
      const after = outgoing[0]!;
      kept.push({ from: before.from, to: after.to, ...(after.toInput === undefined ? {} : { toInput: after.toInput }) });
    }
    edges = kept;
  }
  return edges;
}

/** 結合の読み替えを計算するための、ノードごとの列名（簡易伝播）。 */
function branchColumnsOf(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  facts: TemplateProfileFacts,
): (nodeId: string) => readonly string[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const inputsOf = (nodeId: string): string[] =>
    edges.filter((edge) => edge.to === nodeId).sort((a, b) => (a.toInput ?? 0) - (b.toInput ?? 0)).map((edge) => edge.from);
  const cache = new Map<string, readonly string[]>();
  const compute = (nodeId: string): readonly string[] => {
    const cached = cache.get(nodeId);
    if (cached !== undefined) return cached;
    cache.set(nodeId, []); // 循環はここへ来ない（読み込み時に弾く）が、念のため自己参照を止める。
    const node = byId.get(nodeId);
    const inputs = inputsOf(nodeId).map(compute);
    const config = (node?.config ?? {}) as Record<string, unknown>;
    let columns: readonly string[] = inputs[0] ?? [];
    if (node !== undefined) {
      if (typeof config['dataSourceId'] === 'string') {
        columns = facts.sources.find((source) => source.dataSourceId === config['dataSourceId'])?.columns.map((column) => column.name) ?? [];
      } else if (node.type === 'select' && Array.isArray(config['columns'])) {
        columns = (config['columns'] as readonly unknown[]).map(String);
      } else if (node.type === 'join') {
        columns = joinColumnsOf(inputs[0] ?? [], inputs[1] ?? [], config).columns;
      } else if (node.type === 'parse-period') {
        const start = typeof config['startColumn'] === 'string' ? config['startColumn'] : 'periodStart';
        const granularity = typeof config['granularityColumn'] === 'string' ? config['granularityColumn'] : 'periodGranularity';
        columns = [...columns, start, granularity];
      } else if (node.type === 'calculate' && typeof config['outputColumn'] === 'string') {
        columns = columns.includes(config['outputColumn']) ? columns : [...columns, config['outputColumn']];
      }
    }
    cache.set(nodeId, columns);
    return columns;
  };
  return compute;
}

/** `join` の出力列と、右由来の列の読み替え（`join` ノードの `planJoin` と同じ規則）。 */
function joinColumnsOf(left: readonly string[], right: readonly string[], config: Record<string, unknown>): { columns: string[]; renames: Map<string, string> } {
  const suffix = typeof config['rightSuffix'] === 'string' ? config['rightSuffix'] : DEFAULT_RIGHT_SUFFIX;
  const keys = Array.isArray(config['keys']) ? (config['keys'] as readonly unknown[]) : [];
  const rightKeys = new Set(keys.map((key) => (typeof key === 'string' ? key : String((key as { right?: unknown } | null)?.right ?? ''))));
  const columns = [...left];
  const used = new Set(columns);
  const renames = new Map<string, string>();
  for (const name of right) {
    if (rightKeys.has(name)) continue;
    const outName = used.has(name) ? `${name}${suffix}` : name;
    if (used.has(outName)) continue;
    used.add(outName);
    columns.push(outName);
    renames.set(name, outName);
  }
  return { columns, renames };
}

/** ある node から前向きに辿れるノード id（その join より下流か、を見るのに使う）。 */
function downstreamOf(nodeId: string, edges: readonly GraphEdge[]): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const edge of edges) {
      if (edge.from !== current || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/** ある node へ後ろ向きに辿れるノード id。 */
function upstreamOf(nodeId: string, edges: readonly GraphEdge[]): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const edge of edges) {
      if (edge.to !== current || seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }
  return seen;
}

/**
 * 引数の設計時サンプルを、宣言した型のセルへ寄せる。
 * `nullable` は上書き後の効く値（任意なら見本が無くても null を置ける）。
 */
function sampleOf(argument: ToolTemplateArgument, nullable: boolean, resolved: unknown): string | number | boolean | null {
  const flat = Array.isArray(resolved) ? (resolved as readonly unknown[]).map(String).join(',') : resolved;
  if (flat === null || flat === undefined) {
    if (nullable) return null;
    throw new ToolTemplateError(`argument '${argument.name}' has no design-time sample; give it a literal "sample", or declare it "nullable": true`);
  }
  switch (argument.type) {
    case 'number': {
      const numeric = Number(flat);
      if (!Number.isFinite(numeric)) {
        throw new ToolTemplateError(`argument '${argument.name}' is declared "type": "number" but its sample is ${JSON.stringify(flat)}; use a numeric sample or change the argument's type`);
      }
      return numeric;
    }
    case 'boolean':
      return typeof flat === 'boolean' ? flat : String(flat) === 'true';
    default:
      // date は ISO 文字列のまま置く（`agent-input` が実行時に Date へ寄せる）。
      return String(flat);
  }
}

/**
 * テンプレートとスロット値から Tool のグラフ・引数宣言・説明文を決定的に組み立てる。
 *
 * 前提: `validateSlotValues(template, values, facts)` が空を返していること。ここは
 * 「正しいスロット値は必ず正しいグラフになる」だけを担い、成立しない組み合わせは
 * `ToolTemplateError`（理由と直し方つき）で止める。
 */
export function instantiateTemplate(
  template: ToolTemplate,
  values: TemplateSlotValues,
  facts: TemplateProfileFacts,
  options: InstantiateTemplateOptions,
): InstantiatedTemplate {
  if (!TEMPLATE_FUNCTION_NAME_PATTERN.test(options.toolName)) {
    throw new ToolTemplateError(`'${options.toolName}' cannot be published as a function name (allowed: letters, digits, '_' and '-', 1..64 characters); pass an ASCII name such as the tool plan key`);
  }
  const raw = withSlotDefaults(template, values);
  // 引数の上書きは application でも同じ検査を通すが（違反を 422 の欄ごとの指摘にするため）、
  // Factory など他の呼び出し元のためにここでも止める（検査を飛ばした上書きが黙って効かないように）。
  const overrides = options.argumentNullability;
  const argumentViolations = overrides === undefined ? [] : argumentNullabilityViolations(template, raw, overrides);
  if (argumentViolations.length > 0) {
    throw new ToolTemplateError(argumentViolations.map((violation) => violation.message).join('; '));
  }
  const nullableOf = (argument: ToolTemplateArgument): boolean => effectiveNullable(argument, overrides);
  const surviving = survivingNodeIds(template, raw);
  const edges = bridgedEdges(template, raw, surviving);
  const instantiator = new Instantiator(template, facts);
  const baseScope: SubstitutionScope = { values: raw, raw, loop: {} };

  const keptNodes = template.nodes.filter((node) => surviving.has(node.id));
  const typeOf = (node: ToolTemplateNode): string => {
    if (typeof node.type === 'string') return node.type;
    return String(instantiator.substitute(node.type, baseScope, `node '${node.id}'.type`));
  };

  // 第 1 段: 読み替え無しで組む。結合より上流のノードはこれが最終形で、
  // 結合の suffix を決めるのに要る列名（`select.columns` / `join.keys`）もここで確定する。
  const firstPass: GraphNode[] = keptNodes.map((node) => ({
    id: node.id,
    type: typeOf(node),
    config: instantiator.substitute(node.config, baseScope, `node '${node.id}'.config`) ?? {},
  }));

  // 第 2 段: 結合の右側から来た列を指すスロットを、join より下流でだけ suffix 付きへ読み替える。
  const columnsOf = branchColumnsOf(firstPass, edges, facts);
  const slotValuesPerNode = new Map<string, TemplateSlotValues>();
  const columnSlots: Record<string, string> = {};
  const renamedBySlot: Record<string, string | number | readonly string[] | undefined> = { ...raw };
  const joins = firstPass.filter((node) => node.type === 'join');
  const affectedByJoin: { readonly join: string; readonly slots: ReadonlySet<string> }[] = [];

  for (const join of joins) {
    const inputs = edges.filter((edge) => edge.to === join.id).sort((a, b) => (a.toInput ?? 0) - (b.toInput ?? 0));
    const leftColumns = inputs[0] === undefined ? [] : columnsOf(inputs[0].from);
    const rightColumns = inputs[1] === undefined ? [] : columnsOf(inputs[1].from);
    const { renames } = joinColumnsOf(leftColumns, rightColumns, (join.config ?? {}) as Record<string, unknown>);
    const rightSources = new Set<string>();
    if (inputs[1] !== undefined) {
      for (const id of [inputs[1].from, ...upstreamOf(inputs[1].from, edges)]) {
        const config = (firstPass.find((node) => node.id === id)?.config ?? {}) as Record<string, unknown>;
        if (typeof config['dataSourceId'] === 'string') rightSources.add(config['dataSourceId']);
      }
    }
    const affected = new Set<string>();
    for (const slot of template.slots) {
      if (slot.kind !== 'column') continue;
      const sourceId = raw[slot.source];
      if (typeof sourceId !== 'string' || !rightSources.has(sourceId)) continue;
      const current = renamedBySlot[slot.name];
      if (current === undefined) continue;
      const rename = (name: string): string => renames.get(name) ?? name;
      renamedBySlot[slot.name] = Array.isArray(current) ? (current as readonly string[]).map(rename) : rename(String(current));
      affected.add(slot.name);
    }
    affectedByJoin.push({ join: join.id, slots: affected });
  }

  for (const node of firstPass) {
    // そのノードより上流に join があれば、その join の読み替えを適用する。
    const upstream = upstreamOf(node.id, edges);
    const applied: Record<string, string | number | readonly string[] | undefined> = { ...raw };
    for (const entry of affectedByJoin) {
      if (!upstream.has(entry.join)) continue;
      for (const slot of entry.slots) applied[slot] = renamedBySlot[slot];
    }
    slotValuesPerNode.set(node.id, applied);
  }

  const nodes: GraphNode[] = keptNodes.map((node, index) => {
    const applied = slotValuesPerNode.get(node.id) ?? raw;
    const scope: SubstitutionScope = { values: applied, raw, loop: {} };
    const changed = template.slots.some((slot) => applied[slot.name] !== raw[slot.name]);
    if (!changed) return firstPass[index]!;
    return {
      id: node.id,
      type: firstPass[index]!.type,
      config: instantiator.substitute(node.config, scope, `node '${node.id}'.config`) ?? {},
    };
  });

  // 実体化後の列名 → スロット名（最下流の読み替えを採る: 検証の問題文はそこで出る）。
  const lastJoin = joins[joins.length - 1];
  const downstream = lastJoin === undefined ? new Set<string>() : downstreamOf(lastJoin.id, edges);
  for (const slot of template.slots) {
    if (slot.kind !== 'column') continue;
    const value = downstream.size === 0 ? raw[slot.name] : renamedBySlot[slot.name];
    for (const column of Array.isArray(value) ? (value as readonly string[]) : (isEmpty(value) ? [] : [textOf(value)])) {
      columnSlots[column] = slot.name;
    }
  }

  // 引数（残ったものだけ）→ `agent-input` ノード。
  const keptArguments = survivingArguments(template, raw);
  const columns: Column[] = keptArguments.map((argument) => ({ name: argument.name, type: argument.type, nullable: nullableOf(argument) }));
  const sample: Record<string, string | number | boolean | null> = {};
  for (const argument of keptArguments) {
    sample[argument.name] = sampleOf(argument, nullableOf(argument), instantiator.substitute(argument.sample, baseScope, `argument '${argument.name}'.sample`));
  }
  const inputSchema: Schema | undefined = columns.length === 0 ? undefined : { columns };
  if (inputSchema !== undefined) {
    nodes.push({ id: TEMPLATE_ARGUMENTS_NODE_ID, type: 'agent-input', config: { schema: inputSchema, sample } });
  }

  // 落ちた引数を束縛したままの条件が残っていないことは読み込み時には見られない（`when` 次第）ので、
  // ここで確かめる: 宣言の無い引数を参照する filter は実行時に必ず落ちる。
  const declared = new Set(keptArguments.map((argument) => argument.name));
  for (const node of nodes) {
    for (const reference of collectReferences(node.config, `node '${node.id}'.config`)) {
      if (reference.kind !== 'argument' || declared.has(reference.name)) continue;
      throw new ToolTemplateError(`${reference.path} binds the argument '${reference.name}', which was dropped with its "when"; give the node the same "when" as the argument`);
    }
  }

  // 引数の説明は Tool の説明文に連結する。入力スキーマの列は名前・型・null 可否しか持たず、
  // モデルへ届く文章は Tool の説明文だけである（実測: 説明が届かず granularity に "monthly" を渡して 0 行になった）。
  const summary = interpolate(template.description[options.language], baseScope, 'description');
  const argumentLines = keptArguments.map((argument) => {
    const required = nullableOf(argument) ? (options.language === 'ja' ? '省略可' : 'optional') : (options.language === 'ja' ? '必須' : 'required');
    return `- ${argument.name} (${required}): ${interpolate(argument.description[options.language], baseScope, `argument '${argument.name}'.description`)}`;
  });
  const description = argumentLines.length === 0
    ? summary
    : [summary, options.language === 'ja' ? '引数:' : 'Arguments:', ...argumentLines].join('\n');

  return {
    graph: { nodes, edges },
    ...(inputSchema === undefined ? {} : { inputSchema }),
    agentTool: { name: options.toolName, description },
    pendingExpressions: keptNodes.flatMap((node) =>
      collectReferences(node.config, `node '${node.id}'.config`)
        .filter((reference) => reference.kind === 'intent')
        .map((reference) => ({ nodeId: node.id, intent: textOf(raw[reference.name]) }))),
    columnSlots,
  };
}

/**
 * `$intent` の calculate ノードへ式を入れた新しい結果を返す（純関数）。
 * 式提案（v41）が書いた式を実体化の結果へ戻すための唯一の入口。
 */
export function withPendingExpression(instantiated: InstantiatedTemplate, nodeId: string, expression: string): InstantiatedTemplate {
  if (!instantiated.pendingExpressions.some((entry) => entry.nodeId === nodeId)) return instantiated;
  return {
    ...instantiated,
    graph: {
      nodes: instantiated.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, config: { ...(node.config as Record<string, unknown>), expression } } : node),
      edges: instantiated.graph.edges,
    },
    pendingExpressions: instantiated.pendingExpressions.filter((entry) => entry.nodeId !== nodeId),
  };
}

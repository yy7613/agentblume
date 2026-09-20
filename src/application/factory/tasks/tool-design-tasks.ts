/**
 * application層: 段階的ツール生成の 4 つの設計タスク（v42 実装契約 §4「タスク定義」）。
 *
 * 規律は 3 つだけ:
 * 1. **選択肢を閉じる** — 列名・キー・粒度・並び順はプロファイルから作った `enum` の中からしか選べない。
 *    自由記述は「引数名」と「計算の意図」だけ（12B 級のモデルが列名を書き間違える余地を構造から消す）。
 * 2. **材料は最小** — プロファイル全体（サンプル行・全列・全カテゴリ値）は渡さない。各タスクが決めるのに
 *    要る分（期間列の粒度内訳、カテゴリ列の値の先頭 8 件、数値列名、列一覧）だけを載せる。
 * 3. **スキーマで言えないことは `parse` で言う** — 引数名の形・予約名・重複・件数上限・`limit` の範囲は
 *    構造化出力では縛れないので、決定的に検査して「そのまま直せる英文」で差し戻す。
 */
import { PERIOD_GRANULARITIES, type PeriodGranularity } from '../../../domain/etl/nodes/parse-period';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import { MAX_TOOL_CALLS } from '../../agent/run-agent-preview';
import { supportsMultiValueFilterOps } from '../roles/tool-smith-role';
import type { JsonSchemaProperty } from '../../model/model-provider';
import type { DataProfile, JoinCandidate } from '../profile-data-sources';
import type { RoleTask, RoleTaskParseResult } from './role-task';
import {
  MAX_TOOL_SPEC_CATEGORY_FILTERS,
  MAX_TOOL_SPEC_COMPUTATIONS,
  MAX_TOOL_SPEC_JOIN_KEYS,
  MAX_TOOL_SPEC_LIMIT,
  MIN_TOOL_SPEC_LIMIT,
  PERIOD_GRANULARITY_COLUMN,
  PERIOD_START_COLUMN,
  RESERVED_TOOL_SPEC_ARGUMENTS,
  TOOL_SPEC_ARGUMENT_PATTERN,
  type ToolSpecCategoryFilter,
  type ToolSpecComputation,
  type ToolSpecJoin,
  type ToolSpecOutput,
  type ToolSpecPeriod,
} from '../../../domain/factory/tool-spec';

/** カテゴリ列ごとに材料として見せる実在値の件数（全値は渡さない）。 */
export const CATEGORY_VALUE_SAMPLE = 8;

/** コンパイラが `parse-period` で足す列（計算列の名前が衝突してはいけない）。 */
export const COMPILER_ADDED_COLUMNS: readonly string[] = [PERIOD_START_COLUMN, PERIOD_GRANULARITY_COLUMN];

const JOIN_MODES: readonly string[] = ['inner', 'left'];
const OUTPUT_SORTS: readonly string[] = ['latest-first', 'oldest-first', 'none'];

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function list(values: readonly string[]): string {
  return values.join(', ');
}

function quote(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value) ?? 'nothing';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(content: string | null): RoleTaskParseResult<Record<string, unknown>> {
  if (content === null || content.trim() === '') {
    return { ok: false, issues: ['The response was empty. Return a JSON object matching the schema.'] };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, issues: ['The response was not valid JSON. Return only a JSON object matching the schema.'] };
  }
  if (!isRecord(value)) return { ok: false, issues: ['The response must be a JSON object.'] };
  return { ok: true, value };
}

/** 決定的な並びで、このプロファイル群の数値列名を集める。 */
function numericColumnsOf(profiles: readonly DataProfile[]): string[] {
  return unique(profiles.flatMap((profile) => profile.columns.filter((column) => column.type === 'number').map((column) => column.name)));
}

/** 結合後の表に存在しうる列名（計算列の名前の衝突判定に使う。materials としては渡さない）。 */
function existingColumnsOf(profiles: readonly DataProfile[]): string[] {
  return unique([...profiles.flatMap((profile) => profile.columns.map((column) => column.name)), ...COMPILER_ADDED_COLUMNS]);
}

/** 期間列に実在する粒度（`unknown` は除く）。`PERIOD_GRANULARITIES` の順で並べて決定的にする。 */
export function granularitiesOf(period: DataProfile['periodColumns'][number]): PeriodGranularity[] {
  return PERIOD_GRANULARITIES.filter((granularity) => granularity !== 'unknown' && (period.granularities[granularity] ?? 0) > 0);
}

/** このツールが束ねるソースの組み合わせに関係する結合候補だけを取り出す（向きは問わない）。 */
export function joinCandidatesFor(profiles: readonly DataProfile[]): JoinCandidate[] {
  const involved = new Set(profiles.map((profile) => profile.dataSourceId));
  const primary = profiles[0];
  if (primary === undefined) return [];
  return (primary.joinCandidates ?? []).filter((candidate) => involved.has(candidate.leftDataSourceId) && involved.has(candidate.rightDataSourceId));
}

/** 目標の本文だけを材料として載せる（言語は説明文の言語決定に要る）。 */
function goalMaterial(goal: FactoryGoalInput): Record<string, unknown> {
  return {
    goal: goal.goal,
    ...(goal.targetUsers === undefined ? {} : { targetUsers: goal.targetUsers }),
    ...(goal.constraints === undefined ? {} : { constraints: goal.constraints }),
    language: goal.language,
  };
}

function planMaterial(plan: FactoryToolPlan): Record<string, unknown> {
  return {
    purpose: plan.purpose,
    ...(plan.argumentSummary === undefined ? {} : { argumentSummary: plan.argumentSummary }),
    ...(plan.outputShape === undefined ? {} : { outputShape: plan.outputShape }),
  };
}

/** 引数名 1 つを検査する（形 → 予約名 → 重複 の順で、最初に当たった 1 件だけ返す）。 */
function argumentIssue(label: string, value: unknown, used: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string' || !TOOL_SPEC_ARGUMENT_PATTERN.test(value)) {
    return `${label} ${quote(value)} must be snake_case matching ${TOOL_SPEC_ARGUMENT_PATTERN.source}: a lowercase letter, then lowercase letters, digits or underscores, at most 40 characters.`;
  }
  if (RESERVED_TOOL_SPEC_ARGUMENTS.includes(value)) {
    return `${label} ${quote(value)} is a reserved argument name. The tool declares ${list(RESERVED_TOOL_SPEC_ARGUMENTS)} itself; pick another name.`;
  }
  if (used.has(value)) {
    return `${label} ${quote(value)} is already used by another filter. Every argument name must be unique.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// T0 decide-join
// ---------------------------------------------------------------------------

export interface DecideJoinInput {
  readonly plan: FactoryToolPlan;
  /** 主ソースを先頭にした、このツールが束ねるソースのプロファイル。 */
  readonly profiles: readonly DataProfile[];
}

/** 候補が挙げているキー列の和集合（enum の材料）。 */
export function joinKeyChoices(input: DecideJoinInput): string[] {
  return unique(joinCandidatesFor(input.profiles).flatMap((candidate) => candidate.keys));
}

export const decideJoinTask: RoleTask<DecideJoinInput, ToolSpecJoin> = {
  name: 'decide-join',
  goal: 'You decide how this tool joins its data sources: which shared key columns it joins on, and which join mode it uses.',
  rules: [
    '- Take every key from joinCandidates[].keys. Never invent a column, and never join on a note or free-text column (注記, remarks, 備考).',
    '- Join on ALL the keys the candidate lists (for example BOTH the period AND the region code). One key alone matches every region with every region and multiplies the rows.',
    '- When the sources share both a code and a name for the same thing, the code alone is enough; list the name only if there is no code.',
    `- Use at most ${MAX_TOOL_SPEC_JOIN_KEYS} keys, each one at most once.`,
    "- Use mode 'inner' — it keeps exactly the rows where every source has a value, which is what putting values side by side means.",
    "- Use mode 'left' only when the purpose explicitly needs rows that exist in the primary source alone.",
    '- uniqueLeft / uniqueRight false only means the tool has to narrow that side later; it is not a reason to drop a key.',
  ],
  schema(input) {
    const choices = joinKeyChoices(input);
    const key: JsonSchemaProperty = choices.length === 0 ? { type: 'string' } : { type: 'string', enum: choices };
    return {
      type: 'object',
      additionalProperties: false,
      required: ['keys', 'mode'],
      properties: {
        keys: { type: 'array', items: key },
        mode: { type: 'string', enum: JOIN_MODES },
      },
    };
  },
  payload(input) {
    return {
      ...planMaterial(input.plan),
      sources: input.profiles.map((profile, index) => ({ dataSourceId: profile.dataSourceId, name: profile.name, role: index === 0 ? 'primary' : 'additional' })),
      joinCandidates: joinCandidatesFor(input.profiles).map((candidate) => ({
        leftDataSourceId: candidate.leftDataSourceId,
        rightDataSourceId: candidate.rightDataSourceId,
        keys: candidate.keys,
        overlap: candidate.overlap,
        uniqueLeft: candidate.uniqueLeft,
        uniqueRight: candidate.uniqueRight,
      })),
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const choices = joinKeyChoices(input);
    const issues: string[] = [];

    const rawKeys = root.value['keys'];
    const keys: string[] = [];
    if (!Array.isArray(rawKeys)) {
      issues.push('keys must be an array of column names.');
    } else if (rawKeys.length === 0) {
      issues.push(`keys must contain at least one column. Choose from: ${choices.length === 0 ? '(no join key candidate is available for these data sources)' : list(choices)}.`);
    } else if (rawKeys.length > MAX_TOOL_SPEC_JOIN_KEYS) {
      issues.push(`keys must contain at most ${MAX_TOOL_SPEC_JOIN_KEYS} columns. Received ${rawKeys.length}.`);
    } else {
      const seen = new Set<string>();
      rawKeys.forEach((value: unknown, index: number) => {
        if (typeof value !== 'string' || !choices.includes(value)) {
          issues.push(`keys[${index}] must be one of the shared key columns: ${choices.length === 0 ? '(none available)' : list(choices)}. Received ${quote(value)}.`);
          return;
        }
        if (seen.has(value)) {
          issues.push(`keys[${index}] ${quote(value)} is listed twice. List every join key exactly once.`);
          return;
        }
        seen.add(value);
        keys.push(value);
      });
    }

    const mode = root.value['mode'];
    if (typeof mode !== 'string' || !JOIN_MODES.includes(mode)) {
      issues.push(`mode must be one of: ${list(JOIN_MODES)}. Received ${quote(mode)}.`);
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { keys, mode: mode as ToolSpecJoin['mode'] } };
  },
};

// ---------------------------------------------------------------------------
// T1 decide-filters
// ---------------------------------------------------------------------------

export interface DecideFiltersInput {
  readonly plan: FactoryToolPlan;
  readonly goal: FactoryGoalInput;
  /** 主ソースを先頭にした、このツールが束ねるソースのプロファイル。 */
  readonly profiles: readonly DataProfile[];
}

export interface DecideFiltersOutput {
  readonly period?: ToolSpecPeriod;
  readonly categoryFilters: readonly ToolSpecCategoryFilter[];
}

/** 期間列は主ソースのものだけを使う（契約 §3: `parse-period` は結合後に主ソースの列へ 1 回だけ掛ける）。 */
export function periodColumnsOf(input: DecideFiltersInput): DataProfile['periodColumns'] {
  return (input.profiles[0]?.periodColumns ?? []).filter((period) => granularitiesOf(period).length > 0);
}

/**
 * カテゴリ列も主ソースのものだけを使う（`validateToolSpec` が主ソースの `categoricalColumns` しか
 * 受け付けないため。追加ソース固有の列を選ばせると、コンパイル前の検証で必ず差し戻しになる）。
 */
export function categoricalColumnsOf(input: DecideFiltersInput): DataProfile['categoricalColumns'] {
  return (input.profiles[0]?.categoricalColumns ?? []).filter((column) => column.values.length > 0);
}

export const decideFiltersTask: RoleTask<DecideFiltersInput, DecideFiltersOutput> = {
  name: 'decide-filters',
  goal: 'You decide how this tool narrows its rows: how it handles the period column, and which category columns it exposes as call arguments.',
  rules: [
    '- When a period column has "mixed": true, rows of several granularities share it, so you MUST pin the granularity: pick a fixed one, or \'argument\'.',
    "- Pick 'argument' only when the goal really needs more than one granularity (monthly AND yearly); then defaultGranularity must be one of the granularities present in that column.",
    "- With a fixed granularity, leave defaultGranularity null. Set period to null only when the data has no period column.",
    '- Set range to true whenever the goal mentions a span of time, a trend, the latest figures, or a maximum over time; false only for a single fixed label.',
    supportsMultiValueFilterOps()
      ? '- Add a category filter only for a column the goal actually narrows on, and always set multi to true: one call must be able to ask for several values, or a comparison costs one call per value.'
      : '- Add a category filter only for a column the goal actually narrows on; multi must be false because this build accepts a single value per argument.',
    `- Keep at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS} category filters: the conversation has only ${MAX_TOOL_CALLS} tool calls, and every extra argument is one more thing the agent can get wrong.`,
    `- Argument names are snake_case (${TOOL_SPEC_ARGUMENT_PATTERN.source}), unique, and may not be ${list(RESERVED_TOOL_SPEC_ARGUMENTS)}: the tool declares those itself.`,
    '- An empty categoryFilters array is the right answer when the goal needs no narrowing by category.',
  ],
  schema(input) {
    const periods = periodColumnsOf(input);
    const granularities = unique(periods.flatMap((period) => granularitiesOf(period)));
    const categorical = categoricalColumnsOf(input).map((column) => column.column);
    const period: JsonSchemaProperty = periods.length === 0
      ? { type: 'null' }
      : {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['column', 'granularity', 'defaultGranularity', 'range'],
        properties: {
          column: { type: 'string', enum: periods.map((entry) => entry.column) },
          granularity: { type: 'string', enum: [...granularities, 'argument'] },
          defaultGranularity: { type: ['string', 'null'], enum: [...granularities, null] },
          range: { type: 'boolean' },
        },
      };
    return {
      type: 'object',
      additionalProperties: false,
      required: ['period', 'categoryFilters'],
      properties: {
        period,
        categoryFilters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['column', 'argument', 'multi'],
            properties: {
              column: categorical.length === 0 ? { type: 'string' } : { type: 'string', enum: categorical },
              argument: { type: 'string' },
              multi: { type: 'boolean' },
            },
          },
        },
      },
    };
  },
  payload(input) {
    return {
      ...planMaterial(input.plan),
      ...goalMaterial(input.goal),
      maxToolCalls: MAX_TOOL_CALLS,
      periodColumns: periodColumnsOf(input).map((period) => ({
        column: period.column,
        granularities: period.granularities,
        ...(period.minStart === undefined ? {} : { minStart: period.minStart }),
        ...(period.maxStart === undefined ? {} : { maxStart: period.maxStart }),
        mixed: period.mixed,
      })),
      categoricalColumns: categoricalColumnsOf(input).map((column) => ({
        column: column.column,
        distinctCount: column.distinctCount,
        values: column.values.slice(0, CATEGORY_VALUE_SAMPLE),
      })),
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const issues: string[] = [];
    const periods = periodColumnsOf(input);
    const periodNames = periods.map((entry) => entry.column);
    const allGranularities = unique(periods.flatMap((period) => granularitiesOf(period)));
    const categorical = categoricalColumnsOf(input).map((column) => column.column);

    let period: ToolSpecPeriod | undefined;
    const rawPeriod = root.value['period'];
    if (rawPeriod !== null && rawPeriod !== undefined) {
      if (!isRecord(rawPeriod)) {
        issues.push('period must be an object with column, granularity, defaultGranularity and range, or null.');
      } else if (periodNames.length === 0) {
        issues.push('period must be null: this tool has no period column to parse.');
      } else {
        const column = rawPeriod['column'];
        const valid = typeof column === 'string' && periodNames.includes(column);
        if (!valid) issues.push(`period.column must be one of: ${list(periodNames)}. Received ${quote(column)}.`);
        const matched = valid ? periods.find((entry) => entry.column === column) : undefined;
        const available: string[] = matched === undefined ? allGranularities : granularitiesOf(matched);
        const granularity = rawPeriod['granularity'];
        const allowed = [...available, 'argument'];
        const granularityValid = typeof granularity === 'string' && allowed.includes(granularity);
        if (!granularityValid) issues.push(`period.granularity must be one of: ${list(allowed)}. Received ${quote(granularity)}.`);
        const rawDefault = rawPeriod['defaultGranularity'];
        const hasDefault = rawDefault !== null && rawDefault !== undefined && rawDefault !== '';
        if (granularity === 'argument') {
          if (!hasDefault) {
            issues.push(`period.defaultGranularity is required when period.granularity is 'argument'. Pick the granularity to fall back on, one of: ${list(available)}.`);
          } else if (typeof rawDefault !== 'string' || !available.includes(rawDefault)) {
            issues.push(`period.defaultGranularity must be a granularity present in the data: one of ${list(available)}. Received ${quote(rawDefault)}.`);
          }
        } else if (hasDefault) {
          issues.push("period.defaultGranularity must be null unless period.granularity is 'argument'.");
        }
        const range = rawPeriod['range'];
        if (typeof range !== 'boolean') issues.push(`period.range must be true or false. Received ${quote(range)}.`);
        if (valid && granularityValid && typeof range === 'boolean' && issues.length === 0) {
          period = {
            column: column as string,
            granularity: granularity as ToolSpecPeriod['granularity'],
            ...(granularity === 'argument' ? { defaultGranularity: rawDefault as PeriodGranularity } : {}),
            range,
          };
        }
      }
    }

    const categoryFilters: ToolSpecCategoryFilter[] = [];
    const rawFilters = root.value['categoryFilters'];
    const entries: readonly unknown[] = rawFilters === undefined ? [] : (Array.isArray(rawFilters) ? rawFilters : []);
    if (rawFilters !== undefined && !Array.isArray(rawFilters)) {
      issues.push('categoryFilters must be an array (use an empty array when the tool needs no category argument).');
    } else if (entries.length > MAX_TOOL_SPEC_CATEGORY_FILTERS) {
      issues.push(`categoryFilters must contain at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS} entries. Received ${entries.length}.`);
    } else {
      const usedColumns = new Set<string>();
      const usedArguments = new Set<string>();
      entries.forEach((entry: unknown, index: number) => {
        if (!isRecord(entry)) {
          issues.push(`categoryFilters[${index}] must be an object with column, argument and multi.`);
          return;
        }
        const column = entry['column'];
        let columnOk = false;
        if (categorical.length === 0) {
          issues.push(`categoryFilters[${index}].column cannot be set: this tool has no categorical column, so categoryFilters must be empty.`);
        } else if (typeof column !== 'string' || !categorical.includes(column)) {
          issues.push(`categoryFilters[${index}].column must be one of: ${list(categorical)}. Received ${quote(column)}.`);
        } else if (usedColumns.has(column)) {
          issues.push(`categoryFilters[${index}].column ${quote(column)} is already filtered by another entry. Filter each column at most once.`);
        } else {
          usedColumns.add(column);
          columnOk = true;
        }
        const argument = entry['argument'];
        const argumentProblem = argumentIssue(`categoryFilters[${index}].argument`, argument, usedArguments);
        if (argumentProblem !== undefined) issues.push(argumentProblem);
        else usedArguments.add(argument as string);
        const multi = entry['multi'];
        if (typeof multi !== 'boolean') issues.push(`categoryFilters[${index}].multi must be true or false. Received ${quote(multi)}.`);
        if (columnOk && argumentProblem === undefined && typeof multi === 'boolean') {
          categoryFilters.push({ column: column as string, argument: argument as string, multi });
        }
      });
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { ...(period === undefined ? {} : { period }), categoryFilters } };
  },
};

// ---------------------------------------------------------------------------
// T2 decide-computations
// ---------------------------------------------------------------------------

export interface DecideComputationsInput {
  readonly plan: FactoryToolPlan;
  readonly goal: FactoryGoalInput;
  /** 主ソースを先頭にした、このツールが束ねるソースのプロファイル。 */
  readonly profiles: readonly DataProfile[];
}

export interface DecideComputationsOutput {
  readonly computations: readonly ToolSpecComputation[];
}

export const decideComputationsTask: RoleTask<DecideComputationsInput, DecideComputationsOutput> = {
  name: 'decide-computations',
  goal: 'You decide which computed columns this tool should add, and describe in plain language what each one must compute.',
  rules: [
    '- Do NOT write a formula or any arithmetic syntax. Name the new column and say in ONE plain sentence what it should mean.',
    '- Propose a computation only for arithmetic BETWEEN COLUMNS OF THE SAME ROW: a difference, a ratio, a percentage, a per-capita value, a share of a total.',
    '- The expression language cannot do conditionals (if/case), text handling, aggregation over rows (sum/average/count), or comparison with a previous row. Never ask for those.',
    '- Refer only to the numeric columns listed in numericColumns; never mention a column that is not there.',
    '- outputColumn must be a NEW column name that does not already exist in the table, and every outputColumn must differ from the others.',
    `- Propose at most ${MAX_TOOL_SPEC_COMPUTATIONS} computations.`,
    '- An EMPTY computations array is the right answer whenever the goal needs no arithmetic between columns. That is the normal case; do not invent work.',
  ],
  schema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['computations'],
      properties: {
        computations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['outputColumn', 'intent'],
            properties: {
              outputColumn: { type: 'string' },
              intent: { type: 'string' },
            },
          },
        },
      },
    };
  },
  payload(input) {
    return {
      ...planMaterial(input.plan),
      ...goalMaterial(input.goal),
      numericColumns: numericColumnsOf(input.profiles),
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const issues: string[] = [];
    const existing = existingColumnsOf(input.profiles);
    const computations: ToolSpecComputation[] = [];

    const rawComputations = root.value['computations'];
    if (rawComputations !== undefined && !Array.isArray(rawComputations)) {
      issues.push('computations must be an array (use an empty array when no column arithmetic is needed).');
      return { ok: false, issues };
    }
    const entries: readonly unknown[] = Array.isArray(rawComputations) ? rawComputations : [];
    if (entries.length > MAX_TOOL_SPEC_COMPUTATIONS) {
      issues.push(`computations must contain at most ${MAX_TOOL_SPEC_COMPUTATIONS} entries. Received ${entries.length}.`);
      return { ok: false, issues };
    }
    const used = new Set<string>();
    entries.forEach((entry: unknown, index: number) => {
      if (!isRecord(entry)) {
        issues.push(`computations[${index}] must be an object with outputColumn and intent.`);
        return;
      }
      const outputColumn = entry['outputColumn'];
      let columnOk = false;
      if (typeof outputColumn !== 'string' || outputColumn.trim() === '') {
        issues.push(`computations[${index}].outputColumn must be a non-empty column name. Received ${quote(outputColumn)}.`);
      } else if (existing.includes(outputColumn)) {
        issues.push(`computations[${index}].outputColumn ${quote(outputColumn)} already exists in the table. Choose a new column name.`);
      } else if (used.has(outputColumn)) {
        issues.push(`computations[${index}].outputColumn ${quote(outputColumn)} is used by another computation. Every computed column needs its own name.`);
      } else {
        used.add(outputColumn);
        columnOk = true;
      }
      const intent = entry['intent'];
      const intentOk = typeof intent === 'string' && intent.trim() !== '';
      if (!intentOk) issues.push(`computations[${index}].intent must be one plain sentence saying what to compute. Received ${quote(intent)}.`);
      if (columnOk && intentOk) computations.push({ outputColumn: outputColumn as string, intent: intent as string });
    });

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { computations } };
  },
};

// ---------------------------------------------------------------------------
// T3 decide-output
// ---------------------------------------------------------------------------

export interface DecideOutputInput {
  readonly plan: FactoryToolPlan;
  /** 結合・計算のあとに表へ残っている列（コンパイラの途中結果からオーケストレータが渡す）。 */
  readonly availableColumns: readonly string[];
  /** 引数を省略した呼び出しが返しうる行数の目安。 */
  readonly estimatedRows: number;
}

export const decideOutputTask: RoleTask<DecideOutputInput, ToolSpecOutput> = {
  name: 'decide-output',
  goal: 'You decide which columns this tool returns, how its rows are sorted, and how many rows one call returns.',
  rules: [
    '- Keep the period label column, the value columns the purpose is about, and every computed column. Dropping them makes the answer unusable.',
    '- Return an EMPTY columns array to keep every column. List columns only to drop clutter the purpose does not need.',
    '- Never list a column that is not in availableColumns, and never list the same column twice.',
    "- Use sort 'latest-first' when the purpose wants the newest figures, 'oldest-first' for a chronological trend, and 'none' when the rows have no period.",
    `- limit is a whole number between ${MIN_TOOL_SPEC_LIMIT} and ${MAX_TOOL_SPEC_LIMIT}. It bounds a call made with no arguments at all, so it must not overflow.`,
    '- Compare limit with estimatedRows: when the estimate is larger, the sort decides which rows survive, so pick the sort that keeps the rows the purpose cares about.',
  ],
  schema(input) {
    const columns: JsonSchemaProperty = input.availableColumns.length === 0
      ? { type: 'string' }
      : { type: 'string', enum: [...input.availableColumns] };
    return {
      type: 'object',
      additionalProperties: false,
      required: ['columns', 'sort', 'limit'],
      properties: {
        columns: { type: 'array', items: columns },
        sort: { type: 'string', enum: OUTPUT_SORTS },
        limit: { type: 'number', minimum: MIN_TOOL_SPEC_LIMIT, maximum: MAX_TOOL_SPEC_LIMIT },
      },
    };
  },
  payload(input) {
    return {
      ...planMaterial(input.plan),
      availableColumns: [...input.availableColumns],
      estimatedRows: input.estimatedRows,
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const issues: string[] = [];
    const available = input.availableColumns;
    const columns: string[] = [];

    const rawColumns = root.value['columns'];
    if (rawColumns !== undefined && !Array.isArray(rawColumns)) {
      issues.push('columns must be an array of column names (use an empty array to keep every column).');
    } else {
      const seen = new Set<string>();
      (Array.isArray(rawColumns) ? rawColumns : []).forEach((value: unknown, index: number) => {
        if (typeof value !== 'string' || !available.includes(value)) {
          issues.push(`columns[${index}] must be one of: ${available.length === 0 ? '(no column is available)' : list(available)}. Received ${quote(value)}.`);
          return;
        }
        if (seen.has(value)) {
          issues.push(`columns[${index}] ${quote(value)} is listed twice. List every column at most once.`);
          return;
        }
        seen.add(value);
        columns.push(value);
      });
    }

    const sort = root.value['sort'];
    if (typeof sort !== 'string' || !OUTPUT_SORTS.includes(sort)) {
      issues.push(`sort must be one of: ${list(OUTPUT_SORTS)}. Received ${quote(sort)}.`);
    }

    const limit = root.value['limit'];
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < MIN_TOOL_SPEC_LIMIT || limit > MAX_TOOL_SPEC_LIMIT) {
      issues.push(`limit must be a whole number between ${MIN_TOOL_SPEC_LIMIT} and ${MAX_TOOL_SPEC_LIMIT}. Received ${quote(limit)}.`);
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { columns, sort: sort as ToolSpecOutput['sort'], limit: limit as number } };
  },
};

/**
 * ドメイン: AI 判定ノード（`ai-judge`）。
 *
 * 各行を「利用者が日本語で書いた判定基準」に照らして、はい/いいえ（`yes` / `no` / `unclear`）または
 * 利用者が定義したカテゴリ（分類）に振り分ける。Dify の「質問分類器」「LLM 条件分岐」に相当するが、
 * このノード自身は LLM を呼ばない: 判定結果は実行直前にアプリ層（`ResolveAiJudgmentsUseCase`）が
 * `config.resolved.verdicts` として注入し、ここは注入済みの判定を**決定的に**行へ適用するだけである。
 * （EtlNode は同期・純粋で、LLM のような非同期 I/O は既存の行ソースと同じく事前解決で扱う。）
 *
 * - `flag`: 判定列（と理由列）を足して全行を通す。後段の `filter` で `aiVerdict eq yes` のように**決定的に分岐**できる。
 * - `keep` / `exclude`: 判定が `matchValues` に含まれる行だけを残す / 除く。`unclear` は明示的に選ばない限り「一致しない」。
 * - 判定対象の行は列の値で同一視する（同じ内容の行は 1 回だけ判定する）。件数上限（`maxItems`）を超えたら実行を止める。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

export const AI_JUDGE_TYPE = 'ai-judge';
/** 判断できなかった行の判定値（はい/いいえ・分類の両モード共通の予約語）。 */
export const AI_JUDGE_UNCLEAR = 'unclear';
/** はい/いいえモードの判定値。 */
export const AI_JUDGE_YES_NO_VALUES = ['yes', 'no', AI_JUDGE_UNCLEAR] as const;
/** 1 回の実行で判定できる行（重複除外後）の上限。ローカル LLM を回す前提の安全弁。 */
export const AI_JUDGE_MAX_ITEMS = 200;
export const AI_JUDGE_DEFAULT_MAX_ITEMS = 50;
export const AI_JUDGE_MAX_CATEGORIES = 20;

export type AiJudgeAction = 'flag' | 'keep' | 'exclude';
export type AiJudgeMode = 'yes-no' | 'classify';

export interface AiJudgeCategory {
  readonly name: string;
  readonly description?: string;
}

/** 1 行（内容で同一視した 1 件）の判定。 */
export interface AiJudgeVerdict {
  readonly value: string;
  readonly reason: string;
}

/** アプリ層が実行直前に注入する判定結果。キーは `aiJudgeItemKey`。保存済み Tool には含めない。 */
export interface AiJudgeResolved {
  readonly verdicts: Readonly<Record<string, AiJudgeVerdict>>;
}

export interface AiJudgeConfig {
  readonly configVersion: 1;
  /** 判定基準（日本語の質問文。例:「この問い合わせはクレームですか？」）。 */
  readonly question: string;
  /** 空なら はい/いいえ、1 つ以上なら分類モード。 */
  readonly categories: readonly AiJudgeCategory[];
  /** モデルに見せる列。空なら全列。 */
  readonly columns: readonly string[];
  readonly outputColumn: string;
  /** null なら理由列を出さない。 */
  readonly reasonColumn: string | null;
  readonly action: AiJudgeAction;
  /** keep / exclude で「一致」とみなす判定値。 */
  readonly matchValues: readonly string[];
  readonly maxItems: number;
  readonly resolved?: AiJudgeResolved;
}

const configSchema = z.object({
  configVersion: z.literal(1).default(1),
  question: z.string().max(2000).default(''),
  categories: z.array(z.object({ name: z.string().min(1).max(100), description: z.string().max(500).optional() })).max(AI_JUDGE_MAX_CATEGORIES).default([]),
  columns: z.array(z.string().min(1)).max(50).default([]),
  outputColumn: z.string().min(1).default('aiVerdict'),
  reasonColumn: z.string().min(1).nullable().default('aiReason'),
  action: z.enum(['flag', 'keep', 'exclude']).default('flag'),
  matchValues: z.array(z.string().min(1)).max(AI_JUDGE_MAX_CATEGORIES + 1).default(['yes']),
  maxItems: z.number().int().min(1).max(AI_JUDGE_MAX_ITEMS).default(AI_JUDGE_DEFAULT_MAX_ITEMS),
  resolved: z.object({ verdicts: z.record(z.string(), z.object({ value: z.string(), reason: z.string() })) }).optional(),
});

function validate(config: unknown): AiJudgeConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`ai-judge: invalid config: ${zodMessage(parsed.error)}`);
  return parsed.data;
}

export function aiJudgeMode(config: Pick<AiJudgeConfig, 'categories'>): AiJudgeMode {
  return config.categories.length === 0 ? 'yes-no' : 'classify';
}

/** この設定で出うる判定値（モデルの回答スキーマ・UI の選択肢・matchValues の検証が共有する）。 */
export function aiJudgeAllowedValues(config: Pick<AiJudgeConfig, 'categories'>): readonly string[] {
  return aiJudgeMode(config) === 'yes-no' ? [...AI_JUDGE_YES_NO_VALUES] : [...config.categories.map((category) => category.name), AI_JUDGE_UNCLEAR];
}

/** モデルに見せる列（設定が空なら入力の全列）。 */
export function aiJudgeColumns(input: Schema, config: Pick<AiJudgeConfig, 'columns'>): readonly string[] {
  return config.columns.length === 0 ? input.columns.map((column) => column.name) : config.columns;
}

function cellJson(cell: Cell): string | number | boolean | null {
  return cell instanceof Date ? cell.toISOString() : cell;
}

/** モデルへ渡す 1 行分の値（Date は ISO 文字列）。列の並びは `columns` の順で固定する。 */
export function aiJudgeItemValues(row: Row, columns: readonly string[]): Readonly<Record<string, string | number | boolean | null>> {
  const values: Record<string, string | number | boolean | null> = {};
  for (const column of columns) values[column] = cellJson(row[column] ?? null);
  return values;
}

/** 行を内容で同一視するキー（同じ値の行は同じ判定を受ける。判定の再利用・重複除外に使う）。 */
export function aiJudgeItemKey(row: Row, columns: readonly string[]): string {
  return JSON.stringify(columns.map((column) => cellJson(row[column] ?? null)));
}

/**
 * 設定と入力スキーマの整合（列の実在・カテゴリ名の重複・matchValues の妥当性・出力列の衝突）。
 * `inferSchema` は issue として返し、`execute` は最初のエラーを ConfigError / SchemaError として投げる。
 */
export function aiJudgeIssues(input: Schema, config: AiJudgeConfig): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (config.question.trim() === '') issues.push({ severity: 'error', message: 'ai-judge: question is required' });
  const names = new Set(input.columns.map((column) => column.name));
  for (const column of config.columns) {
    if (!names.has(column)) issues.push({ severity: 'error', message: `ai-judge: column not found: ${column}`, column });
  }
  const seen = new Set<string>();
  for (const category of config.categories) {
    if (category.name === AI_JUDGE_UNCLEAR) issues.push({ severity: 'error', message: `ai-judge: category name is reserved: ${AI_JUDGE_UNCLEAR}` });
    if (seen.has(category.name)) issues.push({ severity: 'error', message: `ai-judge: duplicate category: ${category.name}` });
    seen.add(category.name);
  }
  if (config.action !== 'flag') {
    const allowed = aiJudgeAllowedValues(config);
    if (config.matchValues.length === 0) issues.push({ severity: 'error', message: `ai-judge: matchValues is required when action is ${config.action}` });
    for (const value of config.matchValues) {
      if (!allowed.includes(value)) issues.push({ severity: 'error', message: `ai-judge: match value is not a possible verdict: ${value}` });
    }
  } else {
    if (names.has(config.outputColumn)) issues.push({ severity: 'error', message: `ai-judge: output column already exists: ${config.outputColumn}`, column: config.outputColumn });
    if (config.reasonColumn !== null && names.has(config.reasonColumn)) issues.push({ severity: 'error', message: `ai-judge: reason column already exists: ${config.reasonColumn}`, column: config.reasonColumn });
    if (config.reasonColumn !== null && config.reasonColumn === config.outputColumn) issues.push({ severity: 'error', message: `ai-judge: reason column must differ from the output column: ${config.outputColumn}` });
  }
  return issues;
}

function outputSchema(input: Schema, config: AiJudgeConfig): Schema {
  if (config.action !== 'flag') return input;
  const added: Column[] = [{ name: config.outputColumn, type: 'string', nullable: false }];
  if (config.reasonColumn !== null) added.push({ name: config.reasonColumn, type: 'string', nullable: true });
  return { columns: [...input.columns, ...added] };
}

const NO_VERDICT: AiJudgeVerdict = { value: AI_JUDGE_UNCLEAR, reason: 'no verdict was returned for this row' };

export const aiJudgeNode: EtlNode<AiJudgeConfig> = {
  type: AI_JUDGE_TYPE,
  kind: 'transform',
  inputArity: 1,
  validateConfig: validate,
  inferSchema(inputs, config): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues = aiJudgeIssues(input, config);
    return issues.length > 0 ? { schema: input, state: 'mismatch', issues } : { schema: outputSchema(input, config), state: 'confirmed', issues: [] };
  },
  execute(inputs, config): Table {
    const input = inputs[0];
    if (input === undefined) throw new ConfigError('ai-judge requires one input');
    const issues = aiJudgeIssues(input.schema, config);
    const missingColumn = issues.find((issue) => issue.message.startsWith('ai-judge: column not found'));
    if (missingColumn !== undefined) throw new SchemaError(missingColumn.message);
    const firstIssue = issues[0];
    if (firstIssue !== undefined) throw new ConfigError(firstIssue.message);
    if (config.resolved === undefined) {
      // 解決器を通さずに実行された（配線漏れ）か、モデルが判定を返す前に実行された。黙って全行 unclear にはしない。
      throw new ConfigError('ai-judge: verdicts are not resolved; the graph must run through the AI judgment resolver before execution');
    }
    const columns = aiJudgeColumns(input.schema, config);
    const verdicts = config.resolved.verdicts;
    const matches = new Set(config.matchValues);
    const rows: Row[] = [];
    for (const row of input.rows) {
      const verdict = verdicts[aiJudgeItemKey(row, columns)] ?? NO_VERDICT;
      if (config.action === 'flag') {
        rows.push(config.reasonColumn === null
          ? { ...row, [config.outputColumn]: verdict.value }
          : { ...row, [config.outputColumn]: verdict.value, [config.reasonColumn]: verdict.reason });
        continue;
      }
      const matched = matches.has(verdict.value);
      if (config.action === 'keep' ? matched : !matched) rows.push(row);
    }
    return { schema: outputSchema(input.schema, config), rows };
  },
};

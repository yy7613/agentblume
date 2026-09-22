/**
 * application層: LLM に 正常 / 境界 / 異常 のツール検証ケース案を作らせる。
 *
 * ## 何をするか
 * 保存済み Tool の公開契約（inputSchema・agentTool・outputSchema）とグラフの要約、そして
 * agent-input ノードの設計時サンプルで 1 度だけ実行した結果（出力列・先頭行・行数）をモデルへ渡し、
 * カテゴリごとに `perCategory` 件のケース（引数 + 期待）を JSON で返させる。
 *
 * ## 何をしないか
 * - **保存しない。** 提案は利用者がレビューして実行・保存する（UI の明示操作）。
 * - **モデルの出力を信用しない。** 未宣言の引数・型違い・不正な期待は落とすか直し、その内容を
 *   `warnings` に残す（不正な 1 件のために提案全体を失敗にしない）。ただし異常系ケースでは
 *   「未宣言の引数を 1 つ渡す」「非 nullable に null を渡す」こと自体が検証の狙いなので、
 *   `outcome: 'error'` が付いている場合に限り未宣言キーを 1 つだけ残す。
 * - サンプル実行は engine.preview（副作用なし）で、失敗しても提案は続ける（warning に残す）。
 *
 * ## 失敗の扱い
 * モデル未設定・structured-output 非対応・JSON でない応答・使えるケースが 0 件は
 * ModelProviderError（api で 502）。Tool が無ければ ToolNotFoundError（404）。
 */
import type { Column, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import {
  TOOL_CHECK_NAME_MAX_LENGTH, validateToolCheckExpectations,
  type JsonCell, type ToolCheckExpectations,
} from '../../domain/tool-check/tool-check-case';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { ResolveAiJudgmentsUseCase } from '../tool/resolve-ai-judgments';
import { ModelProviderError, type JsonSchemaObject, type JsonSchemaProperty, type ModelProviderPort } from '../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../prompt/prompt-catalog-port';
import type { ToolCheckToolRef } from './tool-check-result';

/** 文の置き場所（v48 / ADR-0052）。 */
export const TOOL_CHECK_CASES_PROMPT: PromptSpec = { id: 'tool-check/suggest-cases', sections: ['system'] };

export const TOOL_CHECK_CASE_CATEGORIES = ['normal', 'boundary', 'abnormal'] as const;
export type ToolCheckCaseCategory = (typeof TOOL_CHECK_CASE_CATEGORIES)[number];

export const DEFAULT_SUGGESTIONS_PER_CATEGORY = 2;
export const MIN_SUGGESTIONS_PER_CATEGORY = 1;
export const MAX_SUGGESTIONS_PER_CATEGORY = 5;
/** モデルへ見せるサンプル行数。列と値の雰囲気が分かれば十分で、全行を渡すとプロンプトが膨らむ。 */
const SAMPLE_ROW_LIMIT = 5;

export interface ToolCheckSuggestion {
  readonly category: ToolCheckCaseCategory;
  readonly name: string;
  /** モデルの説明（表示用。信用はしない）。 */
  readonly rationale: string;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations: ToolCheckExpectations;
  /** サーバー側の検証で落とした・直した点。 */
  readonly warnings: readonly string[];
}

export interface SuggestToolCheckCasesInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  /** 省略時は最新版。 */
  readonly version?: SemVer;
  /** カテゴリごとの件数（1〜5、既定 2。範囲外は api が 400 にする。ここでは丸める）。 */
  readonly perCategory?: number;
  /** 重点（自由文）。 */
  readonly focus?: string;
}

export interface ToolCheckSuggestions {
  readonly tool: ToolCheckToolRef;
  readonly suggestions: readonly ToolCheckSuggestion[];
  readonly model?: { readonly provider: string; readonly model: string };
  /** 提案全体への注意（サンプル実行の失敗・件数の切り詰め・カテゴリ不明のケースの除去）。 */
  readonly warnings: readonly string[];
}

/** モデルへ渡す文脈。JSON.stringify してそのまま user メッセージにする。 */
interface SuggestionContext {
  readonly tool: { readonly name: string; readonly description?: string; readonly publishName: string; readonly version: string };
  readonly perCategory: number;
  readonly focus?: string;
  readonly inputSchema: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
  readonly outputSchema?: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
  readonly graph: { readonly nodes: readonly { readonly id: string; readonly type: string; readonly argumentBindings?: readonly ArgumentBinding[] }[] };
  readonly sampleRun?: {
    readonly arguments: Readonly<Record<string, JsonCell>>;
    readonly rowCount: number;
    readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
    readonly rows: readonly Readonly<Record<string, JsonCell>>[];
  };
}

/** filter 条件が Agent 引数に束縛されている箇所（モデルが「どの引数が何を絞るか」を知るため）。 */
interface ArgumentBinding { readonly column: string; readonly op?: string; readonly argument: string; readonly binds: 'value' | 'operator' }

const columnSchema: JsonSchemaProperty = { type: 'object', additionalProperties: false, required: ['column', 'op', 'value', 'mode'], properties: {
  column: { type: 'string' },
  op: { type: 'string', enum: ['eq', 'neq', 'gte', 'lte', 'contains'] },
  value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
  mode: { type: 'string', enum: ['any', 'all'] },
} };

const RESPONSE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['cases'],
  properties: {
    cases: { type: 'array', items: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'name', 'rationale', 'arguments', 'expectations'],
      properties: {
        category: { type: 'string', enum: [...TOOL_CHECK_CASE_CATEGORIES] },
        name: { type: 'string' },
        rationale: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
        expectations: { type: 'object', additionalProperties: false, properties: {
          rowCount: { type: 'object', additionalProperties: false, required: ['op', 'value'], properties: { op: { type: 'string', enum: ['eq', 'gte', 'lte'] }, value: { type: 'number' } } },
          columns: { type: 'array', items: { type: 'string' } },
          cells: { type: 'array', items: columnSchema },
          maxDurationMs: { type: 'number' },
          outcome: { type: 'string', enum: ['success', 'error'] },
        } },
      },
    } },
  },
};

export class SuggestToolCheckCasesUseCase {
  /**
   * `enabled` を関数で受けるのは SuggestAnalysisConfigUseCase と同じ理由（モデルは UI から切り替えられる）。
   * `modelSnapshot` は応答の `model` 表示用で、無ければ省略する（提案の成否には関わらない）。
   */
  constructor(
    private readonly tools: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly model: ModelProviderPort,
    private readonly enabled: () => boolean | Promise<boolean>,
    /** 文の置き場所（v48）。 */
    private readonly prompts: PromptCatalogPort,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
    private readonly modelSnapshot?: () => Promise<{ readonly provider: string; readonly model: string } | undefined>,
    /** サンプル実行の前に AI 判定を解く。失敗してもサンプル実行の warning になるだけで提案は続く。 */
    private readonly resolveAiJudgments?: ResolveAiJudgmentsUseCase,
  ) {}

  async available(): Promise<boolean> {
    return await this.enabled() && this.model.capabilities().includes('structured-output');
  }

  async execute(input: SuggestToolCheckCasesInput): Promise<ToolCheckSuggestions> {
    if (!await this.available()) throw new ModelProviderError('tool check suggestions are not configured');
    const perCategory = clampPerCategory(input.perCategory);
    const tool = await this.loadTool(input.scope, input.toolId, input.version);
    const warnings: string[] = [];

    const sampleRun = await this.sampleRun(input.scope, tool, warnings);
    const context = buildContext(tool, perCategory, input.focus, sampleRun);
    const completion = await this.model.complete({
      temperature: 0,
      messages: [
        { role: 'system', content: this.prompts.get(TOOL_CHECK_CASES_PROMPT.id).render('system') },
        { role: 'user', content: JSON.stringify(context) },
      ],
      responseFormat: { name: 'tool_check_case_suggestions', strict: true, schema: RESPONSE_SCHEMA },
    });

    let parsed: unknown;
    try { parsed = JSON.parse(completion.message.content ?? ''); } catch (error) { throw new ModelProviderError('tool check suggestions returned invalid JSON', error); }
    // 形が違う応答（配列・cases 無し）も「JSON として使えない」扱い。response schema を守れないモデルの問題で、利用者に直せる点は無い。
    const cases = (parsed as { cases?: unknown } | null)?.cases;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(cases)) {
      throw new ModelProviderError('tool check suggestions returned invalid JSON');
    }

    const outputColumns = knownOutputColumns(tool, sampleRun);
    const suggestions = repairCases(cases, tool.inputSchema, outputColumns, perCategory, warnings);
    if (suggestions.length === 0) throw new ModelProviderError('tool check suggestions returned no usable case');

    const model = await this.snapshot();
    return {
      tool: { internalId: tool.metadata.internalId, version: tool.metadata.version.toString(), publishName: tool.metadata.publishName },
      suggestions,
      ...(model === undefined ? {} : { model }),
      warnings,
    };
  }

  private async loadTool(scope: TenantScope, toolId: ToolId, version?: SemVer): Promise<Tool> {
    const tool = version === undefined ? await this.tools.findLatest(scope, toolId) : await this.tools.findVersion(scope, toolId, version);
    if (tool === null) throw new ToolNotFoundError(version === undefined ? `tool not found: ${toolId}` : `tool not found: ${toolId}@${version.toString()}`);
    return tool;
  }

  /**
   * agent-input ノードの設計時サンプルでグラフを 1 度実行し、出力の列・先頭行・全行数を得る
   * （DiagnoseToolUseCase の「execution」検査と同じ経路。engine.preview はサンプル値を自動で使う）。
   * 失敗しても提案は続ける: 期待の根拠が無くなるだけで、引数案は公開契約から作れる。
   */
  private async sampleRun(scope: TenantScope, tool: Tool, warnings: string[]): Promise<SuggestionContext['sampleRun']> {
    try {
      const withSources = this.resolveDataSources === undefined ? tool.graph : await this.resolveDataSources.execute(scope, tool.graph);
      const graph = this.resolveAiJudgments === undefined ? withSources : await this.resolveAiJudgments.execute(withSources);
      const preview = this.engine.preview(graph, { rowLimit: SAMPLE_ROW_LIMIT });
      return {
        arguments: agentInputSample(tool.graph),
        rowCount: preview.fullOutput.rows.length,
        columns: columnsOf(preview.output.schema),
        rows: preview.output.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, cell instanceof Date ? cell.toISOString() : cell]))),
      };
    } catch (error) {
      warnings.push(`sample run failed (${messageOf(error)}); expectations are guessed from the schema only`);
      return undefined;
    }
  }

  private async snapshot(): Promise<{ readonly provider: string; readonly model: string } | undefined> {
    if (this.modelSnapshot === undefined) return undefined;
    try {
      const snapshot = await this.modelSnapshot();
      return snapshot === undefined ? undefined : { provider: snapshot.provider, model: snapshot.model };
    } catch {
      return undefined; // 表示用の情報が取れないだけで提案は返せる。
    }
  }
}

function clampPerCategory(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SUGGESTIONS_PER_CATEGORY;
  return Math.min(MAX_SUGGESTIONS_PER_CATEGORY, Math.max(MIN_SUGGESTIONS_PER_CATEGORY, Math.trunc(value)));
}

function columnsOf(schema: Schema | undefined): { readonly name: string; readonly type: string; readonly nullable: boolean }[] {
  return (schema?.columns ?? []).map((column) => ({ name: column.name, type: column.type, nullable: column.nullable }));
}

function agentInputSample(graph: ToolGraph): Readonly<Record<string, JsonCell>> {
  const node = graph.nodes.find((item) => item.type === 'agent-input');
  const sample = (node?.config as { sample?: unknown } | undefined)?.sample;
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return {};
  return Object.fromEntries(Object.entries(sample as Record<string, unknown>).flatMap(([key, value]) => {
    if (value instanceof Date) return [[key, value.toISOString()]];
    return isJsonCell(value) ? [[key, value]] : [];
  }));
}

/**
 * グラフの要約: ノード id と type、filter の条件が Agent 引数を束縛している箇所だけ。
 * 条件の形は tool-execution.ts と同じ（`valueBinding` / `opBinding` の `source: 'agent-input'`）。
 * ノード config をそのまま渡すと巨大な json-source の rows まで送ってしまうため、ここで絞る。
 */
function summarizeGraph(graph: ToolGraph): SuggestionContext['graph'] {
  return { nodes: graph.nodes.map((node) => {
    const bindings = node.type === 'filter' ? argumentBindings(node.config) : [];
    return { id: node.id, type: node.type, ...(bindings.length === 0 ? {} : { argumentBindings: bindings }) };
  }) };
}

function argumentBindings(config: unknown): ArgumentBinding[] {
  const raw = (config as { conditions?: unknown } | null)?.conditions;
  const conditions = Array.isArray(raw) ? raw : [config];
  const bindings: ArgumentBinding[] = [];
  for (const condition of conditions) {
    const item = condition as { column?: unknown; op?: unknown; valueBinding?: { source?: unknown; field?: unknown }; opBinding?: { source?: unknown; field?: unknown } } | null;
    if (item === null || typeof item !== 'object' || typeof item.column !== 'string') continue;
    const op = typeof item.op === 'string' ? { op: item.op } : {};
    if (item.valueBinding?.source === 'agent-input' && typeof item.valueBinding.field === 'string') bindings.push({ column: item.column, ...op, argument: item.valueBinding.field, binds: 'value' });
    if (item.opBinding?.source === 'agent-input' && typeof item.opBinding.field === 'string') bindings.push({ column: item.column, ...op, argument: item.opBinding.field, binds: 'operator' });
  }
  return bindings;
}

function buildContext(tool: Tool, perCategory: number, focus: string | undefined, sampleRun: SuggestionContext['sampleRun']): SuggestionContext {
  const trimmedFocus = focus?.trim();
  return {
    tool: {
      name: tool.agentTool?.name ?? tool.metadata.publishName,
      ...(tool.agentTool === undefined ? {} : { description: tool.agentTool.description }),
      publishName: tool.metadata.publishName,
      version: tool.metadata.version.toString(),
    },
    perCategory,
    ...(trimmedFocus === undefined || trimmedFocus === '' ? {} : { focus: trimmedFocus }),
    inputSchema: columnsOf(tool.inputSchema),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: columnsOf(tool.outputSchema) }),
    graph: summarizeGraph(tool.graph),
    ...(sampleRun === undefined ? {} : { sampleRun }),
  };
}

/** 出力列の正: 宣言 outputSchema があればそれ、無ければサンプル実行の列。どちらも無ければ undefined（検証しない）。 */
function knownOutputColumns(tool: Tool, sampleRun: SuggestionContext['sampleRun']): ReadonlySet<string> | undefined {
  if (tool.outputSchema !== undefined) return new Set(tool.outputSchema.columns.map((column) => column.name));
  if (sampleRun !== undefined) return new Set(sampleRun.columns.map((column) => column.name));
  return undefined;
}

// ---------------------------------------------------------------------------
// モデル出力の検証と修復
// ---------------------------------------------------------------------------

interface RawCase { readonly category?: unknown; readonly name?: unknown; readonly rationale?: unknown; readonly arguments?: unknown; readonly expectations?: unknown }

function isCategory(value: unknown): value is ToolCheckCaseCategory {
  return typeof value === 'string' && (TOOL_CHECK_CASE_CATEGORIES as readonly string[]).includes(value);
}

function isJsonCell(value: unknown): value is JsonCell {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * ケースを検証・修復してカテゴリ順（normal → boundary → abnormal）に並べる。
 * 落とした理由はケース単位の `warnings`（引数・期待）か提案全体の `warnings`（カテゴリ不明・切り詰め）へ。
 */
function repairCases(cases: readonly unknown[], inputSchema: Schema | undefined, outputColumns: ReadonlySet<string> | undefined, perCategory: number, warnings: string[]): ToolCheckSuggestion[] {
  const byCategory = new Map<ToolCheckCaseCategory, ToolCheckSuggestion[]>(TOOL_CHECK_CASE_CATEGORIES.map((category) => [category, []]));
  const overflow = new Map<ToolCheckCaseCategory, number>();
  for (const raw of cases) {
    const item = (raw === null || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw) as RawCase;
    if (!isCategory(item.category)) {
      warnings.push(`dropped a case with unknown category '${String(item.category)}'`);
      continue;
    }
    const bucket = byCategory.get(item.category)!;
    if (bucket.length >= perCategory) {
      overflow.set(item.category, (overflow.get(item.category) ?? 0) + 1);
      continue;
    }
    bucket.push(repairCase(item, item.category, bucket.length + 1, inputSchema, outputColumns));
  }
  for (const [category, dropped] of overflow) {
    warnings.push(`model returned ${perCategory + dropped} ${category} cases; kept the first ${perCategory}`);
  }
  return TOOL_CHECK_CASE_CATEGORIES.flatMap((category) => byCategory.get(category) ?? []);
}

function repairCase(item: RawCase, category: ToolCheckCaseCategory, ordinal: number, inputSchema: Schema | undefined, outputColumns: ReadonlySet<string> | undefined): ToolCheckSuggestion {
  const caseWarnings: string[] = [];
  const name = repairName(item.name, category, ordinal, caseWarnings);
  const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
  // 期待を先に確定する: 異常系で未宣言引数を残せるかは outcome: 'error' の有無で決まる。
  const expectations = repairExpectations(item.expectations, outputColumns, caseWarnings);
  const args = repairArguments(item.arguments, category, expectations.outcome === 'error', inputSchema, caseWarnings);
  return { category, name, rationale, arguments: args, expectations, warnings: caseWarnings };
}

function repairName(value: unknown, category: ToolCheckCaseCategory, ordinal: number, warnings: string[]): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > 0 && trimmed.length <= TOOL_CHECK_NAME_MAX_LENGTH) return trimmed;
  const fallback = `${category} case ${ordinal}`;
  warnings.push(trimmed.length === 0 ? `name was missing; replaced with '${fallback}'` : `name exceeded ${TOOL_CHECK_NAME_MAX_LENGTH} characters; replaced with '${fallback}'`);
  return fallback;
}

/**
 * 期待はキーごとにドメインの検証（validateToolCheckExpectations）へ通し、不正なものだけ落とす。
 * 出力列が分かっているときは cells の列が出力に無ければ落とす（実行しても必ず不合格になる期待は提案の価値が無い）。
 */
function repairExpectations(value: unknown, outputColumns: ReadonlySet<string> | undefined, warnings: string[]): ToolCheckExpectations {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) warnings.push('expectations were not an object; removed');
    return {};
  }
  const result: { -readonly [K in keyof ToolCheckExpectations]: ToolCheckExpectations[K] } = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || entry === null) continue;
    let validated: ToolCheckExpectations;
    try {
      validated = validateToolCheckExpectations({ [key]: entry });
    } catch (error) {
      warnings.push(`expectation '${key}' was invalid (${messageOf(error).replace(/^createToolCheckCase: expectations\./u, '')}); removed`);
      continue;
    }
    switch (key) {
      case 'rowCount': result.rowCount = validated.rowCount; break;
      case 'columns': result.columns = validated.columns; break;
      case 'maxDurationMs': result.maxDurationMs = validated.maxDurationMs; break;
      case 'outcome': result.outcome = validated.outcome; break;
      case 'cells': {
        const cells = validated.cells ?? [];
        const kept = outputColumns === undefined ? cells : cells.filter((cell) => {
          if (outputColumns.has(cell.column)) return true;
          warnings.push(`cell expectation on '${cell.column}' removed: not an output column`);
          return false;
        });
        if (kept.length > 0) result.cells = kept;
        break;
      }
      default: warnings.push(`unknown expectation '${key}' removed`);
    }
  }
  return result;
}

/**
 * 引数の検証と修復。
 * - 未宣言のキー: 異常系で `outcome: 'error'` のときだけ 1 つ残す（それが検証の狙い）。他は落とす。
 * - 宣言済みのキー: 型が違えば曖昧でない範囲で寄せる（"12" → 12、"true" → true、12 → "12"）。
 *   寄せられない型違いは正常・境界では warning つきで残し（利用者が直せる）、異常系ではそのまま残す。
 * - null: nullable でない列への null は正常・境界では落とす。異常系では残す（拒否されることを見るケース）。
 * - inputSchema が無い Tool: 宣言済みキーが存在しないので、上の「未宣言」規則だけが働く。
 */
function repairArguments(value: unknown, category: ToolCheckCaseCategory, expectsError: boolean, inputSchema: Schema | undefined, warnings: string[]): Readonly<Record<string, JsonCell>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) warnings.push('arguments were not an object; removed');
    return {};
  }
  const columns = new Map<string, Column>((inputSchema?.columns ?? []).map((column) => [column.name, column]));
  const result: Record<string, JsonCell> = {};
  let undeclaredKept = false;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim().length === 0) continue;
    const column = columns.get(key);
    if (column === undefined) {
      if (category === 'abnormal' && expectsError && !undeclaredKept && isJsonCell(raw)) {
        undeclaredKept = true;
        result[key] = raw;
        continue;
      }
      warnings.push(category === 'abnormal' && expectsError && undeclaredKept
        ? `only one undeclared argument is kept per case; removed '${key}'`
        : `argument '${key}' is not declared in the tool's input schema; removed`);
      continue;
    }
    if (raw === null) {
      if (column.nullable || category === 'abnormal') { result[key] = null; continue; }
      warnings.push(`argument '${key}' is null but the column is not nullable; removed`);
      continue;
    }
    const coerced = coerce(raw, column);
    if (coerced === undefined) {
      warnings.push(`argument '${key}' could not be converted to a JSON value; removed`);
      continue;
    }
    // 異常系で「失敗すること」を期待するケースは、型違いそのものが検証の狙い。寄せられる型違い（"80" → 80）を
    // 寄せてしまうとケースが成功して期待と食い違うので、元の値のまま残す（寄せられない型違いは従来どおり黙って残る）。
    if (category === 'abnormal' && expectsError && coerced.converted && isJsonCell(raw)) {
      warnings.push(`argument '${key}' is ${describe(raw)} but the column is ${column.type}; kept as-is because the case expects an error`);
      result[key] = raw;
      continue;
    }
    if (coerced.converted) warnings.push(`argument '${key}' was ${describe(raw)}; converted to ${column.type} ${JSON.stringify(coerced.value)}`);
    else if (coerced.mismatch && category !== 'abnormal') warnings.push(`argument '${key}' is ${describe(raw)} but the column is ${column.type}`);
    result[key] = coerced.value;
  }
  return result;
}

interface Coercion { readonly value: JsonCell; readonly converted: boolean; readonly mismatch: boolean }

/** 列の型へ曖昧でない範囲で寄せる。寄せられなければ元の値を mismatch 付きで返す。JSON セルでない値は undefined。 */
function coerce(raw: unknown, column: Column): Coercion | undefined {
  if (raw instanceof Date) return { value: raw.toISOString(), converted: true, mismatch: false };
  if (!isJsonCell(raw) || raw === null) return undefined;
  switch (column.type) {
    case 'number': {
      if (typeof raw === 'number') return { value: raw, converted: false, mismatch: false };
      if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/u.test(raw.trim()) && Number.isFinite(Number(raw))) return { value: Number(raw), converted: true, mismatch: false };
      return { value: raw, converted: false, mismatch: true };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw, converted: false, mismatch: false };
      if (raw === 'true' || raw === 'false') return { value: raw === 'true', converted: true, mismatch: false };
      return { value: raw, converted: false, mismatch: true };
    }
    case 'string':
    case 'date': {
      if (typeof raw === 'string') return { value: raw, converted: false, mismatch: false };
      // 数値・真偽値を文字列列へ渡すのは表現の違いだけで意図は明確（"12" と 12）。date 列は ISO 文字列が期待なので寄せない。
      if (column.type === 'string') return { value: String(raw), converted: true, mismatch: false };
      return { value: raw, converted: false, mismatch: true };
    }
    default: return { value: raw, converted: false, mismatch: false };
  }
}

function describe(value: unknown): string {
  return `${JSON.stringify(value)} (${typeof value})`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

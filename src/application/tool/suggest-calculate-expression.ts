/**
 * 応用: 関数電卓ノードの式を LLM に提案させる（v41 実装契約 §3 / ADR-0046）。
 *
 * モデルの応答をそのまま渡さず、domain の診断（`validateExpression` / `previewExpression`）で
 * 検分してから返す。誤りは種別と候補で **1 回だけ** 差し戻し、それでも通らなければ理由を文言に
 * 含めて失敗する（往復を重ねるより、人が指示を直す方が速い）。
 * 適用・保存はしない。返すのは提案だけで、ノードへ入れるのは UI の明示操作。
 */
import type { EtlEngine } from '../etl/engine';
import { ModelProviderError, type ModelCompletionRequest, type ModelProviderPort } from '../model/model-provider';
import type { Row, Schema } from '../../domain/data/types';
import { findColumn } from '../../domain/data/schema';
import { GraphError } from '../../domain/etl/errors';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import type { NodeId } from '../../domain/etl/ids';
import { CALCULATE_TYPE } from '../../domain/etl/nodes/calculate';
import {
  previewExpression,
  validateExpression,
  type ExpressionDiagnostic,
  type ExpressionPreview,
} from '../../domain/etl/nodes/calculate-diagnostics';
import {
  CALCULATE_PROMPT_SAMPLE_ROWS,
  CALCULATE_PROMPT_TEMPLATE_VERSION,
  buildCalculateExpressionRepairRequest,
  buildCalculateExpressionRequest,
  type CalculateExpressionRepairFeedback,
} from './calculate-expression-prompt';

/** 検分のために上流から取る行数。プロンプトへ載せるのはこのうち先頭 CALCULATE_PROMPT_SAMPLE_ROWS 件。 */
const INSPECTION_ROW_LIMIT = 100;
/** 提案に添える入出力の見本の数。 */
const PROPOSAL_SAMPLE_ROWS = 5;
/** 出力列名が決まらないときの既定。 */
const DEFAULT_OUTPUT_COLUMN = 'result';

/** 提案 1 件。適用すると `config` がそのまま node.config になる。 */
export interface CalculateExpressionProposal {
  readonly nodeId: NodeId;
  readonly nodeType: 'calculate';
  /** `onError` / `precision` は現在値を保つ（ADR-0046 決定 5: 失敗時の扱いと丸めは運用判断）。 */
  readonly config: {
    readonly outputColumn: string;
    readonly expression: string;
    readonly onError?: 'null' | 'fail';
    readonly precision?: number;
  };
  readonly rationale: readonly string[];
  /** モデルの warnings に、検分で分かったこと（部分失敗・列の上書きなど）を足したもの。 */
  readonly warnings: readonly string[];
  /** 最終案の判定。`ok` なものだけを返すので、残る診断は warning だけ。 */
  readonly validation: { readonly references: readonly string[]; readonly diagnostics: readonly ExpressionDiagnostic[] };
  readonly preview: {
    readonly rows: number;
    readonly evaluated: number;
    readonly failed: number;
    readonly failureCounts: Readonly<Record<string, number>>;
    readonly sample: readonly { readonly input: Row; readonly output: unknown }[];
  };
  /** 修復回を使ったか（UI が「1 回直しました」と示す）。 */
  readonly repaired: boolean;
  readonly promptTemplateVersion: string;
}

/** 上流から取れた材料。行が取れなかったときは理由を warning として持ち上げる。 */
interface Upstream {
  readonly schema: Schema;
  readonly rows: readonly Row[];
  readonly warning?: string;
}

/** モデルの応答のうち、こちらが読む部分。 */
interface ParsedProposal {
  readonly expression: string;
  readonly outputColumn: unknown;
  readonly rationale: readonly string[];
  readonly warnings: readonly string[];
}

/** 検分の結果。`feedback` が入っていれば差し戻す。 */
interface Inspection {
  readonly diagnostics: readonly ExpressionDiagnostic[];
  readonly references: readonly string[];
  readonly preview?: ExpressionPreview;
  readonly feedback?: CalculateExpressionRepairFeedback;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 上流だけを終端にした部分グラフ（上流の祖先すべてと、その間の辺）。
 *
 * 対象ノードを含めたまま preview すると、式が空の新規ノードで実行が落ちて標本行が取れない。
 * 祖先の閉包を取るのは、途中のノードの入次数（arity）を崩さないため。
 */
function upstreamOnlyGraph(graph: ToolGraph, upstreamId: NodeId): ToolGraph {
  const keep = new Set<string>([upstreamId]);
  const queue: string[] = [upstreamId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.to === current && !keep.has(edge.from)) {
        keep.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

/** 診断を差し戻しの形へ写す（文言ではなく種別と候補を渡す）。 */
function feedbackDiagnostics(diagnostics: readonly ExpressionDiagnostic[]): CalculateExpressionRepairFeedback['diagnostics'] {
  return diagnostics.map((item) => ({
    code: item.code,
    category: item.category,
    message: item.message,
    ...(item.position === undefined ? {} : { position: item.position }),
    ...(item.column === undefined ? {} : { column: item.column }),
    ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
  }));
}

/** 失敗時の文言の「原因」部分。候補があれば直し方まで書く。 */
function diagnosticSummary(diagnostics: readonly ExpressionDiagnostic[]): string {
  return diagnostics
    .map((item) => (item.suggestion === undefined ? item.message : `${item.message} → 候補: ${item.suggestion}`))
    .join('; ');
}

function failureCountsOf(preview: ExpressionPreview | undefined): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [reason, count] of Object.entries(preview?.failureCounts ?? {})) {
    if (typeof count === 'number' && count > 0) counts[reason] = count;
  }
  return counts;
}

export class SuggestCalculateExpressionUseCase {
  /**
   * `enabled` を関数で受ける理由は `SuggestAnalysisConfigUseCase` と同じ。
   * モデルは UI から切り替えられるので、起動時の env で固定すると設定とズレる。
   */
  constructor(
    private readonly engine: EtlEngine,
    private readonly model: ModelProviderPort,
    private readonly enabled: () => boolean | Promise<boolean>,
  ) {}

  async available(): Promise<boolean> {
    return (await this.enabled()) && this.model.capabilities().includes('structured-output');
  }

  async execute(
    input: { readonly graph: ToolGraph; readonly nodeId: NodeId; readonly intent: string },
    signal?: AbortSignal,
  ): Promise<CalculateExpressionProposal> {
    if (!(await this.available())) throw new ModelProviderError('calculate assistant is not configured');
    if (input.intent.trim() === '') throw new ModelProviderError('calculate assistant requires an intent');
    const node = input.graph.nodes.find((item) => item.id === input.nodeId);
    if (node === undefined || node.type !== CALCULATE_TYPE) {
      throw new ModelProviderError('calculate assistant supports calculate nodes only');
    }

    const current = (node.config === null || typeof node.config !== 'object' ? {} : node.config) as Readonly<Record<string, unknown>>;
    const upstream = this.gatherUpstream(input.graph, node.id);
    const warnings: string[] = [];
    if (upstream.warning !== undefined) warnings.push(upstream.warning);

    const request = buildCalculateExpressionRequest({
      intent: input.intent,
      node: { id: node.id, currentConfig: current },
      upstreamSchema: upstream.schema,
      sampleRows: upstream.rows.slice(0, CALCULATE_PROMPT_SAMPLE_ROWS),
    });

    let repaired = false;
    let content = await this.ask(request, signal);
    let proposed = parseProposal(content);
    rejectDecline(proposed);
    let inspection = inspect(proposed.expression, upstream);

    if (inspection.feedback !== undefined) {
      // 差し戻しは 1 回だけ（ADR-0046 決定 2）。
      repaired = true;
      const repair = buildCalculateExpressionRepairRequest(request, content, inspection.feedback);
      content = await this.ask(repair, signal);
      proposed = parseProposal(content);
      rejectDecline(proposed);
      inspection = inspect(proposed.expression, upstream);
      if (inspection.feedback !== undefined) {
        throw new ModelProviderError(
          `calculate assistant could not produce a valid expression after one repair: ${proposed.expression} — ${failureDetail(inspection)}`,
        );
      }
    }

    const outputColumn = resolveOutputColumn(proposed.outputColumn, current);
    const onError = onErrorOf(current['onError']);
    const precision = current['precision'];
    const config: CalculateExpressionProposal['config'] = {
      ...(onError === undefined ? {} : { onError }),
      ...(typeof precision === 'number' ? { precision } : {}),
      outputColumn,
      expression: proposed.expression,
    };

    // 入力の graph は変異させない（提案は「見せるだけ」で、適用は UI の明示操作）。
    const applied: ToolGraph = {
      nodes: input.graph.nodes.map((item) => (item.id === node.id ? ({ ...item, config } as GraphNode) : item)),
      edges: input.graph.edges,
    };
    try {
      if (this.engine.propagateSchemas(applied).hasErrors) {
        throw new ModelProviderError('calculate assistant proposal failed schema validation');
      }
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      // まだ繋がっていないグラフ（置いたばかりのノード・未接続の上流）は、それ自体では伝播できない。
      // 式そのものは上流スキーマに対する判定で見ているので、組み立ての途中を理由に提案を捨てない。
      if (!(error instanceof GraphError)) {
        throw new ModelProviderError('calculate assistant proposal failed schema validation', error);
      }
    }

    warnings.push(...proposed.warnings, ...inspectionWarnings(inspection, upstream.schema, outputColumn));

    return {
      nodeId: node.id,
      nodeType: 'calculate',
      config,
      rationale: proposed.rationale,
      warnings,
      validation: { references: inspection.references, diagnostics: inspection.diagnostics },
      preview: {
        rows: inspection.preview?.rows.length ?? 0,
        evaluated: inspection.preview?.evaluated ?? 0,
        failed: inspection.preview?.failed ?? 0,
        failureCounts: failureCountsOf(inspection.preview),
        sample: (inspection.preview?.rows ?? []).slice(0, PROPOSAL_SAMPLE_ROWS).map((row) => ({
          input: upstream.rows[row.index] ?? {},
          output: row.value,
        })),
      },
      repaired,
      promptTemplateVersion: CALCULATE_PROMPT_TEMPLATE_VERSION,
    };
  }

  /**
   * 上流のスキーマと標本行。
   *
   * 対象ノードを外した（上流を終端にした）グラフで preview するのが本命の経路。
   * 新しく置いたばかりの電卓ノードは式が空で、対象ノードを含めたまま実行すると落ちるため。
   * それでも取れなければ（上流の設定不備など）スキーマだけで提案を続け、検分を省いたことを伝える。
   */
  private gatherUpstream(graph: ToolGraph, nodeId: NodeId): Upstream {
    const upstreamId = graph.edges.find((edge) => edge.to === nodeId)?.from;
    if (upstreamId === undefined) return { schema: { columns: [] }, rows: [] };

    try {
      const result = this.engine.preview(upstreamOnlyGraph(graph, upstreamId), { rowLimit: INSPECTION_ROW_LIMIT });
      const table = result.nodes[upstreamId]?.table;
      if (table !== undefined) return { schema: table.schema, rows: table.rows };
    } catch {
      // 標本行が取れないのは提案を止める理由にならない（列の名前と型だけでも式は組める）。
    }

    let schema: Schema = { columns: [] };
    try {
      schema = this.engine.propagateSchemas(graph).nodes[upstreamId]?.schema ?? { columns: [] };
    } catch {
      // 壊れたグラフでも列 0 個で提案を組む（上流未接続と同じ扱い）。
    }
    return { schema, rows: [], warning: '上流の標本行を取得できなかったため、プレビューによる検分は省きました。' };
  }

  /** モデルへの 1 往復。中断はそのまま通し、それ以外の失敗は ModelProviderError に包む。 */
  private async ask(request: ModelCompletionRequest, signal?: AbortSignal): Promise<string> {
    try {
      const completion = await this.model.complete(request, signal);
      return completion.message.content ?? '';
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof ModelProviderError) throw error;
      const detail = error instanceof Error ? error.message : 'model request failed';
      throw new ModelProviderError(`calculate assistant could not reach the model: ${detail}`, error);
    }
  }
}

/**
 * 空の式はモデルの**辞退**（この電卓では表せない、の意思表示）。文法エラーとして差し戻すと
 * 無駄な 1 往復のあとに「式を入力してください」だけが残り、モデルが warnings に書いた理由
 * （「文字数を数える関数が無い」など）が利用者に届かない。LM Studio 実機（gemma 4 12B）で
 * 「商品名の文字数を数えたい」に対して実際にこの形の応答が返った。
 */
function rejectDecline(proposed: ParsedProposal): void {
  if (proposed.expression.trim() !== '') return;
  const reasons = proposed.warnings.length > 0 ? proposed.warnings : proposed.rationale;
  const reason = reasons.length > 0 ? reasons.join('; ') : 'the model gave no reason';
  throw new ModelProviderError(
    `calculate assistant declined: the instruction cannot be expressed as a calculator formula — ${reason}。次にやること: 数値列の四則演算と関数で表せる計算に指示を言い換えるか、別のノードで前処理してください。`,
  );
}

function parseProposal(content: string): ParsedProposal {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ModelProviderError('calculate assistant returned invalid JSON', error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelProviderError('calculate assistant returned an invalid proposal');
  }
  const proposed = value as { expression?: unknown; outputColumn?: unknown; rationale?: unknown; warnings?: unknown };
  if (typeof proposed.expression !== 'string') {
    throw new ModelProviderError('calculate assistant returned an invalid proposal');
  }
  return {
    expression: proposed.expression,
    outputColumn: proposed.outputColumn,
    rationale: strings(proposed.rationale),
    warnings: strings(proposed.warnings),
  };
}

/**
 * 提案を domain の診断で検分する。
 *
 * 判定に落ちたとき、標本行で全行失敗したとき、実データで数値にならない列を使ったときは差し戻す。
 * 一部の行が失敗するだけなら差し戻さない（データ欠損は式の誤りではない。ADR-0046 決定 2-5）。
 */
function inspect(expression: string, upstream: Upstream): Inspection {
  const validation = validateExpression(expression, upstream.schema);
  if (!validation.ok) {
    return {
      diagnostics: validation.diagnostics,
      references: validation.references,
      feedback: { expression, diagnostics: feedbackDiagnostics(validation.diagnostics) },
    };
  }
  if (upstream.rows.length === 0) {
    return { diagnostics: validation.diagnostics, references: validation.references };
  }

  const preview = previewExpression(expression, upstream.schema, upstream.rows, { limit: INSPECTION_ROW_LIMIT });
  const diagnosis = preview.diagnosis;
  const rejected = diagnosis.allFailed || diagnosis.notNumericColumns.length > 0;
  return {
    diagnostics: validation.diagnostics,
    references: validation.references,
    preview,
    ...(rejected
      ? {
          feedback: {
            expression,
            diagnostics: feedbackDiagnostics(validation.diagnostics),
            preview: {
              allFailed: diagnosis.allFailed,
              ...(diagnosis.dominantReason === undefined ? {} : { dominantReason: diagnosis.dominantReason }),
              notNumericColumns: diagnosis.notNumericColumns,
              allNullColumns: diagnosis.allNullColumns,
              ...(diagnosis.nextStep === undefined ? {} : { nextStep: diagnosis.nextStep }),
            },
          },
        }
      : {}),
  };
}

/** 失敗の文言の中身。原因（診断）に、分かっていれば次の一手を続ける。 */
function failureDetail(inspection: Inspection): string {
  const cause = diagnosticSummary(inspection.diagnostics);
  const nextStep = inspection.preview?.diagnosis.nextStep;
  if (cause === '') return nextStep ?? '式が標本行で 1 行も計算できませんでした。指示に使う列名と丸めを具体的に書いてください。';
  return nextStep === undefined ? cause : `${cause}; ${nextStep}`;
}

/** 検分から利用者へ伝えること（拒みはしないが、適用前に知っておくべきこと）。 */
function inspectionWarnings(inspection: Inspection, schema: Schema, outputColumn: string): readonly string[] {
  const warnings: string[] = [];
  const preview = inspection.preview;
  if (preview !== undefined && preview.failed > 0) {
    const breakdown = Object.entries(failureCountsOf(preview))
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ');
    warnings.push(`${preview.failed}/${preview.rows.length} 行が計算できません（内訳: ${breakdown}）`);
  }
  const allNull = preview?.diagnosis.allNullColumns ?? [];
  if (allNull.length > 0) warnings.push(`列 ${allNull.join(' / ')} は見た行がすべて空です。`);
  // 数値列があるのに列を 1 つも使わない式は、指示を表せずに定数で埋めた疑いがある
  // （LM Studio 実機の gpt-oss-20b は「文字数を数えたい」に `0` を返した）。定数列を足す指示も
  // あり得るので拒まず、適用前に気づけるよう知らせる。
  const numericColumns = (schema.columns ?? []).filter((column) => column.type === 'number');
  if (inspection.references.length === 0 && numericColumns.length > 0) {
    warnings.push('式が入力列を 1 つも参照していません（定数だけ）。指示を式で表せなかった可能性があるので、適用前に結果を確かめてください。');
  }
  // 同名列は置き換えられる（ノードの仕様）。消える列があることは適用前に知らせる。
  if (findColumn(schema, outputColumn) !== undefined) {
    warnings.push(`出力列 ${outputColumn} は上流にもあります。適用するとその列は計算結果で置き換わります。`);
  }
  return warnings;
}

/** 現在の `onError`。読めない値は「指定なし」（ノードの既定 'null' に任せる）。 */
function onErrorOf(value: unknown): 'null' | 'fail' | undefined {
  if (value === 'null') return 'null';
  if (value === 'fail') return 'fail';
  return undefined;
}

/** 出力列名。応答が空 / 非文字列なら現在値、現在値も空なら既定。 */
function resolveOutputColumn(proposed: unknown, current: Readonly<Record<string, unknown>>): string {
  if (typeof proposed === 'string' && proposed.trim() !== '') return proposed;
  const existing = current['outputColumn'];
  if (typeof existing === 'string' && existing.trim() !== '') return existing;
  return DEFAULT_OUTPUT_COLUMN;
}

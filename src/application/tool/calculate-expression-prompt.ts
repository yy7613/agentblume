/**
 * 応用: 関数電卓ノードの式を提案させるプロンプト（v41 実装契約 §2 / ADR-0046 決定 3・4）。
 *
 * モデルは呼ばない純関数だけを置く。文面を単体で固定できるようにするためで、
 * 呼び出し（検分と修復 1 回）は `suggest-calculate-expression.ts` が持つ。
 * 関数の説明は domain の正典（`CALCULATE_FUNCTIONS`）から機械的に組む。ここに手書きの一覧を
 * 置くと、関数を足したときにプロンプトだけが古いまま残る。
 */
import type { Row, Schema } from '../../domain/data/types';
import { CALCULATE_CONSTANTS, CALCULATE_FUNCTIONS } from '../../domain/etl/nodes/calculate-expression';
import { ModelProviderError, type ModelCompletionRequest, type ModelRequestMessage, type JsonSchemaObject } from '../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../prompt/prompt-catalog-port';

/**
 * 文の置き場所（v48 / ADR-0052）。版（`calculate-expression/v2`）はファイルの frontmatter が正で、
 * ここに定数は持たない。差し戻しは条件で行が増えるので、入る・入らないの単位で節を分けてある。
 */
export const CALCULATE_PROMPT: PromptSpec = {
  id: 'tool/calculate-expression',
  sections: ['system', 'repair.intro', 'repair.suggestions', 'repair.not-numeric', 'repair.outro'],
};

/** プロンプトに載せる標本行の数。列の型と桁を読み取れれば足り、これ以上は文脈を食うだけ。 */
export const CALCULATE_PROMPT_SAMPLE_ROWS = 5;

export interface CalculateExpressionPromptInput {
  readonly intent: string;
  readonly node: { readonly id: string; readonly currentConfig: Readonly<Record<string, unknown>> };
  readonly upstreamSchema: Schema;
  /** 呼び手が既に CALCULATE_PROMPT_SAMPLE_ROWS 件以下へ切る。超えていればここでも切る。 */
  readonly sampleRows: readonly Row[];
}

/** 差し戻しの材料。文言ではなく種別と候補を渡す（v40 の設計理由: 文言は改訂で変わるが種別は変わらない）。 */
export interface CalculateExpressionRepairFeedback {
  /** 直前に提案された式。 */
  readonly expression: string;
  readonly diagnostics: readonly {
    code: string;
    category: string;
    message: string;
    position?: number;
    column?: string;
    suggestion?: string;
  }[];
  readonly preview?: {
    readonly allFailed: boolean;
    readonly dominantReason?: string;
    readonly notNumericColumns: readonly string[];
    readonly allNullColumns: readonly string[];
    readonly nextStep?: string;
  };
}

const RESPONSE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['expression', 'outputColumn', 'rationale', 'warnings'],
  properties: {
    expression: { type: 'string' },
    outputColumn: { type: 'string' },
    rationale: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

/** 関数一覧の行。正典の並び順のまま `signature — description` で出す。 */
function functionCatalog(): string {
  return CALCULATE_FUNCTIONS.map((fn) => `- ${fn.signature} — ${fn.description}`).join('\n');
}

/**
 * system の本文。語彙（定数名・関数一覧）は domain の正典から組んで差し込む
 * （ファイルに写しを置くと、関数を足したときにプロンプトだけが古いまま残る）。
 */
export function calculateExpressionSystemPrompt(prompts: PromptCatalogPort): string {
  return prompts.get(CALCULATE_PROMPT.id).render('system', {
    constants: Object.keys(CALCULATE_CONSTANTS).join(', '),
    functions: functionCatalog(),
  });
}

/** 標本行を上限まで切る。壊れた入力（配列でない）でも落ちない。 */
function limitRows(rows: readonly Row[]): readonly Row[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, CALCULATE_PROMPT_SAMPLE_ROWS);
}

/** 列の写し。判定に使う 3 つだけを渡す（余計な内部表現をモデルに見せない）。 */
function schemaForPrompt(schema: Schema): { readonly columns: readonly { name: string; type: string; nullable: boolean }[] } {
  const columns = Array.isArray(schema?.columns) ? schema.columns : [];
  return { columns: columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })) };
}

/**
 * user メッセージ。信頼しない部分（列名と標本値）だけを `<untrusted-data>` で囲む。
 * JSON 全体を囲むと `intent`（利用者自身の指示）まで「指示ではない」ことになってしまう。
 */
function userContent(prompts: PromptCatalogPort, input: CalculateExpressionPromptInput): string {
  const instruction = JSON.stringify({
    promptTemplateVersion: prompts.get(CALCULATE_PROMPT.id).version,
    intent: input.intent,
    node: { id: input.node.id, currentConfig: input.node.currentConfig },
  });
  const data = JSON.stringify({
    upstreamSchema: schemaForPrompt(input.upstreamSchema),
    sampleRows: limitRows(input.sampleRows),
  });
  return `${instruction}\n<untrusted-data>\n${data}\n</untrusted-data>`;
}

/** 初回の要求。temperature 0、strict な JSON スキーマ。 */
export function buildCalculateExpressionRequest(prompts: PromptCatalogPort, input: CalculateExpressionPromptInput): ModelCompletionRequest {
  // 呼び手（ユースケース）でも弾くが、プロンプトだけを組む経路から空の指示が入るのを二重に止める。
  if (typeof input.intent !== 'string' || input.intent.trim() === '') {
    throw new ModelProviderError('calculate assistant requires an intent');
  }
  const messages: readonly ModelRequestMessage[] = [
    { role: 'system', content: calculateExpressionSystemPrompt(prompts) },
    { role: 'user', content: userContent(prompts, input) },
  ];
  return {
    messages,
    temperature: 0,
    responseFormat: { name: 'calculate_expression_proposal', strict: true, schema: RESPONSE_SCHEMA },
  };
}

/** 差し戻しの本文。種別と候補をそのまま JSON で渡し、取るべき行動だけを言葉で添える。 */
function repairContent(prompts: PromptCatalogPort, feedback: CalculateExpressionRepairFeedback): string {
  const template = prompts.get(CALCULATE_PROMPT.id);
  const lines = [
    template.render('repair.intro'),
    JSON.stringify(feedback),
  ];
  const suggested = feedback.diagnostics.filter((item) => typeof item.suggestion === 'string' && item.suggestion !== '');
  if (suggested.length > 0) {
    lines.push(template.render('repair.suggestions', {
      names: suggested.map((item) => `${item.column ?? item.code} -> ${item.suggestion as string}`).join(', '),
    }));
  }
  const notNumeric = feedback.preview?.notNumericColumns ?? [];
  if (notNumeric.length > 0) {
    lines.push(template.render('repair.not-numeric', { columns: notNumeric.join(', ') }));
  }
  lines.push(template.render('repair.outro'));
  return lines.join('\n');
}

/** 修復回の要求。初回の messages を先頭に保ち、assistant 応答と差し戻しの user メッセージを足す。 */
export function buildCalculateExpressionRepairRequest(
  prompts: PromptCatalogPort,
  first: ModelCompletionRequest,
  assistantContent: string,
  feedback: CalculateExpressionRepairFeedback,
): ModelCompletionRequest {
  return {
    ...first,
    messages: [
      ...first.messages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: repairContent(prompts, feedback) },
    ],
  };
}

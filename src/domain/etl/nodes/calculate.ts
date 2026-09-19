/**
 * ドメイン: 関数電卓ノード `calculate`（v39 実装契約 §2.2 / ADR-0045）
 *
 * kind: transform / arity: 1。
 * 入力の各行について数式を 1 回評価し、結果を 1 列として足す（同名列はその位置で置き換える）。
 * 計算は決定的でなければならないため、LLM にも `eval` にも渡さず自作の解釈器で読む。
 */
import { z } from 'zod';
import type { Column, Row, Schema, Table } from '../../data/types';
import { columnNames } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';
import {
  MAX_ROUND_DIGITS,
  evaluateExpressionDetailed,
  parseExpression,
  type CalculateFailureReason,
} from './calculate-expression';
import {
  applyPrecision,
  rowLookup,
  validateExpression,
  type ExpressionDiagnostic,
} from './calculate-diagnostics';

/** ノードの type キー。 */
export const CALCULATE_TYPE = 'calculate';

/** `calculate` の設定。 */
export interface CalculateConfig {
  /** 結果を入れる列名（1 文字以上）。 */
  readonly outputColumn: string;
  /** 数式。空文字は設定途中なので ConfigError にせず inferSchema の error にする。 */
  readonly expression: string;
  /** 評価できない行の扱い。既定は 'null'。 */
  readonly onError?: 'null' | 'fail';
  /** 小数第 n 位で四捨五入する。省略すると丸めない。 */
  readonly precision?: number;
}

const configSchema = z.object({
  outputColumn: z.string().min(1),
  // 長さの上限は parse 側の issue にする（打っている途中で ConfigError にしない）。
  expression: z.string(),
  onError: z.enum(['null', 'fail']).optional(),
  precision: z.number().int().min(0).max(MAX_ROUND_DIGITS).optional(),
});

/**
 * 出力スキーマ。同名列があればその位置で置き換える（列の並びは利用者が組んだ順のまま保つ）。
 * 評価できない行は null になるため、出力は常に nullable。
 */
function withOutputColumn(input: Schema, outputColumn: string): Schema {
  const column: Column = { name: outputColumn, type: 'number', nullable: true };
  const index = input.columns.findIndex((c) => c.name === outputColumn);
  if (index === -1) return { columns: [...input.columns, column] };
  return { columns: input.columns.map((c, i) => (i === index ? column : c)) };
}

/**
 * 停止したときに出す理由と次の一手。
 *
 * 値はどれも null になるが直す先が違うので、原因を言い当てたうえで何をすればよいかまで書く
 * （「評価できません」だけでは、式・データ・上流のどれを見ればよいか分からない）。
 */
function failureReason(reason: CalculateFailureReason): string {
  switch (reason) {
    case 'divide-by-zero': return '0 で割っています';
    case 'missing-value': return '参照している列が空か、数値にできない値です';
    case 'domain-error': return '関数の定義域の外です（負数の平方根・0 以下の対数など）';
    case 'overflow': return '計算結果が大きすぎて扱えません';
    default: return '引数が不正です';
  }
}

function failureNextStep(reason: CalculateFailureReason): string {
  switch (reason) {
    case 'divide-by-zero': return '分母が 0 になる行を上流の行フィルターで除くか、評価できないときの扱いを「空にする」にしてください。';
    case 'missing-value': return '上流の null 処理で既定値を入れるか、評価できないときの扱いを「空にする」にしてください。';
    case 'domain-error': return '式を見直すか、定義域の外になる行を上流の行フィルターで除いてください。';
    case 'overflow': return '桁数の小さい列を使うか、式を見直してください。';
    default: return '丸めの桁数は 0〜15 の整数です。設定を確かめてください。';
  }
}

/** parse 失敗を利用者に見せる 1 行（位置は 1 起点で数える）。 */
function parseFailureMessage(message: string, position: number): string {
  return `式の ${position + 1} 文字目: ${message}`;
}

/**
 * 診断 1 件を issue へ写す。位置が分かるもの（式の読み取りの失敗）にだけ
 * 「式の N 文字目:」を前置する。列の問題は式のどこを指せばよいか決まらないため付けない。
 */
function toIssue(diagnostic: ExpressionDiagnostic): SchemaIssue {
  const message =
    diagnostic.position === undefined
      ? diagnostic.message
      : parseFailureMessage(diagnostic.message, diagnostic.position);
  return {
    severity: diagnostic.severity,
    message,
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
  };
}

class CalculateNode implements EtlNode<CalculateConfig> {
  readonly type = CALCULATE_TYPE;
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): CalculateConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`calculate: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: CalculateConfig): SchemaInference {
    if (inputs.length !== 1) {
      throw new SchemaError(`calculate: expects exactly 1 input, received ${inputs.length}`);
    }
    const input = inputs[0] ?? { columns: [] };
    const schema = withOutputColumn(input, config.outputColumn);

    // 式の妥当性の判定は診断（calculate-diagnostics）に一本化する。ここに規則を書き足すと、
    // 画面・LLM への差し戻し・スキーマ推論で答えが食い違う。
    const validation = validateExpression(config.expression, input);
    return {
      schema,
      state: validation.ok ? 'confirmed' : 'mismatch',
      issues: validation.diagnostics.map(toIssue),
    };
  }

  execute(inputs: readonly Table[], config: CalculateConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const schema = withOutputColumn(input.schema, config.outputColumn);

    // スキーマ点検を通っていない経路（保存済み Tool の直接実行など）で読めない式に出会ったら設定の誤り。
    if (config.expression.trim() === '') {
      throw new ConfigError('calculate: 式が空です');
    }
    const parsed = parseExpression(config.expression, columnNames(input.schema));
    if (!parsed.ok) {
      throw new ConfigError(`calculate: ${parseFailureMessage(parsed.message, parsed.position)}`);
    }

    const onError = config.onError ?? 'null';
    const precision = config.precision;

    const rows: Row[] = input.rows.map((row, index) => {
      // 参照の寄せ方も丸めも診断と同じ関数を通す（プレビューと実行で値が分かれないため）。
      const outcome = evaluateExpressionDetailed(parsed.ast, rowLookup(row));
      const value = applyPrecision(outcome.value, precision);
      if (value === null && onError === 'fail') {
        // 丸めで初めて null になった場合、評価そのものは成功しているので理由が入らない。
        const reason = outcome.reason ?? 'invalid-argument';
        throw new SchemaError(
          `行 ${index + 1}: 式 \`${config.expression}\` を評価できません（${failureReason(reason)}）。${failureNextStep(reason)}`,
        );
      }
      return { ...row, [config.outputColumn]: value };
    });

    return { schema, rows };
  }
}

/** `calculate` ノードのシングルトン。 */
export const calculateNode: EtlNode<CalculateConfig> = new CalculateNode();

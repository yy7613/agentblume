/**
 * 関数電卓ノード（calculate）の表示用の写し。
 *
 * UI層は domain（src/domain/etl/nodes/calculate-expression.ts）を import しない方針
 * （依存検査で落ちる）なので、関数一覧・定数一覧をここに複製する。名前・群・引数数・並びは
 * calculator-keys.test.ts が domain の正典（CALCULATE_FUNCTIONS / CALCULATE_CONSTANTS）との
 * 一致をピン留めする（filter の FILTER_OPS と同じ規律。NodeInspector.tsx 参照）。
 */

export type CalculatorFunctionGroup = 'basic' | 'rounding' | 'exponential' | 'trigonometric';

export interface CalculatorFunctionKey {
  readonly name: string;
  readonly group: CalculatorFunctionGroup;
  readonly minArgs: number;
  readonly maxArgs: number | undefined;
  readonly hint: string;
  readonly hintJa: string;
}

/** 並びは domain の CALCULATE_FUNCTIONS と同じ（ピン留めテストで固定）。 */
export const CALCULATOR_FUNCTION_KEYS: readonly CalculatorFunctionKey[] = [
  // basic
  { name: 'abs', group: 'basic', minArgs: 1, maxArgs: 1, hint: 'abs(x): absolute value', hintJa: 'abs(x): 絶対値' },
  { name: 'sign', group: 'basic', minArgs: 1, maxArgs: 1, hint: 'sign(x): -1, 0 or 1', hintJa: 'sign(x): 符号（-1・0・1）' },
  { name: 'sqrt', group: 'basic', minArgs: 1, maxArgs: 1, hint: 'sqrt(x): square root', hintJa: 'sqrt(x): 平方根' },
  { name: 'cbrt', group: 'basic', minArgs: 1, maxArgs: 1, hint: 'cbrt(x): cube root', hintJa: 'cbrt(x): 立方根' },
  { name: 'pow', group: 'basic', minArgs: 2, maxArgs: 2, hint: 'pow(x, y): x to the power y', hintJa: 'pow(x, y): x の y 乗' },
  { name: 'mod', group: 'basic', minArgs: 2, maxArgs: 2, hint: 'mod(x, y): remainder', hintJa: 'mod(x, y): 剰余' },
  { name: 'min', group: 'basic', minArgs: 1, maxArgs: undefined, hint: 'min(...): smallest value', hintJa: 'min(...): 最小値' },
  { name: 'max', group: 'basic', minArgs: 1, maxArgs: undefined, hint: 'max(...): largest value', hintJa: 'max(...): 最大値' },
  { name: 'hypot', group: 'basic', minArgs: 2, maxArgs: 2, hint: 'hypot(x, y): sqrt(x^2 + y^2)', hintJa: 'hypot(x, y): 直角三角形の斜辺' },
  // rounding
  { name: 'round', group: 'rounding', minArgs: 1, maxArgs: 2, hint: 'round(x[, n]): round to n decimal places', hintJa: 'round(x[, n]): 小数第n位で四捨五入' },
  { name: 'floor', group: 'rounding', minArgs: 1, maxArgs: 1, hint: 'floor(x): round down', hintJa: 'floor(x): 切り捨て' },
  { name: 'ceil', group: 'rounding', minArgs: 1, maxArgs: 1, hint: 'ceil(x): round up', hintJa: 'ceil(x): 切り上げ' },
  { name: 'trunc', group: 'rounding', minArgs: 1, maxArgs: 1, hint: 'trunc(x): drop the decimal part', hintJa: 'trunc(x): 小数部を切り捨て' },
  // exponential
  { name: 'exp', group: 'exponential', minArgs: 1, maxArgs: 1, hint: 'exp(x): e to the power x', hintJa: 'exp(x): e の x 乗' },
  { name: 'ln', group: 'exponential', minArgs: 1, maxArgs: 1, hint: 'ln(x): natural logarithm', hintJa: 'ln(x): 自然対数' },
  { name: 'log10', group: 'exponential', minArgs: 1, maxArgs: 1, hint: 'log10(x): base-10 logarithm', hintJa: 'log10(x): 常用対数' },
  { name: 'log2', group: 'exponential', minArgs: 1, maxArgs: 1, hint: 'log2(x): base-2 logarithm', hintJa: 'log2(x): 2を底とする対数' },
  { name: 'log', group: 'exponential', minArgs: 2, maxArgs: 2, hint: 'log(x, base): logarithm with a given base', hintJa: 'log(x, base): 底を指定した対数' },
  // trigonometric
  { name: 'sin', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'sin(x): sine (radians)', hintJa: 'sin(x): 正弦（ラジアン）' },
  { name: 'cos', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'cos(x): cosine (radians)', hintJa: 'cos(x): 余弦（ラジアン）' },
  { name: 'tan', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'tan(x): tangent (radians)', hintJa: 'tan(x): 正接（ラジアン）' },
  { name: 'asin', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'asin(x): inverse sine', hintJa: 'asin(x): 逆正弦' },
  { name: 'acos', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'acos(x): inverse cosine', hintJa: 'acos(x): 逆余弦' },
  { name: 'atan', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'atan(x): inverse tangent', hintJa: 'atan(x): 逆正接' },
  { name: 'atan2', group: 'trigonometric', minArgs: 2, maxArgs: 2, hint: 'atan2(y, x): angle from y, x', hintJa: 'atan2(y, x): y, x からの角度' },
  { name: 'sinh', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'sinh(x): hyperbolic sine', hintJa: 'sinh(x): 双曲線正弦' },
  { name: 'cosh', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'cosh(x): hyperbolic cosine', hintJa: 'cosh(x): 双曲線余弦' },
  { name: 'tanh', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'tanh(x): hyperbolic tangent', hintJa: 'tanh(x): 双曲線正接' },
  { name: 'deg', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'deg(x): radians to degrees', hintJa: 'deg(x): ラジアン→度' },
  { name: 'rad', group: 'trigonometric', minArgs: 1, maxArgs: 1, hint: 'rad(x): degrees to radians', hintJa: 'rad(x): 度→ラジアン' },
];

/** 式中では小文字で書く定数（pi, e）。glyph はキーパッドの表示文字。 */
export const CALCULATOR_CONSTANT_KEYS: readonly { readonly name: string; readonly glyph: string }[] = [
  { name: 'pi', glyph: 'π' },
  { name: 'e', glyph: 'e' },
];

export const CALCULATOR_GROUP_LABELS: Readonly<Record<CalculatorFunctionGroup, { readonly en: string; readonly ja: string }>> = {
  basic: { en: 'Basic', ja: '基本' },
  rounding: { en: 'Rounding', ja: '丸め' },
  exponential: { en: 'Exponential / log', ja: '指数・対数' },
  trigonometric: { en: 'Trigonometric', ja: '三角' },
};

/** 挿入用: 表示記号 → 式に書く記号。数字・カッコ・+ ^ % はどちらも同じ文字なのでここには含めない。 */
export const CALCULATOR_OPERATOR_KEYS: readonly { readonly glyph: string; readonly insert: string }[] = [
  { glyph: '×', insert: '*' },
  { glyph: '÷', insert: '/' },
  { glyph: '−', insert: '-' },
];

/**
 * 括弧の対応だけを見る簡易検査（打っている途中の手掛かり用。妥当性の正典は inferSchema の issue）。
 * `[列名]` の中の文字は列名の一部であり演算子ではないため、`[..]` に入っている間の括弧は数えない
 * （列名に "単価 (税込)" のような括弧を含められるようにするため）。
 * open は「開き - 閉じ」の符号付き差分: 正なら開きが多く、負なら閉じが多い。
 */
export function parenthesisBalance(expression: string): { readonly balanced: boolean; readonly open: number } {
  let open = 0;
  let inBracket = false;
  for (const ch of expression) {
    if (inBracket) {
      if (ch === ']') inBracket = false;
      continue;
    }
    if (ch === '[') { inBracket = true; continue; }
    if (ch === '(') open += 1;
    else if (ch === ')') open -= 1;
  }
  return { balanced: open === 0, open };
}

/**
 * 表示用の式（`*` → `×`, `/` → `÷`）。保存する値（config.expression）はこの関数を呼んでも変わらない
 * （呼び出し側が別変数へ入れて表示にだけ使う）。
 */
export function displayExpression(expression: string): string {
  return expression.replace(/\*/g, '×').replace(/\//g, '÷');
}

/** カーソル位置（caret）へ text を挿入し、挿入後の式と新しいカーソル位置（挿入した文字列の直後）を返す。 */
export function insertAt(expression: string, caret: number, text: string): { readonly expression: string; readonly caret: number } {
  const clamped = Math.max(0, Math.min(caret, expression.length));
  const next = expression.slice(0, clamped) + text + expression.slice(clamped);
  return { expression: next, caret: clamped + text.length };
}

/**
 * ドメイン: 関数電卓ノードの式解釈器（v39 実装契約 §2.1 / ADR-0045）
 *
 * 字句解析 → 再帰下降の構文解析 → 評価。`eval` / `new Function` / 外部の式ライブラリは使わない。
 * 保存された式は他の利用者・エージェントの実行経路に乗るため、任意コードを走らせる手段を置けない。
 * 受け付ける文法を数値・列参照・算術演算子・括弧・固定の関数と定数だけに絞り、
 * 比較・条件・文字列・代入は「読めない」で弾く（境界を明示するために自作している）。
 */

/** 式の長さの上限（文字）。悪意ある長大な式で解釈器を疲弊させないため。 */
export const MAX_EXPRESSION_LENGTH = 1000;
/** 括弧・関数呼び出しの入れ子の上限。再帰下降の深さがそのまま呼び出しスタックになるため。 */
export const MAX_EXPRESSION_DEPTH = 64;
/** トークン数の上限。 */
export const MAX_EXPRESSION_TOKENS = 500;

/** 関数の分類（UI の並び順・見出しに使う）。 */
export type CalculateFunctionGroup = 'basic' | 'rounding' | 'exponential' | 'trigonometric';

/** 式の中で呼べる関数 1 つ。 */
export interface CalculateFunction {
  /** 小文字。式中では大文字小文字を区別しない。 */
  readonly name: string;
  readonly group: CalculateFunctionGroup;
  /** 引数の数。可変長は max を undefined にする。 */
  readonly arity: { readonly min: number; readonly max: number | undefined };
  /**
   * LLM 向けの呼び方（英語・小文字）。例 `round(x, digits?)` / `min(a, b, ...)`。
   * プロンプトの関数一覧はここから機械的に組む（手書きの一覧を別に持つと関数を足したとき置き去りになる）。
   */
  readonly signature: string;
  /**
   * LLM 向けの一文説明（英語）。単位・定義域・端の扱いを書く。
   * 引数の順が入れ替わっても値が出てしまうもの（`log` / `atan2`）は、順そのものを言葉で書く。
   */
  readonly description: string;
}

/**
 * 関数一覧の正典。UI は表示用の写しを持ち、テストでここと一致をピン留めする（ADR-0045 決定 5）。
 * 並び順も UI の表示順として固定する。
 */
export const CALCULATE_FUNCTIONS: readonly CalculateFunction[] = [
  // basic
  { name: 'abs', group: 'basic', arity: { min: 1, max: 1 }, signature: 'abs(x)', description: 'Absolute value of x.' },
  { name: 'sign', group: 'basic', arity: { min: 1, max: 1 }, signature: 'sign(x)', description: 'Sign of x: -1 when negative, 0 when zero, 1 when positive.' },
  { name: 'sqrt', group: 'basic', arity: { min: 1, max: 1 }, signature: 'sqrt(x)', description: 'Square root; x must be >= 0, otherwise the row yields null.' },
  { name: 'cbrt', group: 'basic', arity: { min: 1, max: 1 }, signature: 'cbrt(x)', description: 'Cube root; negative x is allowed.' },
  { name: 'pow', group: 'basic', arity: { min: 2, max: 2 }, signature: 'pow(base, exponent)', description: 'base raised to exponent; the same as base ^ exponent.' },
  { name: 'mod', group: 'basic', arity: { min: 2, max: 2 }, signature: 'mod(a, b)', description: 'Remainder of a divided by b; the sign follows a, so mod(-7, 3) is -1. b must not be 0.' },
  { name: 'min', group: 'basic', arity: { min: 1, max: undefined }, signature: 'min(a, b, ...)', description: 'Smallest of the given values; takes one or more arguments.' },
  { name: 'max', group: 'basic', arity: { min: 1, max: undefined }, signature: 'max(a, b, ...)', description: 'Largest of the given values; takes one or more arguments.' },
  { name: 'hypot', group: 'basic', arity: { min: 2, max: 2 }, signature: 'hypot(a, b)', description: 'Square root of a*a + b*b; takes exactly two arguments.' },
  // rounding
  { name: 'round', group: 'rounding', arity: { min: 1, max: 2 }, signature: 'round(x, digits?)', description: 'Rounds x to digits decimal places (default 0), half away from zero, so round(-2.5) is -3. digits must be an integer from 0 to 15.' },
  { name: 'floor', group: 'rounding', arity: { min: 1, max: 1 }, signature: 'floor(x)', description: 'Largest integer that is <= x.' },
  { name: 'ceil', group: 'rounding', arity: { min: 1, max: 1 }, signature: 'ceil(x)', description: 'Smallest integer that is >= x.' },
  { name: 'trunc', group: 'rounding', arity: { min: 1, max: 1 }, signature: 'trunc(x)', description: 'Drops the fractional part of x, rounding toward zero.' },
  // exponential
  { name: 'exp', group: 'exponential', arity: { min: 1, max: 1 }, signature: 'exp(x)', description: 'e raised to x.' },
  { name: 'ln', group: 'exponential', arity: { min: 1, max: 1 }, signature: 'ln(x)', description: 'Natural logarithm (base e); x must be > 0.' },
  { name: 'log10', group: 'exponential', arity: { min: 1, max: 1 }, signature: 'log10(x)', description: 'Base-10 logarithm; x must be > 0.' },
  { name: 'log2', group: 'exponential', arity: { min: 1, max: 1 }, signature: 'log2(x)', description: 'Base-2 logarithm; x must be > 0.' },
  { name: 'log', group: 'exponential', arity: { min: 2, max: 2 }, signature: 'log(x, base)', description: 'Logarithm of x in the given base; the value comes first and the base second. Both must be > 0 and base must not be 1.' },
  // trigonometric（ラジアン）
  { name: 'sin', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'sin(x)', description: 'Sine of x; x is in radians, not degrees (use rad(d) to convert degrees).' },
  { name: 'cos', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'cos(x)', description: 'Cosine of x; x is in radians, not degrees.' },
  { name: 'tan', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'tan(x)', description: 'Tangent of x; x is in radians, not degrees.' },
  { name: 'asin', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'asin(x)', description: 'Arc sine of x in radians; x must be within -1 to 1.' },
  { name: 'acos', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'acos(x)', description: 'Arc cosine of x in radians; x must be within -1 to 1.' },
  { name: 'atan', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'atan(x)', description: 'Arc tangent of x in radians; the result is within -pi/2 to pi/2.' },
  { name: 'atan2', group: 'trigonometric', arity: { min: 2, max: 2 }, signature: 'atan2(y, x)', description: 'Angle in radians of the point (x, y); the y coordinate comes first and the x coordinate second.' },
  { name: 'sinh', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'sinh(x)', description: 'Hyperbolic sine of x.' },
  { name: 'cosh', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'cosh(x)', description: 'Hyperbolic cosine of x.' },
  { name: 'tanh', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'tanh(x)', description: 'Hyperbolic tangent of x; the result is within -1 to 1.' },
  { name: 'deg', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'deg(x)', description: 'Converts x from radians to degrees.' },
  { name: 'rad', group: 'trigonometric', arity: { min: 1, max: 1 }, signature: 'rad(x)', description: 'Converts x from degrees to radians.' },
];

/** 定数。式中では大文字小文字を区別しない。 */
export const CALCULATE_CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

/** `round(x, n)` / ノードの `precision` が受け付ける小数桁の上限。倍精度でこれ以上は意味を持たない。 */
export const MAX_ROUND_DIGITS = 15;

const FUNCTION_BY_NAME = new Map<string, CalculateFunction>(
  CALCULATE_FUNCTIONS.map((fn) => [fn.name, fn]),
);

/** 打ち間違いの候補に使う関数名（正典の並び順のまま）。 */
const FUNCTION_NAMES: readonly string[] = CALCULATE_FUNCTIONS.map((fn) => fn.name);
/** 打ち間違いの候補に使う定数名。 */
const CONSTANT_NAMES: readonly string[] = Object.keys(CALCULATE_CONSTANTS);

/**
 * 打ち間違いの近さ（Damerau-Levenshtein 距離 / 隣接した入れ替えを 1 と数える版）。同じなら 0。
 *
 * 入れ替えを 1 と数えるのは、打ち間違いの多くが隣接キーの前後入れ替え（`lgo10` / `sqrt`→`sqtr`）で、
 * 素の Levenshtein だとこれが 2 になって「遠い」と判定され、正しい候補を出せなくなるため。
 */
export function nameDistance(left: string, right: string): number {
  // 壊れた入力でも投げない（候補は当てずっぽうでよい場面ではなく、落ちてよい場面でもない）。
  const a = typeof left === 'string' ? left : '';
  const b = typeof right === 'string' ? right : '';
  if (a === b) return 0;
  if (a === '') return b.length;
  if (b === '') return a.length;

  // 直前の 2 行だけを持つ（式の名前は短く、行列を全部持つ必要がない）。
  let twoBack: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current: number[] = [];

  for (let i = 1; i <= a.length; i += 1) {
    current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (current[j - 1] ?? 0) + 1, // 挿入
        (previous[j] ?? 0) + 1, // 削除
        (previous[j - 1] ?? 0) + cost, // 置換
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] ?? 0) + 1); // 隣接の入れ替え
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }

  return previous[b.length] ?? 0;
}

/**
 * 候補のうち最も近いものを 1 つ返す。遠すぎるものは返さない（見当違いの候補は害）。
 * しきい値: 入力が 4 文字以下なら距離 1 まで、5 文字以上なら距離 2 まで。
 * 同じ距離が複数あれば `candidates` の順で先のものを返す（決定的であること）。
 * 比較は大文字小文字を区別しない。
 */
export function suggestName(input: string, candidates: readonly string[]): string | undefined {
  if (typeof input !== 'string' || input === '') return undefined;
  const list: readonly string[] = Array.isArray(candidates) ? candidates : [];

  // 短い名前ほど 2 文字違えば別物になる（`ab` と `pi` を結び付けても直し方にならない）。
  const limit = input.length <= 4 ? 1 : 2;
  const normalized = input.toLowerCase();

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of list) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const distance = nameDistance(normalized, candidate.toLowerCase());
    // 同点は先に来たものを残す（`candidates` の並びが優先順位そのもの）。
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 失敗の種別（v40 実装契約 §2.1）。
 *
 * 文言（`message`）は利用者に合わせて改訂されるが、種別は変わらない。
 * LLM へ「何を直せばよいか」を渡す・画面が原因ごとに案内を出し分ける、といった
 * 機械的な取り回しはすべてこちらを見る（文言の一致で分岐させない）。
 */
export const EXPRESSION_ERROR_CODES = [
  'empty',
  'too-long',
  'too-many-tokens',
  'too-deep',
  'illegal-character',
  'invalid-number',
  'unclosed-bracket',
  'unexpected-bracket',
  'empty-column-name',
  'unknown-function',
  'function-needs-parens',
  'unknown-name',
  'wrong-argument-count',
  'missing-argument',
  'misplaced-comma',
  'unclosed-paren',
  'unexpected-paren',
  'missing-operand',
  'unexpected-end',
  'trailing-input',
  'unreadable',
] as const;
export type ExpressionErrorCode = (typeof EXPRESSION_ERROR_CODES)[number];

/** 構文木。外部へは opaque（`parseExpression` が返した値を `evaluateExpression` へ渡すだけ）。 */
export type ExpressionAst = unknown;

/** 式を読んだ結果。失敗も値で返す（投げない）。 */
export type ParseExpressionResult =
  | { readonly ok: true; readonly ast: ExpressionAst; readonly references: readonly string[] }
  | {
      readonly ok: false;
      readonly code: ExpressionErrorCode;
      readonly message: string;
      readonly position: number;
      /** 近い候補。`unknown-function` / `unknown-name` のときだけ入ることがある。 */
      readonly suggestion?: string;
    };

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '^';
type UnaryOperator = '+' | '-';

interface NumberNode {
  readonly kind: 'number';
  readonly value: number;
}
interface ColumnNode {
  readonly kind: 'column';
  readonly name: string;
}
interface UnaryNode {
  readonly kind: 'unary';
  readonly operator: UnaryOperator;
  readonly operand: ExpressionNode;
}
interface BinaryNode {
  readonly kind: 'binary';
  readonly operator: BinaryOperator;
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}
interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly ExpressionNode[];
}
type ExpressionNode = NumberNode | ColumnNode | UnaryNode | BinaryNode | CallNode;

type TokenKind = 'number' | 'name' | 'column' | 'operator' | 'lparen' | 'rparen' | 'comma';

interface Token {
  readonly kind: TokenKind;
  /** 原文の綴り（`column` は括弧の中身、`number` は正規化後の字面）。 */
  readonly text: string;
  /** `number` のときだけ意味を持つ。 */
  readonly value: number;
  /** 0 起点の文字位置。 */
  readonly position: number;
}

interface Failure {
  readonly code: ExpressionErrorCode;
  readonly message: string;
  readonly position: number;
  readonly suggestion?: string;
}

/** 全角から寄せる対象の記号。列名に現れうる文字を巻き込まないよう、構文の文字だけに絞る。 */
const SYNTAX_CHARACTERS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '-', '*', '/', '%', '^', '(', ')', '[', ']', ',', '.', ' ',
]);

/** NFKC では半角へ寄らない算術記号。電卓の見た目どおりに打てるようにする。 */
const OPERATOR_ALIASES = new Map<string, string>([
  ['×', '*'],
  ['÷', '/'],
  ['−', '-'],
]);

/**
 * 1 文字を構文用に正規化する。
 * 文字単位で行うのは、`position` を原文と 1:1 に保つため（NFKC は 1 文字を複数文字へ展開しうる）。
 */
function normalizeCharacter(character: string): string {
  const alias = OPERATOR_ALIASES.get(character);
  if (alias !== undefined) return alias;
  const folded = character.normalize('NFKC');
  return folded.length === 1 && SYNTAX_CHARACTERS.has(folded) ? folded : character;
}

/** 位置 index の正規化後の 1 文字（範囲外は空文字）。 */
function charAt(text: string, index: number): string {
  const raw = text[index];
  return raw === undefined ? '' : normalizeCharacter(raw);
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isNameStart(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '_'
  );
}

function isNamePart(character: string): boolean {
  return isNameStart(character) || isDigit(character);
}

function token(kind: TokenKind, text: string, position: number, value = 0): Token {
  return { kind, text, value, position };
}

type TokenizeResult = { readonly ok: true; readonly tokens: readonly Token[] } | ({ readonly ok: false } & Failure);

function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = charAt(text, index);

    if (isWhitespace(character)) {
      index += 1;
      continue;
    }

    if (character === '[') {
      const closing = findClosingBracket(text, index + 1);
      if (closing === -1) {
        return { ok: false, code: 'unclosed-bracket', message: '列参照の ] がありません', position: index };
      }
      // 列名は原文のまま切り出す（列名の大文字小文字・全角半角は区別する）。
      const name = text.slice(index + 1, closing);
      if (name === '') {
        return { ok: false, code: 'empty-column-name', message: '列名が空です', position: index };
      }
      tokens.push(token('column', name, index));
      index = closing + 1;
    } else if (isDigit(character) || (character === '.' && isDigit(charAt(text, index + 1)))) {
      const scanned = scanNumber(text, index);
      if (!scanned.ok) return scanned;
      tokens.push(token('number', scanned.literal, index, scanned.value));
      index = scanned.next;
    } else if (isNameStart(character)) {
      let end = index;
      while (end < text.length && isNamePart(charAt(text, end))) end += 1;
      tokens.push(token('name', text.slice(index, end), index));
      index = end;
    } else if (character === '(') {
      tokens.push(token('lparen', '(', index));
      index += 1;
    } else if (character === ')') {
      tokens.push(token('rparen', ')', index));
      index += 1;
    } else if (character === ',') {
      tokens.push(token('comma', ',', index));
      index += 1;
    } else if (character === ']') {
      return { ok: false, code: 'unexpected-bracket', message: '対応する [ がありません', position: index };
    } else if (isBinaryOperator(character)) {
      tokens.push(token('operator', character, index));
      index += 1;
    } else {
      return {
        ok: false,
        code: 'illegal-character',
        message: `式では使えない文字です: ${text[index] ?? ''}`,
        position: index,
      };
    }

    if (tokens.length > MAX_EXPRESSION_TOKENS) {
      const last = tokens[tokens.length - 1];
      return {
        ok: false,
        code: 'too-many-tokens',
        message: `式の要素が多すぎます（上限 ${MAX_EXPRESSION_TOKENS} 個）`,
        position: last === undefined ? 0 : last.position,
      };
    }
  }

  return { ok: true, tokens };
}

function isBinaryOperator(character: string): character is BinaryOperator {
  return (
    character === '+' ||
    character === '-' ||
    character === '*' ||
    character === '/' ||
    character === '%' ||
    character === '^'
  );
}

/** `[` の中身の終わりを探す。全角の `］` も閉じとして認める。 */
function findClosingBracket(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (charAt(text, index) === ']') return index;
  }
  return -1;
}

type ScanNumberResult =
  | { readonly ok: true; readonly literal: string; readonly value: number; readonly next: number }
  | ({ readonly ok: false } & Failure);

function scanNumber(text: string, start: number): ScanNumberResult {
  let index = start;
  let literal = '';

  while (isDigit(charAt(text, index))) {
    literal += charAt(text, index);
    index += 1;
  }

  if (charAt(text, index) === '.') {
    if (!isDigit(charAt(text, index + 1))) {
      return { ok: false, code: 'invalid-number', message: '小数点のあとに数字がありません', position: index };
    }
    literal += '.';
    index += 1;
    while (isDigit(charAt(text, index))) {
      literal += charAt(text, index);
      index += 1;
    }
  }

  // 指数部は「数字が続くとき」だけ取り込む。そうしないと定数 e が指数の書きかけに見える。
  const exponentMark = charAt(text, index);
  if (exponentMark === 'e' || exponentMark === 'E') {
    let cursor = index + 1;
    let sign = '';
    const signCharacter = charAt(text, cursor);
    if (signCharacter === '+' || signCharacter === '-') {
      sign = signCharacter;
      cursor += 1;
    }
    if (isDigit(charAt(text, cursor))) {
      literal += `e${sign}`;
      while (isDigit(charAt(text, cursor))) {
        literal += charAt(text, cursor);
        cursor += 1;
      }
      index = cursor;
    }
  }

  return { ok: true, literal, value: Number(literal), next: index };
}

/**
 * 再帰下降パーサ。失敗は例外ではなく `failure` に記録して null を返し、呼び出し元は素通しで巻き戻る
 * （ETL ドメインでは `throw new Error()` を使わない規律があり、制御用の例外を持ち込まないため）。
 */
class Parser {
  private index = 0;
  private depth = 0;
  private failure: Failure | undefined;
  private readonly references: string[] = [];
  private readonly columns: ReadonlySet<string>;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly knownColumns: readonly string[],
    private readonly textLength: number,
  ) {
    this.columns = new Set(knownColumns);
  }

  parse(): ParseExpressionResult {
    if (this.tokens.length === 0) {
      return { ok: false, code: 'empty', message: '式が空です', position: 0 };
    }
    const ast = this.parseSum();
    if (this.failure === undefined && ast !== null) {
      const extra = this.peek();
      if (extra !== undefined) {
        this.fail('trailing-input', `余分な入力があります: ${extra.text}`, extra.position);
      }
    }
    if (this.failure !== undefined) {
      return { ok: false, ...this.failure };
    }
    if (ast === null) {
      // 保険。null を返す経路はすべて fail を通るので、ここへは来ない想定。
      return { ok: false, code: 'unreadable', message: '式を読めません', position: 0 };
    }
    return { ok: true, ast, references: this.references };
  }

  private fail(code: ExpressionErrorCode, message: string, position: number, suggestion?: string): null {
    // 最初の失敗が利用者にとって原因に一番近い。以降の巻き戻りで上書きしない。
    if (this.failure === undefined) {
      this.failure = { code, message, position, ...(suggestion === undefined ? {} : { suggestion }) };
    }
    return null;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private advance(): void {
    this.index += 1;
  }

  /** 式の末尾の位置（「途中で終わっている」の指し先）。 */
  private endPosition(): number {
    return this.textLength;
  }

  private parseSum(): ExpressionNode | null {
    let left = this.parseTerm();
    if (left === null) return null;
    for (;;) {
      const operator = this.peek();
      if (operator === undefined || operator.kind !== 'operator') break;
      if (operator.text !== '+' && operator.text !== '-') break;
      this.advance();
      const right = this.parseTerm();
      if (right === null) return null;
      left = { kind: 'binary', operator: operator.text, left, right };
    }
    return left;
  }

  private parseTerm(): ExpressionNode | null {
    let left = this.parseFactor();
    if (left === null) return null;
    for (;;) {
      const operator = this.peek();
      if (operator === undefined || operator.kind !== 'operator') break;
      if (operator.text !== '*' && operator.text !== '/' && operator.text !== '%') break;
      this.advance();
      const right = this.parseFactor();
      if (right === null) return null;
      left = { kind: 'binary', operator: operator.text, left, right };
    }
    return left;
  }

  private parseFactor(): ExpressionNode | null {
    const base = this.parseUnary();
    if (base === null) return null;
    const operator = this.peek();
    if (operator === undefined || operator.kind !== 'operator' || operator.text !== '^') return base;
    this.advance();
    // `^` は右結合（2^3^2 = 2^(3^2)）。
    const exponent = this.parseFactor();
    if (exponent === null) return null;
    return { kind: 'binary', operator: '^', left: base, right: exponent };
  }

  private parseUnary(): ExpressionNode | null {
    const operator = this.peek();
    if (operator !== undefined && operator.kind === 'operator' && (operator.text === '+' || operator.text === '-')) {
      this.advance();
      const operand = this.parseUnary();
      if (operand === null) return null;
      return { kind: 'unary', operator: operator.text, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionNode | null {
    const current = this.peek();
    if (current === undefined) {
      return this.fail('unexpected-end', '式が途中で終わっています', this.endPosition());
    }

    switch (current.kind) {
      case 'number':
        this.advance();
        return { kind: 'number', value: current.value };
      case 'column':
        this.advance();
        this.addReference(current.text);
        return { kind: 'column', name: current.text };
      case 'name':
        return this.parseName(current);
      case 'lparen': {
        this.advance();
        if (!this.enter(current.position)) return null;
        const inner = this.parseSum();
        if (inner === null) return null;
        if (!this.expectRightParen()) return null;
        this.depth -= 1;
        return inner;
      }
      case 'rparen':
        return this.fail('unexpected-paren', '対応する ( がありません', current.position);
      case 'comma':
        return this.fail('misplaced-comma', ', はここでは使えません', current.position);
      case 'operator':
        return this.fail('missing-operand', `演算子 ${current.text} の右に数値がありません`, current.position);
      default:
        // 保険。TokenKind は上で尽くしているので、ここへは来ない想定。
        return this.fail('unreadable', '式を読めません', current.position);
    }
  }

  private parseName(current: Token): ExpressionNode | null {
    // 関数名・定数名は大文字小文字を区別しない。列名は区別する。
    const lower = current.text.toLowerCase();
    const fn = FUNCTION_BY_NAME.get(lower);
    const next = this.peek(1);

    if (next !== undefined && next.kind === 'lparen') {
      if (fn === undefined) {
        return this.fail(
          'unknown-function',
          `知らない関数です: ${current.text}`,
          current.position,
          suggestName(current.text, FUNCTION_NAMES),
        );
      }
      return this.parseCall(current, fn);
    }

    if (fn !== undefined) {
      return this.fail('function-needs-parens', `関数 ${lower} は ${lower}(...) の形で書きます`, current.position);
    }

    const constant = CALCULATE_CONSTANTS[lower];
    if (constant !== undefined) {
      this.advance();
      return { kind: 'number', value: constant };
    }

    // 裸の識別子は入力にその列があるときだけ列。無ければ打ち間違いとして見せる（黙って 0 にしない）。
    if (this.columns.has(current.text)) {
      this.advance();
      this.addReference(current.text);
      return { kind: 'column', name: current.text };
    }

    // 候補は列 → 関数 → 定数の順に見る。裸の識別子を打つのはたいてい列のつもりなので、
    // 同じ距離なら列を出したほうが直し方として当たる。
    return this.fail(
      'unknown-name',
      `知らない名前です: ${current.text}。列は [${current.text}] の形で書きます`,
      current.position,
      suggestName(current.text, [...this.knownColumns, ...FUNCTION_NAMES, ...CONSTANT_NAMES]),
    );
  }

  private parseCall(name: Token, fn: CalculateFunction): ExpressionNode | null {
    this.advance(); // 関数名
    const lparen = this.peek();
    this.advance(); // (
    if (!this.enter(lparen === undefined ? name.position : lparen.position)) return null;

    const args: ExpressionNode[] = [];
    const first = this.peek();
    if (first === undefined || first.kind !== 'rparen') {
      for (;;) {
        const arg = this.parseSum();
        if (arg === null) return null;
        args.push(arg);
        const separator = this.peek();
        if (separator !== undefined && separator.kind === 'comma') {
          this.advance();
          // 区切りの直後に ) が来たら、ここで理由を言う。そのまま値の読み取りへ進むと
          // 「対応する ( がありません」（括弧の不一致）という別の原因の文言が出てしまう。
          const afterComma = this.peek();
          if (afterComma === undefined || afterComma.kind === 'rparen') {
            return this.fail(
              'missing-argument',
              `関数 ${name.text.toLowerCase()} の , のあとに引数がありません`,
              separator.position,
            );
          }
          continue;
        }
        break;
      }
    }

    if (!this.expectRightParen()) return null;
    this.depth -= 1;

    const { min, max } = fn.arity;
    if (args.length < min || (max !== undefined && args.length > max)) {
      return this.fail(
        'wrong-argument-count',
        `関数 ${fn.name} の引数は ${describeArity(fn)}です（${args.length} 個でした）`,
        name.position,
      );
    }

    return { kind: 'call', name: fn.name, args };
  }

  private expectRightParen(): boolean {
    const current = this.peek();
    if (current === undefined) {
      this.fail('unclosed-paren', '閉じ括弧 ) がありません', this.endPosition());
      return false;
    }
    if (current.kind !== 'rparen') {
      this.fail('unclosed-paren', `閉じ括弧 ) がありません: ${current.text}`, current.position);
      return false;
    }
    this.advance();
    return true;
  }

  private enter(position: number): boolean {
    this.depth += 1;
    if (this.depth > MAX_EXPRESSION_DEPTH) {
      this.fail('too-deep', `入れ子が深すぎます（上限 ${MAX_EXPRESSION_DEPTH} 段）`, position);
      return false;
    }
    return true;
  }

  private addReference(name: string): void {
    if (!this.references.includes(name)) this.references.push(name);
  }
}

function describeArity(fn: CalculateFunction): string {
  const { min, max } = fn.arity;
  if (max === undefined) return `${min} 個以上`;
  if (min === max) return `${min} 個`;
  return `${min}〜${max} 個`;
}

/**
 * 式を読む。`knownColumns` は裸の識別子を列として扱うかの判定にだけ使う（`[..]` は常に列）。
 * 文法エラー・知らない名前・引数の数の不一致・上限超過はすべて ok:false（投げない）。
 */
export function parseExpression(text: string, knownColumns: readonly string[]): ParseExpressionResult {
  if (text.length > MAX_EXPRESSION_LENGTH) {
    return {
      ok: false,
      code: 'too-long',
      message: `式が長すぎます（上限 ${MAX_EXPRESSION_LENGTH} 文字、いまは ${text.length} 文字）`,
      position: MAX_EXPRESSION_LENGTH,
    };
  }

  const lexed = tokenize(text);
  if (!lexed.ok) {
    return { ok: false, code: lexed.code, message: lexed.message, position: lexed.position };
  }

  return new Parser(lexed.tokens, knownColumns, text.length).parse();
}

/** 有限でない値は「計算できなかった」として null に寄せる。 */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * 0 から遠ざかる四捨五入（`round(x, n)` とノードの `precision` が共有する）。
 * `Math.round` は -0.5 を 0 側へ丸めるため、負数で対称にならない。
 */
export function roundAwayFromZero(value: number, digits: number): number | null {
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_ROUND_DIGITS) return null;
  const factor = 10 ** digits;
  const sign = value < 0 ? -1 : 1;
  const rounded = (Math.round(Math.abs(value) * factor) / factor) * sign;
  // -0 は表示でも比較でも紛らわしいので 0 に寄せる。
  return finite(rounded === 0 ? 0 : rounded);
}

function applyFunction(name: string, args: readonly number[]): number | null {
  const first = args[0];
  const second = args[1];
  if (first === undefined) {
    // 可変長は引数 0 個を受け付けないので、ここへ来るのは手組みの AST だけ。
    return null;
  }

  switch (name) {
    case 'abs':
      return Math.abs(first);
    case 'sign':
      return Math.sign(first);
    case 'sqrt':
      return Math.sqrt(first);
    case 'cbrt':
      return Math.cbrt(first);
    case 'pow':
      return second === undefined ? null : first ** second;
    case 'mod':
      return second === undefined ? null : first % second;
    case 'min':
      return Math.min(...args);
    case 'max':
      return Math.max(...args);
    case 'hypot':
      return second === undefined ? null : Math.hypot(first, second);
    case 'round':
      return roundAwayFromZero(first, second ?? 0);
    case 'floor':
      return Math.floor(first);
    case 'ceil':
      return Math.ceil(first);
    case 'trunc':
      return Math.trunc(first);
    case 'exp':
      return Math.exp(first);
    case 'ln':
      return Math.log(first);
    case 'log10':
      return Math.log10(first);
    case 'log2':
      return Math.log2(first);
    case 'log':
      return second === undefined ? null : Math.log(first) / Math.log(second);
    case 'sin':
      return Math.sin(first);
    case 'cos':
      return Math.cos(first);
    case 'tan':
      return Math.tan(first);
    case 'asin':
      return Math.asin(first);
    case 'acos':
      return Math.acos(first);
    case 'atan':
      return Math.atan(first);
    case 'atan2':
      return second === undefined ? null : Math.atan2(first, second);
    case 'sinh':
      return Math.sinh(first);
    case 'cosh':
      return Math.cosh(first);
    case 'tanh':
      return Math.tanh(first);
    case 'deg':
      return (first * 180) / Math.PI;
    case 'rad':
      return (first * Math.PI) / 180;
    default:
      return null;
  }
}

/**
 * 計算できなかった理由。
 *
 * 値としてはどれも null になるが、**利用者が直す先が違う**ので区別する。
 * 0 除算なら上流で分母 0 の行を除く、欠損なら null 処理を足す、定義域の外なら式を見直す、
 * という具合に次の一手が変わるため（`onError: 'fail'` の文言がこれを使う）。
 */
export type CalculateFailureReason =
  | 'missing-value'
  | 'divide-by-zero'
  | 'domain-error'
  | 'overflow'
  | 'invalid-argument';

export interface EvaluationOutcome {
  readonly value: number | null;
  /** `value` が null のときだけ入る。 */
  readonly reason?: CalculateFailureReason;
}

/** 最初に記録した理由を残す。評価は失敗で打ち切るので、最初のものが根本原因になる。 */
interface ReasonRecorder {
  reason?: CalculateFailureReason;
}

function record(recorder: ReasonRecorder, reason: CalculateFailureReason): null {
  recorder.reason ??= reason;
  return null;
}

/** 定義域を持つ関数。有限の引数から有限でない値が出たら「式が悪い」で、桁あふれではない。 */
const DOMAIN_SENSITIVE_FUNCTIONS: ReadonlySet<string> = new Set(['sqrt', 'ln', 'log10', 'log2', 'log', 'asin', 'acos']);

/** 有限でない結果に理由を付ける。演算子ごとに「0 で割った」のか「大きすぎた」のかが違う。 */
function classifyBinaryFailure(operator: string, left: number, right: number): CalculateFailureReason {
  if ((operator === '/' || operator === '%') && right === 0) return 'divide-by-zero';
  // 0 の負べきは 1/0 と同じこと。利用者にとっても「0 で割った」が正しい説明になる。
  if (operator === '^' && left === 0 && right < 0) return 'divide-by-zero';
  return 'overflow';
}

function classifyCallFailure(name: string, args: readonly number[]): CalculateFailureReason {
  const [first, second] = args;
  if (name === 'round' && second !== undefined && (!Number.isInteger(second) || second < 0 || second > MAX_ROUND_DIGITS)) {
    return 'invalid-argument';
  }
  if (name === 'mod' && second === 0) return 'divide-by-zero';
  if (name === 'pow' && first === 0 && second !== undefined && second < 0) return 'divide-by-zero';
  return DOMAIN_SENSITIVE_FUNCTIONS.has(name) ? 'domain-error' : 'overflow';
}

function evaluateNode(node: ExpressionNode, lookup: (column: string) => number | null, recorder: ReasonRecorder): number | null {
  // 手組みの AST を渡されても落ちないように形を確かめる（契約: 投げない）。
  if (node === null || typeof node !== 'object' || typeof node.kind !== 'string') return record(recorder, 'invalid-argument');

  switch (node.kind) {
    case 'number':
      return finite(node.value) ?? record(recorder, 'overflow');
    case 'column': {
      const value = lookup(node.name);
      if (value === null) return record(recorder, 'missing-value');
      return finite(value) ?? record(recorder, 'overflow');
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, lookup, recorder);
      if (operand === null) return null;
      return finite(node.operator === '-' ? -operand : operand) ?? record(recorder, 'overflow');
    }
    case 'binary': {
      const left = evaluateNode(node.left, lookup, recorder);
      if (left === null) return null;
      const right = evaluateNode(node.right, lookup, recorder);
      if (right === null) return null;
      const applied = applyBinary(node.operator, left, right);
      if (applied === undefined) return record(recorder, 'invalid-argument');
      return finite(applied) ?? record(recorder, classifyBinaryFailure(node.operator, left, right));
    }
    case 'call': {
      const args: number[] = [];
      for (const argument of node.args) {
        const value = evaluateNode(argument, lookup, recorder);
        if (value === null) return null;
        args.push(value);
      }
      const result = applyFunction(node.name, args);
      if (result === null) return record(recorder, classifyCallFailure(node.name, args));
      return finite(result) ?? record(recorder, classifyCallFailure(node.name, args));
    }
    default:
      return record(recorder, 'invalid-argument');
  }
}

/** 二項演算。知らない演算子は undefined（null は「計算した結果が非有限」と区別する）。 */
function applyBinary(operator: string, left: number, right: number): number | undefined {
  switch (operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return left / right;
    case '%': return left % right;
    case '^': return left ** right;
    default: return undefined;
  }
}

/**
 * 評価する。`lookup` は列名 → セル値（数値へ寄せ済み）。参照列が null なら結果は null。
 * 途中で有限でなくなった時点で null（0 除算・sqrt(-1) などを黙って別の数に化けさせない）。**投げない**。
 */
export function evaluateExpression(
  ast: ExpressionAst,
  lookup: (column: string) => number | null,
): number | null {
  return evaluateNode(ast as ExpressionNode, lookup, {});
}

/**
 * 値と、計算できなかった理由を返す。`onError: 'fail'` で「何を直せばよいか」を出すためのもの。
 * 値そのものは `evaluateExpression` と必ず一致する。
 */
export function evaluateExpressionDetailed(
  ast: ExpressionAst,
  lookup: (column: string) => number | null,
): EvaluationOutcome {
  const recorder: ReasonRecorder = {};
  const value = evaluateNode(ast as ExpressionNode, lookup, recorder);
  if (value !== null) return { value };
  return { value: null, ...(recorder.reason === undefined ? {} : { reason: recorder.reason }) };
}

import { describe, expect, it } from 'vitest';
import {
  CALCULATE_CONSTANTS,
  CALCULATE_FUNCTIONS,
  EXPRESSION_ERROR_CODES,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_TOKENS,
  evaluateExpression,
  nameDistance,
  parseExpression,
  suggestName,
  type ExpressionErrorCode,
} from './calculate-expression';

/** 式を評価する。cells のキーが knownColumns、値がセル値。 */
function value(text: string, cells: Readonly<Record<string, number | null>> = {}): number | null {
  const result = parseExpression(text, Object.keys(cells));
  expect(result.ok ? '' : `${result.message} (${result.position})`).toBe('');
  if (!result.ok) return null;
  return evaluateExpression(result.ast, (name) => cells[name] ?? null);
}

/** 読めないはずの式を読ませ、失敗の内容を返す。 */
function failure(text: string, columns: readonly string[] = []): { message: string; position: number } {
  const result = parseExpression(text, columns);
  expect(result.ok).toBe(false);
  return result.ok ? { message: '', position: -1 } : { message: result.message, position: result.position };
}

/** ちょうど n 個のトークンになる式（`1+1+...`、偶数なら先頭に単項マイナス）。 */
function expressionWithTokens(n: number): string {
  const oddCount = n % 2 === 1 ? n : n - 1;
  const terms = (oddCount + 1) / 2;
  const body = Array.from({ length: terms }, () => '1').join('+');
  return n % 2 === 1 ? body : `-${body}`;
}

describe('calculate-expression: 正典', () => {
  it('正常: 関数一覧は 4 群 30 個、名前は小文字で一意、arity は min<=max', () => {
    expect(CALCULATE_FUNCTIONS).toHaveLength(30);
    const names = CALCULATE_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    for (const fn of CALCULATE_FUNCTIONS) {
      expect(fn.name).toBe(fn.name.toLowerCase());
      expect(fn.arity.min).toBeGreaterThanOrEqual(1);
      if (fn.arity.max !== undefined) expect(fn.arity.max).toBeGreaterThanOrEqual(fn.arity.min);
    }
    // 群ごとにまとまって並ぶ（UI がこの順でボタンを出す）。
    expect(CALCULATE_FUNCTIONS.map((fn) => fn.group)).toEqual([
      ...Array.from({ length: 9 }, () => 'basic'),
      ...Array.from({ length: 4 }, () => 'rounding'),
      ...Array.from({ length: 5 }, () => 'exponential'),
      ...Array.from({ length: 12 }, () => 'trigonometric'),
    ]);
  });

  it('正常: 定数と上限値', () => {
    expect(CALCULATE_CONSTANTS).toEqual({ pi: Math.PI, e: Math.E });
    expect(MAX_EXPRESSION_LENGTH).toBe(1000);
    expect(MAX_EXPRESSION_DEPTH).toBe(64);
    expect(MAX_EXPRESSION_TOKENS).toBe(500);
  });
});

describe('calculate-expression: parse/evaluate 正常', () => {
  it('正常: 四則演算の優先順位と括弧', () => {
    expect(value('2+3*4')).toBe(14);
    expect(value('(2+3)*4')).toBe(20);
    expect(value('10-4-3')).toBe(3);
    expect(value('100/5/2')).toBe(10);
    expect(value('2+3*4-6/3')).toBe(12);
  });

  it('正常: ^ は右結合、単項マイナスは指数より先に束縛する', () => {
    expect(value('2^3^2')).toBe(512);
    expect(value('2^-1')).toBe(0.5);
    // 文法上 factor := unary ('^' factor)? なので -3 がまとまってから 2 乗される。
    expect(value('-3^2')).toBe(9);
  });

  it('正常: 単項の + と - を重ねられる', () => {
    expect(value('-5')).toBe(-5);
    expect(value('--5')).toBe(5);
    expect(value('+-5')).toBe(-5);
    expect(value('3*-2')).toBe(-6);
  });

  it('正常: [列名] は日本語・空白・記号を含む列名を参照する', () => {
    expect(value('[税抜 金額] * 1.1', { '税抜 金額': 1000 })).toBeCloseTo(1100, 10);
    expect(value('[金額] / [数量]', { 金額: 300, 数量: 4 })).toBe(75);
  });

  it('正常: 裸の識別子は knownColumns にあるときだけ列になる', () => {
    expect(value('amount * 2', { amount: 21 })).toBe(42);
    expect(value('[amount] + amount', { amount: 1 })).toBe(2);
  });

  it('正常: 定数 pi / e は大文字小文字を区別しない', () => {
    expect(value('pi')).toBe(Math.PI);
    expect(value('PI')).toBe(Math.PI);
    expect(value('E')).toBe(Math.E);
    expect(value('2*pi')).toBeCloseTo(Math.PI * 2, 12);
  });

  it('正常: 関数名は大文字小文字を区別しない', () => {
    expect(value('SQRT(9)')).toBe(3);
    expect(value('Abs(-4)')).toBe(4);
  });

  it('正常: 関数を入れ子にできる', () => {
    expect(value('sqrt(pow(3,2) + pow(4,2))')).toBe(5);
    expect(value('max(min(3, 5), abs(-2))')).toBe(3);
  });

  it('正常: 全角の数字・括弧・演算子と × ÷ を半角へ寄せて読む', () => {
    expect(value('１０÷２')).toBe(5);
    expect(value('（１＋２）×３')).toBe(9);
    expect(value('７％３')).toBe(1);
    expect(value('５−２')).toBe(3);
  });

  it('正常: 指数表記と先頭の小数点', () => {
    expect(value('1e3')).toBe(1000);
    expect(value('1E3')).toBe(1000);
    expect(value('.5')).toBe(0.5);
    expect(value('1.5e-2')).toBeCloseTo(0.015, 12);
    expect(value('2e+2')).toBe(200);
  });

  it('正常: references は参照した列名を重複なし・出現順で返す', () => {
    const result = parseExpression('[金額] * 2 + [数量] - [金額]', ['金額', '数量']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toEqual(['金額', '数量']);
  });

  it('正常: 列を参照しない式の references は空', () => {
    const result = parseExpression('1 + 2', ['金額']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toEqual([]);
  });

  it('正常: % は剰余', () => {
    expect(value('7 % 3')).toBe(1);
    expect(value('7.5 % 2')).toBe(1.5);
    expect(value('mod(7, 3)')).toBe(1);
  });

  it('正常: basic 群', () => {
    expect(value('abs(-3)')).toBe(3);
    expect(value('sign(-3)')).toBe(-1);
    expect(value('sqrt(16)')).toBe(4);
    expect(value('cbrt(27)')).toBe(3);
    expect(value('pow(2, 10)')).toBe(1024);
    expect(value('min(3, 1, 2)')).toBe(1);
    expect(value('max(3, 1, 2)')).toBe(3);
    expect(value('hypot(3, 4)')).toBe(5);
  });

  it('正常: rounding 群（round は 0 から遠ざかる四捨五入）', () => {
    expect(value('round(2.5)')).toBe(3);
    expect(value('round(-2.5)')).toBe(-3);
    expect(value('round(3.14159, 2)')).toBe(3.14);
    expect(value('floor(-1.2)')).toBe(-2);
    expect(value('ceil(1.2)')).toBe(2);
    expect(value('trunc(-1.8)')).toBe(-1);
  });

  it('正常: exponential 群', () => {
    expect(value('exp(0)')).toBe(1);
    expect(value('ln(e)')).toBe(1);
    expect(value('log10(1000)')).toBe(3);
    expect(value('log2(8)')).toBe(3);
    expect(value('log(81, 3)')).toBeCloseTo(4, 12);
  });

  it('正常: trigonometric 群（ラジアン）と度の変換', () => {
    expect(value('sin(0)')).toBe(0);
    expect(value('cos(0)')).toBe(1);
    expect(value('tan(0)')).toBe(0);
    expect(value('asin(1)')).toBeCloseTo(Math.PI / 2, 12);
    expect(value('acos(1)')).toBe(0);
    expect(value('atan(1)')).toBeCloseTo(Math.PI / 4, 12);
    expect(value('atan2(1, 1)')).toBeCloseTo(Math.PI / 4, 12);
    expect(value('sinh(0)')).toBe(0);
    expect(value('cosh(0)')).toBe(1);
    expect(value('tanh(0)')).toBe(0);
    expect(value('deg(pi)')).toBeCloseTo(180, 10);
    expect(value('sin(rad(30))')).toBeCloseTo(0.5, 12);
  });

  it('正常: 空白（全角空白・改行・タブ）は無視する', () => {
    expect(value('  1 +\t2\n* 3  ')).toBe(7);
    expect(value('1　+　2')).toBe(3);
  });
});

describe('calculate-expression: parse 異常', () => {
  it('異常: 知らない関数', () => {
    const { message, position } = failure('foo(1)');
    expect(message).toContain('知らない関数');
    expect(position).toBe(0);
  });

  it('異常: 知らない裸の識別子（入力に列が無い）', () => {
    const { message, position } = failure('1 + kingaku', ['金額']);
    expect(message).toContain('知らない名前');
    expect(position).toBe(4);
  });

  it('異常: 関数名と同じ裸の識別子は列にならない（[..] で書く）', () => {
    expect(failure('sqrt * 2', ['sqrt']).message).toContain('sqrt(...)');
    expect(value('[sqrt] * 2', { sqrt: 3 })).toBe(6);
  });

  it('異常: 引数の数が合わない', () => {
    expect(failure('pow(1)').message).toContain('2 個');
    expect(failure('abs(1, 2)').message).toContain('1 個');
    expect(failure('min()').message).toContain('1 個以上');
    expect(failure('sqrt()').position).toBe(0);
  });

  it('異常: 閉じ括弧が足りない', () => {
    const { message, position } = failure('(1+2');
    expect(message).toContain('閉じ括弧');
    expect(position).toBe(4);
  });

  it('異常: 閉じ括弧が多い', () => {
    const { message, position } = failure('(1+2))');
    expect(message).toContain('余分');
    expect(position).toBe(5);
  });

  it('異常: 演算子が連続する', () => {
    expect(failure('1 * / 2').position).toBe(4);
    expect(failure('1 + * 2').message).toContain('演算子');
    expect(failure('2 ^').message).toContain('途中で終わって');
  });

  it('異常: 空の式・空白だけの式', () => {
    expect(failure('').message).toContain('式が空です');
    expect(failure('   ').position).toBe(0);
  });

  it('異常: [ を閉じ忘れる / 列名が空 / 孤立した ]', () => {
    expect(failure('[金額').message).toContain('] がありません');
    expect(failure('[金額').position).toBe(0);
    expect(failure('[] + 1').message).toContain('列名が空');
    expect(failure('1 + ]').message).toContain('[ がありません');
  });

  it('異常: 比較・条件・文字列は受け付けない', () => {
    expect(failure('[a] > 1', ['a']).message).toContain('使えない文字');
    expect(failure('[a] = 1', ['a']).message).toContain('使えない文字');
    expect(failure("'abc'").position).toBe(0);
  });

  it('異常: 引数の区切りを式の外で使う', () => {
    expect(failure('1, 2').message).toContain('余分');
    expect(failure(', 1').position).toBe(0);
  });

  it('異常: 小数点のあとに数字がない', () => {
    const { message, position } = failure('1. + 2');
    expect(message).toContain('小数点');
    expect(position).toBe(1);
  });

  it('異常: 失敗は必ず 0 起点の position を持ち、投げない', () => {
    for (const text of ['', 'foo(', '1 +', '[a', '@']) {
      const result = parseExpression(text, []);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(Number.isInteger(result.position)).toBe(true);
      expect(result.position).toBeGreaterThanOrEqual(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('calculate-expression: 境界', () => {
  it('境界: MAX_EXPRESSION_LENGTH ちょうどは読めて、+1 は読めない', () => {
    const justFits = `1${' '.repeat(MAX_EXPRESSION_LENGTH - 1)}`;
    expect(justFits).toHaveLength(MAX_EXPRESSION_LENGTH);
    expect(value(justFits)).toBe(1);

    const tooLong = `1${' '.repeat(MAX_EXPRESSION_LENGTH)}`;
    const result = parseExpression(tooLong, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('長すぎます');
    expect(result.position).toBe(MAX_EXPRESSION_LENGTH);
  });

  it('境界: 括弧の入れ子は MAX_EXPRESSION_DEPTH ちょうどまで', () => {
    const atLimit = `${'('.repeat(MAX_EXPRESSION_DEPTH)}1${')'.repeat(MAX_EXPRESSION_DEPTH)}`;
    expect(value(atLimit)).toBe(1);

    const overLimit = `${'('.repeat(MAX_EXPRESSION_DEPTH + 1)}1${')'.repeat(MAX_EXPRESSION_DEPTH + 1)}`;
    expect(failure(overLimit).message).toContain('入れ子が深すぎます');
  });

  it('境界: 関数呼び出しの入れ子も MAX_EXPRESSION_DEPTH ちょうどまで', () => {
    const atLimit = `${'abs('.repeat(MAX_EXPRESSION_DEPTH)}-1${')'.repeat(MAX_EXPRESSION_DEPTH)}`;
    expect(value(atLimit)).toBe(1);

    const overLimit = `${'abs('.repeat(MAX_EXPRESSION_DEPTH + 1)}-1${')'.repeat(MAX_EXPRESSION_DEPTH + 1)}`;
    expect(failure(overLimit).message).toContain('入れ子が深すぎます');
  });

  it('境界: MAX_EXPRESSION_TOKENS ちょうどは読めて、+1 は読めない', () => {
    // `-1+1+...+1`（1 が 250 個）→ -1 + 249 = 248。
    expect(value(expressionWithTokens(MAX_EXPRESSION_TOKENS))).toBe(MAX_EXPRESSION_TOKENS / 2 - 2);

    const { message, position } = failure(expressionWithTokens(MAX_EXPRESSION_TOKENS + 1));
    expect(message).toContain('要素が多すぎます');
    expect(position).toBeGreaterThan(0);
  });

  it('境界: round の小数桁は 0 と 15 まで。16 は評価できない', () => {
    expect(value('round(2.5, 0)')).toBe(3);
    expect(value('round(0.5, 15)')).toBe(0.5);
    expect(value('round(1.0000000000000002, 15)')).toBe(1);
    expect(value('round(2.5, 16)')).toBeNull();
    expect(value('round(2.5, -1)')).toBeNull();
  });

  it('境界: 可変長関数の引数 1 個', () => {
    expect(value('min(1)')).toBe(1);
    expect(value('max(-1)')).toBe(-1);
  });
});

describe('calculate-expression: 例外', () => {
  it('例外: 0 除算は null', () => {
    expect(value('1/0')).toBeNull();
    expect(value('[a]/[b]', { a: 1, b: 0 })).toBeNull();
    expect(value('7 % 0')).toBeNull();
  });

  it('例外: 定義域の外は null', () => {
    expect(value('sqrt(-1)')).toBeNull();
    expect(value('ln(0)')).toBeNull();
    expect(value('ln(-1)')).toBeNull();
    expect(value('0^-1')).toBeNull();
    expect(value('asin(2)')).toBeNull();
  });

  it('例外: 途中で有限でなくなったら null（後段で有限に戻らない）', () => {
    expect(value('exp(ln(0))')).toBeNull();
    expect(value('1e308 * 10')).toBeNull();
  });

  it('例外: 参照列が null なら結果も null', () => {
    expect(value('[a] + 1', { a: null })).toBeNull();
    expect(value('min([a], 1)', { a: null })).toBeNull();
    expect(value('[a] * 0', { a: null })).toBeNull();
  });

  it('例外: % の符号は左辺に従う（JavaScript と同じ規則）', () => {
    expect(value('-7 % 3')).toBe(-1);
    expect(value('7 % -3')).toBe(1);
    expect(value('mod(-7, 3)')).toBe(-1);
  });

  it('例外: evaluateExpression は壊れた AST でも投げずに null', () => {
    expect(evaluateExpression(undefined, () => 1)).toBeNull();
    expect(evaluateExpression({ kind: 'nope' }, () => 1)).toBeNull();
    expect(evaluateExpression({ kind: 'call', name: 'nope', args: [] }, () => 1)).toBeNull();
    expect(evaluateExpression('1 + 1', () => 1)).toBeNull();
  });

  it('例外: 同じ AST は何度評価しても副作用を持たない', () => {
    const result = parseExpression('[a] * 2', ['a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(evaluateExpression(result.ast, () => 3)).toBe(6);
    expect(evaluateExpression(result.ast, () => null)).toBeNull();
    expect(evaluateExpression(result.ast, () => 3)).toBe(6);
  });
});

/**
 * 失敗の種別（v40 実装契約 §2）。
 *
 * 文言は利用者に合わせて改訂されるが、種別は LLM への差し戻しと画面の案内が分岐に使うので変わらない。
 * ここでは「21 種別それぞれに、それを出す式がある」ことを網羅の表として固定する。
 */
const CODE_SAMPLES: Readonly<
  Record<ExpressionErrorCode, { readonly text: string; readonly columns?: readonly string[] } | null>
> = {
  empty: { text: '   ' },
  'too-long': { text: '1'.repeat(MAX_EXPRESSION_LENGTH + 1) },
  'too-many-tokens': { text: expressionWithTokens(MAX_EXPRESSION_TOKENS + 1) },
  'too-deep': {
    text: `${'('.repeat(MAX_EXPRESSION_DEPTH + 1)}1${')'.repeat(MAX_EXPRESSION_DEPTH + 1)}`,
  },
  'illegal-character': { text: '1 & 2' },
  'invalid-number': { text: '1. + 2' },
  'unclosed-bracket': { text: '[金額' },
  'unexpected-bracket': { text: '1 + ]' },
  'empty-column-name': { text: '[] + 1' },
  'unknown-function': { text: 'sqr(4)' },
  'function-needs-parens': { text: 'sqrt * 2' },
  'unknown-name': { text: 'kingaku * 2' },
  'wrong-argument-count': { text: 'pow(1)' },
  'missing-argument': { text: 'max(1,)' },
  'misplaced-comma': { text: 'max(,1)' },
  'unclosed-paren': { text: '(1 + 2' },
  'unexpected-paren': { text: ') + 1' },
  'missing-operand': { text: '1 + * 2' },
  'unexpected-end': { text: '2 ^' },
  'trailing-input': { text: '1 2' },
  // 保険。どの式からも出ない（出たら分類の漏れなので、下の「例外」で見張る）。
  unreadable: null,
};

/** 失敗の種別を返す。読めてしまったらここで落とす。 */
function code(text: string, columns: readonly string[] = []): ExpressionErrorCode | undefined {
  const result = parseExpression(text, columns);
  expect(result.ok ? `読めてしまった: ${text}` : '').toBe('');
  return result.ok ? undefined : result.code;
}

/** 候補を返す。読めてしまったらここで落とす。 */
function suggestion(text: string, columns: readonly string[] = []): string | undefined {
  const result = parseExpression(text, columns);
  expect(result.ok ? `読めてしまった: ${text}` : '').toBe('');
  return result.ok ? undefined : result.suggestion;
}

describe('calculate-expression: 失敗の種別', () => {
  it('正常: EXPRESSION_ERROR_CODES は 21 種で重複がない', () => {
    expect(EXPRESSION_ERROR_CODES).toHaveLength(21);
    expect(new Set(EXPRESSION_ERROR_CODES).size).toBe(EXPRESSION_ERROR_CODES.length);
  });

  it('正常: 網羅の表は全種別を 1 つずつ挙げている（種別を足したら表にも足す）', () => {
    expect(Object.keys(CODE_SAMPLES).sort()).toEqual([...EXPRESSION_ERROR_CODES].sort());
  });

  it('異常: 表の式はそれぞれの種別で断られる', () => {
    for (const [expected, sample] of Object.entries(CODE_SAMPLES)) {
      if (sample === null) continue;
      expect(`${expected}: ${code(sample.text, sample.columns ?? [])}`).toBe(`${expected}: ${expected}`);
    }
  });

  it('異常: 失敗はどれも種別・文言・0 起点の位置を持つ', () => {
    for (const sample of Object.values(CODE_SAMPLES)) {
      if (sample === null) continue;
      const result = parseExpression(sample.text, sample.columns ?? []);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(EXPRESSION_ERROR_CODES).toContain(result.code);
      expect(result.message.length).toBeGreaterThan(0);
      expect(Number.isInteger(result.position) && result.position >= 0).toBe(true);
    }
  });

  it('例外: 保険の unreadable はどの打ち間違いからも出ない（すべて原因を言い当てている）', () => {
    // 到達不能なはずの分類（「式を読めません」）に落ちるのは、分類の漏れそのもの。
    const samples = [
      '', '   ', '=1', '1..2', '2 x 3', '(1', '1)', '[a', ']', '[]', 'max(1,)', 'max(,1)', '1000円',
      '10%', '**', '^2', '1,234', 'SUM([a])', 'sqrt', 'pow(1)', '1 + ', 'abs(1))', '((1)', 'e.5',
      '[a][b]', '2(3+4)', '1 @ 2', 'あ', 'min()', 'round(1,)', '.', '..', '+', '1+', 'a b c',
    ];
    for (const text of samples) {
      const result = parseExpression(text, ['a', 'b']);
      if (result.ok) continue;
      expect(`${text}: ${result.code}`).not.toBe(`${text}: unreadable`);
    }
  });
});

describe('calculate-expression: 打ち間違いの候補', () => {
  it('正常: 知らない関数には近い候補が付く', () => {
    expect(suggestion('sqr(4)')).toBe('sqrt');
    expect(suggestion('lgo10(100)')).toBe('log10');
    expect(suggestion('flor(1.5)')).toBe('floor');
  });

  it('正常: 知らない名前の候補は列を優先する（同じ距離なら列側）', () => {
    // 列 `mid` と関数 `min` はどちらも距離 1。裸の識別子は列のつもりで打つことが多い。
    expect(suggestion('mim * 2', ['mid'])).toBe('mid');
    // 列に近いものが無ければ関数・定数からも出す。
    expect(suggestion('mim * 2', [])).toBe('min');
    expect(suggestion('p1 * 2', [])).toBe('pi');
    // 大文字小文字だけ違う列名は、綴りとして正しい候補になる。
    expect(suggestion('Amount * 2', ['amount'])).toBe('amount');
  });

  it('境界: しきい値は入力の長さで変わる（4 文字以下は距離 1、5 文字以上は距離 2）', () => {
    expect(nameDistance('ab', 'abs')).toBe(1);
    expect(suggestName('ab', ['abs'])).toBe('abs');
    expect(nameDistance('xyz', 'abs')).toBe(3);
    expect(suggestName('xyz', ['abs'])).toBeUndefined();

    expect(nameDistance('tazz', 'tanh')).toBe(2);
    expect(suggestName('tazz', ['tanh'])).toBeUndefined();
    expect(nameDistance('taner', 'tanh')).toBe(2);
    expect(suggestName('taner', ['tanh'])).toBe('tanh');
  });

  it('異常: 遠すぎる打ち間違いには候補を付けない（見当違いの候補は害）', () => {
    // 表計算ソフトの関数名はどれも近くない。中途半端な候補を出すより黙るほうがよい。
    expect(suggestion('SUM([金額])', ['金額'])).toBeUndefined();
    expect(suggestion('VLOOKUP(1)')).toBeUndefined();
    expect(suggestion('COUNTIF(1)')).toBeUndefined();
    // 契約の例（列 `金額` と関数 `min` に対する `kingaku`）はどちらからも遠いので候補は出ない。
    expect(suggestion('1 + kingaku', ['金額'])).toBeUndefined();
    expect(suggestName('kingaku', ['金額', 'min'])).toBeUndefined();
  });

  it('例外: nameDistance は入れ替え 1 回を距離 1 と数え、左右を入れ替えても同じ', () => {
    expect(nameDistance('abs', 'abs')).toBe(0);
    expect(nameDistance('sqrt', 'sqtr')).toBe(1);
    expect(nameDistance('', 'abs')).toBe(3);
    expect(nameDistance('abs', '')).toBe(3);
    expect(nameDistance('log10', 'lgo10')).toBe(nameDistance('lgo10', 'log10'));
  });

  it('例外: suggestName は候補が空でも投げず、同じ距離なら candidates の順で決まる', () => {
    expect(suggestName('abs', [])).toBeUndefined();
    expect(suggestName('', ['abs'])).toBeUndefined();
    expect(suggestName('ab', ['abs', 'abc'])).toBe('abs');
    expect(suggestName('ab', ['abc', 'abs'])).toBe('abc');
    // 何度呼んでも同じ（順序の定まらない集合を使っていない）。
    expect(suggestName('ab', ['abc', 'abs'])).toBe('abc');
  });
});

describe('calculate-expression: 文言と位置の固定', () => {
  // 種別を足したときに文言や位置を動かすと、UI の案内と保存済みの期待が同時に壊れる。
  it('例外: 代表的な失敗の message / position は v39 から変わっていない', () => {
    const expected: readonly (readonly [string, readonly string[], string, number])[] = [
      ['', [], '式が空です', 0],
      ['1 + sqr(4)', [], '知らない関数です: sqr', 4],
      ['1 + kingaku', ['金額'], '知らない名前です: kingaku。列は [kingaku] の形で書きます', 4],
      ['sqrt * 2', ['sqrt'], '関数 sqrt は sqrt(...) の形で書きます', 0],
      ['pow(1)', [], '関数 pow の引数は 2 個です（1 個でした）', 0],
      ['max(1,)', [], '関数 max の , のあとに引数がありません', 5],
      ['max(,1)', [], ', はここでは使えません', 4],
      ['(1+2', [], '閉じ括弧 ) がありません', 4],
      ['(1+2))', [], '余分な入力があります: )', 5],
      ['1 + * 2', [], '演算子 * の右に数値がありません', 4],
      ['2 ^', [], '式が途中で終わっています', 3],
      ['[金額', [], '列参照の ] がありません', 0],
      ['1 + ]', [], '対応する [ がありません', 4],
      ['[] + 1', [], '列名が空です', 0],
      ['1. + 2', [], '小数点のあとに数字がありません', 1],
      ['1 & 2', [], '式では使えない文字です: &', 2],
    ];
    for (const [text, columns, message, position] of expected) {
      const result = parseExpression(text, columns);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(`${text} → ${result.message} @${result.position}`).toBe(`${text} → ${message} @${position}`);
    }
  });
});

/**
 * 式のパターン試験 — 実際に書かれそうな複雑な式を通しで確かめる。
 *
 * 単体の文法・関数ごとの確認は `calculate-expression.test.ts` が持つ。ここで見るのは
 * **組み合わさったときに崩れないか**:
 * - 三角関数を入れ子にして角度変換や合成をする式
 * - 深く括弧を重ねた式、括弧の位置で答えが変わる式
 * - 優先順位・結合の規則が複数同時に効く式
 * - 実務で書かれそうな式（税込計算・距離・伸び率・正規化）
 *
 * 期待値は手計算またはよく知られた恒等式で確かめられるものだけを使う。
 * 浮動小数の誤差があるので、割り切れない値は `toBeCloseTo` で比べる。
 */
import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseExpression } from './calculate-expression';

/** 式を評価する。cells のキーが knownColumns、値がセル値。読めない式はここで落とす。 */
function value(text: string, cells: Readonly<Record<string, number | null>> = {}): number | null {
  const result = parseExpression(text, Object.keys(cells));
  expect(result.ok ? '' : `${result.message} (${result.position})`).toBe('');
  if (!result.ok) return null;
  return evaluateExpression(result.ast, (name) => cells[name] ?? null);
}

describe('式のパターン: 三角関数の組み合わせ', () => {
  it('正常: sin^2 + cos^2 = 1 が任意の角度で成り立つ', () => {
    // ^ は右結合かつ単項より弱いので、二乗は関数呼び出しの外へ書く必要がある。
    for (const degrees of [0, 30, 45, 60, 90, 123.456, -270]) {
      expect(value(`sin(rad([d]))^2 + cos(rad([d]))^2`, { d: degrees })).toBeCloseTo(1, 12);
    }
  });

  it('正常: tan(x) は sin(x) / cos(x) と一致する', () => {
    expect(value('tan(rad(30)) - sin(rad(30)) / cos(rad(30))')).toBeCloseTo(0, 12);
  });

  it('正常: 加法定理 sin(a+b) = sin a cos b + cos a sin b', () => {
    const left = value('sin(rad([a]) + rad([b]))', { a: 35, b: 25 });
    const right = value('sin(rad([a])) * cos(rad([b])) + cos(rad([a])) * sin(rad([b]))', { a: 35, b: 25 });
    expect(left).toBeCloseTo(right as number, 12);
    // 35 + 25 = 60 度なので √3/2。
    expect(left).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });

  it('正常: 逆関数との往復（asin(sin(x)) と deg(rad(x))）', () => {
    expect(value('deg(asin(sin(rad(37))))')).toBeCloseTo(37, 10);
    expect(value('deg(rad([d]))', { d: 123.5 })).toBeCloseTo(123.5, 10);
    // atan2 は象限を保つ。第 2 象限（-1, 1）は 135 度。
    expect(value('deg(atan2(1, -1))')).toBeCloseTo(135, 10);
  });

  it('正常: 双曲線関数の恒等式 cosh^2 - sinh^2 = 1', () => {
    expect(value('cosh([x])^2 - sinh([x])^2', { x: 1.25 })).toBeCloseTo(1, 10);
    expect(value('tanh([x]) - sinh([x]) / cosh([x])', { x: 1.25 })).toBeCloseTo(0, 12);
  });

  it('正常: 三角関数を 4 段入れ子にしても壊れない', () => {
    expect(value('sin(cos(tan(atan(0.5))))')).toBeCloseTo(Math.sin(Math.cos(0.5)), 12);
  });

  it('境界: sin(pi) は厳密には 0 にならない（浮動小数の実際の姿）', () => {
    // 0 と比較するテストを書くと落ちる。式エディタの利用者が踏む落とし穴なので明示的に固定する。
    const result = value('sin(pi)') as number;
    expect(result).not.toBe(0);
    expect(Math.abs(result)).toBeLessThan(1e-15);
    // 丸めれば 0 になる。
    expect(value('round(sin(pi), 10)')).toBe(0);
  });

  it('例外: tan(pi/2) は無限大にならず、有限の大きな値になる（定義どおり落ちない）', () => {
    // 数学上は発散だが、pi/2 が厳密に表せないため計算は有限。null ではないことを固定する。
    const result = value('tan(pi / 2)') as number;
    expect(Number.isFinite(result)).toBe(true);
    expect(Math.abs(result)).toBeGreaterThan(1e15);
  });

  it('異常: 定義域の外の逆三角関数は null', () => {
    expect(value('asin(1.5)')).toBeNull();
    expect(value('acos(-2)')).toBeNull();
    // 入れ子の内側で null になれば、外側も null（黙って別の数に化けない）。
    expect(value('deg(asin(2)) + 1')).toBeNull();
  });
});

describe('式のパターン: 括弧と優先順位', () => {
  it('正常: 括弧の位置で答えが変わる', () => {
    expect(value('2 + 3 * 4')).toBe(14);
    expect(value('(2 + 3) * 4')).toBe(20);
    expect(value('100 / (2 * 5)')).toBe(10);
    expect(value('100 / 2 * 5')).toBe(250);
  });

  it('正常: 括弧を 8 段重ねても内側から順に評価する', () => {
    expect(value('((((((((1 + 1)))))))) * 3')).toBe(6);
    expect(value('(1 + (2 * (3 + (4 * (5 + (6 * (7 + (8))))))))')).toBe(1 + 2 * (3 + 4 * (5 + 6 * (7 + 8))));
  });

  it('正常: 冗長な括弧は答えを変えない', () => {
    expect(value('((2)) + ((3)) * ((4))')).toBe(14);
    expect(value('-((-((3))))')).toBe(3);
  });

  it('正常: 優先順位・結合・単項が同時に効く式', () => {
    // ^ は右結合: 2^3^2 = 2^9 = 512
    expect(value('2 ^ 3 ^ 2')).toBe(512);
    expect(value('(2 ^ 3) ^ 2')).toBe(64);
    // 単項マイナスは ^ より先に束縛する（表計算ソフトと同じ）。
    expect(value('-3 ^ 2')).toBe(9);
    expect(value('-(3 ^ 2)')).toBe(-9);
    // 剰余は乗除と同じ強さで左から。
    expect(value('10 % 4 * 2')).toBe(4);
    expect(value('10 % (4 * 2)')).toBe(2);
    expect(value('2 + 10 % 4 - 1')).toBe(3);
  });

  it('正常: 関数の引数の中に式と括弧を入れられる', () => {
    expect(value('max((1 + 2) * 3, 2 ^ 3, hypot(3, 4))')).toBe(9);
    expect(value('round((1 + 2) / 3 + pow(2, 3), 2)')).toBe(9);
    expect(value('min(abs(-5), max(1, 2, 3), 10)')).toBe(3);
  });

  it('境界: 関数の引数区切りと括弧が入り混じっても取り違えない', () => {
    expect(value('atan2((1 + 1), (3 - 1))')).toBeCloseTo(Math.PI / 4, 12);
    expect(value('log(pow(2, 10), 2)')).toBeCloseTo(10, 12);
    expect(value('hypot(hypot(3, 4), 12)')).toBe(13);
  });

  it('異常: 括弧の対応が崩れた式は読めない', () => {
    for (const text of ['(1 + 2', '1 + 2)', '((1 + 2)', 'sin(1', 'max(1, 2']) {
      expect(parseExpression(text, []).ok).toBe(false);
    }
  });
});

describe('式のパターン: 実務で書かれそうな式', () => {
  const row = { 金額: 1200, 数量: 8, 前年: 950, 税率: 10 };

  it('正常: 税込金額を丸めて出す', () => {
    expect(value('round([金額] * (1 + [税率] / 100), 0)', row)).toBe(1320);
  });

  it('正常: 単価と伸び率', () => {
    expect(value('[金額] / [数量]', row)).toBe(150);
    expect(value('round(([金額] - [前年]) / [前年] * 100, 1)', row)).toBe(26.3);
  });

  it('正常: 2 点間の距離と対数変換', () => {
    expect(value('sqrt(([x2] - [x1]) ^ 2 + ([y2] - [y1]) ^ 2)', { x1: 1, y1: 2, x2: 4, y2: 6 })).toBe(5);
    expect(value('log10([金額]) - log10([前年])', row)).toBeCloseTo(Math.log10(1200 / 950), 12);
  });

  it('境界: 0〜1 へ正規化する式で、最小値と最大値がちょうど 0 と 1 になる', () => {
    const normalize = '([v] - [min]) / ([max] - [min])';
    expect(value(normalize, { v: 10, min: 10, max: 50 })).toBe(0);
    expect(value(normalize, { v: 50, min: 10, max: 50 })).toBe(1);
    expect(value(normalize, { v: 30, min: 10, max: 50 })).toBe(0.5);
  });

  it('例外: 正規化の分母が 0（全行が同じ値）なら null になり、行は落ちない', () => {
    expect(value('([v] - [min]) / ([max] - [min])', { v: 10, min: 10, max: 10 })).toBeNull();
  });

  it('例外: 途中に空の列が混ざると、式全体が null になる', () => {
    expect(value('[金額] / [数量] + [欠損]', { ...row, 欠損: null })).toBeNull();
    // 欠損が掛け算の 0 側にあっても、黙って 0 扱いにはしない。
    expect(value('[金額] * [欠損]', { 金額: 1200, 欠損: null })).toBeNull();
  });
});

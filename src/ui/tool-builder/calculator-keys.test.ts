/**
 * calculator-keys.ts のテスト。
 *
 * - ピン留め: domain の正典（CALCULATE_FUNCTIONS / CALCULATE_CONSTANTS）との一致を固定する
 *   （filter の FILTER_OPS と同じ規律）。domain 担当がまだ calculate-expression.ts を書き終えて
 *   いない間はこのテストだけ赤になり得る。
 * - それ以外: parenthesisBalance / displayExpression / insertAt という純関数の振る舞いを固定する。
 */
import { describe, expect, it } from 'vitest';
// domain の正典。UIソースからは import しない方針だが、テストからのピン留め import は可。
import { CALCULATE_CONSTANTS, CALCULATE_FUNCTIONS } from '../../domain/etl/nodes/calculate-expression';
import {
  CALCULATOR_CONSTANT_KEYS,
  CALCULATOR_FUNCTION_KEYS,
  CALCULATOR_GROUP_LABELS,
  CALCULATOR_OPERATOR_KEYS,
  displayExpression,
  insertAt,
  parenthesisBalance,
} from './calculator-keys';

describe('calculator-keys: domainとのピン留め', () => {
  it('正常: 関数一覧の name / group / 引数数 / 並びが domain の CALCULATE_FUNCTIONS と一致する', () => {
    expect(CALCULATOR_FUNCTION_KEYS.map((key) => key.name)).toEqual(CALCULATE_FUNCTIONS.map((fn) => fn.name));
    expect(CALCULATOR_FUNCTION_KEYS.map((key) => key.group)).toEqual(CALCULATE_FUNCTIONS.map((fn) => fn.group));
    expect(CALCULATOR_FUNCTION_KEYS.map((key) => key.minArgs)).toEqual(CALCULATE_FUNCTIONS.map((fn) => fn.arity.min));
    expect(CALCULATOR_FUNCTION_KEYS.map((key) => key.maxArgs)).toEqual(CALCULATE_FUNCTIONS.map((fn) => fn.arity.max));
  });

  it('正常: 定数一覧が domain の CALCULATE_CONSTANTS と一致する', () => {
    expect(CALCULATOR_CONSTANT_KEYS.map((key) => key.name)).toEqual(Object.keys(CALCULATE_CONSTANTS));
    for (const key of CALCULATOR_CONSTANT_KEYS) {
      expect(CALCULATE_CONSTANTS[key.name]).toBeTypeOf('number');
    }
  });

  it('境界: 4つの関数群すべてに表示ラベル（en/ja）がある', () => {
    const groups = new Set(CALCULATOR_FUNCTION_KEYS.map((key) => key.group));
    for (const group of groups) {
      expect(CALCULATOR_GROUP_LABELS[group].en.length).toBeGreaterThan(0);
      expect(CALCULATOR_GROUP_LABELS[group].ja.length).toBeGreaterThan(0);
    }
  });
});

describe('calculator-keys: parenthesisBalance', () => {
  it('正常: 対応が取れた括弧は balanced=true / open=0', () => {
    expect(parenthesisBalance('(1+2)*(3-4)')).toEqual({ balanced: true, open: 0 });
    expect(parenthesisBalance('sqrt((1+2)*3)')).toEqual({ balanced: true, open: 0 });
    expect(parenthesisBalance('')).toEqual({ balanced: true, open: 0 });
  });

  it('境界: 開きだけ・閉じだけの式では過不足の個数を符号で返す', () => {
    expect(parenthesisBalance('((1+2)')).toEqual({ balanced: false, open: 1 });
    expect(parenthesisBalance('(1+2))')).toEqual({ balanced: false, open: -1 });
    expect(parenthesisBalance('((( ')).toEqual({ balanced: false, open: 3 });
  });

  it('例外: [..] の中の括弧は数えない（列名に括弧を含められる）', () => {
    // 列名 "単価 (税込)" を [] で参照しても、中の丸括弧は式の構造とは無関係。
    expect(parenthesisBalance('[単価 (税込)]')).toEqual({ balanced: true, open: 0 });
    // 外側の丸括弧は数え、[] の中は無視する。
    expect(parenthesisBalance('([単価 (税込)])')).toEqual({ balanced: true, open: 0 });
    expect(parenthesisBalance('([単価 (税込)]')).toEqual({ balanced: false, open: 1 });
  });
});

describe('calculator-keys: displayExpression', () => {
  it('正常: * を ×、/ を ÷ に変えて表示する', () => {
    expect(displayExpression('1*2+3/4')).toBe('1×2+3÷4');
  });

  it('例外: 保存値（渡した文字列）は変えない。往復（2回適用）しても同じ結果になる', () => {
    const saved = '7*[amount]/2';
    const displayed = displayExpression(saved);
    // 元の文字列（保存される値）はイミュータブルなJS文字列なので、呼んでも変化しない。
    expect(saved).toBe('7*[amount]/2');
    // 表示用の変換は * / だけを見るので、既に変換済みの文字列へ再度適用しても壊れない（冪等）。
    expect(displayExpression(displayed)).toBe(displayed);
  });

  it('境界: -（半角ハイフン）は変換しない（式に書く記号のまま表示する）', () => {
    expect(displayExpression('3-1')).toBe('3-1');
  });
});

describe('calculator-keys: insertAt', () => {
  it('正常: カーソル位置に文字列を挿入し、挿入後のカーソル位置を返す', () => {
    expect(insertAt('12', 1, 'x')).toEqual({ expression: '1x2', caret: 2 });
  });

  it('境界: 先頭（0）と末尾（length）への挿入', () => {
    expect(insertAt('12', 0, 'x')).toEqual({ expression: 'x12', caret: 1 });
    expect(insertAt('12', 2, 'x')).toEqual({ expression: '12x', caret: 3 });
  });

  it('異常: 範囲外のカーソル位置は文字列の範囲内へ丸める', () => {
    expect(insertAt('12', -5, 'x')).toEqual({ expression: 'x12', caret: 1 });
    expect(insertAt('12', 99, 'x')).toEqual({ expression: '12x', caret: 3 });
  });
});

describe('calculator-keys: CALCULATOR_OPERATOR_KEYS', () => {
  it('正常: 表示記号と式へ書く記号が × → * / ÷ → / / − → - になっている', () => {
    const map = Object.fromEntries(CALCULATOR_OPERATOR_KEYS.map((key) => [key.glyph, key.insert]));
    expect(map).toEqual({ '×': '*', '÷': '/', '−': '-' });
  });
});

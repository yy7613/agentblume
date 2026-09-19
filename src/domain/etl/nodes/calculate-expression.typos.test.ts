/**
 * 式の打ち間違い試験 — 利用者が実際にやる入力ミスを、直せる形で断れるか。
 *
 * 文法そのものの確認は `calculate-expression.test.ts` が持つ。ここで見るのは
 * **打ち間違いの種類ごとに、原因を言い当てた文言と正しい位置が返るか**:
 * - 関数名の綴り違い・括弧の書き忘れ
 * - 表計算ソフトの癖（先頭の `=`、`SUM(...)`、桁区切りのカンマ）
 * - 演算子の書き忘れ（暗黙の乗算）・`x` を掛け算のつもりで書く
 * - 括弧・角括弧の対応ミス、引数区切りの誤り
 * - 存在しない列名（**角括弧つきは構文として正しいので、ノードの検査が受け止める**）
 *
 * 位置（position）は 0 起点で、UI が式のどこを指せばよいかの手掛かりになる。
 * 「黙って 0 や空にしない」という設計（ADR-0045）が守られていることも併せて固定する。
 */
import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { parseExpression } from './calculate-expression';
import { calculateNode } from './calculate';

const columns = ['金額', '数量'];

/** 読めないはずの式を読ませ、文言と位置を返す。読めてしまったらここで落とす。 */
function failure(text: string, known: readonly string[] = columns): { message: string; position: number } {
  const result = parseExpression(text, known);
  expect(result.ok ? `読めてしまった: ${text}` : '').toBe('');
  return result.ok ? { message: '', position: -1 } : { message: result.message, position: result.position };
}

/** 読めるはずの式。参照した列名を返す。 */
function references(text: string, known: readonly string[] = columns): readonly string[] {
  const result = parseExpression(text, known);
  expect(result.ok ? '' : `読めなかった: ${result.ok ? '' : result.message}`).toBe('');
  return result.ok ? result.references : [];
}

describe('打ち間違い: 関数名', () => {
  it('異常: 綴り違いは「知らない関数」と名前を添えて断る', () => {
    expect(failure('sqr(4)').message).toContain('知らない関数です: sqr');
    expect(failure('squrt(4)').message).toContain('squrt');
    expect(failure('lg(10)').message).toContain('lg');
    // 位置は関数名の先頭。UI がそこを指せる。
    expect(failure('1 + sqr(4)').position).toBe(4);
  });

  it('異常: 括弧を忘れた関数名は「sqrt(...) の形で書きます」と書き方を示す', () => {
    // 「知らない名前」ではなく、関数だと分かったうえで書き方を教える。
    expect(failure('sqrt 4').message).toContain('sqrt(...) の形');
    expect(failure('pi + ln 2').message).toContain('ln(...) の形');
  });

  it('異常: 表計算ソフトの関数名は使えないと分かる形で断る', () => {
    expect(failure('SUM([金額])').message).toContain('知らない関数です: SUM');
    expect(failure('IF([金額] , 1, 2)').message).toContain('IF');
    expect(failure('AVERAGE([金額])').message).toContain('AVERAGE');
  });

  it('正常: 関数名と ( のあいだの空白は許す（打ち方の揺れで断らない）', () => {
    expect(references('ln (4)')).toEqual([]);
    expect(references('max ( [金額] , 2 )')).toEqual(['金額']);
  });
});

describe('打ち間違い: 表計算ソフトの癖', () => {
  it('異常: 先頭の = は使えない文字として位置 0 で断る', () => {
    const { message, position } = failure('=[金額]*2');
    expect(message).toContain('使えない文字です: =');
    expect(position).toBe(0);
  });

  it('異常: 桁区切りのカンマは式の外の , として断る', () => {
    // 1,234 を「1234」のつもりで書く事故。黙って 1 と解釈しない。
    expect(failure('1,234').message).toContain('余分な入力');
    expect(failure('[金額] > 1,000').message).toContain('使えない文字です: >');
  });

  it('異常: 比較・論理・文字列の記号はすべて「使えない文字」で断る', () => {
    for (const text of ['[金額] = 1', '[金額] < 1', '[金額] >= 1', '[金額] & 1', '[金額] | 1', '"abc"']) {
      expect(failure(text).message).toContain('使えない文字');
    }
  });
});

describe('打ち間違い: 演算子の書き忘れ', () => {
  it('異常: 暗黙の乗算は受け付けず、余分な入力として位置を示す', () => {
    // 数学の書き方（2(3+4)）はそのままでは通らない。* を書く必要がある。
    expect(failure('2(3+4)').message).toContain('余分な入力');
    expect(failure('2(3+4)').position).toBe(1);
    expect(failure('[金額][数量]').message).toContain('余分な入力');
    expect(failure('2 [金額]').position).toBe(2);
  });

  it('異常: 掛け算のつもりの x / X は余分な入力になる', () => {
    // × のつもりで半角 x を打つ事故。列にも関数にも無いので読めない。
    expect(failure('2 x 3').message).toContain('余分な入力');
    expect(failure('[金額] X [数量]').position).toBe(5);
  });

  it('異常: 演算子で終わる式・演算子で始まる式', () => {
    expect(failure('[金額] +').message).toContain('途中で終わって');
    expect(failure('2 *').message).toContain('途中で終わって');
    expect(failure('*2').message).toContain('演算子 * の右に数値がありません');
    expect(failure('^2').message).toContain('演算子 ^ の右');
  });

  it('異常: ** をべき乗のつもりで書くと断られる（^ を使う）', () => {
    // 他の言語の癖。* の右に値が無いと分かる形で返す。
    expect(failure('2 ** 3').message).toContain('演算子 * の右に数値がありません');
    expect(parseExpression('2 ^ 3', []).ok).toBe(true);
  });

  it('境界: 単項の + と - は重ねられる（打ち間違いではなく文法として正しい）', () => {
    expect(parseExpression('2 ++ 3', []).ok).toBe(true);
    expect(parseExpression('2 -- 3', []).ok).toBe(true);
  });
});

describe('打ち間違い: 数値の書き方', () => {
  it('異常: 小数点の打ち間違い', () => {
    expect(failure('1.2.3').message).toContain('余分な入力');
    expect(failure('1..2').message).toContain('小数点のあとに数字がありません');
    expect(failure('1.').message).toContain('小数点のあとに数字がありません');
    expect(failure('.').message).toContain('使えない文字');
  });

  it('異常: 単位や記号を混ぜると使えない文字として断る', () => {
    // 単位は字句解析の段階で弾かれる（「余分な入力」より原因に近い文言になる）。
    expect(failure('1000円').message).toContain('使えない文字です: 円');
    expect(failure('50$').message).toContain('使えない文字です: $');
    expect(failure('[金額]@2').message).toContain('使えない文字です: @');
  });

  it('異常: % を単位のつもりで末尾に書くと途中で終わる（剰余の演算子なので）', () => {
    expect(failure('10%').message).toContain('途中で終わって');
    expect(failure('[金額] * 10%').message).toContain('途中で終わって');
  });
});

describe('打ち間違い: 括弧と引数の区切り', () => {
  it('異常: 括弧の数が合わない', () => {
    expect(failure('(1 + 2').message).toContain('閉じ括弧');
    expect(failure('(([金額])').message).toContain('閉じ括弧');
    expect(failure('1 + 2)').message).toContain('余分な入力');
    expect(failure('max(1, 2').message).toContain('閉じ括弧');
  });

  it('異常: 角括弧の打ち間違い', () => {
    expect(failure('[金額').message).toContain('] がありません');
    expect(failure('[[金額]]').message).toContain('[ がありません');
    expect(failure('[金額]]').message).toContain('[ がありません');
    expect(failure('[]').message).toContain('列名が空');
  });

  it('異常: 区切りの直後に引数が無いと、括弧の不一致ではなく引数の不足として断る', () => {
    // 「対応する ( がありません」と出ると、括弧を数え直させてしまう（原因が違う）。
    expect(failure('max(1,)').message).toContain('のあとに引数がありません');
    expect(failure('max(1,)').message).toContain('max');
    expect(failure('atan2(1, )').message).toContain('引数がありません');
    // 区切りが先に来る場合は「ここでは使えません」。
    expect(failure('max(,1)').message).toContain(', はここでは使えません');
  });

  it('異常: 区切りにセミコロンや全角読点は使えない', () => {
    expect(failure('max(1; 2)').message).toContain('使えない文字です: ;');
    expect(failure('max(1、2)').message).toContain('使えない文字');
  });

  it('異常: 引数の数を間違えると、期待する個数を添えて断る', () => {
    expect(failure('pow(2)').message).toContain('2 個');
    expect(failure('sqrt(1, 2)').message).toContain('1 個');
    expect(failure('max()').message).toContain('1 個以上');
  });
});

describe('打ち間違い: 列名', () => {
  it('正常: 全角の括弧・角括弧・演算子はそのまま読む（打ち方の揺れで断らない）', () => {
    expect(references('（1+2）')).toEqual([]);
    expect(references('［金額］')).toEqual(['金額']);
    expect(references('[金額]＊2')).toEqual(['金額']);
    expect(parseExpression('２＾３', []).ok).toBe(true);
  });

  it('異常: 裸の識別子の打ち間違いは「知らない名前」と [..] の書き方を示す', () => {
    const { message, position } = failure('1 + kingaku');
    expect(message).toContain('知らない名前です: kingaku');
    expect(message).toContain('[kingaku]');
    expect(position).toBe(4);
  });

  it('例外: 角括弧つきの存在しない列は構文としては正しい（受け止めるのはノードの検査）', () => {
    // [..] は常に列参照なので、解釈器は綴りの正しさを知らない。ここで落とすと
    // 「まだ繋いでいない上流の列」を先回りで拒むことになる。
    expect(references('[kingaku]')).toEqual(['kingaku']);
    expect(references('[金 額]')).toEqual(['金 額']);
    expect(references('[金額 ]')).toEqual(['金額 ']);

    // ノードのスキーマ推論が error として出す（黙って null の列を作らない）。
    const schema: Schema = { columns: [{ name: '金額', type: 'number', nullable: false }] };
    const inference = calculateNode.inferSchema([schema], calculateNode.validateConfig({ outputColumn: 'x', expression: '[kingaku] * 2' }));
    expect(inference.state).toBe('mismatch');
    expect(inference.issues.some((issue) => issue.severity === 'error' && issue.message.includes('kingaku'))).toBe(true);
  });

  it('例外: 空白の有無は別の列として扱う（列名の空白は有意）', () => {
    const schema: Schema = { columns: [{ name: '金額', type: 'number', nullable: false }] };
    const inference = calculateNode.inferSchema([schema], calculateNode.validateConfig({ outputColumn: 'x', expression: '[金額 ] * 2' }));
    expect(inference.state).toBe('mismatch');
  });
});

describe('打ち間違い: 失敗の共通の作法', () => {
  it('例外: どの打ち間違いでも投げず、0 起点の位置が式の長さを超えない', () => {
    const samples = [
      '', '   ', '=1', 'sqr(1)', '1..2', '2 x 3', '(1', '1)', '[a', ']', 'max(1,)', '1000円', '10%', '**', '[]',
    ];
    for (const text of samples) {
      const result = parseExpression(text, columns);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.position).toBeGreaterThanOrEqual(0);
      expect(result.position).toBeLessThanOrEqual(text.length);
    }
  });

  it('例外: 打ち間違いのある式で execute まで来たら ConfigError（黙って null 列を作らない）', () => {
    const schema: Schema = { columns: [{ name: '金額', type: 'number', nullable: false }] };
    const table: Table = { schema, rows: [{ 金額: 100 }] };
    expect(() => calculateNode.execute([table], calculateNode.validateConfig({ outputColumn: 'x', expression: 'sqr(4)' }))).toThrowError(/知らない関数/);
    expect(() => calculateNode.execute([table], calculateNode.validateConfig({ outputColumn: 'x', expression: '2 x 3' }))).toThrowError(/余分な入力/);
  });
});

/**
 * 式の診断（v40 実装契約 §3 / §4）。
 *
 * ここで確かめるのは「式の設定を LLM に任せる」ための 3 つ:
 * 1. 提案が妥当かを機械可読に判定できる（種別・位置・候補）
 * 2. 読めない式では列の検査に進まない（本当の原因を埋もれさせない）
 * 3. 提案が実際に何を出すかを、ノードを動かさずに、**ノードと同じ値で**確かめられる
 *
 * 3 が崩れると「プレビューでは出たのに実行すると違う」という最も直しにくい不具合になるので、
 * 値はノードの `execute` と突き合わせて固定する。
 */
import { describe, expect, it } from 'vitest';
import type { Row, Schema, Table } from '../../data/types';
import { EXPRESSION_ERROR_CODES } from './calculate-expression';
import {
  DEFAULT_PREVIEW_LIMIT,
  EXPRESSION_DIAGNOSTIC_CATEGORIES,
  EXPRESSION_DIAGNOSTIC_CODES,
  MAX_PREVIEW_LIMIT,
  diagnosticCategory,
  previewExpression,
  validateExpression,
} from './calculate-diagnostics';
import { calculateNode } from './calculate';

const schema: Schema = {
  columns: [
    { name: '金額', type: 'number', nullable: false },
    { name: '数量', type: 'number', nullable: true },
    { name: 'memo', type: 'string', nullable: true },
  ],
};

const rows: readonly Row[] = [
  { 金額: 300, 数量: 4, memo: 'a' },
  { 金額: 1000, 数量: 8, memo: 'b' },
];

/** ノードの実行と同じ値になることを確かめる（規則が分かれていない証拠）。 */
function nodeValues(expression: string, table: Table, precision?: number): readonly (number | null)[] {
  const config = calculateNode.validateConfig({
    outputColumn: '__result',
    expression,
    ...(precision === undefined ? {} : { precision }),
  });
  return calculateNode.execute([table], config).rows.map((row) => {
    const value = row['__result'];
    return typeof value === 'number' ? value : null;
  });
}

describe('calculate-diagnostics: 種別', () => {
  it('正常: 診断の種別は式の失敗 21 種 + スキーマ由来の 3 種で、重複がない', () => {
    expect(EXPRESSION_DIAGNOSTIC_CODES).toHaveLength(EXPRESSION_ERROR_CODES.length + 3);
    expect(new Set(EXPRESSION_DIAGNOSTIC_CODES).size).toBe(EXPRESSION_DIAGNOSTIC_CODES.length);
    for (const code of EXPRESSION_ERROR_CODES) expect(EXPRESSION_DIAGNOSTIC_CODES).toContain(code);
    for (const code of ['unknown-column', 'type-coerced', 'type-not-numeric']) {
      expect(EXPRESSION_DIAGNOSTIC_CODES).toContain(code);
    }
  });
});

describe('validateExpression', () => {
  it('正常: 妥当な式は ok で診断 0 件、references は出現順・重複なし', () => {
    const validation = validateExpression('[金額] / [数量] + [金額]', schema);
    expect(validation.ok).toBe(true);
    expect(validation.diagnostics).toEqual([]);
    expect(validation.references).toEqual(['金額', '数量']);
    expect(validation.unknownColumns).toEqual([]);
  });

  it('正常: 列を参照しない式も妥当（定数と関数だけ）', () => {
    const validation = validateExpression('round(pi, 4)', schema);
    expect(validation.ok).toBe(true);
    expect(validation.references).toEqual([]);
  });

  it('正常: number 以外の型は warning で、ok は true のまま（実行はできる）', () => {
    const input: Schema = {
      columns: [
        { name: 's', type: 'string', nullable: false },
        { name: 'u', type: 'unknown', nullable: false },
        { name: 'n', type: 'null', nullable: true },
        { name: 'b', type: 'boolean', nullable: false },
        { name: 'd', type: 'date', nullable: false },
      ],
    };
    const validation = validateExpression('[s] + [u] + [n] + [b] + [d]', input);
    expect(validation.ok).toBe(true);
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'type-coerced',
      'type-coerced',
      'type-coerced',
      'type-not-numeric',
      'type-not-numeric',
    ]);
    for (const diagnostic of validation.diagnostics) expect(diagnostic.severity).toBe('warning');
    expect(validation.diagnostics.map((diagnostic) => diagnostic.column)).toEqual(['s', 'u', 'n', 'b', 'd']);
    // 型の warning は式のどこを指すものでもないので位置を持たない。
    expect(validation.diagnostics.every((diagnostic) => diagnostic.position === undefined)).toBe(true);
  });

  it('正常: すべての種別に分類が付き、列の指定ミスは書き方によらず column にまとまる', () => {
    // 種別は原因を細かく言い当てるが、利用者が取る行動はもっと粗い。
    // [列名] で書いても裸で書いても「列名を直す」なので、差し戻しでは 1 つに束ねたい。
    for (const code of EXPRESSION_DIAGNOSTIC_CODES) {
      expect(EXPRESSION_DIAGNOSTIC_CATEGORIES).toContain(diagnosticCategory(code));
    }
    expect(diagnosticCategory('unknown-column')).toBe('column');
    expect(diagnosticCategory('unknown-name')).toBe('column');
    expect(diagnosticCategory('empty-column-name')).toBe('column');
    expect(diagnosticCategory('unknown-function')).toBe('function');
    expect(diagnosticCategory('unclosed-paren')).toBe('syntax');
    expect(diagnosticCategory('too-long')).toBe('limit');
    expect(diagnosticCategory('type-coerced')).toBe('type');
  });

  it('正常: 角括弧でも裸でも、列の指定ミスは同じ分類で返る（差し戻しで束ねられる）', () => {
    const input: Schema = { columns: [{ name: 'amount', type: 'number', nullable: false }] };
    const bracketed = validateExpression('[amont] * 2', input);
    const bare = validateExpression('amont * 2', input);
    // 種別は違う（角括弧つきは構文として正しく、裸は名前として読めない）。
    expect(bracketed.diagnostics[0]?.code).toBe('unknown-column');
    expect(bare.diagnostics[0]?.code).toBe('unknown-name');
    // 分類は同じ。どちらも「列名を直す」で済む。
    expect(bracketed.diagnostics[0]?.category).toBe('column');
    expect(bare.diagnostics[0]?.category).toBe('column');
    // 候補もどちらにも付く。
    expect(bracketed.diagnostics[0]?.suggestion).toBe('amount');
    expect(bare.diagnostics[0]?.suggestion).toBe('amount');
  });

  it('例外: 知らない種別を渡しても投げず、syntax に寄せる', () => {
    expect(diagnosticCategory('nope' as never)).toBe('syntax');
    expect(diagnosticCategory(undefined as never)).toBe('syntax');
  });

  it('異常: 空の式は empty の error（設定途中でも原因が分かる文言を返す）', () => {
    for (const expression of ['', '   ', '\t\n']) {
      const validation = validateExpression(expression, schema);
      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toEqual([
        { severity: 'error', code: 'empty', category: 'empty', message: '式を入力してください' },
      ]);
      expect(validation.references).toEqual([]);
    }
  });

  it('異常: 読めない式は error で code と position が入り、列の検査はしない', () => {
    // 構文が崩れている間の参照列は当てにならない。原因（構文）だけを 1 件返す。
    const validation = validateExpression('[原価] + * 2', schema);
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toHaveLength(1);
    const [diagnostic] = validation.diagnostics;
    expect(diagnostic?.code).toBe('missing-operand');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.position).toBe(7);
    expect(diagnostic?.message).toBe('演算子 * の右に数値がありません');
    expect(validation.references).toEqual([]);
    expect(validation.unknownColumns).toEqual([]);
  });

  it('異常: 読めない式の候補はそのまま写る（打ち間違いを直せる形で差し戻す）', () => {
    const validation = validateExpression('sqr([金額])', schema);
    expect(validation.diagnostics[0]?.code).toBe('unknown-function');
    expect(validation.diagnostics[0]?.suggestion).toBe('sqrt');
  });

  it('異常: 入力に無い列は unknown-column の error で、列名と近い候補が入る', () => {
    const input: Schema = { columns: [{ name: 'amount', type: 'number', nullable: false }] };
    const validation = validateExpression('[amont] * 2', input);
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unknown-column',
        category: 'column',
        message: '式が参照する列がありません: amont',
        column: 'amont',
        suggestion: 'amount',
      },
    ]);
    expect(validation.references).toEqual(['amont']);
    expect(validation.unknownColumns).toEqual(['amont']);
  });

  it('異常: 近い列が無ければ候補は付けない（見当違いの候補は害）', () => {
    const validation = validateExpression('[原価] * 2', schema);
    expect(validation.diagnostics[0]?.code).toBe('unknown-column');
    expect(validation.diagnostics[0]?.suggestion).toBeUndefined();
  });

  it('境界: 同じ列を 2 回参照しても診断は 1 件', () => {
    const validation = validateExpression('[原価] + [原価] * 2', schema);
    expect(validation.diagnostics).toHaveLength(1);
    expect(validation.unknownColumns).toEqual(['原価']);

    const warned = validateExpression('[memo] + [memo]', schema);
    expect(warned.diagnostics).toHaveLength(1);
    expect(warned.ok).toBe(true);
  });

  it('境界: 列が 0 個のスキーマでも定数の式は妥当、列参照は unknown-column', () => {
    const empty: Schema = { columns: [] };
    expect(validateExpression('1 + 2', empty).ok).toBe(true);
    const validation = validateExpression('[金額]', empty);
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics[0]?.code).toBe('unknown-column');
    expect(validation.diagnostics[0]?.suggestion).toBeUndefined();
  });

  it('境界: error と warning が混ざるときは参照の出現順に並ぶ', () => {
    const validation = validateExpression('[memo] + [原価]', schema);
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'type-coerced',
      'unknown-column',
    ]);
    expect(validation.ok).toBe(false);
  });

  it('例外: 壊れたスキーマ・異常な入力でも投げない', () => {
    const broken = [
      undefined,
      null,
      {},
      { columns: null },
      { columns: 'x' },
      { columns: [null, 1, { name: 42 }, { name: '金額' }] },
    ];
    for (const input of broken) {
      expect(() => validateExpression('[金額] * 2', input as unknown as Schema)).not.toThrow();
    }
    expect(() => validateExpression(undefined as unknown as string, schema)).not.toThrow();
    expect(() => validateExpression(42 as unknown as string, schema)).not.toThrow();
    expect(validateExpression(undefined as unknown as string, schema).diagnostics[0]?.code).toBe('empty');
    // 型が欠けた列は「number ではない」側として扱う（黙って number と見なさない）。
    const partial = validateExpression('[金額] * 2', { columns: [{ name: '金額' }] } as unknown as Schema);
    expect(partial.ok).toBe(true);
    expect(partial.diagnostics[0]?.code).toBe('type-not-numeric');
  });
});

describe('previewExpression', () => {
  const table: Table = { schema, rows };

  it('正常: 行ごとに値が出て、evaluated / failed が合う', () => {
    const preview = previewExpression('[金額] / [数量]', schema, rows);
    expect(preview.ok).toBe(true);
    expect(preview.rows).toEqual([
      { index: 0, value: 75 },
      { index: 1, value: 125 },
    ]);
    expect(preview.evaluated).toBe(2);
    expect(preview.failed).toBe(0);
    expect(preview.failureCounts).toEqual({});
    expect(preview.firstFailure).toBeUndefined();
    expect(preview.validation.ok).toBe(true);
  });

  it('正常: 値はノードの実行と一致する（数値への寄せ・非有限の扱いが分かれていない）', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'unknown', nullable: true }] },
      rows: [
        { v: 42 },
        { v: ' 1.5 ' },
        { v: 'abc' },
        { v: '' },
        { v: null },
        { v: true },
        { v: new Date('2020-01-01T00:00:00Z') },
        { v: 1e308 },
      ],
    };
    const preview = previewExpression('[v] * 2', input.schema, input.rows);
    expect(preview.rows.map((row) => row.value)).toEqual(nodeValues('[v] * 2', input));
  });

  it('正常: precision はノードと同じ丸め（0 から遠ざかる四捨五入）', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'number', nullable: false }] },
      rows: [{ v: 1.25 }, { v: -1.25 }, { v: 2.4 }],
    };
    const preview = previewExpression('[v]', input.schema, input.rows, { precision: 1 });
    expect(preview.rows.map((row) => row.value)).toEqual([1.3, -1.3, 2.4]);
    expect(preview.rows.map((row) => row.value)).toEqual(nodeValues('[v]', input, 1));
  });

  it('正常: 丸めは評価のあとに当たる（ノードと同じ順序）', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'number', nullable: false }] },
      rows: [{ v: 10 }],
    };
    const preview = previewExpression('[v] / 3', input.schema, input.rows, { precision: 2 });
    expect(preview.rows[0]?.value).toBe(3.33);
    expect(preview.rows.map((row) => row.value)).toEqual(nodeValues('[v] / 3', input, 2));
  });

  it('異常: 読めない式では行を評価せず、ok:false で rows が空', () => {
    for (const expression of ['', '[金額] + ', 'sqr([金額])', '[原価] * 2']) {
      const preview = previewExpression(expression, schema, rows);
      expect(preview.ok).toBe(false);
      expect(preview.rows).toEqual([]);
      expect(preview.evaluated).toBe(0);
      expect(preview.failed).toBe(0);
      expect(preview.failureCounts).toEqual({});
      expect(preview.firstFailure).toBeUndefined();
      expect(preview.validation.ok).toBe(false);
    }
  });

  it('正常: 型の warning だけなら行は評価する（実行できる式を止めない）', () => {
    const input: Schema = { columns: [{ name: 'memo', type: 'string', nullable: true }] };
    const preview = previewExpression('[memo] * 2', input, [{ memo: '21' }]);
    expect(preview.ok).toBe(true);
    expect(preview.validation.diagnostics[0]?.code).toBe('type-coerced');
    expect(preview.rows[0]?.value).toBe(42);
  });

  it('異常: 失敗は理由ごとに数えられ、firstFailure が最初の失敗を指す', () => {
    const input: Schema = {
      columns: [
        { name: 'a', type: 'number', nullable: true },
        { name: 'b', type: 'number', nullable: true },
      ],
    };
    const preview = previewExpression('[a] / [b]', input, [
      { a: 1, b: 0 },
      { a: 10, b: 2 },
      { a: null, b: 2 },
      { a: 3, b: 0 },
    ]);
    expect(preview.evaluated).toBe(1);
    expect(preview.failed).toBe(3);
    expect(preview.failureCounts).toEqual({ 'divide-by-zero': 2, 'missing-value': 1 });
    expect(preview.firstFailure).toEqual({ index: 0, value: null, reason: 'divide-by-zero' });
    expect(preview.rows[2]).toEqual({ index: 2, value: null, reason: 'missing-value' });
  });

  it('異常: 定義域の外・桁あふれも理由として区別する', () => {
    const input: Schema = { columns: [{ name: 'a', type: 'number', nullable: false }] };
    const preview = previewExpression('sqrt([a])', input, [{ a: -1 }, { a: 4 }]);
    expect(preview.failureCounts).toEqual({ 'domain-error': 1 });
    expect(preview.rows[1]?.value).toBe(2);

    const overflow = previewExpression('exp([a])', input, [{ a: 1000 }]);
    expect(overflow.failureCounts).toEqual({ overflow: 1 });
  });

  it('異常: precision が範囲外なら丸めず、その行は invalid-argument で null', () => {
    const input: Schema = { columns: [{ name: 'a', type: 'number', nullable: false }] };
    for (const precision of [16, -1, 1.5]) {
      const preview = previewExpression('[a]', input, [{ a: 1.5 }], { precision });
      expect(preview.ok).toBe(true);
      expect(preview.rows[0]).toEqual({ index: 0, value: null, reason: 'invalid-argument' });
      expect(preview.failureCounts).toEqual({ 'invalid-argument': 1 });
    }
  });

  it('境界: limit の既定は 100、上限は 1000、0 以下・整数でない値は既定に戻す', () => {
    const input: Schema = { columns: [{ name: 'v', type: 'number', nullable: false }] };
    const many: readonly Row[] = Array.from({ length: MAX_PREVIEW_LIMIT + 200 }, (_, index) => ({ v: index }));

    expect(previewExpression('[v]', input, many).rows).toHaveLength(DEFAULT_PREVIEW_LIMIT);
    expect(previewExpression('[v]', input, many, { limit: 3 }).rows).toHaveLength(3);
    expect(previewExpression('[v]', input, many, { limit: MAX_PREVIEW_LIMIT }).rows).toHaveLength(MAX_PREVIEW_LIMIT);
    expect(previewExpression('[v]', input, many, { limit: 99999 }).rows).toHaveLength(MAX_PREVIEW_LIMIT);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(previewExpression('[v]', input, many, { limit }).rows).toHaveLength(DEFAULT_PREVIEW_LIMIT);
    }
    // 先頭から切る（並べ替えない）。
    const limited = previewExpression('[v]', input, many, { limit: 2 });
    expect(limited.rows).toEqual([
      { index: 0, value: 0 },
      { index: 1, value: 1 },
    ]);
    expect(limited.evaluated).toBe(2);
  });

  it('正常: 型の警告があって全行が空になるとき、上流の型変換が要ると言い切る', () => {
    // 型の警告だけでは「寄せられるかもしれない」に留まる。実データで 1 つも数値にならなかった
    // ときに初めて cast が要ると言える。件数の表から人に推理させない。
    const input: Schema = { columns: [{ name: 'price', type: 'string', nullable: true }] };
    const rows: readonly Row[] = [{ price: '税込 1,200 円' }, { price: 'お問い合わせ' }, { price: '応相談' }];
    const preview = previewExpression('[price] * 2', input, rows);

    expect(preview.ok).toBe(true);
    expect(preview.failed).toBe(3);
    expect(preview.diagnosis.allFailed).toBe(true);
    expect(preview.diagnosis.dominantReason).toBe('missing-value');
    expect(preview.diagnosis.notNumericColumns).toEqual(['price']);
    expect(preview.diagnosis.nextStep).toContain('型変換');
    expect(preview.diagnosis.nextStep).toContain('price');
  });

  it('正常: 同じ文字列の列でも、数値にできる値が混ざれば型変換を促さない', () => {
    // 1 つでも寄せられるなら列そのものは使える。直すべきは個々の値であって上流の型ではない。
    const input: Schema = { columns: [{ name: 'price', type: 'string', nullable: true }] };
    const preview = previewExpression('[price] * 2', input, [{ price: '100' }, { price: '応相談' }]);
    expect(preview.evaluated).toBe(1);
    expect(preview.diagnosis.notNumericColumns).toEqual([]);
    expect(preview.diagnosis.allFailed).toBe(false);
    expect(preview.diagnosis.nextStep).toBeUndefined();
  });

  it('正常: 参照列が全行とも空なら、型変換ではなく null 処理を促す', () => {
    const input: Schema = { columns: [{ name: '金額', type: 'number', nullable: true }] };
    const preview = previewExpression('[金額] * 2', input, [{ 金額: null }, { 金額: null }]);
    expect(preview.diagnosis.allNullColumns).toEqual(['金額']);
    expect(preview.diagnosis.notNumericColumns).toEqual([]);
    expect(preview.diagnosis.nextStep).toContain('null 処理');
  });

  it('正常: 全行が 0 除算なら、分母の見直しと行フィルターを促す', () => {
    const preview = previewExpression('[金額] / [数量]', schema, [{ 金額: 100, 数量: 0 }, { 金額: 200, 数量: 0 }]);
    expect(preview.diagnosis.dominantReason).toBe('divide-by-zero');
    expect(preview.diagnosis.allFailed).toBe(true);
    expect(preview.diagnosis.nextStep).toContain('行フィルター');
  });

  it('境界: 一部の行だけ失敗するときは読み替えを出さない（式もデータも概ね正しい）', () => {
    const preview = previewExpression('[金額] / [数量]', schema, [{ 金額: 100, 数量: 4 }, { 金額: 200, 数量: 0 }]);
    expect(preview.evaluated).toBe(1);
    expect(preview.failed).toBe(1);
    expect(preview.diagnosis.allFailed).toBe(false);
    // 理由は分かるが、次の一手を断定できるほどの偏りではない。
    expect(preview.diagnosis.dominantReason).toBe('divide-by-zero');
    expect(preview.diagnosis.nextStep).toBeUndefined();
  });

  it('境界: 失敗が無ければ読み替えは空のまま（余計な案内を出さない）', () => {
    const preview = previewExpression('[金額] * 2', schema, [{ 金額: 100 }, { 金額: 200 }]);
    expect(preview.failed).toBe(0);
    expect(preview.diagnosis).toEqual({ allFailed: false, notNumericColumns: [], allNullColumns: [] });
  });

  it('例外: 読めない式では行を見ないので、読み替えも空になる', () => {
    const preview = previewExpression('[金額] +', schema, [{ 金額: 100 }]);
    expect(preview.ok).toBe(false);
    expect(preview.diagnosis).toEqual({ allFailed: false, notNumericColumns: [], allNullColumns: [] });
  });

  it('境界: 行が 0 件でも妥当な式は ok（式の良し悪しと行数は別）', () => {
    const preview = previewExpression('[金額] * 2', schema, []);
    expect(preview.ok).toBe(true);
    expect(preview.rows).toEqual([]);
    expect(preview.evaluated).toBe(0);
    expect(preview.failed).toBe(0);
  });

  it('例外: 入力の行を書き換えない（凍結した行でも落ちない）', () => {
    const frozen: readonly Row[] = Object.freeze([
      Object.freeze({ 金額: 300, 数量: 4, memo: 'a' }),
      Object.freeze({ 金額: 1000, 数量: 0, memo: 'b' }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(frozen)) as unknown;
    const preview = previewExpression('[金額] / [数量]', schema, frozen, { precision: 2 });
    expect(preview.rows).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(snapshot);
    expect(frozen).toHaveLength(2);
    // ノードの実行も同じ値（プレビューと実行で結果が分かれない）。
    expect(preview.rows.map((row) => row.value)).toEqual(nodeValues('[金額] / [数量]', { schema, rows: frozen }, 2));
  });

  it('例外: 壊れた行・壊れたスキーマでも投げない', () => {
    const input: Schema = { columns: [{ name: 'a', type: 'number', nullable: true }] };
    const broken = [null, undefined, 42, 'x', { a: '3' }, {}] as unknown as readonly Row[];
    expect(() => previewExpression('[a] + 1', input, broken)).not.toThrow();
    const preview = previewExpression('[a] + 1', input, broken);
    expect(preview.rows.map((row) => row.value)).toEqual([null, null, null, null, 4, null]);
    expect(preview.failed).toBe(5);

    expect(() => previewExpression('[a]', input, undefined as unknown as readonly Row[])).not.toThrow();
    expect(() => previewExpression('[a]', null as unknown as Schema, [{ a: 1 }])).not.toThrow();
    expect(() => previewExpression(undefined as unknown as string, input, [{ a: 1 }])).not.toThrow();
  });

  it('例外: 同じ入力から何度呼んでも同じ結果（副作用を持たない）', () => {
    const first = previewExpression('[金額] / [数量]', schema, rows, { precision: 1 });
    const second = previewExpression('[金額] / [数量]', schema, rows, { precision: 1 });
    expect(second).toEqual(first);
    expect(nodeValues('[金額] / [数量]', table, 1)).toEqual(first.rows.map((row) => row.value));
  });
});

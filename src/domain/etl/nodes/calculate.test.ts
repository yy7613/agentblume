import { describe, expect, it } from 'vitest';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { CALCULATE_TYPE, calculateNode } from './calculate';
import { validateExpression } from './calculate-diagnostics';
import { createDefaultRegistry } from './index';

const schema: Schema = {
  columns: [
    { name: '金額', type: 'number', nullable: false },
    { name: '数量', type: 'number', nullable: true },
    { name: 'memo', type: 'string', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { 金額: 300, 数量: 4, memo: 'a' },
    { 金額: 1000, 数量: 8, memo: 'b' },
  ],
};

function config(overrides: Partial<Record<string, unknown>> = {}): {
  outputColumn: string;
  expression: string;
  onError?: 'null' | 'fail';
  precision?: number;
} {
  return calculateNode.validateConfig({ outputColumn: 'result', expression: '1 + 1', ...overrides });
}

describe('calculate: メタデータ', () => {
  it('正常: type/kind/arity', () => {
    expect(CALCULATE_TYPE).toBe('calculate');
    expect(calculateNode.type).toBe('calculate');
    expect(calculateNode.kind).toBe('transform');
    expect(calculateNode.inputArity).toBe(1);
  });

  it('正常: 既定のレジストリに cast の直後で登録されている', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('calculate')).toBe(calculateNode);
    const types = registry.types();
    expect(types.indexOf('calculate')).toBe(types.indexOf('cast') + 1);
  });
});

describe('calculate: validateConfig', () => {
  it('正常: 必須項目だけ / 全項目', () => {
    expect(config()).toEqual({ outputColumn: 'result', expression: '1 + 1' });
    expect(config({ onError: 'fail', precision: 2 })).toEqual({
      outputColumn: 'result',
      expression: '1 + 1',
      onError: 'fail',
      precision: 2,
    });
  });

  it('正常: 空の式も config としては通る（設定途中でプレビューを落とさない）', () => {
    expect(config({ expression: '' }).expression).toBe('');
  });

  it('正常: 未知のキーは黙って落とす', () => {
    const parsed = calculateNode.validateConfig({
      outputColumn: 'result',
      expression: '1',
      おまけ: true,
    });
    expect(parsed).toEqual({ outputColumn: 'result', expression: '1' });
  });

  it('異常: outputColumn が空 / 型違い / config が object でない', () => {
    expect(() => config({ outputColumn: '' })).toThrowError(ConfigError);
    expect(() => calculateNode.validateConfig({ outputColumn: 'r' })).toThrowError(ConfigError);
    expect(() => calculateNode.validateConfig({ outputColumn: 'r', expression: 1 })).toThrowError(ConfigError);
    expect(() => calculateNode.validateConfig(null)).toThrowError(ConfigError);
    expect(() => calculateNode.validateConfig('1+1')).toThrowError(ConfigError);
  });

  it('異常: onError は null / fail だけ', () => {
    expect(() => config({ onError: 'skip' })).toThrowError(ConfigError);
  });

  it('境界: precision は 0..15 の整数', () => {
    expect(config({ precision: 0 }).precision).toBe(0);
    expect(config({ precision: 15 }).precision).toBe(15);
    expect(() => config({ precision: -1 })).toThrowError(ConfigError);
    expect(() => config({ precision: 16 })).toThrowError(ConfigError);
    expect(() => config({ precision: 1.5 })).toThrowError(ConfigError);
  });
});

describe('calculate: inferSchema', () => {
  it('正常: 出力列を末尾に足して confirmed', () => {
    const inference = calculateNode.inferSchema([schema], config({ expression: '[金額] / [数量]' }));
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema.columns).toEqual([
      ...schema.columns,
      { name: 'result', type: 'number', nullable: true },
    ]);
  });

  it('正常: 同名の列はその位置で number/nullable に置き換える', () => {
    const inference = calculateNode.inferSchema(
      [schema],
      config({ outputColumn: '数量', expression: '[金額] * 2' }),
    );
    expect(inference.schema.columns).toEqual([
      { name: '金額', type: 'number', nullable: false },
      { name: '数量', type: 'number', nullable: true },
      { name: 'memo', type: 'string', nullable: true },
    ]);
    expect(inference.state).toBe('confirmed');
  });

  it('正常: string / unknown / null 型の参照は「数値へ寄せます」の warning', () => {
    const input: Schema = {
      columns: [
        { name: 's', type: 'string', nullable: false },
        { name: 'u', type: 'unknown', nullable: false },
        { name: 'n', type: 'null', nullable: true },
      ],
    };
    const inference = calculateNode.inferSchema([input], config({ expression: '[s] + [u] + [n]' }));
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toHaveLength(3);
    for (const issue of inference.issues) {
      expect(issue.severity).toBe('warning');
      expect(issue.message).toContain('数値へ寄せます');
    }
    expect(inference.issues.map((issue) => issue.column)).toEqual(['s', 'u', 'n']);
  });

  it('正常: boolean / date 型の参照は「null になります」の warning', () => {
    const input: Schema = {
      columns: [
        { name: 'b', type: 'boolean', nullable: false },
        { name: 'd', type: 'date', nullable: false },
      ],
    };
    const inference = calculateNode.inferSchema([input], config({ expression: '[b] + [d]' }));
    expect(inference.state).toBe('confirmed');
    expect(inference.issues.map((issue) => issue.severity)).toEqual(['warning', 'warning']);
    for (const issue of inference.issues) {
      expect(issue.message).toContain('null になります');
    }
  });

  it('異常: 参照する列が無ければ error issue と mismatch（出力列は付く）', () => {
    const inference = calculateNode.inferSchema([schema], config({ expression: '[金額] - [原価]' }));
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toHaveLength(1);
    expect(inference.issues[0]?.severity).toBe('error');
    expect(inference.issues[0]?.column).toBe('原価');
    expect(inference.schema.columns.map((column) => column.name)).toEqual([
      '金額',
      '数量',
      'memo',
      'result',
    ]);
  });

  it('異常: 空の式は「式を入力してください」の error と mismatch', () => {
    for (const expression of ['', '   ']) {
      const inference = calculateNode.inferSchema([schema], config({ expression }));
      expect(inference.state).toBe('mismatch');
      expect(inference.issues).toEqual([{ severity: 'error', message: '式を入力してください' }]);
      expect(inference.schema.columns).toHaveLength(schema.columns.length + 1);
    }
  });

  it('異常: 読めない式は位置つきの error issue', () => {
    const inference = calculateNode.inferSchema([schema], config({ expression: '[金額] + ' }));
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toHaveLength(1);
    // 位置は 1 起点で見せる（利用者が数える単位に合わせる）。
    expect(inference.issues[0]?.message).toMatch(/^式の \d+ 文字目: /);
  });

  it('異常: 知らない裸の識別子も読めない式として error', () => {
    const inference = calculateNode.inferSchema([schema], config({ expression: 'kingaku * 2' }));
    expect(inference.state).toBe('mismatch');
    expect(inference.issues[0]?.message).toContain('知らない名前');
  });

  it('例外: 入力が 1 つでなければ SchemaError', () => {
    expect(() => calculateNode.inferSchema([], config())).toThrowError(SchemaError);
    expect(() => calculateNode.inferSchema([schema, schema], config())).toThrowError(SchemaError);
  });
});

describe('calculate: execute', () => {
  it('正常: 行ごとに評価して列を足す（スキーマも inferSchema と同じ）', () => {
    const output = calculateNode.execute([table], config({ expression: '[金額] / [数量]' }));
    expect(output.rows).toEqual([
      { 金額: 300, 数量: 4, memo: 'a', result: 75 },
      { 金額: 1000, 数量: 8, memo: 'b', result: 125 },
    ]);
    expect(output.schema.columns).toEqual(
      calculateNode.inferSchema([schema], config({ expression: '[金額] / [数量]' })).schema.columns,
    );
  });

  it('正常: 同名の列は値もその位置で置き換わる', () => {
    const output = calculateNode.execute(
      [table],
      config({ outputColumn: '数量', expression: '[数量] * 10' }),
    );
    expect(output.rows[0]).toEqual({ 金額: 300, 数量: 40, memo: 'a' });
    expect(output.schema.columns.map((column) => column.name)).toEqual(['金額', '数量', 'memo']);
  });

  it('正常: 数値文字列は寄せ、寄せられない値は null', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'string', nullable: true }] },
      rows: [{ v: '42' }, { v: ' 1.5 ' }, { v: 'abc' }, { v: '' }, { v: null }],
    };
    const output = calculateNode.execute([input], config({ expression: '[v] * 2' }));
    expect(output.rows.map((row) => row['result'])).toEqual([84, 3, null, null, null]);
  });

  it('正常: boolean / date は数値に寄せず null', () => {
    const input: Table = {
      schema: {
        columns: [
          { name: 'b', type: 'boolean', nullable: false },
          { name: 'd', type: 'date', nullable: false },
        ],
      },
      rows: [{ b: true, d: new Date('2020-01-01T00:00:00Z') }],
    };
    expect(calculateNode.execute([input], config({ expression: '[b] + 1' })).rows[0]?.['result']).toBeNull();
    expect(calculateNode.execute([input], config({ expression: '[d] + 1' })).rows[0]?.['result']).toBeNull();
  });

  it('正常: precision は 0 から遠ざかる四捨五入', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'number', nullable: false }] },
      rows: [{ v: 1.25 }, { v: -1.25 }, { v: 2.4 }],
    };
    const output = calculateNode.execute([input], config({ expression: '[v]', precision: 1 }));
    // Math.round(-12.5) は -12 だが、負数も絶対値で丸めるので -1.3。
    expect(output.rows.map((row) => row['result'])).toEqual([1.3, -1.3, 2.4]);
  });

  it('境界: precision 0 は整数へ丸める。省略すると丸めない', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'number', nullable: false }] },
      rows: [{ v: 2.5 }, { v: -2.5 }],
    };
    expect(
      calculateNode.execute([input], config({ expression: '[v]', precision: 0 })).rows.map((row) => row['result']),
    ).toEqual([3, -3]);
    expect(
      calculateNode.execute([input], config({ expression: '[v] / 3' })).rows[0]?.['result'],
    ).toBeCloseTo(0.8333333333333334, 12);
  });

  it('境界: precision 15 でも丸められる', () => {
    const input: Table = {
      schema: { columns: [{ name: 'v', type: 'number', nullable: false }] },
      rows: [{ v: 0.5 }],
    };
    expect(
      calculateNode.execute([input], config({ expression: '[v]', precision: 15 })).rows[0]?.['result'],
    ).toBe(0.5);
  });

  it('正常: onError の既定は null で、評価できない行も残る', () => {
    const input: Table = {
      schema,
      rows: [
        { 金額: 300, 数量: 0, memo: 'a' },
        { 金額: 300, 数量: null, memo: 'b' },
        { 金額: 300, 数量: 4, memo: 'c' },
      ],
    };
    const output = calculateNode.execute([input], config({ expression: '[金額] / [数量]' }));
    expect(output.rows.map((row) => row['result'])).toEqual([null, null, 75]);
  });

  it('異常: onError:fail は行番号・式・理由つきの SchemaError', () => {
    const input: Table = {
      schema,
      rows: [
        { 金額: 300, 数量: 4, memo: 'a' },
        { 金額: 300, 数量: 0, memo: 'b' },
      ],
    };
    const cfg = config({ expression: '[金額] / [数量]', onError: 'fail' });
    expect(() => calculateNode.execute([input], cfg)).toThrowError(SchemaError);
    // 行番号は 1 起点。式と理由を添えて「どこを直せばよいか」を返す。
    expect(() => calculateNode.execute([input], cfg)).toThrowError(
      /行 2: 式 `\[金額\] \/ \[数量\]` を評価できません（0 で割っています）。/,
    );
    // 直す先まで書く（「評価できません」だけでは式・データ・上流のどれを見ればよいか分からない）。
    expect(() => calculateNode.execute([input], cfg)).toThrowError(/行フィルター/);
  });

  it('異常: 停止したときの理由は原因ごとに変わる（0 除算 / 欠損 / 定義域の外）', () => {
    const schema: Schema = { columns: [{ name: 'a', type: 'number', nullable: true }, { name: 'b', type: 'number', nullable: true }] };
    const run = (expression: string, row: Row) =>
      () => calculateNode.execute(
        [{ schema, rows: [row] }],
        calculateNode.validateConfig({ outputColumn: 'x', expression, onError: 'fail' }),
      );

    expect(run('[a] / [b]', { a: 1, b: 0 })).toThrowError(/0 で割っています/);
    expect(run('[a] + 1', { a: null, b: 1 })).toThrowError(/参照している列が空/);
    expect(run('sqrt([a])', { a: -1, b: 1 })).toThrowError(/定義域の外/);
    expect(run('exp([a])', { a: 1000, b: 1 })).toThrowError(/大きすぎて/);
    // 丸めの桁数は評価そのものは成功するので、理由は引数側になる。
    expect(run('round([a], 16)', { a: 1.5, b: 1 })).toThrowError(/引数が不正/);
  });

  it('異常: 読めない式・空の式で実行まで来たら ConfigError', () => {
    expect(() => calculateNode.execute([table], config({ expression: '[金額] +' }))).toThrowError(ConfigError);
    expect(() => calculateNode.execute([table], config({ expression: 'kingaku' }))).toThrowError(ConfigError);
    expect(() => calculateNode.execute([table], config({ expression: '' }))).toThrowError(ConfigError);
  });

  it('例外: 行が空でも落ちず、入力の行を書き換えない', () => {
    const empty: Table = { schema, rows: [] };
    const output = calculateNode.execute([empty], config({ expression: '[金額] * 2' }));
    expect(output.rows).toEqual([]);
    expect(output.schema.columns).toHaveLength(schema.columns.length + 1);

    const original = { ...table.rows[0] };
    calculateNode.execute([table], config({ expression: '[金額] * 2' }));
    expect(table.rows[0]).toEqual(original);
  });

  it('例外: 定数と関数だけの式は列が無くても計算できる', () => {
    const input: Table = { schema: { columns: [] }, rows: [{}, {}] };
    const output = calculateNode.execute([input], config({ expression: 'round(pi, 4)' }));
    expect(output.rows.map((row) => row['result'])).toEqual([3.1416, 3.1416]);
  });
});

describe('calculate: inferSchema と診断の一致', () => {
  // 判定の規則が 2 か所にあると、画面の案内・LLM への差し戻し・スキーマ推論で答えが食い違う。
  // ノードは validateExpression に委ね、issue は severity / message / column を写すだけ。
  it('例外: どの式でも issue は validateExpression の診断と 1 対 1 で対応する', () => {
    const expressions = [
      '[金額] / [数量]',
      'round(pi, 4)',
      '[memo] * 2',
      '[memo] + [原価]',
      '[原価] * 2',
      '',
      '   ',
      '[金額] + ',
      'kingaku * 2',
      'sqr([金額])',
      '[金額] * (1',
    ];
    for (const expression of expressions) {
      const inference = calculateNode.inferSchema([schema], config({ expression }));
      const validation = validateExpression(expression, schema);

      expect(`${expression}: ${inference.state}`).toBe(`${expression}: ${validation.ok ? 'confirmed' : 'mismatch'}`);
      expect(inference.issues).toHaveLength(validation.diagnostics.length);
      inference.issues.forEach((issue, index) => {
        const diagnostic = validation.diagnostics[index];
        expect(issue.severity).toBe(diagnostic?.severity);
        expect(issue.column).toBe(diagnostic?.column);
        // 位置が分かる診断にだけ 1 起点の案内を前置する（列の問題は式のどこも指さない）。
        expect(issue.message).toBe(
          diagnostic?.position === undefined
            ? diagnostic?.message
            : `式の ${diagnostic.position + 1} 文字目: ${diagnostic.message}`,
        );
      });
    }
  });
});

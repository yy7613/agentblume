/**
 * 期間の解釈ノード（`parse-period`）。
 *
 * 政府統計の `時点` 列は 1 列の中に粒度が混ざる（「1975年10月」「2024年1-3月期」「2024年」「2024年度」）。
 * ここで固定するのは「どのラベルをどう読むか」と「読めないラベルで落ちないこと」の 2 つ。
 * エンジンを通した一本の流れ（粒度で絞る → 開始日で範囲指定 → 並べ替え）は応用層
 * （`src/application/etl/parse-period.e2e.test.ts`）に置く（領域層から応用層を読み込まないため）。
 */
import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { PERIOD_GRANULARITIES, parsePeriodLabel, parsePeriodNode } from './parse-period';

/** ラベル 1 つを読んで `['ISO文字列 | null', 粒度]` にする（期待値を 1 行で書くため）。 */
function read(label: unknown, fiscalYearStartMonth = 4): readonly [string | null, string] {
  const parsed = parsePeriodLabel(label, fiscalYearStartMonth);
  return [parsed.start === null ? null : parsed.start.toISOString(), parsed.granularity];
}

const config = parsePeriodNode.validateConfig({ column: '時点' });

const inputSchema: Schema = {
  columns: [
    { name: '時点', type: 'string', nullable: true },
    { name: '値', type: 'number', nullable: true },
  ],
};

function tableOf(labels: readonly (string | null)[]): Table {
  return { schema: inputSchema, rows: labels.map((label, index) => ({ 時点: label, 値: index })) };
}

describe('parsePeriodLabel: 日本語の期間ラベル', () => {
  it('正常: 年月日・年月・年・年度をそれぞれの粒度で読む（年度は開始月から）', () => {
    expect(read('2024年3月15日')).toEqual(['2024-03-15T00:00:00.000Z', 'day']);
    expect(read('1975年10月')).toEqual(['1975-10-01T00:00:00.000Z', 'month']);
    expect(read('2024年')).toEqual(['2024-01-01T00:00:00.000Z', 'year']);
    expect(read('2024年度')).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
  });

  it('正常: 「M-N月期」は 3 か月なら四半期、6 か月なら半期として読む', () => {
    expect(read('2024年1-3月期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年10-12月期')).toEqual(['2024-10-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年1-6月期')).toEqual(['2024-01-01T00:00:00.000Z', 'half']);
  });

  it('正常: 波ダッシュ・全角チルダ・「M月〜N月」表記も同じ結果になる', () => {
    expect(read('2024年1〜3月期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年1～3月期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年1月～3月')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年1月-3月')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
  });

  it('境界: 3・6 か月以外の span は粒度 unknown だが開始日は入れる（捨てない）', () => {
    expect(read('2024年1-2月期')).toEqual(['2024-01-01T00:00:00.000Z', 'unknown']);
    expect(read('2024年1-12月期')).toEqual(['2024-01-01T00:00:00.000Z', 'unknown']);
  });

  it('境界: 年をまたぐ span（11-1月期）は 3 か月として四半期になる', () => {
    expect(read('2024年11-1月期')).toEqual(['2024-11-01T00:00:00.000Z', 'quarter']);
  });

  it('正常: 第N四半期は暦年なら 1 月起点、年度なら年度の開始月起点で読む', () => {
    expect(read('2024年第1四半期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年第4四半期')).toEqual(['2024-10-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年度第1四半期')).toEqual(['2024-04-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年度第3四半期')).toEqual(['2024-10-01T00:00:00.000Z', 'quarter']);
  });

  it('境界: 年度第4四半期は翌年の 1 月へ繰り上がる', () => {
    expect(read('2024年度第4四半期')).toEqual(['2025-01-01T00:00:00.000Z', 'quarter']);
  });

  it('正常: 年度の上期・下期は半期として読む', () => {
    expect(read('2024年度上期')).toEqual(['2024-04-01T00:00:00.000Z', 'half']);
    expect(read('2024年度下期')).toEqual(['2024-10-01T00:00:00.000Z', 'half']);
  });

  it('正常: 年度の開始月が 4 以外でも、年度・年度四半期・上期/下期がその月から始まる', () => {
    expect(read('2024年度', 1)).toEqual(['2024-01-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('2024年度', 10)).toEqual(['2024-10-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('2024年度第1四半期', 10)).toEqual(['2024-10-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年度第2四半期', 10)).toEqual(['2025-01-01T00:00:00.000Z', 'quarter']);
    expect(read('2024年度下期', 10)).toEqual(['2025-04-01T00:00:00.000Z', 'half']);
  });

  it('境界: 年度の開始月は暦年の粒度（年・月・四半期）には影響しない', () => {
    expect(read('2024年', 10)).toEqual(['2024-01-01T00:00:00.000Z', 'year']);
    expect(read('2024年5月', 10)).toEqual(['2024-05-01T00:00:00.000Z', 'month']);
    expect(read('2024年第1四半期', 10)).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
  });

  it('正常: 全角数字・全角スペースを含むラベルも半角と同じに読む', () => {
    expect(read('２０２４年１０月')).toEqual(['2024-10-01T00:00:00.000Z', 'month']);
    expect(read('２０２４年１-３月期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('　2024年度　')).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read(' 1975年10月 ')).toEqual(['1975-10-01T00:00:00.000Z', 'month']);
  });
});

describe('parsePeriodLabel: 和暦', () => {
  it('正常: 元号ごとの元年が西暦に対応する', () => {
    expect(read('明治元年')).toEqual(['1868-01-01T00:00:00.000Z', 'year']);
    expect(read('大正元年')).toEqual(['1912-01-01T00:00:00.000Z', 'year']);
    expect(read('昭和元年')).toEqual(['1926-01-01T00:00:00.000Z', 'year']);
    expect(read('平成元年')).toEqual(['1989-01-01T00:00:00.000Z', 'year']);
    expect(read('令和元年')).toEqual(['2019-01-01T00:00:00.000Z', 'year']);
  });

  it('正常: 和暦は月・年度・四半期など後ろの形と組み合わせても読める', () => {
    expect(read('平成20年4月')).toEqual(['2008-04-01T00:00:00.000Z', 'month']);
    expect(read('令和元年度')).toEqual(['2019-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('昭和50年10月')).toEqual(['1975-10-01T00:00:00.000Z', 'month']);
    expect(read('令和6年1-3月期')).toEqual(['2024-01-01T00:00:00.000Z', 'quarter']);
    expect(read('平成31年4月1日')).toEqual(['2019-04-01T00:00:00.000Z', 'day']);
    expect(read('令和6年度第1四半期')).toEqual(['2024-04-01T00:00:00.000Z', 'quarter']);
  });

  it('異常: 元号らしき語でも知らない元号は解釈しない', () => {
    expect(read('大宝元年')).toEqual([null, 'unknown']);
  });
});

describe('parsePeriodLabel: 西洋式の表記', () => {
  it('正常: ISO・スラッシュ区切りの年月日と年月を読む', () => {
    expect(read('2024-03-15')).toEqual(['2024-03-15T00:00:00.000Z', 'day']);
    expect(read('2024/03/15')).toEqual(['2024-03-15T00:00:00.000Z', 'day']);
    expect(read('2024-03')).toEqual(['2024-03-01T00:00:00.000Z', 'month']);
    expect(read('2024/3')).toEqual(['2024-03-01T00:00:00.000Z', 'month']);
  });

  it('正常: 6 桁の YYYYMM・四半期・FY・年を読む', () => {
    expect(read('202403')).toEqual(['2024-03-01T00:00:00.000Z', 'month']);
    expect(read('2024Q2')).toEqual(['2024-04-01T00:00:00.000Z', 'quarter']);
    expect(read('2024-Q4')).toEqual(['2024-10-01T00:00:00.000Z', 'quarter']);
    expect(read('FY2024')).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('FY 2024')).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('2024')).toEqual(['2024-01-01T00:00:00.000Z', 'year']);
  });

  it('正常: FY は年度の開始月に従う', () => {
    expect(read('FY2024', 10)).toEqual(['2024-10-01T00:00:00.000Z', 'fiscal-year']);
  });

  it('境界: 6 桁でも月が 01..12 でなければ解釈しない', () => {
    expect(read('202400')).toEqual([null, 'unknown']);
    expect(read('202413')).toEqual([null, 'unknown']);
    expect(read('202412')).toEqual(['2024-12-01T00:00:00.000Z', 'month']);
  });
});

describe('parsePeriodLabel: セルの型', () => {
  it('正常: Date のセルはその日付をそのまま使い、粒度は day になる', () => {
    const date = new Date('2024-03-15T00:00:00.000Z');
    const parsed = parsePeriodLabel(date, 4);
    expect(parsed.granularity).toBe('day');
    expect(parsed.start?.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('正常: 数値のセルは文字列と同じ規則で読む（2024 は年、202403 は月）', () => {
    expect(read(2024)).toEqual(['2024-01-01T00:00:00.000Z', 'year']);
    expect(read(202403)).toEqual(['2024-03-01T00:00:00.000Z', 'month']);
  });

  it('異常: null・空文字・空白だけ・真偽値は解釈しない', () => {
    expect(read(null)).toEqual([null, 'unknown']);
    expect(read(undefined)).toEqual([null, 'unknown']);
    expect(read('')).toEqual([null, 'unknown']);
    expect(read('　 ')).toEqual([null, 'unknown']);
    expect(read(true)).toEqual([null, 'unknown']);
  });

  it('異常: 不正な Date・非有限の数値は解釈しない', () => {
    expect(read(new Date('nonsense'))).toEqual([null, 'unknown']);
    expect(read(Number.NaN)).toEqual([null, 'unknown']);
    expect(read(Number.POSITIVE_INFINITY)).toEqual([null, 'unknown']);
  });
});

describe('parsePeriodLabel: 読めないラベル', () => {
  it('異常: 月・日が範囲外のラベルは unknown（黙って繰り上げない）', () => {
    expect(read('2024年13月')).toEqual([null, 'unknown']);
    expect(read('2024年0月')).toEqual([null, 'unknown']);
    expect(read('2024年2月30日')).toEqual([null, 'unknown']);
    expect(read('2024-02-30')).toEqual([null, 'unknown']);
    expect(read('2023年2月29日')).toEqual([null, 'unknown']);
  });

  it('境界: うるう年の 2月29日は読める', () => {
    expect(read('2024年2月29日')).toEqual(['2024-02-29T00:00:00.000Z', 'day']);
  });

  it('境界: 年は 1..9999 の範囲だけを読む', () => {
    expect(read('0年')).toEqual([null, 'unknown']);
    expect(read('1年')).toEqual(['0001-01-01T00:00:00.000Z', 'year']);
    expect(read('9999年12月')).toEqual(['9999-12-01T00:00:00.000Z', 'month']);
  });

  it('異常: 四半期の番号が 1..4 の外なら unknown', () => {
    expect(read('2024年第5四半期')).toEqual([null, 'unknown']);
    expect(read('2024年第0四半期')).toEqual([null, 'unknown']);
    expect(read('2024Q5')).toEqual([null, 'unknown']);
  });

  it('異常: 期間ラベルでない文字列は unknown（例外を投げない）', () => {
    expect(read('全国')).toEqual([null, 'unknown']);
    expect(read('－')).toEqual([null, 'unknown']);
    expect(read('X')).toEqual([null, 'unknown']);
    expect(read('2024年ごろ')).toEqual([null, 'unknown']);
  });

  it('境界: 年度の開始月が範囲外で渡されても 4 として扱い、投げない', () => {
    expect(read('2024年度', 0)).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('2024年度', 13)).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    expect(read('2024年度', Number.NaN)).toEqual(['2024-04-01T00:00:00.000Z', 'fiscal-year']);
    // 既定引数（省略）も 4。
    expect(parsePeriodLabel('2024年度').start?.toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });
});

describe('PERIOD_GRANULARITIES', () => {
  it('正常: 粒度の正準リストは 7 種で、実際に出る値をすべて含む', () => {
    expect([...PERIOD_GRANULARITIES]).toEqual(['day', 'month', 'quarter', 'half', 'year', 'fiscal-year', 'unknown']);
    const produced = ['2024年3月1日', '2024年3月', '2024年1-3月期', '2024年度上期', '2024年', '2024年度', '全国']
      .map((label) => parsePeriodLabel(label, 4).granularity);
    expect(new Set(produced)).toEqual(new Set(PERIOD_GRANULARITIES));
  });
});

describe('parse-period: 契約（種別・設定）', () => {
  it('正常: transform / 入力 1 のノードである', () => {
    expect(parsePeriodNode.type).toBe('parse-period');
    expect(parsePeriodNode.kind).toBe('transform');
    expect(parsePeriodNode.inputArity).toBe(1);
  });

  it('正常: column だけ指定すれば残りは既定値が入る', () => {
    expect(parsePeriodNode.validateConfig({ column: '時点' })).toEqual({
      column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4,
    });
  });

  it('正常: 出力列名と年度の開始月は上書きできる', () => {
    expect(parsePeriodNode.validateConfig({ column: 't', startColumn: '開始日', granularityColumn: '粒度', fiscalYearStartMonth: 1 }))
      .toEqual({ column: 't', startColumn: '開始日', granularityColumn: '粒度', fiscalYearStartMonth: 1 });
  });

  it('例外: column が無い / 空文字なら ConfigError', () => {
    expect(() => parsePeriodNode.validateConfig({})).toThrowError(ConfigError);
    expect(() => parsePeriodNode.validateConfig({ column: '' })).toThrowError(ConfigError);
  });

  it('例外: 年度の開始月が 1..12 の整数でなければ ConfigError', () => {
    expect(() => parsePeriodNode.validateConfig({ column: 't', fiscalYearStartMonth: 0 })).toThrowError(ConfigError);
    expect(() => parsePeriodNode.validateConfig({ column: 't', fiscalYearStartMonth: 13 })).toThrowError(ConfigError);
    expect(() => parsePeriodNode.validateConfig({ column: 't', fiscalYearStartMonth: 4.5 })).toThrowError(ConfigError);
  });

  it('境界: 年度の開始月は 1 と 12 を受け付ける', () => {
    expect(parsePeriodNode.validateConfig({ column: 't', fiscalYearStartMonth: 1 }).fiscalYearStartMonth).toBe(1);
    expect(parsePeriodNode.validateConfig({ column: 't', fiscalYearStartMonth: 12 }).fiscalYearStartMonth).toBe(12);
  });

  it('例外: 出力列名が空文字なら ConfigError', () => {
    expect(() => parsePeriodNode.validateConfig({ column: 't', startColumn: '' })).toThrowError(ConfigError);
    expect(() => parsePeriodNode.validateConfig({ column: 't', granularityColumn: '' })).toThrowError(ConfigError);
  });
});

describe('parse-period: inferSchema', () => {
  it('正常: 入力列の後ろに 開始日(date, null可) と 粒度(string, null不可) を足し、confirmed になる', () => {
    const result = parsePeriodNode.inferSchema([inputSchema], config);
    expect(result.state).toBe('confirmed');
    expect(result.issues).toEqual([]);
    expect(result.schema.columns).toEqual([
      { name: '時点', type: 'string', nullable: true },
      { name: '値', type: 'number', nullable: true },
      { name: 'periodStart', type: 'date', nullable: true },
      { name: 'periodGranularity', type: 'string', nullable: false },
    ]);
  });

  it('異常: 対象列が無ければ error issue と mismatch（入力スキーマのまま返す）', () => {
    const result = parsePeriodNode.inferSchema([inputSchema], parsePeriodNode.validateConfig({ column: '年月' }));
    expect(result.state).toBe('mismatch');
    expect(result.schema).toEqual(inputSchema);
    expect(result.issues).toEqual([{ severity: 'error', message: 'parse-period: column not found: 年月', column: '年月' }]);
  });

  it('異常: 足す列名が上流に既にあれば、どちらの列かが分かる error issue になる', () => {
    const schema: Schema = { columns: [...inputSchema.columns, { name: 'periodStart', type: 'string', nullable: true }] };
    const result = parsePeriodNode.inferSchema([schema], config);
    expect(result.state).toBe('mismatch');
    expect(result.issues.map((issue) => issue.message)).toEqual(['parse-period: start column already exists: periodStart']);

    const other: Schema = { columns: [...inputSchema.columns, { name: 'periodGranularity', type: 'string', nullable: true }] };
    expect(parsePeriodNode.inferSchema([other], config).issues.map((issue) => issue.message))
      .toEqual(['parse-period: granularity column already exists: periodGranularity']);
  });

  it('異常: 2 つの出力列名が同じなら error issue になる', () => {
    const same = parsePeriodNode.validateConfig({ column: '時点', startColumn: '期間', granularityColumn: '期間' });
    const result = parsePeriodNode.inferSchema([inputSchema], same);
    expect(result.state).toBe('mismatch');
    expect(result.issues.map((issue) => issue.message)).toEqual(['parse-period: start column and granularity column must differ: 期間']);
  });

  it('境界: 入力が無い（未接続）ときは列不存在の issue になり、投げない', () => {
    const result = parsePeriodNode.inferSchema([], config);
    expect(result.state).toBe('mismatch');
    expect(result.issues[0]?.message).toBe('parse-period: column not found: 時点');
  });
});

describe('parse-period: execute', () => {
  it('正常: 粒度の違うラベルが混ざっていても、行ごとに開始日と粒度を足す', () => {
    const table = tableOf(['1975年10月', '2024年1-3月期', '2024年', '2024年度']);
    const output = parsePeriodNode.execute([table], config);

    expect(output.rows.map((row) => (row['periodStart'] as Date | null)?.toISOString() ?? null)).toEqual([
      '1975-10-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      '2024-04-01T00:00:00.000Z',
    ]);
    expect(output.rows.map((row) => row['periodGranularity'])).toEqual(['month', 'quarter', 'year', 'fiscal-year']);
    // 元の列は残る。
    expect(output.rows.map((row) => row['値'])).toEqual([0, 1, 2, 3]);
  });

  it('異常: 読めない行・null の行でも止まらず、開始日 null / 粒度 unknown で通す', () => {
    const output = parsePeriodNode.execute([tableOf(['全国', null, '', '2024年'])], config);
    expect(output.rows.map((row) => row['periodStart'])).toEqual([null, null, null, new Date('2024-01-01T00:00:00.000Z')]);
    expect(output.rows.map((row) => row['periodGranularity'])).toEqual(['unknown', 'unknown', 'unknown', 'year']);
  });

  it('正常: 出力スキーマは inferSchema と同じ（列の順序も）', () => {
    const output = parsePeriodNode.execute([tableOf(['2024年'])], config);
    expect(output.schema).toEqual(parsePeriodNode.inferSchema([inputSchema], config).schema);
  });

  it('正常: 年度の開始月の設定が実行にも効く', () => {
    const october = parsePeriodNode.validateConfig({ column: '時点', fiscalYearStartMonth: 10 });
    const output = parsePeriodNode.execute([tableOf(['2024年度'])], october);
    expect((output.rows[0]?.['periodStart'] as Date).toISOString()).toBe('2024-10-01T00:00:00.000Z');
  });

  it('境界: 行が 0 件でもスキーマだけ増えた空のテーブルを返す', () => {
    const output = parsePeriodNode.execute([tableOf([])], config);
    expect(output.rows).toEqual([]);
    expect(output.schema.columns.map((column) => column.name)).toEqual(['時点', '値', 'periodStart', 'periodGranularity']);
  });

  it('正常: 入力テーブルを書き換えない（行オブジェクトも別物を返す）', () => {
    const table = tableOf(['2024年']);
    const before = structuredClone(table.rows);
    const output = parsePeriodNode.execute([table], config);

    expect(table.rows).toEqual(before);
    expect(table.schema).toEqual(inputSchema);
    expect(output.rows[0]).not.toBe(table.rows[0]);
  });

  it('例外: 対象列が無ければ SchemaError（issue と同じ文言）', () => {
    expect(() => parsePeriodNode.execute([tableOf(['2024年'])], parsePeriodNode.validateConfig({ column: '年月' })))
      .toThrowError(new SchemaError('parse-period: column not found: 年月'));
  });

  it('例外: 足す列名が既にある / 2 つの出力列名が同じなら ConfigError（issue と同じ文言）', () => {
    const table: Table = {
      schema: { columns: [...inputSchema.columns, { name: 'periodStart', type: 'string', nullable: true }] },
      rows: [{ 時点: '2024年', 値: 0, periodStart: 'x' }],
    };
    expect(() => parsePeriodNode.execute([table], config)).toThrowError(new ConfigError('parse-period: start column already exists: periodStart'));

    const same = parsePeriodNode.validateConfig({ column: '時点', startColumn: '期間', granularityColumn: '期間' });
    expect(() => parsePeriodNode.execute([tableOf(['2024年'])], same))
      .toThrowError(new ConfigError('parse-period: start column and granularity column must differ: 期間'));
  });
});

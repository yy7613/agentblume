import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import {
  AI_JUDGE_DEFAULT_MAX_ITEMS,
  AI_JUDGE_MAX_ITEMS,
  AI_JUDGE_UNCLEAR,
  aiJudgeAllowedValues,
  aiJudgeColumns,
  aiJudgeIssues,
  aiJudgeItemKey,
  aiJudgeItemValues,
  aiJudgeMode,
  aiJudgeNode,
  type AiJudgeConfig,
  type AiJudgeVerdict,
} from './ai-judge';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'body', type: 'string', nullable: false },
    { name: 'at', type: 'date', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, body: '商品が壊れていました', at: new Date('2026-01-01T00:00:00.000Z') },
    { id: 2, body: '発送はいつですか', at: null },
  ],
};

/** validateConfig を通して既定を埋めた設定を作る（execute / inferSchema は既定込みの設定を受ける）。 */
function configOf(partial: Record<string, unknown> = {}): AiJudgeConfig {
  return aiJudgeNode.validateConfig({ question: 'これはクレームですか？', ...partial });
}

/** 与えた行にそのまま対応する verdicts（キーは aiJudgeItemKey）。 */
function verdictsFor(rows: readonly Record<string, unknown>[], columns: readonly string[], values: readonly AiJudgeVerdict[]): Record<string, AiJudgeVerdict> {
  const verdicts: Record<string, AiJudgeVerdict> = {};
  rows.forEach((row, index) => {
    const verdict = values[index];
    if (verdict !== undefined) verdicts[aiJudgeItemKey(row as Table['rows'][number], columns)] = verdict;
  });
  return verdicts;
}

describe('ai-judge: metadata', () => {
  it('type / kind / arity は transform の 1 入力', () => {
    expect(aiJudgeNode.type).toBe('ai-judge');
    expect(aiJudgeNode.kind).toBe('transform');
    expect(aiJudgeNode.inputArity).toBe(1);
  });
});

describe('ai-judge: validateConfig', () => {
  it('空の config は既定で埋まる（はい/いいえ・flag・aiVerdict / aiReason）', () => {
    const config = aiJudgeNode.validateConfig({});
    expect(config).toMatchObject({
      configVersion: 1,
      question: '',
      categories: [],
      columns: [],
      outputColumn: 'aiVerdict',
      reasonColumn: 'aiReason',
      action: 'flag',
      matchValues: ['yes'],
      maxItems: AI_JUDGE_DEFAULT_MAX_ITEMS,
    });
    expect(config.resolved).toBeUndefined();
  });

  it('reasonColumn は null を受ける（理由列を出さない）', () => {
    expect(aiJudgeNode.validateConfig({ reasonColumn: null }).reasonColumn).toBeNull();
  });

  it('resolved を持つ config も通る（アプリ層が注入した判定をそのまま受け取る）', () => {
    const config = aiJudgeNode.validateConfig({ resolved: { verdicts: { '["a"]': { value: 'yes', reason: 'r' } } } });
    expect(config.resolved?.verdicts['["a"]']).toEqual({ value: 'yes', reason: 'r' });
  });

  it.each([
    ['action が未知の語', { action: 'drop' }],
    ['configVersion が 1 以外', { configVersion: 2 }],
    ['outputColumn が空文字', { outputColumn: '' }],
    ['reasonColumn が空文字', { reasonColumn: '' }],
    ['maxItems が 0', { maxItems: 0 }],
    ['maxItems が上限超過', { maxItems: AI_JUDGE_MAX_ITEMS + 1 }],
    ['maxItems が小数', { maxItems: 1.5 }],
    ['categories の name が空', { categories: [{ name: '' }] }],
    ['columns が文字列の配列でない', { columns: [1] }],
    ['matchValues に空文字', { matchValues: [''] }],
    ['question が長すぎる', { question: 'あ'.repeat(2001) }],
    ['resolved.verdicts の形が違う', { resolved: { verdicts: { k: { value: 'yes' } } } }],
  ])('%s は ConfigError', (_name, partial) => {
    expect(() => aiJudgeNode.validateConfig(partial)).toThrowError(ConfigError);
  });
});

describe('ai-judge: aiJudgeMode / aiJudgeAllowedValues', () => {
  it('categories が空なら yes-no（yes / no / unclear）', () => {
    expect(aiJudgeMode({ categories: [] })).toBe('yes-no');
    expect(aiJudgeAllowedValues({ categories: [] })).toEqual(['yes', 'no', AI_JUDGE_UNCLEAR]);
  });

  it('categories があれば classify（カテゴリ名 + unclear。並びはカテゴリの順）', () => {
    const categories = [{ name: 'クレーム' }, { name: '問い合わせ' }];
    expect(aiJudgeMode({ categories })).toBe('classify');
    expect(aiJudgeAllowedValues({ categories })).toEqual(['クレーム', '問い合わせ', AI_JUDGE_UNCLEAR]);
  });
});

describe('ai-judge: aiJudgeColumns', () => {
  it('columns が空なら入力の全列を入力スキーマの並びで返す', () => {
    expect(aiJudgeColumns(schema, { columns: [] })).toEqual(['id', 'body', 'at']);
  });

  it('columns の指定があればその指定をそのまま使う（並びも指定どおり）', () => {
    expect(aiJudgeColumns(schema, { columns: ['body', 'id'] })).toEqual(['body', 'id']);
  });
});

describe('ai-judge: aiJudgeItemKey / aiJudgeItemValues', () => {
  const columns = ['id', 'body'];

  it('同じ内容の行は同じキーになる（重複除外・判定の再利用の土台）', () => {
    expect(aiJudgeItemKey({ id: 1, body: 'x' }, columns)).toBe(aiJudgeItemKey({ id: 1, body: 'x' }, columns));
  });

  it('値が違えばキーも違う', () => {
    expect(aiJudgeItemKey({ id: 1, body: 'x' }, columns)).not.toBe(aiJudgeItemKey({ id: 2, body: 'x' }, columns));
  });

  it('行のプロパティの並びが違ってもキーは同じ（列の並びは columns で固定される）', () => {
    expect(aiJudgeItemKey({ body: 'x', id: 1 }, columns)).toBe(aiJudgeItemKey({ id: 1, body: 'x' }, columns));
  });

  it('columns の並びが違えばキーは違う（列の並びは判定の入力の一部）', () => {
    expect(aiJudgeItemKey({ id: 1, body: 'x' }, ['id', 'body'])).not.toBe(aiJudgeItemKey({ id: 1, body: 'x' }, ['body', 'id']));
  });

  it('見ない列の違いはキーに影響しない', () => {
    expect(aiJudgeItemKey({ id: 1, body: 'x', other: 'a' }, columns)).toBe(aiJudgeItemKey({ id: 1, body: 'x', other: 'b' }, columns));
  });

  it('Date セルは ISO 文字列になる（同じ時刻の別インスタンスが同じキーになる）', () => {
    const a = aiJudgeItemKey({ at: new Date('2026-01-01T00:00:00.000Z') }, ['at']);
    const b = aiJudgeItemKey({ at: new Date('2026-01-01T00:00:00.000Z') }, ['at']);
    expect(a).toBe(b);
    expect(a).toContain('2026-01-01T00:00:00.000Z');
  });

  it('欠けた列は null として扱う（undefined と null が同じキーになる）', () => {
    expect(aiJudgeItemKey({ id: 1 }, columns)).toBe(aiJudgeItemKey({ id: 1, body: null }, columns));
  });

  it('aiJudgeItemValues はキーと同じ並び・同じ正規化（Date は ISO、欠けは null）', () => {
    expect(aiJudgeItemValues({ body: 'x', at: new Date('2026-01-01T00:00:00.000Z') }, ['id', 'body', 'at'])).toEqual({
      id: null, body: 'x', at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('ai-judge: aiJudgeIssues', () => {
  it('問題が無ければ空', () => {
    expect(aiJudgeIssues(schema, configOf())).toEqual([]);
  });

  it('question が空白だけなら error', () => {
    expect(aiJudgeIssues(schema, configOf({ question: '   ' }))).toEqual([
      { severity: 'error', message: 'ai-judge: question is required' },
    ]);
  });

  it('存在しない列を指定したら列名つきの error', () => {
    expect(aiJudgeIssues(schema, configOf({ columns: ['missing'] }))).toEqual([
      { severity: 'error', message: 'ai-judge: column not found: missing', column: 'missing' },
    ]);
  });

  it('カテゴリ名に予約語 unclear は使えない', () => {
    const issues = aiJudgeIssues(schema, configOf({ categories: [{ name: AI_JUDGE_UNCLEAR }], action: 'flag' }));
    expect(issues.map((issue) => issue.message)).toContain('ai-judge: category name is reserved: unclear');
  });

  it('カテゴリ名の重複は error', () => {
    const issues = aiJudgeIssues(schema, configOf({ categories: [{ name: 'a' }, { name: 'a' }] }));
    expect(issues.map((issue) => issue.message)).toContain('ai-judge: duplicate category: a');
  });

  it.each(['keep', 'exclude'] as const)('%s で matchValues が空なら error', (action) => {
    expect(aiJudgeIssues(schema, configOf({ action, matchValues: [] })).map((issue) => issue.message)).toContain(
      `ai-judge: matchValues is required when action is ${action}`,
    );
  });

  it('matchValues に「起こりえない判定値」があれば error', () => {
    expect(aiJudgeIssues(schema, configOf({ action: 'keep', matchValues: ['maybe'] })).map((issue) => issue.message)).toContain(
      'ai-judge: match value is not a possible verdict: maybe',
    );
  });

  it('classify の matchValues はカテゴリ名と unclear だけを受ける', () => {
    const base = { action: 'keep' as const, categories: [{ name: 'クレーム' }] };
    expect(aiJudgeIssues(schema, configOf({ ...base, matchValues: ['クレーム', AI_JUDGE_UNCLEAR] }))).toEqual([]);
    // yes は はい/いいえモードの語で、分類モードでは起こりえない。
    expect(aiJudgeIssues(schema, configOf({ ...base, matchValues: ['yes'] })).map((issue) => issue.message)).toContain(
      'ai-judge: match value is not a possible verdict: yes',
    );
  });

  it('flag で出力列が既存列とぶつかれば列名つきの error', () => {
    expect(aiJudgeIssues(schema, configOf({ outputColumn: 'body' }))).toContainEqual({
      severity: 'error', message: 'ai-judge: output column already exists: body', column: 'body',
    });
  });

  it('flag で理由列が既存列とぶつかれば列名つきの error', () => {
    expect(aiJudgeIssues(schema, configOf({ reasonColumn: 'body' }))).toContainEqual({
      severity: 'error', message: 'ai-judge: reason column already exists: body', column: 'body',
    });
  });

  it('flag で理由列と出力列が同じなら error', () => {
    expect(aiJudgeIssues(schema, configOf({ outputColumn: 'v', reasonColumn: 'v' })).map((issue) => issue.message)).toContain(
      'ai-judge: reason column must differ from the output column: v',
    );
  });

  it('keep / exclude は列を足さないので、出力列の衝突は検査しない', () => {
    expect(aiJudgeIssues(schema, configOf({ action: 'keep', outputColumn: 'body', reasonColumn: 'body' }))).toEqual([]);
  });

  it('matchValues の検査は flag では行わない（flag は全行を通すので一致の概念が無い）', () => {
    expect(aiJudgeIssues(schema, configOf({ action: 'flag', matchValues: [] }))).toEqual([]);
  });
});

describe('ai-judge: inferSchema', () => {
  it('flag は判定列（非 null 文字列）と理由列（null 可）を足して confirmed', () => {
    const inference = aiJudgeNode.inferSchema([schema], configOf());
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema.columns).toEqual([
      ...schema.columns,
      { name: 'aiVerdict', type: 'string', nullable: false },
      { name: 'aiReason', type: 'string', nullable: true },
    ]);
  });

  it('reasonColumn が null なら理由列は足さない', () => {
    const inference = aiJudgeNode.inferSchema([schema], configOf({ reasonColumn: null }));
    expect(inference.schema.columns.map((column) => column.name)).toEqual(['id', 'body', 'at', 'aiVerdict']);
  });

  it('出力列名を変えれば、その名前で足される', () => {
    const inference = aiJudgeNode.inferSchema([schema], configOf({ outputColumn: '判定', reasonColumn: '理由' }));
    expect(inference.schema.columns.map((column) => column.name)).toEqual(['id', 'body', 'at', '判定', '理由']);
  });

  it.each(['keep', 'exclude'] as const)('%s はスキーマを変えない（行を絞るだけ）', (action) => {
    const inference = aiJudgeNode.inferSchema([schema], configOf({ action }));
    expect(inference.state).toBe('confirmed');
    expect(inference.schema).toEqual(schema);
  });

  it('issue があれば mismatch で、スキーマは入力のまま（列を足さない）', () => {
    const inference = aiJudgeNode.inferSchema([schema], configOf({ question: '' }));
    expect(inference.state).toBe('mismatch');
    expect(inference.schema).toEqual(schema);
    expect(inference.issues).toHaveLength(1);
  });

  it('入力が無い（未接続）ときは空スキーマ扱いで、question があっても issue にはならない', () => {
    const inference = aiJudgeNode.inferSchema([], configOf());
    expect(inference.state).toBe('confirmed');
    expect(inference.schema.columns.map((column) => column.name)).toEqual(['aiVerdict', 'aiReason']);
  });

  it('resolved の有無は inferSchema に影響しない（スキーマは判定前から確定する）', () => {
    const withoutResolved = aiJudgeNode.inferSchema([schema], configOf());
    const withResolved = aiJudgeNode.inferSchema([schema], configOf({ resolved: { verdicts: {} } }));
    expect(withResolved.schema).toEqual(withoutResolved.schema);
  });
});

describe('ai-judge: execute', () => {
  const columns = ['id', 'body', 'at'];

  it('flag は全行を通し、判定と理由を列として足す', () => {
    const config = configOf({
      resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'yes', reason: '破損の申告' }, { value: 'no', reason: '納期の質問' }]) },
    });
    const out = aiJudgeNode.execute([table], config);
    expect(out.schema.columns.map((column) => column.name)).toEqual(['id', 'body', 'at', 'aiVerdict', 'aiReason']);
    expect(out.rows.map((row) => [row['id'], row['aiVerdict'], row['aiReason']])).toEqual([
      [1, 'yes', '破損の申告'],
      [2, 'no', '納期の質問'],
    ]);
  });

  it('reasonColumn が null なら理由列を出さない', () => {
    const config = configOf({
      reasonColumn: null,
      resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'yes', reason: 'r' }, { value: 'no', reason: 'r' }]) },
    });
    const out = aiJudgeNode.execute([table], config);
    expect(out.schema.columns.map((column) => column.name)).toEqual(['id', 'body', 'at', 'aiVerdict']);
    expect(out.rows[0]).not.toHaveProperty('aiReason');
  });

  it('keep は matchValues に一致した行だけを残す（スキーマは変えない）', () => {
    const config = configOf({
      action: 'keep', matchValues: ['yes'],
      resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'yes', reason: 'r' }, { value: 'no', reason: 'r' }]) },
    });
    const out = aiJudgeNode.execute([table], config);
    expect(out.schema).toEqual(schema);
    expect(out.rows.map((row) => row['id'])).toEqual([1]);
  });

  it('exclude は一致した行を除く', () => {
    const config = configOf({
      action: 'exclude', matchValues: ['yes'],
      resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'yes', reason: 'r' }, { value: 'no', reason: 'r' }]) },
    });
    expect(aiJudgeNode.execute([table], config).rows.map((row) => row['id'])).toEqual([2]);
  });

  it('unclear は matchValues に挙げない限り「一致しない」（keep では落ち、exclude では残る）', () => {
    const verdicts = verdictsFor(table.rows, columns, [{ value: AI_JUDGE_UNCLEAR, reason: '判断できない' }, { value: 'yes', reason: 'r' }]);
    const keep = aiJudgeNode.execute([table], configOf({ action: 'keep', matchValues: ['yes'], resolved: { verdicts } }));
    expect(keep.rows.map((row) => row['id'])).toEqual([2]);
    const exclude = aiJudgeNode.execute([table], configOf({ action: 'exclude', matchValues: ['yes'], resolved: { verdicts } }));
    expect(exclude.rows.map((row) => row['id'])).toEqual([1]);
  });

  it('unclear を matchValues に挙げれば keep の対象になる（「判断できない行だけ見る」運用）', () => {
    const verdicts = verdictsFor(table.rows, columns, [{ value: AI_JUDGE_UNCLEAR, reason: 'r' }, { value: 'yes', reason: 'r' }]);
    const out = aiJudgeNode.execute([table], configOf({ action: 'keep', matchValues: [AI_JUDGE_UNCLEAR], resolved: { verdicts } }));
    expect(out.rows.map((row) => row['id'])).toEqual([1]);
  });

  it('分類モードはカテゴリ名をそのまま判定列に置く', () => {
    const config = configOf({
      categories: [{ name: 'クレーム' }, { name: '問い合わせ' }],
      resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'クレーム', reason: 'r' }, { value: '問い合わせ', reason: 'r' }]) },
    });
    expect(aiJudgeNode.execute([table], config).rows.map((row) => row['aiVerdict'])).toEqual(['クレーム', '問い合わせ']);
  });

  it('判定の無い行は unclear + 「判定が返らなかった」理由になる（黙って通さない・落とさない）', () => {
    const config = configOf({ resolved: { verdicts: verdictsFor(table.rows, columns, [{ value: 'yes', reason: 'r' }]) } });
    const out = aiJudgeNode.execute([table], config);
    expect(out.rows[1]).toMatchObject({ aiVerdict: AI_JUDGE_UNCLEAR, aiReason: 'no verdict was returned for this row' });
  });

  it('同じ内容の行は 1 件の判定を共有する（重複除外の裏返し）', () => {
    const duplicated: Table = { schema, rows: [table.rows[0] as Table['rows'][number], { ...(table.rows[0] as Table['rows'][number]) }] };
    const config = configOf({ resolved: { verdicts: verdictsFor([table.rows[0] as Table['rows'][number]], columns, [{ value: 'yes', reason: 'r' }]) } });
    expect(aiJudgeNode.execute([duplicated], config).rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'yes']);
  });

  it('Date セルを含む行も判定に行き当たる（キーの ISO 正規化が execute 側と揃っている）', () => {
    const config = configOf({ columns: ['at'], resolved: { verdicts: { [aiJudgeItemKey({ at: new Date('2026-01-01T00:00:00.000Z') }, ['at'])]: { value: 'yes', reason: '元日' } } } });
    const out = aiJudgeNode.execute([table], config);
    expect(out.rows[0]).toMatchObject({ aiVerdict: 'yes', aiReason: '元日' });
    // at が null の行はこの判定に当たらない。
    expect(out.rows[1]).toMatchObject({ aiVerdict: AI_JUDGE_UNCLEAR });
  });

  it('columns を絞れば、その列だけで判定に行き当たる（見ない列が違っても同じ判定）', () => {
    const rows: Table['rows'] = [{ id: 1, body: '同じ本文', at: null }, { id: 2, body: '同じ本文', at: null }];
    const config = configOf({ columns: ['body'], resolved: { verdicts: { [aiJudgeItemKey({ body: '同じ本文' }, ['body'])]: { value: 'yes', reason: 'r' } } } });
    expect(aiJudgeNode.execute([{ schema, rows }], config).rows.map((row) => row['aiVerdict'])).toEqual(['yes', 'yes']);
  });

  it('resolved が無ければ ConfigError（配線漏れを黙って全行 unclear にしない）', () => {
    expect(() => aiJudgeNode.execute([table], configOf())).toThrowError(ConfigError);
    expect(() => aiJudgeNode.execute([table], configOf())).toThrowError(/verdicts are not resolved/);
  });

  it('存在しない列の指定は SchemaError（設定の不備ではなくスキーマの不一致として報告する）', () => {
    const config = configOf({ columns: ['missing'], resolved: { verdicts: {} } });
    expect(() => aiJudgeNode.execute([table], config)).toThrowError(SchemaError);
    expect(() => aiJudgeNode.execute([table], config)).toThrowError('ai-judge: column not found: missing');
  });

  it('列欠落は resolved の有無より先に報告する（原因の近い方を出す）', () => {
    expect(() => aiJudgeNode.execute([table], configOf({ columns: ['missing'] }))).toThrowError(SchemaError);
  });

  it('意味的な不備（question が空・出力列の衝突）は ConfigError', () => {
    expect(() => aiJudgeNode.execute([table], configOf({ question: '', resolved: { verdicts: {} } }))).toThrowError(ConfigError);
    expect(() => aiJudgeNode.execute([table], configOf({ outputColumn: 'body', resolved: { verdicts: {} } }))).toThrowError(
      'ai-judge: output column already exists: body',
    );
  });

  it('入力が無ければ ConfigError', () => {
    expect(() => aiJudgeNode.execute([], configOf({ resolved: { verdicts: {} } }))).toThrowError(ConfigError);
  });

  it('空の入力表でも落ちない（判定 0 件、スキーマは flag の出力どおり）', () => {
    const out = aiJudgeNode.execute([{ schema, rows: [] }], configOf({ resolved: { verdicts: {} } }));
    expect(out.rows).toEqual([]);
    expect(out.schema.columns.map((column) => column.name)).toEqual(['id', 'body', 'at', 'aiVerdict', 'aiReason']);
  });

  it('入力の行を書き換えない（新しい行オブジェクトを作る）', () => {
    const rows: Table['rows'] = [{ id: 1, body: 'x', at: null }];
    const config = configOf({ resolved: { verdicts: verdictsFor(rows, columns, [{ value: 'yes', reason: 'r' }]) } });
    aiJudgeNode.execute([{ schema, rows }], config);
    expect(rows[0]).toEqual({ id: 1, body: 'x', at: null });
  });
});

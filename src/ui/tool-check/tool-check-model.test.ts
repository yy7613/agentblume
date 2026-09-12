import { describe, expect, it } from 'vitest';
import type { SchemaDto, ToolCheckCaseDto, ToolCheckRunResultDto, ToolCheckSuggestionDto } from '../api/types';
import {
  EMPTY_EXPECTATIONS, ROW_LIMIT, argumentIssues, argumentNamesInMessage, assertionCounts, assertionKindLabel, buildArguments, buildExpectations, buildRunDto,
  buildSuggestDto, categoryLabel, clampPerCategory, coerceCell, draftFromExpectations, draftsFromArguments, editorFingerprint, editorFromCase, editorFromSuggestion,
  groupSuggestions, initialDrafts, inputKindFor, isExpectedFailure, summarizeExpectations, summarizeStatuses,
} from './tool-check-model';

const schema: SchemaDto = {
  columns: [
    { name: 'limit', type: 'number', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
    { name: 'region', type: 'string', nullable: true },
    { name: 'since', type: 'date', nullable: true },
  ],
};
const scope = { tenantId: 'local', workspaceId: 'default' };

describe('initialDrafts / draftsFromArguments', () => {
  it('正常: boolean 列は false、他は空欄から始める', () => {
    const drafts = initialDrafts(schema);
    expect(drafts['active']).toEqual({ raw: 'false', isNull: false });
    expect(drafts['limit']).toEqual({ raw: '', isNull: false });
  });

  it('境界: スキーマ無しは空の下書き', () => {
    expect(initialDrafts(undefined)).toEqual({});
  });

  it('正常: 保存済み引数を復元し、null は「未指定(null)」トグルに戻す', () => {
    const drafts = draftsFromArguments({ limit: 5, active: true, region: null }, schema);
    expect(drafts['limit']).toEqual({ raw: '5', isNull: false });
    expect(drafts['active']).toEqual({ raw: 'true', isNull: false });
    expect(drafts['region']).toEqual({ raw: '', isNull: true });
    // 保存に無い列はスキーマの既定値。
    expect(drafts['since']).toEqual({ raw: '', isNull: false });
  });
});

describe('buildArguments', () => {
  it('正常: number は数値、boolean は真偽値、string/date は文字列として送る', () => {
    const args = buildArguments(schema, {
      limit: { raw: '10', isNull: false },
      active: { raw: 'true', isNull: false },
      region: { raw: 'east', isNull: false },
      since: { raw: '2026-01-31', isNull: false },
    });
    expect(args).toEqual({ limit: 10, active: true, region: 'east', since: '2026-01-31' });
    expect(typeof args['limit']).toBe('number');
  });

  it('正常: 「未指定(null)」トグルは値に関わらず null を送る', () => {
    expect(buildArguments(schema, { region: { raw: 'ignored', isNull: true } })['region']).toBeNull();
  });

  it('境界: 空欄の列はキーごと送らない（必須判定はサーバーに任せる）', () => {
    const args = buildArguments(schema, { limit: { raw: '   ', isNull: false } });
    expect('limit' in args).toBe(false);
    expect('since' in args).toBe(false);
  });

  it('境界: number 欄の 0 と負数はそのまま数値で送る', () => {
    expect(buildArguments(schema, { limit: { raw: '0', isNull: false } })['limit']).toBe(0);
    expect(buildArguments(schema, { limit: { raw: '-3.5', isNull: false } })['limit']).toBe(-3.5);
  });

  it('異常: number 欄に数値でない文字列は変換せず文字列のまま残す（argumentIssues が弾く）', () => {
    expect(buildArguments(schema, { limit: { raw: 'abc', isNull: false } })['limit']).toBe('abc');
    expect(argumentIssues(schema, { limit: { raw: 'abc', isNull: false } })).toEqual({ limit: 'not-a-number' });
  });

  it('境界: 「未指定(null)」中の数値欄は不備として数えない', () => {
    expect(argumentIssues(schema, { limit: { raw: 'abc', isNull: true } })).toEqual({});
  });

  it('境界: スキーマ無しは {} を送る', () => {
    expect(buildArguments(undefined, { anything: { raw: '1', isNull: false } })).toEqual({});
  });
});

describe('coerceCell（型が不明なとき）', () => {
  it('正常: 数値・真偽値・null に見える文字列をそれぞれ変換し、他は文字列のまま', () => {
    expect(coerceCell('12', undefined)).toBe(12);
    expect(coerceCell('true', undefined)).toBe(true);
    expect(coerceCell('false', undefined)).toBe(false);
    expect(coerceCell('null', undefined)).toBeNull();
    expect(coerceCell('east', undefined)).toBe('east');
  });

  it('境界: string 型と分かっていれば "12" も文字列のまま', () => {
    expect(coerceCell('12', 'string')).toBe('12');
  });

  it('境界: 空文字は数値化しない', () => {
    expect(coerceCell('', undefined)).toBe('');
  });
});

describe('argumentNamesInMessage', () => {
  const names = ['limit', 'region', 'since'];
  it('正常: サーバー定型文（missing / invalid / unknown）から引数名を取り出す', () => {
    expect(argumentNamesInMessage('required argument missing: limit', names)).toEqual(['limit']);
    expect(argumentNamesInMessage("invalid argument 'region': expected string, received number 3", names)).toEqual(['region']);
    expect(argumentNamesInMessage('unknown argument(s): foo, bar', names)).toEqual(['foo', 'bar']);
  });

  it('境界: 定型文でなければ本文に語として現れる列名を拾う（部分一致は拾わない）', () => {
    expect(argumentNamesInMessage('value of since is not a date; limits are fine', names)).toEqual(['since']);
  });

  it('異常: 何も当たらなければ空配列', () => {
    expect(argumentNamesInMessage('something else went wrong', names)).toEqual([]);
  });

  it('例外: 正規表現のメタ文字を含む列名（a.b / total(1) / x+y）でも例外を投げずに語として判定する', () => {
    const odd = ['a.b', 'total(1)', 'x+y', '[q]'];
    expect(() => argumentNamesInMessage('bad value in total(1)', odd)).not.toThrow();
    expect(argumentNamesInMessage('bad value in total(1) and x+y', odd)).toEqual(['total(1)', 'x+y']);
    // '.' はメタ文字ではなく文字として比べる（a.b は aXb に当たらない）。
    expect(argumentNamesInMessage('aXb is wrong', odd)).toEqual([]);
  });
});

describe('buildExpectations', () => {
  it('正常: 埋まっている項目だけを含める', () => {
    const built = buildExpectations({ rowCountOp: 'gte', rowCountValue: '3', columns: ['total', ' region '], cells: [{ column: 'total', op: 'gte', value: '100', mode: 'any' }], maxDurationMs: '500', outcome: '' }, { columns: [{ name: 'total', type: 'number', nullable: false }] });
    expect(built).toEqual({ rowCount: { op: 'gte', value: 3 }, columns: ['total', 'region'], cells: [{ column: 'total', op: 'gte', value: 100, mode: 'any' }], maxDurationMs: 500 });
  });

  it('正常: 実行の結末は「指定なし」なら省き、成功 / 失敗を選べばそのまま送る', () => {
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, outcome: 'error' }, undefined)).toEqual({ outcome: 'error' });
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, outcome: 'success' }, undefined)).toEqual({ outcome: 'success' });
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, outcome: '' }, undefined)).toBeUndefined();
  });

  it('正常: 保存済みの outcome は入力欄へ戻り、無ければ「指定なし」', () => {
    expect(draftFromExpectations({ outcome: 'error' }).outcome).toBe('error');
    expect(draftFromExpectations({}).outcome).toBe('');
    expect(buildExpectations(draftFromExpectations({ outcome: 'error', rowCount: { op: 'eq', value: 0 } }), undefined)).toEqual({ outcome: 'error', rowCount: { op: 'eq', value: 0 } });
  });

  it('境界: 全部空なら undefined（空オブジェクトを送らない）', () => {
    expect(buildExpectations(EMPTY_EXPECTATIONS, undefined)).toBeUndefined();
  });

  it('境界: rowCount 0 は「0 行を期待する」として送る（空欄と区別する）', () => {
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, rowCountValue: '0' }, undefined)).toEqual({ rowCount: { op: 'eq', value: 0 } });
  });

  it('異常: 負数・小数・数値でない行数は期待に含めない', () => {
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, rowCountValue: '-1' }, undefined)).toBeUndefined();
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, rowCountValue: '1.5' }, undefined)).toBeUndefined();
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, maxDurationMs: 'fast' }, undefined)).toBeUndefined();
  });

  it('境界: 列名が空のセル条件は未完成として除き、出力スキーマの型で値を変換する', () => {
    const built = buildExpectations({
      ...EMPTY_EXPECTATIONS,
      cells: [{ column: '', op: 'eq', value: '1', mode: 'all' }, { column: 'code', op: 'eq', value: '007', mode: 'all' }],
    }, { columns: [{ name: 'code', type: 'string', nullable: false }] });
    expect(built?.cells).toEqual([{ column: 'code', op: 'eq', value: '007', mode: 'all' }]);
  });

  it('境界: 50 件のセル条件をそのまま送れる', () => {
    const cells = Array.from({ length: 50 }, (_, index) => ({ column: `c${index}`, op: 'eq' as const, value: String(index), mode: 'any' as const }));
    expect(buildExpectations({ ...EMPTY_EXPECTATIONS, cells }, undefined)?.cells).toHaveLength(50);
  });

  it('正常: 保存済みの期待を入力欄へ戻し、再構築すると同じ DTO になる', () => {
    const saved = { rowCount: { op: 'lte' as const, value: 9 }, columns: ['a'], cells: [{ column: 'a', op: 'contains' as const, value: 'x', mode: 'all' as const }, { column: 'b', op: 'eq' as const, value: null, mode: 'any' as const }], maxDurationMs: 100 };
    expect(buildExpectations(draftFromExpectations(saved), undefined)).toEqual(saved);
  });
});

describe('buildRunDto / editorFingerprint / editorFromCase', () => {
  it('正常: 版を指定しなければ version を省き、rowLimit 100 を明示する', () => {
    const dto = buildRunDto({ toolId: 't1', version: '', caseName: '', drafts: { limit: { raw: '2', isNull: false } }, expectations: EMPTY_EXPECTATIONS }, scope, schema, undefined);
    expect(dto).toEqual({ scope, toolId: 't1', arguments: { limit: 2 }, rowLimit: ROW_LIMIT });
    expect('version' in dto).toBe(false);
    expect('expectations' in dto).toBe(false);
  });

  it('正常: 版と期待があれば含める', () => {
    const dto = buildRunDto({ toolId: 't1', version: '1.2.0', caseName: '', drafts: {}, expectations: { ...EMPTY_EXPECTATIONS, maxDurationMs: '10' } }, scope, undefined, undefined);
    expect(dto.version).toBe('1.2.0');
    expect(dto.expectations).toEqual({ maxDurationMs: 10 });
  });

  it('正常: 未保存判定はキーの順序に依らない', () => {
    const base = { toolId: 't', version: '', caseName: '', expectations: EMPTY_EXPECTATIONS };
    const a = editorFingerprint({ ...base, drafts: { x: { raw: '1', isNull: false }, y: { raw: '2', isNull: false } } });
    const b = editorFingerprint({ ...base, drafts: { y: { raw: '2', isNull: false }, x: { raw: '1', isNull: false } } });
    expect(a).toBe(b);
    expect(editorFingerprint({ ...base, drafts: { x: { raw: '9', isNull: false } } })).not.toBe(a);
  });

  it('正常: ケースからエディタ状態を復元する（版未固定は latest = 空文字）', () => {
    const item: ToolCheckCaseDto = { id: 'c1', toolId: 't1', name: 'Case', arguments: { limit: 3 }, expectations: { columns: ['a'] }, createdAt: 'x', updatedAt: 'y' };
    const state = editorFromCase(item, schema);
    expect(state.toolId).toBe('t1');
    expect(state.version).toBe('');
    expect(state.caseName).toBe('Case');
    expect(state.drafts['limit']).toEqual({ raw: '3', isNull: false });
    expect(state.expectations.columns).toEqual(['a']);
  });
});

describe('集計とラベル', () => {
  const result: ToolCheckRunResultDto = {
    tool: { internalId: 't', version: '1.0.0', publishName: 't' }, status: 'failed',
    assertions: [{ kind: 'rowCount', passed: true, expected: 'row count == 1', actual: 'row count 1' }, { kind: 'column', passed: false, expected: "column 'x' exists", actual: 'columns: a' }],
    output: { schema: { columns: [] }, rows: [] }, rowCount: 0, nodes: [], durationMs: 1, checkedAt: 'now',
  };
  it('正常: 合格・不合格の件数を数える', () => {
    expect(assertionCounts(result)).toEqual({ passed: 1, failed: 1 });
  });
  it('境界: 期待が無ければ 0/0', () => {
    expect(assertionCounts({ ...result, assertions: [] })).toEqual({ passed: 0, failed: 0 });
  });
  it('正常: 期待の項目名は outcome も含めて en / ja を持つ', () => {
    expect(assertionKindLabel('outcome')).toEqual(['Outcome', '実行の結末']);
    expect(assertionKindLabel('rowCount')).toEqual(['Row count', '行数']);
    expect(assertionKindLabel('duration')).toEqual(['Duration', '所要時間']);
  });
  it('正常: 「失敗が期待値で実際に失敗した合格」は status = passed かつ error ありで判定する', () => {
    const error = { code: 'TOOL_ARGUMENTS', message: 'required argument missing: limit' };
    expect(isExpectedFailure({ ...result, status: 'passed', error })).toBe(true);
    expect(isExpectedFailure({ ...result, status: 'error', error })).toBe(false);
    expect(isExpectedFailure({ ...result, status: 'passed' })).toBe(false);
  });
  it('正常: すべて実行の集計は error も数える', () => {
    expect(summarizeStatuses(['passed', 'error', 'failed', 'passed'])).toEqual({ passed: 2, failed: 1, error: 1 });
  });
  it('正常: 入力欄の種類は列の型で決まり、date は ISO テキスト', () => {
    expect(inputKindFor({ name: 'a', type: 'number', nullable: false })).toBe('number');
    expect(inputKindFor({ name: 'a', type: 'boolean', nullable: false })).toBe('boolean');
    expect(inputKindFor({ name: 'a', type: 'date', nullable: false })).toBe('text');
    expect(inputKindFor({ name: 'a', type: 'unknown', nullable: false })).toBe('text');
  });
});

describe('LLM 提案の補助（buildSuggestDto / clampPerCategory / groupSuggestions / summarizeExpectations / editorFromSuggestion）', () => {
  const suggestion = (overrides: Partial<ToolCheckSuggestionDto> = {}): ToolCheckSuggestionDto => ({
    category: 'normal', name: 'basic', rationale: 'why', arguments: { limit: 3 }, expectations: { rowCount: { op: 'gte', value: 1 } }, warnings: [], ...overrides,
  });

  it('正常: perCategory と trim した focus を載せ、版が最新（空）なら version を省く', () => {
    expect(buildSuggestDto({ toolId: 't', version: '', perCategory: 3, focus: '  価格の境界  ' }, scope)).toStrictEqual({ scope, toolId: 't', perCategory: 3, focus: '価格の境界' });
    expect(buildSuggestDto({ toolId: 't', version: '1.1.0', perCategory: 2, focus: '' }, scope)).toStrictEqual({ scope, toolId: 't', version: '1.1.0', perCategory: 2 });
  });

  it('境界: perCategory は 1 と 5 をそのまま通し、0 / 6 / 小数 / 数値でない値は 1〜5 に丸める', () => {
    expect(clampPerCategory(1)).toBe(1);
    expect(clampPerCategory(5)).toBe(5);
    expect(clampPerCategory(0)).toBe(1);
    expect(clampPerCategory(6)).toBe(5);
    expect(clampPerCategory('3.9')).toBe(3);
    expect(clampPerCategory('')).toBe(2);
    expect(clampPerCategory('abc')).toBe(2);
    expect(buildSuggestDto({ toolId: 't', version: '', perCategory: 99, focus: '' }, scope).perCategory).toBe(5);
  });

  it('正常: カテゴリ順（正常 → 境界 → 異常）に元の index を保ってまとめ、空のカテゴリも返す', () => {
    const grouped = groupSuggestions([suggestion({ category: 'abnormal', name: 'x' }), suggestion({ name: 'a' }), suggestion({ name: 'b' })]);
    expect(grouped.map((group) => group.category)).toEqual(['normal', 'boundary', 'abnormal']);
    expect(grouped[0]?.items.map((item) => [item.index, item.suggestion.name])).toEqual([[1, 'a'], [2, 'b']]);
    expect(grouped[1]?.items).toEqual([]);
    expect(grouped[2]?.items[0]?.index).toBe(0);
    expect(categoryLabel('boundary')).toEqual(['Boundary', '境界']);
  });

  it('境界: 提案が 0 件でも 3 カテゴリの空グループを返す', () => {
    expect(groupSuggestions([]).map((group) => group.items.length)).toEqual([0, 0, 0]);
  });

  it('正常: 期待の要約はサーバー定型文と同じ形（日本語化を共有できる）', () => {
    expect(summarizeExpectations({ outcome: 'error', rowCount: { op: 'eq', value: 0 }, columns: ['total'], cells: [{ column: 'region', op: 'eq', value: 'east', mode: 'all' }, { column: 'total', op: 'gte', value: 100, mode: 'any' }], maxDurationMs: 500 }))
      .toEqual(['outcome error', 'row count == 0', "column 'total' exists", 'every row has region == "east"', 'some row has total >= 100', 'duration <= 500ms']);
  });

  it('境界: 期待が空なら要約も空', () => {
    expect(summarizeExpectations({})).toEqual([]);
  });

  it('正常: 提案をエディタ状態に展開する（名前・引数・期待。版は選択中のものを引き継ぐ）', () => {
    const state = editorFromSuggestion(suggestion({ arguments: { limit: 3, region: null }, expectations: { outcome: 'error' } }), { toolId: 'sales', version: '1.1.0' }, schema);
    expect(state.caseName).toBe('basic');
    expect(state.toolId).toBe('sales');
    expect(state.version).toBe('1.1.0');
    expect(state.drafts['limit']).toEqual({ raw: '3', isNull: false });
    expect(state.drafts['region']).toEqual({ raw: '', isNull: true });
    expect(state.expectations.outcome).toBe('error');
  });
});

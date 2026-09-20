import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../domain/data/types';
import { OPERATOR_BINDABLE_OPS } from '../../domain/etl/nodes/filter';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { AgentRunError, ToolArgumentsError } from './errors';
import { agentInputInconsistency, assertOutputMatchesSchema, isValidFunctionName, schemaToJsonSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';

const schema: Schema = { columns: [
  { name: 'month', type: 'string', nullable: false },
  { name: 'at', type: 'date', nullable: true },
] };

describe('function 名と agent-input 契約の共有判定', () => {
  it('isValidFunctionName は toolToModelDefinition と同じ規則（英数字・_・- で 1〜64 文字）', () => {
    expect(isValidFunctionName('score_lookup')).toBe(true);
    expect(isValidFunctionName('a-B9')).toBe(true);
    expect(isValidFunctionName('x'.repeat(64))).toBe(true);
    expect(isValidFunctionName('')).toBe(false);
    expect(isValidFunctionName('bad name')).toBe(false);
    expect(isValidFunctionName('ask_bad.name')).toBe(false);
    expect(isValidFunctionName('x'.repeat(65))).toBe(false);
  });

  it('isValidFunctionName の境界: 先頭数字・記号だけの名前は規則上許容し、Unicode・空白・改行・区切り記号は拒否する', () => {
    // 先頭の数字は OpenAI 互換 API の制約（英数字・_・-）で禁止されていないので許容する（現状の挙動を固定）。
    expect(isValidFunctionName('1st_lookup')).toBe(true);
    expect(isValidFunctionName('-')).toBe(true);
    expect(isValidFunctionName('_')).toBe(true);
    expect(isValidFunctionName(`ask_${'a'.repeat(60)}`)).toBe(true);
    expect(isValidFunctionName(`ask_${'a'.repeat(61)}`)).toBe(false);
    expect(isValidFunctionName('スコア検索')).toBe(false);
    expect(isValidFunctionName('score lookup')).toBe(false);
    expect(isValidFunctionName(' ')).toBe(false);
    expect(isValidFunctionName('score\n')).toBe(false);
    expect(isValidFunctionName('score.lookup')).toBe(false);
    expect(isValidFunctionName('score/lookup')).toBe(false);
  });

  it('agentInputInconsistency の境界: schema を持たない config・config undefined・複数ノードのうち不一致の1つを名指しする', () => {
    const declared: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };
    const matching = { id: 'arguments', type: 'agent-input', config: { schema: declared, sample: { minimumScore: 0 } } };
    expect(agentInputInconsistency({ graph: { nodes: [{ id: 'bare', type: 'agent-input', config: {} }], edges: [] }, inputSchema: declared }))
      .toBe("tool inputSchema does not match agent-input node 'bare'");
    expect(agentInputInconsistency({ graph: { nodes: [{ id: 'none', type: 'agent-input', config: undefined }], edges: [] }, inputSchema: declared }))
      .toBe("tool inputSchema does not match agent-input node 'none'");
    expect(agentInputInconsistency({ graph: { nodes: [matching, { id: 'stale', type: 'agent-input', config: { schema: { columns: [] } } }], edges: [] }, inputSchema: declared }))
      .toBe("tool inputSchema does not match agent-input node 'stale'");
    // agent-input 以外のノードの config は見ない。
    expect(agentInputInconsistency({ graph: { nodes: [matching, { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0 } }], edges: [] }, inputSchema: declared })).toBeUndefined();
    // nullable の違いも不一致（schemasEqual と同じ厳密比較）。
    expect(agentInputInconsistency({ graph: { nodes: [matching], edges: [] }, inputSchema: { columns: [{ name: 'minimumScore', type: 'number', nullable: true }] } }))
      .toBe("tool inputSchema does not match agent-input node 'arguments'");
  });

  it('agentInputInconsistency は実行時 graphWithArguments と同じ2メッセージを返す', () => {
    const declared: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };
    const argumentsNode = { id: 'arguments', type: 'agent-input', config: { schema: declared, sample: { minimumScore: 0 } } };
    expect(agentInputInconsistency({ graph: { nodes: [argumentsNode], edges: [] }, inputSchema: declared })).toBeUndefined();
    // 引数を持たない Tool（inputSchema 無し・空）はノードが無くてよい。
    expect(agentInputInconsistency({ graph: { nodes: [], edges: [] } })).toBeUndefined();
    expect(agentInputInconsistency({ graph: { nodes: [], edges: [] }, inputSchema: { columns: [] } })).toBeUndefined();
    expect(agentInputInconsistency({ graph: { nodes: [], edges: [] }, inputSchema: declared })).toBe('tool declares inputSchema but has no agent-input node');
    expect(agentInputInconsistency({ graph: { nodes: [argumentsNode], edges: [] }, inputSchema: { columns: [{ name: 'other', type: 'string', nullable: false }] } }))
      .toBe("tool inputSchema does not match agent-input node 'arguments'");
    // inputSchema 未宣言でノードだけある場合も不一致。config が壊れていても投げない。
    expect(agentInputInconsistency({ graph: { nodes: [argumentsNode], edges: [] } })).toBe("tool inputSchema does not match agent-input node 'arguments'");
    expect(agentInputInconsistency({ graph: { nodes: [{ id: 'broken', type: 'agent-input', config: null }], edges: [] }, inputSchema: declared }))
      .toBe("tool inputSchema does not match agent-input node 'broken'");
  });
});

describe('Tool Calling schema', () => {
  it('SchemaをJSON Schemaへ変換する', () => {
    expect(schemaToJsonSchema(schema)).toEqual({
      type: 'object', additionalProperties: false, required: ['month'],
      properties: {
        month: { type: 'string' },
        at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      },
    });
  });

  it('Tool metadataをfunction definitionへ変換する', () => {
    const tool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Sales', publishName: 'sales_summary', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] }, inputSchema: schema,
    });
    expect(toolToModelDefinition(tool)).toMatchObject({ name: 'sales_summary', description: 'Sales (read-only)', parameters: { required: ['month'] } });
  });

  it('Agent向けに設定した名前と説明をfunction definitionへ使う', () => {
    const tool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Sales', publishName: 'sales_summary', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] }, inputSchema: schema,
      agentTool: { name: 'find_sales', description: 'Find sales totals for a requested month.' },
    });
    expect(toolToModelDefinition(tool)).toMatchObject({ name: 'find_sales', description: 'Find sales totals for a requested month.' });
  });

  it('不正function名と重複input列を拒否する', () => {
    const badTool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Bad', publishName: 'bad name', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] },
    });
    expect(() => toolToModelDefinition(badTool)).toThrow(/function name/);
    expect(() => schemaToJsonSchema({ columns: [
      { name: 'x', type: 'string', nullable: false }, { name: 'x', type: 'number', nullable: false },
    ] })).toThrow(/duplicate/);
  });

  it('argumentsを検証しdateを正規化する', () => {
    const row = validateToolArguments(schema, { month: '2026-07', at: '2026-07-03T00:00:00Z' });
    expect(row['month']).toBe('2026-07');
    expect(row['at']).toBeInstanceOf(Date);
  });

  it.each([
    [{ at: null }, /required/],
    // 期待型に加えて「受け取った値と型」を描写する（小さいモデルの修復が1回で決まるように）。
    [{ month: 7 }, /expected string, received 7 \(number\)/],
    [{ month: ['2026-07'] }, /expected string, received \["2026-07"\] \(array\)/],
    [{ month: '2026-07', at: 'not-a-date' }, /expected date, received "not-a-date" \(string\)/],
    [{ month: '2026-07', extra: true }, /unknown argument/],
  ])('invalid argumentsを拒否する', (args, message) => {
    expect(() => validateToolArguments(schema, args)).toThrow(expect.objectContaining({ message: expect.stringMatching(message) }));
  });

  it('受け取った値の描写は120文字で切り詰める', () => {
    const long = 'x'.repeat(200);
    expect(() => validateToolArguments(schema, { month: [long] }))
      .toThrow(expect.objectContaining({ message: expect.stringMatching(/received \["x+… \(array\)/) }));
  });

  it('output schema mismatchを拒否する', () => {
    const table = { schema, rows: [{ month: 7, at: null }] } as unknown as Table;
    expect(() => assertOutputMatchesSchema(table, schema)).toThrow(AgentRunError);
    expect(() => assertOutputMatchesSchema(table, undefined)).not.toThrow();
    expect(() => assertOutputMatchesSchema({ schema: { columns: [] }, rows: [] }, schema)).toThrow(/column count/);
  });

  it('schema equalityは列順・型・nullableを含める', () => {
    expect(schemasEqual(schema, structuredClone(schema))).toBe(true);
    expect(schemasEqual(undefined, undefined)).toBe(true);
    expect(schemasEqual(schema, undefined)).toBe(false);
    expect(schemasEqual(schema, { columns: [...schema.columns].reverse() })).toBe(false);
  });

  it('全DataType・nullableをJSON Schemaと実行値へ変換する', () => {
    const every: Schema = { columns: [
      { name: 's', type: 'string', nullable: false },
      { name: 'n', type: 'number', nullable: false },
      { name: 'b', type: 'boolean', nullable: false },
      { name: 'd', type: 'date', nullable: false },
      { name: 'z', type: 'null', nullable: false },
      { name: 'u', type: 'unknown', nullable: false },
      { name: 'optional', type: 'string', nullable: true },
    ] };
    expect(schemaToJsonSchema(every).properties).toMatchObject({
      s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' },
      d: { type: 'string', format: 'date-time' }, z: { type: 'null' }, u: {},
      optional: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    });
    expect(schemaToJsonSchema(undefined)).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    const row = validateToolArguments(every, {
      s: 'x', n: 1, b: true, d: '2026-07-03T00:00:00Z', z: null, u: 'anything',
    });
    expect(row).toMatchObject({ s: 'x', n: 1, b: true, z: null, u: 'anything', optional: null });
    expect(row['d']).toBeInstanceOf(Date);
    expect(() => assertOutputMatchesSchema({ schema: every, rows: [row] }, every)).not.toThrow();
  });
});

/** filter ノード1つ + inputSchema の Tool を組み立てる（opBinding の enum 公開テスト用）。 */
function filterTool(inputSchema: Schema, filterConfig: unknown) {
  return createTool({
    metadata: { internalId: 't', workingName: 'w', displayName: 'Filter', publishName: 'filter_rows', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
    sideEffect: 'read-only',
    graph: { nodes: [{ id: 'f', type: 'filter', config: filterConfig }], edges: [] },
    inputSchema,
  });
}

describe('filter opBinding の JSON Schema 公開', () => {
  it('opバインドされたstring引数にenumとdescriptionを付け、他の引数は従来どおり', () => {
    const inputSchema: Schema = { columns: [
      { name: 'month', type: 'string', nullable: false },
      { name: 'priceOp', type: 'string', nullable: false },
    ] };
    const tool = filterTool(inputSchema, {
      column: 'price', op: 'gte', value: 100,
      opBinding: { source: 'agent-input', field: 'priceOp', allowed: ['gt', 'gte', 'lt', 'lte'] },
    });
    const { properties } = toolToModelDefinition(tool).parameters;
    expect(properties['priceOp']).toEqual({
      type: 'string',
      enum: ['gt', 'gte', 'lt', 'lte'],
      description: "Row filter operator applied to column 'price'.",
    });
    // opバインドの無い引数は触らない。
    expect(properties['month']).toEqual({ type: 'string' });
  });

  it('nullable引数はanyOf内のstringへenumを付け、既定演算子の省略時挙動を説明する', () => {
    const inputSchema: Schema = { columns: [{ name: 'priceOp', type: 'string', nullable: true }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gte', value: 100, opBinding: { source: 'agent-input', field: 'priceOp', allowed: ['gt', 'gte'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['priceOp']).toEqual({
      anyOf: [{ type: 'string', enum: ['gt', 'gte'] }, { type: 'null' }],
      description: "Row filter operator applied to column 'price'. Omit it to use the default operator 'gte'.",
    });
  });

  it('allowed省略時は演算子引数にできる全演算子がenumに載る（in/notIn は除く）', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, {
      column: 'price', op: 'eq', value: 1,
      opBinding: { source: 'agent-input', field: 'op' },
    });
    const property = toolToModelDefinition(tool).parameters.properties['op'];
    expect(property?.enum).toEqual([...OPERATOR_BINDABLE_OPS]);
    expect(property?.enum).toHaveLength(9);
    // 値の形が違う複数値演算子は、許可リストを省略しても公開されない。
    expect(property?.enum).not.toContain('in');
  });

  it('同一fieldを複数条件がバインドしたらenumは積集合・descriptionは全列を列挙する', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gte', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'gte', 'lt'] } },
      { column: 'stock', op: 'gte', value: 2, opBinding: { source: 'agent-input', field: 'op', allowed: ['gte', 'lt', 'lte'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['op']).toEqual({
      type: 'string',
      enum: ['gte', 'lt'],
      description: "Row filter operator applied to columns 'price', 'stock'.",
    });
  });

  it('既定演算子が条件間で一致しない場合はOmitの説明を付けない', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: true }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
      { column: 'stock', op: 'lt', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['op']).toEqual({
      anyOf: [{ type: 'string', enum: ['gt', 'lt'] }, { type: 'null' }],
      description: "Row filter operator applied to columns 'price', 'stock'.",
    });
  });

  it('stringベースでない引数や積集合が空の引数は変更しない（不整合な旧Toolでもクラッシュしない）', () => {
    const inputSchema: Schema = { columns: [
      { name: 'wrongType', type: 'number', nullable: false },
      { name: 'emptyOp', type: 'string', nullable: false },
    ] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'wrongType' } },
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'emptyOp', allowed: ['gt'] } },
      { column: 'stock', op: 'lt', value: 1, opBinding: { source: 'agent-input', field: 'emptyOp', allowed: ['lt'] } },
    ], combine: 'and' });
    const { properties } = toolToModelDefinition(tool).parameters;
    expect(properties['wrongType']).toEqual({ type: 'number' });
    expect(properties['emptyOp']).toEqual({ type: 'string' });
  });

  it('inputSchemaに列が無いfieldはプロパティを作らず、string型でない列のfieldは変更しない（Q7）', () => {
    const inputSchema: Schema = { columns: [
      { name: 'month', type: 'string', nullable: false },
      { name: 'limit', type: 'number', nullable: false },
    ] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'ghost', allowed: ['gt', 'lt'] } },
      { column: 'stock', op: 'lt', value: 1, opBinding: { source: 'agent-input', field: 'limit', allowed: ['gt', 'lt'] } },
    ], combine: 'and' });
    const { properties } = toolToModelDefinition(tool).parameters;
    // (a) inputSchema に列が無い field はプロパティを作らない（enum だけの幽霊引数を公開しない）。
    expect(properties['ghost']).toBeUndefined();
    // (b) string 型でない列の field は素の型のまま触らない。
    expect(properties['limit']).toEqual({ type: 'number' });
    // opバインドの無い引数は従来どおり。
    expect(properties['month']).toEqual({ type: 'string' });
  });
});

describe('filter in/notIn の値引数（カンマ区切りの並び）の JSON Schema 公開', () => {
  it('正常: 値の並びを受け取る引数に「カンマ区切りで一度に渡す」説明と設計時サンプルの例を付ける', () => {
    const inputSchema: Schema = { columns: [{ name: 'regions', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, {
      column: '地域', op: 'in', values: ['東京都', '大阪府'],
      valueBinding: { source: 'agent-input', field: 'regions' },
    });
    expect(toolToModelDefinition(tool).parameters.properties['regions']).toEqual({
      type: 'string',
      description: "Comma-separated list of values to match in column '地域'. Pass every value you need in one call (for example \"A,B,C\") instead of calling the tool once per value. For example: \"東京都,大阪府\".",
    });
  });

  it('正常: nullable な引数には「省略するとこの絞り込みをしない」まで書く', () => {
    const inputSchema: Schema = { columns: [{ name: 'regions', type: 'string', nullable: true }] };
    const tool = filterTool(inputSchema, {
      column: '地域', op: 'notIn', values: ['沖縄県'],
      valueBinding: { source: 'agent-input', field: 'regions' },
    });
    const property = toolToModelDefinition(tool).parameters.properties['regions'];
    expect(property?.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(property?.description).toContain('Omit it to skip this filter.');
    expect(property?.enum).toBeUndefined(); // 値は自由記述なので enum は付けない。
  });

  it('境界: 同一引数を複数条件がバインドしたら列とサンプルをまとめて1つの説明にする', () => {
    const inputSchema: Schema = { columns: [{ name: 'regions', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: '地域', op: 'in', values: ['東京都'], valueBinding: { source: 'agent-input', field: 'regions' } },
      { column: '県名', op: 'in', values: ['大阪府'], valueBinding: { source: 'agent-input', field: 'regions' } },
    ], combine: 'or' });
    const description = String(toolToModelDefinition(tool).parameters.properties['regions']?.description);
    expect(description).toContain("columns '地域', '県名'");
    expect(description).toContain('"東京都,大阪府"');
  });

  it('境界: 設計時サンプルが無ければ例を書かない（他の文言は変わらない）', () => {
    const inputSchema: Schema = { columns: [{ name: 'regions', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, { column: '地域', op: 'in', valueBinding: { source: 'agent-input', field: 'regions' } });
    const description = String(toolToModelDefinition(tool).parameters.properties['regions']?.description);
    expect(description).toContain('Comma-separated list of values');
    expect(description).not.toContain('For example:');
  });

  it('異常: 宣言の無い引数・string型でない引数は触らず、正しい引数にだけ説明を付ける', () => {
    const inputSchema: Schema = { columns: [
      { name: 'limit', type: 'number', nullable: false },
      { name: 'regions', type: 'string', nullable: false },
    ] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: '地域', op: 'in', values: ['東京都'], valueBinding: { source: 'agent-input', field: 'ghost' } },
      { column: '金額', op: 'in', values: [1], valueBinding: { source: 'agent-input', field: 'limit' } },
      { column: '県名', op: 'in', values: ['大阪府'], valueBinding: { source: 'agent-input', field: 'regions' } },
    ], combine: 'and' });
    const { properties } = toolToModelDefinition(tool).parameters;
    expect(properties['ghost']).toBeUndefined();
    expect(properties['limit']).toEqual({ type: 'number' });
    expect(String(properties['regions']?.description)).toContain('Comma-separated list of values');
  });

  it('境界: 従来どおり — 単値演算子の valueBinding には説明を足さない', () => {
    const inputSchema: Schema = { columns: [{ name: 'region', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, { column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'region' } });
    expect(toolToModelDefinition(tool).parameters.properties['region']).toEqual({ type: 'string' });
  });
});

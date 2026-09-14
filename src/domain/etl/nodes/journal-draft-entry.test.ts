import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { JOURNAL_DRAFT_ENTRY_COLUMNS, JOURNAL_DRAFT_ENTRY_SCHEMA, journalDraftEntrySourceNode } from './journal-draft-entry';

describe('journal-draft-entry: メタデータ', () => {
  it('正常: source / arity 0 として登録できる形を持つ', () => {
    expect(journalDraftEntrySourceNode.type).toBe('journal-draft-entry');
    expect(journalDraftEntrySourceNode.kind).toBe('source');
    expect(journalDraftEntrySourceNode.inputArity).toBe(0);
  });
});

describe('journal-draft-entry: validateConfig', () => {
  it('正常: 空 config（添付すべてを読む）を受理する', () => {
    expect(journalDraftEntrySourceNode.validateConfig({})).toEqual({});
  });

  it('正常: limit をそのまま返し、未知のキーは黙って落とす', () => {
    expect(journalDraftEntrySourceNode.validateConfig({ limit: 2, other: 'x' })).toEqual({ limit: 2 });
  });

  it('境界: limit は 1 と 8 を含み、その外は ConfigError', () => {
    expect(journalDraftEntrySourceNode.validateConfig({ limit: 1 })).toEqual({ limit: 1 });
    expect(journalDraftEntrySourceNode.validateConfig({ limit: 8 })).toEqual({ limit: 8 });
    expect(() => journalDraftEntrySourceNode.validateConfig({ limit: 0 })).toThrowError(ConfigError);
    expect(() => journalDraftEntrySourceNode.validateConfig({ limit: 9 })).toThrowError(ConfigError);
  });

  it('異常: 整数でない limit・型違いは ConfigError', () => {
    expect(() => journalDraftEntrySourceNode.validateConfig({ limit: 1.5 })).toThrowError(ConfigError);
    expect(() => journalDraftEntrySourceNode.validateConfig({ limit: '2' })).toThrowError(ConfigError);
  });

  it('例外: object でない config も ConfigError で落とす', () => {
    expect(() => journalDraftEntrySourceNode.validateConfig(null)).toThrowError(ConfigError);
    expect(() => journalDraftEntrySourceNode.validateConfig([])).toThrowError(ConfigError);
  });
});

describe('journal-draft-entry: inferSchema / execute', () => {
  it('正常: スキーマは入力にも config にも依存せず固定で confirmed', () => {
    const inference = journalDraftEntrySourceNode.inferSchema([], { limit: 3 });
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema).toEqual(JOURNAL_DRAFT_ENTRY_SCHEMA);
  });

  it('正常: 列の並びは JOURNAL_DRAFT_ENTRY_COLUMNS と一致する（行組み立てと共有する並び）', () => {
    expect(JOURNAL_DRAFT_ENTRY_SCHEMA.columns.map((column) => column.name)).toEqual([...JOURNAL_DRAFT_ENTRY_COLUMNS]);
  });

  it('境界: 常に埋まるのは file_name / decided / facts_json だけで、仕訳の列は null を許す', () => {
    const required = JOURNAL_DRAFT_ENTRY_SCHEMA.columns.filter((column) => !column.nullable).map((column) => column.name);
    // 確定しなかった帳票は仕訳の列を持たないため（理由だけを返す）。
    expect(required).toEqual(['file_name', 'decided', 'facts_json']);
  });

  it('例外: リゾルバが書き換えていないときは、投げずに空テーブルを返す', () => {
    const table = journalDraftEntrySourceNode.execute([], {});
    expect(table.rows).toEqual([]);
    expect(table.schema).toEqual(JOURNAL_DRAFT_ENTRY_SCHEMA);
  });
});

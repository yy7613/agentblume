import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { JOURNAL_ATTACHMENT_COLUMNS, JOURNAL_ATTACHMENT_SCHEMA, journalAttachmentSourceNode } from './journal-attachment';

describe('journal-attachment: メタデータ', () => {
  it('正常: source / arity 0 として登録できる形を持つ', () => {
    expect(journalAttachmentSourceNode.type).toBe('journal-attachment');
    expect(journalAttachmentSourceNode.kind).toBe('source');
    expect(journalAttachmentSourceNode.inputArity).toBe(0);
  });
});

describe('journal-attachment: validateConfig', () => {
  it('正常: 空 config（添付すべてを読む）を受理する', () => {
    expect(journalAttachmentSourceNode.validateConfig({})).toEqual({});
  });

  it('正常: limit をそのまま返す', () => {
    expect(journalAttachmentSourceNode.validateConfig({ limit: 2 })).toEqual({ limit: 2 });
  });

  it('正常: 未知のキーは黙って落とす（他ノードと同じ規約）', () => {
    expect(journalAttachmentSourceNode.validateConfig({ limit: 1, other: 'x' })).toEqual({ limit: 1 });
  });

  it('境界: limit は 1 と 8 を含み、その外は ConfigError', () => {
    expect(journalAttachmentSourceNode.validateConfig({ limit: 1 })).toEqual({ limit: 1 });
    expect(journalAttachmentSourceNode.validateConfig({ limit: 8 })).toEqual({ limit: 8 });
    expect(() => journalAttachmentSourceNode.validateConfig({ limit: 0 })).toThrowError(ConfigError);
    expect(() => journalAttachmentSourceNode.validateConfig({ limit: 9 })).toThrowError(ConfigError);
  });

  it('異常: 整数でない limit・型違いは ConfigError', () => {
    expect(() => journalAttachmentSourceNode.validateConfig({ limit: 1.5 })).toThrowError(ConfigError);
    expect(() => journalAttachmentSourceNode.validateConfig({ limit: '2' })).toThrowError(ConfigError);
  });

  it('例外: null / 配列など object でない config も ConfigError で落とす', () => {
    expect(() => journalAttachmentSourceNode.validateConfig(null)).toThrowError(ConfigError);
    expect(() => journalAttachmentSourceNode.validateConfig([])).toThrowError(ConfigError);
    expect(() => journalAttachmentSourceNode.validateConfig('x')).toThrowError(ConfigError);
  });
});

describe('journal-attachment: inferSchema / execute', () => {
  it('正常: スキーマは入力にも config にも依存せず固定で confirmed', () => {
    const first = journalAttachmentSourceNode.inferSchema([], {});
    const second = journalAttachmentSourceNode.inferSchema([], { limit: 3 });
    expect(first.state).toBe('confirmed');
    expect(first.issues).toEqual([]);
    expect(first.schema).toEqual(JOURNAL_ATTACHMENT_SCHEMA);
    expect(second.schema).toEqual(first.schema);
  });

  it('正常: 列の並びは JOURNAL_ATTACHMENT_COLUMNS と一致する（行組み立てと共有する並び）', () => {
    expect(JOURNAL_ATTACHMENT_SCHEMA.columns.map((column) => column.name)).toEqual([...JOURNAL_ATTACHMENT_COLUMNS]);
  });

  it('境界: 常に埋まるのは file_name / kind / warnings / facts_json だけで、他は null を許す', () => {
    const required = JOURNAL_ATTACHMENT_SCHEMA.columns.filter((column) => !column.nullable).map((column) => column.name);
    expect(required).toEqual(['file_name', 'kind', 'warnings', 'facts_json']);
  });

  it('例外: リゾルバが書き換えていないときは、投げずに空テーブルを返す', () => {
    // 設計時プレビューやリゾルバ未配線の検証で落とさないため（拒否は application 層の責務）。
    const table = journalAttachmentSourceNode.execute([], {});
    expect(table.rows).toEqual([]);
    expect(table.schema).toEqual(JOURNAL_ATTACHMENT_SCHEMA);
  });
});

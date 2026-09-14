import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { JOURNAL_ENTRIES_COLUMNS, JOURNAL_ENTRIES_SCHEMA, journalEntriesSourceNode } from './journal-entries-source';

describe('journal-entries: メタデータ', () => {
  it('正常: source / arity 0 として登録できる形を持つ', () => {
    expect(journalEntriesSourceNode.type).toBe('journal-entries');
    expect(journalEntriesSourceNode.kind).toBe('source');
    expect(journalEntriesSourceNode.inputArity).toBe(0);
  });
});

describe('journal-entries: validateConfig', () => {
  it('正常: 空 config（全状態・全期間）を受理する', () => {
    expect(journalEntriesSourceNode.validateConfig({})).toEqual({});
  });

  it('正常: status / from / to / limit をそのまま返す', () => {
    expect(journalEntriesSourceNode.validateConfig({ status: 'confirmed', from: '2026-01-01', to: '2026-12-31', limit: 100 }))
      .toEqual({ status: 'confirmed', from: '2026-01-01', to: '2026-12-31', limit: 100 });
  });

  it('正常: 未知のキーは黙って落とす（他ノードと同じ規約）', () => {
    expect(journalEntriesSourceNode.validateConfig({ status: 'draft', other: 1 })).toEqual({ status: 'draft' });
  });

  it('異常: 未知の status は ConfigError', () => {
    expect(() => journalEntriesSourceNode.validateConfig({ status: 'posted' })).toThrowError(ConfigError);
  });

  it('異常: 日付が YYYY-MM-DD でなければ ConfigError（from / to とも）', () => {
    expect(() => journalEntriesSourceNode.validateConfig({ from: '2026/01/01' })).toThrowError(ConfigError);
    expect(() => journalEntriesSourceNode.validateConfig({ to: '26-1-1' })).toThrowError(ConfigError);
    expect(() => journalEntriesSourceNode.validateConfig({ from: 20260101 })).toThrowError(ConfigError);
  });

  it('境界: limit は 1〜10000 の整数だけを受理する', () => {
    expect(journalEntriesSourceNode.validateConfig({ limit: 1 })).toEqual({ limit: 1 });
    expect(journalEntriesSourceNode.validateConfig({ limit: 10_000 })).toEqual({ limit: 10_000 });
    expect(() => journalEntriesSourceNode.validateConfig({ limit: 0 })).toThrowError(ConfigError);
    expect(() => journalEntriesSourceNode.validateConfig({ limit: 10_001 })).toThrowError(ConfigError);
    expect(() => journalEntriesSourceNode.validateConfig({ limit: 1.5 })).toThrowError(ConfigError);
  });

  it('例外: config が null / 配列でも ConfigError で止まる（throw は ConfigError だけ）', () => {
    expect(() => journalEntriesSourceNode.validateConfig(null)).toThrowError(ConfigError);
    expect(() => journalEntriesSourceNode.validateConfig([])).toThrowError(ConfigError);
  });
});

describe('journal-entries: inferSchema', () => {
  it('正常: 14 列の固定スキーマを confirmed で返す', () => {
    const inference = journalEntriesSourceNode.inferSchema([], {});
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema.columns.map((column) => column.name)).toEqual([...JOURNAL_ENTRIES_COLUMNS]);
    expect(inference.schema).toEqual(JOURNAL_ENTRIES_SCHEMA);
  });

  it('境界: 借方 / 貸方の列だけが nullable（複合仕訳で片側が空になるため）', () => {
    const nullable = JOURNAL_ENTRIES_SCHEMA.columns.filter((column) => column.nullable).map((column) => column.name);
    expect(nullable).toEqual([
      'debit_account', 'debit_tax_code', 'debit_amount',
      'credit_account', 'credit_tax_code', 'credit_amount',
      'document_id', 'rule_id',
    ]);
  });

  it('正常: config を変えてもスキーマは変わらない（絞り込みは行だけに効く）', () => {
    expect(journalEntriesSourceNode.inferSchema([], { status: 'confirmed', limit: 3 }).schema)
      .toEqual(journalEntriesSourceNode.inferSchema([], {}).schema);
  });
});

describe('journal-entries: execute', () => {
  it('異常: 未解決のまま実行しても投げず、空テーブルを返す（解決は application 層の責務）', () => {
    const table = journalEntriesSourceNode.execute([], { status: 'confirmed' });
    expect(table.rows).toEqual([]);
    expect(table.schema).toEqual(JOURNAL_ENTRIES_SCHEMA);
  });

  it('境界: 空でもスキーマは固定なので、下流の列参照が壊れない', () => {
    expect(journalEntriesSourceNode.execute([], {}).schema.columns).toHaveLength(14);
  });
});

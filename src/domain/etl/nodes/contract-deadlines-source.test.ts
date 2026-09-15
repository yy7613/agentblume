import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { CONTRACT_DEADLINES_SCHEMA, contractDeadlinesSourceNode } from './contract-deadlines-source';

const node = contractDeadlinesSourceNode;

describe('contract-deadlines: メタデータ', () => {
  it('正常: source / arity 0', () => {
    expect([node.type, node.kind, node.inputArity]).toEqual(['contract-deadlines', 'source', 0]);
  });
});

describe('contract-deadlines: validateConfig', () => {
  it('正常: 空 config と全項目、未知のキーは落とす', () => {
    expect(node.validateConfig({})).toEqual({});
    expect(node.validateConfig({ includeOverdue: false, horizonDays: 90, limit: 50, other: 1 })).toEqual({ includeOverdue: false, horizonDays: 90, limit: 50 });
  });

  it.each([
    [{ horizonDays: 1 }], [{ horizonDays: 36_500 }], [{ limit: 1 }], [{ limit: 10_000 }], [{ includeOverdue: true }],
  ])('境界: %o は受理する', (config) => {
    expect(node.validateConfig(config)).toEqual(config);
  });

  it.each([
    [{ horizonDays: 0 }], [{ horizonDays: 36_501 }], [{ horizonDays: 1.5 }], [{ limit: 0 }], [{ limit: 10_001 }], [{ includeOverdue: 'yes' }],
  ])('異常: %o は ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(/^contract-deadlines: invalid config: /u);
  });

  it.each([null, [], 'x'])('例外: object でない config %o も ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(ConfigError);
  });
});

describe('contract-deadlines: inferSchema / execute', () => {
  it('正常: 固定スキーマで confirmed。列の並び（docs/23 §9.2）', () => {
    expect(node.inferSchema([], { limit: 1 })).toEqual({ schema: CONTRACT_DEADLINES_SCHEMA, state: 'confirmed', issues: [] });
    expect(CONTRACT_DEADLINES_SCHEMA.columns.map((column) => column.name)).toEqual(['contract_id', 'title', 'counterparty', 'kind', 'due_date', 'days_left', 'state', 'term_index', 'term_end', 'auto_renewal', 'basis', 'today']);
    expect(CONTRACT_DEADLINES_SCHEMA.columns.filter((column) => column.nullable).map((column) => column.name)).toEqual(['term_index', 'term_end']);
  });

  it('例外: 未解決のまま実行されても投げずに空テーブル', () => {
    expect(node.execute([], {})).toEqual({ schema: CONTRACT_DEADLINES_SCHEMA, rows: [] });
  });
});

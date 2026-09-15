import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { CONTRACT_CLAUSES_SCHEMA, CONTRACT_CLAUSES_STATUSES, contractClausesSourceNode } from './contract-clauses-source';

const node = contractClausesSourceNode;

describe('contract-clauses: メタデータ', () => {
  it('正常: source / arity 0', () => {
    expect([node.type, node.kind, node.inputArity]).toEqual(['contract-clauses', 'source', 0]);
  });
});

describe('contract-clauses: validateConfig', () => {
  it('正常: 空 config と全項目、未知のキーは落とす', () => {
    expect(node.validateConfig({})).toEqual({});
    expect(node.validateConfig({ status: 'active', limit: 10, other: 1 })).toEqual({ status: 'active', limit: 10 });
  });

  it.each(CONTRACT_CLAUSES_STATUSES.map((status) => [status]))('正常: status %s を受理する', (status) => {
    expect(node.validateConfig({ status })).toEqual({ status });
  });

  it.each([[{ limit: 1 }], [{ limit: 10_000 }]])('境界: %o は受理する', (config) => {
    expect(node.validateConfig(config)).toEqual(config);
  });

  it.each([
    [{ status: 'draft' }], [{ status: '' }], [{ limit: 0 }], [{ limit: 10_001 }], [{ limit: 2.5 }],
  ])('異常: %o は ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(/^contract-clauses: invalid config: /u);
  });

  it.each([null, [], 1])('例外: object でない config %o も ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(ConfigError);
  });
});

describe('contract-clauses: inferSchema / execute', () => {
  it('正常: 固定スキーマで confirmed。列の並び（docs/23 §9.3）', () => {
    expect(node.inferSchema([], { status: 'expired' })).toEqual({ schema: CONTRACT_CLAUSES_SCHEMA, state: 'confirmed', issues: [] });
    expect(CONTRACT_CLAUSES_SCHEMA.columns.map((column) => column.name)).toEqual([
      'contract_id', 'title', 'counterparty', 'signed_date', 'contract_status', 'topic_id', 'topic_label', 'present', 'value_summary', 'tags', 'article_ref', 'quote', 'review_verdict', 'value_json',
    ]);
    // 条項が無い種類も present = false の行で出すので、値の列は null を許す。
    expect(CONTRACT_CLAUSES_SCHEMA.columns.filter((column) => column.nullable).map((column) => column.name)).toEqual(['value_summary', 'article_ref', 'quote', 'review_verdict', 'value_json']);
  });

  it('例外: 未解決のまま実行されても投げずに空テーブル', () => {
    expect(node.execute([], {})).toEqual({ schema: CONTRACT_CLAUSES_SCHEMA, rows: [] });
  });
});

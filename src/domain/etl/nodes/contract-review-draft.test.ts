import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { CONTRACT_REVIEW_DRAFT_SCHEMA, contractReviewDraftSourceNode } from './contract-review-draft';

const node = contractReviewDraftSourceNode;

describe('contract-review-draft: メタデータ', () => {
  it('正常: source / arity 0', () => {
    expect([node.type, node.kind, node.inputArity]).toEqual(['contract-review-draft', 'source', 0]);
  });
});

describe('contract-review-draft: validateConfig', () => {
  it('正常: 空 config（既定の審査基準・LLM 基準あり）を受理する', () => {
    expect(node.validateConfig({})).toEqual({});
  });

  it('正常: 全項目をそのまま返し、未知のキーは落とす', () => {
    expect(node.validateConfig({ playbookId: 'pb1', llmCriteria: false, limit: 2, other: 'x' })).toEqual({ playbookId: 'pb1', llmCriteria: false, limit: 2 });
  });

  it.each([
    [{ limit: 1 }], [{ limit: 2 }], [{ playbookId: 'x' }], [{ playbookId: 'x'.repeat(100) }],
  ])('境界: %o は受理する', (config) => {
    expect(node.validateConfig(config)).toEqual(config);
  });

  it.each([
    [{ limit: 0 }], [{ limit: 3 }], [{ limit: 1.5 }], [{ limit: '1' }], [{ playbookId: '' }], [{ playbookId: 'x'.repeat(101) }], [{ llmCriteria: 'yes' }],
  ])('異常: %o は ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(ConfigError);
    expect(() => node.validateConfig(config)).toThrowError(/^contract-review-draft: invalid config: /u);
  });

  it.each([null, [], 'x', 1])('例外: object でない config %o も ConfigError', (config) => {
    expect(() => node.validateConfig(config)).toThrowError(ConfigError);
  });
});

describe('contract-review-draft: inferSchema / execute', () => {
  it('正常: スキーマは config に依存せず固定で confirmed', () => {
    const first = node.inferSchema([], {});
    expect(first).toEqual({ schema: CONTRACT_REVIEW_DRAFT_SCHEMA, state: 'confirmed', issues: [] });
    expect(node.inferSchema([], { limit: 2, llmCriteria: false }).schema).toEqual(first.schema);
  });

  it('正常: 列の並びと常に埋まる列（docs/23 §9.1）', () => {
    expect(CONTRACT_REVIEW_DRAFT_SCHEMA.columns.map((column) => column.name)).toEqual([
      'file_name', 'playbook_name', 'overall', 'row_type', 'topic_id', 'topic_label', 'verdict', 'present', 'article_ref', 'quote', 'quote_verified',
      'value_summary', 'reasons', 'recommended_text', 'findings', 'value_json', 'criteria_json',
    ]);
    expect(CONTRACT_REVIEW_DRAFT_SCHEMA.columns.filter((column) => !column.nullable).map((column) => column.name)).toEqual(['file_name', 'playbook_name', 'overall', 'row_type', 'reasons', 'findings', 'value_json', 'criteria_json']);
  });

  it('例外: リゾルバが書き換えていないときは投げずに空テーブル', () => {
    // 設計時プレビューで落とさないため（拒否は application 層の責務）。
    expect(node.execute([], {})).toEqual({ schema: CONTRACT_REVIEW_DRAFT_SCHEMA, rows: [] });
  });
});

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { NodeRegistry } from '../registry';
import { EXPENSE_CLAIMS_COLUMNS, EXPENSE_CLAIMS_SCHEMA, expenseClaimsSourceNode } from './expense-claims-source';
import { registerExpenseNodes } from './expense-nodes';
import { EXPENSE_POLICY_COLUMNS, EXPENSE_POLICY_SCHEMA, expensePolicySourceNode } from './expense-policy-source';
import { EXPENSE_RECEIPT_CHECK_COLUMNS, EXPENSE_RECEIPT_CHECK_SCHEMA, expenseReceiptCheckSourceNode } from './expense-receipt-check';

describe('expense-receipt-check', () => {
  it('正常: limit 省略・1・8 を受け付ける', () => {
    expect(expenseReceiptCheckSourceNode.validateConfig({})).toEqual({});
    expect(expenseReceiptCheckSourceNode.validateConfig({ limit: 1 })).toEqual({ limit: 1 });
    expect(expenseReceiptCheckSourceNode.validateConfig({ limit: 8 })).toEqual({ limit: 8 });
  });

  it.each([0, 9, 1.5, '2'])('境界: limit %s は ConfigError', (limit) => {
    expect(() => expenseReceiptCheckSourceNode.validateConfig({ limit })).toThrow(ConfigError);
  });

  it('異常: config が object でなければ ConfigError', () => {
    expect(() => expenseReceiptCheckSourceNode.validateConfig(null)).toThrow(/expense-receipt-check: invalid config/u);
  });

  it('正常: 出力スキーマは固定・confirmed で、列順は COLUMNS と同じ', () => {
    expect(expenseReceiptCheckSourceNode.inferSchema([], {})).toEqual({ schema: EXPENSE_RECEIPT_CHECK_SCHEMA, state: 'confirmed', issues: [] });
    expect(EXPENSE_RECEIPT_CHECK_SCHEMA.columns.map((column) => column.name)).toEqual([...EXPENSE_RECEIPT_CHECK_COLUMNS]);
  });

  it('境界: 解決されずに execute されたら例外にせず空表', () => {
    expect(expenseReceiptCheckSourceNode.execute([], {})).toEqual({ schema: EXPENSE_RECEIPT_CHECK_SCHEMA, rows: [] });
  });
});

describe('expense-claims', () => {
  it('正常: status と limit を受け付ける', () => {
    expect(expenseClaimsSourceNode.validateConfig({ status: 'approved', limit: 500 })).toEqual({ status: 'approved', limit: 500 });
    expect(expenseClaimsSourceNode.validateConfig({})).toEqual({});
  });

  it('異常: 未知の status・範囲外の limit は ConfigError', () => {
    expect(() => expenseClaimsSourceNode.validateConfig({ status: 'open' })).toThrow(/expense-claims: invalid config/u);
    expect(() => expenseClaimsSourceNode.validateConfig({ limit: 501 })).toThrow(ConfigError);
    expect(() => expenseClaimsSourceNode.validateConfig({ limit: 0 })).toThrow(ConfigError);
  });

  it('正常: 出力スキーマは固定・confirmed、execute は空表', () => {
    expect(expenseClaimsSourceNode.inferSchema([], {})).toEqual({ schema: EXPENSE_CLAIMS_SCHEMA, state: 'confirmed', issues: [] });
    expect(EXPENSE_CLAIMS_SCHEMA.columns.map((column) => column.name)).toEqual([...EXPENSE_CLAIMS_COLUMNS]);
    expect(expenseClaimsSourceNode.execute([], {})).toEqual({ schema: EXPENSE_CLAIMS_SCHEMA, rows: [] });
  });
});

describe('expense-policy', () => {
  it('正常: 空の config を受け付ける', () => {
    expect(expensePolicySourceNode.validateConfig({})).toEqual({});
  });

  it('異常: object でない config は ConfigError', () => {
    expect(() => expensePolicySourceNode.validateConfig('x')).toThrow(/expense-policy: invalid config/u);
  });

  it('正常: 出力スキーマは固定・confirmed、execute は空表', () => {
    expect(expensePolicySourceNode.inferSchema([], {})).toEqual({ schema: EXPENSE_POLICY_SCHEMA, state: 'confirmed', issues: [] });
    expect(EXPENSE_POLICY_SCHEMA.columns.map((column) => column.name)).toEqual([...EXPENSE_POLICY_COLUMNS]);
    expect(expensePolicySourceNode.execute([], {})).toEqual({ schema: EXPENSE_POLICY_SCHEMA, rows: [] });
  });
});

describe('registerExpenseNodes', () => {
  it('正常: 骨格の 3 つと系統（B の 3 つ・C の 1 つ）の 7 つの型を登録する（arity 0 の source）', () => {
    const registry = new NodeRegistry();
    registerExpenseNodes(registry);
    expect(registry.types().sort()).toEqual(['expense-advances', 'expense-card-transactions', 'expense-claims', 'expense-fares', 'expense-policy', 'expense-receipt-check', 'expense-summary']);
    for (const type of registry.types()) {
      expect(registry.get(type)).toMatchObject({ kind: 'source', inputArity: 0 });
    }
  });
});

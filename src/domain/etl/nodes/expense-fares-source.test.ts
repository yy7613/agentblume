import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { NodeRegistry } from '../registry';
import { EXPENSE_FARES_COLUMNS, EXPENSE_FARES_SCHEMA, expenseFaresSourceNode } from './expense-fares-source';
import { registerExpenseInputNodes } from './expense-input-nodes';

describe('expense-fares', () => {
  it('正常: 空の config を受け付ける', () => {
    expect(expenseFaresSourceNode.validateConfig({})).toEqual({});
  });

  it('異常: 設定を持たないので、キーがある・object でない config は ConfigError', () => {
    expect(() => expenseFaresSourceNode.validateConfig({ limit: 10 })).toThrow(ConfigError);
    expect(() => expenseFaresSourceNode.validateConfig('x')).toThrow(/expense-fares: invalid config/u);
  });

  it('正常: 出力スキーマは固定・confirmed で列順は COLUMNS と同じ。解決されずに execute されたら空表', () => {
    expect(expenseFaresSourceNode.inferSchema([], {})).toEqual({ schema: EXPENSE_FARES_SCHEMA, state: 'confirmed', issues: [] });
    expect(EXPENSE_FARES_SCHEMA.columns.map((column) => column.name)).toEqual([...EXPENSE_FARES_COLUMNS]);
    expect(expenseFaresSourceNode.execute([], {})).toEqual({ schema: EXPENSE_FARES_SCHEMA, rows: [] });
  });

  it('正常: registerExpenseInputNodes が expense-fares を登録する', () => {
    const registry = new NodeRegistry();
    registerExpenseInputNodes(registry);
    expect(registry.get('expense-fares')).toBe(expenseFaresSourceNode);
  });
});

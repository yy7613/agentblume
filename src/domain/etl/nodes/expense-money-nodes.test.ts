import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import type { NodeRegistry } from '../registry';
import { EXPENSE_ADVANCES_SCHEMA, expenseAdvancesSourceNode } from './expense-advances-source';
import { EXPENSE_CARD_TRANSACTIONS_SCHEMA, expenseCardTransactionsSourceNode } from './expense-card-transactions-source';
import { registerExpenseMoneyNodes } from './expense-money-nodes';
import { EXPENSE_SUMMARY_SCHEMA, expenseSummarySourceNode } from './expense-summary-source';

const nodes = [
  { node: expenseSummarySourceNode, schema: EXPENSE_SUMMARY_SCHEMA, max: 2000 },
  { node: expenseAdvancesSourceNode, schema: EXPENSE_ADVANCES_SCHEMA, max: 500 },
  { node: expenseCardTransactionsSourceNode, schema: EXPENSE_CARD_TRANSACTIONS_SCHEMA, max: 2000 },
] as const;

describe('お金の流れのソースノード', () => {
  it.each(nodes)('正常: $node.type は arity 0 の source で、固定スキーマを confirmed で返し、実行前は空表', ({ node, schema, max }) => {
    expect(node.kind).toBe('source');
    expect(node.inputArity).toBe(0);
    expect(node.validateConfig({})).toEqual({});
    expect(node.validateConfig({ limit: max })).toEqual({ limit: max });
    expect(node.inferSchema([], {})).toEqual({ schema, state: 'confirmed', issues: [] });
    expect(node.execute([], {})).toEqual({ schema, rows: [] });
  });

  it.each(nodes)('境界: $node.type の limit は 1〜上限の整数', ({ node, max }) => {
    expect(() => node.validateConfig({ limit: 0 })).toThrow(ConfigError);
    expect(() => node.validateConfig({ limit: max + 1 })).toThrow(ConfigError);
    expect(() => node.validateConfig({ limit: 1.5 })).toThrow(`${node.type}: invalid config`);
  });

  it('正常: 口座番号・通勤定期の列を持たない', () => {
    for (const { schema } of nodes) expect(schema.columns.map((column) => column.name).join(',')).not.toMatch(/account|commuter|bank/u);
  });

  it('正常: 3 つのノード型を登録する', () => {
    const registered: string[] = [];
    registerExpenseMoneyNodes({ register: (node: { type: string }) => { registered.push(node.type); } } as unknown as NodeRegistry);
    expect(registered).toEqual(['expense-summary', 'expense-advances', 'expense-card-transactions']);
  });
});

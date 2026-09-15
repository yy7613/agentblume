/**
 * 経費精算「お金の流れ」の組込みツール定義（docs/21 §20.11.1〜3）のテスト。
 *
 * 共通のシードループで実際に保存し（保存時にグラフとスキーマの点検が走る）、読み取り専用の約束・公開名・引数の形・説明文を固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE } from '../builtin-tools';
import { createApp, type App } from '../composition/root';
import { EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID, EXPENSE_MONEY_BUILTIN_TOOLS, EXPENSE_SUMMARY_TOOL_ID } from './expense-money';
import { seedTools } from './seed';

describe('EXPENSE_MONEY_BUILTIN_TOOLS', () => {
  const apps: App[] = [];
  afterEach(() => { for (const app of apps.splice(0)) app.close(); });

  it('正常: 3 本とも builtin-expense-* / expense_* の読み取り専用で、説明は「読むだけ」と口座を出さないことを書く', () => {
    expect(EXPENSE_MONEY_BUILTIN_TOOLS.map((tool) => tool.internalId)).toEqual([EXPENSE_SUMMARY_TOOL_ID, EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID]);
    expect(EXPENSE_MONEY_BUILTIN_TOOLS.map((tool) => tool.publishName)).toEqual(['expense_summary', 'expense_advances', 'expense_card_transactions']);
    for (const tool of EXPENSE_MONEY_BUILTIN_TOOLS) {
      expect(tool.agentTool?.name).toBe(tool.publishName);
      expect(tool.sideEffect).toBe('read-only');
      expect(tool.owner).toBe('builtin');
      expect(tool.agentTool?.description).toMatch(/It only reads/u);
    }
    expect(EXPENSE_MONEY_BUILTIN_TOOLS[0]?.agentTool?.description).toMatch(/^Returns totals of the expense claims in this workspace grouped the way you ask/u);
    expect(EXPENSE_MONEY_BUILTIN_TOOLS[0]?.agentTool?.description).toMatch(/bank accounts and receipt images are never included/u);
    expect(EXPENSE_MONEY_BUILTIN_TOOLS[1]?.agentTool?.description).toMatch(/^Returns the cash advances of this workspace.*Bank accounts are never included/u);
    expect(EXPENSE_MONEY_BUILTIN_TOOLS[2]?.agentTool?.description).toMatch(/^Returns the corporate card transactions imported into this workspace/u);
  });

  it('正常: 共通ループでシードでき（グラフの点検を通る）、ノードの並びと引数が仕様どおり', async () => {
    const app = createApp({ profile: 'test' });
    apps.push(app);
    expect(await seedTools(app, BUILTIN_SCOPE, EXPENSE_MONEY_BUILTIN_TOOLS)).toEqual([EXPENSE_SUMMARY_TOOL_ID, EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID]);

    const summary = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_SUMMARY_TOOL_ID);
    expect(summary.graph.nodes.map((node) => node.type)).toEqual(['expense-summary', 'agent-input', 'filter', 'agent-output']);
    expect(summary.inputSchema?.columns.map((column) => [column.name, column.nullable])).toEqual([['period', true], ['group_by', true], ['status', true], ['department', true]]);
    // period / group_by / status は行ソースが引数として読むので、agent-input にエッジを張らない。
    expect(summary.graph.edges.some((edge) => edge.from === 'arguments' || edge.to === 'arguments')).toBe(false);

    const advances = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_ADVANCES_TOOL_ID);
    expect(advances.graph.nodes.map((node) => node.type)).toEqual(['expense-advances', 'agent-input', 'filter', 'filter', 'agent-output']);
    expect(advances.inputSchema?.columns.map((column) => column.name)).toEqual(['employee', 'status']);

    const cards = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_CARD_TRANSACTIONS_TOOL_ID);
    expect(cards.graph.nodes.map((node) => node.type)).toEqual(['expense-card-transactions', 'agent-input', 'filter', 'filter', 'filter', 'agent-output']);
    expect(cards.inputSchema?.columns.map((column) => column.name)).toEqual(['status', 'card', 'period']);

    // 冪等: 2 回目は何も足さない。
    expect(await seedTools(app, BUILTIN_SCOPE, EXPENSE_MONEY_BUILTIN_TOOLS)).toHaveLength(3);
  });
});

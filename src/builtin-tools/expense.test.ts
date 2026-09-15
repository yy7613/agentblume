/**
 * 経費精算の組込みツール定義（docs/21 §13）のテスト。
 *
 * 共通のシードループで実際に保存し（保存時にグラフとスキーマの点検が走る）、読み取り専用の約束と公開名・引数の形を固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE } from '../builtin-tools';
import { createApp, type App } from '../composition/root';
import { EXPENSE_BUILTIN_TOOLS, EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID } from './expense';
import { EXPENSE_INPUT_BUILTIN_TOOLS } from './expense-input';
import { EXPENSE_MONEY_BUILTIN_TOOLS } from './expense-money';
import { seedTools } from './seed';

describe('EXPENSE_BUILTIN_TOOLS', () => {
  const apps: App[] = [];
  afterEach(() => { for (const app of apps.splice(0)) app.close(); });

  // 骨格の 3 本の後ろに系統（B お金の流れ → C 入力と規程）のツールを並べる（系統のツールの中身は各系統のテストで固定する）。
  const ALL_IDS = [EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID, ...EXPENSE_MONEY_BUILTIN_TOOLS.map((tool) => tool.internalId), ...EXPENSE_INPUT_BUILTIN_TOOLS.map((tool) => tool.internalId)];

  it('正常: 骨格の 3 本と系統の 4 本（計 7 本）とも builtin-expense-* / expense_* の読み取り専用で、説明に「読むだけ」を書く', () => {
    expect(EXPENSE_BUILTIN_TOOLS.map((tool) => tool.internalId)).toEqual(ALL_IDS);
    expect(ALL_IDS).toHaveLength(7);
    for (const tool of EXPENSE_BUILTIN_TOOLS) {
      expect(tool.internalId.startsWith('builtin-expense-')).toBe(true);
      expect(tool.publishName.startsWith('expense_')).toBe(true);
      expect(tool.agentTool?.name).toBe(tool.publishName);
      expect(tool.sideEffect).toBe('read-only');
      expect(tool.owner).toBe('builtin');
      expect(tool.agentTool?.description).toMatch(/It only reads/u);
    }
  });

  it('正常: 共通ループでシードでき（グラフの点検を通る）、ノードの並びと引数が仕様どおり', async () => {
    const app = createApp({ profile: 'test' });
    apps.push(app);
    expect(await seedTools(app, BUILTIN_SCOPE, EXPENSE_BUILTIN_TOOLS)).toEqual(ALL_IDS);

    const check = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_CHECK_RECEIPT_TOOL_ID);
    expect(check.graph.nodes.map((node) => node.type)).toEqual(['expense-receipt-check', 'agent-output']);
    expect(check.inputSchema).toBeUndefined();

    const claims = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_CLAIMS_TOOL_ID);
    expect(claims.graph.nodes.map((node) => node.type)).toEqual(['expense-claims', 'agent-input', 'filter', 'filter', 'filter', 'agent-output']);
    expect(claims.inputSchema?.columns.map((column) => [column.name, column.nullable])).toEqual([['claimant', true], ['period', true], ['status', true]]);
    // 組込みは状態を焼き込まない（引数で絞る）。
    expect(claims.graph.nodes[0]?.config).toEqual({ limit: 500 });

    const policy = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_POLICY_TOOL_ID);
    expect(policy.graph.nodes.map((node) => node.type)).toEqual(['expense-policy', 'agent-output']);

    // 冪等: 2 回目は保存しない（版が増えない）。
    await seedTools(app, BUILTIN_SCOPE, EXPENSE_BUILTIN_TOOLS);
    expect((await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_CLAIMS_TOOL_ID)).metadata.version.toString()).toBe('1.0.0');
  });

  it('正常: 規程ツールは保存しなくても（文脈に依らず）プレビューで初期テンプレートの費目を返す', async () => {
    const app = createApp({ profile: 'test' });
    apps.push(app);
    await seedTools(app, BUILTIN_SCOPE, EXPENSE_BUILTIN_TOOLS);
    const { result } = await app.previewTool.preview(BUILTIN_SCOPE, EXPENSE_POLICY_TOOL_ID);
    expect(result.output.rows.length).toBeGreaterThan(5);
    expect(result.output.rows[0]).toMatchObject({ policy_saved: false });
    expect(await app.expensePolicyRepo.get(BUILTIN_SCOPE)).toBeNull();
  });
});

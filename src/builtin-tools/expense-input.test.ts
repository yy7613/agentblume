/**
 * 経費精算「入力と規程」の組込みツール（expense_fares。docs/21 §20.11.4）のテスト。
 *
 * 共通のシードループで実際に保存し（保存時にグラフとスキーマの点検が走る）、読み取り専用の約束と引数の形を固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE } from '../builtin-tools';
import { createApp, type App } from '../composition/root';
import { EXPENSE_FARES_TOOL_ID, EXPENSE_INPUT_BUILTIN_TOOLS } from './expense-input';
import { seedTools } from './seed';

describe('EXPENSE_INPUT_BUILTIN_TOOLS', () => {
  const apps: App[] = [];
  afterEach(() => { for (const app of apps.splice(0)) app.close(); });

  it('正常: expense_fares の 1 本だけで、読み取り専用。説明は「読むだけ」と「通勤定期を含めない」を書く', () => {
    expect(EXPENSE_INPUT_BUILTIN_TOOLS.map((tool) => tool.internalId)).toEqual([EXPENSE_FARES_TOOL_ID]);
    const [tool] = EXPENSE_INPUT_BUILTIN_TOOLS;
    expect(tool).toMatchObject({ internalId: 'builtin-expense-fares', publishName: 'expense_fares', owner: 'builtin', sideEffect: 'read-only', agentTool: { name: 'expense_fares' } });
    expect(tool?.agentTool?.description).toMatch(/It only reads/u);
    expect(tool?.agentTool?.description).toContain("Employees' commuter passes are not included");
  });

  it('正常: 共通ループでシードでき、ノードの並びと引数（from / to を stations の部分一致に束縛）が仕様どおり', async () => {
    const app = createApp({ profile: 'test' });
    apps.push(app);
    expect(await seedTools(app, BUILTIN_SCOPE, EXPENSE_INPUT_BUILTIN_TOOLS)).toEqual([EXPENSE_FARES_TOOL_ID]);
    const tool = await app.getTool.latest(BUILTIN_SCOPE, EXPENSE_FARES_TOOL_ID);
    expect(tool.graph.nodes.map((node) => node.type)).toEqual(['expense-fares', 'agent-input', 'filter', 'filter', 'agent-output']);
    expect(tool.inputSchema?.columns.map((column) => [column.name, column.nullable])).toEqual([['from', true], ['to', true]]);
    const filters = tool.graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config as Record<string, unknown>);
    expect(filters.map((config) => [config['column'], config['op'], config['caseInsensitive'], (config['valueBinding'] as { field: string }).field])).toEqual([
      ['stations', 'contains', true, 'from'], ['stations', 'contains', true, 'to'],
    ]);
    expect(tool.graph.edges).toEqual([{ from: 'fares', to: 'by-from' }, { from: 'by-from', to: 'by-to' }, { from: 'by-to', to: 'agent-result' }]);
  });
});

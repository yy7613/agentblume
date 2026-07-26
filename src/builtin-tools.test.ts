import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE, CURRENT_DATETIME_TOOL_ID, seedBuiltinTools } from './builtin-tools';
import { createApp, type App } from './composition/root';

describe('seedBuiltinTools', () => {
  const apps: App[] = [];
  afterEach(() => { for (const app of apps.splice(0)) app.close(); });

  function newApp(): App {
    const app = createApp({ profile: 'test' });
    apps.push(app);
    return app;
  }

  it('空のリポジトリへ現在日時ツールをシードする', async () => {
    const app = newApp();
    expect(await app.listTools.execute(BUILTIN_SCOPE)).toHaveLength(0);

    const result = await seedBuiltinTools(app);

    expect(result.toolIds).toEqual([CURRENT_DATETIME_TOOL_ID]);
    const tool = await app.getTool.latest(BUILTIN_SCOPE, CURRENT_DATETIME_TOOL_ID);
    expect(tool.metadata.publishName).toBe('current_datetime');
    expect(tool.metadata.displayName).toBe('Current Datetime');
    expect(tool.metadata.owner).toBe('builtin');
    expect(tool.metadata.version.toString()).toBe('1.0.0');
    expect(tool.sideEffect).toBe('read-only');
    expect(tool.agentTool?.name).toBe('current_datetime');
    expect(tool.agentTool?.description).toContain('current date and time');
    expect(tool.graph.nodes.map((node) => node.type)).toEqual(['current-datetime', 'agent-output']);
  });

  it('再実行しても重複せず、新しいバージョンも作らない（冪等）', async () => {
    const app = newApp();

    const first = await seedBuiltinTools(app);
    const second = await seedBuiltinTools(app);

    expect(second).toEqual(first);
    expect((await app.listTools.execute(BUILTIN_SCOPE)).filter((tool) => tool.internalId === CURRENT_DATETIME_TOOL_ID)).toHaveLength(1);
    expect((await app.getTool.latest(BUILTIN_SCOPE, CURRENT_DATETIME_TOOL_ID)).metadata.version.toString()).toBe('1.0.0');
  });

  it('生成したツールはengineでプレビュー実行できて1行の日時を返す', async () => {
    const app = newApp();
    await seedBuiltinTools(app);

    const { result } = await app.previewTool.preview(BUILTIN_SCOPE, CURRENT_DATETIME_TOOL_ID);

    expect(result.output.schema.columns.map((column) => column.name)).toEqual(['now', 'date', 'yearMonth', 'time', 'weekday']);
    expect(result.output.rows).toHaveLength(1);
    const row = result.output.rows[0]!;
    expect(row['now']).toBeInstanceOf(Date);
    expect(row['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row['yearMonth']).toMatch(/^\d{4}-\d{2}$/);
    expect(row['time']).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row['weekday']).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
  });
});

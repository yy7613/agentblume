/**
 * 組み込みツール（あらかじめ用意されたツール）のシード。
 *
 * 手動確認用の `sample-data.ts` と同じ層・同じ流儀だが、こちらは環境変数に関係なく
 * **サーバー起動時に必ず**呼び出す。よく使うツールを毎回作り直さずエージェントへ
 * 割り当てられるようにするため。冪等: 既に同じ internalId があれば何もしない。
 */
import type { App } from './composition/root';

export const BUILTIN_SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

/** 現在日時ツールの internalId。 */
export const CURRENT_DATETIME_TOOL_ID = 'builtin-current-datetime';

export interface BuiltinToolsResult {
  readonly toolIds: readonly string[];
}

export async function seedBuiltinTools(app: App): Promise<BuiltinToolsResult> {
  const scope = BUILTIN_SCOPE;
  const existing = await app.listTools.execute(scope);
  if (!existing.some((tool) => tool.internalId === CURRENT_DATETIME_TOOL_ID)) {
    await app.saveTool.execute({
      scope,
      internalId: CURRENT_DATETIME_TOOL_ID,
      workingName: 'Current datetime draft',
      displayName: 'Current Datetime',
      publishName: 'current_datetime',
      owner: 'builtin',
      sideEffect: 'read-only',
      graph: {
        nodes: [
          // config 空 = サーバーのローカルタイムゾーン。
          { id: 'now', type: 'current-datetime', config: {} },
          // 常に1行なので first-row でオブジェクト1つを返す。
          { id: 'agent-result', type: 'agent-output', config: { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 4096, overflow: 'error' } },
        ],
        edges: [{ from: 'now', to: 'agent-result' }],
      },
      agentTool: {
        name: 'current_datetime',
        description: 'Returns the current date and time (now, date, yearMonth, time, weekday). Call this when the user asks about today, now, or relative dates.',
      },
    });
  }
  return { toolIds: [CURRENT_DATETIME_TOOL_ID] };
}

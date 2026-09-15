/**
 * 業務に属さない組込みツール（現在日時）のシード定義。
 */
import type { BuiltinToolSeed } from './seed';

/** 現在日時ツールの internalId。 */
export const CURRENT_DATETIME_TOOL_ID = 'builtin-current-datetime';

export const CORE_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
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
  },
];

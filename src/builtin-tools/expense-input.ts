/**
 * 経費精算「入力と規程」の組込みツールのシード定義（docs/21 §20.11.4。read-only）。
 *
 * `expense_fares`（運賃マスタ）を足す。通勤定期はツールに出さない（個人の通勤経路の持ち出しになるため）。
 * 運賃マスタの変更・運賃の照合結果の保存はツールにしない（画面から人が行う。ADR-0040 §7）。
 */
import type { BuiltinToolSeed } from './seed';

export const EXPENSE_FARES_TOOL_ID = 'builtin-expense-fares';

/** 引数。すべて nullable = 省略可（省略した条件は実行時にスキップされる）。 */
const FARE_ARGUMENTS = {
  columns: [
    { name: 'from', type: 'string' as const, nullable: true },
    { name: 'to', type: 'string' as const, nullable: true },
  ],
};

export const EXPENSE_INPUT_BUILTIN_TOOLS: readonly BuiltinToolSeed[] = [
  {
    internalId: EXPENSE_FARES_TOOL_ID,
    workingName: 'Expense fares draft',
    displayName: 'Expense Fares',
    publishName: 'expense_fares',
    owner: 'builtin',
    sideEffect: 'read-only',
    inputSchema: FARE_ARGUMENTS,
    graph: {
      nodes: [
        { id: 'fares', type: 'expense-fares', config: {} },
        // 引数の宣言。filter の valueBinding がここへ束縛される（エッジは張らない）。
        { id: 'arguments', type: 'agent-input', config: { schema: FARE_ARGUMENTS, sample: { from: null, to: null } } },
        { id: 'by-from', type: 'filter', config: { column: 'stations', op: 'contains', value: '新宿', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'from' } } },
        { id: 'by-to', type: 'filter', config: { column: 'stations', op: 'contains', value: '霞ケ関', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'to' } } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 2000, maxBytes: 262_144, overflow: 'error' } },
      ],
      edges: [
        { from: 'fares', to: 'by-from' },
        { from: 'by-from', to: 'by-to' },
        { from: 'by-to', to: 'agent-result' },
      ],
    },
    agentTool: {
      name: 'expense_fares',
      description: 'Returns the fare table of this workspace, one row per registered route (route_id, stations, from, to, fare_type, fare, bidirectional, valid_from, valid_to, note, saved, updated_at). Call this when the user asks how much a regular trip costs, whether a claimed train or bus fare matches the registered fare, or which routes are registered. Narrow with from and to (part of a station name, case-insensitive, matched against the whole list of stations of the route); omit an argument to skip that filter. fare is the one-way fare in JPY for fare_type, which is ic for IC cards or ticket for paper tickets, so multiply it by the number of one-way trips; bidirectional true means the same fare applies in the reverse direction. stations lists the stations in order joined with " > ", starting with from and ending with to. The table is the company\'s own data, not live fare data: when a route is missing or may be outdated, tell the user to check the operator\'s fare and register it on the Expense screen. When saved is false no fare table has been saved yet. Employees\' commuter passes are not included. It only reads: it never changes the fare table or any claim.',
    },
  },
];

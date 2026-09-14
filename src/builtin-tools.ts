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

/** 仕訳参照ツールの internalId。 */
export const JOURNAL_ENTRIES_TOOL_ID = 'builtin-journal-entries';

/**
 * 仕訳参照ツールの引数（agent-input ノードの schema と一致させる）。
 * どちらも nullable = 省略できる: 省略された条件は実行時にスキップされ、全件が返る。
 */
const JOURNAL_ARGUMENTS = {
  columns: [
    { name: 'period', type: 'string' as const, nullable: true },
    { name: 'account', type: 'string' as const, nullable: true },
  ],
};

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
  if (!existing.some((tool) => tool.internalId === JOURNAL_ENTRIES_TOOL_ID)) {
    await app.saveTool.execute({
      scope,
      internalId: JOURNAL_ENTRIES_TOOL_ID,
      workingName: 'Journal entries draft',
      displayName: 'Journal Entries',
      publishName: 'journal_entries',
      owner: 'builtin',
      // 読むだけ。判定（状態を変える）・出力（ファイルを作る）はツール化しない（docs/20 §14）。
      sideEffect: 'read-only',
      inputSchema: JOURNAL_ARGUMENTS,
      graph: {
        nodes: [
          // 確定済みだけを見せる（下書きは「まだ帳簿に載っていない」ので数えさせない）。
          { id: 'entries', type: 'journal-entries', config: { status: 'confirmed', limit: 500 } },
          // 引数の宣言。filter の valueBinding がここへ束縛される（エッジは張らない）。
          { id: 'arguments', type: 'agent-input', config: { schema: JOURNAL_ARGUMENTS, sample: { period: null, account: null } } },
          // 期間: 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' の前方一致を contains で見る（date は文字列列）。
          { id: 'by-period', type: 'filter', config: { column: 'date', op: 'contains', value: '2026-09', valueBinding: { source: 'agent-input', field: 'period' } } },
          // 科目: 借方・貸方のどちらかに含まれれば残す（部分一致・大小文字を区別しない）。
          {
            id: 'by-account',
            type: 'filter',
            config: {
              conditions: [
                { column: 'debit_account', op: 'contains', value: '消耗品費', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'account' } },
                { column: 'credit_account', op: 'contains', value: '現金', caseInsensitive: true, valueBinding: { source: 'agent-input', field: 'account' } },
              ],
              combine: 'or',
            },
          },
          { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 500, maxBytes: 262_144, overflow: 'error' } },
        ],
        edges: [
          { from: 'entries', to: 'by-period' },
          { from: 'by-period', to: 'by-account' },
          { from: 'by-account', to: 'agent-result' },
        ],
      },
      agentTool: {
        name: 'journal_entries',
        description: 'Returns the confirmed journal entries (bookkeeping) of this workspace, one row per debit/credit pairing (entry_id, line_no, date, debit_account, debit_tax_code, debit_amount, credit_account, credit_tax_code, credit_amount, description, invoice_status, status, document_id, rule_id). Call this when the user asks about bookkeeping entries, how much was posted to an account, or the totals of a period. Narrow with period (a date prefix such as 2026 or 2026-09) and account (part of an account name, matched on either side); omit an argument to skip that filter. Amounts are tax-inclusive integers in JPY; a compound entry leaves the opposite side null. It only reads: it never judges documents, changes an entry, or writes a CSV file.',
      },
    });
  }
  return { toolIds: [CURRENT_DATETIME_TOOL_ID, JOURNAL_ENTRIES_TOOL_ID] };
}

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
export const JOURNAL_ATTACHMENT_TOOL_ID = 'builtin-journal-attachment';
export const JOURNAL_DRAFT_ENTRY_TOOL_ID = 'builtin-journal-draft-entry';

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
  if (!existing.some((tool) => tool.internalId === JOURNAL_ATTACHMENT_TOOL_ID)) {
    await app.saveTool.execute({
      scope,
      internalId: JOURNAL_ATTACHMENT_TOOL_ID,
      workingName: 'Journal attachment draft',
      displayName: 'Read Attached Document',
      publishName: 'journal_read_attachment',
      owner: 'builtin',
      // 読み取って返すだけ。帳票も仕訳も保存しない（判定・確定は画面から人が押す。docs/20 §14.1）。
      sideEffect: 'read-only',
      graph: {
        nodes: [
          // 添付は引数では運べない（数 MB の base64 をモデルに書かせることになる）ので、
          // 実行文脈から供給する。そのため agent-input は置かず、引数なしのツールにする。
          { id: 'attachment', type: 'journal-attachment', config: {} },
          { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 8, maxBytes: 262_144, overflow: 'error' } },
        ],
        edges: [{ from: 'attachment', to: 'agent-result' }],
      },
      agentTool: {
        name: 'journal_read_attachment',
        description: 'Reads the receipt or invoice image attached to the current message and returns the bookkeeping facts it could extract, one row per attachment (file_name, kind, issuer_name, registration_number, invoice_status, issue_date, transaction_date, grand_total, tax_10_taxable, tax_10_tax, tax_8_taxable, tax_8_tax, description, confidence, warnings, facts_json). Call this when the user attaches a receipt or invoice and asks what it is, how much it was, or how to post it. Takes no arguments: it always reads the attachments of this message. Amounts are tax-inclusive integers in JPY and fields that are not printed on the document come back null; read warnings before trusting the totals. It only reads: it does not save a document, create a journal entry, or write a CSV file. If nothing is attached it fails and says so, so ask the user to attach the image.',
      },
    });
  }
  if (!existing.some((tool) => tool.internalId === JOURNAL_DRAFT_ENTRY_TOOL_ID)) {
    await app.saveTool.execute({
      scope,
      internalId: JOURNAL_DRAFT_ENTRY_TOOL_ID,
      workingName: 'Journal draft entry draft',
      displayName: 'Draft Journal Entry',
      publishName: 'journal_draft_entry',
      owner: 'builtin',
      // 読み取りと判定は純粋。仕訳も帳票も保存しない（帳簿へ残すのは画面から人が押す。docs/20 §14.1）。
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'draft', type: 'journal-draft-entry', config: {} },
          { id: 'agent-result', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 64, maxBytes: 262_144, overflow: 'error' } },
        ],
        edges: [{ from: 'draft', to: 'agent-result' }],
      },
      agentTool: {
        name: 'journal_draft_entry',
        description: 'Reads the receipt or invoice image attached to the current message, judges it against the bookkeeping rules saved in this workspace, and returns the journal entry it would produce, one row per entry line (file_name, decided, reason, rule_id, rule_name, line_no, side, account, tax_code, amount, partner, date, description, invoice_status, facts_json). Call this when the user attaches a document and asks how it should be posted. Takes no arguments: it always reads the attachments of this message. When no rule matches, decided is false and reason says why (no-rule, multiple-rules, missing-fact, unknown-account, ask-if, rule-suggest-mode, document-kind) so you can tell the user what to fix. Amounts are tax-inclusive integers in JPY. It only proposes: it never saves the document, stores the entry, or writes a CSV file.',
      },
    });
  }
  return { toolIds: [CURRENT_DATETIME_TOOL_ID, JOURNAL_ENTRIES_TOOL_ID, JOURNAL_ATTACHMENT_TOOL_ID, JOURNAL_DRAFT_ENTRY_TOOL_ID] };
}

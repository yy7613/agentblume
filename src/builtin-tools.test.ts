import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCOPE, CURRENT_DATETIME_TOOL_ID, JOURNAL_ATTACHMENT_TOOL_ID, JOURNAL_DRAFT_ENTRY_TOOL_ID, JOURNAL_ENTRIES_TOOL_ID, seedBuiltinTools } from './builtin-tools';
import { CONTRACT_CLAUSES_TOOL_ID, CONTRACT_DEADLINES_TOOL_ID, CONTRACT_REVIEW_DRAFT_TOOL_ID } from './builtin-tools/contract';
import { EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID } from './builtin-tools/expense';
import { EXPENSE_FARES_TOOL_ID } from './builtin-tools/expense-input';
import { EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID, EXPENSE_SUMMARY_TOOL_ID } from './builtin-tools/expense-money';
import { RECEIVABLES_INVOICE_DRAFT_TOOL_ID, RECEIVABLES_MATCH_CANDIDATES_TOOL_ID, RECEIVABLES_OUTSTANDING_TOOL_ID } from './builtin-tools/receivables';
import { graphWithArguments } from './application/tool/tool-execution';
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

    // 業務の並び順（共通 → 仕訳 → 経費精算 → 入金消込 → 契約）どおりに返る（ADR-0039）。
    expect(result.toolIds).toEqual([
      CURRENT_DATETIME_TOOL_ID, JOURNAL_ENTRIES_TOOL_ID, JOURNAL_ATTACHMENT_TOOL_ID, JOURNAL_DRAFT_ENTRY_TOOL_ID,
      EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID,
      // 経費精算の系統のツール（B お金の流れ → C 入力と規程の順。EXPENSE_BUILTIN_TOOLS の並び）。
      EXPENSE_SUMMARY_TOOL_ID, EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID, EXPENSE_FARES_TOOL_ID,
      RECEIVABLES_OUTSTANDING_TOOL_ID, RECEIVABLES_MATCH_CANDIDATES_TOOL_ID, RECEIVABLES_INVOICE_DRAFT_TOOL_ID,
      CONTRACT_REVIEW_DRAFT_TOOL_ID, CONTRACT_DEADLINES_TOOL_ID, CONTRACT_CLAUSES_TOOL_ID,
    ]);
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
    expect((await app.listTools.execute(BUILTIN_SCOPE)).filter((tool) => tool.internalId === JOURNAL_ENTRIES_TOOL_ID)).toHaveLength(1);
    expect((await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID)).metadata.version.toString()).toBe('1.0.0');
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

  it('仕訳ツールを read-only の組込みツールとしてシードする', async () => {
    const app = newApp();

    await seedBuiltinTools(app);

    const tool = await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID);
    expect(tool.metadata.publishName).toBe('journal_entries');
    expect(tool.metadata.displayName).toBe('Journal Entries');
    expect(tool.metadata.owner).toBe('builtin');
    expect(tool.metadata.version.toString()).toBe('1.0.0');
    // 読むだけ（判定・出力はツール化しない）。
    expect(tool.sideEffect).toBe('read-only');
    expect(tool.agentTool?.name).toBe('journal_entries');
    expect(tool.agentTool?.description).toContain('confirmed journal entries');
    expect(tool.graph.nodes.map((node) => node.type)).toEqual(['journal-entries', 'agent-input', 'filter', 'filter', 'agent-output']);
    // 確定済みだけを見せる。
    expect(tool.graph.nodes[0]?.config).toMatchObject({ status: 'confirmed' });
    expect(tool.inputSchema?.columns.map((column) => column.name)).toEqual(['period', 'account']);
    // どちらの引数も省略できる（nullable）。
    expect(tool.inputSchema?.columns.every((column) => column.nullable)).toBe(true);
  });

  it('添付帳票の読み取りツールを、引数なしの read-only 組込みツールとしてシードする', async () => {
    const app = newApp();

    await seedBuiltinTools(app);

    const tool = await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_ATTACHMENT_TOOL_ID);
    expect(tool.metadata.publishName).toBe('journal_read_attachment');
    expect(tool.metadata.owner).toBe('builtin');
    expect(tool.sideEffect).toBe('read-only');
    expect(tool.agentTool?.name).toBe('journal_read_attachment');
    expect(tool.agentTool?.description).toContain('attached to the current message');
    expect(tool.graph.nodes.map((node) => node.type)).toEqual(['journal-attachment', 'agent-output']);
    // 添付は引数では運べない（数 MB の base64 になる）ので実行文脈から供給する。だから引数を持たない。
    expect(tool.graph.nodes.some((node) => node.type === 'agent-input')).toBe(false);
    expect(tool.inputSchema?.columns ?? []).toHaveLength(0);
  });

  it('取込から判定までを 1 本で通すツールを、引数なしの read-only 組込みツールとしてシードする', async () => {
    const app = newApp();

    await seedBuiltinTools(app);

    const tool = await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_DRAFT_ENTRY_TOOL_ID);
    expect(tool.metadata.publishName).toBe('journal_draft_entry');
    expect(tool.metadata.owner).toBe('builtin');
    // 判定は純粋関数で、仕訳も帳票も保存しない。
    expect(tool.sideEffect).toBe('read-only');
    expect(tool.agentTool?.description).toContain('judges it against the bookkeeping rules');
    expect(tool.agentTool?.description).toContain('never saves');
    expect(tool.graph.nodes.map((node) => node.type)).toEqual(['journal-draft-entry', 'agent-output']);
    expect(tool.inputSchema?.columns ?? []).toHaveLength(0);
  });

  it('引数は filter の valueBinding へ束縛され、省略した引数の条件は実行時にスキップされる', async () => {
    const app = newApp();
    await seedBuiltinTools(app);
    const tool = await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID);

    const narrowed = graphWithArguments(tool, { period: '2026-09', account: '消耗品費' });
    expect(narrowed.nodes.find((node) => node.id === 'by-period')?.config).toMatchObject({ column: 'date', op: 'contains', value: '2026-09' });
    expect((narrowed.nodes.find((node) => node.id === 'by-account')?.config as { conditions: { value: unknown }[] }).conditions.map((condition) => condition.value))
      .toEqual(['消耗品費', '消耗品費']);

    // 省略（null）は条件そのものを無効化する = 絞り込まない。
    const all = graphWithArguments(tool, { period: null, account: null });
    expect(all.nodes.find((node) => node.id === 'by-period')?.config).toMatchObject({ disabled: true });
    expect((all.nodes.find((node) => node.id === 'by-account')?.config as { conditions: { disabled?: boolean }[] }).conditions.every((condition) => condition.disabled === true)).toBe(true);
  });

  it('確定済みの仕訳だけを行として返す（下書きは返さない）', async () => {
    const app = newApp();
    await seedBuiltinTools(app);
    const saved = await app.saveJournalEntry.execute({
      scope: BUILTIN_SCOPE, date: '2026-09-10',
      lines: [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
      ],
      description: 'テスト仕入', invoiceStatus: 'qualified',
    });

    // 下書きのうちは見えない。
    expect((await app.previewTool.preview(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID)).result.output.rows).toEqual([]);

    await app.confirmJournalEntry.execute(BUILTIN_SCOPE, saved.id);
    const { result } = await app.previewTool.preview(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID);
    expect(result.output.schema.columns.map((column) => column.name)).toEqual([
      'entry_id', 'line_no', 'date', 'debit_account', 'debit_tax_code', 'debit_amount',
      'credit_account', 'credit_tax_code', 'credit_amount', 'description', 'invoice_status', 'status', 'document_id', 'rule_id',
    ]);
    expect(result.output.rows).toHaveLength(1);
    expect(result.output.rows[0]).toMatchObject({ debit_account: '消耗品費', debit_amount: 1100, credit_account: '現金', status: 'confirmed' });
  });

  it('仕訳が 1 件も無くても空の表を返す（列は消えない）', async () => {
    const app = newApp();
    await seedBuiltinTools(app);

    const { result } = await app.previewTool.preview(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID);
    expect(result.output.rows).toEqual([]);
    expect(result.output.schema.columns).toHaveLength(14);
  });
});

describe('seedBuiltinTools（壊れた前提でも壊さない）', () => {
  /** 最小の有効なツール（json-source → agent-output）。 */
  function minimalGraph() {
    return {
      nodes: [
        { id: 'rows', type: 'json-source', config: { rows: [{ value: 1 }] } },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 4096, overflow: 'error' } },
      ],
      edges: [{ from: 'rows', to: 'agent-result' }],
    };
  }

  it('異常: 同じ id のツールを利用者が先に作っていたら、上書きせずそのまま残す', async () => {
    // シードは id での冪等。利用者が手を入れたツールを起動のたびに書き戻すと、編集が黙って消える。
    const app = createApp({ profile: 'test' });
    try {
      await app.saveTool.execute({
        scope: BUILTIN_SCOPE,
        internalId: JOURNAL_ENTRIES_TOOL_ID,
        workingName: '自作',
        displayName: '自分で直した仕訳ツール',
        publishName: 'my_journal_entries',
        owner: 'me',
        sideEffect: 'read-only',
        graph: minimalGraph(),
      });

      const result = await seedBuiltinTools(app);

      expect(result.toolIds).toContain(JOURNAL_ENTRIES_TOOL_ID);
      const tool = await app.getTool.latest(BUILTIN_SCOPE, JOURNAL_ENTRIES_TOOL_ID);
      expect(tool.metadata.displayName).toBe('自分で直した仕訳ツール');
      expect(tool.metadata.owner).toBe('me');
      expect(tool.metadata.version.toString()).toBe('1.0.0');
    } finally { app.close(); }
  });

  it('例外: 同時に 2 回シードすると版の衝突として弾かれ、ツールは重複しない', async () => {
    // シードは「読んでから書く」ので、同時に走らせると後発が VersionConflictError になる。
    // 起動時に 1 回だけ呼ぶ前提なので作りは変えない。ここで固定したいのは
    // **黙って 2 つ目を作らない**こと（重複したツールがエージェントの一覧に並ぶ方が害が大きい）。
    const app = createApp({ profile: 'test' });
    try {
      const results = await Promise.allSettled([seedBuiltinTools(app), seedBuiltinTools(app)]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

      const tools = await app.listTools.execute(BUILTIN_SCOPE);
      const ids = tools.map((tool) => tool.internalId);
      expect(ids.filter((id) => id === JOURNAL_ENTRIES_TOOL_ID)).toHaveLength(1);
      expect(ids.filter((id) => id === CURRENT_DATETIME_TOOL_ID)).toHaveLength(1);

      // 衝突した側は理由が分かる形で失敗する（黙って握り潰さない）。
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected !== undefined && rejected.status === 'rejected') {
        expect(String(rejected.reason)).toMatch(/version|Version/);
      }

      // もう一度呼べば、既にあるので何も作らずに通る（復旧できる）。
      await expect(seedBuiltinTools(app)).resolves.toBeDefined();
      expect((await app.listTools.execute(BUILTIN_SCOPE)).length).toBe(tools.length);
    } finally { app.close(); }
  });
});

/**
 * 入金消込の E2E（合成根を実際に組み立てて一本通す。docs/22 §12）。
 *
 * 通す経路:
 *   設定・取引先 → 請求書の発行（売上仕訳の下書き）→ 銀行明細 CSV の取込 → 判定 → 消込の確定（入金仕訳の下書き）
 *   → 組込みツール 3 本をエージェントに呼ばせる（未入金一覧・消込候補・注文書からの請求書案）
 *
 * 模型は台本（ネットワークを使わない）。検証の焦点は「層をまたいで実際につながっているか」と、
 * **ツールを呼んだ後もデータが変わっていない**こと（読むだけの約束。確定は画面から人が押す）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import type { ModelCompletion } from '../application/model/model-provider';
import { SemVer } from '../domain/tool/semver';
import { defaultReceivablesSettings } from '../domain/receivables/settings';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { RECEIVABLES_INVOICE_DRAFT_TOOL_ID, RECEIVABLES_MATCH_CANDIDATES_TOOL_ID, RECEIVABLES_OUTSTANDING_TOOL_ID } from '../builtin-tools/receivables';
import { createApp, type App } from './root';

const scope = BUILTIN_SCOPE;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const AGENT_ID = 'receivables-clerk';

type ToolArguments = NonNullable<ModelCompletion['message']['toolCalls']>[number]['arguments'];
const toolCall = (name: string, args: ToolArguments = {}): ModelCompletion => ({ message: { role: 'assistant', content: null, toolCalls: [{ id: `call-${name}`, name, arguments: args }] }, finishReason: 'tool_calls' });
const stop = (content: string): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });

/** 注文書の読み取り結果（仕訳の抽出スキーマの全キー）。 */
function orderExtraction(): ModelCompletion {
  return stop(JSON.stringify({
    kind: 'quotation',
    facts: {
      direction: null, issuerName: '株式会社サンプル商事', recipientName: '株式会社サンプルソフト', registrationNumber: null, issueDate: null,
      transactionDate: '2026-09-20', dueDate: null, grandTotal: 33_000,
      totalsByRate: [{ rate: 10, taxableAmount: 30_000, taxAmount: 3_000, amountIncludesTax: false }],
      lines: [{ description: '部品', quantity: 10, unitPrice: 3_000, amount: 30_000, taxRate: 10, reducedRateMark: false }],
      paymentMethod: null, description: null, extra: null,
    },
    fieldEvidence: null, warnings: null,
  }));
}

function newApp(): { app: App; model: ScriptedModelProvider } {
  const model = new ScriptedModelProvider();
  // 注文書の読み取りは「main モデルが設定済みか」を見る。台本模型では設定済みとして扱う。
  vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
  return { app: createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 出さない */ } }), model };
}
afterEach(() => { vi.unstubAllEnvs(); });

const csv = (rows: readonly string[]) => Buffer.from(['日付,摘要,出金,入金,残高', ...rows].join('\r\n'), 'utf8').toString('base64');

/** 発行 → 取込 → 判定 → 確定 まで進め、未入金の請求と未消込の入金を 1 件ずつ残す。 */
async function runBusinessFlow(app: App) {
  await app.saveReceivablesSettings.execute({ scope, settings: { ...defaultReceivablesSettings(), issuer: { name: '株式会社サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] } } });
  const { customer } = await app.saveReceivablesCustomer.execute({ scope, name: '株式会社サンプル商事', kana: 'サンプルシヨウジ', paymentTermDays: 30 });
  const lines = (amount: number) => [{ description: '開発費', amount, taxRate: 10 as const }];
  const paid = await app.createReceivablesInvoice.execute({ scope, content: { customerId: customer.id, issueDate: '2026-09-01', transactionDate: '2026-09-01', dueDate: '2026-09-15', pricing: 'exclusive', lines: lines(100_000) } });
  const open = await app.createReceivablesInvoice.execute({ scope, content: { customerId: customer.id, issueDate: '2026-09-02', transactionDate: '2026-09-02', dueDate: '2026-09-10', pricing: 'exclusive', lines: lines(20_000) } });
  const issuedPaid = await app.issueReceivablesInvoice.execute({ scope, id: paid.invoice.id });
  await app.issueReceivablesInvoice.execute({ scope, id: open.invoice.id });

  const imported = await app.importReceivablesBankCsv.execute({ scope, contentBase64: csv(['2026/09/30,ﾌﾘｺﾐ ｻﾝﾌﾟﾙｼﾖｳｼﾞ,,110000,1110000', '2026/09/30,ﾌﾘｺﾐ ｶ)ﾌﾒｲ,,12345,1122345']), fileName: 'bank.csv', accountKey: 'main' });
  const judged = await app.judgeReceivablesTransactions.execute({ scope });
  const decided = await app.confirmReceivablesDecidedMatchings.execute(scope);
  return { customer, issuedPaid, open, imported, judged, decided };
}

async function saveAgent(app: App): Promise<void> {
  await app.saveAgent.execute({
    scope, internalId: AGENT_ID, workingName: 'receivables-clerk-draft', displayName: '売掛担当', publishName: 'receivables_clerk', owner: 'owner', kind: 'normal',
    systemPrompt: '請求と入金の状況をツールで調べて答えてください。',
    tools: [RECEIVABLES_OUTSTANDING_TOOL_ID, RECEIVABLES_MATCH_CANDIDATES_TOOL_ID, RECEIVABLES_INVOICE_DRAFT_TOOL_ID].map((internalId) => ({ internalId, version: SemVer.parse('1.0.0') })),
  });
}

function toolRows(run: { readonly trace: readonly { readonly kind: string; readonly name?: string; readonly outputPreview?: unknown }[] }, name: string): readonly Record<string, unknown>[] {
  return (run.trace.find((entry) => entry.kind === 'tool-result' && entry.name === name)?.outputPreview ?? []) as readonly Record<string, unknown>[];
}

/** ツールの前後で比べる「業務データの状態」。 */
async function snapshot(app: App) {
  return {
    invoices: (await app.listReceivablesInvoices.execute(scope)).map((summary) => [summary.invoice.id, summary.invoice.status, summary.invoice.paidAmount]),
    transactions: (await app.listReceivablesBankTransactions.execute(scope)).map((transaction) => [transaction.id, transaction.status, transaction.judgment?.reason]),
    matchings: (await app.listReceivablesMatchings.execute(scope)).map((matching) => matching.id),
    customers: (await app.listReceivablesCustomers.execute(scope)).map((item) => [item.customer.id, item.customer.payerAliases.length]),
    entries: (await app.listJournalEntries.execute(scope)).map((entry) => [entry.id, entry.status]),
  };
}

describe('入金消込（E2E）', () => {
  it('正常: 請求発行 → 明細取込 → 判定 → 消込確定 で売上と入金の仕訳下書きが仕訳側に揃う', async () => {
    const { app } = newApp();
    try {
      const flow = await runBusinessFlow(app);
      expect(flow.issuedPaid.invoice.number).toBe('INV-2026-0001');
      expect(flow.imported.imported).toHaveLength(2);
      expect(flow.judged.counts).toEqual({ decided: 1, candidate: 0, unmatched: 1 });
      expect(flow.decided.confirmed).toHaveLength(1);
      expect(flow.decided.failed).toEqual([]);
      expect((await app.getReceivablesInvoice.execute(scope, flow.issuedPaid.invoice.id)).invoice).toMatchObject({ status: 'paid', paidAmount: 110_000 });

      const entries = await app.listJournalEntries.execute(scope);
      expect(entries.map((entry) => [entry.date, entry.status, entry.tags?.[1]?.split(':').slice(0, 2).join(':')])).toEqual([
        ['2026-09-01', 'draft', 'receivables:invoice'],
        ['2026-09-02', 'draft', 'receivables:invoice'],
        ['2026-09-30', 'draft', 'receivables:matching'],
      ]);
      expect(entries[2]!.lines.map((line) => [line.side, line.accountName, line.amount])).toEqual([['debit', '普通預金', 110_000], ['credit', '売掛金', 110_000]]);

      // 取消すると請求は未入金へ戻り、入金仕訳の下書きは消える。
      const matchingId = flow.decided.confirmed[0]!.matchingId;
      await app.cancelReceivablesMatching.execute({ scope, matchingId });
      expect((await app.getReceivablesInvoice.execute(scope, flow.issuedPaid.invoice.id)).invoice.status).toBe('issued');
      expect(await app.listJournalEntries.execute(scope)).toHaveLength(2);
    } finally { app.close(); }
  });

  it('正常: 組込みツール 3 本がエージェントから呼べて、呼んだ後もデータが変わっていない', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      const flow = await runBusinessFlow(app);
      await saveAgent(app);
      const before = await snapshot(app);

      model.enqueue(toolCall('receivables_outstanding', { customer: 'サンプル', min_days_overdue: 1 }), stop('未入金は 1 件です。'));
      const outstanding = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: '払われていない請求は？', mode: 'preview' });
      expect(toolRows(outstanding, 'receivables_outstanding')).toEqual([expect.objectContaining({ invoice_id: flow.open.invoice.id, customer_name: '株式会社サンプル商事', outstanding_amount: 22_000, status: 'issued' })]);

      model.enqueue(toolCall('receivables_match_candidates', { transaction_id: null, customer: null }), stop('1 件は名義不明です。'));
      const candidates = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: '消し込めていない入金は？', mode: 'preview' });
      expect(toolRows(candidates, 'receivables_match_candidates')).toEqual([expect.objectContaining({ amount: 12_345, stage: 'unmatched', reason: 'no-candidate', reason_message: '金額・名義が一致する未入金の請求がありません', invoice_ids: null })]);

      // 1 つの模型がエージェントと読み取りの両方を担うので、ツール呼び出し → 読み取り → 最終応答 の順に積む。
      model.enqueue(toolCall('receivables_invoice_draft'), orderExtraction(), stop('請求書案を作りました。'));
      const draft = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'この注文書の請求書を作って', mode: 'preview', images: [{ name: 'order.png', dataUrl: PNG }] });
      const rows = toolRows(draft, 'receivables_invoice_draft');
      expect(rows).toEqual([expect.objectContaining({ file_name: 'order.png', customer_id: flow.customer.id, line_no: 1, amount: 30_000, grand_total: 33_000, document_total: 33_000, total_difference: 0, violations: 'issue-date-missing' })]);
      expect(JSON.parse(String(rows[0]!['draft_json']))).toMatchObject({ customerId: flow.customer.id, dueDate: '2026-10-20', pricing: 'exclusive' });

      expect(await snapshot(app)).toEqual(before);
    } finally { app.close(); }
  });

  it('異常: 添付の無い請求書案は、利用者が直せる形の理由でツールが落ちる', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await saveAgent(app);
      model.enqueue(toolCall('receivables_invoice_draft'));
      await expect(app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: '請求書を作って', mode: 'preview' })).rejects.toThrow(/attach the purchase order or quotation image/);
    } finally { app.close(); }
  });
});

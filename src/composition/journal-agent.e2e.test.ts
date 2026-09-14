/**
 * 仕訳ツールを組み込んだエージェントの E2E（合成根を実際に組み立てて一本通す）。
 *
 * 通す経路:
 *   組込みツールのシード → 科目マスタとルールを登録 → ツールを紐づけたエージェントを保存
 *   → チャットに帳票を添付して実行 → エージェントがツールを呼ぶ
 *   → 添付の読み取り（LLM）→ 保存済みルールで判定 → 仕訳案がエージェントへ返る
 *
 * 模型は台本（ネットワークを使わない）。**1 つの模型がエージェントの応答と抽出の両方を担う**ので、
 * 積む順番は ツール呼び出し → 抽出の結果 → 最終応答 になる。
 *
 * 検証の焦点は「層をまたいで実際につながっているか」:
 * - 添付が実行文脈を通ってデータソース解決まで届く（引数では運べないので、ここが切れていると何も読めない）。
 * - 保存済みのルールと科目マスタが判定に使われ、**利用者が定義した科目名**で返る。
 * - 読み取り専用の約束が守られている（帳票も仕訳も保存されない）。
 * - 添付が無ければ、利用者が直せる形の理由でツールが落ちる。
 *
 * テナントは `BUILTIN_SCOPE`。組込みツールはそのスコープへ登録され、エージェント実行は
 * 自分のスコープのツール保管庫からしか参照しないため（スコープを跨ぐ特別扱いは無い）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import type { ModelCompletion } from '../application/model/model-provider';
import type { Account, Dimension, TaxCategory } from '../domain/journal/chart-of-accounts';
import { SemVer } from '../domain/tool/semver';
import { BUILTIN_SCOPE, JOURNAL_DRAFT_ENTRY_TOOL_ID, seedBuiltinTools } from '../builtin-tools';
import { createApp, type App } from './root';

const scope = BUILTIN_SCOPE;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const AGENT_ID = 'bookkeeper';

/* -------------------------------------------------------------------------
 * 台本（模型が返す完了応答）
 * ---------------------------------------------------------------------- */

function toolCall(name: string): ModelCompletion {
  return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name, arguments: {} }] }, finishReason: 'tool_calls' };
}

function stop(content: string): ModelCompletion {
  return { message: { role: 'assistant', content }, finishReason: 'stop' };
}

/** 抽出が期待する応答（全キーを持つ事実の雛形を上書きする）。 */
function extraction(overrides: Record<string, unknown> = {}): ModelCompletion {
  const facts = {
    direction: 'out', issuerName: 'サンプルカフェ', recipientName: null, registrationNumber: null,
    issueDate: null, transactionDate: '2026-09-01', dueDate: null, grandTotal: 1100,
    totalsByRate: null, lines: null, paymentMethod: null, description: 'サンプルカフェ コーヒー', extra: null,
    ...overrides,
  };
  return stop(JSON.stringify({ kind: 'receipt', facts, fieldEvidence: null, warnings: null }));
}

/* -------------------------------------------------------------------------
 * 種データ（利用者が自分で定義する科目・ルール）
 * ---------------------------------------------------------------------- */

const taxCategories: readonly TaxCategory[] = [
  { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true },
  { code: 'JP-NA', name: '対象外', side: 'none', enabled: true },
];

const accounts: readonly Account[] = [
  { id: 'meeting', name: '会議費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: [], enabled: true, sortOrder: 1 },
  { id: 'cash', name: '現金', category: 'asset', defaultTaxCode: 'JP-NA', aliases: [], enabled: true, sortOrder: 2 },
];

const dimensions: readonly Dimension[] = [];

async function seedJournal(app: App): Promise<void> {
  await app.saveJournalChart.execute({ scope, accounts: [...accounts], dimensions: [...dimensions], taxCategories: [...taxCategories] });
  await app.saveJournalRule.execute({
    scope,
    rule: {
      name: 'カフェ代', enabled: true, mode: 'auto', priority: 10,
      scope: { direction: 'out' },
      conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
      outcome: {
        lines: [
          { side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total', partnerFrom: 'issuerName' },
          { side: 'credit', accountId: 'cash', taxCode: 'JP-NA', amount: 'total' },
        ],
        descriptionTemplate: '{description}', invoiceStatus: 'auto',
      },
      askIf: [], requiredFacts: [],
    },
  });
}

/** 仕訳ツールを 1 本だけ紐づけたエージェントを保存する。 */
async function saveAgentWithJournalTool(app: App): Promise<void> {
  await app.saveAgent.execute({
    scope, internalId: AGENT_ID, workingName: 'bookkeeper-draft', displayName: '経理担当', publishName: 'bookkeeper',
    owner: 'owner', kind: 'normal',
    systemPrompt: '添付された帳票をツールで読み、どう仕訳するかを答えてください。',
    tools: [{ internalId: JOURNAL_DRAFT_ENTRY_TOOL_ID, version: SemVer.parse('1.0.0') }],
  });
}

/** 台本模型を差し込んだアプリ。試験プロファイルでは仕訳の LLM 機能が無効なので local + :memory: を使う。 */
function newApp(): { app: App; model: ScriptedModelProvider } {
  const model = new ScriptedModelProvider();
  // journalLlmEnabled は「設定の有無」を見る。台本模型を使う E2E では設定済みとして扱う。
  vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
  const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } });
  return { app, model };
}

/** trace から仕訳ツールの結果行を取り出す。 */
function toolResultRows(run: { readonly trace: readonly { readonly kind: string; readonly name?: string; readonly outputPreview?: unknown }[] }): readonly Record<string, unknown>[] {
  const event = run.trace.find((entry) => entry.kind === 'tool-result' && entry.name === 'journal_draft_entry');
  return (event?.outputPreview ?? []) as readonly Record<string, unknown>[];
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('仕訳ツールを組み込んだエージェント（E2E）', () => {
  it('正常: 添付した帳票を読み、保存済みのルールで判定して仕訳案を返す', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await seedJournal(app);
      await saveAgentWithJournalTool(app);
      // 1 つの模型がエージェントと抽出の両方を担う。ツール呼び出し → 抽出 → 最終応答 の順。
      model.enqueue(toolCall('journal_draft_entry'), extraction(), stop('会議費 1,100 円で仕訳できます。'));

      const run = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'このレシートどう仕訳する？', mode: 'preview', images: [{ name: 'receipt.png', dataUrl: PNG }] });

      const rows = toolResultRows(run);
      expect(rows).toHaveLength(2);
      // 利用者が定義した科目名で返る（標準セットではなく、登録したマスタから引く）。
      expect(rows[0]).toMatchObject({ file_name: 'receipt.png', decided: true, rule_name: 'カフェ代', side: 'debit', account: '会議費', amount: 1100, partner: 'サンプルカフェ' });
      expect(rows[1]).toMatchObject({ side: 'credit', account: '現金', amount: 1100 });
    } finally { app.close(); }
  });

  it('正常: 読むだけで、帳票も仕訳も保存しない', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await seedJournal(app);
      await saveAgentWithJournalTool(app);
      model.enqueue(toolCall('journal_draft_entry'), extraction(), stop('done'));

      await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'これは？', mode: 'preview', images: [{ name: 'receipt.png', dataUrl: PNG }] });

      // 帳簿へ残すのは画面から人が押す（docs/20 §14.1）。エージェント経由では増えない。
      expect(await app.listJournalEntries.execute(scope)).toHaveLength(0);
      expect(await app.listJournalDocuments.execute(scope)).toHaveLength(0);
    } finally { app.close(); }
  });

  it('境界: ルールに当たらなければ、仕訳の列ではなく理由を返す', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await seedJournal(app);
      await saveAgentWithJournalTool(app);
      // ルールの条件（descriptionNorm contains カフェ）に当たらない摘要で読ませる。
      model.enqueue(toolCall('journal_draft_entry'), extraction({ issuerName: '文具店', description: '文具店 ノート' }), stop('ルールがありません。'));

      const run = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'これは？', mode: 'preview', images: [{ name: 'note.png', dataUrl: PNG }] });

      const rows = toolResultRows(run);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decided: false, reason: 'no-rule', account: null, amount: null });
    } finally { app.close(); }
  });

  it('異常: 添付が無い実行は、利用者が直せる形の理由で落ちる', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await seedJournal(app);
      await saveAgentWithJournalTool(app);
      model.enqueue(toolCall('journal_draft_entry'));

      await expect(app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'これは？', mode: 'preview' }))
        .rejects.toThrow(/no document is attached/);
    } finally { app.close(); }
  });
});

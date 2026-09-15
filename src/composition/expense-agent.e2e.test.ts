/**
 * 経費精算の読取と組込みツールを、合成根を実際に組み立てて一本通す E2E（docs/21 §15 composition 行）。
 *
 * 通す経路:
 *   A. 領収書画像の読取（仕訳の読取ユースケースを経費のポートで包んだもの）→ 明細として保存 → チェック → 承認 → 仕訳下書き
 *   B. 組込みツールのシード → ツール 3 本を紐づけたエージェントを保存 → チャットで実行
 *      - `expense_check_receipt`: 添付の読取 → 保存済みの規程で試算 → 理由コード付きの行。申請も証憑も保存されない
 *      - `expense_claims`: 引数省略で全件、`status` 指定で絞り込み
 *      - `expense_policy`: 保存済みの規程の費目
 *      - 添付なしの `expense_check_receipt` は直し方の分かる理由で落ちる
 *
 * 模型は台本（ネットワークを使わない）。1 つの模型がエージェントの応答と読取の両方を担うので、
 * 積む順番は ツール呼び出し → 読取の結果 → 最終応答 になる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import type { ModelCompletion } from '../application/model/model-provider';
import { allReasons } from '../domain/expense/judgment';
import { SemVer } from '../domain/tool/semver';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID } from '../builtin-tools/expense';
import { createApp, type App } from './root';

const scope = BUILTIN_SCOPE;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const AGENT_ID = 'expense-assistant';
const by = 'keiri@example.com';

function toolCall(name: string, args: Readonly<Record<string, string>> = {}): ModelCompletion {
  return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name, arguments: args }] }, finishReason: 'tool_calls' };
}

function stop(content: string): ModelCompletion {
  return { message: { role: 'assistant', content }, finishReason: 'stop' };
}

/** 仕訳の読取が期待する応答（全キーを持つ事実の雛形を上書きする）。 */
function extraction(overrides: Record<string, unknown> = {}): ModelCompletion {
  const facts = {
    direction: 'out', issuerName: 'サンプル交通', recipientName: null, registrationNumber: 'T1234567890123',
    issueDate: null, transactionDate: '2026-09-10', dueDate: null, grandTotal: 3200,
    totalsByRate: null, lines: null, paymentMethod: 'cash', description: 'タクシー代 霞が関', extra: null,
    ...overrides,
  };
  return stop(JSON.stringify({ kind: 'receipt', facts, fieldEvidence: null, warnings: null }));
}

function newApp(): { app: App; model: ScriptedModelProvider } {
  const model = new ScriptedModelProvider();
  // 読取は「main モデルの設定の有無」を見る。台本模型を使う E2E では設定済みとして扱う。
  vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
  const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } });
  return { app, model };
}

function toolResultRows(run: { readonly trace: readonly { readonly kind: string; readonly name?: string; readonly outputPreview?: unknown }[] }, name: string): readonly Record<string, unknown>[] {
  const event = run.trace.find((entry) => entry.kind === 'tool-result' && entry.name === name);
  return (event?.outputPreview ?? []) as readonly Record<string, unknown>[];
}

async function saveAgent(app: App): Promise<void> {
  await app.saveAgent.execute({
    scope, internalId: AGENT_ID, workingName: 'expense-assistant-draft', displayName: '経費精算アシスタント', publishName: 'expense_assistant',
    owner: 'owner', kind: 'normal',
    systemPrompt: '添付された領収書や経費の申請・規程をツールで調べて答えてください。',
    tools: [EXPENSE_CHECK_RECEIPT_TOOL_ID, EXPENSE_CLAIMS_TOOL_ID, EXPENSE_POLICY_TOOL_ID].map((internalId) => ({ internalId, version: SemVer.parse('1.0.0') })),
  });
}

/** 読取 → 保存 → チェック → （要確認は確認済みに）→ 承認 → 仕訳下書き。承認済みの申請 id を返す。 */
async function approvedClaimFromReceipt(app: App, model: ScriptedModelProvider): Promise<string> {
  model.enqueue(extraction());
  const read = await app.extractExpenseReceipt.execute({ scope, images: [PNG], fileName: 'taxi.png' });
  const draft = read.drafts[0]!;
  // 別名「タクシー代」から費目が推定され、読取値はそのまま（補正しない）。
  expect(draft).toMatchObject({ categoryId: 'transport.taxi', facts: { payeeName: 'サンプル交通', amount: 3200, registrationNumber: 'T1234567890123' }, extraction: { method: 'llm', documentKind: 'receipt' } });

  const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, by });
  // 利用者が目的を書き足して保存する（読取では目的が取れない）。
  await app.saveExpenseItem.execute({
    scope, claimId: claim.id, by, source: draft.source, extraction: draft.extraction,
    ...(draft.categoryId === undefined ? {} : { categoryId: draft.categoryId }),
    facts: { ...draft.facts, purpose: '客先訪問' },
    receipt: { dataUrl: PNG, fileName: 'taxi.png' },
  });
  await app.resetExpensePolicy.execute(scope);
  await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by });
  let checked = await app.getExpenseClaim.execute(scope, claim.id);
  expect(checked.judgment?.verdict).not.toBe('returned');
  for (const reason of allReasons(checked.judgment!).filter((entry) => entry.severity === 'review')) {
    checked = await app.acknowledgeExpenseReason.execute({ scope, claimId: claim.id, code: reason.code, note: '領収書と照合済み', by: 'shonin@example.com', ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }) });
  }
  expect((await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'shonin@example.com' })).status).toBe('approved');
  const drafted = await app.draftExpenseJournalEntries.execute({ scope, claimId: claim.id, by });
  expect(drafted.entryIds).toHaveLength(1);
  return claim.id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('経費精算の読取とツールを組み込んだエージェント（E2E）', () => {
  it('正常: 領収書の読取 → チェック → 承認 → 仕訳下書きが、仕訳画面と同じ保管庫に下書きを作る', async () => {
    const { app, model } = newApp();
    try {
      const claimId = await approvedClaimFromReceipt(app, model);
      const entries = await app.listJournalEntries.execute(scope);
      expect(entries).toMatchObject([{ status: 'draft', invoiceStatus: 'qualified', registrationNumber: 'T1234567890123', tags: ['expense', `expense-claim:${claimId}`, expect.stringMatching(/^expense-item:/u)] }]);
      expect(entries[0]!.lines.map((line) => [line.side, line.accountName, line.amount])).toEqual([['debit', '旅費交通費', 3200], ['credit', '未払金', 3200]]);
    } finally { app.close(); }
  });

  it('正常: expense_check_receipt は添付を読んで理由コード付きの行を返し、申請も証憑も保存しない', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await app.resetExpensePolicy.execute(scope);
      await saveAgent(app);
      // 登録番号なし・人数なしの接待の領収書。
      model.enqueue(toolCall('expense_check_receipt'), extraction({ issuerName: '割烹サンプル 霞が関店', registrationNumber: null, grandTotal: 12000, description: '接待 会食', transactionDate: '2026-09-12' }), stop('人数を教えてください。'));

      const run = await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'この領収書は精算できますか？', mode: 'preview', images: [{ name: 'dinner.png', dataUrl: PNG }] });

      const rows = toolResultRows(run, 'expense_check_receipt');
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((row) => row['file_name'] === 'dinner.png' && row['verdict'] === 'returned' && row['policy_saved'] === true && row['category_id'] === 'meal.entertainment')).toBe(true);
      const codes = rows.map((row) => row['code']);
      expect(codes).toEqual(expect.arrayContaining(['attendees-missing', 'registration-number-missing', 'purpose-missing']));
      // 添付そのものが証憑なので「領収書なし」は出ない。
      expect(codes).not.toContain('receipt-missing');
      expect(String(rows.find((row) => row['code'] === 'attendees-missing')?.['message'])).toContain('参加人数');
      // 読むだけ。
      expect(await app.listExpenseClaims.execute(scope)).toEqual([]);
    } finally { app.close(); }
  });

  it('正常: expense_claims は引数省略で全件、status で絞り込み。expense_policy は保存済みの規程の費目を返す', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      const claimId = await approvedClaimFromReceipt(app, model);
      await app.createExpenseClaim.execute({ scope, claimant: { name: 'テスト花子' }, period: { from: '2026-09-01', to: '2026-09-30' }, by });
      await saveAgent(app);

      model.enqueue(toolCall('expense_claims'), stop('2 件です。'));
      const all = toolResultRows(await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: '申請の一覧は？', mode: 'preview' }), 'expense_claims');
      expect(all.map((row) => row['claimant']).sort()).toEqual(['テスト太郎', 'テスト花子']);

      model.enqueue(toolCall('expense_claims', { status: 'approved' }), stop('承認済みは 1 件です。'));
      const approved = toolResultRows(await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: '承認済みは？', mode: 'preview' }), 'expense_claims');
      expect(approved).toMatchObject([{ claim_id: claimId, status: 'approved', journal_linked: 'complete', total_amount: 3200, stale: false }]);

      model.enqueue(toolCall('expense_policy'), stop('規程です。'));
      const policy = toolResultRows(await app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'タクシーの上限は？', mode: 'preview' }), 'expense_policy');
      expect(policy.length).toBeGreaterThan(0);
      expect(policy.find((row) => row['category_id'] === 'transport.taxi') ?? policy[0]).toMatchObject({ policy_saved: true });
    } finally { app.close(); }
  });

  it('異常: 添付の無い expense_check_receipt は、利用者が直せる形の理由で落ちる', async () => {
    const { app, model } = newApp();
    try {
      await seedBuiltinTools(app);
      await saveAgent(app);
      model.enqueue(toolCall('expense_check_receipt'));
      await expect(app.runAgentPreview.executeSaved({ scope, agentId: AGENT_ID, message: 'これは精算できる？', mode: 'preview' }))
        .rejects.toThrow(/no receipt is attached/u);
    } finally { app.close(); }
  });
});

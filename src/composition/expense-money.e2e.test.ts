/**
 * 経費精算「お金の流れ（系統 B）」を合成根ごと一本通す E2E（docs/21 §20.15 composition 行のうち B の部分）。
 *
 * A. 仮払: 申請 → 承認 → 支払済み → 支払の仕訳下書き → 経費申請を紐付け → チェック（仮払の理由が出ない / 他人の申請は紐付けられない）
 *    → 承認 → 明細の仕訳下書き → 精算（差額は負 = 返金）→ 返金の受領 → 精算の仕訳下書き（未払金 + 普通預金 / 仮払金）。
 * B. カード: サンプルの明細 CSV を取込 → 期間の重なる CSV で重複を数える → 同じ利用を立替で申請 → チェックで card-charge-claimed
 *    → 照合の保存で二重計上の疑い → 未申請の一覧・対象外の印。
 * C. ツール: シードした 3 本をエージェントから呼ぶ（expense_summary は引数 group_by / period / status を行ソースが受け取る）。
 *
 * 判定日は業務のタイムゾーンで決まるので、時計（Date だけ）を 2026-09-30 の日本時間に固定する。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { FIXTURE_EMPLOYEE_IDS, fixtureCardSettings, fixtureEmployees, fixtureOrganization } from '../adapters/storage/expense-v9.fixtures';
import type { ModelCompletion } from '../application/model/model-provider';
import { BUILTIN_SCOPE, seedBuiltinTools } from '../builtin-tools';
import { EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID, EXPENSE_SUMMARY_TOOL_ID } from '../builtin-tools/expense-money';
import type { ReceiptFacts } from '../domain/expense/receipt-facts';
import { allReasons } from '../domain/expense/judgment';
import { SemVer } from '../domain/tool/semver';
import { createApp, type App } from './root';

const scope = BUILTIN_SCOPE;
const period = { from: '2026-09-01', to: '2026-09-30' };
const SAMPLES = join(process.cwd(), 'samples', 'expense');
const sample = (name: string): string => readFileSync(join(SAMPLES, name), 'utf8');

async function prepareMasters(app: App): Promise<void> {
  for (const employee of fixtureEmployees(scope)) await app.expenseEmployeeRepo.save(employee);
  await app.expenseSettingsRepo.save(scope, 'organization', fixtureOrganization());
  await app.resetExpensePolicy.execute(scope);
}

/** 申請を作って明細を足し、チェックする（申請 id を返す）。 */
async function checkedClaim(app: App, employeeId: string, facts: Partial<ReceiptFacts>, claimPeriod = period): Promise<string> {
  const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: '（マスタから写す）', employeeId }, period: claimPeriod, by: 'keiri@example.com' });
  await app.saveExpenseItem.execute({ scope, claimId: claim.id, by: 'keiri@example.com', categoryId: 'transport.public', source: { type: 'manual' }, facts: { transactionDate: '2026-09-10', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', description: '霞ケ関→大手町', ...facts } });
  await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by: 'keiri@example.com' });
  return claim.id;
}

/** 要確認を確認済みにして承認する。 */
async function approve(app: App, claimId: string): Promise<void> {
  let claim = await app.getExpenseClaim.execute(scope, claimId);
  for (const reason of allReasons(claim.judgment ?? { claimReasons: [], items: [] } as never).filter((entry) => entry.severity === 'review')) {
    claim = await app.acknowledgeExpenseReason.execute({ scope, claimId, code: reason.code, note: '確認済み', by: 'shonin@example.com', ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }) });
  }
  expect((await app.approveExpenseClaim.execute({ scope, claimId, by: 'shonin@example.com' })).status).toBe('approved');
}

const codesOf = async (app: App, claimId: string): Promise<readonly string[]> => {
  const claim = await app.getExpenseClaim.execute(scope, claimId);
  return claim.judgment === undefined ? [] : allReasons(claim.judgment).map((reason) => reason.code);
};

describe('お金の流れの一本通し（E2E）', () => {
  let app: App;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
    app = createApp({ profile: 'test' });
    await prepareMasters(app);
  });

  afterEach(() => {
    app.close();
    vi.useRealTimers();
  });

  it('正常: 仮払の申請 → 支払 → 経費申請の紐付け → 承認 → 差額（返金）の精算と仕訳下書き', async () => {
    const created = await app.expenseAdvances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.hanako, purpose: '大阪出張', amount: 30000, neededOn: '2026-09-05', plannedSettleBy: '2026-09-29' }, 'hanako@example.com');
    await app.expenseAdvances.approve(scope, created.id, { subject: 'jiro@example.com', employeeId: FIXTURE_EMPLOYEE_IDS.jiro });
    await app.expenseAdvances.markPaid(scope, created.id, { paidOn: '2026-09-04', method: 'transfer' }, 'keiri@example.com');
    await app.expenseAdvanceJournalDrafts.execute({ scope, advanceId: created.id, stage: 'payment', by: 'keiri@example.com' });

    const claimId = await checkedClaim(app, FIXTURE_EMPLOYEE_IDS.hanako, {});
    const linked = await app.expenseLinkClaimAdvance.execute({ scope, claimId, advanceId: created.id, by: 'keiri@example.com' });
    expect(linked.status).toBe('draft');
    // 他人の申請は紐付けられない（直す場所つき）。
    const taroClaim = await checkedClaim(app, FIXTURE_EMPLOYEE_IDS.taro, { transactionDate: '2026-09-11', amount: 520, payeeName: '都営バス' });
    await expect(app.expenseLinkClaimAdvance.execute({ scope, claimId: taroClaim, advanceId: created.id, by: 'k' })).rejects.toMatchObject({ blockingReasons: [expect.objectContaining({ code: 'advance-employee-mismatch' })] });

    await app.checkExpenseClaims.execute({ scope, claimIds: [claimId], by: 'keiri@example.com' });
    expect((await codesOf(app, claimId)).filter((code) => code.startsWith('advance-'))).toEqual([]);
    expect((await app.expenseAdvances.list(scope))[0]).toMatchObject({ linkedClaimCount: 1, linkedClaimTotal: 420, overdue: true });
    await approve(app, claimId);
    await app.draftExpenseJournalEntries.execute({ scope, claimId, by: 'keiri@example.com' });

    expect(await app.expenseSettleAdvance.preview(scope, created.id)).toMatchObject({ claimsTotal: 420, difference: -29580, direction: 'refund', blockers: [] });
    const settled = await app.expenseSettleAdvance.settle(scope, created.id, 'keiri@example.com');
    expect(settled.advance).toMatchObject({ status: 'settling', settlement: { refund: { amount: 29580 } } });
    expect((await app.getExpenseClaim.execute(scope, claimId))).toMatchObject({ status: 'settled', settlement: { exportFileName: `advance:${created.id}` } });
    // 精算に入った仮払には、もう別の申請を紐付けられない。
    await expect(app.expenseLinkClaimAdvance.execute({ scope, claimId: taroClaim, advanceId: created.id, by: 'k' })).rejects.toMatchObject({ blockingReasons: expect.arrayContaining([expect.objectContaining({ code: 'advance-already-settled' })]) });

    await app.expenseAdvances.refundReceived(scope, created.id, '2026-09-30', 'keiri@example.com');
    const drafted = await app.expenseAdvanceJournalDrafts.execute({ scope, advanceId: created.id, stage: 'settlement', by: 'keiri@example.com' });
    expect(drafted.advance).toMatchObject({ status: 'settled', journalLink: { paymentEntryId: expect.any(String), settlementEntryId: expect.any(String) } });

    const entries = await app.listJournalEntries.execute(scope);
    const settlement = entries.find((entry) => entry.tags?.includes('expense-advance-settlement'));
    expect(settlement?.lines.map((line) => [line.side, line.accountId, line.amount])).toEqual([
      ['debit', 'liability.other_payables', 420], ['debit', 'asset.ordinary_deposit', 29580], ['credit', 'asset.suspense_paid', 30000],
    ]);
    expect(entries.find((entry) => entry.tags?.includes('expense-advance-payment'))?.lines.map((line) => [line.side, line.accountId, line.amount])).toEqual([
      ['debit', 'asset.suspense_paid', 30000], ['credit', 'asset.ordinary_deposit', 30000],
    ]);
  });

  it('正常: カード明細の取込 → 重複の検出 → 立替で申請した同じ利用を card-charge-claimed で止め、照合で二重計上の疑い・未申請一覧・対象外', async () => {
    const { cards, profiles } = fixtureCardSettings();
    await app.expenseCardSettings.save(scope, { cards, profiles });
    const first = await app.expenseCardStatements.import(scope, { content: sample('card-statement-generic.csv'), fileName: 'card-statement-generic.csv' }, 'keiri@example.com');
    expect(first).toMatchObject({ imported: 5, duplicates: 0, profileId: 'profile-generic', periodFrom: '2026-09-03', periodTo: '2026-09-25' });
    await expect(app.expenseCardStatements.import(scope, { content: sample('card-statement-generic.csv'), fileName: 'again.csv' }, 'k')).rejects.toMatchObject({ code: 'EXPENSE_CARD_DUPLICATE_IMPORT', importId: first.importId });
    expect(await app.expenseCardStatements.import(scope, { content: sample('card-statement-overlap.csv'), fileName: 'card-statement-overlap.csv' }, 'k')).toMatchObject({ imported: 1, duplicates: 1 });

    const claimId = await checkedClaim(app, FIXTURE_EMPLOYEE_IDS.taro, { transactionDate: '2026-09-03', payeeName: 'サンプルマート 霞が関店', amount: 3200, description: '打合せの飲み物' });
    const claim = await app.getExpenseClaim.execute(scope, claimId);
    const reason = claim.judgment === undefined ? undefined : allReasons(claim.judgment).find((entry) => entry.code === 'card-charge-claimed');
    expect(reason).toMatchObject({ severity: 'return', params: expect.objectContaining({ cardLabel: '営業用カード', usedOn: '2026-09-03', cardAmount: 3200, weak: false }) });

    expect(await app.expenseCardMatching.execute(scope, {}, 'keiri@example.com')).toEqual({ matched: 1, reimbursementMatches: 1, unmatched: 5, kept: 0 });
    const matched = await app.expenseCardTransactions.list(scope, { status: 'matched' });
    expect(matched).toEqual([expect.objectContaining({ claimant: 'テスト太郎', match: expect.objectContaining({ claimId, kind: 'reimbursement-item' }) })]);
    // 照合を保存した後の再チェックも同じ理由（この申請に照合済みの利用は候補に残る）。
    await app.checkExpenseClaims.execute({ scope, claimIds: [claimId], by: 'k' });
    expect(await codesOf(app, claimId)).toContain('card-charge-claimed');

    const unmatched = await app.expenseCardTransactions.list(scope, { status: 'unmatched' });
    expect(unmatched.map((transaction) => transaction.merchantRaw)).toEqual(['サンプル書店', 'サンプルカード 年会費', 'サンプル珈琲', 'サンプルホテル 大阪', 'サンプル交通']);
    const fee = unmatched.find((transaction) => transaction.merchantRaw.includes('年会費'));
    expect((await app.expenseCardTransactions.exclude(scope, fee?.id as string, '年会費（申請の対象外）', 'keiri@example.com')).status).toBe('excluded');
    expect(await app.expenseMoneyReadiness.execute(scope)).toMatchObject({ cards: true, cardImportCount: 2, cardCoverage: [{ cardId: 'card-sales', from: '2026-09-03', to: '2026-10-02' }, { cardId: 'card-shared', from: '2026-09-03', to: '2026-09-25' }] });
  });
});

function toolCall(name: string, args: Readonly<Record<string, string>> = {}): ModelCompletion {
  return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name, arguments: args }] }, finishReason: 'tool_calls' };
}
const stop = (content: string): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });

function toolResultRows(run: { readonly trace: readonly { readonly kind: string; readonly name?: string; readonly outputPreview?: unknown }[] }, name: string): readonly Record<string, unknown>[] {
  return (run.trace.find((entry) => entry.kind === 'tool-result' && entry.name === name)?.outputPreview ?? []) as readonly Record<string, unknown>[];
}

describe('お金の流れのツール（E2E。SQLite と実行時の引数）', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('正常: expense_summary は引数なしで既定の粒度、group_by / period / status で行の作り方を変える。expense_advances / expense_card_transactions は絞り込みの引数で絞る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
    vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
    const model = new ScriptedModelProvider();
    const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } });
    try {
      await seedBuiltinTools(app);
      await prepareMasters(app);
      const taro = await checkedClaim(app, FIXTURE_EMPLOYEE_IDS.taro, { amount: 420 });
      await approve(app, taro);
      const hanako = await checkedClaim(app, FIXTURE_EMPLOYEE_IDS.hanako, { amount: 600, transactionDate: '2026-08-20' }, { from: '2026-08-01', to: '2026-08-31' });
      await approve(app, hanako);
      const advance = await app.expenseAdvances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.hanako, purpose: '大阪出張', amount: 30000, neededOn: '2026-09-05', plannedSettleBy: '2026-09-29' }, 'hanako');
      await app.expenseAdvances.approve(scope, advance.id, { subject: 'jiro' });
      await app.expenseAdvances.markPaid(scope, advance.id, { paidOn: '2026-09-04', method: 'cash' }, 'keiri');
      await app.expenseAdvances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.taro, purpose: '研修', amount: 5000, neededOn: '2026-10-05', plannedSettleBy: '2026-10-29' }, 'taro');
      const { cards, profiles } = fixtureCardSettings();
      await app.expenseCardSettings.save(scope, { cards, profiles });
      await app.expenseCardStatements.import(scope, { content: sample('card-statement-generic.csv'), fileName: 'card-statement-generic.csv' }, 'keiri');

      await app.saveAgent.execute({
        scope, internalId: 'money-assistant', workingName: 'money-assistant-draft', displayName: '経費のお金の流れ', publishName: 'money_assistant', owner: 'owner', kind: 'normal',
        systemPrompt: '経費の集計・仮払・カード明細をツールで調べて答えてください。',
        tools: [EXPENSE_SUMMARY_TOOL_ID, EXPENSE_ADVANCES_TOOL_ID, EXPENSE_CARD_TRANSACTIONS_TOOL_ID].map((internalId) => ({ internalId, version: SemVer.parse('1.0.0') })),
      });
      const run = async (name: string, args: Readonly<Record<string, string>> = {}) => {
        model.enqueue(toolCall(name, args), stop('回答'));
        return toolResultRows(await app.runAgentPreview.executeSaved({ scope, agentId: 'money-assistant', message: '教えて', mode: 'preview' }), name);
      };

      const defaults = await run('expense_summary');
      expect(defaults.map((row) => [row['month'], row['category_id'], row['amount'], row['group_by']])).toEqual([['2026-08', 'transport.public', 600, 'month,category'], ['2026-09', 'transport.public', 420, 'month,category']]);
      const byClaimant = await run('expense_summary', { group_by: 'claimant', period: '2026-09', status: 'all' });
      expect(byClaimant).toEqual([expect.objectContaining({ claimant: 'テスト太郎', month: null, category: null, amount: 420, period_from: '2026-09', period_to: '2026-09' })]);
      const byDepartment = await run('expense_summary', { group_by: 'department', department: '営業' });
      expect(byDepartment).toEqual([expect.objectContaining({ department: '営業部', amount: 1020, claim_count: 2 })]);
      await expect((async () => {
        model.enqueue(toolCall('expense_summary', { group_by: 'payee' }));
        await app.runAgentPreview.executeSaved({ scope, agentId: 'money-assistant', message: '教えて', mode: 'preview' });
      })()).rejects.toThrow(/group_by must be a comma-separated list/u);

      expect((await run('expense_advances')).map((row) => row['status']).sort()).toEqual(['paid', 'requested']);
      expect(await run('expense_advances', { employee: '花子', status: 'paid' })).toEqual([expect.objectContaining({ employee: 'テスト花子', overdue: true, difference: null, linked_claim_count: 0 })]);

      expect(await run('expense_card_transactions')).toHaveLength(5);
      expect((await run('expense_card_transactions', { card: '2222', period: '2026-09-1' })).map((row) => row['merchant'])).toEqual(['サンプルホテル 大阪']);
      expect((await run('expense_card_transactions', { status: 'matched' }))).toEqual([]);
    } finally {
      app.close();
    }
  });
});

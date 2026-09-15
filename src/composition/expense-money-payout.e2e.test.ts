/**
 * 経費精算の振込データ（全銀協。UC3）を合成根ごと一本通す E2E（docs/21 §20.15 composition 行: 承認 → 振込データ → 確定で精算済み）。
 *
 * 従業員は系統 A のユースケースで保存し（口座番号をアプリの鍵で封緘）、振込元の設定は B のユースケースで保存する。
 * 承認済みの申請（仕訳下書きつき）と承認済みの仮払を 1 本の振込データにし、点検 → 作成 → 再ダウンロード → 確定で、
 * 申請が精算済み・仮払が支払済み（payoutBatchId 付き）・支払の仕訳下書きが仕訳に出ることを確かめる。
 * 判定日は業務のタイムゾーンで決まるので、時計（Date だけ）を 2026-09-30 の日本時間に固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_EMPLOYEE_IDS } from '../adapters/storage/expense-v9.fixtures';
import { BUILTIN_SCOPE } from '../builtin-tools';
import { allReasons } from '../domain/expense/judgment';
import { createApp, type App } from './root';

const scope = BUILTIN_SCOPE;
const period = { from: '2026-09-01', to: '2026-09-30' };
/** 2026-10-02 は金曜日。 */
const TRANSFER_DATE = '2026-10-02';

async function saveEmployees(app: App): Promise<void> {
  const bank = (accountNumber: string, holderKana: string) => ({ bankCode: '9999', branchCode: '999', accountType: 'ordinary' as const, accountNumber, holderKana });
  await app.expenseSaveEmployee.create(scope, { id: FIXTURE_EMPLOYEE_IDS.taro, code: 'E001', name: 'テスト太郎', bankAccount: bank('1', 'テスト タロウ') }, 'keiri@example.com');
  await app.expenseSaveEmployee.create(scope, { id: FIXTURE_EMPLOYEE_IDS.hanako, code: 'E002', name: 'テスト花子', bankAccount: bank('2', 'テスト ハナコ') }, 'keiri@example.com');
  await app.resetExpensePolicy.execute(scope);
}

async function approvedClaimWithJournal(app: App): Promise<string> {
  const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: '（写す）', employeeId: FIXTURE_EMPLOYEE_IDS.taro }, period, by: 'keiri@example.com' });
  await app.saveExpenseItem.execute({ scope, claimId: claim.id, by: 'keiri@example.com', categoryId: 'transport.public', source: { type: 'manual' }, facts: { transactionDate: '2026-09-10', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', description: '霞ケ関→大手町' } });
  await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by: 'keiri@example.com' });
  const checked = await app.getExpenseClaim.execute(scope, claim.id);
  for (const reason of allReasons(checked.judgment!).filter((entry) => entry.severity === 'review')) {
    await app.acknowledgeExpenseReason.execute({ scope, claimId: claim.id, code: reason.code, note: '確認済み', by: 'shonin@example.com', ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }) });
  }
  expect((await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'shonin@example.com' })).status).toBe('approved');
  await app.draftExpenseJournalEntries.execute({ scope, claimId: claim.id, by: 'keiri@example.com' });
  return claim.id;
}

describe('振込データの一本通し（E2E）', () => {
  let app: App;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
    app = createApp({ profile: 'test' });
    await saveEmployees(app);
  });

  afterEach(() => {
    app.close();
    vi.useRealTimers();
  });

  it('正常: 承認済みの申請と承認済みの仮払 → 点検 → 作成 → 再ダウンロード → 確定で、申請は精算済み・仮払は支払済み・支払の仕訳下書き', async () => {
    const claimId = await approvedClaimWithJournal(app);
    const advance = await app.expenseAdvances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.hanako, purpose: '大阪出張', amount: 30000, neededOn: '2026-10-01', plannedSettleBy: '2026-10-31' }, 'hanako@example.com');
    await app.expenseAdvances.approve(scope, advance.id, { subject: 'jiro@example.com' });
    expect((await app.expenseMoneyReadiness.execute(scope)).payout).toBe(false);
    await app.expensePayoutSettings.save(scope, {
      source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: '9' }, requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ',
      journal: { createPaymentEntry: true },
    });
    expect((await app.expenseMoneyReadiness.execute(scope)).payout).toBe(true);

    const preview = await app.expensePayouts.preview(scope, { transferDate: TRANSFER_DATE });
    expect(preview.problems).toEqual([]);
    expect(preview.lines.map((line) => [line.name, line.amount, line.sources.map((source) => source.kind)])).toEqual([['テスト花子', 30000, ['advance-payment']], ['テスト太郎', 420, ['claim']]]);
    // 申請は仕訳下書きを作成済み・振込日は平日・名義は書式の変換なしなので、確認必須の警告は無い。
    expect(preview.warnings).toEqual([]);

    const { batch, file } = await app.expensePayouts.create(scope, { transferDate: TRANSFER_DATE, acknowledgedWarnings: [] }, 'shonin@example.com');
    const text = Buffer.from(file.contentBase64, 'base64').toString('latin1');
    const records = Array.from({ length: text.length / 122 }, (_, index) => text.slice(index * 122, index * 122 + 120));
    expect(records.map((record) => record[0])).toEqual(['1', '2', '2', '8', '9']);
    expect(records[0]?.slice(54, 58)).toBe('1002');
    expect(records.slice(1, 3).map((record) => [record.slice(43, 50), record.slice(80, 90)])).toEqual([['0000002', '0000030000'], ['0000001', '0000000420']]);
    expect(records[3]?.slice(0, 19)).toBe('8000002000000030420');
    expect((await app.getExpenseClaim.execute(scope, claimId)).payout?.batchId).toBe(batch.id);
    expect(await app.expensePayouts.file(scope, batch.id)).toEqual(file);

    const confirmed = await app.expensePayouts.confirm(scope, batch.id, 'keiri@example.com');
    expect(confirmed.warnings).toEqual([]);
    expect(await app.getExpenseClaim.execute(scope, claimId)).toMatchObject({ status: 'settled', settlement: { exportFileName: batch.fileName } });
    expect((await app.expenseAdvances.get(scope, advance.id)).advance).toMatchObject({ status: 'paid', payment: { paidOn: TRANSFER_DATE, method: 'transfer', payoutBatchId: batch.id } });
    const entries = await app.listJournalEntries.execute(scope);
    const payment = entries.find((entry) => entry.tags?.includes(`expense-payout:${batch.id}`));
    // 借方は振込の行の順（従業員 id 順: 花子の仮払 → 太郎の申請）、貸方は振込元の預金に合計。
    expect(payment?.lines.map((line) => [line.side, line.accountId, line.amount])).toEqual([
      ['debit', 'asset.suspense_paid', 30000], ['debit', 'liability.other_payables', 420], ['credit', 'asset.ordinary_deposit', 30420],
    ]);
    // 確定後はもう同じ申請を振込データに入れられず、候補からも消える。
    expect((await app.expensePayouts.preview(scope, { transferDate: TRANSFER_DATE })).candidates.claims).toEqual([]);
  });
});

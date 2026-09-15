/**
 * 系統 A（人と承認）を合成根ごと一本通す（docs/21 §20.15 composition 行の A の部分）。
 *
 * 1. `composeExpensePeople` が feature・判定の事実・承認経路のプランナーを返す（組込みツールは足さない）。
 * 2. サンプルの組織と従業員 CSV → サンプルの承認経路 → 申請（従業員を選ぶ）→ チェック → 2 段承認（単一ユーザーの代理・コメント必須）→
 *    振込データの前提（口座の開封と名義 30 バイト以内・振込の点検）→ 振込の印 → 確定で精算済み。
 *    振込ファイルの組み立てと振込バッチのユースケースは系統 B の担当なので、ここでは骨格の遷移（`markPayoutExported` / `markSettled`）で
 *    「振込データを作って確定した」状態を作る（B と結合する E2E は骨格の `expense-practical-flow.e2e.test.ts`）。
 *
 * 判定日は業務のタイムゾーンで決まるので、時計（Date だけ）を 2026-09-30 の日本時間に固定する。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policyWithApproval } from '../adapters/storage/expense-people-deps.fixtures';
import { markPayoutExported, markSettled } from '../domain/expense/claim';
import { ExpenseTransitionError } from '../domain/expense/errors';
import { allReasons } from '../domain/expense/judgment';
import { parseEmployeeCsv } from '../domain/expense/people/employee-csv';
import { checkZenginName, ZENGIN_HOLDER_NAME_MAX_BYTES } from '../domain/expense/zengin-charset';
import { composeExpensePeople } from './expense-people';
import type { ExpenseCoreServices } from './expense-core';
import { createApp, type App } from './root';

const scope = { tenantId: 'local', workspaceId: 'default' };
const by = 'keiri@example.com';
const period = { from: '2026-09-01', to: '2026-09-30' };
const SAMPLES = join(process.cwd(), 'samples', 'expense');
const sample = (name: string): string => readFileSync(join(SAMPLES, name), 'utf8');
const singleUser = { subject: 'single-user', roles: [], singleUser: true, canApprove: true };

describe('composeExpensePeople', () => {
  it('正常: feature のキーはすべて expense で始まり、行ソースは持たず、判定の事実とプランナーを返す', () => {
    const composition = composeExpensePeople({} as ExpenseCoreServices);
    expect(Object.keys(composition.feature).every((key) => key.startsWith('expense'))).toBe(true);
    expect(composition.rowSources).toEqual([]);
    expect(typeof composition.checkFacts.gather).toBe('function');
    expect(typeof composition.approvalPlanner.plan).toBe('function');
  });
});

describe('人と承認の一本通し（E2E）', () => {
  let app: App;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
    app = createApp({ profile: 'test' });
  });

  afterEach(() => {
    app.close();
    vi.useRealTimers();
  });

  it('正常: 従業員登録 → 2 段承認（代理）→ 振込データの前提 → 振込の印 → 確定で精算済み', async () => {
    // 準備: 組織・従業員（サンプル CSV）・承認経路（サンプル JSON）。
    const organization = JSON.parse(sample('people-organization.json')) as { departments: never[]; approverGroups: never[] };
    await app.expenseSaveOrganization.execute(scope, organization);
    const imported = await app.expenseImportEmployeesCsv.execute(scope, sample('employees.csv'), by);
    expect(imported).toMatchObject({ created: parseEmployeeCsv(sample('employees.csv')).records.length, skippedRows: [] });
    expect((await app.expensePeopleReadiness.execute(scope)).employees).toEqual({ configured: true, enabledCount: 5 });
    await app.expensePolicyRepo.save(scope, policyWithApproval(JSON.parse(sample('people-approval-routes.json'))));

    // 申請（従業員を選ぶとサーバーが写しを埋める）→ 明細 → チェック。
    const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: '入力した名前', employeeId: 'emp-taro' }, period, by });
    expect(claim.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' });
    await app.saveExpenseItem.execute({
      scope, claimId: claim.id, categoryId: 'transport.public', source: { type: 'manual' }, by,
      facts: { transactionDate: '2026-09-02', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', description: '東京→品川', route: { stations: ['東京', '品川'], trips: 1 } },
    } as Parameters<App['saveExpenseItem']['execute']>[0]);
    await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by });
    let current = await app.getExpenseClaim.execute(scope, claim.id);
    const reasons = allReasons(current.judgment!);
    expect(reasons.map((reason) => reason.code)).not.toContain('claimant-unlinked');
    expect(reasons.map((reason) => reason.code)).not.toContain('approval-route-unresolved');
    expect(reasons.filter((reason) => reason.severity === 'return')).toEqual([]);
    for (const reason of reasons) {
      await app.acknowledgeExpenseReason.execute({ scope, claimId: claim.id, code: reason.code, note: 'E2E で確認', by, ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }) });
    }

    // 承認の見通し: 営業部の経路（上長の花子 → 経理グループ）。
    const flowView = await app.expenseDescribeApprovalFlow.execute(scope, claim.id, singleUser);
    expect(flowView).toMatchObject({ canAct: true, proxy: true, plan: { routeId: 'sales' }, current: { stepId: 'manager', approvers: [{ employeeId: 'emp-hanako' }] } });
    expect((await app.expenseClaimRepo.list(scope, { awaitingEmployeeId: 'emp-hanako' })).map((summary) => summary.id)).toEqual([claim.id]);

    // 1 段目: 単一ユーザーは代理承認なのでコメント必須。
    const withoutComment = await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'single-user', actor: singleUser }).catch((error: unknown) => error);
    expect(withoutComment).toBeInstanceOf(ExpenseTransitionError);
    expect((withoutComment as ExpenseTransitionError).blockingReasons.map((reason) => reason.code)).toEqual(['approval-proxy-comment-missing']);
    current = await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'single-user', actor: singleUser, comment: '花子さん不在のため代理', stepId: 'manager' });
    expect(current).toMatchObject({ status: 'in-approval', approvalFlow: { routeId: 'sales', currentIndex: 1 } });
    expect(current.approvalFlow?.steps[0]?.decision).toMatchObject({ by: 'single-user', proxy: true, comment: '花子さん不在のため代理' });
    expect(current.history.at(-1)).toMatchObject({ type: 'approval-step', proxy: true });
    expect((await app.expenseClaimRepo.list(scope, { awaitingEmployeeId: 'emp-saburo' })).map((summary) => summary.id)).toEqual([claim.id]);
    expect(await app.expenseClaimRepo.list(scope, { awaitingEmployeeId: 'emp-hanako' })).toEqual([]);

    // 2 段目: 画面を開いたときの段と違えば断る。経理として代理承認して承認済み。
    await expect(app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'single-user', actor: singleUser, comment: 'x', stepId: 'manager' })).rejects.toBeInstanceOf(ExpenseTransitionError);
    current = await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'single-user', actor: singleUser, comment: '経理として代理', stepId: 'accounting' });
    expect(current).toMatchObject({ status: 'approved', approval: { by: 'single-user' }, approvalFlow: { currentIndex: 2 } });

    // 振込データの前提: 口座つき CSV で開封できる・名義は 30 バイト以内・振込の点検に止める理由が無い。
    const bankCsv = await app.expenseExportEmployeesCsv.execute(scope, { withBankAccounts: true });
    const taroRow = parseEmployeeCsv(bankCsv.content).records.find((record) => record.id === 'emp-taro');
    expect(taroRow?.bankAccount).toMatchObject({ accountNumber: '0000001', holderKana: 'テスト タロウ' });
    expect(checkZenginName(taroRow!.bankAccount!.holderKana, ZENGIN_HOLDER_NAME_MAX_BYTES, 'strict')).toMatchObject({ text: 'ﾃｽﾄ ﾀﾛｳ', tooLong: false, invalid: [] });
    expect((await app.expenseGetEmployee.execute(scope, 'emp-taro')).payoutReadiness).toMatchObject({ problems: [], warnings: [] });

    // 振込の印 → 銀行で振り込んで確定 → 精算済み。
    const batchId = 'batch-e2e';
    const exported = markPayoutExported(current, batchId, new Date().toISOString());
    await app.expenseClaimRepo.save(exported, new Map());
    const settled = markSettled(exported, by, new Date().toISOString(), 'zengin-sofuri-20261001-batch-e2.txt');
    await app.expenseClaimRepo.save(settled, new Map());
    expect(await app.getExpenseClaim.execute(scope, claim.id)).toMatchObject({ status: 'settled', payout: { batchId }, settlement: { exportFileName: 'zengin-sofuri-20261001-batch-e2.txt' } });
  });

  it('異常: 名義カナが 30 バイトを超える従業員は取込で止まり（切り詰めない）、口座欄の直し方を理由に返す', async () => {
    await app.expenseSaveOrganization.execute(scope, JSON.parse(sample('people-organization.json')) as { departments: never[]; approverGroups: never[] });
    const result = await app.expenseImportEmployeesCsv.execute(scope, sample('employees-invalid.csv'), by);
    expect(result.created).toBe(0);
    expect(result.skippedRows.map((entry) => entry.row)).toEqual([2, 3, 4, 5]);
    expect(result.skippedRows[0]?.reason).toContain('上限 30 バイトを超えています');
    expect(result.skippedRows[1]?.reason).toContain('「・」');
    expect(result.skippedRows[2]?.reason).toContain('口座番号（account_number）');
    expect(result.skippedRows[3]?.reason).toContain('manager_code「Z999」');
  });
});

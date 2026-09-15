/**
 * 経費精算の組み立て（composition/expense.ts）のテスト。
 *
 * 仕訳 BC への橋渡し（読取ポート・仕訳下書きの受け口）と機能フラグの判定だけを見る。
 * 取込 → 判定 → 承認 → 仕訳下書きの一本通しは `expense-agent.e2e.test.ts` / `expense-flow.e2e.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { fixtureEmployees, fixtureOrganization, FIXTURE_DEPARTMENT_IDS, FIXTURE_EMPLOYEE_IDS } from '../adapters/storage/expense-v9.fixtures';
import { JournalDraftRejectedError } from '../application/expense/errors';
import { DescribeExpenseApprovalUseCase } from '../application/expense/review-claims';
import { mvpApprovalPlan } from '../domain/expense/approval';
import { JournalDomainError } from '../domain/journal/errors';
import { journalChartReader, journalDraftSink, journalReceiptReader } from './expense';
import type { JournalAppFeature } from './journal';
import { createApp } from './root';

const scope = { tenantId: 't', workspaceId: 'w' };
const draft = {
  source: { kind: 'claim-item' as const, id: 'c1', itemId: 'i1' }, date: '2026-09-10', description: '立替精算', invoiceStatus: 'qualified' as const, registrationNumber: 'T1234567890123',
  lines: [{ side: 'debit' as const, accountId: 'expense.travel', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit' as const, accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 1100 }],
  tags: ['expense'],
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('journalReceiptReader', () => {
  it('正常: 仕訳の読取結果を経費の読取結果へ写し、signal と入力をそのまま渡す（hintKind は渡さない）', async () => {
    const execute = vi.fn().mockResolvedValue({ kind: 'receipt', facts: { grandTotal: 1100 }, extraction: { method: 'llm', warnings: ['w'], confidence: 0.7, model: { provider: 'p', model: 'm' } } });
    const reader = journalReceiptReader({ extractJournalDocument: { execute } } as unknown as Pick<JournalAppFeature, 'extractJournalDocument'>);
    const signal = new AbortController().signal;
    const result = await reader.read({ images: ['data:image/png;base64,AA=='], text: 'pdf text', fileName: 'a.pdf' }, signal);
    expect(execute).toHaveBeenCalledWith({ images: ['data:image/png;base64,AA=='], text: 'pdf text', fileName: 'a.pdf' }, signal);
    expect(result).toEqual({ documentKind: 'receipt', facts: { grandTotal: 1100 }, warnings: ['w'], confidence: 0.7, model: { provider: 'p', model: 'm' } });
  });

  it('境界: 任意項目が無ければキーを作らない', async () => {
    const execute = vi.fn().mockResolvedValue({ kind: 'unknown', facts: {}, extraction: { method: 'llm', warnings: [] } });
    const reader = journalReceiptReader({ extractJournalDocument: { execute } } as unknown as Pick<JournalAppFeature, 'extractJournalDocument'>);
    expect(await reader.read({ images: ['x'] })).toEqual({ documentKind: 'unknown', facts: {}, warnings: [] });
    expect(execute).toHaveBeenCalledWith({ images: ['x'] }, undefined);
  });
});

describe('journalDraftSink', () => {
  it('正常: 仕訳の保存ユースケースへ draft・manual・tags で渡し、科目名は空で送る（マスタから写し直させる）', async () => {
    const execute = vi.fn().mockResolvedValue({ id: 'entry-1' });
    const sink = journalDraftSink({ saveJournalEntry: { execute } } as unknown as Pick<JournalAppFeature, 'saveJournalEntry'>);
    expect(await sink.createDraft(scope, draft)).toEqual({ entryId: 'entry-1' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ scope, decidedBy: 'manual', registrationNumber: 'T1234567890123', tags: ['expense'], lines: [expect.objectContaining({ accountName: '' }), expect.objectContaining({ accountName: '' })] }));
    const { registrationNumber: _registrationNumber, ...withoutNumber } = draft;
    await sink.createDraft(scope, withoutNumber);
    expect(execute.mock.calls[1]?.[0]).not.toHaveProperty('registrationNumber');
  });

  it('例外: 仕訳の不変条件違反は JournalDraftRejectedError に言い換え、それ以外はそのまま投げる', async () => {
    const rejecting = journalDraftSink({ saveJournalEntry: { execute: vi.fn().mockRejectedValue(new JournalDomainError('disabled account')) } } as unknown as Pick<JournalAppFeature, 'saveJournalEntry'>);
    await expect(rejecting.createDraft(scope, draft)).rejects.toThrow(JournalDraftRejectedError);
    const broken = journalDraftSink({ saveJournalEntry: { execute: vi.fn().mockRejectedValue(new Error('db down')) } } as unknown as Pick<JournalAppFeature, 'saveJournalEntry'>);
    await expect(broken.createDraft(scope, draft)).rejects.toThrow('db down');
  });
});

describe('expenseCapabilities', () => {
  it('正常: test プロファイルは使えない側へ倒す', async () => {
    const app = createApp({ profile: 'test' });
    try { expect(await app.expenseCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } }); } finally { app.close(); }
  });

  it('正常: main モデルが設定済みで構造化出力と vision があれば使える（C の追加読取・規程のヒアリングも同じ条件で使える）', async () => {
    vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
    const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: new ScriptedModelProvider(), logger: () => { /* 保存先ログは出さない */ } });
    try { expect(await app.expenseCapabilities.execute()).toEqual({ extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: true } }); } finally { app.close(); }
  });

  it('境界: 構造化出力が無ければ使えない。main モデルが未設定でも使えない', async () => {
    vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
    const chatOnly = new ScriptedModelProvider();
    vi.spyOn(chatOnly, 'capabilities').mockReturnValue(['chat']);
    const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: chatOnly, logger: () => { /* 保存先ログは出さない */ } });
    try { expect(await app.expenseCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } }); } finally { app.close(); }

    vi.stubEnv('LM_STUDIO_MODEL', '');
    const unset = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: new ScriptedModelProvider(), logger: () => { /* 保存先ログは出さない */ } });
    try { expect(await unset.expenseCapabilities.execute()).toEqual({ extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } }); } finally { unset.close(); }
  });
});

describe('journalChartReader', () => {
  it('正常: 仕訳の科目マスタを経費の読み取りの形（id・名前・有効）へ写し、他の欄は持ち込まない', async () => {
    const execute = vi.fn().mockResolvedValue({
      saved: true,
      chart: {
        accounts: [{ id: 'expense.travel', name: '旅費交通費', enabled: true, category: 'expense', taxCode: 'JP-IN-10-S' }],
        dimensions: [{ id: 'department', name: '部門', required: false, values: [{ id: 'dept-sales', name: '営業部', enabled: false, sortOrder: 1 }] }],
      },
    });
    const reader = journalChartReader({ getJournalChart: { execute } } as unknown as Pick<JournalAppFeature, 'getJournalChart'>);
    expect(await reader.read(scope)).toEqual({ accounts: [{ id: 'expense.travel', name: '旅費交通費', enabled: true }], dimensions: [{ id: 'department', name: '部門', values: [{ id: 'dept-sales', name: '営業部', enabled: false }] }] });
    expect(execute).toHaveBeenCalledWith(scope);
  });
});

describe('経費の組み立て: 3 系統の配線（§20.13.2。系統がスタブのまま）', () => {
  const period = { from: '2026-09-01', to: '2026-09-30' };

  it('正常: App に全リポジトリ・操作者の従業員マスタ・承認の見通しがあり、従業員マスタは同じ保管庫を指す', () => {
    const app = createApp({ profile: 'test' });
    try {
      for (const key of ['expensePolicyRepo', 'expenseClaimRepo', 'expenseReceiptRepo', 'expenseEmployeeRepo', 'expenseSettingsRepo', 'expenseAdvanceRepo', 'expenseCardRepo', 'expensePayoutBatchRepo', 'expensePolicyHearingRepo'] as const) {
        expect(app[key], key).toBeDefined();
      }
      expect(app.expenseEmployeeDirectory).toBe(app.expenseEmployeeRepo);
      expect(app.describeExpenseApproval).toBeInstanceOf(DescribeExpenseApprovalUseCase);
    } finally { app.close(); }
  });

  it('正常: スタブのままなら取込 → チェック → 承認は MVP と同じ（1 段・approvalFlow なし）で、追加読取は使えない', async () => {
    const app = createApp({ profile: 'test' });
    try {
      await app.resetExpensePolicy.execute(scope);
      const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: 'テスト太郎' }, period, by: 'keiri' });
      await app.saveExpenseItem.execute({ scope, claimId: claim.id, categoryId: 'transport.public', facts: { transactionDate: '2026-09-02', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問' }, source: { type: 'manual' }, by: 'keiri' });
      expect(await app.checkExpenseClaims.execute({ scope, claimIds: [claim.id], by: 'keiri' })).toMatchObject({ checked: 1, pass: 1 });
      const checked = await app.getExpenseClaim.execute(scope, claim.id);
      expect(await app.describeExpenseApproval.execute(scope, checked, { subject: 'boss', roles: [], singleUser: false, canApprove: true })).toEqual({ plan: mvpApprovalPlan(), blockers: [] });
      const approved = await app.approveExpenseClaim.execute({ scope, claimId: claim.id, by: 'boss' });
      expect(approved.status).toBe('approved');
      expect(approved.approvalFlow).toBeUndefined();
      const detail = await app.extractExpenseReceipt.execute({ scope, images: ['data:image/png;base64,AA'], detail: true }).then(() => undefined, (error: unknown) => error);
      expect(detail).toMatchObject({ code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE' });
    } finally { app.close(); }
  });

  it('正常: 申請者の employeeId は組み立てた解決器が同じ保管庫の従業員マスタと組織から写す', async () => {
    const app = createApp({ profile: 'test' });
    try {
      for (const employee of fixtureEmployees(scope)) await app.expenseEmployeeRepo.save(employee);
      await app.expenseSettingsRepo.save(scope, 'organization', fixtureOrganization());
      const claim = await app.createExpenseClaim.execute({ scope, claimant: { name: '入力', employeeId: FIXTURE_EMPLOYEE_IDS.taro }, period, by: 'keiri' });
      expect(claim.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales });
    } finally { app.close(); }
  });
});

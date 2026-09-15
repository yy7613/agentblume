import { describe, expect, it } from 'vitest';
import {
  InMemoryCustomerRepository, InMemoryInvoiceRepository, InMemoryMatchingRepository, InMemoryReceivablesSettingsRepository,
} from '../../adapters/storage/in-memory-receivables-repositories';
import { InvoiceComplianceError, InvoiceNotFoundError, JournalLinkError, ReceivablesStateError } from '../../domain/receivables/errors';
import { createInvoice } from '../../domain/receivables/invoice';
import { createMatching } from '../../domain/receivables/matching-aggregate';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import {
  CheckInvoiceUseCase, CreateInvoiceDraftUseCase, DeleteInvoiceDraftUseCase, DuplicateInvoiceUseCase, GetInvoiceUseCase, IssueInvoiceUseCase,
  ListInvoicesUseCase, UpdateInvoiceDraftUseCase, VoidInvoiceUseCase,
} from './manage-invoices';
import { AT, customerOf, FakeJournalSink, invoiceContent, issuerSettings, NOW, scope, sequentialIds } from './receivables-usecases.fixtures';

async function setup(options: { readonly settings?: boolean } = {}) {
  const deps = {
    invoices: new InMemoryInvoiceRepository(), customers: new InMemoryCustomerRepository(), settings: new InMemoryReceivablesSettingsRepository(),
    matchings: new InMemoryMatchingRepository(), journal: new FakeJournalSink(), unitOfWork: new NoopUnitOfWork(), makeId: sequentialIds('inv'), now: () => NOW,
  };
  if (options.settings !== false) await deps.settings.save(scope, issuerSettings());
  await deps.customers.save(customerOf('c1', { name: '山田商事', address: '東京都', registrationNumber: 'T1234567890123' }));
  const draft = async (overrides = {}) => (await new CreateInvoiceDraftUseCase(deps).execute({ scope, content: invoiceContent(overrides) })).invoice;
  return { deps, draft, issue: new IssueInvoiceUseCase(deps) };
}

describe('請求書の検査・下書き', () => {
  it('正常: 検査は保存せず集計と違反を返す。下書きは設定の丸めモードで保存し、検査結果を同梱する', async () => {
    const { deps } = await setup();
    const check = await new CheckInvoiceUseCase(deps).execute({ scope, content: invoiceContent({ customerId: 'missing' }) });
    expect(check.violations.map((issue) => issue.code)).toEqual(['recipient-missing']);
    expect(await deps.invoices.list(scope)).toEqual([]);
    const created = await new CreateInvoiceDraftUseCase(deps).execute({ scope, content: invoiceContent() });
    expect(created.invoice).toMatchObject({ id: 'inv-1', status: 'draft', roundingMode: 'floor', totals: { grandTotal: 110_000 } });
    expect(created.check.violations).toEqual([]);
  });

  it('正常: 設定を保存していなければ初期値（発行者名なし・登録事業者で番号なし）で検査する', async () => {
    const { deps } = await setup({ settings: false });
    expect((await new CheckInvoiceUseCase(deps).execute({ scope, content: invoiceContent() })).violations.map((issue) => issue.code)).toEqual(['issuer-name-missing', 'issuer-registration-number-missing']);
  });

  it('正常 / 異常: 下書きの更新・削除。発行済みは invoice-not-draft、無い id は 404', async () => {
    const { deps, draft, issue } = await setup();
    const invoice = await draft();
    const updated = await new UpdateInvoiceDraftUseCase(deps).execute({ scope, id: invoice.id, content: invoiceContent({ lines: [{ description: '保守', amount: 50_000, taxRate: 10 }] }) });
    expect(updated.invoice.totals.grandTotal).toBe(55_000);
    await issue.execute({ scope, id: invoice.id });
    await expect(new UpdateInvoiceDraftUseCase(deps).execute({ scope, id: invoice.id, content: invoiceContent() })).rejects.toMatchObject({ reason: 'invoice-not-draft' });
    await expect(new DeleteInvoiceDraftUseCase(deps).execute(scope, invoice.id)).rejects.toMatchObject({ reason: 'invoice-not-draft' });
    await expect(new DeleteInvoiceDraftUseCase(deps).execute(scope, 'missing')).rejects.toThrow(InvoiceNotFoundError);
    const other = await draft();
    await new DeleteInvoiceDraftUseCase(deps).execute(scope, other.id);
    expect(await deps.invoices.findById(scope, other.id)).toBeNull();
  });
});

describe('IssueInvoiceUseCase', () => {
  it('正常: 採番し、発行者・取引先・丸めモードを写して凍結し、売上仕訳の下書きを作る', async () => {
    const { deps, draft, issue } = await setup();
    const invoice = await draft({ declared: { grandTotal: 110_000 } });
    const result = await issue.execute({ scope, id: invoice.id });
    expect(result.invoice).toMatchObject({
      status: 'issued', number: 'INV-2026-0001',
      snapshot: { issuer: { name: '株式会社サンプルソフト' }, customer: { name: '山田商事', honorific: '御中', address: '東京都', registrationNumber: 'T1234567890123' }, roundingMode: 'floor', issuedAt: AT },
      journal: { salesEntryId: 'entry-1' },
    });
    expect(result.invoice).not.toHaveProperty('declared');
    expect(result.journal).toEqual({ status: 'created', entryId: 'entry-1' });
    expect(deps.journal.drafts[0]).toMatchObject({ date: '2026-09-30', description: 'INV-2026-0001 山田商事', tags: ['receivables', `receivables:invoice:${invoice.id}`] });
    expect(deps.journal.checked[0]).toEqual({ accountIds: ['revenue.sales', 'asset.receivables'], taxCodes: ['JP-OUT-10-S', 'JP-NA'] });
    // 2 件目は同じ系列の次の番号。
    expect((await issue.execute({ scope, id: (await draft()).id })).invoice.number).toBe('INV-2026-0002');
  });

  it('異常: 違反があれば InvoiceComplianceError（違反の一覧つき）で断り、番号を消費しない', async () => {
    const { deps, draft, issue } = await setup();
    const invoice = await draft({ transactionDate: undefined });
    const failure = await issue.execute({ scope, id: invoice.id }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InvoiceComplianceError);
    expect((failure as InvoiceComplianceError).violations.map((entry) => entry.code)).toEqual(['transaction-date-missing']);
    expect(await deps.invoices.nextNumber(scope, 'INV-2026-{SEQ4}')).toBe(1);
  });

  it('異常: 仕訳の科目が無ければ JournalLinkError（設定項目名つき）で断り、請求書は下書きのまま', async () => {
    const { deps, draft, issue } = await setup();
    deps.journal.missing = [{ kind: 'account', id: 'revenue.sales' }];
    const invoice = await draft();
    const failure = await issue.execute({ scope, id: invoice.id }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JournalLinkError);
    expect((failure as JournalLinkError).missing).toEqual([{ kind: 'account', id: 'revenue.sales', settingPath: 'journal.accounts.sales' }]);
    expect((await deps.invoices.findById(scope, invoice.id))?.status).toBe('draft');
  });

  it('境界: 仕訳連携が無効ならポートを呼ばない。既存の番号と重なる系列は次の番号へ進める', async () => {
    const { deps, draft, issue } = await setup();
    await deps.settings.save(scope, issuerSettings({ journal: { ...issuerSettings().journal, enabled: false } }));
    const taken = createInvoice({ tenant: scope, id: 'old', ...invoiceContent(), status: 'issued', number: 'INV-2026-0001', roundingMode: 'floor', snapshot: { issuer: issuerSettings().issuer, customer: { name: 'x', honorific: '御中' }, roundingMode: 'floor', issuedAt: AT }, createdAt: AT, updatedAt: AT });
    await deps.invoices.save(taken);
    const result = await issue.execute({ scope, id: (await draft()).id });
    expect(result).toMatchObject({ journal: { status: 'disabled' }, invoice: { number: 'INV-2026-0002' } });
    expect(deps.journal.drafts).toEqual([]);
  });

  it('境界: 仕訳が確定済みで上書きしなかったら journalFollowUp（review）を返す。発行済みの再発行は 409', async () => {
    const { deps, draft, issue } = await setup();
    deps.journal.keep = true;
    const invoice = await draft();
    const result = await issue.execute({ scope, id: invoice.id });
    expect(result.journalFollowUp).toEqual({ entryId: 'confirmed-entry', action: 'review', entryStatus: 'confirmed' });
    expect(result.invoice.journal).toEqual({ salesEntryId: 'confirmed-entry', salesEntryKept: true });
    await expect(issue.execute({ scope, id: invoice.id })).rejects.toBeInstanceOf(ReceivablesStateError);
    await expect(issue.execute({ scope, id: 'missing' })).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });
});

describe('VoidInvoiceUseCase / DuplicateInvoiceUseCase', () => {
  it('正常: 取消で売上仕訳の下書きを消す。確定済みなら残して reverse を案内する。仕訳が消えていれば参照を外す', async () => {
    for (const [outcome, followUp, journal] of [
      ['deleted', undefined, {}],
      ['kept', { entryId: 'entry-1', action: 'reverse' }, { salesEntryId: 'entry-1', salesEntryKept: true }],
      ['not-found', undefined, {}],
    ] as const) {
      const { deps, draft, issue } = await setup();
      deps.journal.discardOutcome = outcome;
      const { invoice } = await issue.execute({ scope, id: (await draft()).id });
      const result = await new VoidInvoiceUseCase(deps).execute({ scope, id: invoice.id, reason: '宛名の誤り' });
      expect(result.invoice).toMatchObject({ status: 'void', voided: { reason: '宛名の誤り' }, journal });
      expect(result.journalFollowUp).toEqual(followUp);
      expect(deps.journal.discarded).toEqual(['entry-1']);
    }
  });

  it('異常: 確定済みの消込がある請求は取り消せない（先に消込を取り消す）', async () => {
    const { deps, draft, issue } = await setup();
    const { invoice } = await issue.execute({ scope, id: (await draft()).id });
    await deps.matchings.save(createMatching({ tenant: scope, id: 'm', transactionId: 'tx', transactionAmount: 1_000, allocations: [{ invoiceId: invoice.id, amount: 1_000 }], feeAmount: 0, decidedBy: 'manual', confirmedAt: AT, createdAt: AT, updatedAt: AT }));
    await expect(new VoidInvoiceUseCase(deps).execute({ scope, id: invoice.id, reason: 'x' })).rejects.toMatchObject({ reason: 'invoice-has-payments' });
  });

  it('正常: 複製は発行日を今日にし、元の請求を記録し、番号を持たない下書きを作る', async () => {
    const { deps, draft, issue } = await setup();
    const { invoice } = await issue.execute({ scope, id: (await draft({ issueDate: '2026-09-01' })).id });
    const duplicate = await new DuplicateInvoiceUseCase(deps).execute({ scope, id: invoice.id });
    expect(duplicate.invoice).toMatchObject({ status: 'draft', issueDate: '2026-09-30', duplicatedFrom: invoice.id, customerId: 'c1' });
    expect(duplicate.invoice).not.toHaveProperty('number');
  });
});

describe('一覧と取得', () => {
  it('正常: 取引先名・未入金額・期日超過日数・下書きの違反件数を付け、状態・期日超過で絞れる', async () => {
    const { deps, draft, issue } = await setup();
    await draft({ customerId: undefined });
    const { invoice } = await issue.execute({ scope, id: (await draft({ issueDate: '2026-08-01', transactionDate: '2026-08-01', dueDate: '2026-08-31' })).id });
    const list = new ListInvoicesUseCase(deps);
    const all = await list.execute(scope);
    // 作成日時が同じなので id 昇順（下書き inv-1 が先）。
    expect(all.map((summary) => [summary.invoice.status, summary.customerName, summary.violationCount, summary.daysOverdue])).toEqual([
      ['draft', undefined, 1, 0],
      ['issued', '山田商事', 0, 30],
    ]);
    expect((await list.execute(scope, { status: 'draft' })).map((summary) => summary.invoice.status)).toEqual(['draft']);
    expect((await list.execute(scope, { overdue: true })).map((summary) => summary.invoice.id)).toEqual([invoice.id]);
    expect(await list.execute(scope, { customerId: 'nobody', from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
  });

  it('正常: 取得は入金の配分履歴を付け、下書きにだけ検査を付ける', async () => {
    const { deps, draft, issue } = await setup();
    const pending = await draft();
    expect((await new GetInvoiceUseCase(deps).execute(scope, pending.id)).check?.violations).toEqual([]);
    const { invoice } = await issue.execute({ scope, id: pending.id });
    await deps.matchings.save(createMatching({ tenant: scope, id: 'm', transactionId: 'tx', transactionAmount: 9_560, allocations: [{ invoiceId: invoice.id, amount: 10_000 }], feeAmount: 440, decidedBy: 'manual', confirmedAt: AT, createdAt: AT, updatedAt: AT }));
    const got = await new GetInvoiceUseCase(deps).execute(scope, invoice.id);
    expect(got).not.toHaveProperty('check');
    expect(got.payments).toEqual([{ matchingId: 'm', transactionId: 'tx', amount: 10_000, feeAmount: 440, status: 'confirmed', confirmedAt: AT }]);
  });
});

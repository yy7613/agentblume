import { describe, expect, it } from 'vitest';
import {
  InMemoryBankTransactionRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository, InMemoryMatchingRepository, InMemoryReceivablesSettingsRepository,
} from '../../adapters/storage/in-memory-receivables-repositories';
import { createBankTransaction, type BankTransaction } from '../../domain/receivables/bank-transaction';
import { BankTransactionNotFoundError, CustomerNotFoundError, InvoiceNotFoundError, JournalLinkError, MatchingNotFoundError } from '../../domain/receivables/errors';
import { createInvoice, type Invoice } from '../../domain/receivables/invoice';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { JudgeTransactionsUseCase, MatchCandidatesUseCase } from './judge-transactions';
import {
  CancelMatchingUseCase, ConfirmDecidedMatchingsUseCase, ConfirmMatchingUseCase, DeleteBankTransactionUseCase, expectedOutstandingOf,
  IgnoreTransactionUseCase, ListBankTransactionsUseCase, ListMatchingsUseCase, UnignoreTransactionUseCase,
} from './manage-matchings';
import { AT, customerOf, FakeJournalSink, issuerSettings, NOW, scope, sequentialIds } from './receivables-usecases.fixtures';

const snapshot = { issuer: issuerSettings().issuer, customer: { name: 'テスト工業', honorific: '御中' }, roundingMode: 'floor' as const, issuedAt: AT };

function issued(id: string, amount: number, overrides: Partial<Parameters<typeof createInvoice>[0]> = {}): Invoice {
  return createInvoice({
    tenant: scope, id, number: `INV-${id}`, status: 'issued', customerId: 'c-test', issueDate: '2026-09-01', transactionDate: '2026-09-01', dueDate: '2026-09-30',
    pricing: 'inclusive', lines: [{ description: 'x', amount, taxRate: 10 }], roundingMode: 'floor', snapshot, journal: {}, createdAt: AT, updatedAt: AT, ...overrides,
  });
}

function deposit(id: string, amount: number, payerName: string, overrides: Partial<Parameters<typeof createBankTransaction>[0]> = {}): BankTransaction {
  return createBankTransaction({
    tenant: scope, id, accountKey: 'main', date: '2026-09-30', amount, description: `ﾌﾘｺﾐ ${payerName}`, payerName, payerNameNorm: payerName,
    source: { row: {}, rowNumber: 2 }, fingerprint: `fp-${id}`, createdAt: AT, updatedAt: AT, ...overrides,
  });
}

async function setup() {
  const repos = {
    settings: new InMemoryReceivablesSettingsRepository(), customers: new InMemoryCustomerRepository(), invoices: new InMemoryInvoiceRepository(),
    transactions: new InMemoryBankTransactionRepository(), matchings: new InMemoryMatchingRepository(),
  };
  const deps = { ...repos, journal: new FakeJournalSink(), unitOfWork: new NoopUnitOfWork(), makeId: sequentialIds('m'), now: () => NOW };
  await repos.settings.save(scope, issuerSettings());
  await repos.customers.save(customerOf('c-test', { name: 'テスト工業', kana: 'テストコウギヨウ' }));
  return { ...repos, deps, journal: deps.journal, confirm: new ConfirmMatchingUseCase(deps), judge: new JudgeTransactionsUseCase(repos) };
}

describe('ConfirmMatchingUseCase', () => {
  it('正常: 判定の候補どおりに確定すると、消込・明細・請求・入金仕訳が 1 回で揃う', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 33_000));
    await context.invoices.save(issued('b', 22_000));
    await context.transactions.save(deposit('tx', 54_560, 'テストコウギヨウ'));
    await context.judge.execute({ scope });
    const judged = (await context.transactions.findById(scope, 'tx'))!.judgment!;
    expect(judged.reason).toBe('combined-payment-with-fee');
    const candidate = judged.candidates[0]!;
    const result = await context.confirm.execute({ scope, transactionId: 'tx', allocations: candidate.allocations, feeAmount: candidate.feeAmount, expectedOutstanding: expectedOutstandingOf(candidate) });
    expect(result.matching).toMatchObject({ transactionId: 'tx', customerId: 'c-test', feeAmount: 440, decidedBy: 'judgment', judgmentReason: 'combined-payment-with-fee', journal: { entryId: 'entry-1', outcome: 'created' } });
    expect(result.journal).toEqual({ status: 'created', entryId: 'entry-1' });
    expect((await context.transactions.findById(scope, 'tx'))).toMatchObject({ status: 'matched', matchingId: result.matching.id });
    expect((await context.invoices.findById(scope, 'a'))?.status).toBe('paid');
    // 手数料の税区分の税率から税額を出す（仕訳のマスタを引く）。
    expect(context.journal.drafts[0]!.lines[1]).toEqual({ side: 'debit', accountId: 'expense.fees', taxCode: 'JP-IN-10-S', amount: 440, taxAmount: 40 });
    expect(context.journal.drafts[0]!.description).toBe('入金 テスト工業 INV-a INV-b');
  });

  it('正常: 配分を編集した確定は manual。名義を覚えると学習した別名を記録する', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 50_000));
    await context.transactions.save(deposit('tx', 30_000, 'ﾃｽﾄ ｺｳｷﾞﾖｳ ｼﾃﾝ'));
    const result = await context.confirm.execute({ scope, transactionId: 'tx', allocations: [{ invoiceId: 'a', amount: 30_000 }], feeAmount: 0, learnAlias: { customerId: 'c-test' } });
    expect(result.matching.decidedBy).toBe('manual');
    expect(result.learnedAlias).toMatchObject({ customerId: 'c-test', created: true });
    expect(result.matching.learnedAlias).toEqual({ customerId: 'c-test', aliasId: result.learnedAlias!.aliasId });
    expect((await context.customers.findById(scope, 'c-test'))!.payerAliases[0]).toMatchObject({ origin: 'learned', matchingId: result.matching.id, normalized: 'テストコウギヨウシテン' });
    expect((await context.invoices.findById(scope, 'a'))).toMatchObject({ status: 'partially_paid', paidAmount: 30_000 });
    expect(context.journal.drafts[0]!.lines.map((line) => line.accountId)).toEqual(['asset.ordinary_deposit', 'asset.receivables']);
  });

  it('異常: 確定の前提チェック（残高の変化・配分超過・合計の不一致・手数料の範囲・状態）', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 10_000));
    await context.invoices.save(issued('void', 10_000, { status: 'void', voided: { at: AT, reason: 'x' } }));
    await context.transactions.save(deposit('tx', 10_000, 'x'));
    const base = { scope, transactionId: 'tx', allocations: [{ invoiceId: 'a', amount: 10_000 }], feeAmount: 0 };
    await expect(context.confirm.execute({ ...base, expectedOutstanding: { a: 9_000 } })).rejects.toMatchObject({ reason: 'invoice-outstanding-changed', params: { expected: 9_000, outstanding: 10_000 } });
    await expect(context.confirm.execute({ ...base, allocations: [{ invoiceId: 'a', amount: 10_001 }], feeAmount: 1 })).rejects.toMatchObject({ reason: 'allocation-exceeds-outstanding' });
    await expect(context.confirm.execute({ ...base, allocations: [{ invoiceId: 'a', amount: 9_000 }] })).rejects.toMatchObject({ reason: 'allocation-sum-mismatch' });
    await expect(context.confirm.execute({ ...base, allocations: [] })).rejects.toMatchObject({ reason: 'allocation-sum-mismatch' });
    await context.transactions.save(deposit('tx2', 9_000, 'x'));
    await expect(context.confirm.execute({ ...base, transactionId: 'tx2', feeAmount: 1_000 })).rejects.toMatchObject({ reason: 'fee-out-of-tolerance', params: { fee: 1_000, min: 1, max: 880 } });
    await expect(context.confirm.execute({ ...base, allocations: [{ invoiceId: 'void', amount: 10_000 }] })).rejects.toMatchObject({ reason: 'invoice-outstanding-changed' });
    await expect(context.confirm.execute({ ...base, allocations: [{ invoiceId: 'missing', amount: 10_000 }] })).rejects.toBeInstanceOf(InvoiceNotFoundError);
    await expect(context.confirm.execute({ ...base, transactionId: 'missing' })).rejects.toBeInstanceOf(BankTransactionNotFoundError);
    await expect(context.confirm.execute({ ...base, learnAlias: { customerId: 'nobody' } })).rejects.toBeInstanceOf(CustomerNotFoundError);
    await context.confirm.execute(base);
    await expect(context.confirm.execute(base)).rejects.toMatchObject({ reason: 'transaction-not-unmatched' });
  });

  it('境界: 仕訳連携が無効なら disabled、科目が無ければ JournalLinkError、確定済みの仕訳なら followUp。空の名義は覚えない', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 10_000));
    await context.invoices.save(issued('b', 10_000));
    await context.invoices.save(issued('c', 10_000));
    await context.transactions.save(deposit('t1', 10_000, ''));
    await context.transactions.save(deposit('t2', 10_000, 'x'));
    await context.transactions.save(deposit('t3', 10_000, 'x'));
    context.journal.missing = [{ kind: 'tax', id: 'JP-NA' }];
    await expect(context.confirm.execute({ scope, transactionId: 't2', allocations: [{ invoiceId: 'b', amount: 10_000 }], feeAmount: 0 })).rejects.toBeInstanceOf(JournalLinkError);
    context.journal.missing = [];
    context.journal.keep = true;
    expect((await context.confirm.execute({ scope, transactionId: 't3', allocations: [{ invoiceId: 'c', amount: 10_000 }], feeAmount: 0 })).journalFollowUp).toEqual({ entryId: 'confirmed-entry', action: 'review', entryStatus: 'confirmed' });
    await context.settings.save(scope, issuerSettings({ journal: { ...issuerSettings().journal, enabled: false } }));
    const disabled = await context.confirm.execute({ scope, transactionId: 't1', allocations: [{ invoiceId: 'a', amount: 10_000 }], feeAmount: 0, learnAlias: { customerId: 'c-test' } });
    expect(disabled).toMatchObject({ journal: { status: 'disabled' }, matching: { journal: { outcome: 'disabled' } } });
    expect(disabled).not.toHaveProperty('learnedAlias');
  });
});

describe('ConfirmDecidedMatchingsUseCase', () => {
  it('正常: 競合の無い decided だけを 1 件ずつ確定し、途中の失敗は理由を積んで続ける', async () => {
    const context = await setup();
    await context.customers.save(customerOf('c-sample', { name: 'サンプル商事', kana: 'サンプルシヨウジ' }));
    await context.invoices.save(issued('a', 110_000, { customerId: 'c-sample' }));
    await context.invoices.save(issued('b', 55_000));
    await context.invoices.save(issued('d', 20_000));
    await context.transactions.save(deposit('ok', 110_000, 'サンプルシヨウジ'));
    await context.transactions.save(deposit('contended-1', 55_000, 'テストコウギヨウ'));
    await context.transactions.save(deposit('contended-2', 55_000, 'テストコウギヨウ', { fingerprint: 'fp-c2' }));
    await context.transactions.save(deposit('stale', 20_000, 'テストコウギヨウ'));
    await context.judge.execute({ scope });
    expect((await context.transactions.findById(scope, 'contended-1'))!.judgment).toMatchObject({ stage: 'decided', contendedBy: ['contended-2'] });
    // 判定の後に請求 d の残高が変わった（別の経路で一部入金された）。
    await context.invoices.save({ ...(await context.invoices.findById(scope, 'd'))!, paidAmount: 5_000, status: 'partially_paid' });
    const result = await new ConfirmDecidedMatchingsUseCase(context.transactions, context.confirm).execute(scope);
    expect(result.confirmed.map((entry) => entry.transactionId)).toEqual(['ok']);
    expect(result.failed).toEqual([expect.objectContaining({ transactionId: 'stale', code: 'RECEIVABLES_STATE', reason: 'invoice-outstanding-changed' })]);
  });
});

describe('CancelMatchingUseCase と明細の状態', () => {
  it('正常: 取消で明細を未消込へ、請求の入金額を戻し、入金仕訳の下書きを消し、学習した別名を消す', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 10_000));
    await context.transactions.save(deposit('tx', 10_000, 'ﾃｽﾄｺｳｷﾞﾖｳﾍﾞﾂ'));
    const confirmed = await context.confirm.execute({ scope, transactionId: 'tx', allocations: [{ invoiceId: 'a', amount: 10_000 }], feeAmount: 0, learnAlias: { customerId: 'c-test' } });
    const cancel = new CancelMatchingUseCase(context.deps);
    const result = await cancel.execute({ scope, matchingId: confirmed.matching.id, removeLearnedAlias: true });
    expect(result).toMatchObject({ matching: { status: 'cancelled' }, removedAlias: true });
    expect(result).not.toHaveProperty('journalFollowUp');
    expect(await context.transactions.findById(scope, 'tx')).toMatchObject({ status: 'unmatched' });
    expect(await context.invoices.findById(scope, 'a')).toMatchObject({ status: 'issued', paidAmount: 0 });
    expect(context.journal.discarded).toEqual(['entry-1']);
    expect((await context.customers.findById(scope, 'c-test'))!.payerAliases).toEqual([]);
    await expect(cancel.execute({ scope, matchingId: confirmed.matching.id })).rejects.toMatchObject({ reason: 'matching-not-confirmed' });
    await expect(cancel.execute({ scope, matchingId: 'missing' })).rejects.toBeInstanceOf(MatchingNotFoundError);
  });

  it('境界: 確定済みの仕訳は残して reverse を案内する。別名の削除を選ばなければ残す', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 10_000));
    await context.transactions.save(deposit('tx', 10_000, 'ﾍﾞﾂﾒｲ'));
    const confirmed = await context.confirm.execute({ scope, transactionId: 'tx', allocations: [{ invoiceId: 'a', amount: 10_000 }], feeAmount: 0, learnAlias: { customerId: 'c-test' } });
    context.journal.discardOutcome = 'kept';
    const result = await new CancelMatchingUseCase(context.deps).execute({ scope, matchingId: confirmed.matching.id });
    expect(result).toMatchObject({ journalFollowUp: { entryId: 'entry-1', action: 'reverse' }, removedAlias: false });
    expect((await context.customers.findById(scope, 'c-test'))!.payerAliases).toHaveLength(1);
    expect((await new ListMatchingsUseCase(context.matchings).execute(scope, { status: 'cancelled' })).map((matching) => matching.id)).toEqual([confirmed.matching.id]);
  });

  it('正常 / 異常: 対象外にする・戻す・消込済みの明細は削除できない・一覧', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 3));
    await context.transactions.save(deposit('interest', 3, 'リソク'));
    const ignore = new IgnoreTransactionUseCase(context.transactions, () => NOW);
    expect(await ignore.execute({ scope, id: 'interest', note: '利息' })).toMatchObject({ status: 'ignored', ignoredNote: '利息' });
    expect(await new UnignoreTransactionUseCase(context.transactions).execute({ scope, id: 'interest' })).toMatchObject({ status: 'unmatched' });
    await expect(ignore.execute({ scope, id: 'missing' })).rejects.toBeInstanceOf(BankTransactionNotFoundError);
    await context.confirm.execute({ scope, transactionId: 'interest', allocations: [{ invoiceId: 'a', amount: 3 }], feeAmount: 0 });
    const remove = new DeleteBankTransactionUseCase(context.transactions);
    await expect(remove.execute(scope, 'interest')).rejects.toMatchObject({ reason: 'transaction-not-unmatched' });
    await context.transactions.save(deposit('wrong', 1, 'x'));
    await remove.execute(scope, 'wrong');
    expect((await new ListBankTransactionsUseCase(context.transactions).execute(scope)).map((transaction) => transaction.id)).toEqual(['interest']);
  });
});

describe('JudgeTransactionsUseCase / MatchCandidatesUseCase', () => {
  it('正常: 未消込の明細を判定して保存し、件数を返す。id で絞れる。候補の計算は保存しない', async () => {
    const context = await setup();
    await context.invoices.save(issued('a', 10_000));
    await context.transactions.save(deposit('t1', 10_000, 'テストコウギヨウ'));
    await context.transactions.save(deposit('t2', 5, 'フメイ'));
    const result = await context.judge.execute({ scope, transactionIds: ['t2'] });
    expect(result).toEqual({ judged: [{ transactionId: 't2', stage: 'unmatched', reason: 'no-candidate' }], counts: { decided: 0, candidate: 0, unmatched: 1 } });
    expect((await context.transactions.findById(scope, 't1'))!.judgment).toBeUndefined();
    const candidates = await new MatchCandidatesUseCase(context).execute(scope, 't1');
    expect(candidates.judgment.reason).toBe('exact-amount-and-name');
    expect(candidates.invoices.map((invoice) => invoice.id)).toEqual(['a']);
    expect((await context.transactions.findById(scope, 't1'))!.judgment).toBeUndefined();
    await expect(new MatchCandidatesUseCase(context).execute(scope, 'missing')).rejects.toBeInstanceOf(BankTransactionNotFoundError);
    expect(expectedOutstandingOf(candidates.judgment.candidates[0]!)).toEqual({ a: 10_000 });
  });
});

/**
 * adapters層: 経費精算「お金の流れ（系統 B）」の application テスト用の依存（テスト専用）。
 *
 * `ExpenseSystemDeps` を InMemory の保管庫・偽の暗号・固定の時計・記録する仕訳の受け口で組む。
 * 値は呼ぶたびに新しく作る（テスト間で状態が漏れないように）。
 */
import type { JournalDraftSink } from '../../application/expense/draft-journal-entries';
import { JournalDraftRejectedError } from '../../application/expense/errors';
import type { JournalChartReadPort } from '../../application/expense/ports';
import { ExpenseSettingsStore, organizationReader } from '../../application/expense/settings-store';
import type { ExpenseSystemDeps } from '../../application/expense/system-deps';
import { NoopUnitOfWork, type UnitOfWorkPort } from '../../application/persistence/unit-of-work';
import type { ExpenseJournalDraft } from '../../domain/expense/journal-draft';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { fixtureAccountCipher } from './expense-v9.fixtures';
import { InMemoryExpensePolicyHearingRepository } from './in-memory-expense-input-repositories';
import { InMemoryExpenseAdvanceRepository, InMemoryExpenseCardRepository, InMemoryExpensePayoutBatchRepository } from './in-memory-expense-money-repositories';
import { InMemoryExpenseEmployeeRepository } from './in-memory-expense-people-repositories';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from './in-memory-expense-repositories';
import { InMemoryExpenseSettingsRepository } from './in-memory-expense-settings-repository';

/** 作った下書きを覚える仕訳の受け口。`reject` に理由を入れると次の 1 件を拒否する。 */
export class RecordingJournalSink implements JournalDraftSink {
  readonly drafts: { readonly scope: TenantScope; readonly draft: ExpenseJournalDraft }[] = [];
  reject: string | undefined;

  async createDraft(scope: TenantScope, draft: ExpenseJournalDraft): Promise<{ readonly entryId: string }> {
    if (this.reject !== undefined) {
      const detail = this.reject;
      this.reject = undefined;
      throw new JournalDraftRejectedError(detail);
    }
    this.drafts.push({ scope, draft });
    return { entryId: `je-${this.drafts.length}` };
  }
}

/** 巻き戻しを記録する作業単位（途中で投げたら「巻き戻した」回数を数える。InMemory は実際には戻らない）。 */
export class CountingUnitOfWork implements UnitOfWorkPort {
  transactions = 0;
  failures = 0;
  private readonly inner = new NoopUnitOfWork();

  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactions += 1;
    try {
      return await this.inner.withTransaction(work);
    } catch (error) {
      this.failures += 1;
      throw error;
    }
  }
}

export interface MoneyTestContext {
  readonly deps: ExpenseSystemDeps;
  readonly claims: InMemoryExpenseClaimRepository;
  readonly receipts: InMemoryExpenseReceiptRepository;
  readonly policies: InMemoryExpensePolicyRepository;
  readonly employees: InMemoryExpenseEmployeeRepository;
  readonly settings: InMemoryExpenseSettingsRepository;
  readonly advances: InMemoryExpenseAdvanceRepository;
  readonly cards: InMemoryExpenseCardRepository;
  readonly journal: RecordingJournalSink;
  readonly unitOfWork: CountingUnitOfWork;
  /** 時計を進める（ISO 日時）。 */
  setNow(iso: string): void;
}

export function moneyTestContext(options: { readonly now?: string; readonly journal?: boolean; readonly chart?: JournalChartReadPort } = {}): MoneyTestContext {
  let now = new Date(options.now ?? '2026-09-20T03:00:00.000Z');
  const claims = new InMemoryExpenseClaimRepository();
  const receipts = new InMemoryExpenseReceiptRepository();
  const policies = new InMemoryExpensePolicyRepository();
  const employees = new InMemoryExpenseEmployeeRepository();
  const settings = new InMemoryExpenseSettingsRepository();
  const advances = new InMemoryExpenseAdvanceRepository();
  const cards = new InMemoryExpenseCardRepository();
  const journal = new RecordingJournalSink();
  const unitOfWork = new CountingUnitOfWork();
  const store = new ExpenseSettingsStore(settings);
  const deps: ExpenseSystemDeps = {
    repositories: {
      policies, claims, receipts, employees, settings, advances, cards,
      payouts: new InMemoryExpensePayoutBatchRepository(), hearings: new InMemoryExpensePolicyHearingRepository(),
    },
    settings: store,
    employeeDirectory: employees,
    organization: organizationReader(store),
    cipher: fixtureAccountCipher,
    unitOfWork,
    ...(options.journal === false ? {} : { journalDrafts: journal }),
    ...(options.chart === undefined ? {} : { journalChart: options.chart }),
    now: () => now,
    timeZone: 'Asia/Tokyo',
  };
  return { deps, claims, receipts, policies, employees, settings, advances, cards, journal, unitOfWork, setNow: (iso) => { now = new Date(iso); } };
}

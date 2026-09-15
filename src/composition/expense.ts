/**
 * Composition: 経費精算（docs/21-expense.md）の組み立て。
 *
 * リポジトリの選択（SQLite / InMemory）・ユースケース・行ソース（`expense-*` ノード）・機能フラグをここで組み、
 * `root.ts` へは `ExpenseAppFeature` と行ソースだけを返す（ADR-0039）。
 *
 * 実用化（docs/21 §20.13.2）: 全リポジトリとポートをここで 1 回だけ作り、`ExpenseCoreServices` として 3 系統の
 * `compose<系統>(core)` へ渡す。系統の `feature` を App に展開し、行ソースを連結し、判定の事実 provider・承認経路のプランナー・
 * 追加読取を骨格のユースケースへ配線する。系統がスタブのままなら MVP と同じ動きになる。
 *
 * 仕訳 BC への橋渡しは**ここだけ**で行う（docs/21 §18.1 S-1）:
 * - 読取は仕訳の組み立て結果の `extractJournalDocument` を `ReceiptReaderPort` として包む（同じプロンプト・同じ誤読対策）。
 * - 仕訳下書きは仕訳の `saveJournalEntry` を `JournalDraftSink` として包む。仕訳のリポジトリを作り直すと、
 *   test プロファイルでは InMemory の保管庫が別になり、作った下書きが仕訳画面から見えないため。
 * - 部門の補助軸の照合は仕訳の `getJournalChart` を `JournalChartReadPort` として包む。
 */
import { AesGcmSecretCipher } from '../adapters/security/aes-gcm-secret-cipher';
import {
  InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository,
} from '../adapters/storage/in-memory-expense-repositories';
import { InMemoryExpensePolicyHearingRepository } from '../adapters/storage/in-memory-expense-input-repositories';
import { InMemoryExpenseAdvanceRepository, InMemoryExpenseCardRepository, InMemoryExpensePayoutBatchRepository } from '../adapters/storage/in-memory-expense-money-repositories';
import { InMemoryExpenseEmployeeRepository } from '../adapters/storage/in-memory-expense-people-repositories';
import { InMemoryExpenseSettingsRepository } from '../adapters/storage/in-memory-expense-settings-repository';
import {
  SqliteExpenseClaimRepository, SqliteExpensePolicyRepository, SqliteExpenseReceiptRepository,
} from '../adapters/storage/sqlite-expense-repositories';
import { SqliteExpensePolicyHearingRepository } from '../adapters/storage/sqlite-expense-input-repositories';
import { SqliteExpenseAdvanceRepository, SqliteExpenseCardRepository, SqliteExpensePayoutBatchRepository } from '../adapters/storage/sqlite-expense-money-repositories';
import { SqliteExpenseEmployeeRepository } from '../adapters/storage/sqlite-expense-people-repositories';
import { SqliteExpenseSettingsRepository } from '../adapters/storage/sqlite-expense-settings-repository';
import { DEFAULT_BUSINESS_TIME_ZONE } from '../domain/expense/business-date';
import { EXPENSE_CAPABILITIES_DISABLED, ExpenseCapabilitiesUseCase, type ExpenseCapabilities } from '../application/expense/capabilities';
import { CheckExpenseClaimsUseCase } from '../application/expense/check-claims';
import { ExpenseClaimRowsProvider } from '../application/expense/claim-rows';
import { DraftJournalEntriesUseCase, type JournalDraftSink } from '../application/expense/draft-journal-entries';
import { JournalDraftRejectedError } from '../application/expense/errors';
import { ExportExpenseSettlementUseCase, SettleExpenseClaimsUseCase } from '../application/expense/export-settlement';
import { ExtractReceiptUseCase, type ReceiptReaderPort } from '../application/expense/extract-receipt';
import { ImportExpenseCsvUseCase } from '../application/expense/import-csv';
import {
  ClaimantResolver, CreateExpenseClaimUseCase, DeleteExpenseClaimUseCase, DeleteExpenseItemUseCase, GetExpenseClaimUseCase, GetExpenseReceiptUseCase,
  ListExpenseClaimsUseCase, SaveExpenseItemUseCase, UpdateExpenseClaimUseCase,
} from '../application/expense/manage-claims';
import { GetExpensePolicyUseCase, ResetExpensePolicyUseCase, SaveExpensePolicyUseCase } from '../application/expense/manage-policy';
import { ExpensePolicyRowsProvider } from '../application/expense/policy-rows';
import { ExportExpensePolicyCsvUseCase, ImportExpensePolicyCsvUseCase } from '../application/expense/policy-transfer';
import type { EmployeeDirectoryPort, JournalChartReadPort } from '../application/expense/ports';
import { ExpenseReceiptCheckRowsProvider } from '../application/expense/receipt-check-rows';
import {
  AcknowledgeExpenseReasonUseCase, ApproveExpenseClaimUseCase, DescribeExpenseApprovalUseCase, GetReturnDraftUseCase, ReturnExpenseClaimUseCase, UnapproveExpenseClaimUseCase,
} from '../application/expense/review-claims';
import { expenseRowSources } from '../application/expense/row-sources';
import { ExpenseSettingsStore, organizationReader } from '../application/expense/settings-store';
import type {
  ExpenseAdvanceRepository, ExpenseCardRepository, ExpenseClaimRepository, ExpenseEmployeeRepository, ExpensePayoutBatchRepository,
  ExpensePolicyHearingRepository, ExpensePolicyRepository, ExpenseReceiptRepository, ExpenseSettingsRepository,
} from '../domain/expense/repositories';
import { JournalDomainError } from '../domain/journal/errors';
import type { BusinessComposition, BusinessCompositionContext } from './business';
import type { ExpenseCoreServices } from './expense-core';
import { composeExpenseInput, type ExpenseInputFeature } from './expense-input';
import { composeExpenseMoney, type ExpenseMoneyFeature } from './expense-money';
import { composeExpensePeople, type ExpensePeopleFeature } from './expense-people';
import type { JournalAppFeature } from './journal';

/** 仕訳の組み立て結果。仕訳下書き・帳票読取を同じ保管庫へ繋ぐため（test プロファイルの InMemory を共有する）。 */
export interface ExpenseCompositionDependencies {
  readonly journal: JournalAppFeature;
}

/** App のうち経費精算の部分（キーはすべて `expense` で始める）。系統の部分は extends で足す。 */
export interface ExpenseAppFeature extends ExpensePeopleFeature, ExpenseMoneyFeature, ExpenseInputFeature {
  readonly expensePolicyRepo: ExpensePolicyRepository;
  readonly expenseClaimRepo: ExpenseClaimRepository;
  readonly expenseReceiptRepo: ExpenseReceiptRepository;
  readonly expenseEmployeeRepo: ExpenseEmployeeRepository;
  readonly expenseSettingsRepo: ExpenseSettingsRepository;
  readonly expenseAdvanceRepo: ExpenseAdvanceRepository;
  readonly expenseCardRepo: ExpenseCardRepository;
  readonly expensePayoutBatchRepo: ExpensePayoutBatchRepository;
  readonly expensePolicyHearingRepo: ExpensePolicyHearingRepository;
  /** 操作者（`ExpenseActor`）の従業員を引く（api の `expense-actor.ts`）。 */
  readonly expenseEmployeeDirectory: EmployeeDirectoryPort;
  readonly getExpensePolicy: GetExpensePolicyUseCase;
  readonly saveExpensePolicy: SaveExpensePolicyUseCase;
  readonly resetExpensePolicy: ResetExpensePolicyUseCase;
  readonly exportExpensePolicyCsv: ExportExpensePolicyCsvUseCase;
  readonly importExpensePolicyCsv: ImportExpensePolicyCsvUseCase;
  readonly listExpenseClaims: ListExpenseClaimsUseCase;
  readonly createExpenseClaim: CreateExpenseClaimUseCase;
  readonly getExpenseClaim: GetExpenseClaimUseCase;
  readonly updateExpenseClaim: UpdateExpenseClaimUseCase;
  readonly deleteExpenseClaim: DeleteExpenseClaimUseCase;
  readonly saveExpenseItem: SaveExpenseItemUseCase;
  readonly deleteExpenseItem: DeleteExpenseItemUseCase;
  readonly getExpenseReceipt: GetExpenseReceiptUseCase;
  readonly importExpenseCsv: ImportExpenseCsvUseCase;
  readonly extractExpenseReceipt: ExtractReceiptUseCase;
  readonly checkExpenseClaims: CheckExpenseClaimsUseCase;
  readonly acknowledgeExpenseReason: AcknowledgeExpenseReasonUseCase;
  readonly getExpenseReturnDraft: GetReturnDraftUseCase;
  readonly returnExpenseClaim: ReturnExpenseClaimUseCase;
  readonly approveExpenseClaim: ApproveExpenseClaimUseCase;
  readonly unapproveExpenseClaim: UnapproveExpenseClaimUseCase;
  readonly describeExpenseApproval: DescribeExpenseApprovalUseCase;
  readonly draftExpenseJournalEntries: DraftJournalEntriesUseCase;
  readonly exportExpenseSettlement: ExportExpenseSettlementUseCase;
  readonly settleExpenseClaims: SettleExpenseClaimsUseCase;
  /** LLM 機能の可否（`GET /runtime/capabilities` の `expense`）。 */
  readonly expenseCapabilities: ExpenseCapabilitiesUseCase;
}

/** 仕訳の読取ユースケースを経費の読取ポートとして包む（`hintKind` は渡さない。経費だからと種別を決めつけると分類がずれる）。 */
export function journalReceiptReader(journal: Pick<JournalAppFeature, 'extractJournalDocument'>): ReceiptReaderPort {
  return {
    async read(input, signal) {
      const result = await journal.extractJournalDocument.execute({
        images: input.images,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      }, signal);
      return {
        documentKind: result.kind,
        facts: result.facts,
        warnings: result.extraction.warnings,
        ...(result.extraction.confidence === undefined ? {} : { confidence: result.extraction.confidence }),
        ...(result.extraction.model === undefined ? {} : { model: result.extraction.model }),
      };
    },
  };
}

/** 仕訳の保存ユースケースを経費の下書きの受け口として包む。仕訳の不変条件違反は「拒否」に言い換える。 */
export function journalDraftSink(journal: Pick<JournalAppFeature, 'saveJournalEntry'>): JournalDraftSink {
  return {
    async createDraft(scope, draft) {
      try {
        const entry = await journal.saveJournalEntry.execute({
          scope,
          date: draft.date,
          description: draft.description,
          invoiceStatus: draft.invoiceStatus,
          ...(draft.registrationNumber === undefined ? {} : { registrationNumber: draft.registrationNumber }),
          // accountName は SaveJournalEntryUseCase が科目マスタから必ず写し直す（クライアント申告を採らない設計）。
          // 部門の補助軸（dimensionValues）は行に載っていればそのまま写る（§20.12）。
          lines: draft.lines.map((line) => ({ ...line, accountName: '' })),
          tags: draft.tags,
          // 既存の値域に経費は無いので manual。出所は tags で表す（仕訳側の変更を要しない）。
          decidedBy: 'manual',
        });
        return { entryId: entry.id };
      } catch (error) {
        if (error instanceof JournalDomainError) throw new JournalDraftRejectedError(error.message);
        throw error;
      }
    },
  };
}

/** 仕訳の科目マスタの取得を、経費の読み取りポートとして包む（部門の補助軸の値の照合）。 */
export function journalChartReader(journal: Pick<JournalAppFeature, 'getJournalChart'>): JournalChartReadPort {
  return {
    async read(scope) {
      const { chart } = await journal.getJournalChart.execute(scope);
      return {
        accounts: chart.accounts.map((account) => ({ id: account.id, name: account.name, enabled: account.enabled })),
        dimensions: chart.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, values: dimension.values.map((value) => ({ id: value.id, name: value.name, enabled: value.enabled })) })),
      };
    },
  };
}

export function composeExpense(context: BusinessCompositionContext, dependencies: ExpenseCompositionDependencies): BusinessComposition<ExpenseAppFeature> {
  const { unitOfWork, errorLogger } = context;
  const policyRepo = context.pickRepository<ExpensePolicyRepository>((db) => new SqliteExpensePolicyRepository(db), () => new InMemoryExpensePolicyRepository());
  const claimRepo = context.pickRepository<ExpenseClaimRepository>((db) => new SqliteExpenseClaimRepository(db), () => new InMemoryExpenseClaimRepository());
  const receiptRepo = context.pickRepository<ExpenseReceiptRepository>((db) => new SqliteExpenseReceiptRepository(db), () => new InMemoryExpenseReceiptRepository());
  const employeeRepo = context.pickRepository<ExpenseEmployeeRepository>((db) => new SqliteExpenseEmployeeRepository(db), () => new InMemoryExpenseEmployeeRepository());
  const settingsRepo = context.pickRepository<ExpenseSettingsRepository>((db) => new SqliteExpenseSettingsRepository(db), () => new InMemoryExpenseSettingsRepository());
  const advanceRepo = context.pickRepository<ExpenseAdvanceRepository>((db) => new SqliteExpenseAdvanceRepository(db), () => new InMemoryExpenseAdvanceRepository());
  const cardRepo = context.pickRepository<ExpenseCardRepository>((db) => new SqliteExpenseCardRepository(db), () => new InMemoryExpenseCardRepository());
  const payoutRepo = context.pickRepository<ExpensePayoutBatchRepository>((db) => new SqliteExpensePayoutBatchRepository(db), () => new InMemoryExpensePayoutBatchRepository());
  const hearingRepo = context.pickRepository<ExpensePolicyHearingRepository>((db) => new SqliteExpensePolicyHearingRepository(db), () => new InMemoryExpensePolicyHearingRepository());

  const settings = new ExpenseSettingsStore(settingsRepo);
  const organization = organizationReader(settings);
  const employeeDirectory: EmployeeDirectoryPort = employeeRepo;
  const journalDrafts = journalDraftSink(dependencies.journal);
  const journalChart = journalChartReader(dependencies.journal);
  const core: ExpenseCoreServices = {
    context,
    journal: dependencies.journal,
    repositories: { policies: policyRepo, claims: claimRepo, receipts: receiptRepo, employees: employeeRepo, settings: settingsRepo, advances: advanceRepo, cards: cardRepo, payouts: payoutRepo, hearings: hearingRepo },
    settings,
    employeeDirectory,
    organization,
    // 文脈に鍵が無い構成（業務の文脈を直接組むテスト）だけ揮発鍵。本番の root は常にモデル設定と同じ鍵を渡す。
    cipher: context.secretCipher ?? AesGcmSecretCipher.ephemeral(),
    unitOfWork,
    journalDrafts,
    journalChart,
    now: () => new Date(),
    timeZone: DEFAULT_BUSINESS_TIME_ZONE,
  };
  const people = composeExpensePeople(core);
  const money = composeExpenseMoney(core);
  const input = composeExpenseInput(core);
  const factsProviders = [people.checkFacts, money.checkFacts, input.checkFacts];
  const planner = people.approvalPlanner;

  // 取込タブとツールで同じ 1 つを使う（読み取りの規則を 2 か所に分けない）。
  const extractExpenseReceipt = new ExtractReceiptUseCase(journalReceiptReader(dependencies.journal), policyRepo, input.detailReader);

  /** LLM 機能の可否。読取は仕訳と同じ判定（構造化出力が要り、画像は vision も）で、test プロファイルは使えない側へ倒す。 */
  const capabilitiesResolver = async (): Promise<ExpenseCapabilities> => {
    if (context.profile === 'test') return EXPENSE_CAPABILITIES_DISABLED;
    if (!await context.mainModelConfigured()) return EXPENSE_CAPABILITIES_DISABLED;
    const capabilities = await context.mainModelCapabilities();
    const structured = capabilities.includes('structured-output');
    const [detail, hearing] = await Promise.all([input.detailReader.available(), input.policyHearingAvailable()]);
    return {
      extraction: { enabled: structured, vision: structured && capabilities.includes('vision') },
      detailExtraction: { enabled: detail },
      policyHearing: { enabled: hearing },
    };
  };

  const rowSources = [
    ...expenseRowSources({
      receiptCheck: new ExpenseReceiptCheckRowsProvider(extractExpenseReceipt, policyRepo, claimRepo),
      claims: new ExpenseClaimRowsProvider(claimRepo, policyRepo),
      policy: new ExpensePolicyRowsProvider(policyRepo),
    }),
    ...people.rowSources,
    ...money.rowSources,
    ...input.rowSources,
  ];

  const claimants = new ClaimantResolver(employeeDirectory, organization);
  return {
    rowSources,
    feature: {
      ...people.feature,
      ...money.feature,
      ...input.feature,
      expensePolicyRepo: policyRepo,
      expenseClaimRepo: claimRepo,
      expenseReceiptRepo: receiptRepo,
      expenseEmployeeRepo: employeeRepo,
      expenseSettingsRepo: settingsRepo,
      expenseAdvanceRepo: advanceRepo,
      expenseCardRepo: cardRepo,
      expensePayoutBatchRepo: payoutRepo,
      expensePolicyHearingRepo: hearingRepo,
      expenseEmployeeDirectory: employeeDirectory,
      getExpensePolicy: new GetExpensePolicyUseCase(policyRepo),
      saveExpensePolicy: new SaveExpensePolicyUseCase(policyRepo),
      resetExpensePolicy: new ResetExpensePolicyUseCase(policyRepo),
      exportExpensePolicyCsv: new ExportExpensePolicyCsvUseCase(policyRepo),
      importExpensePolicyCsv: new ImportExpensePolicyCsvUseCase(policyRepo),
      listExpenseClaims: new ListExpenseClaimsUseCase(claimRepo, policyRepo),
      createExpenseClaim: new CreateExpenseClaimUseCase(claimRepo, undefined, undefined, claimants),
      getExpenseClaim: new GetExpenseClaimUseCase(claimRepo),
      updateExpenseClaim: new UpdateExpenseClaimUseCase(claimRepo, receiptRepo, undefined, claimants),
      deleteExpenseClaim: new DeleteExpenseClaimUseCase(claimRepo, receiptRepo, unitOfWork, cardRepo),
      saveExpenseItem: new SaveExpenseItemUseCase(claimRepo, receiptRepo, policyRepo, unitOfWork),
      deleteExpenseItem: new DeleteExpenseItemUseCase(claimRepo, receiptRepo, unitOfWork),
      getExpenseReceipt: new GetExpenseReceiptUseCase(claimRepo, receiptRepo),
      importExpenseCsv: new ImportExpenseCsvUseCase(claimRepo, receiptRepo, policyRepo, unitOfWork, undefined, undefined, undefined, { directory: employeeDirectory, claimants }),
      extractExpenseReceipt,
      checkExpenseClaims: new CheckExpenseClaimsUseCase(claimRepo, receiptRepo, policyRepo, undefined, undefined, factsProviders, planner),
      acknowledgeExpenseReason: new AcknowledgeExpenseReasonUseCase(claimRepo, receiptRepo),
      getExpenseReturnDraft: new GetReturnDraftUseCase(claimRepo),
      returnExpenseClaim: new ReturnExpenseClaimUseCase(claimRepo, receiptRepo),
      approveExpenseClaim: new ApproveExpenseClaimUseCase(claimRepo, receiptRepo, policyRepo, undefined, planner),
      unapproveExpenseClaim: new UnapproveExpenseClaimUseCase(claimRepo, receiptRepo, undefined, advanceRepo),
      describeExpenseApproval: new DescribeExpenseApprovalUseCase(policyRepo, planner),
      draftExpenseJournalEntries: new DraftJournalEntriesUseCase(claimRepo, receiptRepo, policyRepo, journalDrafts, undefined, organization, journalChart),
      exportExpenseSettlement: new ExportExpenseSettlementUseCase(claimRepo, policyRepo),
      settleExpenseClaims: new SettleExpenseClaimsUseCase(claimRepo, receiptRepo, unitOfWork),
      expenseCapabilities: new ExpenseCapabilitiesUseCase(capabilitiesResolver, errorLogger),
    },
  };
}

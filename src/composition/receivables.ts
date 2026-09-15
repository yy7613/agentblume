/**
 * Composition: 入金消込（docs/22-receivables.md）の組み立て。
 *
 * リポジトリの選択（SQLite / InMemory）・ユースケース・行ソース（`receivables-*` ノード）・機能フラグをここで組み、
 * `root.ts` へは `ReceivablesAppFeature` と行ソースだけを返す（ADR-0039）。
 *
 * **仕訳への橋渡しはここだけ**（ADR-0041 決定 5）。receivables の application は仕訳の application を import せず、
 * ポート `JournalDraftSink` / `OrderDocumentReaderPort` を定義するだけにしてある。ここで組み立て済みの仕訳
 * （`dependencies.journal`）のユースケースを包んで注入する。仕訳のリポジトリを作り直さないのは、test プロファイルの
 * InMemory の保管庫が別になり、作った下書きが仕訳から見えなくなるため。
 */
import {
  InMemoryBankCsvProfileRepository, InMemoryBankTransactionRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository,
  InMemoryMatchingRepository, InMemoryReceivablesSettingsRepository,
} from '../adapters/storage/in-memory-receivables-repositories';
import {
  SqliteBankCsvProfileRepository, SqliteBankTransactionRepository, SqliteCustomerRepository, SqliteInvoiceRepository,
  SqliteMatchingRepository, SqliteReceivablesSettingsRepository,
} from '../adapters/storage/sqlite-receivables-repositories';
import { JournalExtractionUnavailableError } from '../application/journal/errors';
import { ReceivablesCapabilitiesUseCase } from '../application/receivables/capabilities';
import { ReceivablesExtractionUnavailableError } from '../application/receivables/errors';
import { ImportBankCsvUseCase, PreviewBankCsvUseCase } from '../application/receivables/import-bank-csv';
import { JudgeTransactionsUseCase, MatchCandidatesUseCase } from '../application/receivables/judge-transactions';
import { DeleteBankCsvProfileUseCase, ListBankCsvProfilesUseCase, SaveBankCsvProfileUseCase } from '../application/receivables/manage-bank-csv-profiles';
import { DeleteCustomerUseCase, GetCustomerUseCase, ListCustomersUseCase, SaveCustomerUseCase } from '../application/receivables/manage-customers';
import {
  CheckInvoiceUseCase, CreateInvoiceDraftUseCase, DeleteInvoiceDraftUseCase, DuplicateInvoiceUseCase, GetInvoiceUseCase,
  IssueInvoiceUseCase, ListInvoicesUseCase, UpdateInvoiceDraftUseCase, VoidInvoiceUseCase,
} from '../application/receivables/manage-invoices';
import {
  CancelMatchingUseCase, ConfirmDecidedMatchingsUseCase, ConfirmMatchingUseCase, DeleteBankTransactionUseCase, IgnoreTransactionUseCase,
  ListBankTransactionsUseCase, ListMatchingsUseCase, UnignoreTransactionUseCase,
} from '../application/receivables/manage-matchings';
import { GetReceivablesSettingsUseCase, SaveReceivablesSettingsUseCase } from '../application/receivables/manage-settings';
import type { JournalDraftSink, OrderDocumentReaderPort } from '../application/receivables/ports';
import { receivablesRowSources } from '../application/receivables/row-sources';
import { InvoiceDraftRowsProvider, MatchCandidateRowsProvider, OutstandingInvoiceRowsProvider } from '../application/receivables/rows';
import { findAccount, findTaxCategory } from '../domain/journal/chart-of-accounts';
import type {
  BankCsvProfileRepository, BankTransactionRepository, CustomerRepository, InvoiceRepository, MatchingRepository, ReceivablesSettingsRepository,
} from '../domain/receivables/repositories';
import type { BusinessComposition, BusinessCompositionContext } from './business';
import type { JournalAppFeature } from './journal';

/** 仕訳の組み立て結果。仕訳下書き・帳票読取を同じ保管庫へ繋ぐため（test プロファイルの InMemory を共有する）。 */
export interface ReceivablesCompositionDependencies {
  readonly journal: JournalAppFeature;
}

/** App のうち入金消込の部分（キーは `receivables` で始める）。 */
export interface ReceivablesAppFeature {
  readonly getReceivablesSettings: GetReceivablesSettingsUseCase;
  readonly saveReceivablesSettings: SaveReceivablesSettingsUseCase;
  readonly listReceivablesCustomers: ListCustomersUseCase;
  readonly getReceivablesCustomer: GetCustomerUseCase;
  readonly saveReceivablesCustomer: SaveCustomerUseCase;
  readonly deleteReceivablesCustomer: DeleteCustomerUseCase;
  readonly checkReceivablesInvoice: CheckInvoiceUseCase;
  readonly createReceivablesInvoice: CreateInvoiceDraftUseCase;
  readonly updateReceivablesInvoice: UpdateInvoiceDraftUseCase;
  readonly getReceivablesInvoice: GetInvoiceUseCase;
  readonly listReceivablesInvoices: ListInvoicesUseCase;
  readonly deleteReceivablesInvoice: DeleteInvoiceDraftUseCase;
  readonly issueReceivablesInvoice: IssueInvoiceUseCase;
  readonly voidReceivablesInvoice: VoidInvoiceUseCase;
  readonly duplicateReceivablesInvoice: DuplicateInvoiceUseCase;
  readonly listReceivablesBankCsvProfiles: ListBankCsvProfilesUseCase;
  readonly saveReceivablesBankCsvProfile: SaveBankCsvProfileUseCase;
  readonly deleteReceivablesBankCsvProfile: DeleteBankCsvProfileUseCase;
  readonly previewReceivablesBankCsv: PreviewBankCsvUseCase;
  readonly importReceivablesBankCsv: ImportBankCsvUseCase;
  readonly listReceivablesBankTransactions: ListBankTransactionsUseCase;
  readonly deleteReceivablesBankTransaction: DeleteBankTransactionUseCase;
  readonly ignoreReceivablesBankTransaction: IgnoreTransactionUseCase;
  readonly unignoreReceivablesBankTransaction: UnignoreTransactionUseCase;
  readonly judgeReceivablesTransactions: JudgeTransactionsUseCase;
  readonly receivablesMatchCandidates: MatchCandidatesUseCase;
  readonly confirmReceivablesMatching: ConfirmMatchingUseCase;
  readonly confirmReceivablesDecidedMatchings: ConfirmDecidedMatchingsUseCase;
  readonly cancelReceivablesMatching: CancelMatchingUseCase;
  readonly listReceivablesMatchings: ListMatchingsUseCase;
  /** 注文書・見積書の読み取りの可否（`GET /runtime/capabilities` の `receivables`）。 */
  readonly receivablesCapabilities: ReceivablesCapabilitiesUseCase;
}

/**
 * `JournalDraftSink` の実装（docs/22 §6.2）。仕訳の既存ユースケースだけで作る。
 *
 * `SaveJournalEntryUseCase` は既存 id の更新で**状態を保ったまま中身を差し替える**ので、利用者が確認・出力した仕訳を
 * 上書きしないための確認（`draft` 以外は書かずに kept）はこのアダプタの責務にする。
 */
export function createJournalDraftSink(journal: Pick<JournalAppFeature, 'getJournalChart' | 'journalEntryRepo' | 'saveJournalEntry' | 'deleteJournalEntry'>): JournalDraftSink {
  return {
    async checkAccounts(scope, refs) {
      // 未保存なら標準セット（仕訳の画面と同じ規律）。
      const { chart } = await journal.getJournalChart.execute(scope);
      return [
        ...refs.accountIds.filter((id) => findAccount(chart, id)?.enabled !== true).map((id) => ({ kind: 'account' as const, id })),
        ...refs.taxCodes.filter((code) => findTaxCategory(chart, code)?.enabled !== true).map((id) => ({ kind: 'tax' as const, id })),
      ];
    },
    async taxRateOf(scope, taxCode) {
      const { chart } = await journal.getJournalChart.execute(scope);
      return findTaxCategory(chart, taxCode)?.rate;
    },
    async upsertDraft(scope, request) {
      const existing = request.existingEntryId === undefined ? null : await journal.journalEntryRepo.findById(scope, request.existingEntryId);
      if (existing !== null && existing.status !== 'draft') return { status: 'kept', entryId: existing.id, entryStatus: existing.status };
      const saved = await journal.saveJournalEntry.execute({
        scope,
        ...(existing === null ? {} : { id: existing.id }),
        date: request.date,
        // 科目名はユースケースがマスタから写し直すので空で渡す。
        lines: request.lines.map((line) => ({ ...line, accountName: '' })),
        description: request.description,
        // 発行側の売上・入金なので仕入税額控除の区分は要らない（仕訳の `direction: 'in'` と同じ扱い）。
        invoiceStatus: 'not_required',
        tags: request.tags,
        // 仕訳に「連携」を表す値が無いので manual。出所はタグで示す（docs/22 §14 の任意の要求）。
        decidedBy: 'manual',
      });
      return { status: existing === null ? 'created' : 'updated', entryId: saved.id };
    },
    async discardDraft(scope, entryId) {
      const existing = await journal.journalEntryRepo.findById(scope, entryId);
      if (existing === null) return 'not-found';
      if (existing.status !== 'draft') return 'kept';
      await journal.deleteJournalEntry.execute(scope, entryId);
      return 'deleted';
    },
  };
}

/** `OrderDocumentReaderPort` の実装。仕訳の vision 読取（正規化・整合チェック込み）を見積書のヒントで 1 枚ずつ呼ぶ。 */
export function createOrderDocumentReader(journal: Pick<JournalAppFeature, 'extractJournalDocument'>): OrderDocumentReaderPort {
  return {
    async read({ image, fileName }) {
      let result;
      try {
        result = await journal.extractJournalDocument.execute({ images: [image], fileName, hintKind: 'quotation' });
      } catch (error) {
        // 利用者が設定画面で直せる理由は、入金消込のエラーとして包み直す（ツールの失敗文言を業務側で持つため）。
        if (error instanceof JournalExtractionUnavailableError) throw new ReceivablesExtractionUnavailableError(error.message);
        throw error;
      }
      const { facts } = result;
      return {
        ...(facts.issuerName === undefined ? {} : { issuerName: facts.issuerName }),
        ...(facts.recipientName === undefined ? {} : { recipientName: facts.recipientName }),
        ...(facts.registrationNumber === undefined ? {} : { registrationNumber: facts.registrationNumber }),
        ...(facts.issueDate === undefined ? {} : { issueDate: facts.issueDate }),
        ...(facts.transactionDate === undefined ? {} : { transactionDate: facts.transactionDate }),
        ...(facts.dueDate === undefined ? {} : { dueDate: facts.dueDate }),
        ...(facts.grandTotal === undefined ? {} : { grandTotal: facts.grandTotal }),
        ...(facts.totalsByRate === undefined ? {} : { totalsByRate: facts.totalsByRate }),
        lines: (facts.lines ?? []).map((line) => ({
          description: line.description,
          ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
          ...(line.unitPrice === undefined ? {} : { unitPrice: line.unitPrice }),
          amount: line.amount,
          ...(line.taxRate === undefined ? {} : { taxRate: line.taxRate }),
        })),
        warnings: result.extraction.warnings,
      };
    },
  };
}

export function composeReceivables(context: BusinessCompositionContext, dependencies: ReceivablesCompositionDependencies): BusinessComposition<ReceivablesAppFeature> {
  const { journal } = dependencies;
  // 入金消込（v7）: 6 つの集約。取引先の別名は record_json に同梱する。
  const settingsRepo = context.pickRepository<ReceivablesSettingsRepository>((db) => new SqliteReceivablesSettingsRepository(db), () => new InMemoryReceivablesSettingsRepository());
  const customerRepo = context.pickRepository<CustomerRepository>((db) => new SqliteCustomerRepository(db), () => new InMemoryCustomerRepository());
  const invoiceRepo = context.pickRepository<InvoiceRepository>((db) => new SqliteInvoiceRepository(db), () => new InMemoryInvoiceRepository());
  const profileRepo = context.pickRepository<BankCsvProfileRepository>((db) => new SqliteBankCsvProfileRepository(db), () => new InMemoryBankCsvProfileRepository());
  const transactionRepo = context.pickRepository<BankTransactionRepository>((db) => new SqliteBankTransactionRepository(db), () => new InMemoryBankTransactionRepository());
  const matchingRepo = context.pickRepository<MatchingRepository>((db) => new SqliteMatchingRepository(db), () => new InMemoryMatchingRepository());

  const sink = createJournalDraftSink(journal);
  const reader = createOrderDocumentReader(journal);
  const readers = { settings: settingsRepo, customers: customerRepo, invoices: invoiceRepo, transactions: transactionRepo };
  const invoiceDeps = { invoices: invoiceRepo, customers: customerRepo, settings: settingsRepo, matchings: matchingRepo, journal: sink, unitOfWork: context.unitOfWork };
  const matchingDeps = { ...readers, matchings: matchingRepo, journal: sink, unitOfWork: context.unitOfWork };
  const confirm = new ConfirmMatchingUseCase(matchingDeps);

  const rowSources = receivablesRowSources({
    outstanding: new OutstandingInvoiceRowsProvider(invoiceRepo, customerRepo, matchingRepo, transactionRepo),
    matchCandidates: new MatchCandidateRowsProvider(readers),
    invoiceDraft: new InvoiceDraftRowsProvider(reader, settingsRepo, customerRepo),
  });

  return {
    rowSources,
    feature: {
      getReceivablesSettings: new GetReceivablesSettingsUseCase(settingsRepo),
      saveReceivablesSettings: new SaveReceivablesSettingsUseCase(settingsRepo),
      listReceivablesCustomers: new ListCustomersUseCase(customerRepo, invoiceRepo),
      getReceivablesCustomer: new GetCustomerUseCase(customerRepo),
      saveReceivablesCustomer: new SaveCustomerUseCase(customerRepo),
      deleteReceivablesCustomer: new DeleteCustomerUseCase(customerRepo, invoiceRepo),
      checkReceivablesInvoice: new CheckInvoiceUseCase(invoiceDeps),
      createReceivablesInvoice: new CreateInvoiceDraftUseCase(invoiceDeps),
      updateReceivablesInvoice: new UpdateInvoiceDraftUseCase(invoiceDeps),
      getReceivablesInvoice: new GetInvoiceUseCase(invoiceDeps),
      listReceivablesInvoices: new ListInvoicesUseCase(invoiceDeps),
      deleteReceivablesInvoice: new DeleteInvoiceDraftUseCase(invoiceDeps),
      issueReceivablesInvoice: new IssueInvoiceUseCase(invoiceDeps),
      voidReceivablesInvoice: new VoidInvoiceUseCase(invoiceDeps),
      duplicateReceivablesInvoice: new DuplicateInvoiceUseCase(invoiceDeps),
      listReceivablesBankCsvProfiles: new ListBankCsvProfilesUseCase(profileRepo),
      saveReceivablesBankCsvProfile: new SaveBankCsvProfileUseCase(profileRepo),
      deleteReceivablesBankCsvProfile: new DeleteBankCsvProfileUseCase(profileRepo),
      previewReceivablesBankCsv: new PreviewBankCsvUseCase(profileRepo),
      importReceivablesBankCsv: new ImportBankCsvUseCase(profileRepo, transactionRepo),
      listReceivablesBankTransactions: new ListBankTransactionsUseCase(transactionRepo),
      deleteReceivablesBankTransaction: new DeleteBankTransactionUseCase(transactionRepo),
      ignoreReceivablesBankTransaction: new IgnoreTransactionUseCase(transactionRepo),
      unignoreReceivablesBankTransaction: new UnignoreTransactionUseCase(transactionRepo),
      judgeReceivablesTransactions: new JudgeTransactionsUseCase(readers),
      receivablesMatchCandidates: new MatchCandidatesUseCase(readers),
      confirmReceivablesMatching: confirm,
      confirmReceivablesDecidedMatchings: new ConfirmDecidedMatchingsUseCase(transactionRepo, confirm),
      cancelReceivablesMatching: new CancelMatchingUseCase(matchingDeps),
      listReceivablesMatchings: new ListMatchingsUseCase(matchingRepo),
      // 読み取りは仕訳の抽出と同じモデル・同じ判定（test プロファイルでは仕訳側が「使えない」に倒す）。
      receivablesCapabilities: new ReceivablesCapabilitiesUseCase(async () => {
        const capabilities = await journal.journalCapabilities.execute();
        return { invoiceDraft: { enabled: capabilities.extraction.enabled, vision: capabilities.extraction.vision } };
      }, context.errorLogger),
    },
  };
}

/**
 * adapters層: 入金消込 BC の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 仕訳の InMemory 実装と同じく、保存も読み出しも `structuredClone` する（SQLite が JSON を経由するのと挙動を揃える）。
 * 並びと一意性（請求書番号・明細の指紋）は SQLite 側の索引と同じ結果にする。比較関数は SQLite 実装も使う。
 */
import type { BankCsvProfile } from '../../domain/receivables/bank-csv-profile';
import type { BankTransaction } from '../../domain/receivables/bank-transaction';
import type { Customer } from '../../domain/receivables/customer';
import type { Invoice } from '../../domain/receivables/invoice';
import type { Matching } from '../../domain/receivables/matching-aggregate';
import type {
  BankCsvProfileRepository, BankTransactionListOptions, BankTransactionRepository, CustomerListOptions, CustomerRepository,
  InvoiceListOptions, InvoiceRepository, MatchingListOptions, MatchingRepository, ReceivablesSettingsRepository,
} from '../../domain/receivables/repositories';
import type { ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';

const scopeKey = (scope: TenantScope) => `${scope.tenantId}\u0000${scope.workspaceId}`;
const key = (scope: TenantScope, id: string) => `${scopeKey(scope)}\u0000${id}`;
const inScope = (item: { readonly tenant?: TenantScope }, scope: TenantScope) => item.tenant?.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** 名前 昇順 → id 昇順。 */
export const compareCustomers = (left: Customer, right: Customer) => compareText(left.name, right.name) || compareText(left.id, right.id);
/** 作成日時 降順 → id 昇順。 */
export const compareInvoices = (left: Invoice, right: Invoice) => compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id);
/** 更新日時 降順 → id 昇順。 */
export const compareProfiles = (left: BankCsvProfile, right: BankCsvProfile) => compareText(right.updatedAt, left.updatedAt) || compareText(left.id, right.id);
/** 入金日 昇順 → 作成日時 昇順 → id 昇順。 */
export const compareTransactions = (left: BankTransaction, right: BankTransaction) => compareText(left.date, right.date) || compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
/** 確定日時 降順 → id 昇順。 */
export const compareMatchings = (left: Matching, right: Matching) => compareText(right.confirmedAt, left.confirmedAt) || compareText(left.id, right.id);

export class InMemoryReceivablesSettingsRepository implements ReceivablesSettingsRepository {
  private readonly store = new Map<string, ReceivablesSettings>();
  async get(scope: TenantScope): Promise<ReceivablesSettings | null> {
    const found = this.store.get(scopeKey(scope));
    return found === undefined ? null : structuredClone(found);
  }
  async save(scope: TenantScope, settings: ReceivablesSettings): Promise<void> { this.store.set(scopeKey(scope), structuredClone(settings)); }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly store = new Map<string, Customer>();
  async save(customer: Customer): Promise<void> { this.store.set(key(customer.tenant, customer.id), structuredClone(customer)); }
  async findById(scope: TenantScope, id: string): Promise<Customer | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope, options?: CustomerListOptions): Promise<readonly Customer[]> {
    return [...this.store.values()]
      .filter((customer) => inScope(customer, scope) && (options?.enabled === undefined || customer.enabled === options.enabled))
      .sort(compareCustomers).map((customer) => structuredClone(customer));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly store = new Map<string, Invoice>();
  private readonly sequences = new Map<string, number>();

  async save(invoice: Invoice): Promise<void> {
    if (invoice.number !== undefined) {
      const clash = [...this.store.values()].find((other) => inScope(other, invoice.tenant) && other.id !== invoice.id && other.number === invoice.number);
      if (clash !== undefined) throw new Error(`UNIQUE constraint failed: receivables_invoices.invoice_number (${invoice.number})`);
    }
    this.store.set(key(invoice.tenant, invoice.id), structuredClone(invoice));
  }
  async findById(scope: TenantScope, id: string): Promise<Invoice | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly Invoice[]> {
    return ids.map((id) => this.store.get(key(scope, id))).filter((invoice): invoice is Invoice => invoice !== undefined).map((invoice) => structuredClone(invoice));
  }
  async list(scope: TenantScope, options?: InvoiceListOptions): Promise<readonly Invoice[]> {
    return [...this.store.values()].filter((invoice) => {
      if (!inScope(invoice, scope)) return false;
      if (options?.statuses !== undefined && !options.statuses.includes(invoice.status)) return false;
      if (options?.customerId !== undefined && invoice.customerId !== options.customerId) return false;
      if ((options?.from !== undefined || options?.to !== undefined) && invoice.issueDate === undefined) return false;
      if (options?.from !== undefined && invoice.issueDate! < options.from) return false;
      if (options?.to !== undefined && invoice.issueDate! > options.to) return false;
      if (options?.dueBefore !== undefined && (invoice.dueDate === undefined || invoice.dueDate >= options.dueBefore)) return false;
      return true;
    }).sort(compareInvoices).map((invoice) => structuredClone(invoice));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
  async nextNumber(scope: TenantScope, seriesKey: string): Promise<number> {
    const sequenceKey = key(scope, seriesKey);
    const next = this.sequences.get(sequenceKey) ?? 1;
    this.sequences.set(sequenceKey, next + 1);
    return next;
  }
}

export class InMemoryBankCsvProfileRepository implements BankCsvProfileRepository {
  private readonly store = new Map<string, BankCsvProfile>();
  async save(profile: BankCsvProfile): Promise<void> { this.store.set(key(profile.tenant!, profile.id), structuredClone(profile)); }
  async findById(scope: TenantScope, id: string): Promise<BankCsvProfile | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope): Promise<readonly BankCsvProfile[]> {
    return [...this.store.values()].filter((profile) => inScope(profile, scope)).sort(compareProfiles).map((profile) => structuredClone(profile));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
}

export class InMemoryBankTransactionRepository implements BankTransactionRepository {
  private readonly store = new Map<string, BankTransaction>();
  async save(transaction: BankTransaction): Promise<void> {
    const clash = [...this.store.values()].find((other) => inScope(other, transaction.tenant) && other.id !== transaction.id && other.fingerprint === transaction.fingerprint);
    if (clash !== undefined) throw new Error(`UNIQUE constraint failed: receivables_bank_transactions.fingerprint (${transaction.fingerprint})`);
    this.store.set(key(transaction.tenant, transaction.id), structuredClone(transaction));
  }
  async findById(scope: TenantScope, id: string): Promise<BankTransaction | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async findByFingerprints(scope: TenantScope, fingerprints: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const wanted = new Set(fingerprints);
    return new Map([...this.store.values()].filter((transaction) => inScope(transaction, scope) && wanted.has(transaction.fingerprint)).map((transaction) => [transaction.fingerprint, transaction.id]));
  }
  async list(scope: TenantScope, options?: BankTransactionListOptions): Promise<readonly BankTransaction[]> {
    const ids = options?.ids === undefined ? undefined : new Set(options.ids);
    const matched = [...this.store.values()].filter((transaction) => {
      if (!inScope(transaction, scope)) return false;
      if (options?.status !== undefined && transaction.status !== options.status) return false;
      if (options?.accountKey !== undefined && transaction.accountKey !== options.accountKey) return false;
      if (options?.from !== undefined && transaction.date < options.from) return false;
      if (options?.to !== undefined && transaction.date > options.to) return false;
      return ids === undefined || ids.has(transaction.id);
    }).sort(compareTransactions).map((transaction) => structuredClone(transaction));
    return options?.limit === undefined ? matched : matched.slice(0, options.limit);
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
}

export class InMemoryMatchingRepository implements MatchingRepository {
  private readonly store = new Map<string, Matching>();
  async save(matching: Matching): Promise<void> { this.store.set(key(matching.tenant, matching.id), structuredClone(matching)); }
  async findById(scope: TenantScope, id: string): Promise<Matching | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope, options?: MatchingListOptions): Promise<readonly Matching[]> {
    return [...this.store.values()].filter((matching) => {
      if (!inScope(matching, scope)) return false;
      if (options?.status !== undefined && matching.status !== options.status) return false;
      if (options?.transactionId !== undefined && matching.transactionId !== options.transactionId) return false;
      return options?.invoiceId === undefined || matching.allocations.some((allocation) => allocation.invoiceId === options.invoiceId);
    }).sort(compareMatchings).map((matching) => structuredClone(matching));
  }
}

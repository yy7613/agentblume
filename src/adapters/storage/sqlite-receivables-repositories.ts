/**
 * adapters層: 入金消込 BC の SQLite 永続化（テーブル定義は `receivables-migrations.ts` の version 7）。
 *
 * 本体は `record_json`（domain の Serialized 型）で、絞り込み・並び・一意性に使う値だけを列に出す。
 * 復元は必ず `deserialize*` を通す（壊れた行は黙って null にせず `ReceivablesDomainError` で失敗させる）。
 * 列に無い並び（取引先の名前順）は読み出し後に InMemory と同じ比較関数で並べる（共有契約テストが結果の一致を検査する）。
 */
import type { BankCsvProfile } from '../../domain/receivables/bank-csv-profile';
import type { BankTransaction } from '../../domain/receivables/bank-transaction';
import type { Customer } from '../../domain/receivables/customer';
import { invoiceOutstanding, type Invoice } from '../../domain/receivables/invoice';
import type { Matching } from '../../domain/receivables/matching-aggregate';
import type {
  BankCsvProfileRepository, BankTransactionListOptions, BankTransactionRepository, CustomerListOptions, CustomerRepository,
  InvoiceListOptions, InvoiceRepository, MatchingListOptions, MatchingRepository, ReceivablesSettingsRepository,
} from '../../domain/receivables/repositories';
import {
  deserializeBankCsvProfile, deserializeBankTransaction, deserializeCustomer, deserializeInvoice, deserializeMatching,
  deserializeReceivablesSettings, serializeBankCsvProfile, serializeBankTransaction, serializeCustomer, serializeInvoice,
  serializeMatching, serializeReceivablesSettings,
} from '../../domain/receivables/serialization';
import type { ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { compareCustomers } from './in-memory-receivables-repositories';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, deserialize: (raw: unknown) => T): T => deserialize(JSON.parse(String(value)));
const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

export class SqliteReceivablesSettingsRepository extends SqliteRepositoryBase implements ReceivablesSettingsRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async get(scope: TenantScope): Promise<ReceivablesSettings | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_settings WHERE tenant_id=? AND workspace_id=?`).get(scope.tenantId, scope.workspaceId);
    return row === undefined ? null : parse(row['record_json'], deserializeReceivablesSettings);
  }
  async save(scope: TenantScope, settings: ReceivablesSettings): Promise<void> {
    this.db.prepare(`INSERT INTO receivables_settings (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET record_json=excluded.record_json`).run(scope.tenantId, scope.workspaceId, json(serializeReceivablesSettings(settings)));
  }
}

export class SqliteCustomerRepository extends SqliteRepositoryBase implements CustomerRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async save(customer: Customer): Promise<void> {
    this.db.prepare(`INSERT INTO receivables_customers (tenant_id, workspace_id, id, enabled, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET enabled=excluded.enabled, created_at=excluded.created_at, record_json=excluded.record_json`)
      .run(customer.tenant.tenantId, customer.tenant.workspaceId, customer.id, customer.enabled ? 1 : 0, customer.createdAt, json(serializeCustomer(customer)));
  }
  async findById(scope: TenantScope, id: string): Promise<Customer | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_customers WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeCustomer);
  }
  async list(scope: TenantScope, options?: CustomerListOptions): Promise<readonly Customer[]> {
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    let sql = `SELECT record_json FROM receivables_customers WHERE tenant_id=? AND workspace_id=?`;
    if (options?.enabled !== undefined) { sql += ' AND enabled=?'; params.push(options.enabled ? 1 : 0); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeCustomer)).sort(compareCustomers);
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM receivables_customers WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
}

export class SqliteInvoiceRepository extends SqliteRepositoryBase implements InvoiceRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async save(invoice: Invoice): Promise<void> {
    this.db.prepare(`INSERT INTO receivables_invoices (tenant_id, workspace_id, id, invoice_number, customer_id, status, issue_date, due_date, outstanding_amount, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET invoice_number=excluded.invoice_number, customer_id=excluded.customer_id, status=excluded.status,
        issue_date=excluded.issue_date, due_date=excluded.due_date, outstanding_amount=excluded.outstanding_amount, created_at=excluded.created_at, record_json=excluded.record_json`)
      .run(invoice.tenant.tenantId, invoice.tenant.workspaceId, invoice.id, invoice.number ?? null, invoice.customerId ?? null, invoice.status,
        invoice.issueDate ?? null, invoice.dueDate ?? null, invoiceOutstanding(invoice), invoice.createdAt, json(serializeInvoice(invoice)));
  }
  async findById(scope: TenantScope, id: string): Promise<Invoice | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_invoices WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeInvoice);
  }
  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly Invoice[]> {
    const found = await Promise.all(ids.map((id) => this.findById(scope, id)));
    return found.filter((invoice): invoice is Invoice => invoice !== null);
  }
  async list(scope: TenantScope, options?: InvoiceListOptions): Promise<readonly Invoice[]> {
    const where = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.statuses !== undefined) {
      if (options.statuses.length === 0) return [];
      where.push(`status IN (${placeholders(options.statuses.length)})`); params.push(...options.statuses);
    }
    if (options?.customerId !== undefined) { where.push('customer_id=?'); params.push(options.customerId); }
    if (options?.from !== undefined) { where.push('issue_date IS NOT NULL AND issue_date>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('issue_date IS NOT NULL AND issue_date<=?'); params.push(options.to); }
    if (options?.dueBefore !== undefined) { where.push('due_date IS NOT NULL AND due_date<?'); params.push(options.dueBefore); }
    return this.db.prepare(`SELECT record_json FROM receivables_invoices WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC`).all(...params)
      .map((row) => parse(row['record_json'], deserializeInvoice));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM receivables_invoices WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
  async nextNumber(scope: TenantScope, seriesKey: string): Promise<number> {
    // 読みと書きを 1 つの同期トランザクションに入れる（外側の UnitOfWork があれば SAVEPOINT で合流する）。
    return this.database.transaction(() => {
      const row = this.db.prepare(`SELECT next_value FROM receivables_invoice_sequences WHERE tenant_id=? AND workspace_id=? AND series_key=?`).get(scope.tenantId, scope.workspaceId, seriesKey);
      const next = row === undefined ? 1 : Number(row['next_value']);
      this.db.prepare(`INSERT INTO receivables_invoice_sequences (tenant_id, workspace_id, series_key, next_value) VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, workspace_id, series_key) DO UPDATE SET next_value=excluded.next_value`).run(scope.tenantId, scope.workspaceId, seriesKey, next + 1);
      return next;
    });
  }
}

export class SqliteBankCsvProfileRepository extends SqliteRepositoryBase implements BankCsvProfileRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async save(profile: BankCsvProfile): Promise<void> {
    this.db.prepare(`INSERT INTO receivables_bank_csv_profiles (tenant_id, workspace_id, id, updated_at, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json`)
      .run(profile.tenant!.tenantId, profile.tenant!.workspaceId, profile.id, profile.updatedAt, json(serializeBankCsvProfile(profile)));
  }
  async findById(scope: TenantScope, id: string): Promise<BankCsvProfile | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_bank_csv_profiles WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeBankCsvProfile);
  }
  async list(scope: TenantScope): Promise<readonly BankCsvProfile[]> {
    return this.db.prepare(`SELECT record_json FROM receivables_bank_csv_profiles WHERE tenant_id=? AND workspace_id=? ORDER BY updated_at DESC, id ASC`).all(scope.tenantId, scope.workspaceId)
      .map((row) => parse(row['record_json'], deserializeBankCsvProfile));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM receivables_bank_csv_profiles WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
}

export class SqliteBankTransactionRepository extends SqliteRepositoryBase implements BankTransactionRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async save(transaction: BankTransaction): Promise<void> {
    this.db.prepare(`INSERT INTO receivables_bank_transactions (tenant_id, workspace_id, id, account_key, transaction_date, amount, status, fingerprint, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET account_key=excluded.account_key, transaction_date=excluded.transaction_date, amount=excluded.amount,
        status=excluded.status, fingerprint=excluded.fingerprint, created_at=excluded.created_at, record_json=excluded.record_json`)
      .run(transaction.tenant.tenantId, transaction.tenant.workspaceId, transaction.id, transaction.accountKey, transaction.date, transaction.amount,
        transaction.status, transaction.fingerprint, transaction.createdAt, json(serializeBankTransaction(transaction)));
  }
  async findById(scope: TenantScope, id: string): Promise<BankTransaction | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_bank_transactions WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeBankTransaction);
  }
  async findByFingerprints(scope: TenantScope, fingerprints: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const statement = this.db.prepare(`SELECT id FROM receivables_bank_transactions WHERE tenant_id=? AND workspace_id=? AND fingerprint=?`);
    const found = new Map<string, string>();
    for (const fingerprint of new Set(fingerprints)) {
      const row = statement.get(scope.tenantId, scope.workspaceId, fingerprint);
      if (row !== undefined) found.set(fingerprint, String(row['id']));
    }
    return found;
  }
  async list(scope: TenantScope, options?: BankTransactionListOptions): Promise<readonly BankTransaction[]> {
    const where = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.accountKey !== undefined) { where.push('account_key=?'); params.push(options.accountKey); }
    if (options?.from !== undefined) { where.push('transaction_date>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('transaction_date<=?'); params.push(options.to); }
    if (options?.ids !== undefined) {
      if (options.ids.length === 0) return [];
      where.push(`id IN (${placeholders(options.ids.length)})`); params.push(...options.ids);
    }
    let sql = `SELECT record_json FROM receivables_bank_transactions WHERE ${where.join(' AND ')} ORDER BY transaction_date ASC, created_at ASC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeBankTransaction));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM receivables_bank_transactions WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
}

export class SqliteMatchingRepository extends SqliteRepositoryBase implements MatchingRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }
  async save(matching: Matching): Promise<void> {
    const { tenantId, workspaceId } = matching.tenant;
    // 本体と配分表が食い違わないよう 1 つの同期トランザクションで書く。
    this.database.transaction(() => {
      this.db.prepare(`INSERT INTO receivables_matchings (tenant_id, workspace_id, id, transaction_id, status, confirmed_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET transaction_id=excluded.transaction_id, status=excluded.status, confirmed_at=excluded.confirmed_at, record_json=excluded.record_json`)
        .run(tenantId, workspaceId, matching.id, matching.transactionId, matching.status, matching.confirmedAt, json(serializeMatching(matching)));
      this.db.prepare(`DELETE FROM receivables_matching_allocations WHERE tenant_id=? AND workspace_id=? AND matching_id=?`).run(tenantId, workspaceId, matching.id);
      const insert = this.db.prepare(`INSERT INTO receivables_matching_allocations (tenant_id, workspace_id, matching_id, invoice_id, amount, status) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const allocation of matching.allocations) insert.run(tenantId, workspaceId, matching.id, allocation.invoiceId, allocation.amount, matching.status);
    });
  }
  async findById(scope: TenantScope, id: string): Promise<Matching | null> {
    const row = this.db.prepare(`SELECT record_json FROM receivables_matchings WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeMatching);
  }
  async list(scope: TenantScope, options?: MatchingListOptions): Promise<readonly Matching[]> {
    const where = ['tenant_id=?', 'workspace_id=?'];
    const params: string[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.transactionId !== undefined) { where.push('transaction_id=?'); params.push(options.transactionId); }
    if (options?.invoiceId !== undefined) {
      where.push('id IN (SELECT matching_id FROM receivables_matching_allocations WHERE tenant_id=? AND workspace_id=? AND invoice_id=?)');
      params.push(scope.tenantId, scope.workspaceId, options.invoiceId);
    }
    return this.db.prepare(`SELECT record_json FROM receivables_matchings WHERE ${where.join(' AND ')} ORDER BY confirmed_at DESC, id ASC`).all(...params)
      .map((row) => parse(row['record_json'], deserializeMatching));
  }
}

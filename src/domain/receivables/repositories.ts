/**
 * ドメイン: 入金消込 BC のリポジトリ境界（docs/22 §9）。
 *
 * - 設定はワークスペースに 1 つ（scope がキー）。無ければ null（application が初期値を返す。保存はしない）。
 * - 取引先 / 請求書 / プロファイル / 明細 / 消込は (scope, id) で upsert。並びは各 list のコメントが正本で、
 *   InMemory と SQLite は共有契約テストで同じ結果になることを確かめる。
 * - 請求書番号はワークスペース内で一意（下書きは番号なし）。明細の指紋もワークスペース内で一意で、
 *   重複取込の最後の砦になる（保存が一意違反で失敗する）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { BankCsvProfile } from './bank-csv-profile';
import type { BankTransaction, BankTransactionStatus } from './bank-transaction';
import type { Customer } from './customer';
import type { Invoice, InvoiceStatus } from './invoice';
import type { Matching, MatchingStatus } from './matching-aggregate';
import type { ReceivablesSettings } from './settings';

export interface ReceivablesSettingsRepository {
  get(scope: TenantScope): Promise<ReceivablesSettings | null>;
  save(scope: TenantScope, settings: ReceivablesSettings): Promise<void>;
}

export interface CustomerListOptions {
  readonly enabled?: boolean;
}

export interface CustomerRepository {
  save(customer: Customer): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<Customer | null>;
  /** 名前 昇順 → id 昇順。 */
  list(scope: TenantScope, options?: CustomerListOptions): Promise<readonly Customer[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface InvoiceListOptions {
  readonly statuses?: readonly InvoiceStatus[];
  readonly customerId?: string;
  /** 発行日（`YYYY-MM-DD`）の範囲。両端を含む。発行日の無い下書きは範囲指定から外れる。 */
  readonly from?: string;
  readonly to?: string;
  /** 期日がこの日より前（期日超過の一覧。期日の無いものは外れる）。 */
  readonly dueBefore?: string;
}

export interface InvoiceRepository {
  /** 番号が他の請求書と重なれば一意違反で失敗する。 */
  save(invoice: Invoice): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<Invoice | null>;
  /** 見つかったものだけ（ids の順）。 */
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly Invoice[]>;
  /** 作成日時 降順 → id 昇順。 */
  list(scope: TenantScope, options?: InvoiceListOptions): Promise<readonly Invoice[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
  /** 系列の次の連番を返して 1 進める（1 から）。発行と同じ UnitOfWork で呼ぶこと。 */
  nextNumber(scope: TenantScope, seriesKey: string): Promise<number>;
}

export interface BankCsvProfileRepository {
  save(profile: BankCsvProfile): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<BankCsvProfile | null>;
  /** 更新日時 降順 → id 昇順（判定で新しいものを先に当てる）。 */
  list(scope: TenantScope): Promise<readonly BankCsvProfile[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface BankTransactionListOptions {
  readonly status?: BankTransactionStatus;
  readonly from?: string;
  readonly to?: string;
  readonly accountKey?: string;
  readonly ids?: readonly string[];
  readonly limit?: number;
}

export interface BankTransactionRepository {
  /** 指紋が既存の明細と重なれば一意違反で失敗する。 */
  save(transaction: BankTransaction): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<BankTransaction | null>;
  /** 指紋 → 既存の明細 id。 */
  findByFingerprints(scope: TenantScope, fingerprints: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** 入金日 昇順 → 作成日時 昇順 → id 昇順（判定の順）。 */
  list(scope: TenantScope, options?: BankTransactionListOptions): Promise<readonly BankTransaction[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface MatchingListOptions {
  readonly status?: MatchingStatus;
  readonly invoiceId?: string;
  readonly transactionId?: string;
}

export interface MatchingRepository {
  /** 請求からの逆引き（配分表）も同時に書く。 */
  save(matching: Matching): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<Matching | null>;
  /** 確定日時 降順 → id 昇順。 */
  list(scope: TenantScope, options?: MatchingListOptions): Promise<readonly Matching[]>;
}

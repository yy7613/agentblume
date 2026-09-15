/**
 * application層: 取引先（docs/22 §2.2）の一覧・取得・保存・削除。
 *
 * 別名の出所（手動 / 学習）・学習した消込・作成日・最終一致日は**サーバーが持っている値を引き継ぐ**。
 * 画面が送るのは別名の id と文字列だけで、そこから出所を書き換えられると「学習した別名だけ取消で消す」が壊れる。
 * 別の取引先と同じ正規化名の別名は保存できるが、判定では `alias-conflict` になるので `warnings` で知らせる。
 */
import { randomUUID } from 'node:crypto';
import { aliasConflicts, createCustomer, type AliasConflict, type Customer, type Honorific } from '../../domain/receivables/customer';
import { CustomerNotFoundError, ReceivablesStateError } from '../../domain/receivables/errors';
import { invoiceOutstanding, OPEN_INVOICE_STATUSES } from '../../domain/receivables/invoice';
import type { CustomerRepository, InvoiceRepository } from '../../domain/receivables/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface CustomerListItem {
  readonly customer: Customer;
  /** 発行済みで未入金の合計。 */
  readonly outstanding: number;
}

export class ListCustomersUseCase {
  constructor(private readonly customers: CustomerRepository, private readonly invoices: InvoiceRepository) {}
  async execute(scope: TenantScope, options: { readonly enabled?: boolean } = {}): Promise<readonly CustomerListItem[]> {
    const [customers, open] = await Promise.all([this.customers.list(scope, options), this.invoices.list(scope, { statuses: OPEN_INVOICE_STATUSES })]);
    const outstanding = new Map<string, number>();
    for (const invoice of open) {
      if (invoice.customerId !== undefined) outstanding.set(invoice.customerId, (outstanding.get(invoice.customerId) ?? 0) + invoiceOutstanding(invoice));
    }
    return customers.map((customer) => ({ customer, outstanding: outstanding.get(customer.id) ?? 0 }));
  }
}

export class GetCustomerUseCase {
  constructor(private readonly customers: CustomerRepository) {}
  async execute(scope: TenantScope, id: string): Promise<Customer> {
    const customer = await this.customers.findById(scope, id);
    if (customer === null) throw new CustomerNotFoundError(`customer not found: ${id}`);
    return customer;
  }
}

export interface SaveCustomerInput {
  readonly scope: TenantScope;
  /** 省略で新規、指定で更新（無ければ 404）。 */
  readonly id?: string;
  readonly name: string;
  readonly honorific?: Honorific;
  readonly kana?: string;
  readonly registrationNumber?: string;
  readonly paymentTermDays?: number;
  readonly address?: string;
  readonly note?: string;
  readonly payerAliases?: readonly { readonly id?: string; readonly text: string }[];
  readonly enabled?: boolean;
}

export class SaveCustomerUseCase {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveCustomerInput): Promise<{ readonly customer: Customer; readonly warnings: readonly AliasConflict[] }> {
    const at = this.now().toISOString();
    const existing = input.id === undefined ? null : await this.customers.findById(input.scope, input.id);
    if (input.id !== undefined && existing === null) throw new CustomerNotFoundError(`customer not found: ${input.id}`);
    const previous = new Map((existing?.payerAliases ?? []).map((alias) => [alias.id, alias]));
    const customer = createCustomer({
      tenant: input.scope,
      ...(input.id === undefined ? {} : { id: input.id }),
      name: input.name,
      ...(input.honorific === undefined ? {} : { honorific: input.honorific }),
      ...(input.kana === undefined ? {} : { kana: input.kana }),
      ...(input.registrationNumber === undefined ? {} : { registrationNumber: input.registrationNumber }),
      ...(input.paymentTermDays === undefined ? {} : { paymentTermDays: input.paymentTermDays }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.note === undefined ? {} : { note: input.note }),
      payerAliases: (input.payerAliases ?? []).map((alias) => {
        const kept = alias.id === undefined ? undefined : previous.get(alias.id);
        return kept === undefined
          ? { text: alias.text, origin: 'manual' as const, createdAt: at }
          : { ...kept, text: alias.text };
      }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }, this.makeId);
    await this.customers.save(customer);
    const others = await this.customers.list(input.scope);
    return { customer, warnings: aliasConflicts(customer, others) };
  }
}

export class DeleteCustomerUseCase {
  constructor(private readonly customers: CustomerRepository, private readonly invoices: InvoiceRepository) {}
  async execute(scope: TenantScope, id: string): Promise<void> {
    const customer = await this.customers.findById(scope, id);
    if (customer === null) throw new CustomerNotFoundError(`customer not found: ${id}`);
    const used = await this.invoices.list(scope, { customerId: id });
    // 請求書から参照されている取引先を物理削除すると、請求の宛名と消込の照合相手が消える。無効化を案内する。
    if (used.length > 0) throw new ReceivablesStateError('customer-in-use', `customer ${customer.name} is used by ${used.length} invoices; disable it instead`, { invoices: used.length });
    await this.customers.delete(scope, id);
  }
}

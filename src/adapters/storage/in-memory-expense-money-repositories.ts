/**
 * adapters層: 経費精算のお金の流れ（仮払・法人カード・振込バッチ）の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 保存も読み出しも `structuredClone` する（SQLite 実装は JSON を経由するので挙動を揃える）。
 * SQLite の一意制約（取込の SHA-256・利用行の dedupe_key）に当たる検査もここで同じ結果・同じエラーにする。
 */
import type { AdvanceStatus, ExpenseAdvance } from '../../domain/expense/advance';
import type { ExpenseCardImport, ExpenseCardTransaction } from '../../domain/expense/card';
import type { ExpensePayoutBatch, PayoutBatchStatus } from '../../domain/expense/payout';
import type {
  CardCandidateQuery, ExpenseAdvanceRepository, ExpenseCardRepository, ExpenseCardTransactionListOptions, ExpensePayoutBatchRepository,
} from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import {
  ACTIVE_PAYOUT_BATCH_STATUSES, cardDedupeConflict, cardDuplicateImport, mergeCardCoverage, payoutBatchIncludesClaim, type CardCoverageRange,
} from './sqlite-expense-money-repositories';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }
function inScope(item: { readonly tenant: TenantScope }, scope: TenantScope): boolean {
  return item.tenant.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/** createdAt 降順 → id 昇順。 */
function newestFirst(left: { readonly createdAt: string; readonly id: string }, right: { readonly createdAt: string; readonly id: string }): number {
  return compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id);
}
function limit<T>(items: readonly T[], count: number | undefined): readonly T[] {
  return count === undefined ? items : items.slice(0, count);
}

export class InMemoryExpenseAdvanceRepository implements ExpenseAdvanceRepository {
  private readonly store = new Map<string, ExpenseAdvance>();

  async save(advance: ExpenseAdvance): Promise<void> {
    this.store.set(key(advance.tenant, advance.id), structuredClone(advance));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseAdvance | null> {
    const advance = this.store.get(key(scope, id));
    return advance === undefined ? null : structuredClone(advance);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseAdvance[]> {
    return ids.map((id) => this.store.get(key(scope, id))).filter((advance): advance is ExpenseAdvance => advance !== undefined).map((advance) => structuredClone(advance));
  }

  async list(scope: TenantScope, options?: { readonly status?: AdvanceStatus; readonly employeeId?: string; readonly limit?: number }): Promise<readonly ExpenseAdvance[]> {
    const matched = [...this.store.values()]
      .filter((advance) => inScope(advance, scope)
        && (options?.status === undefined || advance.status === options.status)
        && (options?.employeeId === undefined || advance.employeeId === options.employeeId))
      .sort(newestFirst);
    return limit(matched, options?.limit).map((advance) => structuredClone(advance));
  }
}

export class InMemoryExpenseCardRepository implements ExpenseCardRepository {
  private readonly imports = new Map<string, ExpenseCardImport>();
  private readonly transactions = new Map<string, ExpenseCardTransaction>();

  private transactionsIn(scope: TenantScope): readonly ExpenseCardTransaction[] {
    return [...this.transactions.values()].filter((transaction) => inScope(transaction, scope));
  }

  async saveImport(importRecord: ExpenseCardImport, transactions: readonly ExpenseCardTransaction[]): Promise<{ readonly inserted: number; readonly duplicates: number }> {
    const existing = [...this.imports.values()].find((other) => inScope(other, importRecord.tenant) && other.fileSha256 === importRecord.fileSha256 && other.id !== importRecord.id);
    // 検査を書き込みより先に済ませる（途中で投げても何も残らない = SQLite のトランザクションと同じ）。
    if (existing !== undefined) throw cardDuplicateImport(existing.id, existing.createdAt);
    this.imports.set(key(importRecord.tenant, importRecord.id), structuredClone(importRecord));
    let inserted = 0;
    for (const transaction of transactions) {
      // INSERT OR IGNORE と同じく、主キー（id）か dedupe_key が既にあれば入れない。
      const taken = this.transactions.has(key(transaction.tenant, transaction.id))
        || this.transactionsIn(transaction.tenant).some((other) => other.dedupeKey === transaction.dedupeKey);
      if (taken) continue;
      this.transactions.set(key(transaction.tenant, transaction.id), structuredClone(transaction));
      inserted += 1;
    }
    return { inserted, duplicates: transactions.length - inserted };
  }

  async findImport(scope: TenantScope, id: string): Promise<ExpenseCardImport | null> {
    const record = this.imports.get(key(scope, id));
    return record === undefined ? null : structuredClone(record);
  }

  async listImports(scope: TenantScope, options?: { readonly limit?: number }): Promise<readonly ExpenseCardImport[]> {
    const matched = [...this.imports.values()].filter((record) => inScope(record, scope)).sort(newestFirst);
    return limit(matched, options?.limit).map((record) => structuredClone(record));
  }

  async deleteImport(scope: TenantScope, id: string): Promise<number> {
    if (!this.imports.delete(key(scope, id))) return -1;
    const targets = this.transactionsIn(scope).filter((transaction) => transaction.importId === id);
    for (const transaction of targets) this.transactions.delete(key(scope, transaction.id));
    return targets.length;
  }

  async saveTransactions(transactions: readonly ExpenseCardTransaction[]): Promise<void> {
    for (const transaction of transactions) {
      const conflict = this.transactionsIn(transaction.tenant).find((other) => other.dedupeKey === transaction.dedupeKey && other.id !== transaction.id);
      if (conflict !== undefined) throw cardDedupeConflict(transaction, conflict.id);
    }
    for (const transaction of transactions) this.transactions.set(key(transaction.tenant, transaction.id), structuredClone(transaction));
  }

  async findTransaction(scope: TenantScope, id: string): Promise<ExpenseCardTransaction | null> {
    const transaction = this.transactions.get(key(scope, id));
    return transaction === undefined ? null : structuredClone(transaction);
  }

  async listTransactions(scope: TenantScope, options?: ExpenseCardTransactionListOptions): Promise<readonly ExpenseCardTransaction[]> {
    const matched = this.transactionsIn(scope)
      .filter((transaction) => (options?.status === undefined || transaction.status === options.status)
        && (options?.cardId === undefined || transaction.cardId === options.cardId)
        && (options?.from === undefined || transaction.usedOn >= options.from)
        && (options?.to === undefined || transaction.usedOn <= options.to)
        && (options?.claimId === undefined || transaction.match?.claimId === options.claimId))
      .sort((left, right) => compareText(right.usedOn, left.usedOn) || compareText(left.id, right.id));
    return limit(matched, options?.limit).map((transaction) => structuredClone(transaction));
  }

  async findTransactionsForMatching(scope: TenantScope, query: CardCandidateQuery): Promise<readonly ExpenseCardTransaction[]> {
    return this.transactionsIn(scope)
      .filter((transaction) => transaction.usedOn >= query.from && transaction.usedOn <= query.to
        && (query.amounts.length === 0 || query.amounts.some((range) => transaction.amount >= range.min && transaction.amount <= range.max)))
      .sort((left, right) => compareText(left.usedOn, right.usedOn) || compareText(left.id, right.id))
      .map((transaction) => structuredClone(transaction));
  }

  async coverage(scope: TenantScope, cardIds?: readonly string[]): Promise<readonly CardCoverageRange[]> {
    const wanted = cardIds === undefined ? undefined : new Set(cardIds);
    const ranges = [...this.imports.values()].filter((record) => inScope(record, scope)).flatMap((record) => {
      const cards = record.cardId !== undefined
        ? [record.cardId]
        : [...new Set(this.transactionsIn(scope).filter((transaction) => transaction.importId === record.id).map((transaction) => transaction.cardId))];
      return cards.map((cardId) => ({ cardId, from: record.periodFrom, to: record.periodTo }));
    });
    return mergeCardCoverage(ranges.filter((range) => wanted === undefined || wanted.has(range.cardId)));
  }

  async unlinkClaim(scope: TenantScope, claimId: string): Promise<number> {
    const targets = this.transactionsIn(scope).filter((transaction) => transaction.status === 'matched' && transaction.match?.claimId === claimId);
    for (const { match: _match, ...rest } of targets) this.transactions.set(key(scope, rest.id), { ...rest, status: 'unmatched' });
    return targets.length;
  }
}

export class InMemoryExpensePayoutBatchRepository implements ExpensePayoutBatchRepository {
  private readonly store = new Map<string, ExpensePayoutBatch>();

  private inScope(scope: TenantScope): readonly ExpensePayoutBatch[] {
    return [...this.store.values()].filter((batch) => inScope(batch, scope)).sort(newestFirst);
  }

  async save(batch: ExpensePayoutBatch): Promise<void> {
    this.store.set(key(batch.tenant, batch.id), structuredClone(batch));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpensePayoutBatch | null> {
    const batch = this.store.get(key(scope, id));
    return batch === undefined ? null : structuredClone(batch);
  }

  async list(scope: TenantScope, options?: { readonly status?: PayoutBatchStatus; readonly limit?: number }): Promise<readonly ExpensePayoutBatch[]> {
    const matched = this.inScope(scope).filter((batch) => options?.status === undefined || batch.status === options.status);
    return limit(matched, options?.limit).map((batch) => structuredClone(batch));
  }

  async findActiveByClaimIds(scope: TenantScope, claimIds: readonly string[]): Promise<readonly ExpensePayoutBatch[]> {
    if (claimIds.length === 0) return [];
    const wanted = new Set(claimIds);
    return this.inScope(scope)
      .filter((batch) => ACTIVE_PAYOUT_BATCH_STATUSES.includes(batch.status) && payoutBatchIncludesClaim(batch, wanted))
      .map((batch) => structuredClone(batch));
  }
}

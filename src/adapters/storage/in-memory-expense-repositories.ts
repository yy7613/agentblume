/**
 * adapters層: 経費精算 BC の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * **保存も読み出しも `structuredClone` する**（SQLite 実装は JSON を経由するので当然そうなる。挙動を揃える）。
 * 並び順と重複候補の並びは SQLite の `ORDER BY` と 1 対 1 に対応させてある（共有契約テストが検査する）。
 * 実用化の派生索引（`expense_claim_refs` / `expense_item_refs`）は保存した申請そのものから同じ値を作れるので持たず、
 * 申請から作れない現在の段の承認者（`expense_claim_approvers`）だけを別に持つ。
 */
import type { CardMatchableItem } from '../../domain/expense/card';
import { claimantKeyOf, toExpenseClaimSummary, type ExpenseClaim, type ExpenseClaimSummary } from '../../domain/expense/claim';
import { itemKeyOf, payeeKeyOf, type DuplicateCandidate, type ItemKey } from '../../domain/expense/duplicates';
import type { ExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseReceipt } from '../../domain/expense/receipt';
import type {
  CardCandidateQuery, DuplicateCandidateQuery, ExpenseClaimListOptions, ExpenseClaimRepository, ExpenseItemFact, ExpenseItemFactQuery,
  ExpensePolicyRepository, ExpenseReceiptRepository,
} from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

function scopeKey(scope: TenantScope): string { return `${scope.tenantId}\u0000${scope.workspaceId}`; }
function key(scope: TenantScope, id: string): string { return `${scopeKey(scope)}\u0000${id}`; }
function inScope(item: { readonly tenant: TenantScope }, scope: TenantScope): boolean {
  return item.tenant.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/** SQLite の `col>=?` / `col<=?` と同じく、値が無ければ範囲を指定した時点で外れる。 */
function inRange(value: string | undefined, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && (value === undefined || value < from)) return false;
  if (to !== undefined && (value === undefined || value > to)) return false;
  return true;
}
function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export class InMemoryExpensePolicyRepository implements ExpensePolicyRepository {
  private readonly store = new Map<string, ExpensePolicy>();

  async get(scope: TenantScope): Promise<ExpensePolicy | null> {
    const policy = this.store.get(scopeKey(scope));
    return policy === undefined ? null : structuredClone(policy);
  }

  async save(scope: TenantScope, policy: ExpensePolicy): Promise<void> {
    this.store.set(scopeKey(scope), structuredClone(policy));
  }
}

export class InMemoryExpenseClaimRepository implements ExpenseClaimRepository {
  private readonly store = new Map<string, ExpenseClaim>();
  /** 申請 id → 明細の照合キー（SQLite の `expense_item_keys` に当たる派生データ）。 */
  private readonly keys = new Map<string, readonly (ItemKey & { readonly itemId: string })[]>();
  /** 申請 id → 現在の段の承認者（SQLite の `expense_claim_approvers`）。 */
  private readonly approvers = new Map<string, ReadonlySet<string>>();

  async save(claim: ExpenseClaim, receiptHashes: ReadonlyMap<string, string>, approvers: readonly string[] = []): Promise<void> {
    const storeKey = key(claim.tenant, claim.id);
    this.store.set(storeKey, structuredClone(claim));
    this.keys.set(storeKey, claim.items.map((item) => ({ itemId: item.id, ...itemKeyOf(item, receiptHashes.get(item.id)) })));
    this.approvers.set(storeKey, new Set(approvers));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseClaim | null> {
    const claim = this.store.get(key(scope, id));
    return claim === undefined ? null : structuredClone(claim);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseClaim[]> {
    return ids.map((id) => this.store.get(key(scope, id))).filter((claim): claim is ExpenseClaim => claim !== undefined).map((claim) => structuredClone(claim));
  }

  async list(scope: TenantScope, options?: ExpenseClaimListOptions): Promise<readonly ExpenseClaimSummary[]> {
    const claimant = options?.claimant?.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    const statuses = options?.statuses !== undefined && options.statuses.length > 0 ? new Set<string>(options.statuses) : undefined;
    const matched = [...this.store.values()].filter((claim) => {
      if (!inScope(claim, scope)) return false;
      if (options?.status !== undefined && claim.status !== options.status) return false;
      if (statuses !== undefined && !statuses.has(claim.status)) return false;
      if (options?.verdict !== undefined && claim.judgment?.verdict !== options.verdict) return false;
      if (claimant !== undefined && claimant !== '' && !claimantKeyOf(claim.claimant).includes(claimant)) return false;
      if (options?.from !== undefined && claim.period.to < options.from) return false;
      if (options?.to !== undefined && claim.period.from > options.to) return false;
      if (options?.employeeId !== undefined && claim.claimant.employeeId !== options.employeeId) return false;
      if (options?.departmentId !== undefined && claim.claimant.departmentId !== options.departmentId) return false;
      if (options?.advanceId !== undefined && claim.advanceId !== options.advanceId) return false;
      if (options?.unlinked === true && claim.claimant.employeeId !== undefined) return false;
      if (options?.awaitingEmployeeId !== undefined && !(this.approvers.get(key(scope, claim.id))?.has(options.awaitingEmployeeId) ?? false)) return false;
      return true;
    }).sort((left, right) => (left.createdAt !== right.createdAt ? compareText(right.createdAt, left.createdAt) : compareText(left.id, right.id)));
    const limited = options?.limit === undefined ? matched : matched.slice(0, options.limit);
    return limited.map((claim) => toExpenseClaimSummary(structuredClone(claim)));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    this.keys.delete(key(scope, id));
    this.approvers.delete(key(scope, id));
    return this.store.delete(key(scope, id));
  }

  async findDuplicateCandidates(scope: TenantScope, query: DuplicateCandidateQuery): Promise<readonly DuplicateCandidate[]> {
    if (query.keys.length === 0 && query.sha256s.length === 0) return [];
    const pairs = new Set(query.keys.map((entry) => `${entry.transactionDate}|${entry.amount}`));
    const shas = new Set(query.sha256s);
    const claims = [...this.store.values()]
      .filter((claim) => inScope(claim, scope) && claim.id !== query.excludeClaimId)
      .sort((left, right) => (left.createdAt !== right.createdAt ? compareText(left.createdAt, right.createdAt) : compareText(left.id, right.id)));
    const candidates: DuplicateCandidate[] = [];
    for (const claim of claims) {
      const rows = [...(this.keys.get(key(scope, claim.id)) ?? [])].sort((left, right) => compareText(left.itemId, right.itemId));
      for (const row of rows) {
        const byKey = row.transactionDate !== undefined && row.amount !== undefined && pairs.has(`${row.transactionDate}|${row.amount}`);
        const bySha = row.receiptSha256 !== undefined && shas.has(row.receiptSha256);
        if (!byKey && !bySha) continue;
        const { itemId, ...itemKey } = row;
        candidates.push({ claimId: claim.id, itemId, claimStatus: claim.status, claimantName: claim.claimant.name, ...itemKey });
      }
    }
    return candidates;
  }

  /** スコープ内の申請を claim_id 昇順、明細を item_id 昇順に並べる（SQLite の ORDER BY と同じ）。 */
  private itemsInOrder(scope: TenantScope): readonly { readonly claim: ExpenseClaim; readonly item: ExpenseClaim['items'][number] }[] {
    return [...this.store.values()]
      .filter((claim) => inScope(claim, scope))
      .sort((left, right) => compareText(left.id, right.id))
      .flatMap((claim) => [...claim.items].sort((left, right) => compareText(left.id, right.id)).map((item) => ({ claim, item })));
  }

  async listItemFacts(scope: TenantScope, query: ExpenseItemFactQuery): Promise<readonly ExpenseItemFact[]> {
    const statuses = query.statuses !== undefined && query.statuses.length > 0 ? new Set<string>(query.statuses) : undefined;
    return this.itemsInOrder(scope)
      .filter(({ claim, item }) => inRange(item.facts.transactionDate, query.transactionFrom, query.transactionTo)
        && inRange(claim.approval?.at, query.approvedFrom, query.approvedTo)
        && inRange(claim.settlement?.settledAt, query.settledFrom, query.settledTo)
        && (statuses === undefined || statuses.has(claim.status)))
      .slice(0, query.limit)
      .map(({ claim, item }) => withDefined({
        claimId: claim.id,
        itemId: item.id,
        status: claim.status,
        transactionDate: item.facts.transactionDate,
        amount: item.facts.amount,
        categoryId: item.categoryId,
        corporate: item.facts.corporatePayment === true,
        employeeId: claim.claimant.employeeId,
        departmentId: claim.claimant.departmentId,
        claimantName: claim.claimant.name,
        departmentText: claim.claimant.department,
        approvedAt: claim.approval?.at,
        settledAt: claim.settlement?.settledAt,
      }));
  }

  async findCardCandidates(scope: TenantScope, query: CardCandidateQuery): Promise<readonly CardMatchableItem[]> {
    const candidates: CardMatchableItem[] = [];
    for (const { claim, item } of this.itemsInOrder(scope)) {
      const { transactionDate, amount } = item.facts;
      if (transactionDate === undefined || amount === undefined || amount <= 0) continue;
      if (transactionDate < query.from || transactionDate > query.to) continue;
      if (query.amounts.length > 0 && !query.amounts.some((range) => amount >= range.min && amount <= range.max)) continue;
      if (query.excludeClaimId !== undefined && claim.id === query.excludeClaimId) continue;
      candidates.push(withDefined({
        claimId: claim.id,
        itemId: item.id,
        claimStatus: claim.status,
        employeeId: claim.claimant.employeeId,
        transactionDate,
        amount,
        payeeKey: payeeKeyOf(item.facts.payeeName),
        corporate: item.facts.corporatePayment === true,
      }));
    }
    // 取引日 → claim_id → item_id（itemsInOrder が後ろ 2 つの順を作っているので、安定ソートで取引日だけを並べる）。
    return candidates.sort((left, right) => compareText(left.transactionDate, right.transactionDate));
  }
}

export class InMemoryExpenseReceiptRepository implements ExpenseReceiptRepository {
  private readonly store = new Map<string, ExpenseReceipt>();

  async save(receipt: ExpenseReceipt): Promise<void> {
    this.store.set(key(receipt.tenant, receipt.id), structuredClone(receipt));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseReceipt | null> {
    const receipt = this.store.get(key(scope, id));
    return receipt === undefined ? null : structuredClone(receipt);
  }

  private ofClaim(scope: TenantScope, claimId: string): readonly ExpenseReceipt[] {
    return [...this.store.values()]
      .filter((receipt) => inScope(receipt, scope) && receipt.claimId === claimId)
      .sort((left, right) => (left.createdAt !== right.createdAt ? compareText(left.createdAt, right.createdAt) : compareText(left.id, right.id)));
  }

  async findByItem(scope: TenantScope, claimId: string, itemId: string): Promise<ExpenseReceipt | null> {
    const matched = this.ofClaim(scope, claimId).filter((receipt) => receipt.itemId === itemId);
    // SQLite と同じく新しい方（createdAt 降順 → id 昇順の先頭）。
    const newest = [...matched].sort((left, right) => (left.createdAt !== right.createdAt ? compareText(right.createdAt, left.createdAt) : compareText(left.id, right.id)))[0];
    return newest === undefined ? null : structuredClone(newest);
  }

  async hashesByClaim(scope: TenantScope, claimId: string): Promise<ReadonlyMap<string, string>> {
    return new Map(this.ofClaim(scope, claimId).map((receipt) => [receipt.itemId, receipt.sha256]));
  }

  async deleteByClaim(scope: TenantScope, claimId: string): Promise<number> {
    const targets = this.ofClaim(scope, claimId);
    for (const receipt of targets) this.store.delete(key(scope, receipt.id));
    return targets.length;
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }
}

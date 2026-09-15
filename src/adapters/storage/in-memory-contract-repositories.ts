/**
 * adapters層: 契約 BC の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 仕訳の InMemory 実装と同じく、保存も読み出しも `structuredClone` する（SQLite が JSON を経由するのと挙動を揃える）。
 * 並び順の正本は `domain/contract/repositories.ts` の doc コメント。SQLite の `ORDER BY` と同じ結果にする。
 */
import { toContractDocumentSummary, type ContractDocument, type ContractDocumentSummary } from '../../domain/contract/document';
import type { Playbook } from '../../domain/contract/playbook';
import type {
  ContractDocumentListOptions, ContractDocumentRepository, ContractPlaybookRepository, ContractReviewRepository,
  DeadlineProjection, SignedContractListOptions, SignedContractRepository,
} from '../../domain/contract/repositories';
import type { ContractReview } from '../../domain/contract/review';
import type { SignedContract } from '../../domain/contract/signed-contract';
import type { TenantScope } from '../../domain/shared/tenant-scope';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }
function inScope(item: { readonly tenant: TenantScope }, scope: TenantScope): boolean {
  return item.tenant.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export class InMemoryContractPlaybookRepository implements ContractPlaybookRepository {
  private readonly store = new Map<string, Playbook>();
  async save(playbook: Playbook): Promise<void> { this.store.set(key(playbook.tenant, playbook.id), structuredClone(playbook)); }
  async findById(scope: TenantScope, id: string): Promise<Playbook | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope): Promise<readonly Playbook[]> {
    return [...this.store.values()].filter((playbook) => inScope(playbook, scope))
      .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id))
      .map((playbook) => structuredClone(playbook));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
}

export class InMemoryContractDocumentRepository implements ContractDocumentRepository {
  private readonly store = new Map<string, ContractDocument>();
  async save(document: ContractDocument): Promise<void> { this.store.set(key(document.tenant, document.id), structuredClone(document)); }
  async findById(scope: TenantScope, id: string): Promise<ContractDocument | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope, options?: ContractDocumentListOptions): Promise<readonly ContractDocumentSummary[]> {
    const summaries = [...this.store.values()]
      .filter((document) => inScope(document, scope) && (options?.status === undefined || document.status === options.status))
      .sort((left, right) => compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id))
      .map(toContractDocumentSummary);
    return options?.limit === undefined ? summaries : summaries.slice(0, options.limit);
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
}

export class InMemoryContractReviewRepository implements ContractReviewRepository {
  private readonly store = new Map<string, ContractReview>();
  async save(review: ContractReview): Promise<void> { this.store.set(key(review.tenant, review.id), structuredClone(review)); }
  async findById(scope: TenantScope, id: string): Promise<ContractReview | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async listByDocument(scope: TenantScope, documentId: string): Promise<readonly ContractReview[]> {
    return [...this.store.values()].filter((review) => inScope(review, scope) && review.documentId === documentId)
      .sort((left, right) => compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id))
      .map((review) => structuredClone(review));
  }
  async deleteByDocument(scope: TenantScope, documentId: string): Promise<number> {
    let removed = 0;
    for (const [entryKey, review] of this.store) {
      if (inScope(review, scope) && review.documentId === documentId) { this.store.delete(entryKey); removed += 1; }
    }
    return removed;
  }
}

export class InMemorySignedContractRepository implements SignedContractRepository {
  private readonly store = new Map<string, SignedContract>();
  async save(contract: SignedContract): Promise<void> {
    // 1 文書 1 件（SQLite の一意索引と同じ規律）。別 id で同じ文書を登録しようとしたら失敗させる。
    const duplicate = [...this.store.values()].find((entry) => inScope(entry, contract.tenant) && entry.documentId === contract.documentId && entry.id !== contract.id);
    if (duplicate !== undefined) throw new Error(`UNIQUE constraint failed: contract_signed_contracts document_id ${contract.documentId}`);
    this.store.set(key(contract.tenant, contract.id), structuredClone(contract));
  }
  async findById(scope: TenantScope, id: string): Promise<SignedContract | null> {
    const found = this.store.get(key(scope, id));
    return found === undefined ? null : structuredClone(found);
  }
  async findByDocument(scope: TenantScope, documentId: string): Promise<SignedContract | null> {
    const found = [...this.store.values()].find((contract) => inScope(contract, scope) && contract.documentId === documentId);
    return found === undefined ? null : structuredClone(found);
  }
  async list(scope: TenantScope, options?: SignedContractListOptions): Promise<readonly SignedContract[]> {
    const needle = options?.counterparty?.toLowerCase();
    return [...this.store.values()]
      .filter((contract) => inScope(contract, scope)
        && (options?.status === undefined || contract.status === options.status)
        && (needle === undefined || needle === '' || contract.counterpartyName.toLowerCase().includes(needle)))
      .sort((left, right) => compareText(right.signedDate, left.signedDate) || compareText(left.id, right.id))
      .map((contract) => structuredClone(contract));
  }
  async delete(scope: TenantScope, id: string): Promise<boolean> { return this.store.delete(key(scope, id)); }
  async listOpenDeadlines(scope: TenantScope, options?: { readonly dueOnOrBefore?: string }): Promise<readonly DeadlineProjection[]> {
    return [...this.store.values()].filter((contract) => inScope(contract, scope))
      .flatMap((contract) => contract.deadlines
        .filter((deadline) => deadline.status === 'open' && (options?.dueOnOrBefore === undefined || deadline.dueDate <= options.dueOnOrBefore))
        .map((deadline) => ({ contractId: contract.id, deadlineId: deadline.id, kind: deadline.kind, dueDate: deadline.dueDate })))
      .sort((left, right) => compareText(left.dueDate, right.dueDate) || compareText(left.contractId, right.contractId) || compareText(left.deadlineId, right.deadlineId));
  }
}

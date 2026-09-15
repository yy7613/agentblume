/**
 * ドメイン: 契約 BC のリポジトリ境界。
 *
 * - 審査基準 / 文書 / レビュー / 締結済み契約は (scope, id) で upsert。
 * - 文書の一覧は**要約**（本文・条項・抽出の詳細を含まない）。本体は findById で 1 件ずつ読む。
 * - 期限は締結済み契約の `deadlines[]` が正本で、保存と**同じトランザクション**で投影へ出す（期限の近い順の一覧に使う）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { ContractDocument, ContractDocumentStatus, ContractDocumentSummary } from './document';
import type { Playbook } from './playbook';
import type { ContractReview } from './review';
import type { DeadlineKind, SignedContract, SignedContractStatus } from './signed-contract';

export interface ContractPlaybookRepository {
  save(playbook: Playbook): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<Playbook | null>;
  /** 作成の古い順（createdAt 昇順 → id 昇順）。 */
  list(scope: TenantScope): Promise<readonly Playbook[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface ContractDocumentListOptions {
  readonly status?: ContractDocumentStatus;
  readonly limit?: number;
}

export interface ContractDocumentRepository {
  save(document: ContractDocument): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ContractDocument | null>;
  /** 新しいものが先（createdAt 降順 → id 昇順）。 */
  list(scope: TenantScope, options?: ContractDocumentListOptions): Promise<readonly ContractDocumentSummary[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface ContractReviewRepository {
  save(review: ContractReview): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ContractReview | null>;
  /** その文書のレビュー（新しいものが先）。 */
  listByDocument(scope: TenantScope, documentId: string): Promise<readonly ContractReview[]>;
  /** 戻り値は消した件数。 */
  deleteByDocument(scope: TenantScope, documentId: string): Promise<number>;
}

export interface SignedContractListOptions {
  readonly status?: SignedContractStatus;
  /** 相手方名の部分一致。 */
  readonly counterparty?: string;
}

/** 期限の投影 1 行。 */
export interface DeadlineProjection {
  readonly contractId: string;
  readonly deadlineId: string;
  readonly kind: DeadlineKind;
  readonly dueDate: string;
}

export interface SignedContractRepository {
  /** 契約と期限の投影を同じトランザクションで書く（期限は削除 → 再挿入）。 */
  save(contract: SignedContract): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<SignedContract | null>;
  findByDocument(scope: TenantScope, documentId: string): Promise<SignedContract | null>;
  /** 締結日の新しい順（signedDate 降順 → id 昇順）。 */
  list(scope: TenantScope, options?: SignedContractListOptions): Promise<readonly SignedContract[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
  /** 未完了の期限（期限日の昇順 → 契約 id → 期限 id）。`dueOnOrBefore` で上限を切れる。 */
  listOpenDeadlines(scope: TenantScope, options?: { readonly dueOnOrBefore?: string }): Promise<readonly DeadlineProjection[]>;
}

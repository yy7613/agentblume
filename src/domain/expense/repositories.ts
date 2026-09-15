/**
 * ドメイン: 経費精算 BC のリポジトリ境界（docs/21 §12.1 / §20.8.3）。
 *
 * - 規程はワークスペースに 1 つ（scope がキー）。無ければ null（application が初期テンプレートを返す。保存はしない）。
 * - 申請は (scope, id) で upsert。一覧は**要約**（作成日時の降順 → id 昇順）。明細の事実は含むが証憑本体は含まない。
 * - 申請の保存は、重複検出の索引（明細ごとの取引日・金額・支払先キー・費目・画像ハッシュ）と、実用化の派生索引
 *   （`expense_claim_refs` / `expense_item_refs` / `expense_claim_approvers`）を同じトランザクションで入れ直す。
 * - 証憑本体は申請から分けて保存する（一覧・判定・ツールで画像を読まないため）。
 * - ワークスペースに 1 つの設定（組織・振込元・カード・運賃）は kind ごとに 1 行。無ければ null。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { AdvanceStatus, ExpenseAdvance } from './advance';
import type { CardMatchableItem, CardTransactionStatus, ExpenseCardImport, ExpenseCardTransaction } from './card';
import type { ClaimStatus, ExpenseClaim, ExpenseClaimSummary } from './claim';
import type { DuplicateCandidate } from './duplicates';
import type { ExpenseEmployee } from './employee';
import type { Verdict } from './judgment';
import type { ExpensePayoutBatch, PayoutBatchStatus } from './payout';
import type { ExpensePolicy } from './policy';
import type { ExpensePolicyHearing, HearingStatus } from './policy-hearing';
import type { ExpenseReceipt } from './receipt';
import type { ExpenseSettingsKind, ExpenseSettingsOf } from './settings';

export interface ExpensePolicyRepository {
  get(scope: TenantScope): Promise<ExpensePolicy | null>;
  save(scope: TenantScope, policy: ExpensePolicy): Promise<void>;
}

export interface ExpenseClaimListOptions {
  readonly status?: ClaimStatus;
  /** 複数の状態のどれか（`status` と両方あれば両方を満たすもの）。 */
  readonly statuses?: readonly ClaimStatus[];
  readonly verdict?: Verdict;
  /** 申請者名の部分一致（NFKC・空白除去・小文字化して比べる）。 */
  readonly claimant?: string;
  /** 申請期間の重なり（両端を含む）。 */
  readonly from?: string;
  readonly to?: string;
  /** 紐付けた従業員（`expense_claim_refs.employee_id`）。 */
  readonly employeeId?: string;
  readonly departmentId?: string;
  readonly advanceId?: string;
  /** 現在の段の承認者にこの従業員が入っている（`expense_claim_approvers`）。 */
  readonly awaitingEmployeeId?: string;
  /** 従業員に紐付いていない申請だけ。 */
  readonly unlinked?: boolean;
  readonly limit?: number;
}

export interface DuplicateCandidateQuery {
  /** 自分の明細の 取引日 × 金額。 */
  readonly keys: readonly { readonly transactionDate: string; readonly amount: number }[];
  readonly sha256s: readonly string[];
  /** 自分の申請（候補から除く）。 */
  readonly excludeClaimId?: string;
}

/** 集計の入力（明細 1 件 = 1 行。§20.3.7）。 */
export interface ExpenseItemFact {
  readonly claimId: string;
  readonly itemId: string;
  readonly status: ClaimStatus;
  readonly transactionDate?: string;
  /** 金額（0 以下も行は作る。集計は 1 円以上だけを数える）。 */
  readonly amount?: number;
  readonly categoryId?: string;
  /** 会社払いの明細か（`facts.corporatePayment === true`）。 */
  readonly corporate: boolean;
  readonly employeeId?: string;
  readonly departmentId?: string;
  readonly claimantName: string;
  readonly departmentText?: string;
  readonly approvedAt?: string;
  readonly settledAt?: string;
}

export interface ExpenseItemFactQuery {
  readonly transactionFrom?: string;
  readonly transactionTo?: string;
  readonly approvedFrom?: string;
  readonly approvedTo?: string;
  readonly settledFrom?: string;
  readonly settledTo?: string;
  readonly statuses?: readonly ClaimStatus[];
  readonly limit: number;
}

export interface CardCandidateQuery {
  /** 明細の取引日の範囲（両端を含む）。 */
  readonly from: string;
  readonly to: string;
  /** 金額の範囲のどれか（両端を含む）。空なら金額で絞らない。 */
  readonly amounts: readonly { readonly min: number; readonly max: number }[];
  readonly excludeClaimId?: string;
}

export interface ExpenseClaimRepository {
  /**
   * `receiptHashes` は明細 id → 証憑の SHA-256（索引用）。`approvers` は現在の段の承認者の従業員 id
   * （`expense_claim_approvers` を入れ直す。省略 = 空）。
   */
  save(claim: ExpenseClaim, receiptHashes: ReadonlyMap<string, string>, approvers?: readonly string[]): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpenseClaim | null>;
  /** ids の順、見つかったものだけ。 */
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseClaim[]>;
  /** createdAt 降順 → id 昇順。 */
  list(scope: TenantScope, options?: ExpenseClaimListOptions): Promise<readonly ExpenseClaimSummary[]>;
  /** 索引の行（重複・派生索引）も消す。戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, id: string): Promise<boolean>;
  findDuplicateCandidates(scope: TenantScope, query: DuplicateCandidateQuery): Promise<readonly DuplicateCandidate[]>;
  /** 集計の入力（claim_id → item_id の昇順。limit 件まで）。申請の record_json を読まない。 */
  listItemFacts(scope: TenantScope, query: ExpenseItemFactQuery): Promise<readonly ExpenseItemFact[]>;
  /** カード照合の候補の明細（取引日と金額がある明細。取引日 → claim_id → item_id の昇順）。 */
  findCardCandidates(scope: TenantScope, query: CardCandidateQuery): Promise<readonly CardMatchableItem[]>;
}

export interface ExpenseReceiptRepository {
  save(receipt: ExpenseReceipt): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpenseReceipt | null>;
  findByItem(scope: TenantScope, claimId: string, itemId: string): Promise<ExpenseReceipt | null>;
  /** 申請の明細 id → SHA-256（画像本体を読まない。索引の入れ直しと判定に使う）。 */
  hashesByClaim(scope: TenantScope, claimId: string): Promise<ReadonlyMap<string, string>>;
  /** 戻り値は消した件数。 */
  deleteByClaim(scope: TenantScope, claimId: string): Promise<number>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

/* ---------------------------------------------------------------------------
 * 実用化（§20.8.3）
 * ------------------------------------------------------------------------- */

export interface ExpenseEmployeeListOptions {
  readonly enabled?: boolean;
  readonly departmentId?: string;
  /** 氏名・カナ・社員番号の部分一致（NFKC・空白除去・小文字化）。 */
  readonly query?: string;
  readonly limit?: number;
}

export interface ExpenseEmployeeRepository {
  /**
   * `expense_employee_subjects` も入れ直す。社員番号（code_key）・ログイン ID の一意違反は、どの従業員と重なるかを付けた
   * `ExpenseDomainError`（`details.field` / `details.conflictEmployeeId`）。
   */
  save(employee: ExpenseEmployee): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpenseEmployee | null>;
  /** ids の順、見つかったものだけ。 */
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseEmployee[]>;
  findBySubject(scope: TenantScope, subject: string): Promise<ExpenseEmployee | null>;
  /** `employeeCodeKey` の一覧で引く（有効・無効を問わない。code_key 昇順）。 */
  findByCodeKeys(scope: TenantScope, codeKeys: readonly string[]): Promise<readonly ExpenseEmployee[]>;
  /** `employeeNameKey` の完全一致（有効・無効を問わない。id 昇順）。 */
  findByNameKey(scope: TenantScope, nameKey: string): Promise<readonly ExpenseEmployee[]>;
  /** 有効が先 → name_key 昇順 → id 昇順。 */
  list(scope: TenantScope, options?: ExpenseEmployeeListOptions): Promise<readonly ExpenseEmployee[]>;
  countEnabled(scope: TenantScope): Promise<number>;
}

/** kind ごとに型付きの薄い包みを application（`settings-store.ts`）が作る。 */
export interface ExpenseSettingsRepository {
  get<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K): Promise<ExpenseSettingsOf<K> | null>;
  save<K extends ExpenseSettingsKind>(scope: TenantScope, kind: K, value: ExpenseSettingsOf<K>): Promise<void>;
}

export interface ExpenseAdvanceRepository {
  save(advance: ExpenseAdvance): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpenseAdvance | null>;
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseAdvance[]>;
  /** createdAt 降順 → id 昇順。 */
  list(scope: TenantScope, options?: { readonly status?: AdvanceStatus; readonly employeeId?: string; readonly limit?: number }): Promise<readonly ExpenseAdvance[]>;
}

export interface ExpenseCardTransactionListOptions {
  readonly status?: CardTransactionStatus;
  readonly cardId?: string;
  /** 利用日の範囲（両端を含む）。 */
  readonly from?: string;
  readonly to?: string;
  readonly claimId?: string;
  readonly limit?: number;
}

export interface ExpenseCardRepository {
  /**
   * 取込 1 回と利用行を 1 トランザクションで保存する。同じ `dedupeKey` の行は入れず `duplicates` に数える。
   * 同じファイル（SHA-256 一致）は `ExpenseCardDuplicateImportError`（何も保存しない）。
   */
  saveImport(importRecord: ExpenseCardImport, transactions: readonly ExpenseCardTransaction[]): Promise<{ readonly inserted: number; readonly duplicates: number }>;
  findImport(scope: TenantScope, id: string): Promise<ExpenseCardImport | null>;
  /** createdAt 降順 → id 昇順。 */
  listImports(scope: TenantScope, options?: { readonly limit?: number }): Promise<readonly ExpenseCardImport[]>;
  /** 取込と、その取込の利用行を消す。戻り値は消した利用行の件数（取込が無ければ -1）。 */
  deleteImport(scope: TenantScope, id: string): Promise<number>;
  /** 利用行の状態・照合の更新（upsert）。 */
  saveTransactions(transactions: readonly ExpenseCardTransaction[]): Promise<void>;
  findTransaction(scope: TenantScope, id: string): Promise<ExpenseCardTransaction | null>;
  /** 利用日の降順 → id 昇順。 */
  listTransactions(scope: TenantScope, options?: ExpenseCardTransactionListOptions): Promise<readonly ExpenseCardTransaction[]>;
  /** 照合の候補（利用日の範囲 × 金額の範囲のどれか。利用日 → id の昇順）。 */
  findTransactionsForMatching(scope: TenantScope, query: CardCandidateQuery): Promise<readonly ExpenseCardTransaction[]>;
  /** カードごとの取込範囲（periodFrom〜periodTo の和集合を区間で返す。cardId → from の昇順）。 */
  coverage(scope: TenantScope, cardIds?: readonly string[]): Promise<readonly { readonly cardId: string; readonly from: string; readonly to: string }[]>;
  /** 申請の削除で照合を外す（matched → unmatched）。戻り値は外した件数。 */
  unlinkClaim(scope: TenantScope, claimId: string): Promise<number>;
}

export interface ExpensePayoutBatchRepository {
  save(batch: ExpensePayoutBatch): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpensePayoutBatch | null>;
  /** createdAt 降順 → id 昇順。 */
  list(scope: TenantScope, options?: { readonly status?: PayoutBatchStatus; readonly limit?: number }): Promise<readonly ExpensePayoutBatch[]>;
  /** 取消されていない（exported / confirmed）バッチのうち、指定の申請を含むもの。 */
  findActiveByClaimIds(scope: TenantScope, claimIds: readonly string[]): Promise<readonly ExpensePayoutBatch[]>;
}

export interface ExpensePolicyHearingRepository {
  save(hearing: ExpensePolicyHearing): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<ExpensePolicyHearing | null>;
  /** updatedAt 降順 → id 昇順。 */
  list(scope: TenantScope, options?: { readonly status?: HearingStatus; readonly limit?: number }): Promise<readonly ExpensePolicyHearing[]>;
}

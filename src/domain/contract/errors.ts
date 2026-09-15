/**
 * ドメイン: 契約書レビュー（contract）BC のエラー型。
 *
 * - 不変条件違反（審査基準・文書・レビュー・締結済み契約）は `ContractDomainError`（api で 400）。
 * - 存在しない参照は `*NotFoundError`（404）。
 * - 状態が許さない操作（締結済み文書の本文変更、確定済みレビューの判断変更、二重の締結登録）は
 *   `ContractStateError`（409）。入力は正しいが「今は」できないので 400 と分ける。
 *
 * 判定できないことはエラーではなく結果（`unresolved` + 理由コード）で表す（ADR-0042 §4）。
 */

/** 不変条件違反（入力不正）。api で 400。 */
export class ContractDomainError extends Error {
  readonly code = 'CONTRACT_DOMAIN';
  /** 画面が「直す場所」を示すための追加の項目（例: 判断が未入力のトピック id の一覧）。 */
  constructor(message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ContractDomainError';
  }
}

/** 状態が許さない操作。api で 409。`documentId` / `contractId` は画面が「開く場所」に使う。 */
export class ContractStateError extends Error {
  readonly code = 'CONTRACT_STATE';
  constructor(message: string, readonly target?: { readonly documentId?: string; readonly contractId?: string; readonly reviewId?: string }) {
    super(message);
    this.name = 'ContractStateError';
  }
}

/** 指定 id の審査基準が見つからない。api で 404。 */
export class ContractPlaybookNotFoundError extends Error {
  readonly code = 'CONTRACT_PLAYBOOK_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ContractPlaybookNotFoundError';
  }
}

/** 指定 id の文書が見つからない。api で 404。 */
export class ContractDocumentNotFoundError extends Error {
  readonly code = 'CONTRACT_DOCUMENT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ContractDocumentNotFoundError';
  }
}

/** 指定 id のレビューが見つからない。api で 404。 */
export class ContractReviewNotFoundError extends Error {
  readonly code = 'CONTRACT_REVIEW_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ContractReviewNotFoundError';
  }
}

/** 指定 id の締結済み契約（または期限）が見つからない。api で 404。 */
export class SignedContractNotFoundError extends Error {
  readonly code = 'CONTRACT_SIGNED_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'SignedContractNotFoundError';
  }
}

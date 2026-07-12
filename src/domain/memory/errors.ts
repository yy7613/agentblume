/**
 * ドメイン: 長期記憶（Wiki / MemoryProposal）のエラー（v21 実装契約 §1.3 / ADR-0016）
 */

/** 記憶ドメインの不変条件違反（入力不正・不正な状態遷移）。api で 400。 */
export class MemoryDomainError extends Error {
  readonly code = 'MEMORY_DOMAIN';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryDomainError';
  }
}

/** WikiPage が見つからない。api で 404。 */
export class WikiPageNotFoundError extends Error {
  readonly code = 'WIKI_PAGE_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'WikiPageNotFoundError';
  }
}

export class WikiSpaceNotFoundError extends Error {
  readonly code = 'WIKI_SPACE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'WikiSpaceNotFoundError'; }
}

/** MemoryProposal が見つからない。api で 404。 */
export class MemoryProposalNotFoundError extends Error {
  readonly code = 'MEMORY_PROPOSAL_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryProposalNotFoundError';
  }
}

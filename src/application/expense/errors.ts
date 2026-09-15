/**
 * application層: 経費精算のポート越しに現れるエラー（docs/21 §8.1）。
 *
 * ドメインの不変条件違反ではないので `src/domain/expense/errors.ts` には置かない。
 */

/**
 * 仕訳側が下書きを拒否した（科目がマスタに無い・無効など）。`JournalDraftSink` の実装（composition）が
 * 仕訳の `JournalDomainError` をこれに包み直す（経費の application は仕訳の application / エラー型を知らない）。
 */
export class JournalDraftRejectedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`the journal rejected the draft entry: ${detail}`);
    this.name = 'JournalDraftRejectedError';
    this.detail = detail;
  }
}

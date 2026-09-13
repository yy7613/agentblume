/**
 * ドメイン: 仕訳（journal）BC のエラー型。
 *
 * - 不変条件違反（科目マスタ・文書・ルール・仕訳・ヒアリング）は `JournalDomainError`（api で 400）。
 * - 存在しない参照は `*NotFoundError`（404）。
 * - CSV 取込の入力不正は `JournalCsvImportError`（400。行番号があれば `row` に持つ）。
 * - 出力の前提違反（未対応の形式など）は `JournalExportError`（400）。
 *
 * 判定が「確定できなかった」ことはエラーではなく判定結果（`undecided`）で表す。
 */

/** 不変条件違反（入力不正）。api で 400。 */
export class JournalDomainError extends Error {
  readonly code = 'JOURNAL_DOMAIN';
  constructor(message: string) {
    super(message);
    this.name = 'JournalDomainError';
  }
}

/** 指定 id の文書が見つからない。api で 404。 */
export class JournalDocumentNotFoundError extends Error {
  readonly code = 'JOURNAL_DOCUMENT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'JournalDocumentNotFoundError';
  }
}

/** 指定 id のルールが見つからない。api で 404。 */
export class JournalRuleNotFoundError extends Error {
  readonly code = 'JOURNAL_RULE_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'JournalRuleNotFoundError';
  }
}

/** 指定 id の仕訳が見つからない。api で 404。 */
export class JournalEntryNotFoundError extends Error {
  readonly code = 'JOURNAL_ENTRY_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'JournalEntryNotFoundError';
  }
}

/** 指定 id のヒアリングが見つからない。api で 404。 */
export class JournalHearingNotFoundError extends Error {
  readonly code = 'JOURNAL_HEARING_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'JournalHearingNotFoundError';
  }
}

/** CSV 取込の入力不正（列名署名の不一致・引用符の閉じ忘れなど）。行が特定できるときは `row`（1 始まり）を持つ。 */
export class JournalCsvImportError extends Error {
  readonly code = 'JOURNAL_CSV_IMPORT';
  readonly row: number | undefined;
  constructor(message: string, row?: number) {
    super(message);
    this.name = 'JournalCsvImportError';
    this.row = row;
  }
}

/** 出力の前提違反（未対応の形式・出力対象なし）。api で 400。 */
export class JournalExportError extends Error {
  readonly code = 'JOURNAL_EXPORT';
  constructor(message: string) {
    super(message);
    this.name = 'JournalExportError';
  }
}

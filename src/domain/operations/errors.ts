export class FeedbackValidationError extends Error {
  readonly code = 'FEEDBACK_VALIDATION';
  constructor(message: string) { super(message); this.name = 'FeedbackValidationError'; }
}

/**
 * バックアップ／復元の前提が満たされていない（揮発DB・壊れたマニフェスト・
 * このビルドより新しいスキーマ・復元先が使用中）。いずれも**利用者の操作で直せる**ため、
 * 原因と次の一手が分かる文言を持たせる。
 */
export class BackupValidationError extends Error {
  readonly code = 'BACKUP_VALIDATION';
  constructor(message: string) { super(message); this.name = 'BackupValidationError'; }
}

/** 指定した名前のバックアップがバックアップ置き場に無い。 */
export class BackupNotFoundError extends Error {
  readonly code = 'BACKUP_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'BackupNotFoundError'; }
}

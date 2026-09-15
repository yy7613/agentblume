/**
 * ドメイン: 経費精算（expense）BC のエラー型（docs/21 §4.6 / §10.1 / §20.9.5）。
 *
 * - 入力の形の不正・保存済みレコードの不変条件違反は `ExpenseDomainError`（400）。CSV の行が分かれば `row`、
 *   直す欄が分かれば `details.field`（従業員の一意違反なら重なった相手 `details.conflictEmployeeId`、問題の従業員そのものなら `details.employeeId`）。
 * - 汎用 CSV 取込の前提違反（必須列が無い等）は `ExpenseCsvImportError`（400）。
 * - 参照切れは `Expense*NotFoundError`（404）。
 * - 状態遷移の拒否（差し戻し理由が残る申請の承認など）は `ExpenseTransitionError`（409）。
 *   画面が「承認できない理由」を並べられるよう `blockingReasons` を持つ。
 * - 仕訳連携の失敗は `ExpenseJournalLinkError`（409）。明細ごとの原因と直す場所を `problems` に持つ。
 * - 振込データの点検で止めたものは `ExpensePayoutBlockedError`（409）。直す場所を全件 `problems` に持つ。
 *
 * 規程違反そのものはエラーではなく判定結果（理由コード）で表す。
 */

/** `ExpenseDomainError` に載せる「直す場所」。 */
export interface ExpenseDomainErrorDetails {
  /** 直す欄（例 `bankAccount.holderKana` / `code` / `loginSubjects`）。 */
  readonly field?: string;
  /** 一意違反で重なった従業員。 */
  readonly conflictEmployeeId?: string;
  /**
   * 問題のある従業員そのもの（重なりではない。上長の循環の相手・口座番号を開封できなかった従業員など）。
   * 画面がその従業員を開く導線に使う。
   */
  readonly employeeId?: string;
  /** 名義カナの変換結果（変換後の形と、直すべき文字の位置）。 */
  readonly converted?: { readonly text: string; readonly bytes: number; readonly invalid: readonly { readonly char: string; readonly index: number }[] };
}

/** 不変条件違反（入力不正）。api で 400。 */
export class ExpenseDomainError extends Error {
  readonly code = 'EXPENSE_DOMAIN';
  readonly row: number | undefined;
  readonly details: ExpenseDomainErrorDetails | undefined;
  constructor(message: string, row?: number, details?: ExpenseDomainErrorDetails) {
    super(message);
    this.name = 'ExpenseDomainError';
    this.row = row;
    this.details = details;
  }
}

/** 汎用 CSV の取込全体の前提違反（取引日・金額の列が無い等）。api で 400。 */
export class ExpenseCsvImportError extends Error {
  readonly code = 'EXPENSE_CSV_IMPORT';
  readonly row: number | undefined;
  constructor(message: string, row?: number) {
    super(message);
    this.name = 'ExpenseCsvImportError';
    this.row = row;
  }
}

/** 指定 id の申請が見つからない。api で 404。 */
export class ExpenseClaimNotFoundError extends Error {
  readonly code = 'EXPENSE_CLAIM_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ExpenseClaimNotFoundError';
  }
}

/** 申請の中に指定 id の明細が無い。api で 404。 */
export class ExpenseItemNotFoundError extends Error {
  readonly code = 'EXPENSE_ITEM_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ExpenseItemNotFoundError';
  }
}

/** 明細に証憑本体が無い。api で 404。 */
export class ExpenseReceiptNotFoundError extends Error {
  readonly code = 'EXPENSE_RECEIPT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ExpenseReceiptNotFoundError';
  }
}

/* 実用化の参照切れ（§20.9.5）。code は画面の見出しの鍵なので 1 クラス 1 code にする。 */

export class ExpenseEmployeeNotFoundError extends Error {
  readonly code = 'EXPENSE_EMPLOYEE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpenseEmployeeNotFoundError'; }
}

export class ExpenseAdvanceNotFoundError extends Error {
  readonly code = 'EXPENSE_ADVANCE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpenseAdvanceNotFoundError'; }
}

export class ExpensePayoutNotFoundError extends Error {
  readonly code = 'EXPENSE_PAYOUT_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpensePayoutNotFoundError'; }
}

export class ExpenseCardTransactionNotFoundError extends Error {
  readonly code = 'EXPENSE_CARD_TRANSACTION_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpenseCardTransactionNotFoundError'; }
}

export class ExpenseCardImportNotFoundError extends Error {
  readonly code = 'EXPENSE_CARD_IMPORT_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpenseCardImportNotFoundError'; }
}

export class ExpenseHearingNotFoundError extends Error {
  readonly code = 'EXPENSE_HEARING_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'ExpenseHearingNotFoundError'; }
}

/** 従業員 CSV の取込全体の前提違反。api で 400。 */
export class ExpenseEmployeeCsvImportError extends Error {
  readonly code = 'EXPENSE_EMPLOYEE_CSV_IMPORT';
  readonly row: number | undefined;
  readonly missingColumns: readonly string[] | undefined;
  constructor(message: string, options: { readonly row?: number; readonly missingColumns?: readonly string[] } = {}) {
    super(message);
    this.name = 'ExpenseEmployeeCsvImportError';
    this.row = options.row;
    this.missingColumns = options.missingColumns === undefined ? undefined : [...options.missingColumns];
  }
}

/** カード明細 CSV の取込の前提違反（列の対応が決まらない等）。api で 400。 */
export class ExpenseCardImportError extends Error {
  readonly code = 'EXPENSE_CARD_IMPORT';
  readonly row: number | undefined;
  readonly missingColumns: readonly string[] | undefined;
  /** 見出しから推定した列の対応（利用者が選び直す起点）。 */
  readonly suggestedMapping: Readonly<Record<string, string>> | undefined;
  constructor(message: string, options: { readonly row?: number; readonly missingColumns?: readonly string[]; readonly suggestedMapping?: Readonly<Record<string, string>> } = {}) {
    super(message);
    this.name = 'ExpenseCardImportError';
    this.row = options.row;
    this.missingColumns = options.missingColumns === undefined ? undefined : [...options.missingColumns];
    this.suggestedMapping = options.suggestedMapping === undefined ? undefined : { ...options.suggestedMapping };
  }
}

/** 同じファイル（SHA-256 一致）の二重取込。api で 409。 */
export class ExpenseCardDuplicateImportError extends Error {
  readonly code = 'EXPENSE_CARD_DUPLICATE_IMPORT';
  readonly importId: string;
  readonly importedAt: string;
  constructor(message: string, importId: string, importedAt: string) {
    super(message);
    this.name = 'ExpenseCardDuplicateImportError';
    this.importId = importId;
    this.importedAt = importedAt;
  }
}

/** 案を作った後に規程が保存された（ヒアリングの差分が古い）。api で 409。 */
export class ExpensePolicyConflictError extends Error {
  readonly code = 'EXPENSE_POLICY_CONFLICT';
  readonly currentUpdatedAt: string;
  constructor(message: string, currentUpdatedAt: string) {
    super(message);
    this.name = 'ExpensePolicyConflictError';
    this.currentUpdatedAt = currentUpdatedAt;
  }
}

/** モデルを使う機能が使えない理由。 */
export type ExpenseModelUnavailableReason = 'model' | 'structured-output' | 'vision';

/** 経費専用の追加読取が使えない（モデル未設定など）。api で 409。 */
export class ExpenseDetailExtractionUnavailableError extends Error {
  readonly code = 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE';
  readonly missing: ExpenseModelUnavailableReason;
  constructor(message: string, missing: ExpenseModelUnavailableReason) {
    super(message);
    this.name = 'ExpenseDetailExtractionUnavailableError';
    this.missing = missing;
  }
}

/** 規程のヒアリングが使えない（モデル未設定など）。api で 409。 */
export class ExpenseHearingUnavailableError extends Error {
  readonly code = 'EXPENSE_HEARING_UNAVAILABLE';
  readonly missing: ExpenseModelUnavailableReason;
  constructor(message: string, missing: ExpenseModelUnavailableReason) {
    super(message);
    this.name = 'ExpenseHearingUnavailableError';
    this.missing = missing;
  }
}

/** ヒアリングの応答がスキーマに合わない（修復を 1 回求めても直らない）。api で 502。 */
export class ExpenseHearingSchemaError extends Error {
  readonly code = 'EXPENSE_HEARING_SCHEMA';
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = 'ExpenseHearingSchemaError';
    this.issues = [...issues];
  }
}

/**
 * 遷移を妨げている理由 1 件。`code` は理由コード（§4）か、判定そのものの問題を表す擬似コード
 * （`judgment-missing` / `judgment-stale` / `self-approval`、§20.5.1 の `approval-*`）。
 * `params` は擬似コードの文言の差し込み値（段の名前・承認者の名前など）。
 */
export interface ExpenseBlockingReason {
  readonly code: string;
  readonly itemId?: string;
  readonly params?: Readonly<Record<string, string | number | boolean | null>>;
}

/** 一括操作で対象外の状態だった申請（精算済みの印など）。 */
export interface ExpenseClaimStateRef {
  readonly id: string;
  readonly status: string;
}

/** 状態遷移の拒否。api で 409。 */
export class ExpenseTransitionError extends Error {
  readonly code = 'EXPENSE_TRANSITION';
  readonly blockingReasons: readonly ExpenseBlockingReason[];
  /** 次にやる操作（日本語の 1 文）。画面は理由カードの上に出す。 */
  readonly nextStep: string | undefined;
  readonly claims: readonly ExpenseClaimStateRef[];
  constructor(message: string, options: { readonly blockingReasons?: readonly ExpenseBlockingReason[]; readonly nextStep?: string; readonly claims?: readonly ExpenseClaimStateRef[] } = {}) {
    super(message);
    this.name = 'ExpenseTransitionError';
    this.blockingReasons = [...(options.blockingReasons ?? [])];
    this.nextStep = options.nextStep;
    this.claims = [...(options.claims ?? [])];
  }
}

/** 仕訳連携の問題 1 件の直す場所。 */
export type ExpenseJournalLinkFixTarget = 'item' | 'policy-category' | 'policy-journal' | 'journal-chart' | 'organization';

/** 仕訳連携で下書きを作れない理由 1 件（§8.2 / §8.3 / §20.12）。 */
export interface ExpenseJournalLinkProblem {
  readonly itemId?: string;
  readonly code: string;
  /** 原因と次の一手（日本語）。 */
  readonly message: string;
  readonly fixTarget: ExpenseJournalLinkFixTarget;
  readonly categoryId?: string;
  readonly accountId?: string;
  readonly departmentId?: string;
}

/** 仕訳連携の失敗。api で 409。作成済みの仕訳があれば `createdEntryIds` に並べる（「続きを作成」の根拠）。 */
export class ExpenseJournalLinkError extends Error {
  readonly code = 'EXPENSE_JOURNAL_LINK';
  readonly problems: readonly ExpenseJournalLinkProblem[];
  readonly createdEntryIds: readonly string[];
  constructor(message: string, problems: readonly ExpenseJournalLinkProblem[], createdEntryIds: readonly string[] = []) {
    super(message);
    this.name = 'ExpenseJournalLinkError';
    this.problems = [...problems];
    this.createdEntryIds = [...createdEntryIds];
  }
}

/* ---------------------------------------------------------------------------
 * 振込データの点検（§20.5.2）。止める（blocking）と確認必須の警告（warning）に分ける。
 * コードの集合はここ（葉）に置く。payout.ts が文言を、B の planPayout が組み立てを持つ。
 * ------------------------------------------------------------------------- */

export const EXPENSE_PAYOUT_BLOCKING_CODES = [
  'payout-source-missing', 'payout-employee-unlinked', 'payout-bank-account-missing', 'payout-bank-account-invalid',
  'payout-holder-kana-invalid', 'payout-holder-kana-too-long', 'payout-bank-name-missing', 'payout-amount-too-large',
  'payout-too-many-records', 'payout-already-exported', 'payout-claim-not-approved', 'payout-transfer-date-invalid',
] as const;
export const EXPENSE_PAYOUT_WARNING_CODES = [
  'payout-transfer-date-weekend', 'payout-bank-account-recently-changed', 'payout-holder-kana-converted', 'payout-no-journal',
] as const;
export type ExpensePayoutBlockingCode = (typeof EXPENSE_PAYOUT_BLOCKING_CODES)[number];
export type ExpensePayoutWarningCode = (typeof EXPENSE_PAYOUT_WARNING_CODES)[number];
export type ExpensePayoutProblemCode = ExpensePayoutBlockingCode | ExpensePayoutWarningCode;

/** 点検の導線先（画面のボタン）。 */
export type ExpensePayoutFixTarget =
  | 'payout-settings' | 'claim-claimant' | 'employee-links' | 'employee-bank-account' | 'employee-history'
  | 'payout-batch' | 'approve' | 'transfer-date' | 'settle' | 'none';

export interface ExpensePayoutProblem {
  readonly code: ExpensePayoutProblemCode;
  readonly employeeId?: string;
  readonly claimId?: string;
  readonly advanceId?: string;
  readonly field?: string;
  /** 原因と次の一手（日本語）。`payoutProblemText` で作る。 */
  readonly message: string;
  readonly fixTarget: ExpensePayoutFixTarget;
  readonly params?: Readonly<Record<string, string | number | boolean | null>>;
}

/** 振込データを作れない（止める理由が 1 件以上、または警告が未確認）。api で 409。 */
export class ExpensePayoutBlockedError extends Error {
  readonly code = 'EXPENSE_PAYOUT_BLOCKED';
  readonly problems: readonly ExpensePayoutProblem[];
  readonly warnings: readonly ExpensePayoutProblem[];
  constructor(message: string, problems: readonly ExpensePayoutProblem[], warnings: readonly ExpensePayoutProblem[] = []) {
    super(message);
    this.name = 'ExpensePayoutBlockedError';
    this.problems = [...problems];
    this.warnings = [...warnings];
  }
}

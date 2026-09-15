/**
 * ドメイン: 判定の拡張点（docs/21 §20.3.1 / ADR-0043 §2。骨格。凍結）。
 *
 * `checkClaim` は純粋関数のまま、系統ごとの**事実**（`CheckExtensionsInput`）を引数で受け、系統ごとの**検査関数**
 * （`ExpenseCheckContributor`）が理由を足す。事実は application の `ExpenseCheckFactsProvider` が索引から集め、判定に I/O もモデルも入れない。
 *
 * 循環依存（depcruise の `no-circular`）を避けるため、事実の型は系統ごとの葉 `<系統>/check-facts.ts` に置き、
 * contributor の本体（`<系統>/check-<系統>.ts`）はこのファイルの型だけを import する。`check.ts` の型もここへ持ち込まない。
 *
 * 系統をまたぐ事実（交通費の照合に要る申請者の通勤定期など）は、系統の型に依存しないよう**使う側の provider が自分で読む**
 * （C の provider が `EmployeeDirectoryPort` で定期を読み、`InputCheckFacts` に入れる）。
 */
import type { Claimant, ClaimPeriod, ExpenseItem } from './claim';
import type { InputCheckFacts } from './input/check-facts';
import type { ReasonParamValue } from './judgment';
import type { MoneyCheckFacts } from './money/check-facts';
import type { PeopleCheckFacts } from './people/check-facts';
import type { ExpenseCategory, ExpensePolicy } from './policy';
import type { ExpenseReasonCode, Severity } from './reason-codes';

export interface CheckExtensionsInput {
  /** 申請者の従業員（有効か・部門）、マスタを使っているか、承認計画の未解決（A）。 */
  readonly people?: PeopleCheckFacts;
  /** 紐付く仮払の要約、カード利用の候補（未照合 or この申請に照合済み）、明細の取込範囲（B）。 */
  readonly money?: MoneyCheckFacts;
  /** 運賃マスタ、駅名の別名、申請者の通勤定期（C）。 */
  readonly input?: InputCheckFacts;
}

/** 判定に渡す申請（`CheckClaimInput.claim`）。 */
export interface CheckedClaim {
  readonly id: string;
  readonly period: ClaimPeriod;
  readonly items: readonly ExpenseItem[];
  readonly claimant?: Claimant;
  readonly advanceId?: string;
}

/** contributor に渡す、骨格が評価済みの値（打ち切りに使う）。 */
export interface ItemEvaluation {
  readonly item: ExpenseItem;
  readonly index: number;
  /** 画面・文言の明細の呼び名（`itemLabel`）。 */
  readonly description: string;
  /** 有効な費目（未決定・規程に無い・無効なら undefined）。 */
  readonly category?: ExpenseCategory;
  /** 判定に使える金額（1 円以上。無ければ undefined = `amount-missing`）。 */
  readonly amount?: number;
  readonly date?: string;
  /** 骨格がこの明細に出した理由（重さの上書きで `off` にしたものは含まない）。 */
  readonly emitted: ReadonlySet<ExpenseReasonCode>;
}

/** contributor が返す理由の下書き。重さは骨格が規程から決める（`forcedSeverity` は弱い一致を常に要確認にするとき）。 */
export interface ReasonDraft {
  readonly code: ExpenseReasonCode;
  /** 文言の差し込み値（§20.4 の `{…}` と同じ名前）。明細の理由には骨格が `description` を足す。 */
  readonly params: Readonly<Record<string, ReasonParamValue>>;
  readonly forcedSeverity?: Severity;
}

export type ExpenseCheckContributorId = 'people' | 'money' | 'input';

export interface ExpenseCheckContributor {
  readonly id: ExpenseCheckContributorId;
  /** 出してよいコード。3 つの集合は互いに素で、既存 27 コードを含まない（テストで固定）。 */
  readonly codes: readonly ExpenseReasonCode[];
  /** 申請の理由（明細が無い申請でも呼ぶ）。 */
  claimReasons?(claim: CheckedClaim, policy: ExpensePolicy, extensions: CheckExtensionsInput): readonly ReasonDraft[];
  /** 明細の理由（骨格の評価の後に呼ぶ。並びは骨格が評価順へ安定ソートする）。 */
  itemReasons?(evaluation: ItemEvaluation, policy: ExpensePolicy, extensions: CheckExtensionsInput, claim?: CheckedClaim): readonly ReasonDraft[];
}

/** provider の結果を 1 つにまとめる（系統のキーは互いに重ならないので、後から来た同じキーは上書きする）。 */
export function mergeCheckExtensions(parts: readonly Partial<CheckExtensionsInput>[]): CheckExtensionsInput {
  return parts.reduce<CheckExtensionsInput>((merged, part) => ({ ...merged, ...Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined)) }), {});
}

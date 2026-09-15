/**
 * ドメイン: 判定に渡す「人と承認」の事実の型（docs/21 §20.3.1 / §20.3.3。系統 A）。
 *
 * 循環依存を避けるための葉。`check-extensions.ts` がこの型だけを import する（`check-people.ts` は import しない）。
 * 事実は application の `PeopleCheckFactsProvider` が索引（従業員の件数・申請者の従業員・氏名キー・承認計画）から集める。
 */
import type { ApprovalUnresolvedCause } from '../approval';

/** 申請者に紐付いた従業員の要約（判定は有効かどうかだけを見る）。 */
export interface PeopleClaimantEmployeeFact {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** 承認計画の未解決の最初の 1 件（`resolveApprovalPlan` の結果。`claimant-unlinked` 原因も含めて渡し、contributor が除く）。 */
export interface PeopleApprovalUnresolvedFact {
  readonly routeId?: string;
  readonly routeName: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly cause: ApprovalUnresolvedCause;
  /** 文言の差し込み値（claimant / manager / department / group / employee）と導線の id（employeeId / departmentId / groupId）。 */
  readonly params: Readonly<Record<string, string | null>>;
}

export interface PeopleCheckFacts {
  /** 有効な従業員が 1 人以上いるか（いなければ紐付けを求めない。MVP と同じ動き）。 */
  readonly masterInUse?: boolean;
  /**
   * 申請者の従業員。`null` = 申請が `claimant.employeeId` を持つのにマスタに見つからない。
   * `undefined` = 申請が紐付いていない（または調べていない）。
   */
  readonly claimantEmployee?: PeopleClaimantEmployeeFact | null;
  /** 未紐付けの申請者と氏名キーが一致する有効な従業員（最大 3。候補の提示だけに使う）。 */
  readonly nameCandidates?: readonly { readonly id: string; readonly name: string }[];
  readonly approvalUnresolved?: PeopleApprovalUnresolvedFact;
}

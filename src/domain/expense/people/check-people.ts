/**
 * ドメイン: 「人と承認」の検査関数（contributor。docs/21 §20.3.2 / §20.3.3。系統 A）。
 *
 * 出してよいコードは `PEOPLE_REASON_CODES`（`claimant-unlinked` / `claimant-employee-disabled` / `approval-route-unresolved`）。
 * 事実（`PeopleCheckFacts`）が無ければ何も出さない（系統の provider を配線しない構成は MVP と同じ判定）。
 *
 * - `claimant-unlinked`: マスタを使っている（有効な従業員が 1 人以上）のに申請者が紐付いていない。候補は氏名が一致する有効な従業員（最大 3）。
 * - `claimant-employee-disabled`: 紐付いた従業員が無効、または見つからない（`missing`）。
 * - `approval-route-unresolved`: 承認計画の未解決の最初の 1 件。原因 `claimant-unlinked` は出さない（申請者の紐付けの理由に集約。§20.3.3）。
 *
 * 画面の導線が該当行を開けるよう、差し込み値に `employeeId` / `departmentId` / `groupId` / `routeId` / `stepId` も入れる。
 */
import type { CheckedClaim, ExpenseCheckContributor, ReasonDraft } from '../check-extensions';
import type { ReasonParamValue } from '../judgment';
import { PEOPLE_REASON_CODES } from '../reason-codes';
import type { PeopleCheckFacts } from './check-facts';

export type { PeopleCheckFacts } from './check-facts';

/** 候補の氏名の最大件数（文言が長くなりすぎないように）。 */
export const CLAIMANT_CANDIDATES_MAX = 3;

function withoutNull(params: Readonly<Record<string, string | null>>): Record<string, ReasonParamValue> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== ''));
}

/** 申請の理由（明細が無い申請でも出す）。純関数。 */
export function peopleClaimReasons(claim: CheckedClaim, facts: PeopleCheckFacts | undefined): readonly ReasonDraft[] {
  if (facts === undefined) return [];
  const drafts: ReasonDraft[] = [];
  const claimant = claim.claimant?.name ?? '';
  const employeeId = claim.claimant?.employeeId;
  const unlinked = employeeId === undefined && facts.masterInUse === true;

  if (unlinked) {
    const candidates = (facts.nameCandidates ?? []).slice(0, CLAIMANT_CANDIDATES_MAX);
    drafts.push({
      code: 'claimant-unlinked',
      params: {
        claimant,
        ...(candidates.length === 0 ? {} : { candidates: candidates.map((candidate) => candidate.name).join('、') }),
        // 候補が 1 人なら導線でその人を開ける。
        ...(candidates.length === 1 ? { employeeId: (candidates[0] as { id: string }).id } : {}),
      },
    });
  }

  if (employeeId !== undefined && facts.claimantEmployee !== undefined && (facts.claimantEmployee === null || !facts.claimantEmployee.enabled)) {
    drafts.push({ code: 'claimant-employee-disabled', params: { claimant, missing: facts.claimantEmployee === null, employeeId } });
  }

  const unresolved = facts.approvalUnresolved;
  if (unresolved !== undefined && unresolved.cause !== 'claimant-unlinked') {
    drafts.push({
      code: 'approval-route-unresolved',
      params: {
        ...withoutNull(unresolved.params),
        routeName: unresolved.routeName,
        stepId: unresolved.stepId,
        stepName: unresolved.stepName,
        cause: unresolved.cause,
        ...(unresolved.routeId === undefined ? {} : { routeId: unresolved.routeId }),
      },
    });
  }
  return drafts;
}

export const peopleContributor: ExpenseCheckContributor = {
  id: 'people',
  codes: PEOPLE_REASON_CODES,
  claimReasons: (claim, _policy, extensions) => peopleClaimReasons(claim, extensions.people),
};

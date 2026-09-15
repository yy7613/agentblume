/**
 * application層: 申請のチェック（段階 1 の実行と保存。docs/21 §7 / §20.3.1）。
 *
 * 判定そのものは domain の純粋関数 `checkClaim`。ここは入力を集める係:
 * - 判定日は業務のタイムゾーン（既定 Asia/Tokyo）で求める。UTC の日付にすると日本時間 0〜9 時に当日のレシートが未来になる。
 * - 他の申請との重複候補は、全申請を読まずに索引（取引日 × 金額・画像ハッシュ）で引く。
 * - 系統の事実は注入された provider（A / B / C）を並列に呼んでまとめる。スタブは何も返さないので MVP と同じ判定になる。
 * - 承認済み・精算済みは対象外（指定されても飛ばして `skipped` に数える）。
 *
 * `approvalBlockers`・一覧の `stale`・承認は、判定そのものをこの `judgeClaim` 以外で作らない（判定の入口を増やさない）。
 */
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from '../../domain/expense/business-date';
import { checkClaim } from '../../domain/expense/check';
import { mergeCheckExtensions } from '../../domain/expense/check-extensions';
import { claimFingerprint, withJudgment, withPolicyStaleness, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError } from '../../domain/expense/errors';
import type { ClaimJudgment } from '../../domain/expense/judgment';
import type { ExpensePolicy } from '../../domain/expense/policy';
import { usableAmount } from '../../domain/expense/receipt-facts';
import type { ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { loadExpensePolicy } from './manage-policy';
import type { ApprovalRoutePlanner, ExpenseCheckFactsProvider } from './ports';

export interface CheckExpenseClaimsInput {
  readonly scope: TenantScope;
  /** 省略時は draft と、判定が古い checked / in-approval の全件。 */
  readonly claimIds?: readonly string[];
  readonly by?: string;
}

export interface CheckExpenseClaimsResult {
  readonly checked: number;
  readonly pass: number;
  readonly needsReview: number;
  readonly returned: number;
  readonly skipped: number;
}

/** 1 申請の判定に要る重複候補と系統の事実を集めて判定する（保存はしない）。 */
export async function judgeClaim(
  claims: ExpenseClaimRepository,
  receipts: ExpenseReceiptRepository,
  claim: ExpenseClaim,
  policy: ExpensePolicy,
  policySaved: boolean,
  today: string,
  factsProviders: readonly ExpenseCheckFactsProvider[] = [],
): Promise<{ readonly judgment: ClaimJudgment; readonly hashes: ReadonlyMap<string, string> }> {
  const hashes = await receipts.hashesByClaim(claim.tenant, claim.id);
  const keys = claim.items.flatMap((item) => {
    const amount = usableAmount(item.facts);
    return item.facts.transactionDate === undefined || amount === undefined ? [] : [{ transactionDate: item.facts.transactionDate, amount }];
  });
  const [candidates, parts] = await Promise.all([
    keys.length === 0 && hashes.size === 0
      ? Promise.resolve([])
      : claims.findDuplicateCandidates(claim.tenant, { keys, sha256s: [...new Set(hashes.values())], excludeClaimId: claim.id }),
    Promise.all(factsProviders.map((provider) => provider.gather(claim.tenant, claim, policy, today))),
  ]);
  const extensions = mergeCheckExtensions(parts);
  return { judgment: checkClaim({ claim, policy, policySaved, duplicateCandidates: candidates, today, receiptHashes: hashes, extensions }), hashes };
}

export class CheckExpenseClaimsUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
    private readonly factsProviders: readonly ExpenseCheckFactsProvider[] = [],
    /** 現在の段の承認者（「あなたの承認待ち」の索引）。省略 = 入れない。 */
    private readonly planner?: ApprovalRoutePlanner,
  ) {}

  async execute(input: CheckExpenseClaimsInput): Promise<CheckExpenseClaimsResult> {
    const { policy, saved } = await loadExpensePolicy(this.policies, input.scope);
    let targets: readonly ExpenseClaim[];
    if (input.claimIds === undefined) {
      const [drafts, checked, inApproval] = await Promise.all([
        this.claims.list(input.scope, { status: 'draft' }),
        this.claims.list(input.scope, { status: 'checked' }),
        this.claims.list(input.scope, { status: 'in-approval' }),
      ]);
      const stale = [...checked, ...inApproval].map((summary) => withPolicyStaleness(summary, policy)).filter((summary) => summary.stale);
      targets = await this.claims.findByIds(input.scope, [...drafts, ...stale].map((summary) => summary.id));
    } else {
      targets = await this.claims.findByIds(input.scope, input.claimIds);
      const found = new Set(targets.map((claim) => claim.id));
      const missing = input.claimIds.find((id) => !found.has(id));
      if (missing !== undefined) throw new ExpenseClaimNotFoundError(`expense claim not found: ${missing}`);
    }

    const now = this.now();
    const at = now.toISOString();
    const today = businessDateOf(now, this.timeZone);
    const result = { checked: 0, pass: 0, needsReview: 0, returned: 0, skipped: 0 };
    for (const claim of targets) {
      if (claim.status === 'approved' || claim.status === 'settled') { result.skipped += 1; continue; }
      const { judgment, hashes } = await judgeClaim(this.claims, this.receipts, claim, policy, saved, today, this.factsProviders);
      const updated = withJudgment(claim, { ...judgment, policyUpdatedAt: policy.updatedAt, itemsFingerprint: claimFingerprint(claim), checkedAt: at }, at, input.by);
      const approvers = this.planner === undefined ? [] : await this.planner.currentApprovers(input.scope, updated, policy);
      await this.claims.save(updated, hashes, approvers);
      result.checked += 1;
      if (judgment.verdict === 'pass') result.pass += 1;
      else if (judgment.verdict === 'needs-review') result.needsReview += 1;
      else result.returned += 1;
    }
    return result;
  }
}

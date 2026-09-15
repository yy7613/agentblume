/**
 * ドメイン: 規程チェック（段階 1。docs/21 §3 / §20.3 / ADR-0040 §1 / ADR-0043 §2）。
 *
 * `checkClaim` は **申請・規程・重複候補・判定日・系統の事実だけを引数に取る純粋関数**。モデル呼び出しも I/O も無く、
 * 同じ入力からは必ず同じ判定が出る。明細は `items[]` の順、1 明細の中は §20.3.2 の順で評価し、
 * 前提が欠けたら依存するチェックを打ち切る（「金額が無い」明細に上限超過なしと出すと、通ったように見えるため）。
 *
 * 実用化の 16 コードは系統の検査関数（contributor。`check-contributors.ts`）が足す。骨格は評価済みの値（費目・金額・日付・
 * 出した理由）を渡し、戻ってきた理由を評価順へ安定ソートし、重さを規程から決める。contributor が `codes` に無いコードを
 * 返したら実装の誤りとして `ExpenseDomainError` にする（黙って出さない）。
 *
 * このファイルは規程の**数値を持たない**。上限・閾値・必須項目はすべて `policy` から読む。
 */
import { splitTotalsByRate, transitionalDeductionRate } from '../journal/tax';
import { daysBetween } from './business-date';
import { EXPENSE_CHECK_CONTRIBUTORS } from './check-contributors';
import type { CheckedClaim, CheckExtensionsInput, ExpenseCheckContributor, ItemEvaluation, ReasonDraft } from './check-extensions';
import { itemLabel, type ExpenseItem } from './claim';
import { itemKeyOf, matchKeys, type DuplicateCandidate } from './duplicates';
import { ExpenseDomainError } from './errors';
import { verdictOf, type CheckReason, type ClaimJudgment, type ItemCheck, type ReasonParamValue } from './judgment';
import { findCategory, type ExpenseCategory, type ExpensePolicy } from './policy';
import { REASON_CATALOG, reasonOrder, severityFor, type ExpenseReasonCode, type Severity } from './reason-codes';
import { digitCount, usableAmount } from './receipt-facts';

export interface CheckClaimInput {
  readonly claim: CheckedClaim;
  readonly policy: ExpensePolicy;
  /** 規程が保存済みか（未保存 = 初期テンプレートのまま）。 */
  readonly policySaved: boolean;
  /** 同じ取引日 × 金額、または同じ画像ハッシュを持つ他の申請の明細（application が索引で集める）。 */
  readonly duplicateCandidates: readonly DuplicateCandidate[];
  /** 判定日（YYYY-MM-DD）。application が業務のタイムゾーンで求めて渡す。 */
  readonly today: string;
  /** 明細 id → 証憑本体の SHA-256（同一画像の重複に使う）。 */
  readonly receiptHashes?: ReadonlyMap<string, string>;
  /** 系統の事実（application の `ExpenseCheckFactsProvider` が集める）。無ければ系統の理由は出ない。 */
  readonly extensions?: CheckExtensionsInput;
  /** 検査関数（既定は 3 系統。テストで差し替える）。 */
  readonly contributors?: readonly ExpenseCheckContributor[];
}

/** 精算書・伝票の読取では発行者（= 支払先）が申請者・作成者になり、支払先が空になりやすい。 */
const READER_PAYEE_UNRELIABLE_KINDS: ReadonlySet<string> = new Set(['expense_report', 'slip_transfer', 'slip_cash_in', 'slip_cash_out']);

interface EvaluationContext {
  readonly policy: ExpensePolicy;
  readonly today: string;
  /** 申請が無い試算（ツール）では undefined。期間・提出期限・申請内の重複を評価しない。 */
  readonly claim?: CheckedClaim;
  readonly candidates: readonly DuplicateCandidate[];
  readonly receiptHashes: ReadonlyMap<string, string>;
  readonly hasReceipt: (item: ExpenseItem) => boolean;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { review: 1, return: 2 };

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/** 閾値つきの要否。金額が無いときは「必要」とみなす（§3.2）。 */
function requiredAt(requirement: { readonly required: boolean; readonly exemptBelow?: number }, amount: number | undefined): boolean {
  if (!requirement.required) return false;
  if (requirement.exemptBelow === undefined || amount === undefined) return true;
  return amount >= requirement.exemptBelow;
}

interface ItemOutcome {
  readonly reasons: readonly CheckReason[];
  readonly evaluation: ItemEvaluation;
}

function evaluateItem(item: ExpenseItem, index: number, context: EvaluationContext): ItemOutcome {
  const { policy } = context;
  const reasons: CheckReason[] = [];
  const description = itemLabel(item, index);
  const push = (code: ExpenseReasonCode, params: Record<string, ReasonParamValue>, forced?: Severity): void => {
    const severity = forced ?? severityFor(code, policy.severityOverrides);
    if (severity === undefined) return;
    const searchKey = REASON_CATALOG[code].searchKey;
    reasons.push({ code, severity, itemId: item.id, params: { description, ...params }, ...(searchKey === undefined ? {} : { searchKey }) });
  };
  const { facts } = item;

  // 1. 費目。どちらかが出たら費目に依存するチェックを飛ばす。
  let category: ExpenseCategory | undefined;
  if (item.categoryId === undefined) {
    push('category-missing', { categoryText: item.categoryText ?? null });
  } else {
    const found = findCategory(policy, item.categoryId);
    if (found === undefined || !found.enabled) push('category-unknown', { categoryId: item.categoryId });
    else category = found;
  }

  // 2. 必須項目（電帳法の検索要件を含む）。
  const amount = usableAmount(facts);
  const date = facts.transactionDate;
  if (amount === undefined) push('amount-missing', { amount: facts.amount ?? null });
  if (date === undefined) push('date-missing', { issueDate: facts.issueDate ?? null });
  if (blank(facts.payeeName)) {
    const kind = item.extraction.documentKind;
    push('payee-missing', { documentKind: kind ?? null, readerHint: kind !== undefined && READER_PAYEE_UNRELIABLE_KINDS.has(kind) });
  }
  if (category !== undefined && category.requires.purpose && blank(facts.purpose)) push('purpose-missing', { category: category.name });

  // 3. 証憑。
  if (category !== undefined && requiredAt(category.receipt, amount) && !context.hasReceipt(item)) {
    push('receipt-missing', { category: category.name, exemptBelow: category.receipt.exemptBelow ?? null });
  }
  if (item.extraction.warnings.length > 0) push('receipt-extraction-warning', { warnings: item.extraction.warnings.join(' / '), count: item.extraction.warnings.length });
  if (amount !== undefined && facts.totalsByRate !== undefined && facts.totalsByRate.length > 0) {
    const split = splitTotalsByRate({ totalsByRate: facts.totalsByRate });
    const sum = split.taxable10 + split.taxable8 + split.taxable0;
    // 税率行ごとの端数処理で最大 1 円ずれるので行数円まで許す（仕訳の整合チェックと同じ）。
    const tolerance = facts.totalsByRate.length;
    if (Math.abs(sum - amount) > tolerance) push('receipt-amount-mismatch', { sum, amount, diff: Math.abs(sum - amount), tolerance });
  }

  // 4. 日付。未来の日付が出たら他の期間系は出さない（年の打ち間違いを期間外と二重に言わない）。
  if (date !== undefined) {
    if (date > context.today) {
      push('date-in-future', { date, today: context.today });
    } else if (context.claim !== undefined) {
      const { period } = context.claim;
      if (date < period.from || date > period.to) push('date-outside-period', { date, from: period.from, to: period.to });
      const limitDays = policy.claimRules.submissionDeadlineDays;
      if (limitDays !== undefined) {
        const days = daysBetween(date, item.addedOn ?? context.today);
        if (days > limitDays) push('submission-late', { date, days, limitDays });
      }
    }
  }

  // 5. 支払方法・インボイス。会社払いの明細を申請に含める運用（§20.2.2 card.acceptCorporatePaymentItems）では会社払いを対象外にしない。
  if (facts.corporatePayment === true) {
    if (!policy.card.acceptCorporatePaymentItems) push('payment-not-reimbursable', { paymentMethod: 'corporate' });
  } else if (facts.paymentMethod !== undefined && policy.claimRules.nonReimbursablePaymentMethods.includes(facts.paymentMethod)) push('payment-not-reimbursable', { paymentMethod: facts.paymentMethod });
  if (category !== undefined && requiredAt(category.invoice, amount) && facts.registrationNumber === undefined) {
    const raw = item.extraction.rejectedRegistrationNumber;
    push('registration-number-missing', {
      category: category.name,
      date: date ?? null,
      deductionRate: date === undefined ? null : Math.round(transitionalDeductionRate(date) * 100),
      raw: raw ?? null,
      digits: raw === undefined ? null : digitCount(raw),
    });
  }

  // 6. 規程の上限（費目と金額に依存する）。
  if (category !== undefined && amount !== undefined) {
    const { limits, requires } = category;
    if (limits.perItem !== undefined && amount > limits.perItem) push('per-item-limit-exceeded', { category: category.name, limit: limits.perItem, over: amount - limits.perItem, amount });
    const attendeeCount = facts.attendees?.count;
    if (requires.attendees && attendeeCount === undefined) push('attendees-missing', { category: category.name });
    if (limits.perPerson !== undefined && attendeeCount !== undefined) {
      const count = policy.claimRules.attendeesIncludeClaimant ? attendeeCount : attendeeCount + 1;
      let basis = amount;
      let basisFallback = false;
      if (limits.perPersonBasis === 'tax-excluded') {
        if (facts.totalsByRate !== undefined && facts.totalsByRate.length > 0) {
          const split = splitTotalsByRate({ totalsByRate: facts.totalsByRate });
          basis = amount - split.tax10 - split.tax8;
        } else {
          // 税抜にできないときは税込で判定し、そのことを文言に出す（黙って税込にしない）。
          basisFallback = true;
        }
      }
      // 割り算をしない（端数処理の揺れを避ける）。
      if (basis > limits.perPerson * count) {
        push('per-person-limit-exceeded', { perPerson: Math.floor(basis / count), basis: basisFallback ? 'tax-included' : limits.perPersonBasis, count, category: category.name, limit: limits.perPerson, basisFallback });
      }
    }
    if (requires.attendeeDetails) {
      const missingNames = (facts.attendees?.names ?? []).length === 0;
      const missingRelation = blank(facts.attendees?.relation);
      if (missingNames || missingRelation) push('attendee-details-missing', { category: category.name, missingNames, missingRelation });
    }
    if (limits.perUnit !== undefined) {
      if (facts.unitCount === undefined) push('unit-count-missing', { category: category.name, unitLabel: limits.perUnit.label });
      else if (amount > limits.perUnit.amount * facts.unitCount) {
        push('per-unit-limit-exceeded', { category: category.name, unitLabel: limits.perUnit.label, perUnit: Math.floor(amount / facts.unitCount), limit: limits.perUnit.amount, amount, unitCount: facts.unitCount });
      }
    }
  }

  // 7. 事前承認。費目を指定しない条件は費目が決まらなくても評価し、金額条件は金額が無ければ当たらない扱いにする。
  if (blank(facts.preApprovalRef)) {
    const count = facts.attendees?.count === undefined ? undefined : (policy.claimRules.attendeesIncludeClaimant ? facts.attendees.count : facts.attendees.count + 1);
    const matched = policy.preApprovalRules.find((rule) => {
      if (!rule.enabled) return false;
      if (rule.categoryIds.length > 0 && (category === undefined || !rule.categoryIds.includes(category.id))) return false;
      if (rule.minAmount !== undefined && (amount === undefined || amount < rule.minAmount)) return false;
      if (rule.minPerPerson !== undefined && (amount === undefined || count === undefined || amount < rule.minPerPerson * count)) return false;
      return true;
    });
    if (matched !== undefined) push('pre-approval-missing', { ruleId: matched.id, ruleName: matched.name });
  }

  // 8. 重複（取引日と金額が揃わなければ比べない）。
  if (amount !== undefined && date !== undefined) {
    const ownSha = context.receiptHashes.get(item.id);
    const key = itemKeyOf(item, ownSha);
    if (context.claim !== undefined) {
      const others = context.claim.items;
      for (const [position, other] of others.entries()) {
        if (other.id === item.id) continue;
        const otherSha = context.receiptHashes.get(other.id);
        // 1 枚の精算書を分割した明細どうしは同じ画像を共有するので、重複にしない。
        if (ownSha !== undefined && ownSha === otherSha) continue;
        const strength = matchKeys(key, itemKeyOf(other, otherSha));
        if (strength === undefined) continue;
        push('duplicate-in-claim', { otherItemId: other.id, otherDescription: itemLabel(other, position), weak: strength === 'weak' }, strength === 'weak' ? 'review' : undefined);
        break;
      }
    }
    const ownClaimId = context.claim?.id;
    const foreign = context.candidates.filter((candidate) => candidate.claimId !== ownClaimId);
    let best: { readonly candidate: DuplicateCandidate; readonly weak: boolean; readonly severity: Severity } | undefined;
    for (const candidate of foreign) {
      const strength = matchKeys(key, candidate);
      if (strength === undefined) continue;
      const base = severityFor('duplicate-across-claims', policy.severityOverrides) ?? 'review';
      // 弱い鍵の一致と、相手が下書き（同じファイルを 2 回取り込んだだけのことが多い）は要確認に下げる。
      const severity: Severity = strength === 'weak' || candidate.claimStatus === 'draft' ? 'review' : base;
      if (best === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[best.severity]) best = { candidate, weak: strength === 'weak', severity };
    }
    if (best !== undefined) {
      push('duplicate-across-claims', { otherClaimId: best.candidate.claimId, otherItemId: best.candidate.itemId, otherStatus: best.candidate.claimStatus, claimantName: best.candidate.claimantName, weak: best.weak }, best.severity);
    }
    if (ownSha !== undefined) {
      const sameImage = foreign.find((candidate) => candidate.receiptSha256 === ownSha);
      if (sameImage !== undefined) {
        push('duplicate-receipt-image', { otherClaimId: sameImage.claimId, otherItemId: sameImage.itemId, otherStatus: sameImage.claimStatus }, sameImage.claimStatus === 'draft' ? 'review' : undefined);
      }
    }
  }

  const evaluation: ItemEvaluation = {
    item, index, description,
    ...(category === undefined ? {} : { category }),
    ...(amount === undefined ? {} : { amount }),
    ...(date === undefined ? {} : { date }),
    emitted: new Set(reasons.map((reason) => reason.code)),
  };
  return { reasons, evaluation };
}

function claimReason(code: ExpenseReasonCode, policy: ExpensePolicy, params: Record<string, ReasonParamValue>): CheckReason | undefined {
  const severity = severityFor(code, policy.severityOverrides);
  return severity === undefined ? undefined : { code, severity, params };
}

/** contributor の下書き → 理由（コードの集合の検査・重さの決定・明細の呼び名の付与）。`off` なら undefined。 */
function fromDraft(contributor: ExpenseCheckContributor, draft: ReasonDraft, policy: ExpensePolicy, item?: { readonly id: string; readonly description: string }): CheckReason | undefined {
  if (!contributor.codes.includes(draft.code)) {
    throw new ExpenseDomainError(`expense check: contributor ${contributor.id} returned ${draft.code}, which is not one of its codes (${contributor.codes.join(', ')})`);
  }
  const severity = draft.forcedSeverity ?? severityFor(draft.code, policy.severityOverrides);
  if (severity === undefined) return undefined;
  const searchKey = REASON_CATALOG[draft.code].searchKey;
  return {
    code: draft.code,
    severity,
    ...(item === undefined ? {} : { itemId: item.id }),
    params: item === undefined ? { ...draft.params } : { description: item.description, ...draft.params },
    ...(searchKey === undefined ? {} : { searchKey }),
  };
}

/** 評価順（`REASON_CODES`）へ安定ソートする。既存 27 コードの相対順は変わらない。 */
function byEvaluationOrder(reasons: readonly CheckReason[]): CheckReason[] {
  return [...reasons].sort((left, right) => reasonOrder(left.code) - reasonOrder(right.code));
}

/** 申請 1 件を判定する（純粋）。 */
export function checkClaim(input: CheckClaimInput): ClaimJudgment {
  const { claim, policy } = input;
  const receiptHashes = input.receiptHashes ?? new Map<string, string>();
  const extensions = input.extensions ?? {};
  const contributors = input.contributors ?? EXPENSE_CHECK_CONTRIBUTORS;
  let claimReasons: CheckReason[] = [];
  const unreviewed = input.policySaved ? undefined : claimReason('policy-unreviewed', policy, {});
  if (unreviewed !== undefined) claimReasons.push(unreviewed);

  // 申請の前提（申請者・仮払・承認経路）は明細が無くても見せる（claim-empty の早期終了より前）。
  let contributed = false;
  for (const contributor of contributors) {
    for (const draft of contributor.claimReasons?.(claim, policy, extensions) ?? []) {
      const reason = fromDraft(contributor, draft, policy);
      if (reason === undefined) continue;
      claimReasons.push(reason);
      contributed = true;
    }
  }
  if (contributed) claimReasons = byEvaluationOrder(claimReasons);

  if (claim.items.length === 0) {
    const empty = claimReason('claim-empty', policy, {});
    if (empty !== undefined) claimReasons.push(empty);
    return { verdict: verdictOf(claimReasons), items: [], claimReasons, totals: { amount: 0, byCategory: [] }, searchKeysComplete: false };
  }

  const context: EvaluationContext = {
    policy,
    today: input.today,
    claim,
    candidates: input.duplicateCandidates,
    receiptHashes,
    hasReceipt: (item) => item.receiptId !== undefined,
  };
  const items: ItemCheck[] = claim.items.map((item, index) => {
    const outcome = evaluateItem(item, index, context);
    let reasons = [...outcome.reasons];
    let added = false;
    for (const contributor of contributors) {
      for (const draft of contributor.itemReasons?.(outcome.evaluation, policy, extensions, claim) ?? []) {
        const reason = fromDraft(contributor, draft, policy, { id: item.id, description: outcome.evaluation.description });
        if (reason === undefined) continue;
        reasons.push(reason);
        added = true;
      }
    }
    if (added) reasons = byEvaluationOrder(reasons);
    return { itemId: item.id, verdict: verdictOf(reasons), reasons };
  });

  // 9. 申請の集計: 金額のある明細だけで費目別に合計する。
  const byCategory = new Map<string, number>();
  let total = 0;
  for (const item of claim.items) {
    const amount = usableAmount(item.facts);
    if (amount === undefined) continue;
    total += amount;
    if (item.categoryId !== undefined) byCategory.set(item.categoryId, (byCategory.get(item.categoryId) ?? 0) + amount);
  }
  for (const [categoryId, sum] of byCategory) {
    const category = findCategory(policy, categoryId);
    const limit = category?.enabled === true ? category.limits.perClaim : undefined;
    if (category === undefined || limit === undefined || sum <= limit) continue;
    const reason = claimReason('per-claim-limit-exceeded', policy, { categoryId, category: category.name, total: sum, limit, over: sum - limit });
    if (reason !== undefined) claimReasons.push(reason);
  }

  const every = [...claimReasons, ...items.flatMap((item) => item.reasons)];
  return {
    verdict: verdictOf(every),
    items,
    claimReasons,
    totals: { amount: total, byCategory: [...byCategory.entries()].map(([categoryId, amount]) => ({ categoryId, amount })) },
    searchKeysComplete: claim.items.every((item) => item.facts.transactionDate !== undefined && usableAmount(item.facts) !== undefined && !blank(item.facts.payeeName)),
  };
}

export interface CheckReceiptInput {
  readonly item: ExpenseItem;
  /** 明細の位置（文言の「明細 N」に使う）。 */
  readonly index?: number;
  readonly policy: ExpensePolicy;
  readonly duplicateCandidates: readonly DuplicateCandidate[];
  readonly today: string;
  /** 添付された画像があるか（ツールの試算では添付そのものが証憑）。 */
  readonly hasReceipt: boolean;
  readonly receiptSha256?: string;
}

/**
 * 申請に依存しないチェックだけを 1 明細に対して行う（ツールの試算。§13.1）。
 * 期間・提出期限・申請内の重複・申請の合計・`policy-unreviewed` は評価しない。
 * 系統の事実を受けないので、申請・マスタに依存する実用化のコードは出ない（§20.3.1-5）。
 */
export function checkReceipt(input: CheckReceiptInput): ItemCheck {
  const context: EvaluationContext = {
    policy: input.policy,
    today: input.today,
    candidates: input.duplicateCandidates,
    receiptHashes: input.receiptSha256 === undefined ? new Map() : new Map([[input.item.id, input.receiptSha256]]),
    hasReceipt: () => input.hasReceipt,
  };
  const { reasons } = evaluateItem(input.item, input.index ?? 0, context);
  return { itemId: input.item.id, verdict: verdictOf(reasons), reasons };
}

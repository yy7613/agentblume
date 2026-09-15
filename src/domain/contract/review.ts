/**
 * ドメイン: プレイブック判定（docs/23 §4.1。`reviewContract` は純関数）とレビューの集約。
 *
 * 評価順: 立場 → 抽出の失敗 → 条項の有無 → 引用の信頼性（未検証・競合）→ 法令の照合 → 決定的な条件 → LLM 基準の回答の適用。
 * - 基準は**全部評価する**（最初の失敗で止めない。交渉では全論点を一度に出したい）。
 * - トピックの判定は基準結果の最悪値。順位は `reject > negotiate > unresolved > accept`。
 * - `overall` はトピック判定の最悪値。文書全体の所見に warning 以上があれば accept のままにしない（最低 unresolved）。
 *
 * **LLM に委ねるのは「値の読み取り」と「はい/いいえ型の基準への回答と引用」だけ。** 合否・集約・日数・金額比較・
 * 印紙税候補はすべてここで決定的に決める。LLM の呼び出しは application が先に行い、回答を渡す。
 * 回答の根拠（evidenceQuote）が条文の中に無ければその回答は採らない（`llm-evidence-missing`）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { ClauseValue, PaymentTermsValue } from './clause-value';
import { evaluateCondition, type ConditionScalar } from './conditions';
import { termMonthsOf } from './consistency';
import { articleForClause, counterpartyNameOf, ourNameOf, type Clause, type ContractDocument } from './document';
import { ContractDomainError, ContractStateError } from './errors';
import { quoteAppearsIn } from './evidence';
import type { ContractReviewId } from './ids';
import { applicablePaymentLimit, checkPaymentMaxDays, checkProhibitedPaymentMethod, paymentMaxDays, type LegalOutcome } from './legal-checks';
import { enabledTopics, expandRecommendedText, type ClauseTopic, type Playbook, type PlaybookCriterion } from './playbook';
import { REASON_SEVERITY, type Reason, type ReasonCode, type ReasonDetail } from './reasons';
import { stampDutyCandidates } from './stamp-duty';
import type { SigningMethod } from './vocabulary';

export const VERDICTS = ['accept', 'negotiate', 'reject', 'unresolved'] as const;
export type Verdict = (typeof VERDICTS)[number];
export type HumanDecision = 'accept' | 'negotiate' | 'reject';
export type CriterionOutcome = 'pass' | 'fail' | 'unresolved' | 'not-applicable';

export type LlmCriterionAnswer =
  | { readonly status: 'answered'; readonly answer: 'yes' | 'no' | 'unclear'; readonly evidenceQuote: string | null; readonly reasoning: string }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' };

export interface CriterionResult {
  readonly criterionId: string;
  readonly outcome: CriterionOutcome;
  readonly reasonCode?: ReasonCode;
  readonly detail?: ReasonDetail;
  readonly llm?: { readonly answer: 'yes' | 'no' | 'unclear'; readonly evidenceQuote: string | null; readonly reasoning: string };
}

export interface TopicResult {
  readonly topicId: string;
  readonly topicLabel: string;
  readonly verdict: Verdict;
  readonly present: boolean;
  readonly reasons: readonly Reason[];
  readonly criteria: readonly CriterionResult[];
  readonly recommendedTexts: readonly string[];
  readonly humanDecision?: HumanDecision;
  readonly humanNote?: string;
}

export interface ReviewInput {
  readonly document: ContractDocument;
  readonly playbook: Playbook;
  /** criterionId → 回答。無い基準は「モデルが使えなかった」扱い。 */
  readonly llmAnswers: ReadonlyMap<string, LlmCriterionAnswer>;
  readonly signingMethod?: SigningMethod;
}

export interface ReviewOutcome {
  readonly results: readonly TopicResult[];
  readonly documentFindings: readonly Reason[];
  readonly overall: Verdict;
}

const RANK: Readonly<Record<Verdict, number>> = { accept: 0, unresolved: 1, negotiate: 2, reject: 3 };

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst), 'accept');
}

/** 基準のパス → 値（派生値を含む）。値が無ければ undefined。立場が要るのに未設定なら `role`。 */
export function fieldValueOf(path: string, clause: Clause | undefined, context: { readonly document: ContractDocument; readonly termMonths?: number }): ConditionScalar | undefined | 'role' {
  if (path === 'present') return clause?.present ?? false;
  const value: ClauseValue | undefined = clause?.value;
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'term': return ({ 'term.months': termMonthsOf(value), 'term.startDate': value.startDate, 'term.endDate': value.endDate, 'term.startsOnSigning': value.startsOnSigning } as Record<string, ConditionScalar | undefined>)[path];
    case 'auto_renewal': return ({ 'renewal.renews': value.renews, 'renewal.months': value.renewalMonths ?? (value.sameAsInitial ? context.termMonths : undefined) } as Record<string, ConditionScalar | undefined>)[path];
    // 月は 30 日換算の目安（期限計算は暦で行う）。
    case 'notice': return ({ 'notice.days': value.unit === 'month' ? value.amount * 30 : value.amount, 'notice.amount': value.amount, 'notice.unit': value.unit, 'notice.businessDays': value.businessDays } as Record<string, ConditionScalar | undefined>)[path];
    case 'payment_terms': {
      if (path === 'payment.maxDays') { const result = paymentMaxDays(value); return result.kind === 'indeterminate' ? undefined : result.maxDays; }
      return ({ 'payment.method': value.method, 'payment.basis': value.basis } as Record<string, ConditionScalar | undefined>)[path];
    }
    case 'liability_cap': return ({ 'cap.kind': value.capKind, 'cap.amount': value.amount, 'cap.months': value.months, 'cap.excludesWillfulOrGross': value.excludesWillfulOrGross, 'cap.present': value.capKind !== 'none' && value.capKind !== 'unspecified' } as Record<string, ConditionScalar | undefined>)[path];
    case 'permission': return path === 'permission.policy' ? value.policy : undefined;
    case 'ip_ownership': {
      if (path === 'ip.owner') {
        if (value.owner === 'shared' || value.owner === 'unspecified') return value.owner;
        if (context.document.ourParty === undefined) return 'role';
        return value.owner === context.document.ourParty ? 'us' : 'counterparty';
      }
      return ({ 'ip.transferOn': value.transferOn, 'ip.moralRightsNotExercised': value.moralRightsNotExercised } as Record<string, ConditionScalar | undefined>)[path];
    }
    case 'jurisdiction': return ({ 'jurisdiction.court': value.court, 'jurisdiction.exclusive': value.exclusive } as Record<string, ConditionScalar | undefined>)[path];
    case 'text': return undefined;
  }
}

function hasWarning(clause: Clause | undefined, code: ReasonCode): boolean {
  return clause?.warnings.some((warning) => warning.code === code) ?? false;
}

function unresolved(criterion: PlaybookCriterion, code: ReasonCode, detail?: ReasonDetail): CriterionResult {
  return { criterionId: criterion.id, outcome: 'unresolved', reasonCode: code, ...(detail === undefined ? {} : { detail }) };
}

function fromLegal(criterion: PlaybookCriterion, outcome: LegalOutcome): CriterionResult {
  if (outcome.outcome === 'not-applicable') return { criterionId: criterion.id, outcome: 'not-applicable' };
  if (outcome.outcome === 'pass') return { criterionId: criterion.id, outcome: 'pass', detail: outcome.detail };
  return { criterionId: criterion.id, outcome: outcome.outcome, reasonCode: outcome.reason, detail: outcome.detail };
}

function evaluateCriterion(criterion: PlaybookCriterion, clause: Clause | undefined, input: ReviewInput, termMonths: number | undefined): CriterionResult {
  const { document, playbook } = input;
  if (criterion.appliesToRoles !== undefined) {
    if (document.ourRole === undefined) return unresolved(criterion, 'role-not-set');
    if (!criterion.appliesToRoles.includes(document.ourRole)) return { criterionId: criterion.id, outcome: 'not-applicable' };
  }
  if (hasWarning(clause, 'extraction-failed')) return unresolved(criterion, 'extraction-failed');
  if (clause === undefined || !clause.present) {
    if (criterion.check.type !== 'required') return { criterionId: criterion.id, outcome: 'not-applicable' };
    const noKeyword = clause?.warnings.some((warning) => warning.code === 'clause-missing') ?? false;
    return { criterionId: criterion.id, outcome: 'fail', reasonCode: 'clause-missing', detail: { noKeywordMatch: noKeyword } };
  }
  if (hasWarning(clause, 'conflicting-clauses')) return unresolved(criterion, 'conflicting-clauses');
  if (hasWarning(clause, 'quote-not-found') || (clause.source === 'llm' && clause.evidence.length > 0 && clause.evidence.every((entry) => !entry.verified))) return unresolved(criterion, 'quote-not-found');
  const check = criterion.check;
  switch (check.type) {
    case 'required': return { criterionId: criterion.id, outcome: 'pass' };
    case 'legal': {
      if (clause.value?.kind !== 'payment_terms') return unresolved(criterion, hasWarning(clause, 'value-unparsed') ? 'value-unparsed' : 'field-missing', { field: 'payment' });
      const terms: PaymentTermsValue = clause.value;
      return fromLegal(criterion, check.rule === 'payment-max-days' ? checkPaymentMaxDays(terms, document.counterpartyProfile, playbook.legal) : checkProhibitedPaymentMethod(terms, document.counterpartyProfile, playbook.legal));
    }
    case 'condition': {
      let missing: string | undefined;
      let roleNeeded = false;
      for (const condition of check.conditions) {
        const actual = fieldValueOf(condition.field, clause, { document, ...(termMonths === undefined ? {} : { termMonths }) });
        if (actual === 'role') { roleNeeded = true; continue; }
        const outcome = evaluateCondition(condition, actual);
        if (outcome === 'fail') {
          return {
            criterionId: criterion.id, outcome: 'fail', reasonCode: 'criterion-failed',
            detail: { field: condition.field, actual: actual ?? null, op: condition.op, expected: Array.isArray(condition.value) ? condition.value.join(', ') : (condition.value as ConditionScalar | undefined) ?? null, rationale: criterion.rationale },
          };
        }
        if (outcome === 'field-missing') missing ??= condition.field;
      }
      if (roleNeeded) return unresolved(criterion, 'role-not-set');
      if (missing !== undefined) return unresolved(criterion, hasWarning(clause, 'value-unparsed') ? 'value-unparsed' : 'field-missing', { field: missing });
      return { criterionId: criterion.id, outcome: 'pass' };
    }
    case 'llm': {
      const answer = input.llmAnswers.get(criterion.id);
      if (answer === undefined || answer.status === 'unavailable') return unresolved(criterion, 'llm-unavailable', { question: check.question });
      if (answer.status === 'failed') return unresolved(criterion, 'llm-unclear', { question: check.question });
      const llm = { answer: answer.answer, evidenceQuote: answer.evidenceQuote, reasoning: answer.reasoning };
      if (answer.answer === 'unclear') return { ...unresolved(criterion, 'llm-unclear', { question: check.question }), llm };
      const article = articleForClause(document, clause);
      const scope = article === undefined ? clause.evidence.map((entry) => entry.quote).join('\n') : document.body.slice(article.start, article.end);
      if (answer.evidenceQuote === null || !quoteAppearsIn(scope, answer.evidenceQuote)) return { ...unresolved(criterion, 'llm-evidence-missing', { question: check.question }), llm };
      return answer.answer === check.passWhen
        ? { criterionId: criterion.id, outcome: 'pass', llm }
        : { criterionId: criterion.id, outcome: 'fail', reasonCode: 'llm-criterion-failed', detail: { question: check.question, reasoning: answer.reasoning }, llm };
    }
  }
}

function outcomeVerdict(result: CriterionResult, criterion: PlaybookCriterion): Verdict {
  if (result.outcome === 'fail') return criterion.onFail;
  return result.outcome === 'unresolved' ? 'unresolved' : 'accept';
}

export function reviewContract(input: ReviewInput): ReviewOutcome {
  const { document, playbook } = input;
  const topics = enabledTopics(playbook);
  const topicIds = new Set(topics.map((topic) => topic.id));
  const criteria = playbook.criteria.filter((criterion) => criterion.enabled).sort((left, right) => left.sortOrder - right.sortOrder);
  const clauseOf = (topicId: string) => document.clauses.find((clause) => clause.topicId === topicId);
  const primaryTerm = topics.filter((topic) => topic.valueKind === 'term').map((topic) => clauseOf(topic.id)).find((clause) => clause?.present === true && clause.value?.kind === 'term');
  const termMonths = primaryTerm?.value?.kind === 'term' ? termMonthsOf(primaryTerm.value) : undefined;
  const limit = applicablePaymentLimit(document.counterpartyProfile, playbook.legal);
  const placeholders = (clause: Clause | undefined) => ({
    counterparty: counterpartyNameOf(document) ?? '相手方',
    us: ourNameOf(document) ?? '当社',
    paymentMaxDays: String(limit ?? playbook.legal.paymentMaxDays),
    articleRef: clause?.articleRef ?? '該当条項',
  });

  const results: TopicResult[] = topics.map((topic: ClauseTopic) => {
    const clause = clauseOf(topic.id);
    const evaluated = criteria.filter((criterion) => criterion.topicId === topic.id).map((criterion) => ({ criterion, result: evaluateCriterion(criterion, clause, input, termMonths) }));
    const verdict = worstVerdict(evaluated.map(({ criterion, result }) => outcomeVerdict(result, criterion)));
    const reasons: Reason[] = evaluated.filter(({ result }) => result.reasonCode !== undefined).map(({ criterion, result }) => ({ code: result.reasonCode!, criterionId: criterion.id, topicId: topic.id, ...(result.detail === undefined ? {} : { detail: result.detail }) }));
    const recommendedTexts = [...new Set(evaluated.filter(({ result, criterion }) => result.outcome === 'fail' && criterion.recommendedText !== undefined).map(({ criterion }) => expandRecommendedText(criterion.recommendedText!, placeholders(clause))))];
    return { topicId: topic.id, topicLabel: topic.label, verdict, present: clause?.present ?? false, reasons, criteria: evaluated.map(({ result }) => result), recommendedTexts };
  });

  // 無効化・削除されたトピックを参照する基準は、判定から黙って消さずに unknown-topic として見せる。
  const orphans = criteria.filter((criterion) => !topicIds.has(criterion.topicId));
  for (const topicId of [...new Set(orphans.map((criterion) => criterion.topicId))]) {
    const own = orphans.filter((criterion) => criterion.topicId === topicId);
    results.push({
      topicId, topicLabel: playbook.topics.find((topic) => topic.id === topicId)?.label ?? topicId, verdict: 'unresolved', present: false,
      reasons: own.map((criterion) => ({ code: 'unknown-topic' as const, criterionId: criterion.id, topicId })),
      criteria: own.map((criterion) => ({ criterionId: criterion.id, outcome: 'unresolved' as const, reasonCode: 'unknown-topic' as const })),
      recommendedTexts: [],
    });
  }

  const documentFindings: Reason[] = [];
  for (const topic of topics) {
    const clause = clauseOf(topic.id);
    for (const warning of clause?.warnings ?? []) {
      if (warning.code === 'deadline-mismatch') documentFindings.push({ code: 'deadline-mismatch', topicId: topic.id, detail: { message: warning.message, days: warning.days ?? null } });
    }
    if (clause?.present === true && clause.value?.kind === 'payment_terms' && clause.value.basis === 'acceptance') documentFindings.push({ code: 'payment-basis-acceptance', topicId: topic.id });
  }
  const renewal = topics.filter((topic) => topic.valueKind === 'auto_renewal').map((topic) => clauseOf(topic.id)).find((clause) => clause?.present === true && clause.value?.kind === 'auto_renewal');
  for (const candidate of stampDutyCandidates({
    nature: document.contractNature?.value,
    ...(document.contractAmount === undefined ? {} : { contractAmount: document.contractAmount }),
    ...(termMonths === undefined ? {} : { termMonths }),
    ...(renewal?.value?.kind === 'auto_renewal' ? { renews: renewal.value.renews } : {}),
    ...(input.signingMethod === undefined ? {} : { signingMethod: input.signingMethod }),
  }, playbook.stampDuty)) {
    documentFindings.push({ code: candidate.code, detail: { documentTypeCode: candidate.documentTypeCode, name: candidate.name, nature: candidate.nature, amount: candidate.amount, electronic: candidate.electronic, sourceUrl: candidate.sourceUrl } });
  }

  const topicWorst = worstVerdict(results.map((result) => result.verdict));
  const warned = documentFindings.some((finding) => REASON_SEVERITY[finding.code] === 'warning');
  return { results, documentFindings, overall: topicWorst === 'accept' && warned ? 'unresolved' : topicWorst };
}

/* ---------------------------------------------------------------------------
 * レビューの集約
 * ------------------------------------------------------------------------ */

export interface LlmCacheEntry {
  /** 条文ハッシュ + 質問ハッシュ + モデル。 */
  readonly key: string;
  readonly criterionId: string;
  readonly answer: 'yes' | 'no' | 'unclear';
  readonly evidenceQuote: string | null;
  readonly reasoning: string;
}

export type PlaybookSnapshot = Omit<Playbook, 'tenant'>;

export interface ContractReview {
  readonly tenant: TenantScope;
  readonly id: ContractReviewId;
  readonly documentId: string;
  readonly playbookId: string;
  readonly playbookName: string;
  /** 判定時の審査基準の写し（後から基準を直しても当時の根拠を保つ）。 */
  readonly playbookSnapshot: PlaybookSnapshot;
  readonly playbookSnapshotAt: string;
  /** 判定時の条項の指紋（変わったら stale）。 */
  readonly clausesFingerprint: string;
  readonly results: readonly TopicResult[];
  readonly documentFindings: readonly Reason[];
  readonly overall: Verdict;
  readonly status: 'draft' | 'finalized';
  readonly stale: boolean;
  readonly llmCache: readonly LlmCacheEntry[];
  readonly model?: { readonly provider: string; readonly model: string };
  readonly finalizedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateContractReviewProps = ContractReview;

function reviewFail(message: string): never {
  throw new ContractDomainError(`createContractReview: ${message}`);
}

export function createContractReview(props: CreateContractReviewProps): ContractReview {
  if (props === null || typeof props !== 'object') reviewFail('props must be an object');
  if (typeof props.tenant?.tenantId !== 'string' || typeof props.tenant.workspaceId !== 'string') reviewFail('tenant is required');
  for (const key of ['id', 'documentId', 'playbookId', 'playbookName', 'playbookSnapshotAt', 'clausesFingerprint', 'createdAt', 'updatedAt'] as const) {
    if (typeof props[key] !== 'string' || props[key] === '') reviewFail(`${key} is required`);
  }
  if (!VERDICTS.includes(props.overall)) reviewFail(`overall must be one of ${VERDICTS.join(', ')}`);
  if (props.status !== 'draft' && props.status !== 'finalized') reviewFail('status must be draft or finalized');
  if (typeof props.stale !== 'boolean') reviewFail('stale must be a boolean');
  if (props.playbookSnapshot === null || typeof props.playbookSnapshot !== 'object') reviewFail('playbookSnapshot is required');
  if (!Array.isArray(props.results) || !Array.isArray(props.documentFindings) || !Array.isArray(props.llmCache)) reviewFail('results / documentFindings / llmCache must be arrays');
  props.results.forEach((result, index) => {
    if (typeof result?.topicId !== 'string' || !VERDICTS.includes(result.verdict) || !Array.isArray(result.criteria) || !Array.isArray(result.reasons) || !Array.isArray(result.recommendedTexts)) reviewFail(`results[${index}] is malformed`);
    if (result.humanDecision !== undefined && !['accept', 'negotiate', 'reject'].includes(result.humanDecision)) reviewFail(`results[${index}].humanDecision must be accept, negotiate or reject`);
    if (result.humanNote !== undefined && (typeof result.humanNote !== 'string' || result.humanNote.length > 2000)) reviewFail(`results[${index}].humanNote must be a string of at most 2000 characters`);
  });
  if (props.status === 'finalized' && props.results.some((result) => result.humanDecision === undefined)) reviewFail('a finalized review needs a decision for every clause type');
  // LLM の理由と引用は上限で切る（1 レコード 8 MiB の上限を守る。docs/23 §8）。
  const results = props.results.map((result: TopicResult) => ({
    ...structuredClone(result),
    criteria: result.criteria.map((criterion: CriterionResult) => criterion.llm === undefined ? structuredClone(criterion) : { ...structuredClone(criterion), llm: { answer: criterion.llm.answer, evidenceQuote: criterion.llm.evidenceQuote === null ? null : criterion.llm.evidenceQuote.slice(0, 300), reasoning: criterion.llm.reasoning.slice(0, 200) } }),
  }));
  return {
    ...structuredClone(props),
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    results,
    llmCache: props.llmCache.map((entry) => ({ key: entry.key, criterionId: entry.criterionId, answer: entry.answer, evidenceQuote: entry.evidenceQuote === null ? null : entry.evidenceQuote.slice(0, 300), reasoning: entry.reasoning.slice(0, 200) })),
  };
}

export interface HumanDecisionInput {
  readonly topicId: string;
  readonly decision?: HumanDecision | null;
  readonly note?: string | null;
}

function assertDraft(review: ContractReview, action: string): void {
  if (review.status === 'finalized') throw new ContractStateError(`the review "${review.id}" is already finalized, so it cannot ${action}; run a new review instead`, { reviewId: review.id, documentId: review.documentId });
}

/** 人の判断とメモ（draft のみ）。null は取り消し。 */
export function applyHumanDecisions(review: ContractReview, decisions: readonly HumanDecisionInput[], now: string): ContractReview {
  assertDraft(review, 'change decisions');
  const byTopic = new Map(decisions.map((decision) => [decision.topicId, decision]));
  for (const topicId of byTopic.keys()) {
    if (!review.results.some((result) => result.topicId === topicId)) throw new ContractDomainError(`applyHumanDecisions: the review has no clause type "${topicId}"`);
  }
  const results = review.results.map((result) => {
    const input = byTopic.get(result.topicId);
    if (input === undefined) return result;
    const { humanDecision: _decision, humanNote: _note, ...rest } = result;
    const decision = input.decision === undefined ? result.humanDecision : input.decision ?? undefined;
    const note = input.note === undefined ? result.humanNote : input.note ?? undefined;
    return { ...rest, ...(decision === undefined ? {} : { humanDecision: decision }), ...(note === undefined || note === '' ? {} : { humanNote: note }) };
  });
  return createContractReview({ ...review, results, updatedAt: now });
}

/** 確定。全トピックに人の判断が要る（未判断の id を details で返す）。 */
export function finalizeReview(review: ContractReview, now: string): ContractReview {
  assertDraft(review, 'be finalized again');
  const missing = review.results.filter((result) => result.humanDecision === undefined).map((result) => result.topicId);
  if (missing.length > 0) throw new ContractDomainError(`finalizeReview: decide every clause type before finalizing (undecided: ${missing.join(', ')})`, { undecidedTopicIds: missing });
  return createContractReview({ ...review, status: 'finalized', finalizedAt: now, updatedAt: now });
}

/** 締結済み契約と台帳に写す、トピックごとの判断（人の判断があればそれ、無ければ判定）。 */
export function decidedVerdicts(review: ContractReview): Readonly<Record<string, Verdict>> {
  return Object.fromEntries(review.results.map((result) => [result.topicId, result.humanDecision ?? result.verdict]));
}

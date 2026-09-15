/**
 * application層: レビューの実行・取得・人の判断・確定（docs/23 §4 / §6）。
 *
 * 実行は「LLM 基準の回答を先に集める → `reviewContract`（純関数）で判定 → draft として保存」。
 * モデルが使えなくても決定的な判定は返す（レビュー全体を 409 にしない）。判定の確定は人が画面から押す。
 * 判定の後に条項か審査基準が変わったら stale（取得時に計算する）。
 */
import { articleForClause, createContractDocument, type ContractDocument } from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractReviewNotFoundError, ContractStateError } from '../../domain/contract/errors';
import { fingerprint, stableJson } from '../../domain/contract/fingerprint';
import { enabledTopics, type Playbook } from '../../domain/contract/playbook';
import type { ContractDocumentRepository, ContractPlaybookRepository, ContractReviewRepository } from '../../domain/contract/repositories';
import {
  applyHumanDecisions, createContractReview, finalizeReview, reviewContract,
  type ContractReview, type HumanDecisionInput,
} from '../../domain/contract/review';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import type { ContractCriteriaAnswerer, TopicCriteriaRequest } from './llm-criteria';
import type { ContractPlaybookResolver } from './manage-playbooks';
import { randomId, systemClock, type Clock, type IdGenerator } from './support';

/** 判定に効く文書の中身の指紋（条項・立場・相手方区分・性質・金額）。 */
export function clausesFingerprintOf(document: ContractDocument): string {
  return fingerprint(stableJson({
    clauses: document.clauses.map((clause) => ({ topicId: clause.topicId, present: clause.present, articleRef: clause.articleRef, value: clause.value, warnings: clause.warnings.map((warning) => warning.code) })),
    ourParty: document.ourParty, ourRole: document.ourRole, profile: document.counterpartyProfile, nature: document.contractNature?.value, amount: document.contractAmount,
  }));
}

/** LLM 基準を持つトピックごとの問い合わせ（条項があり、根拠が信頼できるものだけ）。 */
export function criteriaRequestsFor(document: ContractDocument, playbook: Playbook): readonly TopicCriteriaRequest[] {
  const unreliable = new Set(['extraction-failed', 'conflicting-clauses', 'quote-not-found']);
  return enabledTopics(playbook).flatMap((topic) => {
    const criteria = playbook.criteria.filter((criterion) => criterion.enabled && criterion.topicId === topic.id && criterion.check.type === 'llm' && (criterion.appliesToRoles === undefined || (document.ourRole !== undefined && criterion.appliesToRoles.includes(document.ourRole))));
    const clause = document.clauses.find((entry) => entry.topicId === topic.id);
    if (criteria.length === 0 || clause === undefined || !clause.present || clause.warnings.some((warning) => warning.code !== undefined && unreliable.has(warning.code))) return [];
    const article = articleForClause(document, clause);
    const articleText = article === undefined ? clause.evidence.map((entry) => entry.quote).join('\n') : document.body.slice(article.start, article.end);
    if (articleText.trim() === '') return [];
    return [{ topic, criteria, articleText, parties: document.parties, ...(document.ourParty === undefined ? {} : { ourParty: document.ourParty }), ...(document.ourRole === undefined ? {} : { ourRole: document.ourRole }) }];
  });
}

export class RunContractReviewUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly reviews: ContractReviewRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly answerer: ContractCriteriaAnswerer,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = randomId,
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly documentId: string; readonly playbookId?: string }, signal?: AbortSignal): Promise<ContractReview> {
    const document = await this.documents.findById(input.scope, input.documentId);
    if (document === null) throw new ContractDocumentNotFoundError(`contract document not found: ${input.documentId}`);
    if (document.status === 'imported' || document.status === 'extracted') {
      throw new ContractStateError(`confirm the clauses of "${document.title}" before running a review (open the clauses step, check the values, and press confirm)`, { documentId: document.id });
    }
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId ?? document.extraction?.playbookId);
    const previous = (await this.reviews.listByDocument(input.scope, document.id))[0];
    const { answers, cache } = await this.answerer.answer(criteriaRequestsFor(document, playbook), previous?.llmCache ?? [], signal);
    const outcome = reviewContract({ document, playbook, llmAnswers: answers });
    const now = this.clock().toISOString();
    const { tenant: _tenant, ...snapshot } = playbook;
    const modelKey = cache.length === 0 ? undefined : await this.answerer.modelKey();
    const review = createContractReview({
      tenant: input.scope, id: this.ids(), documentId: document.id, playbookId: playbook.id, playbookName: playbook.name,
      playbookSnapshot: snapshot, playbookSnapshotAt: playbook.updatedAt, clausesFingerprint: clausesFingerprintOf(document),
      results: outcome.results, documentFindings: outcome.documentFindings, overall: outcome.overall,
      status: 'draft', stale: false, llmCache: cache,
      ...(modelKey === undefined || modelKey === 'main' ? {} : { model: { provider: modelKey.split('/')[0]!, model: modelKey.slice(modelKey.indexOf('/') + 1) } }),
      createdAt: now, updatedAt: now,
    });
    return this.unitOfWork.withTransaction(async () => {
      await this.reviews.save(review);
      await this.documents.save(createContractDocument({ ...document, reviewId: review.id, updatedAt: now }));
      return review;
    });
  }
}

export class GetContractReviewUseCase {
  constructor(private readonly reviews: ContractReviewRepository, private readonly documents: ContractDocumentRepository, private readonly playbooks: ContractPlaybookRepository) {}

  async execute(scope: TenantScope, id: string): Promise<ContractReview> {
    const review = await this.reviews.findById(scope, id);
    if (review === null) throw new ContractReviewNotFoundError(`contract review not found: ${id}`);
    if (review.stale) return review;
    const document = await this.documents.findById(scope, review.documentId);
    const playbook = await this.playbooks.findById(scope, review.playbookId);
    const stale = (document !== null && clausesFingerprintOf(document) !== review.clausesFingerprint) || (playbook !== null && playbook.updatedAt > review.playbookSnapshotAt);
    return stale ? { ...review, stale: true } : review;
  }
}

export class SaveContractReviewDecisionsUseCase {
  constructor(private readonly reviews: ContractReviewRepository, private readonly clock: Clock = systemClock) {}

  async execute(input: { readonly scope: TenantScope; readonly reviewId: string; readonly decisions: readonly HumanDecisionInput[] }): Promise<ContractReview> {
    const review = await this.reviews.findById(input.scope, input.reviewId);
    if (review === null) throw new ContractReviewNotFoundError(`contract review not found: ${input.reviewId}`);
    const updated = applyHumanDecisions(review, input.decisions, this.clock().toISOString());
    await this.reviews.save(updated);
    return updated;
  }
}

export class FinalizeContractReviewUseCase {
  constructor(
    private readonly reviews: ContractReviewRepository,
    private readonly documents: ContractDocumentRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(scope: TenantScope, reviewId: string): Promise<ContractReview> {
    const review = await this.reviews.findById(scope, reviewId);
    if (review === null) throw new ContractReviewNotFoundError(`contract review not found: ${reviewId}`);
    const now = this.clock().toISOString();
    const finalized = finalizeReview(review, now);
    const document = await this.documents.findById(scope, review.documentId);
    return this.unitOfWork.withTransaction(async () => {
      await this.reviews.save(finalized);
      if (document !== null && document.status !== 'signed') await this.documents.save(createContractDocument({ ...document, status: 'reviewed', reviewId: finalized.id, updatedAt: now }));
      return finalized;
    });
  }
}

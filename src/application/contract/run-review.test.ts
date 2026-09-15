import { describe, expect, it } from 'vitest';
import {
  AT, confirmedClauses, documentFixture, evidenceOf, inMemoryContractRepositories, playbookFixture, QUOTES, SAMPLE_CONTRACT_BODY, scope,
} from '../../adapters/storage/contract-repository.fixtures';
import type { Clause, ContractDocument } from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractDomainError, ContractReviewNotFoundError, ContractStateError } from '../../domain/contract/errors';
import type { PlaybookCriterion } from '../../domain/contract/playbook';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { criteriaContext, FakeModel, gateFor, sequentialIds } from './contract.fixtures';
import { ContractCriteriaAnswerer } from './llm-criteria';
import { ContractPlaybookResolver } from './manage-playbooks';
import {
  clausesFingerprintOf, criteriaRequestsFor, FinalizeContractReviewUseCase, GetContractReviewUseCase, RunContractReviewUseCase, SaveContractReviewDecisionsUseCase,
} from './run-review';

const playbook = playbookFixture('pb-1', { isDefault: true });
const fifthArticle = (document: ContractDocument) => { const article = document.articles.find((entry) => entry.ref === '第5条')!; return document.body.slice(article.start, article.end); };
const confirmedDocument = (overrides: Partial<ContractDocument> = {}) => documentFixture('doc-1', { status: 'confirmed', clauses: confirmedClauses(), ...overrides });
const withClause = (topicId: string, change: Partial<Clause>) => confirmedClauses().map((clause) => (clause.topicId === topicId ? { ...clause, ...change } : clause));

/** 損害賠償の上限の LLM 基準（passWhen: no）に「はい」と答えるモデル。根拠は第5条にある文。 */
function yesModel(): FakeModel {
  return new FakeModel().respond((request) => ({ answers: criteriaContext(request).criteria.map((entry) => ({ criterionId: entry.criterionId, answer: 'yes', evidenceQuote: '委託料の総額を上限として賠償する', reasoning: '上限が委託料に制限されている' })) }));
}

describe('clausesFingerprintOf', () => {
  it('判定に効く中身（条項の値・警告コード・立場・区分・性質・金額）が変わったときだけ変わる', () => {
    const base = confirmedDocument();
    const fingerprint = clausesFingerprintOf(base);
    expect(clausesFingerprintOf(confirmedDocument({ updatedAt: '2030-01-01T00:00:00.000Z', title: '題名だけ変更' }))).toBe(fingerprint);
    for (const changed of [
      confirmedDocument({ clauses: withClause('liability_cap', { value: { kind: 'liability_cap', capKind: 'none' } }) }),
      confirmedDocument({ clauses: withClause('term', { warnings: [{ code: 'deadline-mismatch', message: 'x', origin: 'consistency' }] }) }),
      confirmedDocument({ ourRole: 'vendor' }),
      confirmedDocument({ counterpartyProfile: { toriteki: 'yes', freelance: 'unknown' } }),
      confirmedDocument({ contractNature: { value: 'ukeoi' } }),
      confirmedDocument({ contractAmount: 100 }),
    ]) {
      expect(clausesFingerprintOf(changed)).not.toBe(fingerprint);
    }
  });
});

describe('criteriaRequestsFor', () => {
  it('正常: LLM 基準を持ち、条項があり根拠が信頼できるトピックだけを、根拠の条文全体つきで問い合わせる', () => {
    const document = confirmedDocument();
    const requests = criteriaRequestsFor(document, playbook);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ topic: { id: 'liability_cap' }, criteria: [{ id: 'liability-cap' }], articleText: fifthArticle(document), parties: document.parties, ourParty: 'A', ourRole: 'client' });
    expect(requests[0]!.articleText).toContain('第5条（損害賠償）');
  });

  it('境界: 根拠が信頼できない（抽出失敗・競合・引用なし）・条項が無い・根拠の文が空なら問わない', () => {
    for (const code of ['extraction-failed', 'conflicting-clauses', 'quote-not-found'] as const) {
      expect(criteriaRequestsFor(confirmedDocument({ clauses: withClause('liability_cap', { warnings: [{ code, message: 'x', origin: 'extraction' }] }) }), playbook), code).toEqual([]);
    }
    // code の無い補足の警告は信頼性に影響しない。
    expect(criteriaRequestsFor(confirmedDocument({ clauses: withClause('liability_cap', { warnings: [{ message: '読み取りの補足', origin: 'extraction' }] }) }), playbook)).toHaveLength(1);
    expect(criteriaRequestsFor(confirmedDocument({ clauses: withClause('liability_cap', { present: false, evidence: [], value: undefined }) }), playbook)).toEqual([]);
    expect(criteriaRequestsFor(confirmedDocument({ clauses: confirmedClauses().filter((clause) => clause.topicId !== 'liability_cap') }), playbook)).toEqual([]);
    expect(criteriaRequestsFor(confirmedDocument({ clauses: withClause('liability_cap', { articleRef: undefined, evidence: [] }) }), playbook)).toEqual([]);
  });

  it('境界: 条文が引けなければ根拠の引用を連結して渡す', () => {
    const clauses = withClause('liability_cap', { articleRef: '第99条', evidence: [{ quote: '賠償の上限', verified: true }, { quote: '委託料の総額', verified: true }] });
    expect(criteriaRequestsFor(confirmedDocument({ clauses }), playbook)[0]?.articleText).toBe('賠償の上限\n委託料の総額');
  });

  it('境界: 立場の限定・無効な基準・無効なトピックを除く。自社側・立場が無ければ省く', () => {
    const vendorOnly: PlaybookCriterion = { id: 'vendor-llm', topicId: 'jurisdiction', appliesToRoles: ['vendor'], check: { type: 'llm', question: '専属的ですか。', passWhen: 'yes' }, onFail: 'negotiate', rationale: 'r', enabled: true, sortOrder: 1 };
    const disabled: PlaybookCriterion = { ...vendorOnly, id: 'disabled-llm', appliesToRoles: undefined, enabled: false };
    const custom = playbookFixture('pb-x', { criteria: [...playbook.criteria, vendorOnly, disabled] });
    expect(criteriaRequestsFor(confirmedDocument(), custom).map((request) => request.topic.id)).toEqual(['liability_cap']);
    expect(criteriaRequestsFor(confirmedDocument({ ourRole: 'vendor' }), custom).map((request) => request.topic.id)).toEqual(['liability_cap', 'jurisdiction']);
    const noRole = criteriaRequestsFor(confirmedDocument({ ourRole: undefined, ourParty: undefined }), custom);
    expect(noRole.map((request) => request.topic.id)).toEqual(['liability_cap']);
    expect(noRole[0]).not.toHaveProperty('ourParty');
    expect(noRole[0]).not.toHaveProperty('ourRole');
    const topicOff = playbookFixture('pb-y', { topics: playbook.topics.map((topic) => (topic.id === 'liability_cap' ? { ...topic, enabled: false } : topic)) });
    expect(criteriaRequestsFor(confirmedDocument(), topicOff)).toEqual([]);
  });
});

describe('RunContractReviewUseCase', () => {
  async function setup(model: FakeModel, options: { readonly snapshot?: { provider: string; model: string } } = {}) {
    const repos = inMemoryContractRepositories();
    await repos.playbooks.save(playbook);
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 8, 15, 1, 0, tick++));
    const resolver = new ContractPlaybookResolver(repos.playbooks, clock);
    const run = new RunContractReviewUseCase(repos.documents, repos.reviews, resolver, new ContractCriteriaAnswerer(gateFor(model, options)), new NoopUnitOfWork(), clock, sequentialIds('rv'));
    return { ...repos, run };
  }

  it('正常: モデルが使えなくても決定的な判定で draft を保存し、LLM 基準は llm-unavailable、文書にレビューを紐づける', async () => {
    const model = new FakeModel(['chat']);
    const { run, documents, reviews } = await setup(model);
    const document = confirmedDocument();
    await documents.save(document);
    const review = await run.execute({ scope, documentId: 'doc-1' });
    expect(model.requests).toEqual([]);
    expect(review).toMatchObject({ id: 'rv-1', documentId: 'doc-1', playbookId: 'pb-1', playbookName: playbook.name, playbookSnapshotAt: playbook.updatedAt, clausesFingerprint: clausesFingerprintOf(document), status: 'draft', stale: false, llmCache: [] });
    expect(review).not.toHaveProperty('model');
    expect(review.playbookSnapshot).not.toHaveProperty('tenant');
    expect(review.playbookSnapshot.criteria).toEqual(playbook.criteria);
    const liability = review.results.find((result) => result.topicId === 'liability_cap')!;
    expect(liability).toMatchObject({ verdict: 'unresolved', criteria: [{ criterionId: 'liability-cap', outcome: 'unresolved', reasonCode: 'llm-unavailable' }] });
    expect(review.results.find((result) => result.topicId === 'term')).toMatchObject({ verdict: 'accept', present: true });
    expect(review.results.find((result) => result.topicId === 'jurisdiction')).toMatchObject({ verdict: 'accept' });
    expect(await reviews.findById(scope, 'rv-1')).toEqual(review);
    expect(await documents.findById(scope, 'doc-1')).toMatchObject({ reviewId: 'rv-1', status: 'confirmed', updatedAt: review.createdAt });
  });

  it('正常: モデルが使えれば回答で判定し、回答とモデルの指紋をレビューに残す（「/」を含むモデル名も崩さない）', async () => {
    const model = yesModel();
    const { run, documents } = await setup(model, { snapshot: { provider: 'local', model: 'org/gemma-12b' } });
    await documents.save(confirmedDocument());
    const review = await run.execute({ scope, documentId: 'doc-1' });
    expect(model.requests).toHaveLength(1);
    expect(review.model).toEqual({ provider: 'local', model: 'org/gemma-12b' });
    expect(review.llmCache).toEqual([expect.objectContaining({ criterionId: 'liability-cap', answer: 'yes', key: expect.stringMatching(/:local\/org\/gemma-12b$/u) })]);
    expect(review.results.find((result) => result.topicId === 'liability_cap')).toMatchObject({ verdict: 'negotiate', criteria: [{ outcome: 'fail', reasonCode: 'llm-criterion-failed' }], recommendedTexts: [expect.stringContaining('故意又は重大な過失')] });
  });

  it('正常: 再レビューは前回のレビューの回答を再利用する（条文・質問・モデルが同じならモデルを呼ばない）', async () => {
    const model = yesModel();
    const { run, documents, reviews } = await setup(model);
    await documents.save(confirmedDocument());
    const first = await run.execute({ scope, documentId: 'doc-1' });
    // 指紋が取れない（main スロット）ときは model を持たないが、回答は残る。
    expect(first).not.toHaveProperty('model');
    expect(first.llmCache).toHaveLength(1);
    const second = await run.execute({ scope, documentId: 'doc-1' });
    expect(model.requests).toHaveLength(1);
    expect(second.id).toBe('rv-2');
    expect(second.llmCache).toEqual(first.llmCache);
    expect(second.results).toEqual(first.results);
    expect((await reviews.listByDocument(scope, 'doc-1')).map((review) => review.id)).toEqual(['rv-2', 'rv-1']);
    expect((await documents.findById(scope, 'doc-1'))?.reviewId).toBe('rv-2');
  });

  it('正常: 審査基準は指定 → 抽出に使った審査基準 → 既定の順（reviewed の文書も再レビューできる）', async () => {
    const { run, documents, playbooks } = await setup(new FakeModel(['chat']));
    await playbooks.save(playbookFixture('pb-2', { name: '抽出時の基準' }));
    await documents.save(confirmedDocument({ status: 'reviewed', extraction: { playbookId: 'pb-2', promptTemplateVersion: 'contract-extract/v1', chunks: [], warnings: [], unscannedArticleRefs: [], scanAllArticles: false, extractedAt: AT } }));
    expect((await run.execute({ scope, documentId: 'doc-1' })).playbookName).toBe('抽出時の基準');
    expect((await run.execute({ scope, documentId: 'doc-1', playbookId: 'pb-1' })).playbookId).toBe('pb-1');
  });

  it('異常: 無い文書は 404、条項を確定していない（imported / extracted）文書は 409 で確定の手順を示す', async () => {
    const { run, documents, reviews } = await setup(new FakeModel());
    await expect(run.execute({ scope, documentId: 'missing' })).rejects.toThrow(ContractDocumentNotFoundError);
    for (const status of ['imported', 'extracted'] as const) {
      await documents.save(documentFixture(`doc-${status}`, { status }));
      const error = await run.execute({ scope, documentId: `doc-${status}` }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ContractStateError);
      expect(error).toMatchObject({ target: { documentId: `doc-${status}` }, message: expect.stringContaining('press confirm') });
    }
    expect(await reviews.listByDocument(scope, 'doc-imported')).toEqual([]);
  });
});

describe('GetContractReviewUseCase（stale の判定）', () => {
  async function reviewed() {
    const repos = inMemoryContractRepositories();
    await repos.playbooks.save(playbook);
    const clock = () => new Date('2026-09-15T01:00:00.000Z');
    const run = new RunContractReviewUseCase(repos.documents, repos.reviews, new ContractPlaybookResolver(repos.playbooks, clock), new ContractCriteriaAnswerer(gateFor(new FakeModel(['chat']))), new NoopUnitOfWork(), clock, sequentialIds('rv'));
    await repos.documents.save(confirmedDocument());
    const review = await run.execute({ scope, documentId: 'doc-1' });
    return { ...repos, review, get: new GetContractReviewUseCase(repos.reviews, repos.documents, repos.playbooks) };
  }

  it('正常: 判定の後に何も変わっていなければ stale ではない', async () => {
    const { get, review } = await reviewed();
    expect(await get.execute(scope, review.id)).toEqual(review);
  });

  it('境界: 条項が変わったら stale（取得時に計算し、保存はしない）', async () => {
    const { get, review, documents, reviews } = await reviewed();
    await documents.save(confirmedDocument({ clauses: withClause('liability_cap', { value: { kind: 'liability_cap', capKind: 'none' } }), reviewId: review.id }));
    expect(await get.execute(scope, review.id)).toEqual({ ...review, stale: true });
    expect((await reviews.findById(scope, review.id))?.stale).toBe(false);
  });

  it('境界: 審査基準が判定の後に更新されたら stale。同時刻なら stale ではない', async () => {
    const { get, review, playbooks } = await reviewed();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true, updatedAt: review.playbookSnapshotAt }));
    expect((await get.execute(scope, review.id)).stale).toBe(false);
    await playbooks.save(playbookFixture('pb-1', { isDefault: true, updatedAt: '2026-09-20T00:00:00.000Z' }));
    expect((await get.execute(scope, review.id)).stale).toBe(true);
  });

  it('境界: 保存済みの stale はそのまま返す。文書・審査基準が消えていても stale にはしない', async () => {
    const { get, review, documents, playbooks, reviews } = await reviewed();
    await documents.delete(scope, 'doc-1');
    await playbooks.delete(scope, 'pb-1');
    expect((await get.execute(scope, review.id)).stale).toBe(false);
    await reviews.save({ ...review, stale: true });
    expect((await get.execute(scope, review.id)).stale).toBe(true);
    await expect(get.execute(scope, 'missing')).rejects.toThrow(ContractReviewNotFoundError);
  });
});

describe('SaveContractReviewDecisionsUseCase / FinalizeContractReviewUseCase', () => {
  const NOW = new Date('2026-09-16T00:00:00.000Z');

  async function reviewed(documentOverrides: Partial<ContractDocument> = {}) {
    const repos = inMemoryContractRepositories();
    await repos.playbooks.save(playbook);
    const clock = () => NOW;
    const run = new RunContractReviewUseCase(repos.documents, repos.reviews, new ContractPlaybookResolver(repos.playbooks, clock), new ContractCriteriaAnswerer(gateFor(new FakeModel(['chat']))), new NoopUnitOfWork(), clock, sequentialIds('rv'));
    await repos.documents.save(confirmedDocument());
    const review = await run.execute({ scope, documentId: 'doc-1' });
    if (Object.keys(documentOverrides).length > 0) await repos.documents.save(confirmedDocument({ reviewId: review.id, ...documentOverrides }));
    return {
      ...repos, review,
      decide: new SaveContractReviewDecisionsUseCase(repos.reviews, clock),
      finalize: new FinalizeContractReviewUseCase(repos.reviews, repos.documents, new NoopUnitOfWork(), clock),
    };
  }

  it('正常: 人の判断とメモを保存し、全トピックを判断したら確定して文書を reviewed にする', async () => {
    const { decide, finalize, review, reviews, documents } = await reviewed();
    const partial = await decide.execute({ scope, reviewId: review.id, decisions: [{ topicId: 'liability_cap', decision: 'negotiate', note: '上限の除外を交渉する' }] });
    expect(partial.results.find((result) => result.topicId === 'liability_cap')).toMatchObject({ humanDecision: 'negotiate', humanNote: '上限の除外を交渉する' });
    expect(partial.updatedAt).toBe(NOW.toISOString());
    expect(await reviews.findById(scope, review.id)).toEqual(partial);

    const error = await finalize.execute(scope, review.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractDomainError);
    expect((error as ContractDomainError).details?.['undecidedTopicIds']).toContain('term');
    expect((await documents.findById(scope, 'doc-1'))?.status).toBe('confirmed');

    await decide.execute({ scope, reviewId: review.id, decisions: review.results.filter((result) => result.topicId !== 'liability_cap').map((result) => ({ topicId: result.topicId, decision: 'accept' as const })) });
    const finalized = await finalize.execute(scope, review.id);
    expect(finalized).toMatchObject({ status: 'finalized', finalizedAt: NOW.toISOString() });
    expect(await documents.findById(scope, 'doc-1')).toMatchObject({ status: 'reviewed', reviewId: review.id, updatedAt: NOW.toISOString() });
    // 確定後は判断を変えられない（新しいレビューを実行する）。
    await expect(decide.execute({ scope, reviewId: review.id, decisions: [{ topicId: 'term', decision: 'reject' }] })).rejects.toThrow(ContractStateError);
    await expect(finalize.execute(scope, review.id)).rejects.toThrow(ContractStateError);
  });

  it('境界: 締結済みの文書は確定しても状態を変えない。文書が消えていてもレビューは確定できる', async () => {
    const signed = await reviewed({ status: 'signed', signedContractId: 'sc-1' });
    await signed.decide.execute({ scope, reviewId: signed.review.id, decisions: signed.review.results.map((result) => ({ topicId: result.topicId, decision: 'accept' as const })) });
    await signed.finalize.execute(scope, signed.review.id);
    expect((await signed.documents.findById(scope, 'doc-1'))?.status).toBe('signed');

    const orphan = await reviewed();
    await orphan.documents.delete(scope, 'doc-1');
    await orphan.decide.execute({ scope, reviewId: orphan.review.id, decisions: orphan.review.results.map((result) => ({ topicId: result.topicId, decision: 'reject' as const })) });
    await expect(orphan.finalize.execute(scope, orphan.review.id)).resolves.toMatchObject({ status: 'finalized' });
    expect(await orphan.documents.findById(scope, 'doc-1')).toBeNull();
  });

  it('異常: 無いレビューは 404、レビューに無いトピックの判断は 400', async () => {
    const { decide, finalize, review } = await reviewed();
    await expect(decide.execute({ scope, reviewId: 'missing', decisions: [] })).rejects.toThrow(ContractReviewNotFoundError);
    await expect(finalize.execute(scope, 'missing')).rejects.toThrow(ContractReviewNotFoundError);
    await expect(decide.execute({ scope, reviewId: review.id, decisions: [{ topicId: 'warranty', decision: 'accept' }] })).rejects.toThrow('the review has no clause type "warranty"');
  });
});

// 根拠の位置が本文の中にあること（fixture の前提）を明示しておく。
it('前提: fixture の根拠は本文の位置を指す', () => {
  const evidence = evidenceOf(QUOTES.liability);
  expect(SAMPLE_CONTRACT_BODY.slice(evidence.start, evidence.end)).toBe(QUOTES.liability);
});

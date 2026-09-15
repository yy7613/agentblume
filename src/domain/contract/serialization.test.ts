import { describe, expect, it } from 'vitest';
import { createContractDocument, type ContractDocument } from './document';
import { ContractDomainError } from './errors';
import { findPlaybookTemplate, playbookFromTemplate } from './playbook-templates';
import { createContractReview, reviewContract, type ContractReview } from './review';
import { segmentArticles, singlePage } from './segmentation';
import {
  deserializeContractDocument, deserializeContractReview, deserializePlaybook, deserializeSignedContract,
  serializeContractDocument, serializeContractReview, serializePlaybook, serializeSignedContract,
} from './serialization';
import { computeDeadlines, createSignedContract, type SignedClause, type SignedContract } from './signed-contract';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const NOW = '2026-09-15T00:00:00.000Z';
const BODY = '株式会社サンプル商事（以下「甲」という。）と株式会社テスト（以下「乙」という。）\n第1条（期間）本契約の有効期間は2026年4月1日から1年間とする。\n第2条（更新）1年間更新する。\n第3条（管轄）東京地方裁判所。';

const playbook = playbookFromTemplate(findPlaybookTemplate('outsourcing-client')!, { tenant, id: 'pb1', isDefault: true, now: NOW });

const document: ContractDocument = createContractDocument({
  tenant, id: 'doc1', title: '業務委託契約書', source: { type: 'pdf-text', fileName: 'a.pdf', pageCount: 1, sha256: 'h' }, body: BODY, pages: singlePage(BODY),
  articles: segmentArticles(BODY, singlePage(BODY), 4000), parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '株式会社テスト' } },
  ourParty: 'A', ourRole: 'client', counterpartyProfile: { toriteki: 'yes', freelance: 'unknown' }, contractNature: { value: 'ukeoi' }, contractAmount: 500_000,
  extraction: { promptTemplateVersion: 'contract-extract/v1', chunks: [{ index: 0, articleRefs: ['第1条'], topicIds: ['term'], status: 'ok' }], warnings: [], unscannedArticleRefs: [], scanAllArticles: false, extractedAt: NOW },
  clauses: [{ topicId: 'term', present: true, articleRef: '第1条', evidence: [{ quote: '本契約の有効期間', start: BODY.indexOf('本契約の有効期間'), end: BODY.indexOf('本契約の有効期間') + 8, verified: true }], value: { kind: 'term', startDate: '2026-04-01', durationMonths: 12, startsOnSigning: false }, confidence: 0.8, source: 'llm', warnings: [{ message: 'note', origin: 'consistency' }] }],
  status: 'confirmed', createdAt: NOW, updatedAt: NOW,
});

const outcome = reviewContract({ document, playbook, llmAnswers: new Map([['liability-cap', { status: 'answered', answer: 'unclear', evidenceQuote: null, reasoning: 'r' }]]) });
const { tenant: _omit, ...snapshot } = playbook;
const review: ContractReview = createContractReview({
  tenant, id: 'r1', documentId: 'doc1', playbookId: 'pb1', playbookName: playbook.name, playbookSnapshot: snapshot, playbookSnapshotAt: NOW, clausesFingerprint: 'fp',
  results: outcome.results.map((result) => ({ ...result, humanDecision: 'accept' as const })), documentFindings: outcome.documentFindings, overall: outcome.overall,
  status: 'finalized', stale: false, llmCache: [{ key: 'k', criterionId: 'liability-cap', answer: 'unclear', evidenceQuote: null, reasoning: 'r' }], model: { provider: 'p', model: 'm' }, finalizedAt: NOW, createdAt: NOW, updatedAt: NOW,
});

const clauses: SignedClause[] = [
  { topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第1条', quote: '本契約の有効期間', quoteVerified: true, value: { kind: 'term', startDate: '2026-04-01', durationMonths: 12, startsOnSigning: false } },
  { topicId: 'auto_renewal', topicLabel: '自動更新', valueKind: 'auto_renewal', present: true, quoteVerified: false, value: { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false } },
  { topicId: 'liability_cap', topicLabel: '損害賠償の上限', valueKind: 'liability_cap', present: false, quoteVerified: false },
];
const signed: SignedContract = createSignedContract({
  tenant, id: 'sc1', documentId: 'doc1', reviewId: 'r1', title: '業務委託契約', counterpartyName: '株式会社テスト', signedDate: '2026-03-20', signingMethod: 'paper', ourParty: 'A',
  clauses, stampDuty: { documentTypeCode: 'no2', amount: 200, affixed: true }, deadlines: computeDeadlines(clauses, '2026-03-20', '2026-09-15').deadlines, status: 'active',
  reviewVerdicts: { term: 'accept' }, warnings: [{ code: 'notice-deadline-passed', message: 'm' }], createdAt: NOW, updatedAt: NOW,
});

const aggregates = [
  ['Playbook', playbook, serializePlaybook, deserializePlaybook],
  ['ContractDocument', document, serializeContractDocument, deserializeContractDocument],
  ['ContractReview', review, serializeContractReview, deserializeContractReview],
  ['SignedContract', signed, serializeSignedContract, deserializeSignedContract],
] as const;

function expectRejected(action: () => unknown, message: RegExp): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ContractDomainError);
  expect((caught as Error).message).toMatch(message);
}

describe('serialization: 往復', () => {
  it.each(aggregates)('正常: %s は serialize → JSON → deserialize で元に戻る', (_label, value, serialize, deserialize) => {
    const serialized = (serialize as (input: typeof value) => unknown)(value);
    expect(serialized).toEqual(value);
    expect(serialized).not.toBe(value);
    expect((deserialize as (input: unknown) => unknown)(JSON.parse(JSON.stringify(serialized)))).toEqual(value);
  });

  it('境界: 任意キーに undefined が入った記録も復元できる（キーごと落とす）', () => {
    const restored = deserializeContractDocument({ ...serializeContractDocument(document), reviewId: undefined, ourParty: undefined });
    expect(restored).not.toHaveProperty('reviewId');
    expect(restored).not.toHaveProperty('ourParty');
    expect(deserializeSignedContract({ ...serializeSignedContract(signed), reviewId: undefined })).not.toHaveProperty('reviewId');
  });
});

describe('serialization: 壊れた記録', () => {
  it.each([
    ['Playbook の id が数値', () => deserializePlaybook({ ...playbook, id: 1 }), /^deserializePlaybook: invalid record: id: /u],
    ['Playbook が null', () => deserializePlaybook(null), /deserializePlaybook: invalid record: \(root\): /u],
    ['Playbook の形は正しいが不変条件違反', () => deserializePlaybook({ ...playbook, topics: [] }), /createPlaybook: topics must have 1 to 50/u],
    ['文書の本文が無い', () => deserializeContractDocument({ ...document, body: undefined }), /^deserializeContractDocument: invalid record: body: /u],
    ['文書の条項が重複', () => deserializeContractDocument({ ...document, clauses: [...document.clauses, ...document.clauses] }), /createContractDocument: clauses has the clause type "term" twice/u],
    ['レビューの stale が文字列', () => deserializeContractReview({ ...review, stale: 'no' }), /^deserializeContractReview: invalid record: stale: /u],
    ['レビューの overall が語彙外', () => deserializeContractReview({ ...review, overall: 'maybe' }), /createContractReview: overall must be one of/u],
    ['締結済み契約の判断が文字列でない', () => deserializeSignedContract({ ...signed, reviewVerdicts: { term: 1 } }), /^deserializeSignedContract: invalid record: reviewVerdicts\.term: /u],
    ['締結済み契約の締結日が暦に無い', () => deserializeSignedContract({ ...signed, signedDate: '2026-02-30' }), /createSignedContract: signedDate must be a calendar date/u],
    ['締結済み契約が配列', () => deserializeSignedContract([]), /deserializeSignedContract: invalid record: \(root\)/u],
  ])('異常: %s は ContractDomainError', (_label, action, message) => {
    expectRejected(action, message);
  });
});

/**
 * adapters層: 契約 BC のリポジトリ共有契約テストと application のテストが使う組み立て（テスト専用）。
 *
 * すべて domain の create* を通すので、契約テストが「保存できるはずのない値」を保存して実装差を見逃すことがない。
 * application のテストからも使う（application の fixtures は adapters を import できないため、ここに置く）。
 */
import { createContractDocument, type Clause, type ContractDocument } from '../../domain/contract/document';
import { createPlaybook, type Playbook } from '../../domain/contract/playbook';
import { findPlaybookTemplate, playbookFromTemplate } from '../../domain/contract/playbook-templates';
import { createContractReview, type ContractReview } from '../../domain/contract/review';
import { detectParties, segmentArticles, singlePage } from '../../domain/contract/segmentation';
import { createSignedContract, type Deadline, type SignedClause, type SignedContract } from '../../domain/contract/signed-contract';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import {
  InMemoryContractDocumentRepository, InMemoryContractPlaybookRepository, InMemoryContractReviewRepository, InMemorySignedContractRepository,
} from './in-memory-contract-repositories';

export const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
export const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
export const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

export const AT = '2026-09-13T00:00:00.000Z';

/** 自社名（審査基準の ourCompanyNames に入れると甲に当たる）。 */
export const OUR_COMPANY = '株式会社サンプル商事';
export const COUNTERPARTY = '架空テック合同会社';

/**
 * 合成の業務委託契約書（当事者は架空）。条見出しが 3 件以上あるので条文分割され、前文・後文も残る。
 * 第1条はどのトピックのキーワードにも当たらない（未スキャン条文の確認用）。
 */
export const SAMPLE_CONTRACT_BODY = [
  '業務委託契約書',
  '',
  `${OUR_COMPANY}（以下「甲」という。）と${COUNTERPARTY}（以下「乙」という。）は、次のとおり業務委託契約を締結する。`,
  '',
  '第1条（目的）',
  '甲は乙に対し、ソフトウェア開発支援業務を依頼し、乙はこれを引き受ける。',
  '',
  '第2条（契約期間）',
  '本契約の期間は、2026年4月1日から2027年3月31日までとする。',
  '',
  '第3条（自動更新）',
  '期間満了の3か月前までにいずれの当事者からも書面による申出がないときは、本契約は同一条件でさらに1年間更新されるものとし、以後も同様とする。',
  '',
  '第4条（委託料の支払）',
  '甲は、毎月末日締め翌月末日までに乙の指定する銀行口座へ振り込む方法により委託料を支払う。',
  '',
  '第5条（損害賠償）',
  '乙が甲に損害を与えたときは、乙は甲に対し、本契約に基づき受領した委託料の総額を上限として賠償する。',
  '',
  '第6条（管轄）',
  '本契約に関する紛争は、東京地方裁判所を第一審の専属的合意管轄裁判所とする。',
  '',
  '本契約締結の証として、本書2通を作成し、甲乙記名押印のうえ各1通を保有する。',
  '2026年3月15日',
  '',
].join('\n');

export const QUOTES = {
  term: '本契約の期間は、2026年4月1日から2027年3月31日までとする。',
  renewal: '期間満了の3か月前までにいずれの当事者からも書面による申出がないときは、本契約は同一条件でさらに1年間更新されるものとし、以後も同様とする。',
  payment: '甲は、毎月末日締め翌月末日までに乙の指定する銀行口座へ振り込む方法により委託料を支払う。',
  liability: '乙が甲に損害を与えたときは、乙は甲に対し、本契約に基づき受領した委託料の総額を上限として賠償する。',
  jurisdiction: '本契約に関する紛争は、東京地方裁判所を第一審の専属的合意管轄裁判所とする。',
} as const;

/** 本文中の引用の位置つき根拠（照合済み）。 */
export function evidenceOf(quote: string, body: string = SAMPLE_CONTRACT_BODY): { readonly quote: string; readonly start: number; readonly end: number; readonly verified: true } {
  const start = body.indexOf(quote);
  if (start === -1) throw new Error(`fixture quote is not in the body: ${quote}`);
  return { quote, start, end: start + quote.length, verified: true };
}

/** 業務委託（発注者側）テンプレートの審査基準。 */
export function playbookFixture(id: string, overrides: Partial<Playbook> = {}): Playbook {
  const base = playbookFromTemplate(findPlaybookTemplate('outsourcing-client')!, { tenant: scope, id, isDefault: false, now: AT, ourCompanyNames: [OUR_COMPANY] });
  return createPlaybook({ ...base, extraction: { scanAllArticles: false, chunkMaxChars: 4000 }, ...overrides });
}

/** サンプル本文から人が確定した条項（期間・自動更新・通知・支払・上限・管轄）。 */
export function confirmedClauses(): readonly Clause[] {
  return [
    { topicId: 'term', present: true, articleRef: '第2条', evidence: [evidenceOf(QUOTES.term)], value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }, source: 'llm', warnings: [] },
    { topicId: 'auto_renewal', present: true, articleRef: '第3条', evidence: [evidenceOf(QUOTES.renewal)], value: { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: true }, source: 'llm', warnings: [] },
    { topicId: 'renewal_notice', present: true, articleRef: '第3条', evidence: [evidenceOf(QUOTES.renewal)], value: { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }, source: 'llm', warnings: [] },
    { topicId: 'payment', present: true, articleRef: '第4条', evidence: [evidenceOf(QUOTES.payment)], value: { kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end', method: 'bank_transfer' }, source: 'llm', warnings: [] },
    { topicId: 'liability_cap', present: true, articleRef: '第5条', evidence: [evidenceOf(QUOTES.liability)], value: { kind: 'liability_cap', capKind: 'fees_paid' }, source: 'llm', warnings: [] },
    { topicId: 'subcontracting', present: false, evidence: [], source: 'llm', warnings: [] },
    { topicId: 'jurisdiction', present: true, articleRef: '第6条', evidence: [evidenceOf(QUOTES.jurisdiction)], value: { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: true }, source: 'manual', warnings: [] },
  ];
}

/** サンプル本文の文書。既定は取込直後（imported・条項なし）。 */
export function documentFixture(id: string, overrides: Partial<ContractDocument> = {}): ContractDocument {
  const body = overrides.body ?? SAMPLE_CONTRACT_BODY;
  const pages = overrides.pages ?? singlePage(body);
  const detected = detectParties(body);
  return createContractDocument({
    tenant: scope,
    id,
    title: `業務委託契約書 ${id}`,
    source: { type: 'text', fileName: 'contract.txt', sha256: 'sha-sample' },
    body,
    pages,
    articles: segmentArticles(body, pages, 4000),
    parties: { A: { label: '甲', ...(detected.A === undefined ? {} : { name: detected.A }) }, B: { label: '乙', ...(detected.B === undefined ? {} : { name: detected.B }) } },
    ourParty: 'A',
    ourRole: 'client',
    counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' },
    clauses: [],
    status: 'imported',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function reviewFixture(id: string, overrides: Partial<ContractReview> = {}): ContractReview {
  const { tenant: _tenant, ...snapshot } = playbookFixture('playbook-1');
  return createContractReview({
    tenant: scope,
    id,
    documentId: 'doc-1',
    playbookId: 'playbook-1',
    playbookName: snapshot.name,
    playbookSnapshot: snapshot,
    playbookSnapshotAt: AT,
    clausesFingerprint: 'fingerprint-1',
    results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [{ criterionId: 'term-required', outcome: 'pass' }], recommendedTexts: [] }],
    documentFindings: [],
    overall: 'accept',
    status: 'draft',
    stale: false,
    llmCache: [{ key: 'k1', criterionId: 'liability-cap', answer: 'no', evidenceQuote: '委託料の総額を上限', reasoning: '上限がある' }],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** 締結時の条項の写し（期間 1 年・同一条件で自動更新・満了の 3 か月前まで通知）。 */
export function signedClausesFixture(): readonly SignedClause[] {
  return [
    { topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第2条', quote: QUOTES.term, quoteVerified: true, value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false } },
    { topicId: 'auto_renewal', topicLabel: '自動更新', valueKind: 'auto_renewal', present: true, articleRef: '第3条', quote: QUOTES.renewal, quoteVerified: true, value: { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: true } },
    { topicId: 'renewal_notice', topicLabel: '更新拒絶の通知期限', valueKind: 'notice', present: true, articleRef: '第3条', quote: QUOTES.renewal, quoteVerified: true, value: { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false } },
    { topicId: 'liability_cap', topicLabel: '損害賠償の上限', valueKind: 'liability_cap', present: true, articleRef: '第5条', quote: QUOTES.liability, quoteVerified: false, value: { kind: 'liability_cap', capKind: 'none' } },
    { topicId: 'subcontracting', topicLabel: '再委託', valueKind: 'permission', present: false, quoteVerified: true },
  ];
}

/** 第 1 期の期限（signedClausesFixture から計算した値と同じ）。 */
export function deadlinesFixture(): readonly Deadline[] {
  return [
    { id: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-12-31', basis: '第3条: 満了の3か月前まで', termIndex: 1, termEnd: '2027-03-31', status: 'open' },
    { id: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31', basis: '第2条: 満了日', termIndex: 1, termEnd: '2027-03-31', status: 'open' },
    { id: 'renewal-1', kind: 'renewal', dueDate: '2027-04-01', basis: '第3条: 満了の翌日に更新', termIndex: 1, termEnd: '2027-03-31', status: 'open' },
  ];
}

export function signedContractFixture(id: string, overrides: Partial<SignedContract> = {}): SignedContract {
  return createSignedContract({
    tenant: scope,
    id,
    documentId: `doc-${id}`,
    title: `業務委託契約 ${id}`,
    counterpartyName: COUNTERPARTY,
    signedDate: '2026-03-15',
    signingMethod: 'electronic',
    ourParty: 'A',
    clauses: signedClausesFixture(),
    deadlines: deadlinesFixture(),
    status: 'active',
    reviewVerdicts: { term: 'accept' },
    warnings: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** application のテスト用: InMemory のリポジトリ一式。 */
export function inMemoryContractRepositories() {
  return {
    playbooks: new InMemoryContractPlaybookRepository(),
    documents: new InMemoryContractDocumentRepository(),
    reviews: new InMemoryContractReviewRepository(),
    signed: new InMemorySignedContractRepository(),
  };
}

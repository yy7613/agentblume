import { describe, expect, it } from 'vitest';
import type { ClauseValue } from './clause-value';
import type { Clause, ClauseWarning, ContractDocument } from './document';
import { ContractDomainError, ContractStateError } from './errors';
import { createPlaybook, type ClauseTopic, type CriterionCheck, type Playbook, type PlaybookCriterion } from './playbook';
import { DEFAULT_LEGAL_SETTINGS, DEFAULT_STAMP_DUTY } from './playbook-templates';
import { REASON_CODES, type ReasonCode } from './reasons';
import { applyHumanDecisions, createContractReview, decidedVerdicts, fieldValueOf, finalizeReview, reviewContract, worstVerdict, type ContractReview, type LlmCriterionAnswer, type ReviewOutcome, type TopicResult, type Verdict } from './review';
import { segmentArticles, singlePage } from './segmentation';
import type { OurRole, SigningMethod } from './vocabulary';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const NOW = '2026-09-15T00:00:00.000Z';

const BODY = [
  '株式会社サンプル商事（以下「甲」という。）と株式会社テスト（以下「乙」という。）は次のとおり契約する。',
  '第1条（期間）本契約の有効期間は2026年4月1日から2027年3月31日までとする。',
  '第2条（損害賠償）乙の賠償額は委託料を上限とする。',
  '第3条（支払）甲は月末締め翌月末日に振込で支払う。',
  '第4条（再委託）乙は甲の承諾なく再委託できる。',
].join('\n');

const topic = (id: string, valueKind: ClauseTopic['valueKind'], sortOrder = 0, enabled = true): ClauseTopic => ({ id, label: `L-${id}`, valueKind, keywords: [], guidance: '', enabled, sortOrder });
const criterion = (id: string, topicId: string, check: CriterionCheck, extra: Partial<PlaybookCriterion> = {}): PlaybookCriterion => ({ id, topicId, check, onFail: 'negotiate', rationale: `R-${id}`, enabled: true, sortOrder: 0, ...extra });
const playbook = (topics: readonly ClauseTopic[], criteria: readonly PlaybookCriterion[], extra: Partial<Playbook> = {}): Playbook => createPlaybook({
  tenant, id: 'pb', name: '審査基準', isDefault: true, ourRole: 'client', ourCompanyNames: [], topics, criteria, legal: DEFAULT_LEGAL_SETTINGS,
  stampDuty: { enabled: false, documentTypes: [] }, extraction: { scanAllArticles: false, chunkMaxChars: 4000 }, createdAt: NOW, updatedAt: NOW, ...extra,
});
const clause = (topicId: string, value?: ClauseValue, overrides: Partial<Clause> = {}): Clause => ({
  topicId, present: true, evidence: [{ quote: '根拠', verified: true }], ...(value === undefined ? {} : { value }), source: 'manual', warnings: [], ...overrides,
});
const warning = (code: ReasonCode, extra: Partial<ClauseWarning> = {}): ClauseWarning => ({ code, message: code, origin: 'extraction', ...extra });
const doc = (clauses: readonly Clause[], overrides: Partial<ContractDocument> = {}): ContractDocument => ({
  tenant, id: 'doc1', title: '業務委託契約書', source: { type: 'text' }, body: BODY, pages: singlePage(BODY), articles: segmentArticles(BODY, singlePage(BODY), 4000),
  parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '株式会社テスト' } }, ourParty: 'A', ourRole: 'client',
  counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, clauses, status: 'confirmed', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const without = <K extends keyof ContractDocument>(document: ContractDocument, key: K): ContractDocument => { const copy = { ...document }; delete copy[key]; return copy; };
const run = (book: Playbook, document: ContractDocument, answers: Readonly<Record<string, LlmCriterionAnswer>> = {}, signingMethod?: SigningMethod): ReviewOutcome =>
  reviewContract({ document, playbook: book, llmAnswers: new Map(Object.entries(answers)), ...(signingMethod === undefined ? {} : { signingMethod }) });
const codesOf = (outcome: ReviewOutcome): ReasonCode[] => [...outcome.results.flatMap((result) => result.reasons.map((reason) => reason.code)), ...outcome.documentFindings.map((finding) => finding.code)];
const resultOf = (outcome: ReviewOutcome, topicId: string): TopicResult => outcome.results.find((result) => result.topicId === topicId)!;

const monthEndTwo: ClauseValue = { kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end', method: 'bank_transfer' };
const capLlm = criterion('cap-llm', 'cap', { type: 'llm', question: '委託料以下に制限されていますか。', passWhen: 'no' });
const capClause = clause('cap', { kind: 'liability_cap', capKind: 'fees_paid' }, { articleRef: '第2条' });
const answered = (answer: 'yes' | 'no' | 'unclear', evidenceQuote: string | null): LlmCriterionAnswer => ({ status: 'answered', answer, evidenceQuote, reasoning: '理由' });

/* ---------------------------------------------------------------------------
 * 理由コードの網羅（docs/23 §12: §4.5 の全 code を 1 回以上出す）
 * ------------------------------------------------------------------------ */

const REASON_SCENARIOS: readonly [ReasonCode, () => ReviewOutcome][] = [
  ['clause-missing', () => run(playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' })]), doc([]))],
  ['quote-not-found', () => run(playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' })]), doc([clause('term', undefined, { warnings: [warning('quote-not-found')] })]))],
  ['conflicting-clauses', () => run(playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' })]), doc([clause('term', undefined, { warnings: [warning('conflicting-clauses')] })]))],
  ['extraction-failed', () => run(playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' })]), doc([clause('term', undefined, { warnings: [warning('extraction-failed')] })]))],
  ['value-unparsed', () => run(playbook([topic('cap', 'liability_cap')], [criterion('c', 'cap', { type: 'condition', conditions: [{ field: 'cap.amount', op: 'lte', value: 100 }] })]), doc([clause('cap', { kind: 'liability_cap', capKind: 'fixed_amount' }, { warnings: [warning('value-unparsed')] })]))],
  ['field-missing', () => run(playbook([topic('cap', 'liability_cap')], [criterion('c', 'cap', { type: 'condition', conditions: [{ field: 'cap.amount', op: 'lte', value: 100 }] })]), doc([clause('cap', { kind: 'liability_cap', capKind: 'fixed_amount' })]))],
  ['role-not-set', () => run(playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' }, { appliesToRoles: ['client'] })]), without(doc([clause('term')]), 'ourRole'))],
  ['unknown-topic', () => run(playbook([topic('term', 'term'), topic('old', 'text', 0, false)], [criterion('c', 'old', { type: 'required' })]), doc([]))],
  ['criterion-failed', () => run(playbook([topic('sub', 'permission')], [criterion('c', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'in', value: ['prior_consent'] }] })]), doc([clause('sub', { kind: 'permission', policy: 'free' })]))],
  ['llm-criterion-failed', () => run(playbook([topic('cap', 'liability_cap')], [capLlm]), doc([capClause]), { 'cap-llm': answered('yes', '委託料を上限とする') })],
  ['llm-unclear', () => run(playbook([topic('cap', 'liability_cap')], [capLlm]), doc([capClause]), { 'cap-llm': { status: 'failed' } })],
  ['llm-evidence-missing', () => run(playbook([topic('cap', 'liability_cap')], [capLlm]), doc([capClause]), { 'cap-llm': answered('yes', '月末締め翌月末日') })],
  ['llm-unavailable', () => run(playbook([topic('cap', 'liability_cap')], [capLlm]), doc([capClause]))],
  ['payment-over-limit', () => run(playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'payment-max-days' })]), doc([clause('pay', monthEndTwo)]))],
  ['payment-terms-indeterminate', () => run(playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'payment-max-days' })]), doc([clause('pay', { kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end' })]))],
  ['payment-basis-acceptance', () => run(playbook([topic('pay', 'payment_terms')], []), doc([clause('pay', { kind: 'payment_terms', basis: 'acceptance', daysAfterBasis: 30 })]))],
  ['prohibited-payment-method', () => run(playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'prohibited-payment-method' })]), doc([clause('pay', { ...monthEndTwo, method: 'promissory_note' })]))],
  ['counterparty-profile-missing', () => run(playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'payment-max-days' })]), doc([clause('pay', monthEndTwo)], { counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' } }))],
  ['deadline-mismatch', () => run(playbook([topic('term', 'term')], []), doc([clause('term', undefined, { warnings: [warning('deadline-mismatch', { origin: 'consistency', days: 1 })] })]))],
  ['stamp-duty-candidate', () => run(playbook([topic('term', 'term')], [], { stampDuty: DEFAULT_STAMP_DUTY }), doc([], { contractNature: { value: 'basic_transaction' } }))],
  ['stamp-duty-amount-unknown', () => run(playbook([topic('term', 'term')], [], { stampDuty: DEFAULT_STAMP_DUTY }), doc([], { contractNature: { value: 'ukeoi' } }))],
];

describe('review: reviewContract が出す理由コードの網羅', () => {
  it.each(REASON_SCENARIOS)('正常: %s を出す', (code, scenario) => {
    expect(codesOf(scenario())).toContain(code);
  });

  it('正常: 表は reviewContract が出しうる全コードを覆う（締結登録の notice-deadline-passed と再レビューの review-stale は別の層）', () => {
    expect(REASON_SCENARIOS.map(([code]) => code).sort()).toEqual(REASON_CODES.filter((code) => code !== 'notice-deadline-passed' && code !== 'review-stale').sort());
  });
});

/* ---------------------------------------------------------------------------
 * 評価順
 * ------------------------------------------------------------------------ */

describe('review: 評価順（立場 → 抽出の失敗 → 条項の有無 → 競合 → 引用 → 各基準）', () => {
  const required = (extra: Partial<PlaybookCriterion> = {}) => playbook([topic('term', 'term')], [criterion('c', 'term', { type: 'required' }, extra)]);
  const first = (outcome: ReviewOutcome) => resultOf(outcome, 'term').criteria[0]!;

  it('正常: 立場が要る基準は、立場未設定なら抽出の失敗より先に role-not-set', () => {
    expect(first(run(required({ appliesToRoles: ['client'] }), without(doc([clause('term', undefined, { warnings: [warning('extraction-failed')] })]), 'ourRole')))).toMatchObject({ outcome: 'unresolved', reasonCode: 'role-not-set' });
  });

  it('正常: 立場が合わない基準は not-applicable（判定は accept）', () => {
    const outcome = run(required({ appliesToRoles: ['vendor'] }), doc([]));
    expect(first(outcome)).toEqual({ criterionId: 'c', outcome: 'not-applicable' });
    expect(resultOf(outcome, 'term').verdict).toBe('accept');
  });

  it('正常: 抽出の失敗は条項の有無より先（present = false でも extraction-failed）', () => {
    expect(first(run(required(), doc([clause('term', undefined, { present: false, warnings: [warning('extraction-failed')] })])))).toMatchObject({ reasonCode: 'extraction-failed' });
  });

  it.each([
    ['条項が無い', [], false],
    ['present = false でキーワードに当たらなかった', [clause('term', undefined, { present: false, evidence: [], warnings: [warning('clause-missing')] })], true],
  ])('正常: %s → clause-missing（onFail で失敗、noKeywordMatch = %s）', (_label, clauses, noKeywordMatch) => {
    const outcome = run(required({ onFail: 'reject' }), doc(clauses));
    expect(first(outcome)).toEqual({ criterionId: 'c', outcome: 'fail', reasonCode: 'clause-missing', detail: { noKeywordMatch } });
    expect(resultOf(outcome, 'term')).toMatchObject({ verdict: 'reject', present: false });
  });

  it('正常: 条項が無いとき required 以外の基準は not-applicable', () => {
    const outcome = run(playbook([topic('sub', 'permission')], [criterion('c', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'equals', value: 'free' }] })]), doc([]));
    expect(resultOf(outcome, 'sub')).toMatchObject({ verdict: 'accept', present: false, reasons: [], criteria: [{ criterionId: 'c', outcome: 'not-applicable' }] });
  });

  it('正常: 競合は引用未検証より先', () => {
    expect(first(run(required(), doc([clause('term', undefined, { warnings: [warning('quote-not-found'), warning('conflicting-clauses')] })])))).toMatchObject({ reasonCode: 'conflicting-clauses' });
  });

  it.each([
    ['LLM 抽出で根拠がすべて未検証', { source: 'llm' as const, evidence: [{ quote: 'a', verified: false }, { quote: 'b', verified: false }] }, 'unresolved'],
    ['LLM 抽出で 1 件でも検証済み', { source: 'llm' as const, evidence: [{ quote: 'a', verified: false }, { quote: 'b', verified: true }] }, 'pass'],
    ['LLM 抽出で根拠なし', { source: 'llm' as const, evidence: [] }, 'pass'],
    ['手入力は未検証でも採る', { source: 'manual' as const, evidence: [{ quote: 'a', verified: false }] }, 'pass'],
  ])('境界: %s → %s', (_label, overrides, outcome) => {
    expect(first(run(required(), doc([clause('term', undefined, overrides)]))).outcome).toBe(outcome);
  });
});

/* ---------------------------------------------------------------------------
 * 集約
 * ------------------------------------------------------------------------ */

describe('review: 集約（reject > negotiate > unresolved > accept）', () => {
  it.each<[readonly Verdict[], Verdict]>([
    [[], 'accept'], [['accept', 'unresolved'], 'unresolved'], [['unresolved', 'negotiate', 'accept'], 'negotiate'], [['negotiate', 'reject', 'unresolved'], 'reject'], [['reject', 'accept'], 'reject'],
  ])('正常: worstVerdict(%o) = %s', (verdicts, expected) => {
    expect(worstVerdict(verdicts)).toBe(expected);
  });

  it('正常: 基準は全部評価し（最初の失敗で止めない）、sortOrder 順に並べ、無効な基準は除く', () => {
    const book = playbook([topic('cap', 'liability_cap')], [
      criterion('fail-negotiate', 'cap', { type: 'condition', conditions: [{ field: 'cap.kind', op: 'equals', value: 'none' }] }, { sortOrder: 20 }),
      criterion('llm', 'cap', { type: 'llm', question: 'q', passWhen: 'yes' }, { sortOrder: 30 }),
      criterion('fail-reject', 'cap', { type: 'condition', conditions: [{ field: 'cap.present', op: 'isFalse' }] }, { sortOrder: 10, onFail: 'reject' }),
      criterion('disabled', 'cap', { type: 'required' }, { enabled: false }),
    ]);
    const result = resultOf(run(book, doc([capClause])), 'cap');
    expect(result.verdict).toBe('reject');
    expect(result.criteria.map((entry) => [entry.criterionId, entry.outcome])).toEqual([['fail-reject', 'fail'], ['fail-negotiate', 'fail'], ['llm', 'unresolved']]);
    expect(result.reasons.map((reason) => [reason.code, reason.criterionId, reason.topicId])).toEqual([['criterion-failed', 'fail-reject', 'cap'], ['criterion-failed', 'fail-negotiate', 'cap'], ['llm-unavailable', 'llm', 'cap']]);
  });

  it('正常: 要交渉が確定していれば、未判定の基準があっても negotiate（未判定も一覧に残す）', () => {
    const book = playbook([topic('cap', 'liability_cap')], [
      criterion('fail', 'cap', { type: 'condition', conditions: [{ field: 'cap.kind', op: 'equals', value: 'none' }] }),
      criterion('llm', 'cap', { type: 'llm', question: 'q', passWhen: 'yes' }),
    ]);
    const result = resultOf(run(book, doc([capClause])), 'cap');
    expect(result.verdict).toBe('negotiate');
    expect(result.criteria.map((entry) => entry.outcome)).toEqual(['fail', 'unresolved']);
  });

  it('正常: トピックは sortOrder 順、無効なトピックは結果に出さない。基準の無いトピックは accept', () => {
    const outcome = run(playbook([topic('b', 'text', 20), topic('a', 'text', 10), topic('off', 'text', 0, false)], []), doc([clause('b', { kind: 'text', summary: 's' })]));
    expect(outcome.results).toEqual([
      { topicId: 'a', topicLabel: 'L-a', verdict: 'accept', present: false, reasons: [], criteria: [], recommendedTexts: [] },
      { topicId: 'b', topicLabel: 'L-b', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [] },
    ]);
    expect(outcome.overall).toBe('accept');
  });

  it('正常: 無効化・削除されたトピックを参照する基準は unknown-topic のトピック結果にまとめる', () => {
    const book = playbook([topic('term', 'term'), topic('old', 'text', 0, false)], [criterion('c1', 'old', { type: 'required' }), criterion('c2', 'old', { type: 'required' }), criterion('c3', 'gone', { type: 'required' })].slice(0, 2));
    const removed = { ...book, criteria: [...book.criteria, criterion('c3', 'gone', { type: 'required' })] };
    const outcome = run(removed, doc([]));
    expect(outcome.results.slice(1)).toEqual([
      { topicId: 'old', topicLabel: 'L-old', verdict: 'unresolved', present: false, reasons: [{ code: 'unknown-topic', criterionId: 'c1', topicId: 'old' }, { code: 'unknown-topic', criterionId: 'c2', topicId: 'old' }], criteria: [{ criterionId: 'c1', outcome: 'unresolved', reasonCode: 'unknown-topic' }, { criterionId: 'c2', outcome: 'unresolved', reasonCode: 'unknown-topic' }], recommendedTexts: [] },
      { topicId: 'gone', topicLabel: 'gone', verdict: 'unresolved', present: false, reasons: [{ code: 'unknown-topic', criterionId: 'c3', topicId: 'gone' }], criteria: [{ criterionId: 'c3', outcome: 'unresolved', reasonCode: 'unknown-topic' }], recommendedTexts: [] },
    ]);
    expect(outcome.overall).toBe('unresolved');
  });
});

/* ---------------------------------------------------------------------------
 * 推奨文案
 * ------------------------------------------------------------------------ */

describe('review: 推奨文案', () => {
  const TEXT = '{us}は{counterparty}に{paymentMaxDays}日以内に払う（{articleRef}）。';
  const book = (legal = DEFAULT_LEGAL_SETTINGS) => playbook([topic('sub', 'permission')], [
    criterion('fail-1', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'equals', value: 'prohibited' }] }, { recommendedText: TEXT }),
    criterion('fail-2', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'notEquals', value: 'free' }] }, { recommendedText: TEXT }),
    criterion('pass', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'equals', value: 'free' }] }, { recommendedText: '合格した基準の文案' }),
    criterion('unresolved', 'sub', { type: 'llm', question: 'q', passWhen: 'yes' }, { recommendedText: '未判定の基準の文案' }),
    criterion('no-text', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'in', value: ['notify'] }] }),
  ], { legal });

  it('正常: 失敗した基準の文案だけを置換子展開し、トピック内の重複は 1 つにする', () => {
    const result = resultOf(run(book(), doc([clause('sub', { kind: 'permission', policy: 'free' }, { articleRef: '第4条' })])), 'sub');
    expect(result.recommendedTexts).toEqual(['株式会社サンプル商事は株式会社テストに60日以内に払う（第4条）。']);
  });

  it('境界: 自社が未設定・条番号なしなら既定の語、上限日数は相手方区分に応じた値（フリーランスの 45 日）', () => {
    const document = without(doc([clause('sub', { kind: 'permission', policy: 'free' })], { counterpartyProfile: { toriteki: 'no', freelance: 'yes' } }), 'ourParty');
    const result = resultOf(run(book({ ...DEFAULT_LEGAL_SETTINGS, freelancePaymentMaxDays: 45 }), document), 'sub');
    expect(result.recommendedTexts).toEqual(['当社は相手方に45日以内に払う（該当条項）。']);
  });

  it('境界: 当事者名が無ければ既定の語、相手方区分が未入力なら設定の支払日数', () => {
    const document = doc([clause('sub', { kind: 'permission', policy: 'free' })], { parties: { A: { label: '甲' }, B: { label: '乙' } }, counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' } });
    expect(resultOf(run(book(), document), 'sub').recommendedTexts).toEqual(['当社は相手方に60日以内に払う（該当条項）。']);
  });
});

/* ---------------------------------------------------------------------------
 * condition / legal / llm の各分岐
 * ------------------------------------------------------------------------ */

describe('review: condition 基準', () => {
  const single = (conditions: Extract<CriterionCheck, { type: 'condition' }>['conditions'], topicKind: ClauseTopic['valueKind'] = 'ip_ownership') => playbook([topic('t', topicKind)], [criterion('c', 't', { type: 'condition', conditions })]);
  const first = (outcome: ReviewOutcome) => resultOf(outcome, 't').criteria[0]!;

  it('正常: 失敗の detail に項目・実値・演算子・期待値（配列は連結）・理由を入れる', () => {
    const outcome = run(playbook([topic('t', 'permission')], [criterion('c', 't', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'in', value: ['prior_consent', 'prohibited'] }] })]), doc([clause('t', { kind: 'permission', policy: 'free' })]));
    expect(first(outcome)).toEqual({ criterionId: 'c', outcome: 'fail', reasonCode: 'criterion-failed', detail: { field: 'permission.policy', actual: 'free', op: 'in', expected: 'prior_consent, prohibited', rationale: 'R-c' } });
  });

  it('境界: 値を持たない演算子の期待値と、値が無い exists の実値は null', () => {
    expect(first(run(single([{ field: 'ip.transferOn', op: 'exists' }]), doc([clause('t', { kind: 'ip_ownership', owner: 'shared' })])))).toMatchObject({ outcome: 'fail', detail: { actual: null, expected: null } });
  });

  it('正常: AND の全条件を満たせば pass', () => {
    expect(first(run(single([{ field: 'ip.owner', op: 'equals', value: 'us' }, { field: 'ip.transferOn', op: 'equals', value: 'payment' }]), doc([clause('t', { kind: 'ip_ownership', owner: 'A', transferOn: 'payment' })])))).toEqual({ criterionId: 'c', outcome: 'pass' });
  });

  it('正常: ip.owner は自社の甲乙が未設定なら role-not-set（他の条件が満たされていても）', () => {
    const document = without(doc([clause('t', { kind: 'ip_ownership', owner: 'A', transferOn: 'payment' })]), 'ourParty');
    expect(first(run(single([{ field: 'ip.owner', op: 'equals', value: 'us' }, { field: 'ip.transferOn', op: 'equals', value: 'payment' }]), document))).toMatchObject({ outcome: 'unresolved', reasonCode: 'role-not-set' });
  });

  it('正常: 立場が要る条件があっても、他の条件が不合格なら criterion-failed を優先する', () => {
    const document = without(doc([clause('t', { kind: 'ip_ownership', owner: 'A', transferOn: 'delivery' })]), 'ourParty');
    expect(first(run(single([{ field: 'ip.owner', op: 'equals', value: 'us' }, { field: 'ip.transferOn', op: 'equals', value: 'payment' }]), document))).toMatchObject({ outcome: 'fail', reasonCode: 'criterion-failed', detail: { field: 'ip.transferOn' } });
  });

  it('正常: 値が無い項目は最初のものを field-missing の detail に入れる', () => {
    expect(first(run(single([{ field: 'ip.transferOn', op: 'equals', value: 'payment' }, { field: 'ip.moralRightsNotExercised', op: 'isTrue' }]), doc([clause('t', { kind: 'ip_ownership', owner: 'A' })])))).toEqual({ criterionId: 'c', outcome: 'unresolved', reasonCode: 'field-missing', detail: { field: 'ip.transferOn' } });
  });

  it('正常: renewal.months は「同一条件」なら主たる期間の月数を使う', () => {
    const book = playbook([topic('term', 'term'), topic('renewal', 'auto_renewal')], [criterion('c', 'renewal', { type: 'condition', conditions: [{ field: 'renewal.months', op: 'lte', value: 6 }] })]);
    const renewal = clause('renewal', { kind: 'auto_renewal', renews: true, sameAsInitial: true });
    const term = clause('term', { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', startsOnSigning: false });
    expect(resultOf(run(book, doc([term, renewal])), 'renewal').criteria[0]).toMatchObject({ outcome: 'fail', detail: { actual: 12 } });
    expect(resultOf(run(book, doc([renewal])), 'renewal').criteria[0]).toMatchObject({ outcome: 'unresolved', reasonCode: 'field-missing' });
  });
});

describe('review: legal 基準', () => {
  const book = playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'payment-max-days' }, { onFail: 'reject' })]);
  const first = (outcome: ReviewOutcome) => resultOf(outcome, 'pay').criteria[0]!;

  it('正常: 上限内は pass（detail を残す）、超過は onFail', () => {
    expect(first(run(book, doc([clause('pay', { ...monthEndTwo, payMonthOffset: 1 })])))).toMatchObject({ outcome: 'pass', detail: { maxDays: 62, monthEndAllowance: true } });
    expect(resultOf(run(book, doc([clause('pay', monthEndTwo)])), 'pay').verdict).toBe('reject');
  });

  it('正常: 相手方が対象外なら not-applicable', () => {
    expect(first(run(book, doc([clause('pay', monthEndTwo)], { counterpartyProfile: { toriteki: 'no', freelance: 'no' } })))).toEqual({ criterionId: 'c', outcome: 'not-applicable' });
  });

  it.each([
    ['値が無い', clause('pay'), 'field-missing'],
    ['値の型が違う', clause('pay', { kind: 'text', summary: 'x' }), 'field-missing'],
    ['値が読めなかった', clause('pay', undefined, { warnings: [warning('value-unparsed')] }), 'value-unparsed'],
  ])('異常: %s → %s（detail.field = payment）', (_label, value, code) => {
    expect(first(run(book, doc([value])))).toEqual({ criterionId: 'c', outcome: 'unresolved', reasonCode: code, detail: { field: 'payment' } });
  });

  it('異常: 支払手段が読めていなければ field-missing', () => {
    const methodBook = playbook([topic('pay', 'payment_terms')], [criterion('c', 'pay', { type: 'legal', rule: 'prohibited-payment-method' })]);
    expect(first(run(methodBook, doc([clause('pay', { kind: 'payment_terms', basis: 'delivery' })])))).toMatchObject({ reasonCode: 'field-missing', detail: { field: 'payment.method' } });
  });
});

describe('review: llm 基準', () => {
  const book = playbook([topic('cap', 'liability_cap')], [capLlm]);
  const first = (outcome: ReviewOutcome) => resultOf(outcome, 'cap').criteria[0]!;

  it('正常: passWhen と一致し、根拠が条文内にあれば pass（回答を残す）', () => {
    expect(first(run(book, doc([capClause]), { 'cap-llm': answered('no', '委託料を上限とする') }))).toEqual({ criterionId: 'cap-llm', outcome: 'pass', llm: { answer: 'no', evidenceQuote: '委託料を上限とする', reasoning: '理由' } });
  });

  it('正常: passWhen と違えば llm-criterion-failed（質問と理由を detail へ）', () => {
    expect(first(run(book, doc([capClause]), { 'cap-llm': answered('yes', '乙の賠償額は委託料を上限とする。') }))).toMatchObject({ outcome: 'fail', reasonCode: 'llm-criterion-failed', detail: { question: '委託料以下に制限されていますか。', reasoning: '理由' } });
  });

  it.each([
    ['回答なし', undefined, 'llm-unavailable', false],
    ['モデル不可', { status: 'unavailable' } as const, 'llm-unavailable', false],
    ['修復でも崩れた', { status: 'failed' } as const, 'llm-unclear', false],
    ['判断不能', answered('unclear', null), 'llm-unclear', true],
    ['根拠なし', answered('yes', null), 'llm-evidence-missing', true],
    ['根拠が別の条文', answered('yes', '月末締め翌月末日'), 'llm-evidence-missing', true],
  ])('異常: %s → %s（採らない回答も llm に残すか: %s）', (_label, answer, code, keepsLlm) => {
    const result = first(run(book, doc([capClause]), answer === undefined ? {} : { 'cap-llm': answer }));
    expect(result).toMatchObject({ outcome: 'unresolved', reasonCode: code, detail: { question: '委託料以下に制限されていますか。' } });
    expect(result.llm !== undefined).toBe(keepsLlm);
  });

  it('境界: 条文が特定できなければ根拠の引用の中で確かめる', () => {
    const loose = clause('cap', { kind: 'liability_cap', capKind: 'fees_paid' }, { evidence: [{ quote: '賠償額は委託料を上限とする', verified: true }] });
    expect(first(run(book, doc([loose]), { 'cap-llm': answered('no', '委託料を上限') })).outcome).toBe('pass');
    expect(first(run(book, doc([loose]), { 'cap-llm': answered('no', '月末締め') })).reasonCode).toBe('llm-evidence-missing');
  });
});

/* ---------------------------------------------------------------------------
 * 文書全体の所見と overall
 * ------------------------------------------------------------------------ */

describe('review: 文書全体の所見と overall', () => {
  it('正常: 突き合わせの警告は warning なので、トピックが全部 accept でも overall は unresolved', () => {
    const outcome = run(playbook([topic('term', 'term')], []), doc([clause('term', undefined, { warnings: [warning('deadline-mismatch', { message: 'ずれ', days: 1 }), warning('deadline-mismatch', { message: '差なし' })] })]));
    expect(outcome.documentFindings).toEqual([{ code: 'deadline-mismatch', topicId: 'term', detail: { message: 'ずれ', days: 1 } }, { code: 'deadline-mismatch', topicId: 'term', detail: { message: '差なし', days: null } }]);
    expect(outcome.results[0]!.verdict).toBe('accept');
    expect(outcome.overall).toBe('unresolved');
  });

  it('正常: 検収日基準は warning（overall を accept にしない）。present = false の条項は見ない', () => {
    const acceptance: ClauseValue = { kind: 'payment_terms', basis: 'acceptance' };
    expect(run(playbook([topic('pay', 'payment_terms')], []), doc([clause('pay', acceptance)])).overall).toBe('unresolved');
    expect(run(playbook([topic('pay', 'payment_terms')], []), doc([clause('pay', acceptance, { present: false })])).documentFindings).toEqual([]);
  });

  it('正常: 印紙税の候補は info なので overall に影響しない', () => {
    const outcome = run(playbook([topic('term', 'term')], [], { stampDuty: DEFAULT_STAMP_DUTY }), doc([], { contractNature: { value: 'ukeoi' }, contractAmount: 1_000_000 }));
    expect(outcome.documentFindings.map((finding) => [finding.code, finding.detail?.['documentTypeCode'], finding.detail?.['amount']])).toEqual([['stamp-duty-candidate', 'no2', 200], ['stamp-duty-candidate', 'no7', 4000]]);
    expect(outcome.overall).toBe('accept');
  });

  it('正常: 所見の warning があってもトピックが negotiate なら overall は negotiate', () => {
    const book = playbook([topic('sub', 'permission'), topic('term', 'term')], [criterion('c', 'sub', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'equals', value: 'prohibited' }] })]);
    expect(run(book, doc([clause('sub', { kind: 'permission', policy: 'free' }), clause('term', undefined, { warnings: [warning('deadline-mismatch')] })])).overall).toBe('negotiate');
  });

  it('正常: 無効なトピックの条項の警告は所見にしない', () => {
    const outcome = run(playbook([topic('term', 'term', 0, false), topic('x', 'text')], []), doc([clause('term', undefined, { warnings: [warning('deadline-mismatch')] })]));
    expect(outcome.documentFindings).toEqual([]);
  });

  it('正常: 電子契約は印紙税の候補に electronic と税額 0 を入れる', () => {
    const outcome = run(playbook([topic('term', 'term')], [], { stampDuty: DEFAULT_STAMP_DUTY }), doc([], { contractNature: { value: 'basic_transaction' } }), {}, 'electronic');
    expect(outcome.documentFindings).toEqual([{ code: 'stamp-duty-candidate', detail: { documentTypeCode: 'no7', name: expect.any(String) as string, nature: 'basic_transaction', amount: 0, electronic: true, sourceUrl: expect.any(String) as string } }]);
  });

  it('境界: 第 7 号の除外は主たる期間の月数と自動更新の条項から決める', () => {
    const book = playbook([topic('term', 'term'), topic('renewal', 'auto_renewal')], [], { stampDuty: DEFAULT_STAMP_DUTY });
    const shortTerm = clause('term', { kind: 'term', startDate: '2026-04-01', endDate: '2026-06-30', startsOnSigning: false });
    const nature = { contractNature: { value: 'basic_transaction' as const } };
    expect(run(book, doc([shortTerm], nature)).documentFindings).toEqual([]);
    expect(run(book, doc([shortTerm, clause('renewal', { kind: 'auto_renewal', renews: false, sameAsInitial: false })], nature)).documentFindings).toEqual([]);
    expect(run(book, doc([shortTerm, clause('renewal', { kind: 'auto_renewal', renews: true, sameAsInitial: true })], nature)).documentFindings.map((finding) => finding.code)).toEqual(['stamp-duty-candidate']);
  });
});

/* ---------------------------------------------------------------------------
 * fieldValueOf
 * ------------------------------------------------------------------------ */

describe('review: fieldValueOf', () => {
  const context = { document: doc([]), termMonths: 12 };
  const value = (path: string, clauseValue: ClauseValue | undefined, ctx: { document: ContractDocument; termMonths?: number } = context) => fieldValueOf(path, clauseValue === undefined ? clause('t') : clause('t', clauseValue), ctx);

  it('境界: present は条項が無ければ false、値が無ければ他のパスは undefined', () => {
    expect(fieldValueOf('present', undefined, context)).toBe(false);
    expect(fieldValueOf('present', clause('t', undefined, { present: false }), context)).toBe(false);
    expect(fieldValueOf('present', clause('t'), context)).toBe(true);
    expect(fieldValueOf('term.months', clause('t'), context)).toBeUndefined();
    expect(fieldValueOf('term.months', undefined, context)).toBeUndefined();
  });

  const term: ClauseValue = { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', startsOnSigning: true };
  const notice = (unit: 'day' | 'month'): ClauseValue => ({ kind: 'notice', amount: 3, unit, anchor: 'expiry', businessDays: true });
  const cap = (capKind: Extract<ClauseValue, { kind: 'liability_cap' }>['capKind']): ClauseValue => ({ kind: 'liability_cap', capKind, amount: 100, months: 2, excludesWillfulOrGross: true });
  const ip = (owner: 'A' | 'B' | 'shared' | 'unspecified'): ClauseValue => ({ kind: 'ip_ownership', owner, transferOn: 'payment', moralRightsNotExercised: false });

  it.each<[string, ClauseValue, unknown]>([
    ['term.months', term, 12], ['term.startDate', term, '2026-04-01'], ['term.endDate', term, '2027-03-31'], ['term.startsOnSigning', term, true], ['term.unknown', term, undefined],
    ['renewal.renews', { kind: 'auto_renewal', renews: true, renewalMonths: 6, sameAsInitial: true }, true],
    ['renewal.months', { kind: 'auto_renewal', renews: true, renewalMonths: 6, sameAsInitial: true }, 6],
    ['renewal.months', { kind: 'auto_renewal', renews: true, sameAsInitial: true }, 12],
    ['renewal.months', { kind: 'auto_renewal', renews: true, sameAsInitial: false }, undefined],
    ['notice.days', notice('month'), 90], ['notice.days', notice('day'), 3], ['notice.amount', notice('day'), 3], ['notice.unit', notice('month'), 'month'], ['notice.businessDays', notice('day'), true],
    ['payment.maxDays', monthEndTwo, 92], ['payment.maxDays', { kind: 'payment_terms', basis: 'delivery' }, undefined], ['payment.method', monthEndTwo, 'bank_transfer'], ['payment.basis', monthEndTwo, 'delivery'],
    ['cap.kind', cap('fixed_amount'), 'fixed_amount'], ['cap.amount', cap('fixed_amount'), 100], ['cap.months', cap('fees_months'), 2], ['cap.excludesWillfulOrGross', cap('none'), true],
    ['cap.present', cap('fixed_amount'), true], ['cap.present', cap('fees_paid'), true], ['cap.present', cap('none'), false], ['cap.present', cap('unspecified'), false],
    ['permission.policy', { kind: 'permission', policy: 'notify' }, 'notify'], ['permission.other', { kind: 'permission', policy: 'notify' }, undefined],
    ['ip.owner', ip('A'), 'us'], ['ip.owner', ip('B'), 'counterparty'], ['ip.owner', ip('shared'), 'shared'], ['ip.owner', ip('unspecified'), 'unspecified'],
    ['ip.transferOn', ip('A'), 'payment'], ['ip.moralRightsNotExercised', ip('A'), false],
    ['jurisdiction.court', { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: false }, '東京地方裁判所'], ['jurisdiction.exclusive', { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: false }, false],
    ['text.summary', { kind: 'text', summary: 's' }, undefined],
  ])('正常: %s（%o）→ %o', (path, clauseValue, expected) => {
    expect(value(path, clauseValue)).toBe(expected);
  });

  it('境界: ip.owner の甲乙は自社の立場（ourParty）で写し、未設定なら role', () => {
    expect(value('ip.owner', ip('A'), { document: doc([], { ourParty: 'B' }) })).toBe('counterparty');
    expect(value('ip.owner', ip('A'), { document: without(doc([]), 'ourParty') })).toBe('role');
    expect(value('ip.owner', ip('shared'), { document: without(doc([]), 'ourParty') })).toBe('shared');
  });
});

/* ---------------------------------------------------------------------------
 * レビューの集約（作成・人の判断・確定）
 * ------------------------------------------------------------------------ */

const twoTopics = (): ReviewOutcome => run(
  playbook([topic('a', 'permission', 10), topic('b', 'text', 20)], [criterion('c', 'a', { type: 'condition', conditions: [{ field: 'permission.policy', op: 'equals', value: 'prohibited' }] })]),
  doc([clause('a', { kind: 'permission', policy: 'free' })]),
);

const review = (overrides: Partial<ContractReview> = {}): ContractReview => {
  const outcome = twoTopics();
  const { tenant: _tenant, ...snapshot } = playbook([topic('a', 'permission')], []);
  return createContractReview({
    tenant, id: 'r1', documentId: 'doc1', playbookId: 'pb', playbookName: '審査基準', playbookSnapshot: snapshot, playbookSnapshotAt: NOW, clausesFingerprint: 'fp',
    results: outcome.results, documentFindings: outcome.documentFindings, overall: outcome.overall, status: 'draft', stale: false, llmCache: [], createdAt: NOW, updatedAt: NOW, ...overrides,
  });
};

describe('review: createContractReview', () => {
  it('正常: 作成したレビューは再検証しても同じ', () => {
    const created = review({ model: { provider: 'p', model: 'm' } });
    expect(createContractReview(created)).toEqual(created);
  });

  it('境界: LLM の引用は 300 文字・理由は 200 文字で切る（回答キャッシュも同じ）', () => {
    const base = review();
    const results = base.results.map((result, index) => index === 0 ? { ...result, criteria: [{ criterionId: 'c', outcome: 'pass' as const, llm: { answer: 'yes' as const, evidenceQuote: 'q'.repeat(400), reasoning: 'r'.repeat(300) } }, { criterionId: 'd', outcome: 'pass' as const, llm: { answer: 'no' as const, evidenceQuote: null, reasoning: 'r' } }] } : result);
    const llmCache = [{ key: 'k', criterionId: 'c', answer: 'yes' as const, evidenceQuote: 'q'.repeat(400), reasoning: 'r'.repeat(300) }, { key: 'k2', criterionId: 'd', answer: 'unclear' as const, evidenceQuote: null, reasoning: 'r' }];
    const created = createContractReview({ ...base, results, llmCache });
    expect(created.results[0]!.criteria.map((entry) => entry.llm)).toEqual([{ answer: 'yes', evidenceQuote: 'q'.repeat(300), reasoning: 'r'.repeat(200) }, { answer: 'no', evidenceQuote: null, reasoning: 'r' }]);
    expect(created.llmCache).toEqual([{ key: 'k', criterionId: 'c', answer: 'yes', evidenceQuote: 'q'.repeat(300), reasoning: 'r'.repeat(200) }, llmCache[1]]);
    expect(created.results).not.toBe(results);
  });

  const valid = review();
  const cases: readonly [string, unknown, RegExp][] = [
    ['props が null', null, /props must be an object/u],
    ['tenant なし', { ...valid, tenant: undefined }, /tenant is required/u],
    ...(['id', 'documentId', 'playbookId', 'playbookName', 'playbookSnapshotAt', 'clausesFingerprint', 'createdAt', 'updatedAt'] as const).map((key): [string, unknown, RegExp] => [`${key} が空`, { ...valid, [key]: '' }, new RegExp(`${key} is required`, 'u')]),
    ['overall が語彙外', { ...valid, overall: 'maybe' }, /overall must be one of accept, negotiate, reject, unresolved/u],
    ['状態が語彙外', { ...valid, status: 'open' }, /status must be draft or finalized/u],
    ['stale が真偽値でない', { ...valid, stale: 'no' }, /stale must be a boolean/u],
    ['写しが null', { ...valid, playbookSnapshot: null }, /playbookSnapshot is required/u],
    ['results が配列でない', { ...valid, results: {} }, /results \/ documentFindings \/ llmCache must be arrays/u],
    ['documentFindings が配列でない', { ...valid, documentFindings: null }, /must be arrays/u],
    ['llmCache が配列でない', { ...valid, llmCache: 'x' }, /must be arrays/u],
    ['結果の判定が語彙外', { ...valid, results: [{ ...valid.results[0], verdict: 'maybe' }] }, /results\[0\] is malformed/u],
    ['結果の配列が欠落', { ...valid, results: [{ ...valid.results[0], criteria: undefined }] }, /results\[0\] is malformed/u],
    ['人の判断が語彙外', { ...valid, results: [{ ...valid.results[0], humanDecision: 'unresolved' }] }, /results\[0\]\.humanDecision must be accept, negotiate or reject/u],
    ['メモが 2001 文字', { ...valid, results: [{ ...valid.results[0], humanNote: 'x'.repeat(2001) }] }, /results\[0\]\.humanNote must be a string of at most 2000/u],
    ['メモが文字列でない', { ...valid, results: [{ ...valid.results[0], humanNote: 1 }] }, /humanNote must be a string/u],
    ['未判断のまま確定', { ...valid, status: 'finalized' }, /a finalized review needs a decision for every clause type/u],
  ];

  it.each(cases)('異常: %s', (_label, props, message) => {
    let caught: unknown;
    try { createContractReview(props as ContractReview); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContractDomainError);
    expect((caught as Error).message).toMatch(message);
  });
});

describe('review: applyHumanDecisions / finalizeReview / decidedVerdicts', () => {
  it('正常: 判断とメモを付け、指定しないトピックは触らない', () => {
    const decided = applyHumanDecisions(review(), [{ topicId: 'a', decision: 'accept', note: '社内で許容' }], 'later');
    expect(resultOf(decided, 'a')).toMatchObject({ verdict: 'negotiate', humanDecision: 'accept', humanNote: '社内で許容' });
    expect(resultOf(decided, 'b')).not.toHaveProperty('humanDecision');
    expect(decided.updatedAt).toBe('later');
  });

  it('境界: undefined は据え置き、null は取り消し、空のメモは持たない', () => {
    const decided = applyHumanDecisions(review(), [{ topicId: 'a', decision: 'reject', note: 'メモ' }], 'later');
    expect(resultOf(applyHumanDecisions(decided, [{ topicId: 'a' }], 'later'), 'a')).toMatchObject({ humanDecision: 'reject', humanNote: 'メモ' });
    const cleared = resultOf(applyHumanDecisions(decided, [{ topicId: 'a', decision: null, note: null }], 'later'), 'a');
    expect(cleared).not.toHaveProperty('humanDecision');
    expect(cleared).not.toHaveProperty('humanNote');
    expect(resultOf(applyHumanDecisions(decided, [{ topicId: 'a', note: '' }], 'later'), 'a')).not.toHaveProperty('humanNote');
  });

  it('異常: レビューに無いトピックは ContractDomainError', () => {
    expect(() => applyHumanDecisions(review(), [{ topicId: 'nope', decision: 'accept' }], 'later')).toThrowError(/applyHumanDecisions: the review has no clause type "nope"/u);
  });

  it('例外: 未判断のトピックが残っていれば確定できず、details.undecidedTopicIds で直す場所を返す', () => {
    const partial = applyHumanDecisions(review(), [{ topicId: 'a', decision: 'negotiate' }], 'later');
    let caught: unknown;
    try { finalizeReview(partial, 'later'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContractDomainError);
    expect((caught as ContractDomainError).details).toEqual({ undecidedTopicIds: ['b'] });
    expect((caught as Error).message).toContain('undecided: b');
  });

  it('正常: 全トピックに判断があれば確定し、確定済みは判断の変更も再確定も ContractStateError', () => {
    const decided = applyHumanDecisions(review(), [{ topicId: 'a', decision: 'negotiate' }, { topicId: 'b', decision: 'accept' }], 'later');
    const finalized = finalizeReview(decided, 'final');
    expect(finalized).toMatchObject({ status: 'finalized', finalizedAt: 'final', updatedAt: 'final' });
    for (const action of [() => finalizeReview(finalized, 'x'), () => applyHumanDecisions(finalized, [{ topicId: 'a', decision: 'accept' }], 'x')]) {
      let caught: unknown;
      try { action(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ContractStateError);
      expect((caught as ContractStateError).target).toEqual({ reviewId: 'r1', documentId: 'doc1' });
    }
  });

  it('正常: decidedVerdicts は人の判断を優先し、無ければ判定', () => {
    const decided = applyHumanDecisions(review(), [{ topicId: 'a', decision: 'accept' }], 'later');
    expect(decidedVerdicts(decided)).toEqual({ a: 'accept', b: 'accept' });
    expect(decidedVerdicts(review())).toEqual({ a: 'negotiate', b: 'accept' });
  });
});

describe('review: 立場の型', () => {
  it.each<[OurRole, 'accept' | 'unresolved']>([['client', 'unresolved'], ['vendor', 'accept'], ['mutual', 'accept']])('正常: 立場 %s で client 限定の LLM 基準は %s', (ourRole, verdict) => {
    const book = playbook([topic('cap', 'liability_cap')], [{ ...capLlm, appliesToRoles: ['client'] }]);
    expect(resultOf(run(book, doc([capClause], { ourRole })), 'cap').verdict).toBe(verdict);
  });
});

/**
 * 締結登録と期限台帳のテスト。「今日」は Clock を注入して固定する（期限の状態・現在期が今日で変わるため）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  confirmedClauses, COUNTERPARTY, deadlinesFixture, documentFixture, inMemoryContractRepositories, playbookFixture, reviewFixture, scope, signedClausesFixture, signedContractFixture,
} from '../../adapters/storage/contract-repository.fixtures';
import type { Clause, ContractDocument } from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractDomainError, ContractStateError, SignedContractNotFoundError } from '../../domain/contract/errors';
import type { Deadline, SignedClause, SignedContract } from '../../domain/contract/signed-contract';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { clockAt, sequentialIds } from './contract.fixtures';
import { ContractPlaybookResolver } from './manage-playbooks';
import {
  CompleteContractDeadlineUseCase, DeleteSignedContractUseCase, GetSignedContractUseCase, ListContractDeadlinesUseCase, ListSignedContractsUseCase,
  PreviewContractDeadlinesUseCase, RegisterSignedContractUseCase, signedClausesOf, TerminateSignedContractUseCase, UpdateSignedContractUseCase,
} from './signed-contracts';
import type { Clock } from './support';

const playbook = playbookFixture('pb-1', { isDefault: true });
const byDue = (deadlines: readonly Deadline[]) => [...deadlines].sort((left, right) => (left.dueDate < right.dueDate ? -1 : left.dueDate > right.dueDate ? 1 : left.id < right.id ? -1 : 1));
const confirmedDocument = (overrides: Partial<ContractDocument> = {}) => documentFixture('doc-1', { status: 'confirmed', clauses: confirmedClauses(), ...overrides });
const withClause = (topicId: string, change: Partial<Clause>) => confirmedClauses().map((clause) => (clause.topicId === topicId ? { ...clause, ...change } : clause));

/** 自動更新の無い期間（満了で終わる）。 */
function fixedTermClauses(startDate: string, endDate: string): readonly SignedClause[] {
  return [
    { topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第2条', quote: '期間', quoteVerified: true, value: { kind: 'term', startDate, endDate, startsOnSigning: false } },
    { topicId: 'auto_renewal', topicLabel: '自動更新', valueKind: 'auto_renewal', present: true, quoteVerified: true, value: { kind: 'auto_renewal', renews: false, sameAsInitial: false } },
  ];
}
const expiryOnly = (dueDate: string): readonly Deadline[] => [{ id: 'expiry-1', kind: 'expiry', dueDate, basis: '第2条: 満了日', termIndex: 1, termEnd: dueDate, status: 'open' }];

async function setup(today = '2026-09-15', options: { readonly savePlaybook?: boolean } = {}) {
  const repos = inMemoryContractRepositories();
  if (options.savePlaybook ?? true) await repos.playbooks.save(playbook);
  let clock: Clock = clockAt(today);
  const now: Clock = () => clock();
  const unitOfWork = new NoopUnitOfWork();
  const resolver = new ContractPlaybookResolver(repos.playbooks, now);
  const ids = sequentialIds('sc');
  return {
    ...repos, now, setToday: (date: string) => { clock = clockAt(date); },
    register: new RegisterSignedContractUseCase(repos.documents, repos.reviews, repos.signed, resolver, unitOfWork, now, ids),
    preview: new PreviewContractDeadlinesUseCase(repos.documents, repos.reviews, resolver, now),
    list: new ListSignedContractsUseCase(repos.signed, now),
    get: new GetSignedContractUseCase(repos.signed, now),
    update: new UpdateSignedContractUseCase(repos.signed, now, sequentialIds('new')),
    remove: new DeleteSignedContractUseCase(repos.signed, repos.documents, repos.reviews, unitOfWork, now),
    terminate: new TerminateSignedContractUseCase(repos.signed, now),
    complete: new CompleteContractDeadlineUseCase(repos.signed, now),
    ledger: new ListContractDeadlinesUseCase(repos.signed, resolver, now),
  };
}

describe('signedClausesOf', () => {
  it('審査基準のトピックを表示順にすべて並べ、条項が無いものは present: false。値の種類が合わない値は写さない', () => {
    const clauses: Clause[] = [
      ...withClause('liability_cap', { evidence: [{ quote: '言い換え', verified: false }] }),
      { topicId: 'warranty', present: true, articleRef: '第9条', evidence: [{ quote: '保証', verified: true }], value: { kind: 'text', summary: '1 年保証' }, source: 'llm', warnings: [] },
      { topicId: 'no_value', present: true, evidence: [], source: 'llm', warnings: [] },
    ].map((clause) => (clause.topicId === 'payment' ? { ...clause, value: { kind: 'notice', amount: 1, unit: 'day', anchor: 'expiry', businessDays: false } } : clause)) as Clause[];
    const result = signedClausesOf(confirmedDocument({ clauses }), playbook);
    expect(result.map((clause) => clause.topicId)).toEqual(['term', 'auto_renewal', 'renewal_notice', 'payment', 'liability_cap', 'subcontracting', 'ip_ownership', 'jurisdiction', 'warranty']);
    expect(result[0]).toEqual({ topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第2条', quote: confirmedClauses()[0]!.evidence[0]!.quote, quoteVerified: true, value: confirmedClauses()[0]!.value });
    expect(result.find((clause) => clause.topicId === 'payment')).not.toHaveProperty('value');
    // LLM 由来で引用が見つからなかった条項は未確認、人が手入力した条項は確認済み。
    expect(result.find((clause) => clause.topicId === 'liability_cap')).toMatchObject({ quoteVerified: false, quote: '言い換え' });
    expect(result.find((clause) => clause.topicId === 'jurisdiction')?.quoteVerified).toBe(true);
    expect(result.find((clause) => clause.topicId === 'ip_ownership')).toEqual({ topicId: 'ip_ownership', topicLabel: '成果物の知的財産権', valueKind: 'ip_ownership', present: false, quoteVerified: true });
    expect(result.find((clause) => clause.topicId === 'subcontracting')).toEqual({ topicId: 'subcontracting', topicLabel: '再委託', valueKind: 'permission', present: false, quoteVerified: true });
    // 審査基準に無い条項は、値があるときだけ id をラベルにして足す。
    expect(result.at(-1)).toEqual({ topicId: 'warranty', topicLabel: 'warranty', valueKind: 'text', present: true, articleRef: '第9条', quote: '保証', quoteVerified: true, value: { kind: 'text', summary: '1 年保証' } });
  });
});

describe('RegisterSignedContractUseCase', () => {
  it('正常: 確定済みの条項を写して期限を計算し、文書を signed にする。レビューしていなければその旨を警告する', async () => {
    const { register, documents, signed, now } = await setup();
    await documents.save(confirmedDocument());
    const { contract, warnings } = await register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' });
    expect(contract).toMatchObject({
      id: 'sc-1', documentId: 'doc-1', title: '業務委託契約書 doc-1', counterpartyName: COUNTERPARTY, signedDate: '2026-03-15', signingMethod: 'paper',
      ourParty: 'A', status: 'active', reviewVerdicts: {}, createdAt: now().toISOString(), updatedAt: now().toISOString(),
    });
    expect(contract).not.toHaveProperty('reviewId');
    expect(byDue(contract.deadlines)).toEqual(deadlinesFixture());
    expect(warnings).toEqual([{ message: 'この文書はレビューしていません。台帳には載せますが、審査基準との照合は行っていません。' }]);
    expect(contract.warnings).toEqual(warnings);
    expect(await signed.findById(scope, 'sc-1')).toEqual(contract);
    expect(await documents.findById(scope, 'doc-1')).toMatchObject({ status: 'signed', signedContractId: 'sc-1', updatedAt: now().toISOString() });
    expect((await signed.listOpenDeadlines(scope)).map((row) => row.deadlineId)).toEqual(['renewal_notice-1', 'expiry-1', 'renewal-1']);
  });

  it('正常: 未確定のレビューは確定を促し、確定済みなら警告せずに人の判断を写す。題名・相手方・印紙税は入力で上書きできる', async () => {
    const { register, documents, reviews } = await setup();
    await documents.save(confirmedDocument({ reviewId: 'rv-draft' }));
    await reviews.save(reviewFixture('rv-draft', { documentId: 'doc-1' }));
    const draft = await register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'electronic', title: '上書きした題名', counterpartyName: '手入力の相手方', stampDuty: { affixed: null } });
    expect(draft.warnings).toEqual([{ message: 'レビューの判定を確定していません。締結前の判断として記録するなら、レビューで判定を確定してください。' }]);
    expect(draft.contract).toMatchObject({ reviewId: 'rv-draft', reviewVerdicts: { term: 'accept' }, title: '上書きした題名', counterpartyName: '手入力の相手方', stampDuty: { affixed: null } });

    await documents.save(confirmedDocument({ id: 'doc-2', reviewId: 'rv-final' }));
    await reviews.save(reviewFixture('rv-final', {
      documentId: 'doc-2', status: 'finalized', finalizedAt: '2026-09-01T00:00:00.000Z',
      results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'negotiate', present: true, reasons: [], criteria: [], recommendedTexts: [], humanDecision: 'accept' }],
    }));
    const finalized = await register.execute({ scope, documentId: 'doc-2', signedDate: '2026-03-15', signingMethod: 'paper' });
    expect(finalized.warnings).toEqual([]);
    expect(finalized.contract.reviewVerdicts).toEqual({ term: 'accept' });
  });

  it('境界: 締結登録の時点で現在期の更新拒絶の通知期限が過ぎていれば notice-deadline-passed を警告する', async () => {
    const { register, documents } = await setup('2027-01-10');
    await documents.save(confirmedDocument());
    const { warnings } = await register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' });
    expect(warnings).toContainEqual({ code: 'notice-deadline-passed', message: '更新拒絶の通知期限 2026-12-31 は既に過ぎています（締結登録時点）。' });
  });

  it('異常: 二重登録（文書が signed・同じ文書の契約がある）は 409 で開く場所を示す', async () => {
    const { register, documents, signed } = await setup();
    await documents.save(confirmedDocument({ status: 'signed', signedContractId: 'sc-old' }));
    const error = await register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractStateError);
    expect(error).toMatchObject({ target: { documentId: 'doc-1' }, message: expect.stringContaining('open it in the deadline ledger') });

    await documents.save(confirmedDocument({ id: 'doc-2' }));
    await signed.save(signedContractFixture('sc-existing', { documentId: 'doc-2' }));
    await expect(register.execute({ scope, documentId: 'doc-2', signedDate: '2026-03-15', signingMethod: 'paper' })).rejects.toMatchObject({ target: { documentId: 'doc-2', contractId: 'sc-existing' } });
    expect((await documents.findById(scope, 'doc-2'))?.status).toBe('confirmed');
  });

  it('異常: 無い文書は 404、暦に無い締結日は 400、相手方が決まらなければ 400（何も保存しない）', async () => {
    const { register, documents, signed } = await setup();
    await expect(register.execute({ scope, documentId: 'missing', signedDate: '2026-03-15', signingMethod: 'paper' })).rejects.toThrow(ContractDocumentNotFoundError);
    await documents.save(confirmedDocument({ ourParty: undefined }));
    await expect(register.execute({ scope, documentId: 'doc-1', signedDate: '2026-02-30', signingMethod: 'paper' })).rejects.toThrow('signedDate must be a calendar date');
    await expect(register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' })).rejects.toThrow(ContractDomainError);
    await expect(register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' })).rejects.toThrow('enter the counterparty on the sign step');
    expect(await signed.list(scope)).toEqual([]);
    expect((await documents.findById(scope, 'doc-1'))?.status).toBe('confirmed');
  });
});

describe('PreviewContractDeadlinesUseCase', () => {
  it('正常: 締結日なしでも期限・自動更新・満了日・印紙税の候補・レビューの有無・相手方を返す（保存しない）', async () => {
    const { preview, documents, signed } = await setup();
    await documents.save(confirmedDocument({ contractNature: { value: 'ukeoi' }, contractAmount: 3_300_000 }));
    const result = await preview.execute({ scope, documentId: 'doc-1', signingMethod: 'paper' });
    expect(result).toMatchObject({ autoRenewal: true, termEnd: '2027-03-31', review: 'none', counterpartyName: COUNTERPARTY, warnings: [] });
    expect(byDue(result.deadlines)).toEqual(deadlinesFixture());
    expect(result.stampDutyCandidates.map((candidate) => [candidate.documentTypeCode, candidate.amount])).toEqual([['no2', 2000], ['no7', 4000]]);
    expect(await signed.list(scope)).toEqual([]);

    // 入力の金額が文書の金額より優先し、電子契約は税額 0。
    const electronic = await preview.execute({ scope, documentId: 'doc-1', signingMethod: 'electronic', contractAmount: 500_000 });
    expect(electronic.stampDutyCandidates.map((candidate) => [candidate.documentTypeCode, candidate.amount, candidate.electronic])).toEqual([['no2', 0, true], ['no7', 0, true]]);
  });

  it('境界: 締結日があるときだけ通知期限の経過を警告する（暦に無い締結日は無いものとして扱う）。条項の突き合わせの警告も並べる', async () => {
    const { preview, documents } = await setup('2027-01-10');
    const mismatch = { code: 'deadline-mismatch' as const, message: '満了日が引用の日付と一致しません', origin: 'consistency' as const };
    await documents.save(confirmedDocument({ clauses: withClause('term', { warnings: [mismatch, { message: '補足', origin: 'consistency' }] }) }));
    expect((await preview.execute({ scope, documentId: 'doc-1' })).warnings).toEqual([{ code: 'deadline-mismatch', message: '満了日が引用の日付と一致しません' }]);
    expect((await preview.execute({ scope, documentId: 'doc-1', signedDate: '2026-13-01' })).warnings).toEqual([{ code: 'deadline-mismatch', message: '満了日が引用の日付と一致しません' }]);
    expect((await preview.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15' })).warnings.map((warning) => warning.code)).toEqual(['notice-deadline-passed', 'deadline-mismatch']);
  });

  it('境界: 締結日から始まる期間は締結日が無ければ計算せず理由を返し、入れれば期限を出す。期間が無ければ満了日も無い', async () => {
    const { preview, documents } = await setup();
    const onSigning = withClause('term', { value: { kind: 'term', durationMonths: 12, startsOnSigning: true } });
    await documents.save(confirmedDocument({ clauses: onSigning, ourParty: undefined }));
    const pending = await preview.execute({ scope, documentId: 'doc-1' });
    expect(pending.deadlines).toEqual([]);
    expect(pending.warnings[0]?.message).toContain('締結日が未定です');
    expect(pending).not.toHaveProperty('termEnd');
    expect(pending).not.toHaveProperty('counterpartyName');
    const withDate = await preview.execute({ scope, documentId: 'doc-1', signedDate: '2026-04-01' });
    expect(withDate.termEnd).toBe('2027-03-31');
    expect(withDate.deadlines.map((deadline) => deadline.id).sort()).toEqual(['expiry-1', 'renewal-1', 'renewal_notice-1']);
  });

  it('正常: レビューの状態（draft / finalized）を返す。無い文書は 404', async () => {
    const { preview, documents, reviews } = await setup();
    await documents.save(confirmedDocument({ reviewId: 'rv-1' }));
    await reviews.save(reviewFixture('rv-1'));
    expect((await preview.execute({ scope, documentId: 'doc-1' })).review).toBe('draft');
    await reviews.save(reviewFixture('rv-1', { status: 'finalized', finalizedAt: '2026-09-01T00:00:00.000Z', results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [], humanDecision: 'accept' }] }));
    expect((await preview.execute({ scope, documentId: 'doc-1' })).review).toBe('finalized');
    await documents.save(confirmedDocument({ id: 'doc-lost', reviewId: 'rv-missing' }));
    expect((await preview.execute({ scope, documentId: 'doc-lost' })).review).toBe('none');
    await expect(preview.execute({ scope, documentId: 'missing' })).rejects.toThrow(ContractDocumentNotFoundError);
  });
});

describe('ListSignedContractsUseCase / GetSignedContractUseCase', () => {
  it('正常: 表示上の状態（active / expired / terminated）を付け、状態で絞れる。相手方の絞り込みはリポジトリへ渡す', async () => {
    const { list, signed } = await setup();
    await signed.save(signedContractFixture('sc-renew'));
    await signed.save(signedContractFixture('sc-ended', { signedDate: '2025-07-01', counterpartyName: '終了済み株式会社', clauses: fixedTermClauses('2025-07-01', '2026-06-30'), deadlines: expiryOnly('2026-06-30') }));
    await signed.save(signedContractFixture('sc-term', { status: 'terminated', terminatedAt: '2026-08-01', deadlines: deadlinesFixture().map((deadline) => ({ ...deadline, status: 'superseded' as const })) }));
    const views = await list.execute(scope);
    expect(views.map((view) => [view.contract.id, view.displayStatus])).toEqual([['sc-renew', 'active'], ['sc-term', 'terminated'], ['sc-ended', 'expired']]);
    expect((await list.execute(scope, { status: 'expired' })).map((view) => view.contract.id)).toEqual(['sc-ended']);
    expect((await list.execute(scope, { counterparty: '終了済み' })).map((view) => view.contract.id)).toEqual(['sc-ended']);
    expect(await list.execute(scope, { status: 'active', counterparty: '終了済み' })).toEqual([]);
  });

  it('境界: 自動更新の契約は今日の現在期で期限を計算し直して返す（保存はしない）', async () => {
    const { list, get, signed } = await setup('2027-05-01');
    const stored = signedContractFixture('sc-renew');
    await signed.save(stored);
    const [view] = await list.execute(scope);
    expect(view?.displayStatus).toBe('active');
    const open = view!.contract.deadlines.filter((deadline) => deadline.status === 'open');
    expect(open.map((deadline) => [deadline.id, deadline.dueDate])).toEqual([['renewal_notice-2', '2027-12-31'], ['expiry-2', '2028-03-31'], ['renewal-2', '2028-04-01']]);
    expect(view!.contract.deadlines.filter((deadline) => deadline.status === 'superseded').map((deadline) => deadline.id).sort()).toEqual(['expiry-1', 'renewal-1', 'renewal_notice-1']);
    expect(await get.execute(scope, 'sc-renew')).toEqual(view);
    expect(await signed.findById(scope, 'sc-renew')).toEqual(stored);
    await expect(get.execute(scope, 'missing')).rejects.toThrow(SignedContractNotFoundError);
  });
});

describe('UpdateSignedContractUseCase', () => {
  const custom: Deadline = { id: 'custom-report', kind: 'custom', dueDate: '2026-10-31', basis: '報告書の提出', status: 'done', completedAt: '2026-09-01T00:00:00.000Z' };

  it('正常: 条項を直したら期限を計算し直す（同じ id の期限は置き換え、手で足した期限は保つ）', async () => {
    const { update, signed, now } = await setup();
    await signed.save(signedContractFixture('sc-1', { deadlines: [...deadlinesFixture(), custom], warnings: [{ message: '古い警告' }] }));
    const clauses = signedClausesFixture().map((clause) => (clause.topicId === 'renewal_notice' ? { ...clause, value: { kind: 'notice' as const, amount: 2, unit: 'month' as const, anchor: 'expiry' as const, businessDays: false } } : clause));
    const updated = await update.execute({ scope, id: 'sc-1', clauses, title: '改題', counterpartyName: '改名合同会社', signingMethod: 'paper', stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: true } });
    expect(updated).toMatchObject({ title: '改題', counterpartyName: '改名合同会社', signingMethod: 'paper', stampDuty: { affixed: true }, warnings: [], updatedAt: now().toISOString() });
    expect(updated.deadlines.find((deadline) => deadline.id === 'renewal_notice-1')).toMatchObject({ dueDate: '2027-01-31', basis: '第3条: 満了の2か月前まで', status: 'open' });
    expect(updated.deadlines.find((deadline) => deadline.id === 'custom-report')).toEqual(custom);
    expect(await signed.findById(scope, 'sc-1')).toEqual(updated);
    expect((await signed.listOpenDeadlines(scope)).find((row) => row.deadlineId === 'renewal_notice-1')?.dueDate).toBe('2027-01-31');
  });

  it('境界: 計算で消えた未完了の期限は superseded、完了済みの期限は完了のまま残す', async () => {
    const { update, signed } = await setup();
    const [notice, expiry, renewal] = deadlinesFixture();
    await signed.save(signedContractFixture('sc-1', { deadlines: [{ ...notice!, status: 'done', completedAt: '2026-09-01T00:00:00.000Z' }, expiry!, renewal!] }));
    const noRenewal = signedClausesFixture().map((clause) => (clause.topicId === 'auto_renewal' ? { ...clause, value: { kind: 'auto_renewal' as const, renews: false, sameAsInitial: false } } : clause));
    const updated = await update.execute({ scope, id: 'sc-1', clauses: noRenewal });
    expect(updated.deadlines.map((deadline) => [deadline.id, deadline.status])).toEqual([['renewal_notice-1', 'done'], ['expiry-1', 'open'], ['renewal-1', 'superseded']]);
    // 締結日だけを直しても期限は計算し直す（始期は条項の値なので変わらない）。
    const redated = await update.execute({ scope, id: 'sc-1', signedDate: '2026-03-01' });
    expect(redated.signedDate).toBe('2026-03-01');
    expect(redated.deadlines).toEqual(updated.deadlines);
  });

  it('正常: customDeadlines を渡したら置き換える（同じ id は完了状態を保ち、新しい期限には id を振る。渡さなかった手入力の期限は消える）', async () => {
    const { update, signed } = await setup();
    const other: Deadline = { id: 'custom-other', kind: 'custom', dueDate: '2026-11-15', basis: '別の期限', status: 'open' };
    await signed.save(signedContractFixture('sc-1', { deadlines: [...deadlinesFixture(), custom, other] }));
    const updated = await update.execute({
      scope, id: 'sc-1',
      customDeadlines: [
        { id: 'custom-report', dueDate: '2026-11-30', basis: '報告書の提出（延期）' },
        { dueDate: '2026-12-15', basis: '監査対応', note: '経理と調整' },
        { id: 'expiry-1', dueDate: '2026-12-20', basis: '計算の期限の id を指定しても手入力の期限として扱う' },
      ],
    });
    const customs = updated.deadlines.filter((deadline) => deadline.kind === 'custom');
    expect(customs).toEqual([
      { id: 'custom-report', kind: 'custom', dueDate: '2026-11-30', basis: '報告書の提出（延期）', status: 'done', completedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'custom-new-1', kind: 'custom', dueDate: '2026-12-15', basis: '監査対応', status: 'open', note: '経理と調整' },
      { id: 'custom-new-2', kind: 'custom', dueDate: '2026-12-20', basis: '計算の期限の id を指定しても手入力の期限として扱う', status: 'open' },
    ]);
    expect(updated.deadlines.some((deadline) => deadline.id === 'custom-other')).toBe(false);
  });

  it('異常: 無い契約は 404、終了した契約は 409、不変条件違反は 400（保存しない）', async () => {
    const { update, signed } = await setup();
    await expect(update.execute({ scope, id: 'missing' })).rejects.toThrow(SignedContractNotFoundError);
    const terminated = signedContractFixture('sc-t', { status: 'terminated', terminatedAt: '2026-08-01' });
    await signed.save(terminated);
    await expect(update.execute({ scope, id: 'sc-t', title: 'x' })).rejects.toMatchObject({ name: 'ContractStateError', target: { contractId: 'sc-t' } });
    const stored = signedContractFixture('sc-1');
    await signed.save(stored);
    await expect(update.execute({ scope, id: 'sc-1', counterpartyName: '  ' })).rejects.toThrow(ContractDomainError);
    await expect(update.execute({ scope, id: 'sc-1', customDeadlines: [{ dueDate: '2026-02-30', basis: 'x' }] })).rejects.toThrow('dueDate must be a calendar date');
    expect(await signed.findById(scope, 'sc-1')).toEqual(stored);
  });
});

describe('DeleteSignedContractUseCase', () => {
  it('正常: 台帳から消し、文書を締結登録前へ戻す（確定済みレビューなら reviewed、それ以外は confirmed）', async () => {
    const { remove, signed, documents, reviews } = await setup();
    const finalizedReview = reviewFixture('rv-final', { status: 'finalized', finalizedAt: '2026-09-01T00:00:00.000Z', results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [], humanDecision: 'accept' }] });
    for (const [id, reviewId, expected] of [['a', 'rv-final', 'reviewed'], ['b', 'rv-draft', 'confirmed'], ['c', undefined, 'confirmed']] as const) {
      await documents.save(confirmedDocument({ id: `doc-${id}`, status: 'signed', signedContractId: `sc-${id}`, ...(reviewId === undefined ? {} : { reviewId }) }));
      await signed.save(signedContractFixture(`sc-${id}`, { documentId: `doc-${id}` }));
      if (reviewId === 'rv-final') await reviews.save(finalizedReview);
      if (reviewId === 'rv-draft') await reviews.save(reviewFixture('rv-draft'));
      await remove.execute(scope, `sc-${id}`);
      const document = await documents.findById(scope, `doc-${id}`);
      expect(document?.status, id).toBe(expected);
      expect(document).not.toHaveProperty('signedContractId');
      expect(await signed.findById(scope, `sc-${id}`)).toBeNull();
    }
    expect(await signed.listOpenDeadlines(scope)).toEqual([]);
  });

  it('境界: 文書が消えていても契約は消せる。無い契約は 404', async () => {
    const { remove, signed, documents } = await setup();
    await signed.save(signedContractFixture('sc-orphan', { documentId: 'doc-gone' }));
    await remove.execute(scope, 'sc-orphan');
    expect(await signed.findById(scope, 'sc-orphan')).toBeNull();
    expect(await documents.findById(scope, 'doc-gone')).toBeNull();
    await expect(remove.execute(scope, 'sc-orphan')).rejects.toThrow(SignedContractNotFoundError);
  });
});

describe('TerminateSignedContractUseCase', () => {
  it('正常: 終了日と理由を記録し、未完了の期限を superseded にする（完了済みは残す）', async () => {
    const { terminate, signed, now } = await setup();
    const [notice, expiry, renewal] = deadlinesFixture();
    await signed.save(signedContractFixture('sc-1', { deadlines: [{ ...notice!, status: 'done', completedAt: '2026-09-01T00:00:00.000Z' }, expiry!, renewal!] }));
    const terminated = await terminate.execute({ scope, id: 'sc-1', terminatedAt: '2026-09-30', reason: '合意解約' });
    expect(terminated).toMatchObject({ status: 'terminated', terminatedAt: '2026-09-30', terminationReason: '合意解約', updatedAt: now().toISOString() });
    expect(terminated.deadlines.map((deadline) => deadline.status)).toEqual(['done', 'superseded', 'superseded']);
    expect(await signed.findById(scope, 'sc-1')).toEqual(terminated);
    expect(await signed.listOpenDeadlines(scope)).toEqual([]);
  });

  it('異常: 無い契約は 404、暦に無い終了日は 400、終了済みは 409', async () => {
    const { terminate, signed } = await setup();
    await expect(terminate.execute({ scope, id: 'missing', terminatedAt: '2026-09-30' })).rejects.toThrow(SignedContractNotFoundError);
    await signed.save(signedContractFixture('sc-1'));
    await expect(terminate.execute({ scope, id: 'sc-1', terminatedAt: '2026/09/30' })).rejects.toThrow('terminatedAt must be a calendar date');
    await terminate.execute({ scope, id: 'sc-1', terminatedAt: '2026-09-30' });
    await expect(terminate.execute({ scope, id: 'sc-1', terminatedAt: '2026-10-01' })).rejects.toThrow(ContractStateError);
  });
});

describe('CompleteContractDeadlineUseCase', () => {
  it('正常: 期限を完了にしてメモを残し、投影から外す', async () => {
    const { complete, signed, now } = await setup();
    await signed.save(signedContractFixture('sc-1'));
    const completed = await complete.execute({ scope, contractId: 'sc-1', deadlineId: 'renewal_notice-1', note: '書面で通知済み' });
    expect(completed.deadlines.find((deadline) => deadline.id === 'renewal_notice-1')).toMatchObject({ status: 'done', completedAt: now().toISOString(), note: '書面で通知済み' });
    expect(await signed.findById(scope, 'sc-1')).toEqual(completed);
    expect((await signed.listOpenDeadlines(scope)).map((row) => row.deadlineId)).toEqual(['expiry-1', 'renewal-1']);
    await expect(complete.execute({ scope, contractId: 'sc-1', deadlineId: 'renewal_notice-1' })).rejects.toThrow(ContractStateError);
  });

  it('境界: 現在期で計算し直してから完了にする（台帳に出ている次の期の id で完了でき、前の期は superseded で保存される）', async () => {
    const { complete, signed } = await setup('2027-05-01');
    await signed.save(signedContractFixture('sc-1'));
    const completed = await complete.execute({ scope, contractId: 'sc-1', deadlineId: 'renewal_notice-2' });
    expect(completed.deadlines.map((deadline) => [deadline.id, deadline.status])).toEqual([
      ['renewal_notice-1', 'superseded'], ['expiry-1', 'superseded'], ['renewal-1', 'superseded'], ['renewal_notice-2', 'done'], ['expiry-2', 'open'], ['renewal-2', 'open'],
    ]);
    expect((await signed.listOpenDeadlines(scope)).map((row) => row.deadlineId)).toEqual(['expiry-2', 'renewal-2']);
  });

  it('異常: 無い契約・無い期限は 404（期限の id を書く）', async () => {
    const { complete, signed } = await setup();
    await expect(complete.execute({ scope, contractId: 'missing', deadlineId: 'expiry-1' })).rejects.toThrow(SignedContractNotFoundError);
    await signed.save(signedContractFixture('sc-1'));
    await expect(complete.execute({ scope, contractId: 'sc-1', deadlineId: 'expiry-9' })).rejects.toThrow('has no deadline "expiry-9"');
  });
});

describe('ListContractDeadlinesUseCase（期限台帳）', () => {
  async function ledgerSetup(today = '2026-09-15', savePlaybook = false) {
    const context = await setup(today, { savePlaybook });
    const overdue: Deadline = { id: 'custom-1', kind: 'custom', dueDate: '2026-09-01', basis: '報告書', status: 'open' };
    const sameDay: Deadline = { id: 'custom-2', kind: 'custom', dueDate: '2026-12-31', basis: '同日の手入力の期限', status: 'open' };
    await context.signed.save(signedContractFixture('sc-a', { deadlines: [...deadlinesFixture(), sameDay] }));
    await context.signed.save(signedContractFixture('sc-b', { counterpartyName: '満了予定株式会社', clauses: fixedTermClauses('2025-10-01', '2026-09-30'), deadlines: expiryOnly('2026-09-30') }));
    await context.signed.save(signedContractFixture('sc-c', { deadlines: [overdue, ...deadlinesFixture()] }));
    // 終了した契約に未完了の期限が残っていても台帳には出さない。
    await context.signed.save(signedContractFixture('sc-t', { status: 'terminated', terminatedAt: '2026-08-01', deadlines: [{ ...overdue, id: 'custom-t' }] }));
    return context;
  }
  const keys = (rows: readonly { contractId: string; deadline: Deadline }[]) => rows.map((row) => `${row.contractId}/${row.deadline.id}`);

  it('正常: 未完了の期限を期限の近い順（同日は契約 id → 期限 id）に、残り日数・状態・自動更新・契約の状態つきで並べる', async () => {
    const { ledger } = await ledgerSetup();
    const result = await ledger.execute({ scope });
    expect(result.today).toBe('2026-09-15');
    // 審査基準が未保存なら既定テンプレートの「期限が近い」日数（60 日）。
    expect(result.dueSoonDays).toBe(60);
    expect(keys(result.rows)).toEqual([
      'sc-c/custom-1', 'sc-b/expiry-1', 'sc-a/custom-2', 'sc-a/renewal_notice-1', 'sc-c/renewal_notice-1', 'sc-a/expiry-1', 'sc-c/expiry-1', 'sc-a/renewal-1', 'sc-c/renewal-1',
    ]);
    expect(result.rows[0]).toMatchObject({ contractId: 'sc-c', daysLeft: -14, state: 'overdue', autoRenewal: true, contractStatus: 'active' });
    expect(result.rows[1]).toMatchObject({ contractId: 'sc-b', title: '業務委託契約 sc-b', counterpartyName: '満了予定株式会社', daysLeft: 15, state: 'due-soon', autoRenewal: false, contractStatus: 'active' });
    expect(result.rows[3]).toMatchObject({ daysLeft: 107, state: 'upcoming' });
  });

  it('境界: withinDays は今日から N 日後まで（当日を含む）、includeOverdue: false は過ぎた期限を外す、kind と limit で絞る', async () => {
    const { ledger } = await ledgerSetup();
    expect(keys((await ledger.execute({ scope, withinDays: 15 })).rows)).toEqual(['sc-c/custom-1', 'sc-b/expiry-1']);
    expect(keys((await ledger.execute({ scope, withinDays: 14 })).rows)).toEqual(['sc-c/custom-1']);
    expect(keys((await ledger.execute({ scope, withinDays: 15, includeOverdue: false })).rows)).toEqual(['sc-b/expiry-1']);
    expect(keys((await ledger.execute({ scope, includeOverdue: true, kind: 'expiry' })).rows)).toEqual(['sc-b/expiry-1', 'sc-a/expiry-1', 'sc-c/expiry-1']);
    expect(keys((await ledger.execute({ scope, limit: 2 })).rows)).toEqual(['sc-c/custom-1', 'sc-b/expiry-1']);
    expect((await ledger.execute({ scope, limit: 0 })).rows).toEqual([]);
  });

  it('境界: 「期限が近い」日数は既定の審査基準の設定値を使う', async () => {
    const { ledger, playbooks } = await ledgerSetup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true, legal: { ...playbook.legal, dueSoonDays: 10 } }));
    const result = await ledger.execute({ scope });
    expect(result.dueSoonDays).toBe(10);
    expect(result.rows.find((row) => row.contractId === 'sc-b')?.state).toBe('upcoming');
  });

  it('境界: 自動更新の契約は投影（保存時点の期）で候補を引いた後に今日の現在期で計算し直す。前の期の期限は出さない', async () => {
    const { ledger, signed } = await setup('2027-05-01', { savePlaybook: false });
    await signed.save(signedContractFixture('sc-a'));
    const rows = (await ledger.execute({ scope })).rows;
    expect(rows.map((row) => [row.deadline.id, row.deadline.dueDate, row.deadline.termIndex])).toEqual([['renewal_notice-2', '2027-12-31', 2], ['expiry-2', '2028-03-31', 2], ['renewal-2', '2028-04-01', 2]]);
    // 投影には前の期の期限が残っていても、計算し直した期限が範囲外なら行にしない。
    expect((await ledger.execute({ scope, withinDays: 30 })).rows).toEqual([]);
    expect((await signed.findById(scope, 'sc-a'))?.deadlines.map((deadline) => deadline.id)).toEqual(deadlinesFixture().map((deadline) => deadline.id));
  });

  it('境界: 満了した非更新の契約の期限は contractStatus: expired で出し、投影にあっても契約が見つからなければ飛ばす', async () => {
    const { ledger, signed } = await setup('2026-10-15', { savePlaybook: false });
    await signed.save(signedContractFixture('sc-b', { clauses: fixedTermClauses('2025-10-01', '2026-09-30'), deadlines: expiryOnly('2026-09-30') }));
    const real = await signed.listOpenDeadlines(scope);
    vi.spyOn(signed, 'listOpenDeadlines').mockResolvedValue([{ contractId: 'sc-ghost', deadlineId: 'expiry-1', kind: 'expiry', dueDate: '2026-01-01' }, ...real]);
    const rows = (await ledger.execute({ scope })).rows;
    expect(rows.map((row) => [row.contractId, row.contractStatus, row.state])).toEqual([['sc-b', 'expired', 'overdue']]);
  });
});

// 期限の fixture が計算の結果と一致していること（台帳のテストの前提）。
it('前提: deadlinesFixture は signedClausesFixture と締結日から計算した期限と同じ', async () => {
  const { register, documents } = await setup();
  await documents.save(confirmedDocument());
  const { contract }: { contract: SignedContract } = await register.execute({ scope, documentId: 'doc-1', signedDate: '2026-03-15', signingMethod: 'paper' });
  expect(byDue(contract.deadlines)).toEqual(deadlinesFixture());
});

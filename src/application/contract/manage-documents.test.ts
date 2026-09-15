import { describe, expect, it } from 'vitest';
import {
  AT, confirmedClauses, COUNTERPARTY, documentFixture, evidenceOf, inMemoryContractRepositories, OUR_COMPANY, playbookFixture, QUOTES, reviewFixture, SAMPLE_CONTRACT_BODY, scope,
} from '../../adapters/storage/contract-repository.fixtures';
import type { Clause } from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractDomainError, ContractStateError } from '../../domain/contract/errors';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { sequentialIds } from './contract.fixtures';
import {
  ConfirmContractClausesUseCase, DeleteContractDocumentUseCase, GetContractDocumentUseCase, ImportContractDocumentUseCase,
  ListContractDocumentsUseCase, matchOurParty, UpdateContractDocumentUseCase,
} from './manage-documents';
import { ContractPlaybookResolver } from './manage-playbooks';

const NOW = new Date('2026-09-15T01:00:00.000Z');

function setup() {
  const repos = inMemoryContractRepositories();
  const unitOfWork = new NoopUnitOfWork();
  const clock = () => NOW;
  const resolver = new ContractPlaybookResolver(repos.playbooks, clock);
  return {
    ...repos,
    importer: new ImportContractDocumentUseCase(repos.documents, resolver, clock, sequentialIds('doc')),
    update: new UpdateContractDocumentUseCase(repos.documents, repos.reviews, resolver, unitOfWork, clock),
    get: new GetContractDocumentUseCase(repos.documents),
    list: new ListContractDocumentsUseCase(repos.documents),
    remove: new DeleteContractDocumentUseCase(repos.documents, repos.reviews, unitOfWork),
    confirm: new ConfirmContractClausesUseCase(repos.documents, repos.reviews, resolver, unitOfWork, clock),
  };
}

describe('matchOurParty', () => {
  it('正常: 表記ゆれ（全角・空白・前後の社名の省略）を吸収して一致した側を返す', () => {
    expect(matchOurParty({ A: '株式会社サンプル商事', B: COUNTERPARTY }, ['サンプル商事'])).toBe('A');
    expect(matchOurParty({ A: COUNTERPARTY, B: 'サンプル 商事' }, ['株式会社サンプル商事'])).toBe('B');
    expect(matchOurParty({ A: 'ＡＢＣ株式会社', B: COUNTERPARTY }, ['ABC株式会社'])).toBe('A');
  });

  it('境界: 両方に当たるなら決めない（取り違えるより人に選ばせる）。当たらない・名前なし・空の自社名も決めない', () => {
    expect(matchOurParty({ A: 'サンプル商事東京', B: 'サンプル商事大阪' }, ['サンプル商事'])).toBeUndefined();
    expect(matchOurParty({ A: COUNTERPARTY }, ['サンプル商事'])).toBeUndefined();
    expect(matchOurParty({}, ['サンプル商事'])).toBeUndefined();
    expect(matchOurParty({ A: 'サンプル商事', B: COUNTERPARTY }, [' ', '　'])).toBeUndefined();
    expect(matchOurParty({ A: 'サンプル商事', B: COUNTERPARTY }, [])).toBeUndefined();
  });
});

describe('ImportContractDocumentUseCase', () => {
  it('正常: 条文分割（前文・後文を含む）と甲乙の検出を行い、審査基準の自社名から自社側を決めて保存する', async () => {
    const { importer, documents, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    const { document, warnings } = await importer.execute({ scope, title: '業務委託契約書', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' } });
    expect(warnings).toEqual([]);
    expect(document).toMatchObject({
      id: 'doc-1', status: 'imported', clauses: [], ourParty: 'A', ourRole: 'client',
      parties: { A: { label: '甲', name: OUR_COMPANY }, B: { label: '乙', name: COUNTERPARTY } },
      counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    expect(document.articles.map((article) => article.ref)).toEqual(['前文', '第1条', '第2条', '第3条', '第4条', '第5条', '第6条', '後文']);
    expect(document.articles.find((article) => article.ref === '第2条')?.heading).toBe('契約期間');
    expect(document.pages).toEqual([{ page: 1, start: 0, end: SAMPLE_CONTRACT_BODY.length, method: 'text-layer', warnings: [] }]);
    expect(await documents.findById(scope, 'doc-1')).toEqual(document);
  });

  it('正常: 利用者の指定（当事者名・自社側・立場・区分・性質・金額・ページ）は検出より優先する。空の当事者名は無視', async () => {
    const { importer } = setup();
    const pages = [{ page: 1, start: 0, end: 100, method: 'vision' as const, warnings: [] }, { page: 2, start: 100, end: SAMPLE_CONTRACT_BODY.length, method: 'vision' as const, warnings: ['〓 1 文字'] }];
    const { document } = await importer.execute({
      scope, title: '手入力', body: SAMPLE_CONTRACT_BODY, source: { type: 'image-ocr', pageCount: 2 }, pages,
      parties: { A: '甲社（手入力）', B: '  ' }, ourParty: 'B', ourRole: 'vendor', counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, contractNature: 'ukeoi', contractAmount: 3_300_000,
    });
    expect(document).toMatchObject({
      parties: { A: { name: '甲社（手入力）' }, B: { name: COUNTERPARTY } }, ourParty: 'B', ourRole: 'vendor',
      counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, contractNature: { value: 'ukeoi' }, contractAmount: 3_300_000,
    });
    expect(document.pages).toHaveLength(2);
    // 審査基準が 0 件なら未保存の既定（自社名なし）なので、自社側は指定が無ければ決まらない。
    const { document: undecided } = await importer.execute({ scope, title: '未指定', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' }, pages: [] });
    expect(undecided.ourParty).toBeUndefined();
    expect(undecided.pages).toHaveLength(1);
  });

  it('境界: 同じ sha256 のファイルが取込済みなら警告を返す（取込は止めない）。違うハッシュ・ハッシュなしは警告しない', async () => {
    const { importer, documents } = setup();
    await documents.save(documentFixture('existing', { title: '先に取り込んだ契約', source: { type: 'pdf-text', sha256: 'abc' } }));
    const duplicate = await importer.execute({ scope, title: '二重', body: SAMPLE_CONTRACT_BODY, source: { type: 'pdf-text', sha256: 'abc' } });
    expect(duplicate.warnings).toEqual(['同じファイルが「先に取り込んだ契約」（existing）として取込済みです。二重に取り込んでいないか確かめてください。']);
    expect(await documents.findById(scope, duplicate.document.id)).not.toBeNull();
    expect((await importer.execute({ scope, title: '別', body: SAMPLE_CONTRACT_BODY, source: { type: 'pdf-text', sha256: 'def' } })).warnings).toEqual([]);
    expect((await importer.execute({ scope, title: '無', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' } })).warnings).toEqual([]);
  });

  it('異常: 本文が空・指定の審査基準が無いときは保存しない', async () => {
    const { importer, documents } = setup();
    await expect(importer.execute({ scope, title: '空', body: '   ', source: { type: 'text' } })).rejects.toThrow(ContractDomainError);
    await expect(importer.execute({ scope, title: 'x', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' }, playbookId: 'missing' })).rejects.toThrow('contract playbook not found');
    expect(await documents.list(scope)).toEqual([]);
  });
});

describe('UpdateContractDocumentUseCase', () => {
  const extraction = { playbookId: 'pb-1', promptTemplateVersion: 'contract-extract/v1', chunks: [], warnings: [], unscannedArticleRefs: [], scanAllArticles: false, extractedAt: AT };

  it('正常: 本文を変えたら抽出とレビューを捨てて imported へ戻す', async () => {
    const { update, documents, reviews, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    await documents.save(documentFixture('doc-1', { status: 'reviewed', clauses: confirmedClauses(), extraction, reviewId: 'rv-1', signingDateText: '2026年3月15日' }));
    await reviews.save(reviewFixture('rv-1'));
    const body = `${SAMPLE_CONTRACT_BODY}\n別紙: 追記`;
    const updated = await update.execute({ scope, id: 'doc-1', title: '改訂版', body, source: { type: 'text' } });
    expect(updated).toMatchObject({ status: 'imported', clauses: [], title: '改訂版', body, createdAt: AT, updatedAt: NOW.toISOString(), ourParty: 'A' });
    expect(updated).not.toHaveProperty('extraction');
    expect(updated).not.toHaveProperty('reviewId');
    expect(updated).not.toHaveProperty('signingDateText');
    expect(await reviews.listByDocument(scope, 'doc-1')).toEqual([]);
    expect(await documents.findById(scope, 'doc-1')).toEqual(updated);
  });

  it('正常: 本文が同じなら条項・状態・抽出・レビュー・締結日の文言・性質とページを保ち、題名などだけを変える', async () => {
    const { update, documents, reviews, playbooks } = setup();
    // 抽出に使った審査基準（extraction.playbookId）で解決するので、保存しておく。
    await playbooks.save(playbookFixture('pb-1'));
    const pages = [{ page: 1, start: 0, end: 50, method: 'vision' as const, warnings: [] }, { page: 2, start: 50, end: SAMPLE_CONTRACT_BODY.length, method: 'vision' as const, warnings: [] }];
    const current = documentFixture('doc-1', { status: 'confirmed', clauses: confirmedClauses(), extraction, reviewId: 'rv-1', signingDateText: '2026年3月15日', contractNature: { value: 'jun_inin', quote: '業務委託' }, pages });
    await documents.save(current);
    await reviews.save(reviewFixture('rv-1'));
    const updated = await update.execute({ scope, id: 'doc-1', title: '題名だけ変更', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' }, contractAmount: 1_000_000 });
    expect(updated).toMatchObject({ title: '題名だけ変更', status: 'confirmed', reviewId: 'rv-1', signingDateText: '2026年3月15日', contractNature: { value: 'jun_inin', quote: '業務委託' }, contractAmount: 1_000_000, extraction });
    expect(updated.clauses).toEqual(current.clauses);
    expect(updated.pages).toEqual(current.pages);
    expect(await reviews.listByDocument(scope, 'doc-1')).toHaveLength(1);

    // 性質を渡したらそれで上書きする。
    const renatured = await update.execute({ scope, id: 'doc-1', title: '題名だけ変更', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' }, contractNature: 'ukeoi' });
    expect(renatured.contractNature).toEqual({ value: 'ukeoi' });
  });

  it('異常: 無い文書は 404、締結済みは 409（本文を変えられない）', async () => {
    const { update, documents } = setup();
    await expect(update.execute({ scope, id: 'missing', title: 'x', body: 'x', source: { type: 'text' } })).rejects.toThrow(ContractDocumentNotFoundError);
    await documents.save(documentFixture('doc-signed', { status: 'signed', signedContractId: 'sc-1' }));
    const error = await update.execute({ scope, id: 'doc-signed', title: 'x', body: SAMPLE_CONTRACT_BODY, source: { type: 'text' } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractStateError);
    expect(error).toMatchObject({ target: { documentId: 'doc-signed', contractId: 'sc-1' } });
  });
});

describe('Get / List / Delete', () => {
  it('Get: 本体を返し、無ければ 404。List: 絞り込みをそのまま渡す', async () => {
    const { get, list, documents } = setup();
    await documents.save(documentFixture('doc-1'));
    await documents.save(documentFixture('doc-2', { status: 'confirmed' }));
    expect((await get.execute(scope, 'doc-1')).body).toBe(SAMPLE_CONTRACT_BODY);
    await expect(get.execute(scope, 'missing')).rejects.toThrow(ContractDocumentNotFoundError);
    expect((await list.execute(scope, { status: 'confirmed' })).map((entry) => entry.id)).toEqual(['doc-2']);
    expect(await list.execute(scope)).toHaveLength(2);
  });

  it('Delete: レビューごと消す。無ければ 404、締結済みは 409（台帳の根拠を消さない）', async () => {
    const { remove, documents, reviews } = setup();
    await documents.save(documentFixture('doc-1', { reviewId: 'rv-1', status: 'confirmed' }));
    await reviews.save(reviewFixture('rv-1'));
    await remove.execute(scope, 'doc-1');
    expect(await documents.findById(scope, 'doc-1')).toBeNull();
    expect(await reviews.listByDocument(scope, 'doc-1')).toEqual([]);
    await expect(remove.execute(scope, 'doc-1')).rejects.toThrow(ContractDocumentNotFoundError);
    await documents.save(documentFixture('doc-signed', { status: 'signed', signedContractId: 'sc-1' }));
    await expect(remove.execute(scope, 'doc-signed')).rejects.toThrow('delete the signed contract first');
    expect(await documents.findById(scope, 'doc-signed')).not.toBeNull();
  });
});

describe('ConfirmContractClausesUseCase', () => {
  it('正常: 条項を検証・突き合わせして confirmed にし、前のレビューを stale にする', async () => {
    const { confirm, documents, reviews, playbooks } = setup();
    await playbooks.save(playbookFixture('pb-1', { isDefault: true }));
    await documents.save(documentFixture('doc-1', { status: 'reviewed', reviewId: 'rv-1', clauses: confirmedClauses() }));
    await reviews.save(reviewFixture('rv-1', { status: 'draft' }));
    // 満了日を本文と食い違わせる → 突き合わせ（consistency）が deadline-mismatch を付ける。
    const clauses: Clause[] = confirmedClauses().map((clause) => clause.topicId === 'term' ? { ...clause, value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-04-30', durationMonths: 12, startsOnSigning: false }, source: 'manual' } : clause);
    const confirmed = await confirm.execute({ scope, documentId: 'doc-1', clauses, ourParty: 'A', contractNature: 'jun_inin' });
    expect(confirmed).toMatchObject({ status: 'confirmed', ourParty: 'A', contractNature: { value: 'jun_inin' }, updatedAt: NOW.toISOString() });
    const term = confirmed.clauses.find((clause) => clause.topicId === 'term');
    expect(term?.warnings.filter((warning) => warning.code === 'deadline-mismatch').length).toBeGreaterThan(0);
    expect(term?.warnings.every((warning) => warning.origin === 'consistency')).toBe(true);
    expect(await reviews.findById(scope, 'rv-1')).toMatchObject({ stale: true, updatedAt: NOW.toISOString() });
    expect(await documents.findById(scope, 'doc-1')).toEqual(confirmed);
  });

  it('境界: imported / extracted / reviewed は confirmed へ、confirmed はそのまま。stale 済み・見つからないレビューは触らない', async () => {
    const { confirm, documents, reviews } = setup();
    for (const status of ['imported', 'extracted', 'confirmed'] as const) {
      await documents.save(documentFixture(`doc-${status}`, { status }));
      expect((await confirm.execute({ scope, documentId: `doc-${status}`, clauses: confirmedClauses() })).status).toBe('confirmed');
    }
    await documents.save(documentFixture('doc-stale', { status: 'reviewed', reviewId: 'rv-stale', contractNature: { value: 'nda' } }));
    const staleReview = reviewFixture('rv-stale', { stale: true, updatedAt: AT });
    await reviews.save(staleReview);
    const result = await confirm.execute({ scope, documentId: 'doc-stale', clauses: [] });
    expect(result.contractNature).toEqual({ value: 'nda' });
    expect(await reviews.findById(scope, 'rv-stale')).toEqual(staleReview);
    await documents.save(documentFixture('doc-lost', { status: 'reviewed', reviewId: 'rv-missing' }));
    await expect(confirm.execute({ scope, documentId: 'doc-lost', clauses: [] })).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('異常: 審査基準に無い種類は 400（どの種類かを書く）、本文外の位置は 400、無い文書は 404、締結済みは 409', async () => {
    const { confirm, documents } = setup();
    await documents.save(documentFixture('doc-1', { status: 'extracted' }));
    await expect(confirm.execute({ scope, documentId: 'doc-1', clauses: [{ topicId: 'warranty', present: false, evidence: [], source: 'manual', warnings: [] }] }))
      .rejects.toThrow('these clause types are not in the playbook "業務委託（発注者側）": warranty');
    const outside: Clause = { topicId: 'term', present: true, evidence: [{ ...evidenceOf(QUOTES.term), end: SAMPLE_CONTRACT_BODY.length + 10 }], source: 'manual', warnings: [] };
    await expect(confirm.execute({ scope, documentId: 'doc-1', clauses: [outside] })).rejects.toThrow('has a position outside the body');
    expect((await documents.findById(scope, 'doc-1'))?.status).toBe('extracted');
    await expect(confirm.execute({ scope, documentId: 'missing', clauses: [] })).rejects.toThrow(ContractDocumentNotFoundError);
    await documents.save(documentFixture('doc-signed', { status: 'signed', signedContractId: 'sc-1' }));
    await expect(confirm.execute({ scope, documentId: 'doc-signed', clauses: [] })).rejects.toThrow(ContractStateError);
  });
});

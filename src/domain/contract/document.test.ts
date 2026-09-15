import { describe, expect, it } from 'vitest';
import { articleForClause, assertNotSigned, BODY_MAX_CHARS, counterpartyNameOf, createContractDocument, ourNameOf, toContractDocumentSummary, type Clause, type ContractDocument } from './document';
import { ContractDomainError, ContractStateError } from './errors';
import { segmentArticles, singlePage, type ContractArticle } from './segmentation';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const BODY = [
  '株式会社サンプル商事（以下「甲」という。）と株式会社テスト（以下「乙」という。）は次のとおり契約する。',
  '第1条（目的）甲は乙に業務を委託する。',
  '第2条（期間）本契約の有効期間は2026年4月1日から1年間とする。',
  '第3条（管轄）東京地方裁判所を専属的合意管轄とする。',
].join('\n');

const clause = (overrides: Partial<Clause> = {}): Clause => ({ topicId: 'term', present: true, evidence: [{ quote: '本契約の有効期間', start: BODY.indexOf('本契約の有効期間'), end: BODY.indexOf('本契約の有効期間') + 8, verified: true }], source: 'llm', warnings: [], ...overrides });

const base = (overrides: Partial<ContractDocument> = {}): ContractDocument => ({
  tenant, id: 'doc1', title: '業務委託契約書', source: { type: 'text' }, body: BODY, pages: singlePage(BODY), articles: segmentArticles(BODY, singlePage(BODY), 4000),
  parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '株式会社テスト' } }, ourParty: 'A', ourRole: 'client',
  counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, clauses: [], status: 'imported', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  ...overrides,
});

function expectRejected(props: unknown, message: RegExp): void {
  let caught: unknown;
  try { createContractDocument(props as ContractDocument); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ContractDomainError);
  expect((caught as Error).message).toMatch(message);
}

describe('document: createContractDocument（正常・境界）', () => {
  it('正常: 検証を通った文書は再検証しても同じ', () => {
    const document = createContractDocument(base({ clauses: [clause({ value: { kind: 'term', startDate: '2026-04-01', durationMonths: 12, startsOnSigning: false }, confidence: 0.9 })] }));
    expect(createContractDocument(document)).toEqual(document);
  });

  it('正常: 表記の正規化（タイトル・当事者名のトリム、ラベルの既定、空の articleRef、数値でない days、ページ警告）', () => {
    const document = createContractDocument(base({
      title: '  業務委託契約書  ',
      parties: { A: { label: '', name: '  サンプル  ' }, B: { name: '   ' } } as unknown as ContractDocument['parties'],
      pages: [{ page: 1, start: 0, end: BODY.length, method: 'vision', warnings: [1, '読めない字'] as unknown as string[] }],
      source: { type: 'pdf-ocr', fileName: 'x'.repeat(250), pageCount: 1, sha256: 'abc' },
      clauses: [clause({ articleRef: '', warnings: [{ message: 'm', origin: 'manual', days: '3' as unknown as number }] })],
    }));
    expect(document.title).toBe('業務委託契約書');
    expect(document.parties).toEqual({ A: { label: '甲', name: 'サンプル' }, B: { label: '乙' } });
    expect(document.pages[0]!.warnings).toEqual(['1', '読めない字']);
    expect(document.source).toEqual({ type: 'pdf-ocr', fileName: 'x'.repeat(200), pageCount: 1, sha256: 'abc' });
    expect(document.clauses[0]).not.toHaveProperty('articleRef');
    expect(document.clauses[0]!.warnings).toEqual([{ message: 'm', origin: 'manual' }]);
  });

  it('境界: 本文ちょうど 300,000 文字・根拠 20 件・確信度 0 と 1・契約金額 0 は受け付ける', () => {
    const body = 'あ'.repeat(BODY_MAX_CHARS);
    expect(createContractDocument(base({ body, pages: singlePage(body), articles: [] })).body).toHaveLength(BODY_MAX_CHARS);
    const evidence = Array.from({ length: 20 }, () => ({ quote: 'q', verified: false }));
    const document = createContractDocument(base({ contractAmount: 0, clauses: [clause({ evidence, confidence: 0 }), clause({ topicId: 'b', confidence: 1 })] }));
    expect(document.clauses[0]!.evidence).toHaveLength(20);
    expect(document.contractAmount).toBe(0);
  });

  it('正常: 候補（競合した条文）と抽出記録を写しで持つ', () => {
    const extraction = { promptTemplateVersion: 'contract-extract/v1', chunks: [], warnings: [], unscannedArticleRefs: [], scanAllArticles: false, extractedAt: 'x' };
    const document = createContractDocument(base({ extraction, clauses: [clause({ candidates: [{ articleRef: '第2条', evidence: [{ quote: 'q', verified: false }], value: { kind: 'text', summary: 's' } }, { evidence: [] }] })] }));
    expect(document.extraction).toEqual(extraction);
    expect(document.extraction).not.toBe(extraction);
    expect(document.clauses[0]!.candidates).toEqual([{ articleRef: '第2条', evidence: [{ quote: 'q', verified: false }], value: { kind: 'text', summary: 's' } }, { evidence: [] }]);
  });

  it('正常: 締結済みの文書は signedContractId と一緒なら作れる', () => {
    expect(createContractDocument(base({ status: 'signed', signedContractId: 'sc1', reviewId: 'r1', contractNature: { value: 'ukeoi', quote: '請負' }, signingDateText: '2026年4月1日' }))).toMatchObject({ status: 'signed', signedContractId: 'sc1', reviewId: 'r1', contractNature: { value: 'ukeoi', quote: '請負' } });
  });
});

describe('document: createContractDocument（異常）', () => {
  const cases: readonly [string, unknown, RegExp][] = [
    ['props が null', null, /props must be an object/u],
    ['tenant なし', { ...base(), tenant: undefined }, /tenant is required/u],
    ['id が空', base({ id: '' }), /id is required/u],
    ['タイトルが空白', base({ title: '  ' }), /title must be a non-empty string of at most 200/u],
    ['タイトル 201 文字', base({ title: 'x'.repeat(201) }), /title must be/u],
    ['本文が空白', base({ body: ' \n ' }), /body must not be empty/u],
    ['本文 300,001 文字', base({ body: 'あ'.repeat(BODY_MAX_CHARS + 1), pages: [{ page: 1, start: 0, end: 1, method: 'text-layer', warnings: [] }], articles: [] }), /body must be at most 300000 characters \(received 300001\); split the appendices/u],
    ['取込の系統が未対応', base({ source: { type: 'docx' as 'text' } }), /source\.type must be one of text, pdf-text, image-ocr, pdf-ocr/u],
    ['ページ数 0', base({ source: { type: 'pdf-text', pageCount: 0 } }), /source\.pageCount must be between 1 and 500/u],
    ['ページ数 501', base({ source: { type: 'pdf-text', pageCount: 501 } }), /source\.pageCount must be between 1 and 500/u],
    ['ページが空', base({ pages: [] }), /pages must have 1 to 500 entries/u],
    ['ページ 501 件', base({ pages: Array.from({ length: 501 }, (_, index) => ({ page: index + 1, start: 0, end: 0, method: 'text-layer' as const, warnings: [] })) }), /pages must have 1 to 500 entries/u],
    ['ページが本文の外', base({ pages: [{ page: 1, start: 0, end: BODY.length + 1, method: 'text-layer', warnings: [] }] }), /pages\[0\] has a range outside the body/u],
    ['ページの開始が終了より後', base({ pages: [{ page: 1, start: 5, end: 4, method: 'text-layer', warnings: [] }] }), /pages\[0\] has a range outside the body/u],
    ['ページの方式が語彙外', base({ pages: [{ page: 1, start: 0, end: 1, method: 'ocr' as 'vision', warnings: [] }] }), /pages\[0\]\.method must be text-layer or vision/u],
    ['条文が配列でない', base({ articles: {} as unknown as ContractArticle[] }), /articles must be an array/u],
    ['条文の範囲が空', base({ articles: [{ ref: '第1条', start: 3, end: 3, page: 1 }] }), /articles\[0\] has a range outside the body/u],
    ['条文の ref が無い', base({ articles: [{ start: 0, end: 1, page: 1 } as unknown as ContractArticle] }), /articles\[0\] has a range outside the body/u],
    ['自社が甲乙以外', base({ ourParty: 'C' as 'A' }), /ourParty must be A or B/u],
    ['立場が語彙外', base({ ourRole: 'boss' as 'client' }), /ourRole must be client, vendor or mutual/u],
    ['相手方区分なし', { ...base(), counterpartyProfile: undefined }, /counterpartyProfile\.toriteki \/ freelance must be yes, no or unknown/u],
    ['フリーランスが語彙外', base({ counterpartyProfile: { toriteki: 'yes', freelance: 'maybe' as 'yes' } }), /counterpartyProfile/u],
    ['契約の性質が語彙外', base({ contractNature: { value: 'lease' as 'ukeoi' } }), /contractNature\.value must be one of/u],
    ['契約金額が負', base({ contractAmount: -1 }), /contractAmount must be a non-negative integer/u],
    ['契約金額が小数', base({ contractAmount: 1.5 }), /contractAmount must be a non-negative integer/u],
    ['状態が語彙外', base({ status: 'draft' as 'imported' }), /status must be one of imported, extracted, confirmed, reviewed, signed/u],
    ['条項が配列でない', base({ clauses: {} as unknown as Clause[] }), /clauses must be an array/u],
    ['条項の topicId が空', base({ clauses: [clause({ topicId: '' })] }), /clauses\[0\]\.topicId is required/u],
    ['present が真偽値でない', base({ clauses: [clause({ present: 'yes' as unknown as boolean })] }), /clauses\[0\]\.present must be a boolean/u],
    ['source が語彙外', base({ clauses: [clause({ source: 'ai' as 'llm' })] }), /clauses\[0\]\.source must be llm or manual/u],
    ['warnings が配列でない', base({ clauses: [clause({ warnings: undefined as unknown as [] })] }), /clauses\[0\]\.warnings must be an array/u],
    ['確信度 1.1', base({ clauses: [clause({ confidence: 1.1 })] }), /clauses\[0\]\.confidence must be between 0 and 1/u],
    ['根拠 21 件', base({ clauses: [clause({ evidence: Array.from({ length: 21 }, () => ({ quote: 'q', verified: true })) })] }), /clauses\[0\]\.evidence must be an array of at most 20 quotes/u],
    ['引用が空', base({ clauses: [clause({ evidence: [{ quote: ' ', verified: true }] })] }), /clauses\[0\]\.evidence\[0\]\.quote must be a non-empty string of at most 2000/u],
    ['引用 2001 文字', base({ clauses: [clause({ evidence: [{ quote: 'x'.repeat(2001), verified: true }] })] }), /evidence\[0\]\.quote must be/u],
    ['verified が無い', base({ clauses: [clause({ evidence: [{ quote: 'q' } as unknown as Clause['evidence'][number]] })] }), /evidence\[0\]\.verified must be a boolean/u],
    ['引用位置が本文の外', base({ clauses: [clause({ evidence: [{ quote: 'q', start: 0, end: BODY.length + 1, verified: true }] })] }), /evidence\[0\] has a position outside the body/u],
    ['引用位置の開始だけ', base({ clauses: [clause({ evidence: [{ quote: 'q', start: 0, verified: true }] })] }), /evidence\[0\] has a position outside the body/u],
    ['引用位置が逆順', base({ clauses: [clause({ evidence: [{ quote: 'q', start: 5, end: 5, verified: true }] })] }), /evidence\[0\] has a position outside the body/u],
    ['値の形が崩れている', base({ clauses: [clause({ value: { kind: 'term' } as unknown as Clause['value'] })] }), /clauses\[0\]\.value: value does not match its kind/u],
    ['警告の message が無い', base({ clauses: [clause({ warnings: [{ origin: 'manual' } as unknown as Clause['warnings'][number]] })] }), /clauses\[0\]\.warnings\[0\]\.message must be a string/u],
    ['警告の code が理由コードでない', base({ clauses: [clause({ warnings: [{ code: 'oops' as 'clause-missing', message: 'm', origin: 'manual' }] })] }), /warnings\[0\]\.code is not a reason code: oops/u],
    ['警告の origin が語彙外', base({ clauses: [clause({ warnings: [{ message: 'm', origin: 'llm' as 'manual' }] })] }), /warnings\[0\]\.origin is invalid/u],
    ['同じトピックが 2 つ', base({ clauses: [clause(), clause()] }), /clauses has the clause type "term" twice; pick one of the candidates instead/u],
    ['候補の値が崩れている', base({ clauses: [clause({ candidates: [{ evidence: [], value: { kind: 'permission', policy: 'x' } as unknown as Clause['value'] }] })] }), /clauses\[0\]\.candidates\[0\]\.value: value does not match/u],
    ['候補の根拠が崩れている', base({ clauses: [clause({ candidates: [{ evidence: [{ quote: '', verified: true }] }] })] }), /clauses\[0\]\.candidates\[0\]\.evidence\[0\]\.quote/u],
    ['締結済みなのに締結済み契約 id が無い', base({ status: 'signed' }), /a signed document needs signedContractId/u],
  ];

  it.each(cases)('異常: %s', (_label, props, message) => {
    expectRejected(props, message);
  });
});

describe('document: 当事者名と要約', () => {
  it.each([
    ['A', '株式会社サンプル商事', '株式会社テスト'],
    ['B', '株式会社テスト', '株式会社サンプル商事'],
    [undefined, undefined, undefined],
  ] as const)('正常: 自社が %s なら 自社名 %s・相手方 %s', (ourParty, ours, theirs) => {
    const { ourParty: _omit, ...rest } = base();
    const document = ourParty === undefined ? rest : { ...rest, ourParty };
    expect(ourNameOf(document)).toBe(ours);
    expect(counterpartyNameOf(document)).toBe(theirs);
  });

  it('正常: 要約は本文・条項を含まず、条項数は present だけを数える', () => {
    const document = createContractDocument(base({ source: { type: 'pdf-text', fileName: 'a.pdf', pageCount: 2, sha256: 'h' }, reviewId: 'r1', clauses: [clause(), clause({ topicId: 'x', present: false, evidence: [] })] }));
    expect(toContractDocumentSummary(document)).toEqual({
      id: 'doc1', title: '業務委託契約書', status: 'imported', sourceType: 'pdf-text', fileName: 'a.pdf', pageCount: 2, sha256: 'h', counterpartyName: '株式会社テスト', ourRole: 'client',
      bodyLength: BODY.length, clauseCount: 1, reviewId: 'r1', createdAt: document.createdAt, updatedAt: document.updatedAt,
    });
  });

  it('境界: 任意の項目が無ければ要約からも省く', () => {
    const { ourParty: _party, ourRole: _role, ...rest } = base({ status: 'signed', signedContractId: 'sc1' });
    const summary = toContractDocumentSummary(createContractDocument(rest));
    expect(Object.keys(summary).sort()).toEqual(['bodyLength', 'clauseCount', 'createdAt', 'id', 'signedContractId', 'sourceType', 'status', 'title', 'updatedAt']);
  });
});

describe('document: assertNotSigned', () => {
  it('例外: 締結済みの文書は ContractStateError（開く場所を持つ）', () => {
    const document = createContractDocument(base({ status: 'signed', signedContractId: 'sc1' }));
    let caught: unknown;
    try { assertNotSigned(document, 'change the body'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContractStateError);
    expect((caught as ContractStateError).target).toEqual({ documentId: 'doc1', contractId: 'sc1' });
    expect((caught as Error).message).toContain('cannot change the body');
  });

  it('例外: 締結済み契約 id の無い締結済み（直列化の崩れ）でも止め、target に contractId を入れない', () => {
    const broken = { ...base(), status: 'signed' as const };
    expect(() => assertNotSigned(broken, 'x')).toThrowError(ContractStateError);
    try { assertNotSigned(broken, 'x'); } catch (error) { expect((error as ContractStateError).target).toEqual({ documentId: 'doc1' }); }
  });

  it.each(['imported', 'extracted', 'confirmed', 'reviewed'] as const)('正常: %s は変更できる', (status) => {
    expect(() => assertNotSigned(base({ status }), 'x')).not.toThrow();
  });
});

describe('document: articleForClause', () => {
  const articles: ContractArticle[] = [
    { ref: '前文', start: 0, end: 10, page: 1 },
    { ref: '第1条', start: 10, end: 20, page: 1 },
    { ref: '第12条', start: 20, end: 30, page: 1 },
    { ref: '第12条の2', start: 30, end: 40, page: 1 },
    { ref: '段落 1', start: 40, end: 50, page: 1 },
    { ref: '段落 12', start: 50, end: 60, page: 2 },
  ];
  const find = (articleRef: string | undefined, start?: number) => articleForClause({ articles }, { ...(articleRef === undefined ? {} : { articleRef }), evidence: start === undefined ? [{ quote: 'q', verified: false }] : [{ quote: 'q', verified: false }, { quote: 'q', start, end: start + 1, verified: true }] })?.ref;

  it.each([
    ['第12条第2項', '第12条'],
    ['第12条', '第12条'],
    ['第12条の2第1項', '第12条の2'],
    ['第1条第3項', '第1条'],
    ['前文', '前文'],
    ['段落 12', '段落 12'],
  ])('正常: articleRef %s → 最長一致で %s（枝番・数字の続きは別の条）', (articleRef, expected) => {
    expect(find(articleRef)).toBe(expected);
  });

  it.each([
    ['当たらない ref は根拠の位置で探す', '第99条', 25, '第12条'],
    ['ref が無ければ根拠の位置', undefined, 55, '段落 12'],
    ['位置も無ければ undefined', '第99条', undefined, undefined],
    ['位置が範囲外なら undefined', undefined, 100, undefined],
  ])('境界: %s', (_label, articleRef, start, expected) => {
    expect(find(articleRef, start)).toBe(expected);
  });
});

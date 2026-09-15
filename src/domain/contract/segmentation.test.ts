import { describe, expect, it } from 'vitest';
import { detectParties, MIN_ARTICLE_HEADINGS, segmentArticles, singlePage, type ContractPage } from './segmentation';

const BODY = [
  '業務委託契約書',
  '',
  '株式会社サンプル商事（以下「甲」という。）と株式会社テスト（以下「乙」という。）は、次のとおり契約する。',
  '',
  '（目的）',
  '第１条　甲は乙に業務を委託する。',
  '第二条（委託料）　甲は乙に委託料を支払う。前条（第1条）の業務の対価とする。',
  '第3条の2　乙は再委託しない。',
  '　第十二条 (管轄) 東京地方裁判所とする。',
  '',
  '本契約締結の証として、本書2通を作成する。',
  '甲　株式会社サンプル商事',
].join('\n');

describe('segmentation: segmentArticles（条見出し）', () => {
  const articles = segmentArticles(BODY, singlePage(BODY), 4000);

  it('正常: 全角数字・漢数字・枝番・前文・後文を分ける', () => {
    expect(articles.map((article) => article.ref)).toEqual(['前文', '第1条', '第2条', '第3条の2', '第12条', '後文']);
  });

  it('正常: 見出しは直後の（見出し）か、前の行の（見出し）から取る（半角括弧も可）', () => {
    expect(articles.map((article) => article.heading)).toEqual([undefined, '目的', '委託料', undefined, '管轄', undefined]);
  });

  it('正常: 前の行の（見出し）があればその行から条文を始める。条文は隙間なく並ぶ', () => {
    expect(articles[1]!.start).toBe(BODY.indexOf('（目的）'));
    expect(articles[0]).toMatchObject({ start: 0, end: BODY.indexOf('（目的）') });
    for (let index = 1; index < articles.length; index += 1) expect(articles[index]!.start).toBe(articles[index - 1]!.end);
    expect(articles[articles.length - 1]!.end).toBe(BODY.length);
  });

  it('正常: 後文は「本契約締結の証として」の行頭から', () => {
    expect(articles[5]!.start).toBe(BODY.indexOf('本契約締結の証として'));
  });

  it('境界: 行頭でない「第1条」への言及は見出しにしない', () => {
    expect(articles.filter((article) => article.ref === '第1条')).toHaveLength(1);
  });

  it('正常: ページ境界から各条文のページを決める', () => {
    const middle = BODY.indexOf('第3条の2');
    const pages: ContractPage[] = [
      { page: 1, start: 0, end: middle, method: 'text-layer', warnings: [] },
      { page: 2, start: middle, end: BODY.length, method: 'vision', warnings: [] },
    ];
    expect(segmentArticles(BODY, pages, 4000).map((article) => article.page)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('境界: ページの範囲外は最後のページ、ページが空なら 1', () => {
    const partial: ContractPage[] = [{ page: 3, start: 0, end: 10, method: 'text-layer', warnings: [] }];
    expect(segmentArticles(BODY, partial, 4000).map((article) => article.page)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(segmentArticles(BODY, [], 4000).map((article) => article.page)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('境界: 本文の先頭が条見出しなら前文を作らず、署名欄の目印が無ければ後文も作らない', () => {
    const body = '第1条 目的\n第2条 委託\n第3条 支払';
    expect(segmentArticles(body, singlePage(body), 4000)).toEqual([
      { ref: '第1条', start: 0, end: 7, page: 1 },
      { ref: '第2条', start: 7, end: 14, page: 1 },
      { ref: '第3条', start: 14, end: body.length, page: 1 },
    ]);
  });

  it('正常: 「本契約の成立を証するため」など他の署名欄の目印も後文にする', () => {
    const body = '第1条 a\n第2条 b\n第3条 c\n本契約の成立を証するため署名する。';
    expect(segmentArticles(body, singlePage(body), 4000).map((article) => article.ref)).toEqual(['第1条', '第2条', '第3条', '後文']);
  });
});

describe('segmentation: 段落フォールバック', () => {
  it(`境界: 条見出しが ${MIN_ARTICLE_HEADINGS} 件未満なら段落に分ける`, () => {
    const body = '第1条 目的\n\n第2条 委託';
    expect(segmentArticles(body, singlePage(body), 4000)).toEqual([{ ref: '段落 1-2', start: 0, end: body.length, page: 1 }]);
  });

  it('正常: chunkMaxChars を超えないように段落を連結する', () => {
    const body = 'aaaa\n\nbbbb\n　\ncccc';
    expect(segmentArticles(body, singlePage(body), 10)).toEqual([
      { ref: '段落 1-2', start: 0, end: 10, page: 1 },
      { ref: '段落 3', start: 13, end: 17, page: 1 },
    ]);
  });

  it('境界: 1 段落が上限を超えても 1 件として出す。空白だけの段落は数えない', () => {
    const body = '\n\n' + 'x'.repeat(20) + '\n\n   \n\n' + 'y';
    const articles = segmentArticles(body, singlePage(body), 10);
    expect(articles.map((article) => article.ref)).toEqual(['段落 1', '段落 2']);
    expect(body.slice(articles[0]!.start, articles[0]!.end)).toBe('x'.repeat(20));
  });

  it('境界: 空白だけの本文は条文なし', () => {
    expect(segmentArticles('  \n\n ', singlePage('  \n\n '), 4000)).toEqual([]);
  });
});

describe('segmentation: detectParties / singlePage', () => {
  it('正常: 前文の「〇〇（以下「甲」という。）」から甲乙の名前を取る', () => {
    expect(detectParties(BODY)).toEqual({ A: '株式会社サンプル商事', B: '株式会社テスト' });
  });

  it.each([
    ['カギ括弧なし・読点あり', 'サンプル商事(以下、甲という。)', { A: 'サンプル商事' }],
    ['乙だけ', '株式会社テスト（以下『乙』という。）', { B: '株式会社テスト' }],
    ['最初の定義を採る', 'A社（以下「甲」という。）\nB社（以下「甲」という。）', { A: 'A社' }],
    ['定義が無い', '甲と乙は契約する。', {}],
  ])('境界: %s', (_label, body, expected) => {
    expect(detectParties(body)).toEqual(expected);
  });

  it('境界: 先頭 3,000 文字より後ろの定義は見ない', () => {
    expect(detectParties(`${'あ'.repeat(3000)}株式会社テスト（以下「乙」という。）`)).toEqual({});
  });

  it('正常: singlePage は本文全体を覆う 1 ページ', () => {
    expect(singlePage('abc')).toEqual([{ page: 1, start: 0, end: 3, method: 'text-layer', warnings: [] }]);
  });
});

describe('segmentation: detectParties の括弧書き', () => {
  it('境界: 名前の直後の短い括弧書き（「（架空）」）は読み飛ばして名前だけを拾う', () => {
    expect(detectParties('株式会社サンプル商事（架空）（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は')).toEqual({ A: '株式会社サンプル商事', B: '架空テック合同会社' });
  });
});

import { expect } from 'vitest';
import type { ContractDocumentRepository } from '../../domain/contract/repositories';
import { confirmedClauses, COUNTERPARTY, documentFixture, otherTenant, otherWorkspace, SAMPLE_CONTRACT_BODY, scope } from './contract-repository.fixtures';

/** ContractDocumentRepository 実装が満たすべき共有契約。 */
export async function contractDocumentRepositoryContract(repo: ContractDocumentRepository): Promise<void> {
  // 正常: 本文・ページ・条文・条項・抽出の記録が欠けずに往復する。
  const first = documentFixture('doc-a', {
    status: 'extracted', clauses: confirmedClauses(), signingDateText: '2026年3月15日', contractNature: { value: 'jun_inin', quote: '業務委託' },
    extraction: { playbookId: 'pb-1', promptTemplateVersion: 'contract-extract/v1', chunks: [{ index: 0, articleRefs: ['第2条'], topicIds: ['term'], status: 'ok' }], warnings: [], unscannedArticleRefs: ['第1条'], scanAllArticles: false, extractedAt: '2026-09-13T03:00:00.000Z' },
    createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T03:00:00.000Z',
  });
  await repo.save(first);
  expect(await repo.findById(scope, 'doc-a')).toEqual(first);

  // 正常: 同 id の保存は上書き。
  const reviewed = documentFixture('doc-a', { status: 'reviewed', clauses: confirmedClauses(), reviewId: 'review-1', createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T04:00:00.000Z' });
  await repo.save(reviewed);
  expect(await repo.findById(scope, 'doc-a')).toEqual(reviewed);

  // 正常: 一覧は新しいものが先（createdAt 降順）、同時刻は id 昇順。
  await repo.save(documentFixture('doc-c', { createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' }));
  await repo.save(documentFixture('doc-b', { status: 'confirmed', ourParty: undefined, source: { type: 'pdf-text', pageCount: 3 }, createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' }));
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b', 'doc-c']);

  // 正常: 要約は本文・条項・抽出の詳細を含まない（一覧の応答を本文で太らせない）。
  const summaries = await repo.list(scope);
  for (const summary of summaries) {
    expect(summary).not.toHaveProperty('body');
    expect(summary).not.toHaveProperty('clauses');
    expect(summary).not.toHaveProperty('extraction');
    expect(JSON.stringify(summary)).not.toContain('委託料を支払う');
  }
  expect(summaries[0]).toEqual({
    id: 'doc-a', title: '業務委託契約書 doc-a', status: 'reviewed', sourceType: 'text', fileName: 'contract.txt', sha256: 'sha-sample',
    counterpartyName: COUNTERPARTY, ourRole: 'client', bodyLength: SAMPLE_CONTRACT_BODY.length, clauseCount: 6, reviewId: 'review-1',
    createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T04:00:00.000Z',
  });
  // 自社が未設定なら相手方は決まらない（要約にも出さない）。
  expect(summaries[1]).not.toHaveProperty('counterpartyName');
  expect(summaries[1]).toMatchObject({ sourceType: 'pdf-text', pageCount: 3 });

  // 正常 / 境界: status で絞り込み、limit は並べ替えの後に効く。0 は空。
  expect((await repo.list(scope, { status: 'confirmed' })).map((entry) => entry.id)).toEqual(['doc-b']);
  expect(await repo.list(scope, { status: 'signed' })).toEqual([]);
  expect((await repo.list(scope, { limit: 2 })).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b']);
  expect(await repo.list(scope, { limit: 0 })).toEqual([]);
  expect((await repo.list(scope, { status: 'imported', limit: 5 })).map((entry) => entry.id)).toEqual(['doc-c']);

  // 境界: スコープ分離。
  expect(await repo.findById(otherTenant, 'doc-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  const foreign = documentFixture('doc-a', { tenant: otherWorkspace, title: '別ワークスペースの文書' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'doc-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'doc-a'))?.status).toBe('reviewed');

  // 正常 / 異常: delete の戻り値。
  expect(await repo.delete(scope, 'doc-a')).toBe(true);
  expect(await repo.delete(scope, 'doc-a')).toBe(false);
  expect(await repo.findById(otherWorkspace, 'doc-a')).toEqual(foreign);

  // 境界: 読み出した値は複製。
  const fetched = await repo.findById(scope, 'doc-b');
  (fetched!.parties.A as { name?: string }).name = '書き換え';
  expect((await repo.findById(scope, 'doc-b'))?.parties.A.name).not.toBe('書き換え');
}

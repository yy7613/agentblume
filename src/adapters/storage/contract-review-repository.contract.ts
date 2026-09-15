import { expect } from 'vitest';
import type { ContractReviewRepository } from '../../domain/contract/repositories';
import { otherTenant, otherWorkspace, reviewFixture, scope } from './contract-repository.fixtures';

/** ContractReviewRepository 実装が満たすべき共有契約。 */
export async function contractReviewRepositoryContract(repo: ContractReviewRepository): Promise<void> {
  // 正常: 判定結果・審査基準の写し・LLM 回答の再利用キャッシュが欠けずに往復する。
  const first = reviewFixture('rv-b', { createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T01:00:00.000Z', model: { provider: 'local', model: 'gemma' } });
  await repo.save(first);
  expect(await repo.findById(scope, 'rv-b')).toEqual(first);

  // 正常: 同 id の保存は上書き（stale・人の判断）。
  const decided = reviewFixture('rv-b', {
    stale: true,
    results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [], humanDecision: 'accept', humanNote: 'OK' }],
    createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z',
  });
  await repo.save(decided);
  expect(await repo.findById(scope, 'rv-b')).toEqual(decided);

  // 正常: 文書ごとの一覧は新しいものが先、同時刻は id 昇順。他の文書のレビューは出ない。
  await repo.save(reviewFixture('rv-c', { createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T03:00:00.000Z' }));
  await repo.save(reviewFixture('rv-a', { createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T03:00:00.000Z' }));
  await repo.save(reviewFixture('rv-other', { documentId: 'doc-2' }));
  expect((await repo.listByDocument(scope, 'doc-1')).map((review) => review.id)).toEqual(['rv-a', 'rv-c', 'rv-b']);
  expect((await repo.listByDocument(scope, 'doc-2')).map((review) => review.id)).toEqual(['rv-other']);
  expect(await repo.listByDocument(scope, 'missing')).toEqual([]);

  // 境界: スコープ分離。
  expect(await repo.findById(otherTenant, 'rv-a')).toBeNull();
  expect(await repo.listByDocument(otherTenant, 'doc-1')).toEqual([]);
  const foreign = reviewFixture('rv-a', { tenant: otherWorkspace, overall: 'reject' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'rv-a')).toEqual(foreign);

  // 正常: deleteByDocument は消した件数を返し、他の文書・他スコープには触れない。
  expect(await repo.deleteByDocument(scope, 'doc-1')).toBe(3);
  expect(await repo.deleteByDocument(scope, 'doc-1')).toBe(0);
  expect(await repo.listByDocument(scope, 'doc-1')).toEqual([]);
  expect((await repo.listByDocument(scope, 'doc-2')).map((review) => review.id)).toEqual(['rv-other']);
  expect(await repo.findById(otherWorkspace, 'rv-a')).toEqual(foreign);
  expect(await repo.findById(scope, 'missing')).toBeNull();

  // 境界: 読み出した値は複製。
  const fetched = await repo.findById(scope, 'rv-other');
  (fetched!.llmCache as unknown as { reasoning: string }[])[0]!.reasoning = '書き換え';
  expect((await repo.findById(scope, 'rv-other'))?.llmCache[0]?.reasoning).toBe('上限がある');
}

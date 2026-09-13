import { expect } from 'vitest';
import type { JournalEntryRepository } from '../../domain/journal/repositories';
import { entryFixture, otherTenant, otherWorkspace, scope } from './journal-repository.fixtures';

/** JournalEntryRepository 実装が満たすべき共有契約。 */
export async function journalEntryRepositoryContract(repo: JournalEntryRepository): Promise<void> {
  // 正常: 行（補助軸・税額・取引先）・インボイス区分・品目・タグが欠けずに往復する。
  const entry = entryFixture('entry-a');
  await repo.save(entry);
  const loaded = await repo.findById(scope, 'entry-a');
  expect(loaded).toEqual(entry);
  expect(loaded?.lines).toHaveLength(2);
  expect(loaded?.lines[0]).toMatchObject({ accountId: 'expense.supplies', accountName: '消耗品費', dimensionValues: { sub_account: 'sub1' }, taxAmount: 100, partner: 'テスト' });
  expect(loaded?.tags).toEqual(['tag1']);

  // 正常: 同 id の保存は上書き（版を持たない）。状態遷移も反映される。
  const confirmed = entryFixture('entry-a', { status: 'confirmed', updatedAt: '2026-09-14T00:00:00.000Z' });
  await repo.save(confirmed);
  expect(await repo.findById(scope, 'entry-a')).toEqual(confirmed);
  expect((await repo.findById(scope, 'entry-a'))?.status).toBe('confirmed');

  // 正常: 一覧は仕訳日 昇順 → createdAt 昇順 → id 昇順（CSV に出す順）。
  await repo.save(entryFixture('entry-early', { date: '2026-09-01' }));
  await repo.save(entryFixture('entry-late', { date: '2026-09-20' }));
  await repo.save(entryFixture('b-same', { date: '2026-09-10', createdAt: '2026-09-13T00:00:00.000Z' }));
  await repo.save(entryFixture('a-same', { date: '2026-09-10', createdAt: '2026-09-13T00:00:00.000Z' }));
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['entry-early', 'a-same', 'b-same', 'entry-a', 'entry-late']);

  // 正常: status で絞り込める。
  expect((await repo.list(scope, { status: 'confirmed' })).map((item) => item.id)).toEqual(['entry-a']);
  expect((await repo.list(scope, { status: 'draft' })).map((item) => item.id)).toEqual(['entry-early', 'a-same', 'b-same', 'entry-late']);
  expect(await repo.list(scope, { status: 'exported' })).toEqual([]);

  // 正常 / 境界: 仕訳日の範囲は両端を含む。
  expect((await repo.list(scope, { from: '2026-09-10', to: '2026-09-10' })).map((item) => item.id)).toEqual(['a-same', 'b-same', 'entry-a']);
  expect((await repo.list(scope, { from: '2026-09-20' })).map((item) => item.id)).toEqual(['entry-late']);
  expect((await repo.list(scope, { to: '2026-09-01' })).map((item) => item.id)).toEqual(['entry-early']);
  expect(await repo.list(scope, { from: '2026-09-21', to: '2026-09-30' })).toEqual([]);

  // 正常: documentId で逆引きできる（文書 → その仕訳）。
  await repo.save(entryFixture('entry-other-doc', { documentId: 'doc-2', date: '2026-09-11' }));
  expect((await repo.list(scope, { documentId: 'doc-2' })).map((item) => item.id)).toEqual(['entry-other-doc']);
  expect((await repo.list(scope, { documentId: 'doc-1' })).map((item) => item.id)).toEqual(['entry-early', 'a-same', 'b-same', 'entry-a', 'entry-late']);
  expect(await repo.list(scope, { documentId: 'missing' })).toEqual([]);
  // 文書に紐づかない仕訳（手入力）は documentId 指定で出ない。
  await repo.save(entryFixture('entry-manual', { documentId: undefined, ruleId: undefined, decidedBy: 'manual', date: '2026-09-11' }));
  expect((await repo.list(scope, { documentId: 'doc-2' })).map((item) => item.id)).toEqual(['entry-other-doc']);
  expect((await repo.findById(scope, 'entry-manual'))?.documentId).toBeUndefined();

  // 境界: 絞り込みの組み合わせ（status + 範囲）。
  expect((await repo.list(scope, { status: 'draft', from: '2026-09-11', to: '2026-09-11' })).map((item) => item.id)).toEqual(['entry-manual', 'entry-other-doc']);

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、同 id が共存できる。
  expect(await repo.findById(otherTenant, 'entry-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  const foreign = entryFixture('entry-a', { tenant: otherWorkspace, description: '別ワークスペース' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'entry-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'entry-a'))?.description).toBe('テスト仕入');
  expect((await repo.list(otherWorkspace)).map((item) => item.id)).toEqual(['entry-a']);

  // 正常 / 異常: delete は削除前に存在したかを返し、他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'entry-a')).toBe(true);
  expect(await repo.delete(scope, 'entry-a')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect(await repo.findById(scope, 'entry-a')).toBeNull();
  expect(await repo.findById(otherWorkspace, 'entry-a')).toEqual(foreign);

  // 境界: 未知の id は null。空スコープの一覧は空配列。
  expect(await repo.findById(scope, 'missing')).toBeNull();
  expect(await repo.list({ tenantId: 'empty', workspaceId: 'empty' })).toEqual([]);

  // 境界: 保存した値は複製される（呼び出し側の参照経由で内部が壊れない）。
  const mutable = entryFixture('entry-mutable');
  await repo.save(mutable);
  const fetched = await repo.findById(scope, 'entry-mutable');
  expect(fetched).toEqual(mutable);
  expect(fetched).not.toBe(mutable);
  expect(fetched?.lines).not.toBe(mutable.lines);
  (fetched as unknown as { lines: { amount: number }[] }).lines[0]!.amount = 1;
  expect((await repo.findById(scope, 'entry-mutable'))?.lines[0]?.amount).toBe(1100);
}
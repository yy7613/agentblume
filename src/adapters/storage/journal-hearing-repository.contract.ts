import { expect } from 'vitest';
import type { JournalHearingRepository } from '../../domain/journal/repositories';
import { hearingFixture, otherTenant, otherWorkspace, scope } from './journal-repository.fixtures';

/**
 * JournalHearingRepository 実装が満たすべき共有契約。
 * フェーズ 1 では集約とリポジトリだけを用意し、質問生成・提案はフェーズ 2 が載せる。
 */
export async function journalHearingRepositoryContract(repo: JournalHearingRepository): Promise<void> {
  // 正常: 質問と回答の列が順序どおり往復する。
  const session = hearingFixture('hearing-a');
  await repo.save(session);
  const loaded = await repo.findById(scope, 'hearing-a');
  expect(loaded).toEqual(session);
  expect(loaded?.turns).toHaveLength(2);
  expect(loaded?.turns[0]).toMatchObject({ role: 'assistant' });
  expect(loaded?.turns[1]).toMatchObject({ role: 'user', answer: { questionId: 'q1', value: 'entertainment' } });
  expect(loaded?.proposal).toBeUndefined();

  // 正常: 同 id の保存は上書き。提案つき（proposed）も往復する。
  const proposed = hearingFixture('hearing-a', {
    status: 'proposed',
    proposal: {
      rule: { name: '飲食は会議費', enabled: true, mode: 'auto', priority: 100, scope: {}, conditions: [{ field: 'extra.purpose', op: 'equals', value: 'internal-meeting' }], outcome: { lines: [{ side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' }] }, askIf: [], requiredFacts: [] },
      entry: { date: '2026-09-10', lines: [{ side: 'debit', accountId: 'expense.meetings', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 }], description: '打合せ', invoiceStatus: 'qualified' },
      newAccounts: [], newDimensionValues: [], newTaxCategories: [], rationale: '軽食程度の打合せ', warnings: [],
    },
    updatedAt: '2026-09-14T00:00:00.000Z',
  });
  await repo.save(proposed);
  expect(await repo.findById(scope, 'hearing-a')).toEqual(proposed);
  expect((await repo.findById(scope, 'hearing-a'))?.proposal?.rationale).toBe('軽食程度の打合せ');

  // 正常: 一覧・文書別ともに新しいものが先（createdAt 降順）、同時刻は id 昇順で安定。
  await repo.save(hearingFixture('hearing-old', { createdAt: '2026-09-01T00:00:00.000Z' }));
  await repo.save(hearingFixture('b-same'));
  await repo.save(hearingFixture('a-same'));
  await repo.save(hearingFixture('hearing-doc2', { documentId: 'doc-2', createdAt: '2026-09-14T00:00:00.000Z' }));
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['hearing-doc2', 'a-same', 'b-same', 'hearing-a', 'hearing-old']);

  // 正常: findByDocument はその文書のものだけを新しい順で返す。
  expect((await repo.findByDocument(scope, 'doc-1')).map((entry) => entry.id)).toEqual(['a-same', 'b-same', 'hearing-a', 'hearing-old']);
  expect((await repo.findByDocument(scope, 'doc-2')).map((entry) => entry.id)).toEqual(['hearing-doc2']);
  expect(await repo.findByDocument(scope, 'missing')).toEqual([]);

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、同 id が共存できる。
  expect(await repo.findById(otherTenant, 'hearing-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  expect(await repo.findByDocument(otherTenant, 'doc-1')).toEqual([]);
  const foreign = hearingFixture('hearing-a', { tenant: otherWorkspace, status: 'cancelled' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'hearing-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'hearing-a'))?.status).toBe('proposed');
  expect((await repo.list(otherWorkspace)).map((entry) => entry.id)).toEqual(['hearing-a']);

  // 境界: 未知の id は null。空スコープの一覧は空配列。
  expect(await repo.findById(scope, 'missing')).toBeNull();
  expect(await repo.list({ tenantId: 'empty', workspaceId: 'empty' })).toEqual([]);

  // 境界: 保存した値は複製される（呼び出し側の参照経由で内部が壊れない）。
  const mutable = hearingFixture('hearing-mutable');
  await repo.save(mutable);
  const fetched = await repo.findById(scope, 'hearing-mutable');
  expect(fetched).toEqual(mutable);
  expect(fetched).not.toBe(mutable);
  expect(fetched?.turns).not.toBe(mutable.turns);
  (fetched as unknown as { turns: { at: string }[] }).turns[0]!.at = '2000-01-01T00:00:00.000Z';
  expect((await repo.findById(scope, 'hearing-mutable'))?.turns[0]?.at).toBe(mutable.turns[0]?.at);

  // 異常: 知らない id・知らない文書を引いても例外にせず、null と空配列を返す。
  // 画面はヒアリングの有無を「取れたかどうか」で判断するので、ここで投げられると開けなくなる。
  expect(await repo.findById(scope, 'no-such-hearing')).toBeNull();
  expect(await repo.findByDocument(scope, 'no-such-document')).toEqual([]);
}

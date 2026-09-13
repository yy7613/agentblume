import { expect } from 'vitest';
import type { JournalDocumentRepository } from '../../domain/journal/repositories';
import { documentFixture, otherTenant, otherWorkspace, SAMPLE_DATA_URL, scope } from './journal-repository.fixtures';

/** JournalDocumentRepository 実装が満たすべき共有契約。 */
export async function journalDocumentRepositoryContract(repo: JournalDocumentRepository): Promise<void> {
  // 正常: 証憑本体（data URL・原文・CSV 行）と facts・extraction が欠けずに往復する。
  const first = documentFixture('doc-a', { createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T03:00:00.000Z' });
  await repo.save(first);
  const loaded = await repo.findById(scope, 'doc-a');
  expect(loaded).toEqual(first);
  expect(loaded?.source.dataUrl).toBe(SAMPLE_DATA_URL);
  expect(loaded?.source.text).toBe('原文テキスト');
  expect(loaded?.source.row).toEqual({ 日付: '2026-09-10' });

  // 正常: 同 id の保存は上書き（版を持たない）。判定結果と仕訳参照も残る。
  const decided = documentFixture('doc-a', {
    status: 'decided', entryId: 'entry-1',
    judgment: { stage: 'decided', ruleId: 'rule-1', entryId: 'entry-1', specificity: 4, candidates: [{ ruleId: 'rule-1', ruleName: 'r', mode: 'auto', priority: 100, specificity: 4 }], judgedAt: '2026-09-13T04:00:00.000Z' },
    createdAt: '2026-09-13T03:00:00.000Z', updatedAt: '2026-09-13T04:00:00.000Z',
  });
  await repo.save(decided);
  expect(await repo.findById(scope, 'doc-a')).toEqual(decided);
  expect((await repo.findById(scope, 'doc-a'))?.judgment).toMatchObject({ stage: 'decided', ruleId: 'rule-1' });

  // 正常: 一覧は新しいものが先（createdAt 降順）、同時刻は id 昇順で安定。
  await repo.save(documentFixture('doc-b', { kind: 'receipt', status: 'undecided', createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' }));
  await repo.save(documentFixture('doc-c', { kind: 'bank_statement', createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' }));
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b', 'doc-c']);

  // 正常: 要約は本体（data URL・原文・CSV 行）を含まない。ここが漏れると一覧の応答が数 MiB になる。
  const summaries = await repo.list(scope);
  for (const summary of summaries) {
    expect(summary).not.toHaveProperty('source');
    expect(JSON.stringify(summary)).not.toContain('base64');
    expect(JSON.stringify(summary)).not.toContain('原文テキスト');
  }
  expect(summaries[0]).toMatchObject({ id: 'doc-a', kind: 'invoice', status: 'decided', sourceType: 'image', fileName: 'invoice.png', transactionDate: '2026-09-10', grandTotal: 1100, entryId: 'entry-1' });

  // 正常: status / kind で絞り込める。
  expect((await repo.list(scope, { status: 'undecided' })).map((entry) => entry.id)).toEqual(['doc-b']);
  expect((await repo.list(scope, { kind: 'bank_statement' })).map((entry) => entry.id)).toEqual(['doc-c']);
  expect(await repo.list(scope, { status: 'exported' })).toEqual([]);

  // 正常 / 境界: 取引日の範囲は両端を含む。日付を持たない文書は範囲指定から外れる。
  await repo.save(documentFixture('doc-old', { facts: { direction: 'out', transactionDate: '2026-08-01', grandTotal: 500 }, createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T01:00:00.000Z' }));
  await repo.save(documentFixture('doc-undated', { facts: { direction: 'out', grandTotal: 500 }, createdAt: '2026-09-13T00:30:00.000Z', updatedAt: '2026-09-13T00:30:00.000Z' }));
  expect((await repo.list(scope, { from: '2026-09-10', to: '2026-09-10' })).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b', 'doc-c']);
  expect((await repo.list(scope, { from: '2026-08-01' })).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b', 'doc-c', 'doc-old']);
  expect((await repo.list(scope, { to: '2026-08-31' })).map((entry) => entry.id)).toEqual(['doc-old']);
  expect((await repo.list(scope, { from: '2026-08-02', to: '2026-09-09' })).map((entry) => entry.id)).toEqual([]);

  // 境界: limit は並べ替えの後に効く（新しい方から N 件）。0 は空。
  expect((await repo.list(scope, { limit: 2 })).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b']);
  expect(await repo.list(scope, { limit: 0 })).toEqual([]);

  // 正常 / 境界: findByIds は ids の順で、見つかったものだけを返す。空配列は空。
  expect((await repo.findByIds(scope, ['doc-c', 'doc-a'])).map((entry) => entry.id)).toEqual(['doc-c', 'doc-a']);
  expect((await repo.findByIds(scope, ['doc-a', 'missing', 'doc-b'])).map((entry) => entry.id)).toEqual(['doc-a', 'doc-b']);
  expect(await repo.findByIds(scope, [])).toEqual([]);
  expect(await repo.findByIds(scope, ['missing'])).toEqual([]);
  // 本体を返すので data URL は落ちない（要約との違い）。
  expect((await repo.findByIds(scope, ['doc-a']))[0]?.source.dataUrl).toBe(SAMPLE_DATA_URL);

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、同 id が共存できる。
  expect(await repo.findById(otherTenant, 'doc-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  expect(await repo.findByIds(otherTenant, ['doc-a'])).toEqual([]);
  const foreign = documentFixture('doc-a', { tenant: otherWorkspace, kind: 'payslip' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'doc-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'doc-a'))?.kind).toBe('invoice');
  expect((await repo.list(otherWorkspace)).map((entry) => entry.id)).toEqual(['doc-a']);

  // 正常 / 異常: delete は削除前に存在したかを返し、他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'doc-a')).toBe(true);
  expect(await repo.delete(scope, 'doc-a')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect(await repo.findById(scope, 'doc-a')).toBeNull();
  expect(await repo.findById(otherWorkspace, 'doc-a')).toEqual(foreign);

  // 境界: 未知の id は null。空スコープの一覧は空配列。
  expect(await repo.findById(scope, 'missing')).toBeNull();
  expect(await repo.list({ tenantId: 'empty', workspaceId: 'empty' })).toEqual([]);

  // 境界: 保存した値は複製される（呼び出し側の参照経由で内部が壊れない）。
  const mutable = documentFixture('doc-mutable');
  await repo.save(mutable);
  const fetched = await repo.findById(scope, 'doc-mutable');
  expect(fetched).toEqual(mutable);
  expect(fetched).not.toBe(mutable);
  expect(fetched?.facts).not.toBe(mutable.facts);
  (fetched as { facts: { grandTotal: number } }).facts.grandTotal = 99;
  expect((await repo.findById(scope, 'doc-mutable'))?.facts.grandTotal).toBe(1100);
}
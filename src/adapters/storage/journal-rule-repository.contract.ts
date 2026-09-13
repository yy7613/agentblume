import { expect } from 'vitest';
import type { JournalRuleRepository } from '../../domain/journal/repositories';
import { otherTenant, otherWorkspace, ruleFixture, scope } from './journal-repository.fixtures';

/** JournalRuleRepository 実装が満たすべき共有契約。 */
export async function journalRuleRepositoryContract(repo: JournalRuleRepository): Promise<void> {
  // 正常: 条件・outcome・askIf・requiredFacts・provenance が欠けずに往復する。
  const rule = ruleFixture('rule-a');
  await repo.save(rule);
  const loaded = await repo.findById(scope, 'rule-a');
  expect(loaded).toEqual(rule);
  expect(loaded?.outcome.lines).toHaveLength(2);
  expect(loaded?.askIf[0]?.questionId).toBe('fixed_asset_check');
  expect(loaded?.provenance).toEqual({ origin: 'manual', exampleDocumentIds: ['doc-1'] });

  // 正常: 同 id の保存は上書き（版を持たない）。無効化も反映される。
  const disabled = ruleFixture('rule-a', { name: '改名', enabled: false, priority: 10, updatedAt: '2026-09-14T00:00:00.000Z' });
  await repo.save(disabled);
  expect(await repo.findById(scope, 'rule-a')).toEqual(disabled);
  expect((await repo.findById(scope, 'rule-a'))?.enabled).toBe(false);

  // 正常: 一覧は priority 降順 → createdAt 昇順 → id 昇順（判定の優先順と同じ）。
  await repo.save(ruleFixture('rule-high', { priority: 500 }));
  await repo.save(ruleFixture('rule-old', { priority: 100, createdAt: '2026-09-01T00:00:00.000Z' }));
  await repo.save(ruleFixture('rule-new', { priority: 100, createdAt: '2026-09-12T00:00:00.000Z' }));
  await repo.save(ruleFixture('a-tie', { priority: 100, createdAt: '2026-09-12T00:00:00.000Z' }));
  // priority 500 → priority 100（createdAt 昇順、同時刻は id 昇順）→ priority 10。
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['rule-high', 'rule-old', 'a-tie', 'rule-new', 'rule-a']);
  // 無効なルールも一覧には出る（判定側が enabled を見て外す。画面は無効も編集できる）。
  expect((await repo.list(scope)).some((entry) => !entry.enabled)).toBe(true);

  // 境界: 負の priority も整数として扱える（並びの末尾へ）。
  await repo.save(ruleFixture('rule-negative', { priority: -50 }));
  expect((await repo.list(scope)).at(-1)?.id).toBe('rule-negative');

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、同 id が共存できる。
  expect(await repo.findById(otherTenant, 'rule-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  const foreign = ruleFixture('rule-a', { tenant: otherWorkspace, name: '別ワークスペース' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'rule-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'rule-a'))?.name).toBe('改名');
  expect((await repo.list(otherWorkspace)).map((entry) => entry.id)).toEqual(['rule-a']);

  // 正常 / 異常: delete は削除前に存在したかを返し、他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'rule-a')).toBe(true);
  expect(await repo.delete(scope, 'rule-a')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect(await repo.findById(scope, 'rule-a')).toBeNull();
  expect(await repo.findById(otherWorkspace, 'rule-a')).toEqual(foreign);

  // 境界: 未知の id は null。空スコープの一覧は空配列。
  expect(await repo.findById(scope, 'missing')).toBeNull();
  expect(await repo.list({ tenantId: 'empty', workspaceId: 'empty' })).toEqual([]);

  // 境界: 保存した値は複製される（呼び出し側の参照経由で内部が壊れない）。
  const mutable = ruleFixture('rule-mutable');
  await repo.save(mutable);
  const fetched = await repo.findById(scope, 'rule-mutable');
  expect(fetched).toEqual(mutable);
  expect(fetched).not.toBe(mutable);
  expect(fetched?.conditions).not.toBe(mutable.conditions);
  (fetched as unknown as { conditions: { field: string }[] }).conditions[0]!.field = '書き換え';
  expect((await repo.findById(scope, 'rule-mutable'))?.conditions[0]?.field).toBe('descriptionNorm');
}
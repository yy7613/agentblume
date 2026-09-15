import { expect } from 'vitest';
import type { ContractPlaybookRepository } from '../../domain/contract/repositories';
import { otherTenant, otherWorkspace, playbookFixture, scope } from './contract-repository.fixtures';

/** ContractPlaybookRepository 実装が満たすべき共有契約。 */
export async function contractPlaybookRepositoryContract(repo: ContractPlaybookRepository): Promise<void> {
  // 正常: トピック・基準・法令設定・印紙税表まで欠けずに往復する。
  const first = playbookFixture('pb-b', { isDefault: true, createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' });
  await repo.save(first);
  expect(await repo.findById(scope, 'pb-b')).toEqual(first);

  // 正常: 同 id の保存は上書き。
  const renamed = playbookFixture('pb-b', { name: '改名した基準', isDefault: false, createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T05:00:00.000Z' });
  await repo.save(renamed);
  expect(await repo.findById(scope, 'pb-b')).toEqual(renamed);

  // 正常: 一覧は作成の古い順（createdAt 昇順）、同時刻は id 昇順。updatedAt は並びに効かない。
  await repo.save(playbookFixture('pb-c', { createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }));
  await repo.save(playbookFixture('pb-a', { createdAt: '2026-09-13T02:00:00.000Z', updatedAt: '2026-09-13T02:00:00.000Z' }));
  expect((await repo.list(scope)).map((playbook) => playbook.id)).toEqual(['pb-c', 'pb-a', 'pb-b']);

  // 境界: テナント / ワークスペース分離。同 id が共存できる。
  expect(await repo.findById(otherTenant, 'pb-a')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  const foreign = playbookFixture('pb-a', { tenant: otherWorkspace, name: '別ワークスペース' });
  await repo.save(foreign);
  expect(await repo.findById(otherWorkspace, 'pb-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'pb-a'))?.name).not.toBe('別ワークスペース');

  // 正常 / 異常: delete は削除前に存在したかを返し、他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'pb-a')).toBe(true);
  expect(await repo.delete(scope, 'pb-a')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect(await repo.findById(otherWorkspace, 'pb-a')).toEqual(foreign);
  expect(await repo.findById(scope, 'missing')).toBeNull();

  // 境界: 読み出した値は複製（呼び出し側の変更が保存値へ漏れない）。
  const fetched = await repo.findById(scope, 'pb-c');
  expect(fetched).not.toBeNull();
  (fetched!.topics as unknown as { label: string }[])[0]!.label = '書き換え';
  expect((await repo.findById(scope, 'pb-c'))?.topics[0]?.label).toBe('契約期間');
  const listed = await repo.list(scope);
  (listed[0]!.topics as unknown as { label: string }[])[0]!.label = '書き換え';
  expect((await repo.list(scope))[0]?.topics[0]?.label).toBe('契約期間');
}

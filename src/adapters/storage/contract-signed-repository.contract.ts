import { expect } from 'vitest';
import type { SignedContractRepository } from '../../domain/contract/repositories';
import { deadlinesFixture, otherTenant, otherWorkspace, scope, signedContractFixture } from './contract-repository.fixtures';

/** SignedContractRepository 実装が満たすべき共有契約（期限の投影を含む）。 */
export async function contractSignedRepositoryContract(repo: SignedContractRepository): Promise<void> {
  // 正常: 条項の写し・期限・判断・印紙税が欠けずに往復し、文書からも引ける。
  const first = signedContractFixture('sc-b', { signedDate: '2026-03-15', stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: null } });
  await repo.save(first);
  expect(await repo.findById(scope, 'sc-b')).toEqual(first);
  expect(await repo.findByDocument(scope, 'doc-sc-b')).toEqual(first);
  expect(await repo.findByDocument(scope, 'missing')).toBeNull();

  // 正常: 一覧は締結日の新しい順、同日は id 昇順。
  await repo.save(signedContractFixture('sc-c', { signedDate: '2026-05-01', counterpartyName: 'Example 100% Holdings' }));
  await repo.save(signedContractFixture('sc-a', { signedDate: '2026-03-15', status: 'terminated', terminatedAt: '2026-08-01', deadlines: deadlinesFixture().map((deadline) => ({ ...deadline, status: 'superseded' as const })) }));
  expect((await repo.list(scope)).map((contract) => contract.id)).toEqual(['sc-c', 'sc-a', 'sc-b']);

  // 正常 / 境界: status と相手方名の部分一致（大文字小文字を区別しない。% は LIKE の記号として解釈しない）。
  expect((await repo.list(scope, { status: 'terminated' })).map((contract) => contract.id)).toEqual(['sc-a']);
  expect((await repo.list(scope, { counterparty: 'テック' })).map((contract) => contract.id)).toEqual(['sc-a', 'sc-b']);
  expect((await repo.list(scope, { counterparty: 'example' })).map((contract) => contract.id)).toEqual(['sc-c']);
  expect((await repo.list(scope, { counterparty: '100%' })).map((contract) => contract.id)).toEqual(['sc-c']);
  expect((await repo.list(scope, { counterparty: '%' })).map((contract) => contract.id)).toEqual(['sc-c']);
  expect((await repo.list(scope, { counterparty: '' })).map((contract) => contract.id)).toEqual(['sc-c', 'sc-a', 'sc-b']);
  expect(await repo.list(scope, { status: 'active', counterparty: '存在しない' })).toEqual([]);

  // 正常: 未完了の期限だけを期限日の昇順 → 契約 id → 期限 id で返す（superseded の sc-a は出ない）。
  expect(await repo.listOpenDeadlines(scope)).toEqual([
    { contractId: 'sc-b', deadlineId: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-12-31' },
    { contractId: 'sc-c', deadlineId: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-12-31' },
    { contractId: 'sc-b', deadlineId: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31' },
    { contractId: 'sc-c', deadlineId: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31' },
    { contractId: 'sc-b', deadlineId: 'renewal-1', kind: 'renewal', dueDate: '2027-04-01' },
    { contractId: 'sc-c', deadlineId: 'renewal-1', kind: 'renewal', dueDate: '2027-04-01' },
  ]);
  // 境界: dueOnOrBefore は当日を含む。
  expect((await repo.listOpenDeadlines(scope, { dueOnOrBefore: '2027-03-31' })).map((row) => `${row.contractId}/${row.deadlineId}`))
    .toEqual(['sc-b/renewal_notice-1', 'sc-c/renewal_notice-1', 'sc-b/expiry-1', 'sc-c/expiry-1']);
  expect(await repo.listOpenDeadlines(scope, { dueOnOrBefore: '2026-12-30' })).toEqual([]);

  // 正常: 保存し直すと投影も入れ替わる（完了した期限は消え、足した期限が出る）。
  const updated = signedContractFixture('sc-b', {
    signedDate: '2026-03-15',
    deadlines: [
      { ...deadlinesFixture()[0]!, status: 'done', completedAt: '2026-11-01T00:00:00.000Z' },
      deadlinesFixture()[1]!,
      { id: 'custom-1', kind: 'custom', dueDate: '2026-10-01', basis: '報告書の提出', status: 'open' },
    ],
  });
  await repo.save(updated);
  expect((await repo.listOpenDeadlines(scope)).filter((row) => row.contractId === 'sc-b')).toEqual([
    { contractId: 'sc-b', deadlineId: 'custom-1', kind: 'custom', dueDate: '2026-10-01' },
    { contractId: 'sc-b', deadlineId: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31' },
  ]);

  // 異常: 1 文書 1 契約。別 id で同じ文書を保存すると失敗し、元の契約は残る。同 id の上書きは通る。
  await expect(repo.save(signedContractFixture('sc-dup', { documentId: 'doc-sc-b' }))).rejects.toThrow(/UNIQUE/u);
  expect(await repo.findById(scope, 'sc-dup')).toBeNull();
  expect((await repo.findByDocument(scope, 'doc-sc-b'))?.id).toBe('sc-b');
  // 別スコープなら同じ文書 id でも衝突しない。
  const foreign = signedContractFixture('sc-foreign', { tenant: otherWorkspace, documentId: 'doc-sc-b' });
  await repo.save(foreign);
  expect(await repo.findByDocument(otherWorkspace, 'doc-sc-b')).toEqual(foreign);

  // 境界: スコープ分離（一覧・期限にも他スコープは出ない）。
  expect(await repo.findById(otherTenant, 'sc-b')).toBeNull();
  expect(await repo.findByDocument(otherTenant, 'doc-sc-b')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  expect(await repo.listOpenDeadlines(otherTenant)).toEqual([]);
  expect((await repo.listOpenDeadlines(otherWorkspace)).map((row) => row.contractId)).toEqual(['sc-foreign', 'sc-foreign', 'sc-foreign']);

  // 正常 / 異常: delete は戻り値を返し、投影も一緒に消える。他スコープには触れない。
  expect(await repo.delete(scope, 'sc-c')).toBe(true);
  expect(await repo.delete(scope, 'sc-c')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect((await repo.listOpenDeadlines(scope)).some((row) => row.contractId === 'sc-c')).toBe(false);
  expect(await repo.findById(otherWorkspace, 'sc-foreign')).toEqual(foreign);

  // 境界: 読み出した値は複製。
  const fetched = await repo.findById(scope, 'sc-b');
  (fetched!.deadlines as unknown as { basis: string }[])[0]!.basis = '書き換え';
  expect((await repo.findById(scope, 'sc-b'))?.deadlines[0]?.basis).not.toBe('書き換え');
}

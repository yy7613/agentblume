import { expect } from 'vitest';
import { defaultReceivablesSettings } from '../../domain/receivables/settings';
import type {
  BankCsvProfileRepository, BankTransactionRepository, CustomerRepository, InvoiceRepository, MatchingRepository, ReceivablesSettingsRepository,
} from '../../domain/receivables/repositories';
import { AT, customerFixture, invoiceFixture, issuedInvoiceFixture, matchingFixture, otherWorkspace, profileFixture, scope, transactionFixture } from './receivables-repository.fixtures';

/** ReceivablesSettingsRepository の共有契約。 */
export async function receivablesSettingsRepositoryContract(repo: ReceivablesSettingsRepository): Promise<void> {
  // 境界: 保存したことが無ければ null（application が初期値を返す）。
  expect(await repo.get(scope)).toBeNull();
  const settings = { ...defaultReceivablesSettings(AT), issuer: { name: 'サンプル', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [{ bankName: '銀行', branchName: '本店', accountType: '普通', accountNumber: '1234567', holderKana: 'サンプル' }] } };
  await repo.save(scope, settings);
  expect(await repo.get(scope)).toEqual(settings);
  // 正常: 上書き。別ワークスペースとは独立。
  await repo.save(scope, { ...settings, matching: { ...settings.matching, maxCombinationSize: 5 } });
  expect((await repo.get(scope))?.matching.maxCombinationSize).toBe(5);
  expect(await repo.get(otherWorkspace)).toBeNull();
}

/** CustomerRepository の共有契約。 */
export async function customerRepositoryContract(repo: CustomerRepository): Promise<void> {
  const customer = customerFixture('c-b', { name: 'B 商事' });
  await repo.save(customer);
  expect(await repo.findById(scope, 'c-b')).toEqual(customer);
  await repo.save(customerFixture('c-a', { name: 'A 商事', enabled: false }));
  await repo.save(customerFixture('c-c', { name: 'A 商事' }));
  // 正常: 名前 昇順 → id 昇順。有効 / 無効で絞れる。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['c-a', 'c-c', 'c-b']);
  expect((await repo.list(scope, { enabled: true })).map((item) => item.id)).toEqual(['c-c', 'c-b']);
  expect((await repo.list(scope, { enabled: false })).map((item) => item.id)).toEqual(['c-a']);
  // 境界: 別ワークスペースからは見えない。削除は存在したかを返す。
  expect(await repo.findById(otherWorkspace, 'c-b')).toBeNull();
  expect(await repo.delete(scope, 'c-b')).toBe(true);
  expect(await repo.delete(scope, 'c-b')).toBe(false);
  // 境界: 保存した値は複製される。
  const fetched = await repo.findById(scope, 'c-a');
  (fetched as unknown as { name: string }).name = 'changed';
  expect((await repo.findById(scope, 'c-a'))?.name).toBe('A 商事');
}

/** InvoiceRepository の共有契約。 */
export async function invoiceRepositoryContract(repo: InvoiceRepository): Promise<void> {
  const draft = invoiceFixture('i-draft', { createdAt: '2026-09-01T00:00:00.000Z', customerId: 'c-2', issueDate: undefined });
  await repo.save(draft);
  expect(await repo.findById(scope, 'i-draft')).toEqual(draft);
  // 境界: 下書きは番号が無いので何件でも保存できる（部分一意索引）。
  await repo.save(invoiceFixture('i-draft-2', { createdAt: '2026-09-02T00:00:00.000Z' }));
  const issued = issuedInvoiceFixture('i-1', 'INV-2026-0001', { createdAt: '2026-09-03T00:00:00.000Z', dueDate: '2026-09-20' });
  await repo.save(issued);
  expect(await repo.findById(scope, 'i-1')).toEqual(issued);
  // 異常: 発行済みの番号が重なれば一意違反で失敗する（自分自身の上書きは可）。
  await expect(repo.save(issuedInvoiceFixture('i-dup', 'INV-2026-0001'))).rejects.toThrow(/UNIQUE/);
  await repo.save({ ...issued, updatedAt: '2026-09-04T00:00:00.000Z' });
  // 境界: 別ワークスペースなら同じ番号を使える。
  await repo.save({ ...issuedInvoiceFixture('i-1', 'INV-2026-0001'), tenant: otherWorkspace });

  // 正常: 作成日時 降順 → id 昇順。状態・取引先・発行日の範囲・期日超過で絞れる。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['i-1', 'i-draft-2', 'i-draft']);
  expect((await repo.list(scope, { statuses: ['issued'] })).map((item) => item.id)).toEqual(['i-1']);
  expect(await repo.list(scope, { statuses: [] })).toEqual([]);
  expect((await repo.list(scope, { customerId: 'c-2' })).map((item) => item.id)).toEqual(['i-draft']);
  expect((await repo.list(scope, { from: '2026-09-10', to: '2026-09-10' })).map((item) => item.id)).toEqual(['i-1', 'i-draft-2']);
  expect((await repo.list(scope, { dueBefore: '2026-09-21' })).map((item) => item.id)).toEqual(['i-1']);
  expect(await repo.list(scope, { dueBefore: '2026-09-20' })).toEqual([]);
  expect((await repo.findByIds(scope, ['missing', 'i-draft', 'i-1'])).map((item) => item.id)).toEqual(['i-draft', 'i-1']);

  // 正常: 連番は系列ごとに 1 から進み、ワークスペースで独立。
  expect(await repo.nextNumber(scope, 'INV-2026-{SEQ4}')).toBe(1);
  expect(await repo.nextNumber(scope, 'INV-2026-{SEQ4}')).toBe(2);
  expect(await repo.nextNumber(scope, 'INV-2027-{SEQ4}')).toBe(1);
  expect(await repo.nextNumber(otherWorkspace, 'INV-2026-{SEQ4}')).toBe(1);

  expect(await repo.delete(scope, 'i-draft')).toBe(true);
  expect(await repo.delete(scope, 'i-draft')).toBe(false);
  expect(await repo.findById(scope, 'i-draft')).toBeNull();
}

/** BankCsvProfileRepository の共有契約。 */
export async function bankCsvProfileRepositoryContract(repo: BankCsvProfileRepository): Promise<void> {
  const profile = profileFixture('p-1');
  await repo.save(profile);
  expect(await repo.findById(scope, 'p-1')).toEqual(profile);
  await repo.save(profileFixture('p-2', { updatedAt: '2026-09-20T00:00:00.000Z' }));
  await repo.save(profileFixture('p-0'));
  // 正常: 更新日時 降順 → id 昇順（新しいプロファイルを先に当てる）。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['p-2', 'p-0', 'p-1']);
  expect(await repo.list(otherWorkspace)).toEqual([]);
  expect(await repo.delete(scope, 'p-2')).toBe(true);
  expect(await repo.delete(scope, 'p-2')).toBe(false);
}

/** BankTransactionRepository の共有契約。 */
export async function bankTransactionRepositoryContract(repo: BankTransactionRepository): Promise<void> {
  const transaction = transactionFixture('tx-b');
  await repo.save(transaction);
  expect(await repo.findById(scope, 'tx-b')).toEqual(transaction);
  await repo.save(transactionFixture('tx-a', { date: '2026-09-01', accountKey: 'sub' }));
  await repo.save(transactionFixture('tx-c', { status: 'ignored', ignoredNote: '利息', judgment: undefined }));
  // 異常: 同じ指紋は一意違反で失敗する（重複取込の最後の砦）。自分自身の上書きは可。
  await expect(repo.save(transactionFixture('tx-dup', { fingerprint: 'fp-tx-b' }))).rejects.toThrow(/UNIQUE/);
  await repo.save({ ...transaction, updatedAt: '2026-10-01T00:00:00.000Z' });
  await repo.save({ ...transactionFixture('tx-b'), tenant: otherWorkspace });

  expect([...(await repo.findByFingerprints(scope, ['fp-tx-a', 'fp-tx-b', 'fp-missing', 'fp-tx-a']))].sort()).toEqual([['fp-tx-a', 'tx-a'], ['fp-tx-b', 'tx-b']]);
  // 正常: 入金日 昇順 → 作成日時 → id。状態・口座・日付範囲・id・件数で絞れる。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['tx-a', 'tx-b', 'tx-c']);
  expect((await repo.list(scope, { status: 'unmatched' })).map((item) => item.id)).toEqual(['tx-a', 'tx-b']);
  expect((await repo.list(scope, { accountKey: 'sub' })).map((item) => item.id)).toEqual(['tx-a']);
  expect((await repo.list(scope, { from: '2026-09-30', to: '2026-09-30' })).map((item) => item.id)).toEqual(['tx-b', 'tx-c']);
  expect((await repo.list(scope, { ids: ['tx-c', 'tx-a'] })).map((item) => item.id)).toEqual(['tx-a', 'tx-c']);
  expect(await repo.list(scope, { ids: [] })).toEqual([]);
  expect((await repo.list(scope, { limit: 1 })).map((item) => item.id)).toEqual(['tx-a']);
  expect(await repo.delete(scope, 'tx-a')).toBe(true);
  expect(await repo.delete(scope, 'tx-a')).toBe(false);
  expect(await repo.findById(scope, 'tx-a')).toBeNull();
}

/** MatchingRepository の共有契約。 */
export async function matchingRepositoryContract(repo: MatchingRepository): Promise<void> {
  const matching = matchingFixture('m-1');
  await repo.save(matching);
  expect(await repo.findById(scope, 'm-1')).toEqual(matching);
  await repo.save(matchingFixture('m-2', { transactionId: 'tx-2', transactionAmount: 10_000, allocations: [{ invoiceId: 'i-3', amount: 10_000 }], feeAmount: 0, confirmedAt: '2026-09-20T00:00:00.000Z' }));
  // 正常: 確定日時 降順 → id。請求からの逆引き・明細・状態で絞れる。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['m-2', 'm-1']);
  expect((await repo.list(scope, { invoiceId: 'i-2' })).map((item) => item.id)).toEqual(['m-1']);
  expect((await repo.list(scope, { transactionId: 'tx-2' })).map((item) => item.id)).toEqual(['m-2']);
  // 正常: 取消の上書きが状態の絞り込みに反映され、配分を差し替えても逆引きが追従する。
  await repo.save({ ...matching, status: 'cancelled', cancelledAt: AT });
  expect((await repo.list(scope, { status: 'confirmed' })).map((item) => item.id)).toEqual(['m-2']);
  await repo.save(matchingFixture('m-2', { transactionId: 'tx-2', transactionAmount: 10_000, allocations: [{ invoiceId: 'i-4', amount: 10_000 }], feeAmount: 0, confirmedAt: '2026-09-20T00:00:00.000Z' }));
  expect(await repo.list(scope, { invoiceId: 'i-3' })).toEqual([]);
  expect((await repo.list(scope, { invoiceId: 'i-4' })).map((item) => item.id)).toEqual(['m-2']);
  expect(await repo.list(otherWorkspace)).toEqual([]);
  expect(await repo.findById(scope, 'missing')).toBeNull();
}

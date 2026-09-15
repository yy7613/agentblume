import { expect } from 'vitest';
import type { ApprovalFlow } from '../../domain/expense/approval';
import { payeeKeyOf } from '../../domain/expense/duplicates';
import type { ExpenseClaimRepository } from '../../domain/expense/repositories';
import { AT, claimFixture, itemFixture, otherTenant, otherWorkspace, scope, SHA_A, SHA_B } from './expense-repository.fixtures';

const judgment = {
  verdict: 'needs-review' as const,
  items: [{ itemId: 'item-1', verdict: 'needs-review' as const, reasons: [{ code: 'payee-missing' as const, severity: 'review' as const, itemId: 'item-1', params: { description: 'x' } }] }],
  claimReasons: [],
  totals: { amount: 3200, byCategory: [{ categoryId: 'transport.taxi', amount: 3200 }] },
  searchKeysComplete: false,
  policyUpdatedAt: AT,
  itemsFingerprint: 'fingerprint',
  checkedAt: AT,
};

/** ExpenseClaimRepository 実装が満たすべき共有契約。 */
export async function expenseClaimRepositoryContract(repo: ExpenseClaimRepository): Promise<void> {
  // 正常: 明細・申請者・履歴が欠けずに往復する。
  const first = claimFixture('claim-a', { createdAt: '2026-09-14T03:00:00.000Z', updatedAt: '2026-09-14T03:00:00.000Z' });
  await repo.save(first, new Map([['item-1', SHA_A]]));
  expect(await repo.findById(scope, 'claim-a')).toEqual(first);

  // 正常: 同 id の保存は上書き。判定も残る。
  const checked = claimFixture('claim-a', { status: 'checked', judgment, createdAt: '2026-09-14T03:00:00.000Z', updatedAt: '2026-09-14T04:00:00.000Z' });
  await repo.save(checked, new Map([['item-1', SHA_A]]));
  expect((await repo.findById(scope, 'claim-a'))?.judgment?.verdict).toBe('needs-review');

  // 正常: 一覧は新しいものが先、同時刻は id 昇順。要約は明細の中身を持たない。
  await repo.save(claimFixture('claim-b', { claimant: { name: 'テスト 花子' }, items: [itemFixture('item-1', { amount: 1500 })], period: { from: '2026-08-01', to: '2026-08-31' }, createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T02:00:00.000Z' }), new Map());
  await repo.save(claimFixture('claim-c', { claimant: { name: 'テスト次郎' }, items: [], period: { from: '2026-10-01', to: '2026-10-31' }, createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T02:00:00.000Z' }), new Map());
  const summaries = await repo.list(scope);
  expect(summaries.map((summary) => summary.id)).toEqual(['claim-a', 'claim-b', 'claim-c']);
  expect(summaries[0]).toMatchObject({ id: 'claim-a', status: 'checked', verdict: 'needs-review', itemCount: 1, totalAmount: 3200, claimant: { name: 'テスト太郎' } });
  expect(summaries[0]).not.toHaveProperty('items');

  // 正常: 状態・判定・申請者（部分一致・空白や大小を無視）・期間の重なりで絞る。limit は並べ替えの後。
  expect((await repo.list(scope, { status: 'checked' })).map((summary) => summary.id)).toEqual(['claim-a']);
  expect((await repo.list(scope, { verdict: 'needs-review' })).map((summary) => summary.id)).toEqual(['claim-a']);
  expect((await repo.list(scope, { claimant: '花子' })).map((summary) => summary.id)).toEqual(['claim-b']);
  expect((await repo.list(scope, { claimant: 'テスト花子' })).map((summary) => summary.id)).toEqual(['claim-b']);
  expect((await repo.list(scope, { claimant: '%' })).map((summary) => summary.id)).toEqual([]);
  expect((await repo.list(scope, { from: '2026-08-31', to: '2026-09-01' })).map((summary) => summary.id)).toEqual(['claim-a', 'claim-b']);
  expect((await repo.list(scope, { from: '2026-10-31' })).map((summary) => summary.id)).toEqual(['claim-c']);
  expect((await repo.list(scope, { to: '2026-07-31' })).map((summary) => summary.id)).toEqual([]);
  expect((await repo.list(scope, { limit: 1 })).map((summary) => summary.id)).toEqual(['claim-a']);

  // 正常 / 境界: findByIds は ids の順で見つかったものだけ。
  expect((await repo.findByIds(scope, ['claim-c', 'missing', 'claim-a'])).map((claim) => claim.id)).toEqual(['claim-c', 'claim-a']);
  expect(await repo.findByIds(scope, [])).toEqual([]);

  // 正常: 重複候補は 取引日 × 金額 または画像ハッシュで引け、自分の申請は含まない。相手の状態と申請者名を持つ。
  await repo.save(claimFixture('claim-d', { items: [itemFixture('item-9', { amount: 3200 }), itemFixture('item-2', { amount: 999, transactionDate: '2026-09-11' })], createdAt: '2026-09-14T05:00:00.000Z', updatedAt: '2026-09-14T05:00:00.000Z' }), new Map([['item-2', SHA_B]]));
  const byKey = await repo.findDuplicateCandidates(scope, { keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [], excludeClaimId: 'claim-b' });
  expect(byKey.map((candidate) => `${candidate.claimId}/${candidate.itemId}`)).toEqual(['claim-a/item-1', 'claim-d/item-9']);
  expect(byKey[0]).toMatchObject({ claimStatus: 'checked', claimantName: 'テスト太郎', payeeKey: 'サンプル交通', categoryId: 'transport.taxi', receiptSha256: SHA_A, transactionDate: '2026-09-10', amount: 3200 });
  expect((await repo.findDuplicateCandidates(scope, { keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [], excludeClaimId: 'claim-a' })).map((candidate) => candidate.claimId)).toEqual(['claim-d']);
  expect((await repo.findDuplicateCandidates(scope, { keys: [], sha256s: [SHA_B] })).map((candidate) => candidate.itemId)).toEqual(['item-2']);
  expect(await repo.findDuplicateCandidates(scope, { keys: [], sha256s: [] })).toEqual([]);
  expect(await repo.findDuplicateCandidates(scope, { keys: [{ transactionDate: '2026-09-10', amount: 3201 }], sha256s: [] })).toEqual([]);

  // 正常: 保存で索引が入れ直される（金額を直した明細は古い鍵で引けない）。
  await repo.save(claimFixture('claim-d', { items: [itemFixture('item-9', { amount: 4000 })], createdAt: '2026-09-14T05:00:00.000Z', updatedAt: '2026-09-14T06:00:00.000Z' }), new Map());
  expect((await repo.findDuplicateCandidates(scope, { keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [SHA_B] })).map((candidate) => candidate.claimId)).toEqual(['claim-a']);

  // 境界: テナント / ワークスペース分離。
  expect(await repo.findById(otherTenant, 'claim-a')).toBeNull();
  expect(await repo.list(otherWorkspace)).toEqual([]);
  expect(await repo.findDuplicateCandidates(otherTenant, { keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [SHA_A] })).toEqual([]);
  const foreign = claimFixture('claim-a', { tenant: otherWorkspace });
  await repo.save(foreign, new Map());
  expect(await repo.findById(otherWorkspace, 'claim-a')).toEqual(foreign);
  expect((await repo.findById(scope, 'claim-a'))?.status).toBe('checked');

  // 正常 / 異常: delete は削除前に存在したかを返し、索引も消える。他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'claim-a')).toBe(true);
  expect(await repo.delete(scope, 'claim-a')).toBe(false);
  expect(await repo.findById(scope, 'claim-a')).toBeNull();
  expect(await repo.findDuplicateCandidates(scope, { keys: [{ transactionDate: '2026-09-10', amount: 3200 }], sha256s: [SHA_A] })).toEqual([]);
  expect(await repo.findById(otherWorkspace, 'claim-a')).toEqual(foreign);

  // 境界: 保存した値は複製される。
  const mutable = claimFixture('claim-m');
  await repo.save(mutable, new Map());
  const fetched = await repo.findById(scope, 'claim-m');
  expect(fetched).not.toBe(mutable);
  (fetched as { claimant: { name: string } }).claimant.name = '書き換え';
  expect((await repo.findById(scope, 'claim-m'))?.claimant.name).toBe('テスト太郎');
}

const APPROVED_AT = '2026-09-16T02:00:00.000Z';
const SETTLED_AT = '2026-09-17T03:00:00.000Z';
const MART = 'サンプルマート 霞が関店';

/** 2 段の経路の 2 段目（経理グループ）で止まっている承認の記録。 */
function twoStepFlow(): ApprovalFlow {
  return {
    routeId: 'route-two-steps', routeName: '2 段承認', resolvedAt: '2026-09-15T00:00:00.000Z', policyUpdatedAt: AT,
    steps: [
      { stepId: 'manager', name: '上長', approverKind: 'claimant-manager', approvers: [{ employeeId: 'emp-hanako', name: 'テスト花子' }], status: 'approved', decision: { by: 'hanako@example.com', employeeId: 'emp-hanako', at: '2026-09-15T01:00:00.000Z', proxy: false } },
      { stepId: 'accounting', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'emp-jiro', name: 'テスト次郎' }, { employeeId: 'emp-saburo', name: 'テスト三郎' }], status: 'pending' },
    ],
    currentIndex: 1,
  };
}

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);
const itemRefs = (rows: readonly { readonly claimId: string; readonly itemId: string }[]): string[] => rows.map((row) => `${row.claimId}/${row.itemId}`);

/**
 * 実用化の派生索引（docs/21 §20.8）の共有契約: 保存で入れ直した索引から、新しい一覧の条件・集計の入力・カード照合の候補が引ける。
 * MVP の契約と状態を混ぜないよう、空のリポジトリに対して別に流す。
 */
export async function expenseClaimDerivedIndexContract(repo: ExpenseClaimRepository): Promise<void> {
  // 承認済み（従業員・部門・仮払に紐付く。会社払い・日付なし・0 円の明細を含む）。
  await repo.save(claimFixture('dx-a', {
    status: 'approved', approval: { by: 'shonin@example.com', at: APPROVED_AT }, advanceId: 'adv-1',
    claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' },
    items: [
      itemFixture('i1'),
      itemFixture('i2', { transactionDate: '2026-09-11', amount: 1980, payeeName: MART, corporatePayment: true }, { categoryId: 'meal.meeting' }),
      itemFixture('i3', { transactionDate: undefined, amount: 500 }),
      itemFixture('i4', { transactionDate: '2026-09-12', amount: 0 }),
    ],
    createdAt: '2026-09-14T03:00:00.000Z', updatedAt: '2026-09-14T03:00:00.000Z',
  }), new Map());
  // 承認中（2 段目の承認者。重複して渡っても 1 人として持つ）。支払先が無い明細。
  await repo.save(claimFixture('dx-b', {
    status: 'in-approval', approvalFlow: twoStepFlow(),
    claimant: { name: 'テスト花子', department: '営業部', employeeId: 'emp-hanako', departmentId: 'dept-sales' },
    items: [itemFixture('i1', { payeeName: undefined })],
    createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T02:00:00.000Z',
  }), new Map(), ['emp-jiro', 'emp-saburo', 'emp-jiro']);
  // 精算済み・振込バッチ入り・従業員に紐付かない。
  await repo.save(claimFixture('dx-c', {
    status: 'settled', approval: { by: 'shonin@example.com', at: APPROVED_AT }, settlement: { settledAt: SETTLED_AT, by: 'keiri@example.com' },
    payout: { batchId: 'batch-1', exportedAt: '2026-09-16T05:00:00.000Z' },
    claimant: { name: 'テスト次郎' }, items: [itemFixture('i1', { transactionDate: '2026-09-20', amount: 4000 })],
    createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z',
  }), new Map());
  // 下書き・明細なし・紐付かない。
  await repo.save(claimFixture('dx-d', { claimant: { name: 'テスト三郎' }, items: [], createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }), new Map());

  // 正常: 状態の複数指定（status と両方あれば両方を満たす）。空の配列は絞らない。
  expect(ids(await repo.list(scope, { statuses: ['approved', 'settled'] }))).toEqual(['dx-a', 'dx-c']);
  expect(ids(await repo.list(scope, { status: 'approved', statuses: ['approved', 'settled'] }))).toEqual(['dx-a']);
  expect(ids(await repo.list(scope, { status: 'draft', statuses: ['approved'] }))).toEqual([]);
  expect(ids(await repo.list(scope, { statuses: [] }))).toEqual(['dx-a', 'dx-b', 'dx-c', 'dx-d']);

  // 正常: 従業員・部門・仮払・承認待ち・未紐付けで絞る（組み合わせは AND、limit は並べ替えの後）。
  expect(ids(await repo.list(scope, { employeeId: 'emp-taro' }))).toEqual(['dx-a']);
  expect(ids(await repo.list(scope, { departmentId: 'dept-sales' }))).toEqual(['dx-a', 'dx-b']);
  expect(ids(await repo.list(scope, { employeeId: 'emp-taro', departmentId: 'dept-admin' }))).toEqual([]);
  expect(ids(await repo.list(scope, { advanceId: 'adv-1' }))).toEqual(['dx-a']);
  expect(ids(await repo.list(scope, { advanceId: 'adv-2' }))).toEqual([]);
  expect(ids(await repo.list(scope, { awaitingEmployeeId: 'emp-saburo' }))).toEqual(['dx-b']);
  expect(ids(await repo.list(scope, { awaitingEmployeeId: 'emp-jiro' }))).toEqual(['dx-b']);
  expect(ids(await repo.list(scope, { awaitingEmployeeId: 'emp-taro' }))).toEqual([]);
  expect(ids(await repo.list(scope, { unlinked: true }))).toEqual(['dx-c', 'dx-d']);
  expect(ids(await repo.list(scope, { unlinked: false }))).toEqual(['dx-a', 'dx-b', 'dx-c', 'dx-d']);
  expect(ids(await repo.list(scope, { unlinked: true, statuses: ['settled', 'draft'], limit: 1 }))).toEqual(['dx-c']);

  // 正常: 集計の入力は claim_id → item_id の昇順。値の無い欄は持たない。金額 0 の明細も行になる。
  expect(await repo.listItemFacts(scope, { limit: 100 })).toEqual([
    { claimId: 'dx-a', itemId: 'i1', status: 'approved', transactionDate: '2026-09-10', amount: 3200, categoryId: 'transport.taxi', corporate: false, employeeId: 'emp-taro', departmentId: 'dept-sales', claimantName: 'テスト太郎', departmentText: '営業部', approvedAt: APPROVED_AT },
    { claimId: 'dx-a', itemId: 'i2', status: 'approved', transactionDate: '2026-09-11', amount: 1980, categoryId: 'meal.meeting', corporate: true, employeeId: 'emp-taro', departmentId: 'dept-sales', claimantName: 'テスト太郎', departmentText: '営業部', approvedAt: APPROVED_AT },
    { claimId: 'dx-a', itemId: 'i3', status: 'approved', amount: 500, categoryId: 'transport.taxi', corporate: false, employeeId: 'emp-taro', departmentId: 'dept-sales', claimantName: 'テスト太郎', departmentText: '営業部', approvedAt: APPROVED_AT },
    { claimId: 'dx-a', itemId: 'i4', status: 'approved', transactionDate: '2026-09-12', amount: 0, categoryId: 'transport.taxi', corporate: false, employeeId: 'emp-taro', departmentId: 'dept-sales', claimantName: 'テスト太郎', departmentText: '営業部', approvedAt: APPROVED_AT },
    { claimId: 'dx-b', itemId: 'i1', status: 'in-approval', transactionDate: '2026-09-10', amount: 3200, categoryId: 'transport.taxi', corporate: false, employeeId: 'emp-hanako', departmentId: 'dept-sales', claimantName: 'テスト花子', departmentText: '営業部' },
    { claimId: 'dx-c', itemId: 'i1', status: 'settled', transactionDate: '2026-09-20', amount: 4000, categoryId: 'transport.taxi', corporate: false, claimantName: 'テスト次郎', approvedAt: APPROVED_AT, settledAt: SETTLED_AT },
  ]);
  // 正常 / 境界: 範囲は両端を含み、値の無い行は範囲を指定すると外れる。limit は並べ替えの後。
  expect(itemRefs(await repo.listItemFacts(scope, { transactionFrom: '2026-09-11', transactionTo: '2026-09-12', limit: 100 }))).toEqual(['dx-a/i2', 'dx-a/i4']);
  expect(itemRefs(await repo.listItemFacts(scope, { approvedFrom: APPROVED_AT, limit: 100 }))).toEqual(['dx-a/i1', 'dx-a/i2', 'dx-a/i3', 'dx-a/i4', 'dx-c/i1']);
  expect(await repo.listItemFacts(scope, { approvedTo: '2026-09-16T01:59:59.999Z', limit: 100 })).toEqual([]);
  expect(itemRefs(await repo.listItemFacts(scope, { settledFrom: SETTLED_AT, settledTo: SETTLED_AT, limit: 100 }))).toEqual(['dx-c/i1']);
  expect(itemRefs(await repo.listItemFacts(scope, { statuses: ['in-approval'], limit: 100 }))).toEqual(['dx-b/i1']);
  expect(await repo.listItemFacts(scope, { statuses: [], limit: 100 })).toHaveLength(6);
  expect(itemRefs(await repo.listItemFacts(scope, { limit: 2 }))).toEqual(['dx-a/i1', 'dx-a/i2']);

  // 正常: カード照合の候補は取引日と 1 円以上の金額がある明細（取引日 → claim_id → item_id）。
  const september = await repo.findCardCandidates(scope, { from: '2026-09-10', to: '2026-09-12', amounts: [] });
  expect(september).toEqual([
    { claimId: 'dx-a', itemId: 'i1', claimStatus: 'approved', employeeId: 'emp-taro', transactionDate: '2026-09-10', amount: 3200, payeeKey: 'サンプル交通', corporate: false },
    { claimId: 'dx-b', itemId: 'i1', claimStatus: 'in-approval', employeeId: 'emp-hanako', transactionDate: '2026-09-10', amount: 3200, corporate: false },
    { claimId: 'dx-a', itemId: 'i2', claimStatus: 'approved', employeeId: 'emp-taro', transactionDate: '2026-09-11', amount: 1980, payeeKey: payeeKeyOf(MART), corporate: true },
  ]);
  // 境界: 金額の範囲は両端を含むどれか。自分の申請を除ける。期間の外は出ない。紐付かない申請は employeeId を持たない。
  expect(itemRefs(await repo.findCardCandidates(scope, { from: '2026-09-01', to: '2026-09-30', amounts: [{ min: 1900, max: 1980 }, { min: 4000, max: 5000 }] }))).toEqual(['dx-a/i2', 'dx-c/i1']);
  expect((await repo.findCardCandidates(scope, { from: '2026-09-20', to: '2026-09-20', amounts: [] }))[0]).not.toHaveProperty('employeeId');
  expect(itemRefs(await repo.findCardCandidates(scope, { from: '2026-09-10', to: '2026-09-10', amounts: [{ min: 3200, max: 3200 }], excludeClaimId: 'dx-a' }))).toEqual(['dx-b/i1']);
  expect(await repo.findCardCandidates(scope, { from: '2026-09-01', to: '2026-09-09', amounts: [] })).toEqual([]);
  expect(await repo.findCardCandidates(scope, { from: '2026-09-12', to: '2026-09-12', amounts: [] })).toEqual([]);

  // 正常: 保存し直すと派生索引も入れ直される（承認者の段が進んだ・紐付けを外した・明細を消した）。
  await repo.save(claimFixture('dx-b', { status: 'checked', claimant: { name: 'テスト花子', employeeId: 'emp-hanako', departmentId: 'dept-sales' }, items: [itemFixture('i1', { payeeName: undefined })], createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T04:00:00.000Z' }), new Map());
  expect(ids(await repo.list(scope, { awaitingEmployeeId: 'emp-jiro' }))).toEqual([]);
  expect(ids(await repo.list(scope, { statuses: ['checked'] }))).toEqual(['dx-b']);
  await repo.save(claimFixture('dx-a', { claimant: { name: 'テスト太郎' }, items: [itemFixture('i1')], createdAt: '2026-09-14T03:00:00.000Z', updatedAt: '2026-09-14T05:00:00.000Z' }), new Map());
  expect(ids(await repo.list(scope, { employeeId: 'emp-taro' }))).toEqual([]);
  expect(ids(await repo.list(scope, { advanceId: 'adv-1' }))).toEqual([]);
  expect(itemRefs(await repo.listItemFacts(scope, { limit: 100 }))).toEqual(['dx-a/i1', 'dx-b/i1', 'dx-c/i1']);
  expect((await repo.listItemFacts(scope, { limit: 1 }))[0]).toEqual({ claimId: 'dx-a', itemId: 'i1', status: 'draft', transactionDate: '2026-09-10', amount: 3200, categoryId: 'transport.taxi', corporate: false, claimantName: 'テスト太郎' });

  // 境界: テナント / ワークスペース分離（同じ id の申請も別物）。
  await repo.save(claimFixture('dx-b', { tenant: otherWorkspace, status: 'in-approval', approvalFlow: twoStepFlow(), claimant: { name: 'テスト花子', employeeId: 'emp-hanako' } }), new Map(), ['emp-jiro']);
  expect(ids(await repo.list(otherWorkspace, { awaitingEmployeeId: 'emp-jiro' }))).toEqual(['dx-b']);
  expect(ids(await repo.list(scope, { awaitingEmployeeId: 'emp-jiro' }))).toEqual([]);
  expect(await repo.listItemFacts(otherTenant, { limit: 100 })).toEqual([]);
  expect(await repo.findCardCandidates(otherTenant, { from: '2026-09-01', to: '2026-09-30', amounts: [] })).toEqual([]);

  // 正常: 削除で派生索引も消え、他スコープの同じ id には触れない。
  expect(await repo.delete(scope, 'dx-c')).toBe(true);
  expect(itemRefs(await repo.listItemFacts(scope, { limit: 100 }))).toEqual(['dx-a/i1', 'dx-b/i1']);
  expect(await repo.findCardCandidates(scope, { from: '2026-09-20', to: '2026-09-20', amounts: [] })).toEqual([]);
  expect(ids(await repo.list(scope, { unlinked: true }))).toEqual(['dx-a', 'dx-d']);
  expect(await repo.delete(scope, 'dx-b')).toBe(true);
  expect(ids(await repo.list(scope, { departmentId: 'dept-sales' }))).toEqual([]);
  expect(ids(await repo.list(otherWorkspace, { awaitingEmployeeId: 'emp-jiro' }))).toEqual(['dx-b']);
  expect(itemRefs(await repo.listItemFacts(otherWorkspace, { limit: 100 }))).toEqual(['dx-b/item-1']);
}

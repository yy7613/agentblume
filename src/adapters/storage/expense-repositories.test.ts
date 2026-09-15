/**
 * 経費精算 BC の 3 つのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `expense-*-repository.contract.ts`。ここでは両実装へ同じ契約をかけたうえで、SQLite にしか無い性質
 * （絞り込み用の列・索引の入れ直し・壊れた行の扱い）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { expenseClaimDerivedIndexContract, expenseClaimRepositoryContract } from './expense-claim-repository.contract';
import { expensePolicyRepositoryContract } from './expense-policy-repository.contract';
import { expenseReceiptRepositoryContract } from './expense-receipt-repository.contract';
import { AT, claimFixture, itemFixture, receiptFixture, scope, SHA_A } from './expense-repository.fixtures';
import { expenseSettingsRepositoryContract } from './expense-settings-repository.contract';
import { fixtureOrganization } from './expense-v9.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from './in-memory-expense-repositories';
import { InMemoryExpenseSettingsRepository } from './in-memory-expense-settings-repository';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteExpenseClaimRepository, SqliteExpensePolicyRepository, SqliteExpenseReceiptRepository } from './sqlite-expense-repositories';
import { SqliteExpenseSettingsRepository } from './sqlite-expense-settings-repository';

describe.each([
  ['規程', expensePolicyRepositoryContract, () => new InMemoryExpensePolicyRepository(), () => new SqliteExpensePolicyRepository()],
  ['申請', expenseClaimRepositoryContract, () => new InMemoryExpenseClaimRepository(), () => new SqliteExpenseClaimRepository()],
  ['申請（実用化の派生索引）', expenseClaimDerivedIndexContract, () => new InMemoryExpenseClaimRepository(), () => new SqliteExpenseClaimRepository()],
  ['証憑', expenseReceiptRepositoryContract, () => new InMemoryExpenseReceiptRepository(), () => new SqliteExpenseReceiptRepository()],
  ['ワークスペースの設定', expenseSettingsRepositoryContract, () => new InMemoryExpenseSettingsRepository(), () => new SqliteExpenseSettingsRepository()],
] as const)('%s リポジトリ', (_name, contract, makeMemory, makeSqlite) => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await contract(makeMemory() as never);
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = makeSqlite();
    try { await contract(repo as never); } finally { repo.close(); }
  });
});

describe('SQLite 固有の性質', () => {
  it('申請: 絞り込み用の列（状態・判定・申請者キー・期間・合計）を出し、明細ごとに索引の行を入れ直す', async () => {
    const database = openSqliteDatabase();
    const claims = new SqliteExpenseClaimRepository(database);
    try {
      await claims.save(claimFixture('c1', { items: [itemFixture('i1'), itemFixture('i2', { payeeName: undefined, amount: 500 })] }), new Map([['i1', SHA_A]]));
      expect(database.handle.prepare(`SELECT status, verdict, claimant_key, period_from, period_to, total_amount, created_at FROM expense_claims WHERE id=?`).get('c1'))
        .toMatchObject({ status: 'draft', verdict: null, claimant_key: 'テスト太郎#e001', period_from: '2026-09-01', period_to: '2026-09-30', total_amount: 3700, created_at: AT });
      const keys = database.handle.prepare(`SELECT item_id, transaction_date, amount, payee_key, category_id, receipt_sha256 FROM expense_item_keys WHERE claim_id=? ORDER BY item_id`).all('c1');
      expect(keys).toEqual([
        { item_id: 'i1', transaction_date: '2026-09-10', amount: 3200, payee_key: 'サンプル交通', category_id: 'transport.taxi', receipt_sha256: SHA_A },
        { item_id: 'i2', transaction_date: '2026-09-10', amount: 500, payee_key: null, category_id: 'transport.taxi', receipt_sha256: null },
      ]);
      // 明細を消して保存し直すと、その申請の索引は入れ直される（古い行が残らない）。
      await claims.save(claimFixture('c1', { items: [itemFixture('i2')] }), new Map());
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM expense_item_keys WHERE claim_id=?`).get('c1')).toMatchObject({ n: 1 });
      // 削除で索引も消える。
      await claims.delete(scope, 'c1');
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM expense_item_keys`).get()).toMatchObject({ n: 0 });
    } finally { database.close(); }
  });

  it('申請: 実用化の派生索引 3 表（申請の参照・明細の事実・現在の段の承認者）を同じ保存で入れ直し、削除で消す', async () => {
    const database = openSqliteDatabase();
    const claims = new SqliteExpenseClaimRepository(database);
    const count = (table: string) => database.handle.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE claim_id='c1'`).get();
    try {
      await claims.save(claimFixture('c1', {
        claimant: { name: 'テスト太郎', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' }, advanceId: 'adv-1',
        items: [itemFixture('i1', { corporatePayment: true, amount: -100 }), itemFixture('i2', { transactionDate: undefined, payeeName: undefined, amount: undefined }, { categoryId: undefined })],
      }), new Map(), ['emp-jiro', 'emp-jiro']);
      expect(database.handle.prepare(`SELECT * FROM expense_claim_refs WHERE claim_id='c1'`).get()).toEqual({
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId, claim_id: 'c1', employee_id: 'emp-taro', department_id: 'dept-sales', department_text: '営業部',
        claimant_name: 'テスト太郎', advance_id: 'adv-1', payout_batch_id: null, approved_at: null, settled_at: null,
      });
      expect(database.handle.prepare(`SELECT item_id, transaction_date, amount, category_id, corporate, payee_key FROM expense_item_refs WHERE claim_id='c1' ORDER BY item_id`).all()).toEqual([
        // 負の金額もそのまま（数えるかは集計が決める）。
        { item_id: 'i1', transaction_date: '2026-09-10', amount: -100, category_id: 'transport.taxi', corporate: 1, payee_key: 'サンプル交通' },
        { item_id: 'i2', transaction_date: null, amount: null, category_id: null, corporate: 0, payee_key: null },
      ]);
      // 承認の記録が無ければ段は 0。同じ人は 1 行。
      expect(database.handle.prepare(`SELECT employee_id, step_index FROM expense_claim_approvers WHERE claim_id='c1'`).all()).toEqual([{ employee_id: 'emp-jiro', step_index: 0 }]);
      // 承認者を渡さずに保存し直すと承認者の行は消え、明細の行も入れ直される。
      await claims.save(claimFixture('c1', { items: [itemFixture('i3')] }), new Map());
      expect(count('expense_claim_approvers')).toMatchObject({ n: 0 });
      expect(database.handle.prepare(`SELECT item_id FROM expense_item_refs WHERE claim_id='c1'`).all()).toEqual([{ item_id: 'i3' }]);
      await claims.save(claimFixture('c1', { items: [itemFixture('i3')] }), new Map(), ['emp-saburo']);
      await claims.delete(scope, 'c1');
      for (const table of ['expense_claim_refs', 'expense_item_refs', 'expense_claim_approvers', 'expense_item_keys']) expect(count(table)).toMatchObject({ n: 0 });
    } finally { database.close(); }
  });

  it('申請: 派生行の無い申請（v9 の埋め戻し前）も一覧の「紐付いていない」に数え、集計とカード候補には出さない', async () => {
    const database = openSqliteDatabase();
    const claims = new SqliteExpenseClaimRepository(database);
    try {
      await claims.save(claimFixture('c1'), new Map());
      database.handle.exec(`DELETE FROM expense_claim_refs`);
      expect((await claims.list(scope, { unlinked: true })).map((summary) => summary.id)).toEqual(['c1']);
      expect(await claims.listItemFacts(scope, { limit: 10 })).toEqual([]);
      // カード候補は明細の派生行だけで引ける（申請の参照が無ければ従業員を持たない）。
      expect(await claims.findCardCandidates(scope, { from: '2026-09-01', to: '2026-09-30', amounts: [] })).toEqual([
        { claimId: 'c1', itemId: 'item-1', claimStatus: 'draft', transactionDate: '2026-09-10', amount: 3200, payeeKey: 'サンプル交通', corporate: false },
      ]);
    } finally { database.close(); }
  });

  it('設定: kind ごとに 1 行で更新日時を列に出す。壊れた record_json（形・JSON）は ExpenseDomainError', async () => {
    const database = openSqliteDatabase();
    const settings = new SqliteExpenseSettingsRepository(database);
    try {
      await settings.save(scope, 'organization', fixtureOrganization());
      await settings.save(scope, 'organization', fixtureOrganization('2026-09-16T00:00:00.000Z'));
      expect(database.handle.prepare(`SELECT kind, updated_at FROM expense_settings`).all()).toEqual([{ kind: 'organization', updated_at: '2026-09-16T00:00:00.000Z' }]);
      const insert = database.handle.prepare(`INSERT INTO expense_settings (tenant_id, workspace_id, kind, updated_at, record_json) VALUES (?, ?, ?, ?, ?)`);
      insert.run(scope.tenantId, scope.workspaceId, 'payout', AT, JSON.stringify({ id: 'broken' }));
      insert.run(scope.tenantId, scope.workspaceId, 'cards', AT, '{broken');
      insert.run(scope.tenantId, scope.workspaceId, 'fares', AT, JSON.stringify({ routes: 'x', updatedAt: AT }));
      await expect(settings.get(scope, 'payout')).rejects.toThrow(ExpenseDomainError);
      await expect(settings.get(scope, 'cards')).rejects.toThrow('record_json is not valid JSON');
      await expect(settings.get(scope, 'fares')).rejects.toThrow('deserializeExpenseSettings(fares)');
    } finally { database.close(); }
  });

  it('証憑: 画像本体は record_json にだけ置き、ハッシュの一覧は本体を読まない', async () => {
    const database = openSqliteDatabase();
    const receipts = new SqliteExpenseReceiptRepository(database);
    try {
      await receipts.save(receiptFixture('r1'));
      const columns = database.handle.prepare(`PRAGMA table_info(expense_receipts)`).all().map((row) => String(row['name']));
      expect(columns).toEqual(['tenant_id', 'workspace_id', 'id', 'claim_id', 'item_id', 'sha256', 'created_at', 'record_json']);
      // record_json が壊れていてもハッシュの一覧は読める（本体を読まない証拠）。
      database.handle.prepare(`UPDATE expense_receipts SET record_json='{}'`).run();
      expect(Object.fromEntries(await receipts.hashesByClaim(scope, 'claim-1'))).toEqual({ 'item-1': SHA_A });
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json は読み出し時に ExpenseDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const policies = new SqliteExpensePolicyRepository(database);
    const claims = new SqliteExpenseClaimRepository(database);
    const receipts = new SqliteExpenseReceiptRepository(database);
    try {
      const broken = JSON.stringify({ id: 'broken' });
      database.handle.prepare(`INSERT INTO expense_policy (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)`).run(scope.tenantId, scope.workspaceId, broken);
      database.handle.prepare(`INSERT INTO expense_claims (tenant_id, workspace_id, id, status, verdict, claimant_key, period_from, period_to, total_amount, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'draft', null, 'x', '2026-09-01', '2026-09-30', 0, AT, broken);
      database.handle.prepare(`INSERT INTO expense_receipts (tenant_id, workspace_id, id, claim_id, item_id, sha256, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'broken', 'i1', SHA_A, AT, broken);
      await expect(policies.get(scope)).rejects.toThrow(ExpenseDomainError);
      await expect(claims.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(claims.findByIds(scope, ['broken'])).rejects.toThrow(ExpenseDomainError);
      await expect(claims.list(scope)).rejects.toThrow(ExpenseDomainError);
      await expect(receipts.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(receipts.findByItem(scope, 'broken', 'i1')).rejects.toThrow(ExpenseDomainError);
    } finally { database.close(); }
  });
});

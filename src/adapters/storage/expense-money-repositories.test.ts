/**
 * 経費精算のお金の流れ（仮払・法人カード・振込バッチ）のリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `expense-money-repository.contract.ts`。ここでは SQLite にしか無い性質（絞り込み用の列・一意制約・
 * 壊れた行の扱い）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../../domain/expense/errors';
import {
  expenseAdvanceRepositoryContract, expenseCardRepositoryContract, expensePayoutBatchRepositoryContract,
} from './expense-money-repository.contract';
import { advanceFixture, cardImportFixture, cardTransactionFixture, fixtureSealAccountNumber, payoutBatchFixture, scope, V9_AT } from './expense-v9.fixtures';
import { InMemoryExpenseAdvanceRepository, InMemoryExpenseCardRepository, InMemoryExpensePayoutBatchRepository } from './in-memory-expense-money-repositories';
import { openSqliteDatabase } from './sqlite-database';
import {
  mergeCardCoverage, SqliteExpenseAdvanceRepository, SqliteExpenseCardRepository, SqliteExpensePayoutBatchRepository,
} from './sqlite-expense-money-repositories';

describe.each([
  ['仮払', expenseAdvanceRepositoryContract, () => new InMemoryExpenseAdvanceRepository(), () => new SqliteExpenseAdvanceRepository()],
  ['法人カード', expenseCardRepositoryContract, () => new InMemoryExpenseCardRepository(), () => new SqliteExpenseCardRepository()],
  ['振込バッチ', expensePayoutBatchRepositoryContract, () => new InMemoryExpensePayoutBatchRepository(), () => new SqliteExpensePayoutBatchRepository()],
] as const)('%s リポジトリ', (_name, contract, makeMemory, makeSqlite) => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await contract(makeMemory() as never);
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = makeSqlite();
    try { await contract(repo as never); } finally { repo.close(); }
  });
});

describe('mergeCardCoverage', () => {
  it('境界: 入力の順に依らずカード → 開始日で並べ、月末と翌月初はつなげるが 1 日空けば分ける', () => {
    expect(mergeCardCoverage([
      { cardId: 'b', from: '2026-03-01', to: '2026-03-31' },
      { cardId: 'a', from: '2026-02-01', to: '2026-02-28' },
      { cardId: 'a', from: '2026-01-01', to: '2026-01-31' },
      { cardId: 'a', from: '2026-03-02', to: '2026-03-10' },
      { cardId: 'a', from: '2026-01-01', to: '2026-01-15' },
    ])).toEqual([
      { cardId: 'a', from: '2026-01-01', to: '2026-02-28' },
      { cardId: 'a', from: '2026-03-02', to: '2026-03-10' },
      { cardId: 'b', from: '2026-03-01', to: '2026-03-31' },
    ]);
    expect(mergeCardCoverage([])).toEqual([]);
  });
});

describe('SQLite 固有の性質（お金の流れ）', () => {
  it('利用行: 照合の申請・明細を列に出し、解除で列も空にする。取込のカード未指定は NULL', async () => {
    const database = openSqliteDatabase();
    const cards = new SqliteExpenseCardRepository(database);
    try {
      await cards.saveImport(cardImportFixture('import-1', { cardId: undefined }), [cardTransactionFixture('tx-1')]);
      expect(database.handle.prepare(`SELECT card_id, period_from, period_to, file_sha256 FROM expense_card_imports`).get()).toEqual({ card_id: null, period_from: '2026-09-01', period_to: '2026-09-30', file_sha256: 'd'.repeat(64) });
      await cards.saveTransactions([cardTransactionFixture('tx-1', { status: 'matched', match: { claimId: 'claim-a', itemId: 'item-1', kind: 'reimbursement-item', strength: 'weak', dateDiffDays: 1, amountDiff: 0, manual: true, at: V9_AT, by: 'keiri@example.com' } })]);
      const row = () => database.handle.prepare(`SELECT status, claim_id, item_id, used_on, amount, merchant_key, dedupe_key FROM expense_card_transactions WHERE id='tx-1'`).get();
      expect(row()).toMatchObject({ status: 'matched', claim_id: 'claim-a', item_id: 'item-1', used_on: '2026-09-10', amount: 3200 });
      expect(await cards.unlinkClaim(scope, 'claim-a')).toBe(1);
      expect(row()).toMatchObject({ status: 'unmatched', claim_id: null, item_id: null });
      // 利用行の updatedAt は解除で変えない（時刻は呼び出し側の監査が持つ）。
      expect((await cards.findTransaction(scope, 'tx-1'))?.updatedAt).toBe(V9_AT);
    } finally { database.close(); }
  });

  it('振込バッチ・仮払: 一覧用の列を出し、口座番号は列に出さない', async () => {
    const database = openSqliteDatabase();
    const payouts = new SqliteExpensePayoutBatchRepository(database);
    const advances = new SqliteExpenseAdvanceRepository(database);
    try {
      await payouts.save(payoutBatchFixture('batch-1'));
      await advances.save(advanceFixture('adv-1', 'paid'));
      expect(database.handle.prepare(`SELECT status, transfer_date, total_amount, record_count, file_sha256, created_at FROM expense_payout_batches`).get())
        .toEqual({ status: 'exported', transfer_date: '2026-09-25', total_amount: 5180, record_count: 1, file_sha256: 'c'.repeat(64), created_at: V9_AT });
      expect(database.handle.prepare(`SELECT employee_id, status, amount, needed_on, planned_settle_by FROM expense_advances`).get())
        .toEqual({ employee_id: 'emp-hanako', status: 'paid', amount: 30000, needed_on: '2026-09-05', planned_settle_by: '2026-09-30' });
      // 口座番号は平文の文字列ではなく封緘値のまま record_json に入る（data は base64、hint は末尾 4 桁）。
      const record = String(database.handle.prepare(`SELECT record_json FROM expense_payout_batches`).get()?.['record_json']);
      expect(record).not.toMatch(/"accountNumber":"/u);
      expect(JSON.parse(record).lines[0].bank.accountNumber).toEqual(fixtureSealAccountNumber('0000001'));
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json（形が違う・JSON でない）は読み出し時に ExpenseDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const advances = new SqliteExpenseAdvanceRepository(database);
    const cards = new SqliteExpenseCardRepository(database);
    const payouts = new SqliteExpensePayoutBatchRepository(database);
    const handle = database.handle;
    const broken = JSON.stringify({ id: 'broken' });
    try {
      handle.prepare(`INSERT INTO expense_advances (tenant_id, workspace_id, id, employee_id, status, amount, needed_on, planned_settle_by, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'emp-x', 'requested', 1, '2026-09-01', '2026-09-30', V9_AT, broken);
      handle.prepare(`INSERT INTO expense_card_imports (tenant_id, workspace_id, id, file_sha256, card_id, period_from, period_to, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'x', 'card-x', '2026-09-01', '2026-09-30', V9_AT, '{not json');
      handle.prepare(`INSERT INTO expense_card_transactions (tenant_id, workspace_id, id, import_id, card_id, used_on, amount, merchant_key, status, claim_id, item_id, dedupe_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'broken', 'card-x', '2026-09-10', 100, 'x', 'matched', 'claim-x', 'item-x', 'k', broken);
      handle.prepare(`INSERT INTO expense_payout_batches (tenant_id, workspace_id, id, status, transfer_date, total_amount, record_count, file_sha256, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'exported', '2026-09-25', 1, 1, 'x', V9_AT, broken);
      await expect(advances.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(advances.findByIds(scope, ['broken'])).rejects.toThrow(ExpenseDomainError);
      await expect(advances.list(scope, { status: 'requested', employeeId: 'emp-x', limit: 1 })).rejects.toThrow(ExpenseDomainError);
      await expect(cards.findImport(scope, 'broken')).rejects.toThrow('record_json is not valid JSON');
      await expect(cards.listImports(scope)).rejects.toThrow(ExpenseDomainError);
      await expect(cards.findTransaction(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(cards.listTransactions(scope)).rejects.toThrow(ExpenseDomainError);
      await expect(cards.findTransactionsForMatching(scope, { from: '2026-09-01', to: '2026-09-30', amounts: [] })).rejects.toThrow(ExpenseDomainError);
      await expect(cards.unlinkClaim(scope, 'claim-x')).rejects.toThrow(ExpenseDomainError);
      await expect(payouts.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(payouts.list(scope)).rejects.toThrow(ExpenseDomainError);
      await expect(payouts.findActiveByClaimIds(scope, ['claim-a'])).rejects.toThrow(ExpenseDomainError);
      // 範囲の算出と取込の削除は record_json を読まない。
      expect(await cards.coverage(scope)).toEqual([{ cardId: 'card-x', from: '2026-09-01', to: '2026-09-30' }]);
      expect(await cards.deleteImport(scope, 'broken')).toBe(1);
    } finally { database.close(); }
  });
});

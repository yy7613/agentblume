/**
 * adapters層: 経費精算のお金の流れ（仮払・法人カード・振込バッチ。docs/21 §20.2.7〜9 / §20.8。UC3〜5）の SQLite 永続化。
 *
 * - 本体は `record_json`、絞り込みと並びに使う値だけを列へ出す（テーブルは `expense-v9-migrations.ts`）。
 * - カード明細の取込は 1 トランザクション。同じファイル（SHA-256）は何も書かずに `ExpenseCardDuplicateImportError`、
 *   期間の重なるファイルの同じ行は `dedupe_key` の一意制約に任せて `INSERT OR IGNORE` で数える（行ごとに引かない）。
 * - 振込バッチの口座番号は封緘値のまま record_json にだけ置く（列に出さない）。
 * - 並び順は `domain/expense/repositories.ts` の doc コメントが正本で、InMemory 実装と同じ結果になる（共有契約テスト）。
 */
import type { AdvanceStatus, ExpenseAdvance } from '../../domain/expense/advance';
import type { ExpenseCardImport, ExpenseCardTransaction } from '../../domain/expense/card';
import { ExpenseCardDuplicateImportError, ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpensePayoutBatch, PayoutBatchStatus } from '../../domain/expense/payout';
import type {
  CardCandidateQuery, ExpenseAdvanceRepository, ExpenseCardRepository, ExpenseCardTransactionListOptions, ExpensePayoutBatchRepository,
} from '../../domain/expense/repositories';
import {
  deserializeExpenseAdvance, deserializeExpenseCardImport, deserializeExpenseCardTransaction, deserializeExpensePayoutBatch,
  serializeExpenseAdvance, serializeExpenseCardImport, serializeExpenseCardTransaction, serializeExpensePayoutBatch,
} from '../../domain/expense/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function parse<T>(value: unknown, deserialize: (raw: unknown) => T, label: string): T {
  let raw: unknown;
  try { raw = JSON.parse(String(value)); } catch { throw new ExpenseDomainError(`${label}: record_json is not valid JSON`); }
  return deserialize(raw);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export interface CardCoverageRange { readonly cardId: string; readonly from: string; readonly to: string }

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * カードごとの取込範囲の和集合（cardId → from の昇順）。日付は日単位の閉区間なので、重なりに加えて
 * 翌日から始まる区間（9/1〜9/30 と 10/1〜10/31）もつなげる（取込の抜けが無い月を「抜け」と見せないため）。
 */
export function mergeCardCoverage(ranges: readonly CardCoverageRange[]): readonly CardCoverageRange[] {
  const sorted = [...ranges].sort((left, right) => (left.cardId !== right.cardId ? (left.cardId < right.cardId ? -1 : 1) : left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  const merged: CardCoverageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.cardId === range.cardId && range.from <= nextDay(last.to)) {
      merged[merged.length - 1] = { ...last, to: range.to > last.to ? range.to : last.to };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function cardDedupeConflict(transaction: ExpenseCardTransaction, conflictId: string): ExpenseDomainError {
  return new ExpenseDomainError(`expense card transaction: ${transaction.id} has the same dedupeKey as ${conflictId} (${transaction.dedupeKey})`);
}

export function cardDuplicateImport(existingId: string, importedAt: string): ExpenseCardDuplicateImportError {
  return new ExpenseCardDuplicateImportError(`expense card import: the same file was already imported as ${existingId} at ${importedAt}`, existingId, importedAt);
}

/** 取消されていない振込バッチが指定の申請を含むか（`sources[].kind = 'claim'`）。 */
export function payoutBatchIncludesClaim(batch: ExpensePayoutBatch, claimIds: ReadonlySet<string>): boolean {
  return batch.lines.some((line) => line.sources.some((source) => source.kind === 'claim' && claimIds.has(source.id)));
}

export const ACTIVE_PAYOUT_BATCH_STATUSES: readonly PayoutBatchStatus[] = ['exported', 'confirmed'];

export class SqliteExpenseAdvanceRepository extends SqliteRepositoryBase implements ExpenseAdvanceRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(advance: ExpenseAdvance): Promise<void> {
    this.db.prepare(
      `INSERT INTO expense_advances (tenant_id, workspace_id, id, employee_id, status, amount, needed_on, planned_settle_by, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET employee_id=excluded.employee_id, status=excluded.status, amount=excluded.amount,
         needed_on=excluded.needed_on, planned_settle_by=excluded.planned_settle_by, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(advance.tenant.tenantId, advance.tenant.workspaceId, advance.id, advance.employeeId, advance.status, advance.amount, advance.neededOn, advance.plannedSettleBy, advance.createdAt, JSON.stringify(serializeExpenseAdvance(advance)));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseAdvance | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_advances WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseAdvance, 'expense advance');
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseAdvance[]> {
    const statement = this.db.prepare(`SELECT record_json FROM expense_advances WHERE tenant_id=? AND workspace_id=? AND id=?`);
    const found: ExpenseAdvance[] = [];
    for (const id of ids) {
      const row = statement.get(scope.tenantId, scope.workspaceId, id);
      if (row !== undefined) found.push(parse(row['record_json'], deserializeExpenseAdvance, 'expense advance'));
    }
    return found;
  }

  async list(scope: TenantScope, options?: { readonly status?: AdvanceStatus; readonly employeeId?: string; readonly limit?: number }): Promise<readonly ExpenseAdvance[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.employeeId !== undefined) { where.push('employee_id=?'); params.push(options.employeeId); }
    let sql = `SELECT record_json FROM expense_advances WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeExpenseAdvance, 'expense advance'));
  }
}

export class SqliteExpenseCardRepository extends SqliteRepositoryBase implements ExpenseCardRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  private transactionValues(transaction: ExpenseCardTransaction): readonly (string | number | null)[] {
    return [
      transaction.tenant.tenantId, transaction.tenant.workspaceId, transaction.id, transaction.importId, transaction.cardId, transaction.usedOn, transaction.amount,
      transaction.merchantKey, transaction.status, transaction.match?.claimId ?? null, transaction.match?.itemId ?? null, transaction.dedupeKey,
      JSON.stringify(serializeExpenseCardTransaction(transaction)),
    ];
  }

  async saveImport(importRecord: ExpenseCardImport, transactions: readonly ExpenseCardTransaction[]): Promise<{ readonly inserted: number; readonly duplicates: number }> {
    const { tenantId, workspaceId } = importRecord.tenant;
    return this.database.transaction(() => {
      const existing = this.db.prepare(`SELECT id, created_at FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? AND file_sha256=? AND id<>?`)
        .get(tenantId, workspaceId, importRecord.fileSha256, importRecord.id);
      if (existing !== undefined) throw cardDuplicateImport(String(existing['id']), String(existing['created_at']));
      this.db.prepare(
        `INSERT INTO expense_card_imports (tenant_id, workspace_id, id, file_sha256, card_id, period_from, period_to, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET file_sha256=excluded.file_sha256, card_id=excluded.card_id, period_from=excluded.period_from,
           period_to=excluded.period_to, created_at=excluded.created_at, record_json=excluded.record_json`,
      ).run(tenantId, workspaceId, importRecord.id, importRecord.fileSha256, importRecord.cardId ?? null, importRecord.periodFrom, importRecord.periodTo, importRecord.createdAt, JSON.stringify(serializeExpenseCardImport(importRecord)));
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO expense_card_transactions (tenant_id, workspace_id, id, import_id, card_id, used_on, amount, merchant_key, status, claim_id, item_id, dedupe_key, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      for (const transaction of transactions) inserted += Number(insert.run(...this.transactionValues(transaction)).changes);
      return { inserted, duplicates: transactions.length - inserted };
    });
  }

  async findImport(scope: TenantScope, id: string): Promise<ExpenseCardImport | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseCardImport, 'expense card import');
  }

  async listImports(scope: TenantScope, options?: { readonly limit?: number }): Promise<readonly ExpenseCardImport[]> {
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    let sql = `SELECT record_json FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeExpenseCardImport, 'expense card import'));
  }

  async deleteImport(scope: TenantScope, id: string): Promise<number> {
    return this.database.transaction(() => {
      const found = this.db.prepare(`SELECT id FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
      if (found === undefined) return -1;
      const result = this.db.prepare(`DELETE FROM expense_card_transactions WHERE tenant_id=? AND workspace_id=? AND import_id=?`).run(scope.tenantId, scope.workspaceId, id);
      this.db.prepare(`DELETE FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
      return Number(result.changes);
    });
  }

  async saveTransactions(transactions: readonly ExpenseCardTransaction[]): Promise<void> {
    this.database.transaction(() => {
      const clash = this.db.prepare(`SELECT id FROM expense_card_transactions WHERE tenant_id=? AND workspace_id=? AND dedupe_key=? AND id<>?`);
      const upsert = this.db.prepare(
        `INSERT INTO expense_card_transactions (tenant_id, workspace_id, id, import_id, card_id, used_on, amount, merchant_key, status, claim_id, item_id, dedupe_key, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET import_id=excluded.import_id, card_id=excluded.card_id, used_on=excluded.used_on, amount=excluded.amount,
           merchant_key=excluded.merchant_key, status=excluded.status, claim_id=excluded.claim_id, item_id=excluded.item_id, dedupe_key=excluded.dedupe_key, record_json=excluded.record_json`,
      );
      for (const transaction of transactions) {
        // 一意制約の生のエラーではどの行と重なったか分からないので、先に引いて domain のエラーにする。
        const conflict = clash.get(transaction.tenant.tenantId, transaction.tenant.workspaceId, transaction.dedupeKey, transaction.id);
        if (conflict !== undefined) throw cardDedupeConflict(transaction, String(conflict['id']));
        upsert.run(...this.transactionValues(transaction));
      }
    });
  }

  async findTransaction(scope: TenantScope, id: string): Promise<ExpenseCardTransaction | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_card_transactions WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseCardTransaction, 'expense card transaction');
  }

  async listTransactions(scope: TenantScope, options?: ExpenseCardTransactionListOptions): Promise<readonly ExpenseCardTransaction[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.cardId !== undefined) { where.push('card_id=?'); params.push(options.cardId); }
    if (options?.from !== undefined) { where.push('used_on>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('used_on<=?'); params.push(options.to); }
    if (options?.claimId !== undefined) { where.push('claim_id=?'); params.push(options.claimId); }
    let sql = `SELECT record_json FROM expense_card_transactions WHERE ${where.join(' AND ')} ORDER BY used_on DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeExpenseCardTransaction, 'expense card transaction'));
  }

  async findTransactionsForMatching(scope: TenantScope, query: CardCandidateQuery): Promise<readonly ExpenseCardTransaction[]> {
    // 状態では絞らない（対象外・手動の紐付けを保つかは照合が決める）。excludeClaimId は明細側の条件なので見ない。
    const where: string[] = ['tenant_id=?', 'workspace_id=?', 'used_on>=?', 'used_on<=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId, query.from, query.to];
    if (query.amounts.length > 0) {
      where.push(`(${query.amounts.map(() => '(amount>=? AND amount<=?)').join(' OR ')})`);
      for (const range of query.amounts) params.push(range.min, range.max);
    }
    return this.db.prepare(`SELECT record_json FROM expense_card_transactions WHERE ${where.join(' AND ')} ORDER BY used_on ASC, id ASC`)
      .all(...params).map((row) => parse(row['record_json'], deserializeExpenseCardTransaction, 'expense card transaction'));
  }

  async coverage(scope: TenantScope, cardIds?: readonly string[]): Promise<readonly CardCoverageRange[]> {
    // カードを指定しない取込（1 ファイルに複数カード）は、その取込の利用行のカードの範囲として数える。
    const rows = this.db.prepare(
      `SELECT card_id, period_from, period_to FROM expense_card_imports WHERE tenant_id=? AND workspace_id=? AND card_id IS NOT NULL
       UNION
       SELECT DISTINCT t.card_id, i.period_from, i.period_to FROM expense_card_imports i
         JOIN expense_card_transactions t ON t.tenant_id=i.tenant_id AND t.workspace_id=i.workspace_id AND t.import_id=i.id
         WHERE i.tenant_id=? AND i.workspace_id=? AND i.card_id IS NULL`,
    ).all(scope.tenantId, scope.workspaceId, scope.tenantId, scope.workspaceId);
    const wanted = cardIds === undefined ? undefined : new Set(cardIds);
    return mergeCardCoverage(rows
      .map((row) => ({ cardId: String(row['card_id']), from: String(row['period_from']), to: String(row['period_to']) }))
      .filter((range) => wanted === undefined || wanted.has(range.cardId)));
  }

  async unlinkClaim(scope: TenantScope, claimId: string): Promise<number> {
    return this.database.transaction(() => {
      const rows = this.db.prepare(`SELECT record_json FROM expense_card_transactions WHERE tenant_id=? AND workspace_id=? AND claim_id=? AND status='matched'`)
        .all(scope.tenantId, scope.workspaceId, claimId);
      const update = this.db.prepare(`UPDATE expense_card_transactions SET status='unmatched', claim_id=NULL, item_id=NULL, record_json=? WHERE tenant_id=? AND workspace_id=? AND id=?`);
      for (const row of rows) {
        // 解除の時刻は呼び出し側の監査が持つ（ここは時計を持たない）ので updatedAt は変えない。
        const { match: _match, ...rest } = parse(row['record_json'], deserializeExpenseCardTransaction, 'expense card transaction');
        update.run(JSON.stringify(serializeExpenseCardTransaction({ ...rest, status: 'unmatched' })), scope.tenantId, scope.workspaceId, rest.id);
      }
      return rows.length;
    });
  }
}

export class SqliteExpensePayoutBatchRepository extends SqliteRepositoryBase implements ExpensePayoutBatchRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(batch: ExpensePayoutBatch): Promise<void> {
    this.db.prepare(
      `INSERT INTO expense_payout_batches (tenant_id, workspace_id, id, status, transfer_date, total_amount, record_count, file_sha256, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET status=excluded.status, transfer_date=excluded.transfer_date, total_amount=excluded.total_amount,
         record_count=excluded.record_count, file_sha256=excluded.file_sha256, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(batch.tenant.tenantId, batch.tenant.workspaceId, batch.id, batch.status, batch.transferDate, batch.totalAmount, batch.recordCount, batch.fileSha256, batch.createdAt, JSON.stringify(serializeExpensePayoutBatch(batch)));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpensePayoutBatch | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_payout_batches WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpensePayoutBatch, 'expense payout batch');
  }

  async list(scope: TenantScope, options?: { readonly status?: PayoutBatchStatus; readonly limit?: number }): Promise<readonly ExpensePayoutBatch[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    let sql = `SELECT record_json FROM expense_payout_batches WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => parse(row['record_json'], deserializeExpensePayoutBatch, 'expense payout batch'));
  }

  async findActiveByClaimIds(scope: TenantScope, claimIds: readonly string[]): Promise<readonly ExpensePayoutBatch[]> {
    if (claimIds.length === 0) return [];
    const wanted = new Set(claimIds);
    // 申請 → バッチの索引は持たない（二重の振込の検査は作成時だけで、取消されていないバッチは少ない）ので record_json を読む。
    return this.db.prepare(
      `SELECT record_json FROM expense_payout_batches WHERE tenant_id=? AND workspace_id=? AND status IN (${placeholders(ACTIVE_PAYOUT_BATCH_STATUSES.length)}) ORDER BY created_at DESC, id ASC`,
    ).all(scope.tenantId, scope.workspaceId, ...ACTIVE_PAYOUT_BATCH_STATUSES)
      .map((row) => parse(row['record_json'], deserializeExpensePayoutBatch, 'expense payout batch'))
      .filter((batch) => payoutBatchIncludesClaim(batch, wanted));
  }
}

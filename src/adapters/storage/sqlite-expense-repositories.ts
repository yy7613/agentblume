/**
 * adapters層: 経費精算 BC の SQLite 永続化（テーブル定義は `expense-migrations.ts` の version 6 と `expense-v9-migrations.ts` の version 9）。
 *
 * 本体は `record_json`（domain の Serialized 型）で、絞り込みと並びに使う値だけを列へ出す。
 * 復元は必ず `deserialize*` を通す（壊れた行は黙って null にせず `ExpenseDomainError` で失敗させる）。
 * 一覧の並びは `domain/expense/repositories.ts` の doc コメントが正本で、InMemory 実装と同じ結果になる（共有契約テスト）。
 */
import type { CardMatchableItem } from '../../domain/expense/card';
import { claimantKeyOf, claimTotalAmount, toExpenseClaimSummary, type ClaimStatus, type ExpenseClaim, type ExpenseClaimSummary } from '../../domain/expense/claim';
import { itemKeyOf, payeeKeyOf, type DuplicateCandidate } from '../../domain/expense/duplicates';
import type { ExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseReceipt } from '../../domain/expense/receipt';
import type {
  CardCandidateQuery, DuplicateCandidateQuery, ExpenseClaimListOptions, ExpenseClaimRepository, ExpenseItemFact, ExpenseItemFactQuery,
  ExpensePolicyRepository, ExpenseReceiptRepository,
} from '../../domain/expense/repositories';
import {
  deserializeExpenseClaim, deserializeExpensePolicy, deserializeExpenseReceipt,
  serializeExpenseClaim, serializeExpensePolicy, serializeExpenseReceipt,
} from '../../domain/expense/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: unknown, deserialize: (raw: unknown) => T): T {
  return deserialize(JSON.parse(String(value)));
}

/** 申請者名の部分一致の鍵（`claimant_key` と同じ正規化）。LIKE の特殊文字は逃がす。 */
function likePattern(text: string): string {
  const key = text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase().replace(/[\\%_]/gu, (char) => `\\${char}`);
  return `%${key}%`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** NULL の列は省く（domain の型は未定義のキーを持たない）。 */
function optionalColumn<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return value === null || value === undefined ? {} : { [key]: String(value) } as Record<K, string>;
}

/** 派生索引を消す 3 表（申請の保存で入れ直し、削除で消す）。 */
const DERIVED_CLAIM_TABLES = ['expense_claim_refs', 'expense_item_refs', 'expense_claim_approvers'] as const;

export class SqliteExpensePolicyRepository extends SqliteRepositoryBase implements ExpensePolicyRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async get(scope: TenantScope): Promise<ExpensePolicy | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_policy WHERE tenant_id=? AND workspace_id=?`).get(scope.tenantId, scope.workspaceId);
    return row === undefined ? null : parse(row['record_json'], deserializeExpensePolicy);
  }

  async save(scope: TenantScope, policy: ExpensePolicy): Promise<void> {
    this.db.prepare(
      `INSERT INTO expense_policy (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET record_json=excluded.record_json`,
    ).run(scope.tenantId, scope.workspaceId, json(serializeExpensePolicy(policy)));
  }
}

export class SqliteExpenseClaimRepository extends SqliteRepositoryBase implements ExpenseClaimRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(claim: ExpenseClaim, receiptHashes: ReadonlyMap<string, string>, approvers: readonly string[] = []): Promise<void> {
    const { tenantId, workspaceId } = claim.tenant;
    // 本体と索引は同じトランザクションで書く（索引だけが古いまま残ると、消した明細と重複判定され続け、集計にも残る）。
    this.database.transaction(() => {
      this.db.prepare(
        `INSERT INTO expense_claims (tenant_id, workspace_id, id, status, verdict, claimant_key, period_from, period_to, total_amount, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET status=excluded.status, verdict=excluded.verdict, claimant_key=excluded.claimant_key,
           period_from=excluded.period_from, period_to=excluded.period_to, total_amount=excluded.total_amount, created_at=excluded.created_at, record_json=excluded.record_json`,
      ).run(tenantId, workspaceId, claim.id, claim.status, claim.judgment?.verdict ?? null, claimantKeyOf(claim.claimant), claim.period.from, claim.period.to, claimTotalAmount(claim), claim.createdAt, json(serializeExpenseClaim(claim)));
      this.db.prepare(`DELETE FROM expense_item_keys WHERE tenant_id=? AND workspace_id=? AND claim_id=?`).run(tenantId, workspaceId, claim.id);
      const insert = this.db.prepare(
        `INSERT INTO expense_item_keys (tenant_id, workspace_id, claim_id, item_id, transaction_date, amount, payee_key, category_id, receipt_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of claim.items) {
        const key = itemKeyOf(item, receiptHashes.get(item.id));
        insert.run(tenantId, workspaceId, claim.id, item.id, key.transactionDate ?? null, key.amount ?? null, key.payeeKey ?? null, key.categoryId ?? null, key.receiptSha256 ?? null);
      }
      this.replaceDerivedIndexes(claim, approvers);
    });
  }

  /** 実用化の派生索引 3 表を入れ直す（呼び出し側のトランザクションの中で）。 */
  private replaceDerivedIndexes(claim: ExpenseClaim, approvers: readonly string[]): void {
    const { tenantId, workspaceId } = claim.tenant;
    for (const table of DERIVED_CLAIM_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND workspace_id=? AND claim_id=?`).run(tenantId, workspaceId, claim.id);
    this.db.prepare(
      `INSERT INTO expense_claim_refs (tenant_id, workspace_id, claim_id, employee_id, department_id, department_text, claimant_name, advance_id, payout_batch_id, approved_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId, workspaceId, claim.id, claim.claimant.employeeId ?? null, claim.claimant.departmentId ?? null, claim.claimant.department ?? null, claim.claimant.name,
      claim.advanceId ?? null, claim.payout?.batchId ?? null, claim.approval?.at ?? null, claim.settlement?.settledAt ?? null,
    );
    const insertItem = this.db.prepare(
      `INSERT INTO expense_item_refs (tenant_id, workspace_id, claim_id, item_id, transaction_date, amount, category_id, corporate, payee_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of claim.items) {
      // 金額は 0 以下もそのまま入れる（行は作り、数えるかは集計が決める。埋め戻しの SQL と同じ値にする）。
      insertItem.run(tenantId, workspaceId, claim.id, item.id, item.facts.transactionDate ?? null, item.facts.amount ?? null, item.categoryId ?? null, item.facts.corporatePayment === true ? 1 : 0, payeeKeyOf(item.facts.payeeName) ?? null);
    }
    const insertApprover = this.db.prepare(`INSERT INTO expense_claim_approvers (tenant_id, workspace_id, claim_id, employee_id, step_index) VALUES (?, ?, ?, ?, ?)`);
    const stepIndex = claim.approvalFlow?.currentIndex ?? 0;
    // 同じ人が重なって渡っても主キーで落ちないよう 1 回にする。
    for (const employeeId of new Set(approvers)) insertApprover.run(tenantId, workspaceId, claim.id, employeeId, stepIndex);
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseClaim | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_claims WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseClaim);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseClaim[]> {
    const statement = this.db.prepare(`SELECT record_json FROM expense_claims WHERE tenant_id=? AND workspace_id=? AND id=?`);
    const found: ExpenseClaim[] = [];
    for (const id of ids) {
      const row = statement.get(scope.tenantId, scope.workspaceId, id);
      if (row !== undefined) found.push(parse(row['record_json'], deserializeExpenseClaim));
    }
    return found;
  }

  async list(scope: TenantScope, options?: ExpenseClaimListOptions): Promise<readonly ExpenseClaimSummary[]> {
    const where: string[] = ['c.tenant_id=?', 'c.workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('c.status=?'); params.push(options.status); }
    // 空の配列は「状態で絞らない」（カード候補の amounts と同じ扱い）。
    if (options?.statuses !== undefined && options.statuses.length > 0) { where.push(`c.status IN (${placeholders(options.statuses.length)})`); params.push(...options.statuses); }
    if (options?.verdict !== undefined) { where.push('c.verdict=?'); params.push(options.verdict); }
    if (options?.claimant !== undefined && options.claimant.trim() !== '') { where.push(`c.claimant_key LIKE ? ESCAPE '\\'`); params.push(likePattern(options.claimant)); }
    // 申請期間の重なり: 期間の終わりが from 以降で、始まりが to 以前。
    if (options?.from !== undefined) { where.push('c.period_to>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('c.period_from<=?'); params.push(options.to); }
    if (options?.employeeId !== undefined) { where.push('r.employee_id=?'); params.push(options.employeeId); }
    if (options?.departmentId !== undefined) { where.push('r.department_id=?'); params.push(options.departmentId); }
    if (options?.advanceId !== undefined) { where.push('r.advance_id=?'); params.push(options.advanceId); }
    // 派生行が無い申請（本来は埋め戻しで無くなる）も「紐付いていない」に数える。
    if (options?.unlinked === true) where.push('r.employee_id IS NULL');
    if (options?.awaitingEmployeeId !== undefined) {
      where.push('EXISTS (SELECT 1 FROM expense_claim_approvers a WHERE a.tenant_id=c.tenant_id AND a.workspace_id=c.workspace_id AND a.claim_id=c.id AND a.employee_id=?)');
      params.push(options.awaitingEmployeeId);
    }
    let sql = `SELECT c.record_json FROM expense_claims c
      LEFT JOIN expense_claim_refs r ON r.tenant_id=c.tenant_id AND r.workspace_id=c.workspace_id AND r.claim_id=c.id
      WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => toExpenseClaimSummary(parse(row['record_json'], deserializeExpenseClaim)));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.database.transaction(() => {
      this.db.prepare(`DELETE FROM expense_item_keys WHERE tenant_id=? AND workspace_id=? AND claim_id=?`).run(scope.tenantId, scope.workspaceId, id);
      for (const table of DERIVED_CLAIM_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND workspace_id=? AND claim_id=?`).run(scope.tenantId, scope.workspaceId, id);
      const result = this.db.prepare(`DELETE FROM expense_claims WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
      return Number(result.changes) > 0;
    });
  }

  async findDuplicateCandidates(scope: TenantScope, query: DuplicateCandidateQuery): Promise<readonly DuplicateCandidate[]> {
    const keys = [...new Map(query.keys.map((key) => [`${key.transactionDate}|${key.amount}`, key])).values()];
    const sha256s = [...new Set(query.sha256s)];
    if (keys.length === 0 && sha256s.length === 0) return [];
    const matches: string[] = [];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    let exclude = '';
    if (query.excludeClaimId !== undefined) { exclude = ' AND k.claim_id<>?'; params.push(query.excludeClaimId); }
    for (const key of keys) { matches.push('(k.transaction_date=? AND k.amount=?)'); params.push(key.transactionDate, key.amount); }
    if (sha256s.length > 0) { matches.push(`k.receipt_sha256 IN (${placeholders(sha256s.length)})`); params.push(...sha256s); }
    const rows = this.db.prepare(
      `SELECT k.claim_id, k.item_id, k.transaction_date, k.amount, k.payee_key, k.category_id, k.receipt_sha256, c.status, json_extract(c.record_json, '$.claimant.name') AS claimant_name
       FROM expense_item_keys k JOIN expense_claims c ON c.tenant_id=k.tenant_id AND c.workspace_id=k.workspace_id AND c.id=k.claim_id
       WHERE k.tenant_id=? AND k.workspace_id=?${exclude} AND (${matches.join(' OR ')})
       ORDER BY c.created_at ASC, k.claim_id ASC, k.item_id ASC`,
    ).all(...params);
    return rows.map((row) => ({
      claimId: String(row['claim_id']),
      itemId: String(row['item_id']),
      claimStatus: String(row['status']),
      claimantName: String(row['claimant_name'] ?? ''),
      ...(row['payee_key'] === null ? {} : { payeeKey: String(row['payee_key']) }),
      ...(row['transaction_date'] === null ? {} : { transactionDate: String(row['transaction_date']) }),
      ...(row['amount'] === null ? {} : { amount: Number(row['amount']) }),
      ...(row['category_id'] === null ? {} : { categoryId: String(row['category_id']) }),
      ...(row['receipt_sha256'] === null ? {} : { receiptSha256: String(row['receipt_sha256']) }),
    }));
  }

  async listItemFacts(scope: TenantScope, query: ExpenseItemFactQuery): Promise<readonly ExpenseItemFact[]> {
    const where: string[] = ['i.tenant_id=?', 'i.workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    // 範囲はすべて両端を含む文字列比較。値が無い行（NULL）は範囲を指定したら外れる。
    const ranges: readonly (readonly [string, string | undefined, '>=' | '<='])[] = [
      ['i.transaction_date', query.transactionFrom, '>='], ['i.transaction_date', query.transactionTo, '<='],
      ['r.approved_at', query.approvedFrom, '>='], ['r.approved_at', query.approvedTo, '<='],
      ['r.settled_at', query.settledFrom, '>='], ['r.settled_at', query.settledTo, '<='],
    ];
    for (const [column, value, operator] of ranges) {
      if (value !== undefined) { where.push(`${column}${operator}?`); params.push(value); }
    }
    if (query.statuses !== undefined && query.statuses.length > 0) { where.push(`c.status IN (${placeholders(query.statuses.length)})`); params.push(...query.statuses); }
    params.push(query.limit);
    // 申請の record_json は読まない（集計は明細の数だけ行があるので、画像や判定の本体を読むと重い）。
    const rows = this.db.prepare(
      `SELECT i.claim_id, i.item_id, c.status, i.transaction_date, i.amount, i.category_id, i.corporate,
         r.employee_id, r.department_id, r.claimant_name, r.department_text, r.approved_at, r.settled_at
       FROM expense_item_refs i
       JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.workspace_id=i.workspace_id AND c.id=i.claim_id
       JOIN expense_claim_refs r ON r.tenant_id=i.tenant_id AND r.workspace_id=i.workspace_id AND r.claim_id=i.claim_id
       WHERE ${where.join(' AND ')} ORDER BY i.claim_id ASC, i.item_id ASC LIMIT ?`,
    ).all(...params);
    return rows.map((row) => ({
      claimId: String(row['claim_id']),
      itemId: String(row['item_id']),
      status: String(row['status']) as ClaimStatus,
      ...optionalColumn('transactionDate', row['transaction_date']),
      ...(row['amount'] === null ? {} : { amount: Number(row['amount']) }),
      ...optionalColumn('categoryId', row['category_id']),
      corporate: Number(row['corporate']) === 1,
      ...optionalColumn('employeeId', row['employee_id']),
      ...optionalColumn('departmentId', row['department_id']),
      claimantName: String(row['claimant_name']),
      ...optionalColumn('departmentText', row['department_text']),
      ...optionalColumn('approvedAt', row['approved_at']),
      ...optionalColumn('settledAt', row['settled_at']),
    }));
  }

  async findCardCandidates(scope: TenantScope, query: CardCandidateQuery): Promise<readonly CardMatchableItem[]> {
    // 「金額がある」は判定と同じく 1 円以上（0 円以下の明細はカードの利用と照合しない）。
    const where: string[] = ['i.tenant_id=?', 'i.workspace_id=?', 'i.transaction_date IS NOT NULL', 'i.amount IS NOT NULL', 'i.amount>0', 'i.transaction_date>=?', 'i.transaction_date<=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId, query.from, query.to];
    if (query.amounts.length > 0) {
      where.push(`(${query.amounts.map(() => '(i.amount>=? AND i.amount<=?)').join(' OR ')})`);
      for (const range of query.amounts) params.push(range.min, range.max);
    }
    if (query.excludeClaimId !== undefined) { where.push('i.claim_id<>?'); params.push(query.excludeClaimId); }
    const rows = this.db.prepare(
      `SELECT i.claim_id, i.item_id, c.status, r.employee_id, i.transaction_date, i.amount, i.payee_key, i.corporate
       FROM expense_item_refs i
       JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.workspace_id=i.workspace_id AND c.id=i.claim_id
       LEFT JOIN expense_claim_refs r ON r.tenant_id=i.tenant_id AND r.workspace_id=i.workspace_id AND r.claim_id=i.claim_id
       WHERE ${where.join(' AND ')} ORDER BY i.transaction_date ASC, i.claim_id ASC, i.item_id ASC`,
    ).all(...params);
    return rows.map((row) => ({
      claimId: String(row['claim_id']),
      itemId: String(row['item_id']),
      claimStatus: String(row['status']),
      ...optionalColumn('employeeId', row['employee_id']),
      transactionDate: String(row['transaction_date']),
      amount: Number(row['amount']),
      ...optionalColumn('payeeKey', row['payee_key']),
      corporate: Number(row['corporate']) === 1,
    }));
  }
}

export class SqliteExpenseReceiptRepository extends SqliteRepositoryBase implements ExpenseReceiptRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(receipt: ExpenseReceipt): Promise<void> {
    this.db.prepare(
      `INSERT INTO expense_receipts (tenant_id, workspace_id, id, claim_id, item_id, sha256, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET claim_id=excluded.claim_id, item_id=excluded.item_id, sha256=excluded.sha256, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(receipt.tenant.tenantId, receipt.tenant.workspaceId, receipt.id, receipt.claimId, receipt.itemId, receipt.sha256, receipt.createdAt, json(serializeExpenseReceipt(receipt)));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseReceipt | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_receipts WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseReceipt);
  }

  async findByItem(scope: TenantScope, claimId: string, itemId: string): Promise<ExpenseReceipt | null> {
    const row = this.db.prepare(
      `SELECT record_json FROM expense_receipts WHERE tenant_id=? AND workspace_id=? AND claim_id=? AND item_id=? ORDER BY created_at DESC, id ASC LIMIT 1`,
    ).get(scope.tenantId, scope.workspaceId, claimId, itemId);
    return row === undefined ? null : parse(row['record_json'], deserializeExpenseReceipt);
  }

  async hashesByClaim(scope: TenantScope, claimId: string): Promise<ReadonlyMap<string, string>> {
    // 画像本体（record_json）は読まない。同じ明細に複数あれば新しい方が勝つよう古い順に積む。
    const rows = this.db.prepare(
      `SELECT item_id, sha256 FROM expense_receipts WHERE tenant_id=? AND workspace_id=? AND claim_id=? ORDER BY created_at ASC, id ASC`,
    ).all(scope.tenantId, scope.workspaceId, claimId);
    return new Map(rows.map((row) => [String(row['item_id']), String(row['sha256'])]));
  }

  async deleteByClaim(scope: TenantScope, claimId: string): Promise<number> {
    const result = this.db.prepare(`DELETE FROM expense_receipts WHERE tenant_id=? AND workspace_id=? AND claim_id=?`).run(scope.tenantId, scope.workspaceId, claimId);
    return Number(result.changes);
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM expense_receipts WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
    return Number(result.changes) > 0;
  }
}

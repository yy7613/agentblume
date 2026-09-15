/**
 * adapters層: 契約 BC の SQLite 永続化（テーブル定義は `contract-migrations.ts` の version 8）。
 *
 * 復元は必ず `deserialize*` を通す（壊れた行は黙って null にせず `ContractDomainError` で失敗させる）。
 * 締結済み契約の保存は、期限の投影（`contract_deadlines`）の削除 → 再挿入と**同じトランザクション**で行う。
 * 投影だけ古いまま残ると、台帳に消えたはずの期限が並ぶ（または新しい期限が出ない）。
 */
import { toContractDocumentSummary, type ContractDocument, type ContractDocumentSummary } from '../../domain/contract/document';
import type { Playbook } from '../../domain/contract/playbook';
import type {
  ContractDocumentListOptions, ContractDocumentRepository, ContractPlaybookRepository, ContractReviewRepository,
  DeadlineProjection, SignedContractListOptions, SignedContractRepository,
} from '../../domain/contract/repositories';
import type { ContractReview } from '../../domain/contract/review';
import {
  deserializeContractDocument, deserializeContractReview, deserializePlaybook, deserializeSignedContract,
  serializeContractDocument, serializeContractReview, serializePlaybook, serializeSignedContract,
} from '../../domain/contract/serialization';
import { counterpartyNameOf } from '../../domain/contract/document';
import type { DeadlineKind, SignedContract } from '../../domain/contract/signed-contract';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: unknown, deserialize: (raw: unknown) => T): T {
  return deserialize(JSON.parse(String(value)));
}

export class SqliteContractPlaybookRepository extends SqliteRepositoryBase implements ContractPlaybookRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(playbook: Playbook): Promise<void> {
    this.db.prepare(
      `INSERT INTO contract_playbooks (tenant_id, workspace_id, id, name, is_default, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET name=excluded.name, is_default=excluded.is_default, updated_at=excluded.updated_at, record_json=excluded.record_json`,
    ).run(playbook.tenant.tenantId, playbook.tenant.workspaceId, playbook.id, playbook.name, playbook.isDefault ? 1 : 0, playbook.updatedAt, json(serializePlaybook(playbook)));
  }

  async findById(scope: TenantScope, id: string): Promise<Playbook | null> {
    const row = this.db.prepare(`SELECT record_json FROM contract_playbooks WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializePlaybook);
  }

  async list(scope: TenantScope): Promise<readonly Playbook[]> {
    // created_at は列に持たないので本体から読んで並べる（件数は多くても数十）。
    const rows = this.db.prepare(`SELECT record_json FROM contract_playbooks WHERE tenant_id=? AND workspace_id=?`).all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => parse(row['record_json'], deserializePlaybook))
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM contract_playbooks WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
}

export class SqliteContractDocumentRepository extends SqliteRepositoryBase implements ContractDocumentRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(document: ContractDocument): Promise<void> {
    this.db.prepare(
      `INSERT INTO contract_documents (tenant_id, workspace_id, id, status, title, counterparty_name, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET status=excluded.status, title=excluded.title, counterparty_name=excluded.counterparty_name, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(document.tenant.tenantId, document.tenant.workspaceId, document.id, document.status, document.title, counterpartyNameOf(document) ?? null, document.createdAt, json(serializeContractDocument(document)));
  }

  async findById(scope: TenantScope, id: string): Promise<ContractDocument | null> {
    const row = this.db.prepare(`SELECT record_json FROM contract_documents WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeContractDocument);
  }

  async list(scope: TenantScope, options?: ContractDocumentListOptions): Promise<readonly ContractDocumentSummary[]> {
    const where = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    let sql = `SELECT record_json FROM contract_documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    return this.db.prepare(sql).all(...params).map((row) => toContractDocumentSummary(parse(row['record_json'], deserializeContractDocument)));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM contract_documents WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
  }
}

export class SqliteContractReviewRepository extends SqliteRepositoryBase implements ContractReviewRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(review: ContractReview): Promise<void> {
    this.db.prepare(
      `INSERT INTO contract_reviews (tenant_id, workspace_id, id, document_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET document_id=excluded.document_id, status=excluded.status, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(review.tenant.tenantId, review.tenant.workspaceId, review.id, review.documentId, review.status, review.createdAt, json(serializeContractReview(review)));
  }

  async findById(scope: TenantScope, id: string): Promise<ContractReview | null> {
    const row = this.db.prepare(`SELECT record_json FROM contract_reviews WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeContractReview);
  }

  async listByDocument(scope: TenantScope, documentId: string): Promise<readonly ContractReview[]> {
    return this.db.prepare(`SELECT record_json FROM contract_reviews WHERE tenant_id=? AND workspace_id=? AND document_id=? ORDER BY created_at DESC, id ASC`)
      .all(scope.tenantId, scope.workspaceId, documentId).map((row) => parse(row['record_json'], deserializeContractReview));
  }

  async deleteByDocument(scope: TenantScope, documentId: string): Promise<number> {
    return Number(this.db.prepare(`DELETE FROM contract_reviews WHERE tenant_id=? AND workspace_id=? AND document_id=?`).run(scope.tenantId, scope.workspaceId, documentId).changes);
  }
}

export class SqliteSignedContractRepository extends SqliteRepositoryBase implements SignedContractRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(contract: SignedContract): Promise<void> {
    const { tenantId, workspaceId } = contract.tenant;
    const transaction = this.database.enterTransaction();
    try {
      this.db.prepare(
        `INSERT INTO contract_signed_contracts (tenant_id, workspace_id, id, document_id, status, counterparty_name, signed_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET document_id=excluded.document_id, status=excluded.status, counterparty_name=excluded.counterparty_name, signed_date=excluded.signed_date, created_at=excluded.created_at, record_json=excluded.record_json`,
      ).run(tenantId, workspaceId, contract.id, contract.documentId, contract.status, contract.counterpartyName, contract.signedDate, contract.createdAt, json(serializeSignedContract(contract)));
      this.db.prepare(`DELETE FROM contract_deadlines WHERE tenant_id=? AND workspace_id=? AND contract_id=?`).run(tenantId, workspaceId, contract.id);
      const insert = this.db.prepare(`INSERT INTO contract_deadlines (tenant_id, workspace_id, contract_id, id, kind, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const deadline of contract.deadlines) insert.run(tenantId, workspaceId, contract.id, deadline.id, deadline.kind, deadline.dueDate, deadline.status);
      transaction.commit();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  async findById(scope: TenantScope, id: string): Promise<SignedContract | null> {
    const row = this.db.prepare(`SELECT record_json FROM contract_signed_contracts WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeSignedContract);
  }

  async findByDocument(scope: TenantScope, documentId: string): Promise<SignedContract | null> {
    const row = this.db.prepare(`SELECT record_json FROM contract_signed_contracts WHERE tenant_id=? AND workspace_id=? AND document_id=?`).get(scope.tenantId, scope.workspaceId, documentId);
    return row === undefined ? null : parse(row['record_json'], deserializeSignedContract);
  }

  async list(scope: TenantScope, options?: SignedContractListOptions): Promise<readonly SignedContract[]> {
    const where = ['tenant_id=?', 'workspace_id=?'];
    const params: string[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    // 部分一致は LIKE の % / _ を逃がさずに済む instr で見る（InMemory の includes と同じ結果）。
    if (options?.counterparty !== undefined && options.counterparty !== '') { where.push('instr(lower(counterparty_name), lower(?)) > 0'); params.push(options.counterparty); }
    return this.db.prepare(`SELECT record_json FROM contract_signed_contracts WHERE ${where.join(' AND ')} ORDER BY signed_date DESC, id ASC`)
      .all(...params).map((row) => parse(row['record_json'], deserializeSignedContract));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const transaction = this.database.enterTransaction();
    try {
      this.db.prepare(`DELETE FROM contract_deadlines WHERE tenant_id=? AND workspace_id=? AND contract_id=?`).run(scope.tenantId, scope.workspaceId, id);
      const removed = Number(this.db.prepare(`DELETE FROM contract_signed_contracts WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id).changes) > 0;
      transaction.commit();
      return removed;
    } catch (error) {
      /* v8 ignore next 2 -- DELETE が失敗するのは接続が壊れたときだけ。巻き戻して投げ直す。 */
      transaction.rollback();
      throw error;
    }
  }

  async listOpenDeadlines(scope: TenantScope, options?: { readonly dueOnOrBefore?: string }): Promise<readonly DeadlineProjection[]> {
    const params: string[] = [scope.tenantId, scope.workspaceId];
    let sql = `SELECT contract_id, id, kind, due_date FROM contract_deadlines WHERE tenant_id=? AND workspace_id=? AND status='open'`;
    if (options?.dueOnOrBefore !== undefined) { sql += ' AND due_date<=?'; params.push(options.dueOnOrBefore); }
    sql += ' ORDER BY due_date ASC, contract_id ASC, id ASC';
    return this.db.prepare(sql).all(...params).map((row) => ({ contractId: String(row['contract_id']), deadlineId: String(row['id']), kind: String(row['kind']) as DeadlineKind, dueDate: String(row['due_date']) }));
  }
}

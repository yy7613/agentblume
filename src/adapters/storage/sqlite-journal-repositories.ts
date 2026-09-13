/**
 * adapters層: 仕訳 BC の SQLite 永続化（テーブル定義は `migrations.ts` の version 5）。
 *
 * 本体は `record_json`（domain の Serialized 型）で、**絞り込みと並びに使う値だけを列へ出す**。
 * 復元は必ず `deserialize*` を通す（保存済みデータにも create* と同じ不変条件を課す。
 * 壊れた行は黙って null にせず `JournalDomainError` で失敗させる — 静かに消えるより気づける方がよい）。
 *
 * 一覧の並びは `domain/journal/repositories.ts` の doc コメントが正本で、InMemory 実装と同じ結果になる
 * （共有契約テストが両方へ同じ検査をかける）。
 */
import { toJournalDocumentSummary, type JournalDocument, type JournalDocumentSummary } from '../../domain/journal/document';
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import type { JournalEntry } from '../../domain/journal/entry';
import type { HearingSession } from '../../domain/journal/hearing';
import type {
  ChartOfAccountsRepository, JournalDocumentListOptions, JournalDocumentRepository,
  JournalEntryListOptions, JournalEntryRepository, JournalHearingRepository, JournalRuleRepository,
} from '../../domain/journal/repositories';
import type { JournalRule } from '../../domain/journal/rule';
import {
  deserializeChartOfAccounts, deserializeHearingSession, deserializeJournalDocument,
  deserializeJournalEntry, deserializeJournalRule, serializeChartOfAccounts, serializeHearingSession,
  serializeJournalDocument, serializeJournalEntry, serializeJournalRule,
} from '../../domain/journal/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: unknown, deserialize: (raw: unknown) => T): T {
  return deserialize(JSON.parse(String(value)));
}

export class SqliteChartOfAccountsRepository extends SqliteRepositoryBase implements ChartOfAccountsRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async get(scope: TenantScope): Promise<ChartOfAccounts | null> {
    const row = this.db.prepare(`SELECT record_json FROM journal_chart WHERE tenant_id=? AND workspace_id=?`).get(scope.tenantId, scope.workspaceId);
    return row === undefined ? null : parse(row['record_json'], deserializeChartOfAccounts);
  }

  async save(scope: TenantScope, chart: ChartOfAccounts): Promise<void> {
    this.db.prepare(
      `INSERT INTO journal_chart (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET record_json=excluded.record_json`,
    ).run(scope.tenantId, scope.workspaceId, json(serializeChartOfAccounts(chart)));
  }
}

export class SqliteJournalDocumentRepository extends SqliteRepositoryBase implements JournalDocumentRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(document: JournalDocument): Promise<void> {
    // 範囲検索の列は要約と同じ規則（取引日が無ければ発行日）。どちらも無ければ NULL で範囲から外れる。
    const transactionDate = document.facts.transactionDate ?? document.facts.issueDate ?? null;
    this.db.prepare(
      `INSERT INTO journal_documents (tenant_id, workspace_id, id, kind, status, transaction_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET kind=excluded.kind, status=excluded.status, transaction_date=excluded.transaction_date, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(document.tenant.tenantId, document.tenant.workspaceId, document.id, document.kind, document.status, transactionDate, document.createdAt, json(serializeJournalDocument(document)));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalDocument | null> {
    const row = this.db.prepare(`SELECT record_json FROM journal_documents WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeJournalDocument);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly JournalDocument[]> {
    if (ids.length === 0) return [];
    const found = new Map<string, JournalDocument>();
    const statement = this.db.prepare(`SELECT id, record_json FROM journal_documents WHERE tenant_id=? AND workspace_id=? AND id=?`);
    for (const id of ids) {
      const row = statement.get(scope.tenantId, scope.workspaceId, id);
      if (row !== undefined) found.set(String(row['id']), parse(row['record_json'], deserializeJournalDocument));
    }
    // 戻り値は ids の順（見つかったものだけ）。
    return ids.map((id) => found.get(id)).filter((document): document is JournalDocument => document !== undefined);
  }

  async list(scope: TenantScope, options?: JournalDocumentListOptions): Promise<readonly JournalDocumentSummary[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.kind !== undefined) { where.push('kind=?'); params.push(options.kind); }
    if (options?.from !== undefined) { where.push('transaction_date IS NOT NULL AND transaction_date>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('transaction_date IS NOT NULL AND transaction_date<=?'); params.push(options.to); }
    let sql = `SELECT record_json FROM journal_documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC`;
    if (options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    const rows = this.db.prepare(sql).all(...params);
    // 要約は本体から作る（data URL・原文・CSV 行はここで落ちる）。
    return rows.map((row) => toJournalDocumentSummary(parse(row['record_json'], deserializeJournalDocument)));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM journal_documents WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
    return Number(result.changes) > 0;
  }
}

export class SqliteJournalRuleRepository extends SqliteRepositoryBase implements JournalRuleRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(rule: JournalRule): Promise<void> {
    this.db.prepare(
      `INSERT INTO journal_rules (tenant_id, workspace_id, id, enabled, priority, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET enabled=excluded.enabled, priority=excluded.priority, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(rule.tenant.tenantId, rule.tenant.workspaceId, rule.id, rule.enabled ? 1 : 0, rule.priority, rule.createdAt, json(serializeJournalRule(rule)));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalRule | null> {
    const row = this.db.prepare(`SELECT record_json FROM journal_rules WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeJournalRule);
  }

  async list(scope: TenantScope): Promise<readonly JournalRule[]> {
    const rows = this.db.prepare(
      `SELECT record_json FROM journal_rules WHERE tenant_id=? AND workspace_id=? ORDER BY priority DESC, created_at ASC, id ASC`,
    ).all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => parse(row['record_json'], deserializeJournalRule));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM journal_rules WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
    return Number(result.changes) > 0;
  }
}

export class SqliteJournalEntryRepository extends SqliteRepositoryBase implements JournalEntryRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(entry: JournalEntry): Promise<void> {
    this.db.prepare(
      `INSERT INTO journal_entries (tenant_id, workspace_id, id, document_id, status, entry_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET document_id=excluded.document_id, status=excluded.status, entry_date=excluded.entry_date, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(entry.tenant.tenantId, entry.tenant.workspaceId, entry.id, entry.documentId ?? null, entry.status, entry.date, entry.createdAt, json(serializeJournalEntry(entry)));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalEntry | null> {
    const row = this.db.prepare(`SELECT record_json FROM journal_entries WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeJournalEntry);
  }

  async list(scope: TenantScope, options?: JournalEntryListOptions): Promise<readonly JournalEntry[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.status !== undefined) { where.push('status=?'); params.push(options.status); }
    if (options?.documentId !== undefined) { where.push('document_id=?'); params.push(options.documentId); }
    if (options?.from !== undefined) { where.push('entry_date>=?'); params.push(options.from); }
    if (options?.to !== undefined) { where.push('entry_date<=?'); params.push(options.to); }
    const rows = this.db.prepare(
      `SELECT record_json FROM journal_entries WHERE ${where.join(' AND ')} ORDER BY entry_date ASC, created_at ASC, id ASC`,
    ).all(...params);
    return rows.map((row) => parse(row['record_json'], deserializeJournalEntry));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM journal_entries WHERE tenant_id=? AND workspace_id=? AND id=?`).run(scope.tenantId, scope.workspaceId, id);
    return Number(result.changes) > 0;
  }
}

export class SqliteJournalHearingRepository extends SqliteRepositoryBase implements JournalHearingRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(session: HearingSession): Promise<void> {
    this.db.prepare(
      `INSERT INTO journal_hearings (tenant_id, workspace_id, id, document_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET document_id=excluded.document_id, status=excluded.status, created_at=excluded.created_at, record_json=excluded.record_json`,
    ).run(session.tenant.tenantId, session.tenant.workspaceId, session.id, session.documentId, session.status, session.createdAt, json(serializeHearingSession(session)));
  }

  async findById(scope: TenantScope, id: string): Promise<HearingSession | null> {
    const row = this.db.prepare(`SELECT record_json FROM journal_hearings WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json'], deserializeHearingSession);
  }

  async findByDocument(scope: TenantScope, documentId: string): Promise<readonly HearingSession[]> {
    const rows = this.db.prepare(
      `SELECT record_json FROM journal_hearings WHERE tenant_id=? AND workspace_id=? AND document_id=? ORDER BY created_at DESC, id ASC`,
    ).all(scope.tenantId, scope.workspaceId, documentId);
    return rows.map((row) => parse(row['record_json'], deserializeHearingSession));
  }

  async list(scope: TenantScope): Promise<readonly HearingSession[]> {
    const rows = this.db.prepare(
      `SELECT record_json FROM journal_hearings WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC, id ASC`,
    ).all(scope.tenantId, scope.workspaceId);
    return rows.map((row) => parse(row['record_json'], deserializeHearingSession));
  }
}
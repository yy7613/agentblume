/**
 * 仕訳 BC の5つのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `journal-*-repository.contract.ts`（実装に依存しない検査）。ここでは両実装へ同じ契約を
 * かけたうえで、SQLite にしか無い性質（絞り込み用の列へ値が出ているか・複合主キー・壊れた行の扱い）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { JournalDomainError } from '../../domain/journal/errors';
import {
  InMemoryChartOfAccountsRepository, InMemoryJournalDocumentRepository, InMemoryJournalEntryRepository,
  InMemoryJournalHearingRepository, InMemoryJournalRuleRepository,
} from './in-memory-journal-repositories';
import { chartOfAccountsRepositoryContract } from './journal-chart-repository.contract';
import { journalDocumentRepositoryContract } from './journal-document-repository.contract';
import { journalEntryRepositoryContract } from './journal-entry-repository.contract';
import { journalHearingRepositoryContract } from './journal-hearing-repository.contract';
import { documentFixture, entryFixture, hearingFixture, ruleFixture, scope } from './journal-repository.fixtures';
import { journalRuleRepositoryContract } from './journal-rule-repository.contract';
import { openSqliteDatabase } from './sqlite-database';
import {
  SqliteChartOfAccountsRepository, SqliteJournalDocumentRepository, SqliteJournalEntryRepository,
  SqliteJournalHearingRepository, SqliteJournalRuleRepository,
} from './sqlite-journal-repositories';

describe.each([
  ['科目マスタ', chartOfAccountsRepositoryContract, () => new InMemoryChartOfAccountsRepository(), () => new SqliteChartOfAccountsRepository()],
  ['文書', journalDocumentRepositoryContract, () => new InMemoryJournalDocumentRepository(), () => new SqliteJournalDocumentRepository()],
  ['ルール', journalRuleRepositoryContract, () => new InMemoryJournalRuleRepository(), () => new SqliteJournalRuleRepository()],
  ['仕訳', journalEntryRepositoryContract, () => new InMemoryJournalEntryRepository(), () => new SqliteJournalEntryRepository()],
  ['ヒアリング', journalHearingRepositoryContract, () => new InMemoryJournalHearingRepository(), () => new SqliteJournalHearingRepository()],
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
  it('文書: 絞り込み用の列（kind / status / transaction_date / created_at）を出す。取引日が無ければ発行日、どちらも無ければ NULL', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteJournalDocumentRepository(database);
    try {
      await repo.save(documentFixture('d1'));
      expect(database.handle.prepare(`SELECT kind, status, transaction_date, created_at FROM journal_documents WHERE id=?`).get('d1'))
        .toMatchObject({ kind: 'invoice', status: 'extracted', transaction_date: '2026-09-10', created_at: '2026-09-13T00:00:00.000Z' });

      // 取引日が無ければ発行日を出す（要約・範囲検索と同じ規則）。
      await repo.save(documentFixture('d2', { facts: { direction: 'out', issueDate: '2026-07-01', grandTotal: 100 } }));
      expect(database.handle.prepare(`SELECT transaction_date FROM journal_documents WHERE id=?`).get('d2')).toMatchObject({ transaction_date: '2026-07-01' });

      // どちらも無ければ NULL（範囲検索から外れる）。
      await repo.save(documentFixture('d3', { facts: { direction: 'out', grandTotal: 100 } }));
      expect(database.handle.prepare(`SELECT transaction_date FROM journal_documents WHERE id=?`).get('d3')).toMatchObject({ transaction_date: null });

      // 本体は record_json にあり、列には出さない（証憑本体で索引を太らせない）。
      const columns = database.handle.prepare(`PRAGMA table_info(journal_documents)`).all().map((row) => String(row['name']));
      expect(columns).toEqual(['tenant_id', 'workspace_id', 'id', 'kind', 'status', 'transaction_date', 'created_at', 'record_json']);
    } finally { database.close(); }
  });

  it('ルール / 仕訳 / ヒアリング: 並びと逆引きに使う列を出す（enabled は 0/1）', async () => {
    const database = openSqliteDatabase();
    const rules = new SqliteJournalRuleRepository(database);
    const entries = new SqliteJournalEntryRepository(database);
    const hearings = new SqliteJournalHearingRepository(database);
    try {
      await rules.save(ruleFixture('r1', { enabled: false, priority: 42 }));
      expect(database.handle.prepare(`SELECT enabled, priority, created_at FROM journal_rules WHERE id=?`).get('r1'))
        .toMatchObject({ enabled: 0, priority: 42, created_at: '2026-09-13T00:00:00.000Z' });

      await entries.save(entryFixture('e1', { status: 'confirmed', date: '2026-09-10' }));
      expect(database.handle.prepare(`SELECT document_id, status, entry_date FROM journal_entries WHERE id=?`).get('e1'))
        .toMatchObject({ document_id: 'doc-1', status: 'confirmed', entry_date: '2026-09-10' });
      // 文書に紐づかない手入力の仕訳は document_id が NULL。
      await entries.save(entryFixture('e2', { documentId: undefined, ruleId: undefined, decidedBy: 'manual' }));
      expect(database.handle.prepare(`SELECT document_id FROM journal_entries WHERE id=?`).get('e2')).toMatchObject({ document_id: null });

      await hearings.save(hearingFixture('h1'));
      expect(database.handle.prepare(`SELECT document_id, status FROM journal_hearings WHERE id=?`).get('h1'))
        .toMatchObject({ document_id: 'doc-1', status: 'open' });
    } finally { database.close(); }
  });

  it('境界: 同じ id を別ワークスペースへ保存しても衝突しない（複合主キー）。科目マスタは id を持たずスコープが鍵', async () => {
    const database = openSqliteDatabase();
    const documents = new SqliteJournalDocumentRepository(database);
    const charts = new SqliteChartOfAccountsRepository(database);
    const other = { tenantId: 'tenant', workspaceId: 'other' };
    try {
      await documents.save(documentFixture('shared'));
      await documents.save(documentFixture('shared', { tenant: other, kind: 'receipt' }));
      expect((await documents.findById(scope, 'shared'))?.kind).toBe('invoice');
      expect((await documents.findById(other, 'shared'))?.kind).toBe('receipt');
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM journal_documents`).get()).toMatchObject({ n: 2 });

      await charts.save(scope, (await import('./journal-repository.fixtures')).chartFixture());
      await charts.save(other, (await import('./journal-repository.fixtures')).chartFixture({ updatedAt: '2026-09-20T00:00:00.000Z' }));
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM journal_chart`).get()).toMatchObject({ n: 2 });
      expect((await charts.get(other))?.updatedAt).toBe('2026-09-20T00:00:00.000Z');
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json は読み出し時に JournalDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const documents = new SqliteJournalDocumentRepository(database);
    const rules = new SqliteJournalRuleRepository(database);
    const entries = new SqliteJournalEntryRepository(database);
    const hearings = new SqliteJournalHearingRepository(database);
    const charts = new SqliteChartOfAccountsRepository(database);
    try {
      const broken = JSON.stringify({ id: 'broken' });
      database.handle.prepare(`INSERT INTO journal_chart (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)`).run(scope.tenantId, scope.workspaceId, broken);
      database.handle.prepare(`INSERT INTO journal_documents (tenant_id, workspace_id, id, kind, status, transaction_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'invoice', 'extracted', null, '2026-09-13T00:00:00.000Z', broken);
      database.handle.prepare(`INSERT INTO journal_rules (tenant_id, workspace_id, id, enabled, priority, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 1, 0, '2026-09-13T00:00:00.000Z', broken);
      database.handle.prepare(`INSERT INTO journal_entries (tenant_id, workspace_id, id, document_id, status, entry_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', null, 'draft', '2026-09-10', '2026-09-13T00:00:00.000Z', broken);
      database.handle.prepare(`INSERT INTO journal_hearings (tenant_id, workspace_id, id, document_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.workspaceId, 'broken', 'doc-1', 'open', '2026-09-13T00:00:00.000Z', broken);

      await expect(charts.get(scope)).rejects.toThrow(JournalDomainError);
      await expect(documents.findById(scope, 'broken')).rejects.toThrow(JournalDomainError);
      await expect(documents.list(scope)).rejects.toThrow(JournalDomainError);
      await expect(documents.findByIds(scope, ['broken'])).rejects.toThrow(JournalDomainError);
      await expect(rules.findById(scope, 'broken')).rejects.toThrow(JournalDomainError);
      await expect(rules.list(scope)).rejects.toThrow(JournalDomainError);
      await expect(entries.findById(scope, 'broken')).rejects.toThrow(JournalDomainError);
      await expect(entries.list(scope)).rejects.toThrow(JournalDomainError);
      await expect(hearings.findById(scope, 'broken')).rejects.toThrow(JournalDomainError);
      await expect(hearings.list(scope)).rejects.toThrow(JournalDomainError);
      await expect(hearings.findByDocument(scope, 'doc-1')).rejects.toThrow(JournalDomainError);
    } finally { database.close(); }
  });
});
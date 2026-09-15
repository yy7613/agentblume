/**
 * 契約 BC の 4 つのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `contract-*-repository.contract.ts`（業務名 contract と共有契約の命名が重なるので集約名を挟む）。
 * ここでは両実装へ同じ契約をかけたうえで、SQLite にしか無い性質（期限の投影が契約の保存と同一トランザクション・
 * 絞り込み用の列・一意索引・壊れた行・migration v8）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { ContractDomainError } from '../../domain/contract/errors';
import { contractDocumentRepositoryContract } from './contract-document-repository.contract';
import { CONTRACT_MIGRATION, CONTRACT_STATEMENTS } from './contract-migrations';
import { contractPlaybookRepositoryContract } from './contract-playbook-repository.contract';
import { contractReviewRepositoryContract } from './contract-review-repository.contract';
import { deadlinesFixture, documentFixture, playbookFixture, reviewFixture, scope, signedContractFixture } from './contract-repository.fixtures';
import { contractSignedRepositoryContract } from './contract-signed-repository.contract';
import {
  InMemoryContractDocumentRepository, InMemoryContractPlaybookRepository, InMemoryContractReviewRepository, InMemorySignedContractRepository,
} from './in-memory-contract-repositories';
import { LATEST_SCHEMA_VERSION } from './migrations';
import { openSqliteDatabase } from './sqlite-database';
import {
  SqliteContractDocumentRepository, SqliteContractPlaybookRepository, SqliteContractReviewRepository, SqliteSignedContractRepository,
} from './sqlite-contract-repositories';
import { SqliteUnitOfWork } from './sqlite-unit-of-work';

describe.each([
  ['審査基準', contractPlaybookRepositoryContract, () => new InMemoryContractPlaybookRepository(), () => new SqliteContractPlaybookRepository()],
  ['文書', contractDocumentRepositoryContract, () => new InMemoryContractDocumentRepository(), () => new SqliteContractDocumentRepository()],
  ['レビュー', contractReviewRepositoryContract, () => new InMemoryContractReviewRepository(), () => new SqliteContractReviewRepository()],
  ['締結済み契約', contractSignedRepositoryContract, () => new InMemorySignedContractRepository(), () => new SqliteSignedContractRepository()],
] as const)('契約 %s リポジトリ', (_name, contract, makeMemory, makeSqlite) => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await contract(makeMemory() as never);
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = makeSqlite();
    try { await contract(repo as never); } finally { repo.close(); }
  });
});

type ProjectionRow = { contract_id: string; id: string; kind: string; due_date: string; status: string };

describe('SQLite 固有の性質', () => {
  it('期限の投影: 保存で契約の deadlines[] がそのまま行になり、保存し直すと削除 → 再挿入される（done も行は残る）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteSignedContractRepository(database);
    const rows = (): ProjectionRow[] => database.handle.prepare(`SELECT contract_id, id, kind, due_date, status FROM contract_deadlines WHERE tenant_id=? AND workspace_id=? ORDER BY due_date, id`).all(scope.tenantId, scope.workspaceId) as unknown as ProjectionRow[];
    try {
      await repo.save(signedContractFixture('sc-1'));
      expect(rows()).toEqual([
        { contract_id: 'sc-1', id: 'renewal_notice-1', kind: 'renewal_notice', due_date: '2026-12-31', status: 'open' },
        { contract_id: 'sc-1', id: 'expiry-1', kind: 'expiry', due_date: '2027-03-31', status: 'open' },
        { contract_id: 'sc-1', id: 'renewal-1', kind: 'renewal', due_date: '2027-04-01', status: 'open' },
      ]);

      // 期限を 1 件減らし 1 件を完了にして保存すると、消えた期限の行は残らない。
      const [notice, expiry] = deadlinesFixture();
      await repo.save(signedContractFixture('sc-1', { deadlines: [{ ...notice!, status: 'done', completedAt: '2026-11-01T00:00:00.000Z' }, expiry!] }));
      expect(rows()).toEqual([
        { contract_id: 'sc-1', id: 'renewal_notice-1', kind: 'renewal_notice', due_date: '2026-12-31', status: 'done' },
        { contract_id: 'sc-1', id: 'expiry-1', kind: 'expiry', due_date: '2027-03-31', status: 'open' },
      ]);

      // 削除で投影も消える。
      expect(await repo.delete(scope, 'sc-1')).toBe(true);
      expect(rows()).toEqual([]);
    } finally { database.close(); }
  });

  it('期限の投影: 投影の挿入が途中で失敗したら、契約本体の上書きも投影の削除も巻き戻る（同一トランザクション）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteSignedContractRepository(database);
    try {
      const original = signedContractFixture('sc-1');
      await repo.save(original);
      // 投影の INSERT だけを失敗させる（契約の UPSERT と投影の DELETE は済んだ後で落ちる）。
      database.handle.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON contract_deadlines WHEN NEW.id = 'custom-boom' BEGIN SELECT RAISE(ABORT, 'projection insert failed'); END`);
      const broken = signedContractFixture('sc-1', { title: '上書きされてはいけない', deadlines: [deadlinesFixture()[1]!, { id: 'custom-boom', kind: 'custom', dueDate: '2026-10-01', basis: '失敗させる', status: 'open' }] });
      await expect(repo.save(broken)).rejects.toThrow('projection insert failed');

      expect(await repo.findById(scope, 'sc-1')).toEqual(original);
      expect((await repo.listOpenDeadlines(scope)).map((row) => row.deadlineId)).toEqual(['renewal_notice-1', 'expiry-1', 'renewal-1']);
      // 失敗の後も接続は使える（トランザクションが開きっぱなしにならない）。
      database.handle.exec('DROP TRIGGER fail_projection');
      await repo.save(broken);
      expect((await repo.findById(scope, 'sc-1'))?.title).toBe('上書きされてはいけない');
    } finally { database.close(); }
  });

  it('期限の投影: 外側の UnitOfWork が巻き戻れば、契約・投影・文書の書き込みがまとめて消える（SAVEPOINT で合流）', async () => {
    const database = openSqliteDatabase();
    const signed = new SqliteSignedContractRepository(database);
    const documents = new SqliteContractDocumentRepository(database);
    const unitOfWork = new SqliteUnitOfWork(database);
    try {
      await expect(unitOfWork.withTransaction(async () => {
        await signed.save(signedContractFixture('sc-1', { documentId: 'doc-1' }));
        await documents.save(documentFixture('doc-1', { status: 'signed', signedContractId: 'sc-1' }));
        throw new Error('rollback everything');
      })).rejects.toThrow('rollback everything');
      expect(await signed.findById(scope, 'sc-1')).toBeNull();
      expect(await signed.listOpenDeadlines(scope)).toEqual([]);
      expect(await documents.findById(scope, 'doc-1')).toBeNull();
    } finally { database.close(); }
  });

  it('一意性: 1 文書 1 契約を DB の一意索引でも止める（別 id・同じ文書は UNIQUE 違反）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteSignedContractRepository(database);
    try {
      await repo.save(signedContractFixture('sc-1', { documentId: 'doc-1' }));
      await expect(repo.save(signedContractFixture('sc-2', { documentId: 'doc-1' }))).rejects.toThrow(/UNIQUE constraint failed/u);
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM contract_signed_contracts`).get()).toMatchObject({ n: 1 });
      expect(database.handle.prepare(`SELECT COUNT(*) AS n FROM contract_deadlines`).get()).toMatchObject({ n: 3 });
    } finally { database.close(); }
  });

  it('絞り込み用の列: 文書の相手方名（自社未設定なら NULL）・審査基準の is_default（0/1）・締結済み契約の列を出す', async () => {
    const database = openSqliteDatabase();
    const playbooks = new SqliteContractPlaybookRepository(database);
    const documents = new SqliteContractDocumentRepository(database);
    const reviews = new SqliteContractReviewRepository(database);
    const signed = new SqliteSignedContractRepository(database);
    try {
      await playbooks.save(playbookFixture('pb-1', { isDefault: true, updatedAt: '2026-09-14T00:00:00.000Z' }));
      await playbooks.save(playbookFixture('pb-2'));
      expect(database.handle.prepare(`SELECT id, name, is_default, updated_at FROM contract_playbooks ORDER BY id`).all())
        .toEqual([{ id: 'pb-1', name: '業務委託（発注者側）', is_default: 1, updated_at: '2026-09-14T00:00:00.000Z' }, { id: 'pb-2', name: '業務委託（発注者側）', is_default: 0, updated_at: '2026-09-13T00:00:00.000Z' }]);

      await documents.save(documentFixture('doc-1', { status: 'confirmed' }));
      await documents.save(documentFixture('doc-2', { ourParty: undefined }));
      expect(database.handle.prepare(`SELECT id, status, title, counterparty_name, created_at FROM contract_documents ORDER BY id`).all()).toEqual([
        { id: 'doc-1', status: 'confirmed', title: '業務委託契約書 doc-1', counterparty_name: '架空テック合同会社', created_at: '2026-09-13T00:00:00.000Z' },
        { id: 'doc-2', status: 'imported', title: '業務委託契約書 doc-2', counterparty_name: null, created_at: '2026-09-13T00:00:00.000Z' },
      ]);

      await reviews.save(reviewFixture('rv-1', { status: 'finalized', results: [{ topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [], recommendedTexts: [], humanDecision: 'accept' }], finalizedAt: '2026-09-13T00:00:00.000Z' }));
      expect(database.handle.prepare(`SELECT document_id, status, created_at FROM contract_reviews WHERE id='rv-1'`).get()).toMatchObject({ document_id: 'doc-1', status: 'finalized' });

      await signed.save(signedContractFixture('sc-1'));
      expect(database.handle.prepare(`SELECT document_id, status, counterparty_name, signed_date, created_at FROM contract_signed_contracts WHERE id='sc-1'`).get())
        .toMatchObject({ document_id: 'doc-sc-1', status: 'active', counterparty_name: '架空テック合同会社', signed_date: '2026-03-15' });
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json は読み出し時に ContractDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const playbooks = new SqliteContractPlaybookRepository(database);
    const documents = new SqliteContractDocumentRepository(database);
    const reviews = new SqliteContractReviewRepository(database);
    const signed = new SqliteSignedContractRepository(database);
    try {
      const broken = JSON.stringify({ id: 'broken' });
      const at = '2026-09-13T00:00:00.000Z';
      database.handle.prepare(`INSERT INTO contract_playbooks (tenant_id, workspace_id, id, name, is_default, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'x', 0, at, broken);
      database.handle.prepare(`INSERT INTO contract_documents (tenant_id, workspace_id, id, status, title, counterparty_name, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'imported', 'x', null, at, broken);
      database.handle.prepare(`INSERT INTO contract_reviews (tenant_id, workspace_id, id, document_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'doc-broken', 'draft', at, broken);
      database.handle.prepare(`INSERT INTO contract_signed_contracts (tenant_id, workspace_id, id, document_id, status, counterparty_name, signed_date, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'doc-broken', 'active', 'x', '2026-01-01', at, broken);
      // 形は合っていても値の不変条件（空の topics）に反する行も、create* で落とす。
      const invalid = JSON.stringify({ ...playbookFixture('invalid'), topics: [] });
      database.handle.prepare(`INSERT INTO contract_playbooks (tenant_id, workspace_id, id, name, is_default, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'invalid', 'x', 0, at, invalid);

      await expect(playbooks.findById(scope, 'broken')).rejects.toThrow(ContractDomainError);
      await expect(playbooks.findById(scope, 'invalid')).rejects.toThrow(ContractDomainError);
      await expect(playbooks.list(scope)).rejects.toThrow(ContractDomainError);
      await expect(documents.findById(scope, 'broken')).rejects.toThrow(ContractDomainError);
      await expect(documents.list(scope)).rejects.toThrow(ContractDomainError);
      await expect(reviews.findById(scope, 'broken')).rejects.toThrow(ContractDomainError);
      await expect(reviews.listByDocument(scope, 'doc-broken')).rejects.toThrow(ContractDomainError);
      await expect(signed.findById(scope, 'broken')).rejects.toThrow(ContractDomainError);
      await expect(signed.findByDocument(scope, 'doc-broken')).rejects.toThrow(ContractDomainError);
      await expect(signed.list(scope)).rejects.toThrow(ContractDomainError);
    } finally { database.close(); }
  });

  it('migration v8: 5 テーブルと索引（締結済み契約の文書は一意）を作り、流し直しても冪等', () => {
    expect(CONTRACT_MIGRATION.version).toBe(8);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    const database = openSqliteDatabase();
    try {
      expect(database.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      const names = (type: string) => database.handle.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name LIKE 'contract%' OR (type=? AND name LIKE 'idx_contract%') ORDER BY name`).all(type, type).map((row) => String(row['name']));
      expect(names('table')).toEqual(['contract_deadlines', 'contract_documents', 'contract_playbooks', 'contract_reviews', 'contract_signed_contracts']);
      expect(names('index').filter((name) => name.startsWith('idx_'))).toEqual([
        'idx_contract_deadlines_scope_due', 'idx_contract_documents_scope_status', 'idx_contract_reviews_scope_document', 'idx_contract_signed_scope_document', 'idx_contract_signed_scope_status',
      ]);
      const indexColumns = (index: string) => database.handle.prepare(`PRAGMA index_info(${index})`).all().map((row) => String(row['name']));
      expect(indexColumns('idx_contract_deadlines_scope_due')).toEqual(['tenant_id', 'workspace_id', 'status', 'due_date']);
      expect(indexColumns('idx_contract_signed_scope_document')).toEqual(['tenant_id', 'workspace_id', 'document_id']);
      const unique = database.handle.prepare(`PRAGMA index_list(contract_signed_contracts)`).all().find((row) => row['name'] === 'idx_contract_signed_scope_document');
      expect(unique?.['unique']).toBe(1);
      const primaryKey = database.handle.prepare(`PRAGMA table_info(contract_deadlines)`).all().filter((row) => Number(row['pk']) > 0).map((row) => String(row['name']));
      expect(primaryKey).toEqual(['tenant_id', 'workspace_id', 'contract_id', 'id']);

      // IF NOT EXISTS で書いてあるので、既にあるテーブルへ流し直しても落ちない（予約版の再適用に備える）。
      expect(() => CONTRACT_MIGRATION.apply(database.handle)).not.toThrow();
      expect(CONTRACT_STATEMENTS.every((statement) => /IF NOT EXISTS/u.test(statement))).toBe(true);
    } finally { database.close(); }
  });
});

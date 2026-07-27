/**
 * 共有SQLite接続のテスト。
 *
 * これまでリポジトリは23本の別々の接続を開いていたため、実ファイルDBの経路（PRAGMA・
 * 再起動をまたぐ往復・接続の所有権）はどこでも検証されていなかった。ここで固定する。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { defaultDatabasePath, MEMORY_DB_PATH, openSqliteDatabase, resolveSqliteDatabase } from './sqlite-database';
import { SqliteWikiRepository } from './sqlite-wiki-repository';
import { SqliteDataSourceRepository } from './sqlite-data-source-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const page = (id: string, body: string) => createWikiPage({ id, tenant: scope, title: id, tags: [], body, sourceRuns: [], updatedAt: '2026-07-01T00:00:00.000Z' });

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agentblume-shared-db-'));
  dbPath = join(directory, 'nested', 'agentblume.db');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** PRAGMA の戻り列名は項目ごとに違う（busy_timeout は `timeout`）ので最初の値を読む。 */
function pragma(database: ReturnType<typeof openSqliteDatabase>, name: string): unknown {
  const row = database.handle.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

describe('openSqliteDatabase', () => {
  it('ファイルDBでは親ディレクトリを作り、WAL / busy_timeout / foreign_keys を適用する', () => {
    const database = openSqliteDatabase(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(database.ephemeral).toBe(false);
      expect(String(pragma(database, 'journal_mode'))).toBe('wal');
      expect(Number(pragma(database, 'busy_timeout'))).toBe(5000);
      expect(Number(pragma(database, 'foreign_keys'))).toBe(1);
    } finally {
      database.close();
    }
  });

  it(':memory: では WAL を設定しない（意味がないため）が、他のPRAGMAは同じ', () => {
    const database = openSqliteDatabase(MEMORY_DB_PATH);
    try {
      expect(database.ephemeral).toBe(true);
      expect(String(pragma(database, 'journal_mode'))).not.toBe('wal');
      expect(Number(pragma(database, 'busy_timeout'))).toBe(5000);
      expect(Number(pragma(database, 'foreign_keys'))).toBe(1);
    } finally {
      database.close();
    }
  });

  it('実ファイルDBはプロセス（接続）をまたいでデータを保持する', async () => {
    const first = openSqliteDatabase(dbPath);
    await new SqliteWikiRepository(first).save(page('cohort', 'kept across restarts'));
    first.close();

    const second = openSqliteDatabase(dbPath);
    try {
      const found = await new SqliteWikiRepository(second).find(scope, 'cohort');
      expect(found?.body).toBe('kept across restarts');
    } finally {
      second.close();
    }
  });

  it('既定の保存先はホーム配下の ~/.agentblume/agentblume.db', () => {
    expect(defaultDatabasePath('/home/example')).toBe(join('/home/example', '.agentblume', 'agentblume.db'));
  });
});

describe('接続の所有権', () => {
  it('パス文字列を渡したリポジトリは自分の接続を所有し、close で閉じる', async () => {
    const repository = new SqliteWikiRepository(dbPath);
    repository.close();
    // 閉じた接続は再利用できない＝所有していた証拠。
    await expect(repository.find(scope, 'x')).rejects.toThrow(/database is not open/);
  });

  it('共有ハンドルを渡したリポジトリは close しても接続を閉じない', async () => {
    const database = openSqliteDatabase(dbPath);
    try {
      const wikis = new SqliteWikiRepository(database);
      const sources = new SqliteDataSourceRepository(database);
      await wikis.save(page('shared', 'body'));
      wikis.close(); // 借りているだけなので no-op。

      await sources.save({ id: 'file', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }, 'a,b\n');
      // 別リポジトリも同じ接続を見ているので、閉じられていないことが確認できる。
      expect(await new SqliteWikiRepository(database).find(scope, 'shared')).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('resolveSqliteDatabase は文字列を所有・ハンドルを非所有として返す', () => {
    const owned = resolveSqliteDatabase(MEMORY_DB_PATH);
    expect(owned.owned).toBe(true);
    const borrowed = resolveSqliteDatabase(owned.database);
    expect(borrowed.owned).toBe(false);
    expect(borrowed.database).toBe(owned.database);
    owned.database.close();
  });
});

describe('transaction', () => {
  it('例外で巻き戻し、成功でコミットする', async () => {
    const database = openSqliteDatabase(dbPath);
    try {
      const wikis = new SqliteWikiRepository(database);
      await wikis.save(page('kept', 'kept'));

      expect(() => database.transaction(() => {
        database.handle.prepare(`DELETE FROM wiki_pages WHERE id='kept'`).run();
        throw new Error('boom');
      })).toThrow('boom');
      expect(await wikis.find(scope, 'kept')).not.toBeNull();

      database.transaction(() => {
        database.handle.prepare(`DELETE FROM wiki_pages WHERE id='kept'`).run();
      });
      expect(await wikis.find(scope, 'kept')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('入れ子は SAVEPOINT になり、内側だけを巻き戻せる', () => {
    const database = openSqliteDatabase(dbPath);
    try {
      const insert = (id: string) => database.handle
        .prepare(`INSERT INTO wiki_pages (tenant_id, workspace_id, id, wiki_id, updated_at, definition_json) VALUES ('tenant','workspace',?,'default','2026-01-01T00:00:00.000Z','{}')`)
        .run(id);
      database.transaction(() => {
        insert('outer');
        expect(() => database.transaction(() => {
          insert('inner');
          throw new Error('inner failed');
        })).toThrow('inner failed');
      });
      const ids = database.handle.prepare(`SELECT id FROM wiki_pages ORDER BY id`).all().map((row) => String(row['id']));
      expect(ids).toEqual(['outer']);
    } finally {
      database.close();
    }
  });
});

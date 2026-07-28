/**
 * マイグレーションの回帰テスト。
 *
 * 旧実装では「列が無ければ ALTER TABLE」の分岐が12箇所あったが、テストは常に新規の
 * `:memory:` DBを開いていたため分岐は常に false で、**一度も実行されない死んだコード**だった。
 * ここでは一時ディレクトリの**実ファイルDB**を旧スキーマへ落としてから開き直し、
 * 補完が本当に走ること・既存行が保持されることを確かめる。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionArtifact } from '../../domain/session/session-artifact';
import { applyMigrations, BASELINE_COLUMNS, LATEST_SCHEMA_VERSION, readSchemaVersion, SchemaVersionError } from './migrations';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteSessionArtifactRepository } from './sqlite-session-artifact-repository';

const scope = { tenantId: 't', workspaceId: 'w' };

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agentblume-migrations-'));
  dbPath = join(directory, 'agentblume.db');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row['name'])));
}

function tablesOf(db: DatabaseSync): Set<string> {
  return new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => String(row['name'])));
}

/** version 1 到達後のDBを、列が足りない旧スキーマへ意図的に巻き戻す。 */
function downgradeToLegacySchema(db: DatabaseSync): void {
  // wiki_id を参照するインデックスがあると DROP COLUMN できない（旧DBにはそもそも無かった）。
  db.exec('DROP INDEX IF EXISTS idx_wiki_pages_scope_wiki_updated');
  for (const { table, column } of BASELINE_COLUMNS) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec('PRAGMA user_version = 0');
}

describe('applyMigrations', () => {
  it('空DBを最新版まで引き上げ、全テーブル・全インデックスを作る', () => {
    const database = openSqliteDatabase(dbPath);
    try {
      expect(database.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(readSchemaVersion(database.handle)).toBe(LATEST_SCHEMA_VERSION);
      const tables = tablesOf(database.handle);
      for (const expected of ['tools', 'agents', 'skills', 'runs', 'wiki_pages', 'session_artifacts', 'model_settings', 'mcp_servers']) {
        expect(tables.has(expected)).toBe(true);
      }
      const indexes = database.handle.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`).all().map((row) => String(row['name']));
      expect(indexes).toContain('idx_runs_scope_started');
      expect(indexes).toContain('idx_wiki_pages_scope_wiki_updated');
      // version 2: テナント横断の status 検索（起動時の孤児Run回収）用。
      expect(indexes).toContain('idx_runs_status');
      expect(indexes).toContain('idx_harness_runs_status');
      expect(indexes).toContain('idx_factory_runs_status');
      expect(indexes).toContain('idx_experiments_status');
    } finally {
      database.close();
    }
  });

  it('二度目の適用は何もしない（冪等）', () => {
    const database = openSqliteDatabase(dbPath);
    try {
      const second = applyMigrations(database.handle);
      expect(second).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION, applied: [] });
      // 開き直しても同じ（起動のたびにDDLが流れない）。
      const third = applyMigrations(database.handle);
      expect(third.applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('旧スキーマのDBを開くと不足列が補完され、既存行はそのまま残る', () => {
    // 1. 最新スキーマで作り、各テーブルへ行を入れる。
    const seeded = openSqliteDatabase(dbPath);
    seeded.handle.exec(`
      INSERT INTO tools (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES ('t','w','tool-1','1.0.0',1,0,0,'{}');
      INSERT INTO agents (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES ('t','w','agent-1','1.0.0',1,0,0,'{}');
      INSERT INTO skills (tenant_id, workspace_id, internal_id, version, major, minor, patch, definition_json) VALUES ('t','w','skill-1','1.0.0',1,0,0,'{}');
      INSERT INTO gate_policies (tenant_id, workspace_id, internal_id, version, major, minor, patch, record_json) VALUES ('t','w','gate-1','1.0.0',1,0,0,'{}');
      INSERT INTO wiki_pages (tenant_id, workspace_id, id, wiki_id, updated_at, definition_json) VALUES ('t','w','page-1','space-x','2026-01-01T00:00:00.000Z','{}');
      INSERT INTO session_artifacts (tenant_id, workspace_id, session_id, artifact_id, idempotency_key, created_at, size_bytes, record_json, payload_path) VALUES ('t','w','s','a','idem','2026-01-01T00:00:00.000Z',3,'{}','/tmp/x.json');
    `);
    seeded.close();

    // 2. 旧スキーマ（12列が欠けた状態）へ巻き戻す。
    const legacy = new DatabaseSync(dbPath);
    downgradeToLegacySchema(legacy);
    expect(columnsOf(legacy, 'tools').has('deleted')).toBe(false);
    expect(columnsOf(legacy, 'wiki_pages').has('wiki_id')).toBe(false);
    expect(readSchemaVersion(legacy)).toBe(0);
    legacy.close();

    // 3. 通常どおり開く＝マイグレーションが走る。
    const upgraded = openSqliteDatabase(dbPath);
    try {
      expect(upgraded.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      for (const { table, column } of BASELINE_COLUMNS) {
        expect(`${table}.${column}`).toBe(columnsOf(upgraded.handle, table).has(column) ? `${table}.${column}` : `${table}.<missing>`);
      }
      // 既存行は消えていない。補完された列には既定値が入る。
      const tool = upgraded.handle.prepare(`SELECT internal_id, deleted FROM tools`).get();
      expect(tool).toMatchObject({ internal_id: 'tool-1', deleted: 0 });
      expect(upgraded.handle.prepare(`SELECT internal_id, deleted FROM agents`).get()).toMatchObject({ internal_id: 'agent-1', deleted: 0 });
      expect(upgraded.handle.prepare(`SELECT internal_id, deleted FROM skills`).get()).toMatchObject({ internal_id: 'skill-1', deleted: 0 });
      expect(upgraded.handle.prepare(`SELECT internal_id, deleted FROM gate_policies`).get()).toMatchObject({ internal_id: 'gate-1', deleted: 0 });
      // 旧DBの wiki_id は失われている前提なので既定 'default' に寄せる（ページ自体は残る）。
      expect(upgraded.handle.prepare(`SELECT id, wiki_id FROM wiki_pages`).get()).toMatchObject({ id: 'page-1', wiki_id: 'default' });
      expect(upgraded.handle.prepare(`SELECT artifact_id, payload_path FROM session_artifacts`).get()).toMatchObject({ artifact_id: 'a', payload_path: null });
      // 補完後にしか作れないインデックスも復活している。
      const indexes = upgraded.handle.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((row) => String(row['name']));
      expect(indexes).toContain('idx_wiki_pages_scope_wiki_updated');
    } finally {
      upgraded.close();
    }
  });

  it('コードより新しい user_version のDBは起動を拒否する', () => {
    const database = openSqliteDatabase(dbPath);
    database.handle.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 5}`);
    database.close();

    expect(() => openSqliteDatabase(dbPath)).toThrow(SchemaVersionError);
    expect(() => openSqliteDatabase(dbPath)).toThrow(/newer than this build supports/);
  });

  it('マイグレーションが途中で失敗したらそのバージョンは丸ごと巻き戻る', () => {
    const db = new DatabaseSync(':memory:');
    try {
      // started_at を持たない runs を先に作っておくと、インデックス作成で必ず失敗する。
      db.exec('CREATE TABLE runs (tenant_id TEXT, workspace_id TEXT)');
      expect(() => applyMigrations(db)).toThrow(/started_at/);
      // 失敗したので user_version は 0 のまま＝次回も再試行される。
      expect(readSchemaVersion(db)).toBe(0);
      expect(tablesOf(db).has('tools')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('旧 payload_json 列を持つ session_artifacts', () => {
  it('列があれば読み書きの両方で面倒を見る（マイグレーションでは落とせない互換経路）', async () => {
    const database = openSqliteDatabase(dbPath);
    try {
      // v28試作のDB形（payload_json が NOT NULL）を再現する。
      database.handle.exec(`ALTER TABLE session_artifacts ADD COLUMN payload_json TEXT NOT NULL DEFAULT ''`);
      const repository = new SqliteSessionArtifactRepository(database, join(directory, 'payloads'));
      const artifact = createSessionArtifact({
        id: 'a', scope, sessionId: 's', name: 'data', kind: 'json', revision: 1,
        contentType: 'application/json', sizeBytes: 12, checksum: 'sum',
        origin: { runId: 'r', toolId: 'tool', toolVersion: '1.0.0', toolCallId: 'c', sinkNodeId: 'sink' },
        createdAt: '2026-07-11T01:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z',
      });
      // 書き込みは payload_json も埋める（NOT NULL 制約に触れずに済む）。
      await repository.save(artifact, { ok: true }, 'idem');
      expect(await repository.find(scope, 's', 'a')).toMatchObject({ payload: { ok: true } });

      // payload_path が空で payload_json にしか本文が無い旧行も読める。
      database.handle.prepare(`UPDATE session_artifacts SET payload_path='', payload_json=? WHERE artifact_id='a'`).run(JSON.stringify({ legacy: true }));
      expect(await repository.find(scope, 's', 'a')).toMatchObject({ payload: { legacy: true } });
    } finally {
      database.close();
    }
  });
});

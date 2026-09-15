/**
 * 業務ごとのスキーマ版（ADR-0039）の規律。
 *
 * 業務は並行して実装するので、版番号だけを予約した空の版（placeholder）が途中に残る。
 * その先まで版を刻むと、後から入った中身が「適用済み」と見なされて流れない。ここではそれが起きないことを固定する。
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, latestSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS, readSchemaVersion, SchemaVersionError } from './migrations';
import { statementMigration, type SchemaMigration } from './schema-migration';

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(':memory:'); });
afterEach(() => { db.close(); });

const table = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY)`;
const tables = () => new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => String(row['name'])));

describe('statementMigration', () => {
  it('正常: 文を順に流す版になり、予約版ではない', () => {
    const migration = statementMigration(1, 'one', [table('a'), table('b')]);
    expect(migration.placeholder).toBeUndefined();
    migration.apply(db);
    expect(tables()).toEqual(new Set(['a', 'b']));
  });

  it('境界: 文が無ければ予約版になり、流しても何もしない', () => {
    const migration = statementMigration(2, 'reserved', []);
    expect(migration.placeholder).toBe(true);
    migration.apply(db);
    expect(tables().size).toBe(0);
  });
});

describe('予約版を含むマイグレーション', () => {
  const one = statementMigration(1, 'one', [table('one')]);
  const reserved = statementMigration(2, 'reserved', []);
  const three = statementMigration(3, 'three', [table('three')]);

  it('正常: 予約版が無ければ最後の版まで刻む', () => {
    const migrations = [one, statementMigration(2, 'two', [table('two')])];
    expect(latestSchemaVersion(migrations)).toBe(2);
    expect(applyMigrations(db, migrations)).toEqual({ from: 0, to: 2, applied: [1, 2] });
  });

  it('境界: 予約版の先の版も適用するが、版は予約版の手前までしか刻まない', () => {
    const migrations = [one, reserved, three];
    expect(latestSchemaVersion(migrations)).toBe(1);
    expect(applyMigrations(db, migrations)).toEqual({ from: 0, to: 1, applied: [1] });
    expect(tables()).toEqual(new Set(['one', 'three']));
  });

  it('境界: 開き直すと予約版の先を冪等に流し直し、予約版に中身が入った時点で最後まで刻む', () => {
    applyMigrations(db, [one, reserved, three]);
    // 同じ構成で開き直す: 版は動かず、three は IF NOT EXISTS で流し直される（数えない）。
    expect(applyMigrations(db, [one, reserved, three])).toEqual({ from: 1, to: 1, applied: [] });
    // 予約版に中身が入った次のビルド: 2 のテーブルが作られ、3 まで刻まれる。
    const filled = [one, statementMigration(2, 'two', [table('two')]), three];
    expect(applyMigrations(db, filled)).toEqual({ from: 1, to: 3, applied: [2, 3] });
    expect(tables()).toEqual(new Set(['one', 'two', 'three']));
  });

  it('異常: 刻める版より新しいDBは開かない', () => {
    db.exec('PRAGMA user_version = 2');
    expect(() => applyMigrations(db, [one, reserved, three])).toThrow(SchemaVersionError);
    expect(readSchemaVersion(db)).toBe(2);
  });

  it('例外: 予約版の先の版が失敗したら、その版だけ巻き戻して投げる', () => {
    const broken: SchemaMigration = { version: 3, description: 'broken', apply(handle) { handle.exec(table('half')); throw new Error('boom'); } };
    expect(() => applyMigrations(db, [one, reserved, broken])).toThrow('boom');
    expect(tables()).toEqual(new Set(['one']));
    expect(readSchemaVersion(db)).toBe(1);
  });
});

describe('MIGRATIONS（業務の版の予約）', () => {
  it('版は 1 から欠番なく並び、仕訳=5・経費精算=6・入金消込=7・契約=8・経費精算の追加=9 が予約されている', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
    expect(MIGRATIONS.slice(4).map((migration) => [migration.version, migration.description.split(' ')[0]])).toEqual([
      [5, 'journal'], [6, 'expense'], [7, 'receivables'], [8, 'contract'], [9, 'expense'],
    ]);
  });

  it('LATEST_SCHEMA_VERSION は途切れずに中身のある版の最後', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(latestSchemaVersion(MIGRATIONS));
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });
});

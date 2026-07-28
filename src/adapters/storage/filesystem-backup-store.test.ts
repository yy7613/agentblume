import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBackupRoot, FilesystemBackupStore } from './filesystem-backup-store';
import { openSqliteDatabase } from './sqlite-database';
import { sessionArtifactDirectory } from './sqlite-session-artifact-repository';

let root: string;
const store = new FilesystemBackupStore();

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentblume-backup-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** WALが効いている状態のDBを作る（未チェックポイントのコミットを残す）。 */
function seedDatabase(path: string): DatabaseSync {
  const database = openSqliteDatabase(path);
  database.handle.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, value TEXT)');
  const insert = database.handle.prepare('INSERT INTO probe (value) VALUES (?)');
  for (let index = 0; index < 200; index += 1) insert.run(`row-${index}`);
  return database.handle;
}

describe('FilesystemBackupStore', () => {
  it('WALで動作中のDBを、開いたまま一貫したスナップショットとして書き出す', async () => {
    const source = join(root, 'agentblume.db');
    const handle = seedDatabase(source);
    try {
      expect(String(handle.prepare('PRAGMA journal_mode').get()?.['journal_mode'])).toBe('wal');
      const destination = join(root, 'snapshot.db');
      const stat = await store.snapshotDatabase(source, destination);
      expect(stat.files).toBe(1);
      expect(stat.bytes).toBeGreaterThan(0);

      // WALにしかないコミットまで含まれていること（ファイルコピーではここが欠ける）。
      const copy = new DatabaseSync(destination);
      try {
        expect(Number(copy.prepare('SELECT COUNT(*) AS count FROM probe').get()?.['count'])).toBe(200);
        // スキーマ版（PRAGMA user_version）もそのまま運ばれる。
        expect(Number(copy.prepare('PRAGMA user_version').get()?.['user_version'])).toBeGreaterThan(0);
      } finally { copy.close(); }

      // 取得後も現用DBは書き込みを続けられる（バックアップが接続を壊さない）。
      handle.exec("INSERT INTO probe (value) VALUES ('after-backup')");
      expect(Number(handle.prepare('SELECT COUNT(*) AS count FROM probe').get()?.['count'])).toBe(201);
    } finally { handle.close(); }
  });

  it('同じ出力先へ2回スナップショットしても壊れない（前回分を消してから書く）', async () => {
    const source = join(root, 'agentblume.db');
    const handle = seedDatabase(source);
    handle.close();
    const destination = join(root, 'snapshot.db');
    await store.snapshotDatabase(source, destination);
    const second = await store.snapshotDatabase(source, destination);
    expect(second.bytes).toBeGreaterThan(0);
    const copy = new DatabaseSync(destination);
    try { expect(Number(copy.prepare('SELECT COUNT(*) AS count FROM probe').get()?.['count'])).toBe(200); }
    finally { copy.close(); }
  });

  it('ディレクトリを入れ子ごとコピーし、件数とバイト数を数える', async () => {
    const source = join(root, 'artifacts');
    await mkdir(join(source, 'a', 'b'), { recursive: true });
    await writeFile(join(source, 'a', 'one.json'), '{"n":1}', 'utf8');
    await writeFile(join(source, 'a', 'b', 'two.jsonl'), '{"n":2}\n', 'utf8');

    const stat = await store.copyDirectory(source, join(root, 'copy'));
    expect(stat.files).toBe(2);
    expect(stat.bytes).toBe(15);
    expect(await readFile(join(root, 'copy', 'a', 'b', 'two.jsonl'), 'utf8')).toBe('{"n":2}\n');
  });

  it('存在しないディレクトリ・ファイルは 0件 / undefined として扱う（バックアップを失敗させない）', async () => {
    expect(await store.copyDirectory(join(root, 'missing'), join(root, 'empty'))).toEqual({ files: 0, bytes: 0 });
    expect(await store.exists(join(root, 'empty'))).toBe(true);
    expect(await store.copyFile(join(root, 'missing.key'), join(root, 'out.key'))).toBeUndefined();
    expect(await store.exists(join(root, 'out.key'))).toBe(false);
    expect(await store.listDirectories(join(root, 'missing'))).toEqual([]);
  });

  it('JSONを整形して往復させる', async () => {
    const path = join(root, 'nested', 'manifest.json');
    await store.writeJson(path, { formatVersion: 1, nested: { ok: true } });
    expect(await readFile(path, 'utf8')).toBe('{\n  "formatVersion": 1,\n  "nested": {\n    "ok": true\n  }\n}\n');
    expect(await store.readJson(path)).toEqual({ formatVersion: 1, nested: { ok: true } });
  });

  it('直下のディレクトリだけを名前順に返す', async () => {
    await mkdir(join(root, 'backups', 'backup-b'), { recursive: true });
    await mkdir(join(root, 'backups', 'backup-a'), { recursive: true });
    await writeFile(join(root, 'backups', 'note.txt'), 'x', 'utf8');
    expect(await store.listDirectories(join(root, 'backups'))).toEqual(['backup-a', 'backup-b']);
  });

  it('退避はDB本体とWALサイドカーを同じ接尾辞で連れて行く', async () => {
    const source = join(root, 'agentblume.db');
    const handle = seedDatabase(source);
    handle.close();
    // 停止済みDBではWALが消えることがあるため、退避対象の存在をテスト側で作って固定する。
    await writeFile(`${source}-wal`, 'stale', 'utf8');
    const moved = await store.moveAside(source, 'pre-restore-x');
    expect(moved).toBe(`${source}.pre-restore-x`);
    expect(await store.exists(`${source}.pre-restore-x`)).toBe(true);
    expect(await store.exists(`${source}.pre-restore-x-wal`)).toBe(true);
    expect(await store.exists(source)).toBe(false);
    expect(await store.moveAside(join(root, 'never-existed'), 'pre-restore-x')).toBeUndefined();
  });

  it('復元は古いWALを消してから置く（別世界のトランザクションを適用させない）', async () => {
    const backup = join(root, 'backup.db');
    const handle = seedDatabase(join(root, 'origin.db'));
    handle.close();
    await store.snapshotDatabase(join(root, 'origin.db'), backup);

    const target = join(root, 'restored.db');
    await writeFile(target, 'garbage', 'utf8');
    await writeFile(`${target}-wal`, 'stale wal', 'utf8');
    await writeFile(`${target}-shm`, 'stale shm', 'utf8');

    const stat = await store.restoreDatabase(backup, target);
    expect(stat.files).toBe(1);
    expect(await store.exists(`${target}-wal`)).toBe(false);
    expect(await store.exists(`${target}-shm`)).toBe(false);
    const restored = new DatabaseSync(target);
    try { expect(Number(restored.prepare('SELECT COUNT(*) AS count FROM probe').get()?.['count'])).toBe(200); }
    finally { restored.close(); }
  });

  it('復元先ディレクトリは丸ごと置き換える（前回の残骸を混ぜない）', async () => {
    const source = join(root, 'from');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'kept.json'), '1', 'utf8');
    const target = join(root, 'to');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.json'), '2', 'utf8');

    expect(await store.restoreDirectory(source, target)).toEqual({ files: 1, bytes: 1 });
    expect(await store.exists(join(target, 'kept.json'))).toBe(true);
    expect(await store.exists(join(target, 'stale.json'))).toBe(false);
    // バックアップにアーティファクトが無い場合は空ディレクトリを作るだけ。
    expect(await store.restoreDirectory(join(root, 'missing'), target)).toEqual({ files: 0, bytes: 0 });
    expect(await store.exists(target)).toBe(true);
  });

  it('使用中判定は、存在しないDBを「未使用」、書き込み中のDBを「使用中」と見る', async () => {
    const source = join(root, 'agentblume.db');
    expect(await store.isDatabaseInUse(source)).toBe(false);
    const handle = seedDatabase(source);
    try {
      expect(await store.isDatabaseInUse(source)).toBe(false);
      handle.exec('BEGIN IMMEDIATE');
      expect(await store.isDatabaseInUse(source)).toBe(true);
      handle.exec('ROLLBACK');
      expect(await store.isDatabaseInUse(source)).toBe(false);
    } finally { handle.close(); }
  });

  it('既定のバックアップ置き場・アーティファクト置き場はDBファイルの隣に決まる', () => {
    const database = join(root, 'agentblume.db');
    expect(defaultBackupRoot(database)).toBe(join(root, 'agentblume.db.backups'));
    expect(sessionArtifactDirectory(database)).toBe(join(root, 'agentblume.db.session-artifacts'));
  });
});

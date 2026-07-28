/**
 * adapters層: `BackupStorePort` のファイルシステム実装。
 *
 * ## SQLiteのオンラインバックアップ
 *
 * 稼働中のDBは WAL（`journal_mode = WAL`）で動いており、**直近のコミットは
 * `agentblume.db-wal` 側にしか無い**。したがって `agentblume.db` を `copyFile` すると、
 * コミット済みのデータが欠けた（最悪、ページの途中まで書かれた）スナップショットになる。
 * WAL・SHM を含めて3ファイルまとめてコピーしても、コピー中に書き込みが走れば整合しない。
 * **単純なファイルコピーは使えない**。
 *
 * `node:sqlite` は 2つの経路を提供する。
 *
 *   1. `backup(sourceDb, destPath)`（モジュール関数）— SQLite の Online Backup API。
 *      ページ単位でコピーし、途中で書き込みが入れば自動でやり直す。**これを第一候補にする**。
 *   2. `VACUUM INTO 'path'`（SQLite 3.27+）— 実行中に読み取りロックを取り、
 *      デフラグ済みの新しいDBを書き出す。`backup` が無い Node（22.15 未満）向けの退避経路。
 *
 * `backup` は `package.json` の `engines`（>= 22.9.0）が許す最小Nodeには**無いことがある**ため、
 * 起動時ではなく呼び出し時に存在を確認し、無ければ 2 へ落ちる。どちらもスナップショットは
 * 一貫しており、出力は WAL を含まない単一ファイルになる（そのまま別マシンへ持って行ける）。
 *
 * ## 復元での `-wal` / `-shm`
 *
 * 復元先に古い `agentblume.db-wal` が残っていると、SQLite は次回オープン時にそれを
 * **戻したばかりのDBへ適用してしまう**（別世界のトランザクションを重ねることになる）。
 * `restoreDatabase` は必ずサイドカーを消す。
 */
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import type { BackupStorePort } from '../../application/operations/backup';
import type { BackupCopyStat } from '../../domain/operations/backup';

/** WAL運用でDB本体に付随するサイドカー（復元時に消す対象）。 */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** `node:sqlite` の Online Backup API（Node 22.15 未満には無い）。 */
type SqliteBackupFn = (source: DatabaseSync, destination: string, options?: Record<string, unknown>) => Promise<number>;

function onlineBackup(): SqliteBackupFn | undefined {
  const candidate = (sqlite as unknown as { backup?: unknown }).backup;
  return typeof candidate === 'function' ? candidate as SqliteBackupFn : undefined;
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path, fsConstants.F_OK); return true; }
  catch { return false; }
}

export class FilesystemBackupStore implements BackupStorePort {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  /**
   * WALを含む一貫したスナップショットを書き出す。
   *
   * **別の接続**を開いて行うため、稼働中のサーバーが持つ共有ハンドルには触らない
   * （サーバーを止めずにバックアップできるのはこのため。WALは複数接続の同時読み書きを許す）。
   * `readOnly` で開かないのは、前回の異常終了でWALが残っている場合に
   * **読み取り専用接続ではWALを回収できず**、停止中のバックアップが取れなくなるためである。
   */
  async snapshotDatabase(sourcePath: string, destinationPath: string): Promise<BackupCopyStat> {
    await mkdir(dirname(destinationPath), { recursive: true });
    // 出力先が残っていると VACUUM INTO は失敗し、backup() は追記的に壊れる。必ず消してから書く。
    await rm(destinationPath, { force: true });
    const source = new DatabaseSync(sourcePath);
    try {
      const backup = onlineBackup();
      if (backup !== undefined) await backup(source, destinationPath);
      else source.prepare('VACUUM INTO ?').run(destinationPath);
    } finally {
      source.close();
    }
    return { files: 1, bytes: await sizeOf(destinationPath) };
  }

  async copyDirectory(sourcePath: string, destinationPath: string): Promise<BackupCopyStat> {
    await mkdir(destinationPath, { recursive: true });
    if (!await pathExists(sourcePath)) return { files: 0, bytes: 0 };
    return await copyTree(sourcePath, destinationPath);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<BackupCopyStat | undefined> {
    if (!await pathExists(sourcePath)) return undefined;
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return { files: 1, bytes: await sizeOf(destinationPath) };
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // 人が読んで確認する前提のファイルなので整形して書く（末尾改行つき）。
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }

  async listDirectories(root: string): Promise<readonly string[]> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { return []; } // 置き場がまだ無い＝バックアップ0件。エラーにしない。
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  }

  async exists(path: string): Promise<boolean> {
    return await pathExists(path);
  }

  async moveAside(path: string, suffix: string): Promise<string | undefined> {
    if (!await pathExists(path)) return undefined;
    const destination = `${path}.${suffix}`;
    await rename(path, destination);
    // DB本体を退避したなら、対になるサイドカーも同じ接尾辞で連れて行く（残すと次のDBへ適用される）。
    for (const sidecar of SQLITE_SIDECAR_SUFFIXES) {
      if (await pathExists(`${path}${sidecar}`)) await rename(`${path}${sidecar}`, `${destination}${sidecar}`);
    }
    return destination;
  }

  async restoreDatabase(sourcePath: string, destinationPath: string): Promise<BackupCopyStat> {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    // 古いWALを残すと、復元したDBへ**別世界のトランザクション**が適用されてしまう。
    for (const sidecar of SQLITE_SIDECAR_SUFFIXES) await rm(`${destinationPath}${sidecar}`, { force: true });
    return { files: 1, bytes: await sizeOf(destinationPath) };
  }

  async restoreDirectory(sourcePath: string, destinationPath: string): Promise<BackupCopyStat> {
    await rm(destinationPath, { recursive: true, force: true });
    await mkdir(destinationPath, { recursive: true });
    if (!await pathExists(sourcePath)) return { files: 0, bytes: 0 };
    return await copyTree(sourcePath, destinationPath);
  }

  /**
   * 復元先が他プロセスに握られていないかを**best-effort**で見る。
   *
   * `busy_timeout = 0` で `BEGIN EXCLUSIVE` を試し、SQLITE_BUSY なら使用中と判断する。
   * ただしWALでは**アイドルな読み手はロックを保持しない**ため、「起動しているが今は何もしていない」
   * サーバーは検出できない。あくまで分かりやすい事故（実行中のジョブがある最中の復元）を
   * 弾くための網であり、これが false を返したことは「安全である」ことの証明ではない。
   * 運用手順としては必ずプロセスを止めてから復元する（docs/17-operations-runbook.md）。
   */
  async isDatabaseInUse(path: string): Promise<boolean> {
    if (!await pathExists(path)) return false;
    let handle: DatabaseSync;
    try { handle = new DatabaseSync(path); }
    catch { return true; } // 開けない時点で誰かが排他で握っている（あるいは壊れている）。触らせない。
    try {
      handle.exec('PRAGMA busy_timeout = 0');
      handle.exec('BEGIN EXCLUSIVE');
      handle.exec('ROLLBACK');
      return false;
    } catch {
      return true;
    } finally {
      handle.close();
    }
  }
}

/** ディレクトリを再帰コピーし、コピーしたファイル数とバイト数を返す。 */
async function copyTree(sourcePath: string, destinationPath: string): Promise<BackupCopyStat> {
  let files = 0;
  let bytes = 0;
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(sourcePath, entry.name);
    const to = join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      const nested = await copyTree(from, to);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      await copyFile(from, to);
      files += 1;
      bytes += await sizeOf(to);
    }
    // シンボリックリンク等は辿らない（バックアップの範囲を管理下のファイルに限る）。
  }
  return { files, bytes };
}

/**
 * セッションアーティファクトの既定ディレクトリと同じ規則で、バックアップ置き場を決める。
 * DBの隣に置くのは「見つけやすさ」を優先した既定であり、
 * **別ドライブ・別マシンへ複製するのは利用者の運用**（runbookに明記）。
 */
export function defaultBackupRoot(databasePath: string): string {
  return join(dirname(resolve(databasePath)), `${basename(databasePath)}.backups`);
}

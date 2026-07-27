/**
 * adapters層: 共有SQLite接続（`node:sqlite` の `DatabaseSync`）。
 *
 * 以前は23個の `Sqlite*Repository` がそれぞれ `new DatabaseSync(path)` を実行していた。
 * 同じファイルに23本の接続がぶら下がるため、
 *
 *   - **リポジトリをまたぐトランザクションが原理的に書けない**
 *     （Factory Run は Tool→Skill→Agent を別接続へ順に書くので、途中でクラッシュすると孤児が残る）
 *   - 起動時PRAGMA（WAL / busy_timeout / foreign_keys）の適用箇所も23倍に散る
 *
 * という問題があった。ここで接続を1本に束ね、PRAGMAとマイグレーションを1箇所へ集約する。
 *
 * ## 移行のしかた（既存テストを壊さない）
 *
 * リポジトリのコンストラクタは従来どおり**パス文字列**も受け取れる（`SqliteDatabaseSource`）。
 * 文字列を渡した場合は自分専用の接続を開いて自分で閉じる（`owned = true`）。
 * Composition Root は共有ハンドル（`SqliteDatabase`）を渡し、`close()` は Root が1回だけ呼ぶ。
 * これにより200本以上ある既存テストの呼び出し形（`new SqliteXxxRepository()` /
 * `new SqliteXxxRepository(':memory:')`）は一切変更せずに済む。
 *
 * ## トランザクション
 *
 * `transaction()` / `enterTransaction()` は入れ子を SAVEPOINT で表現する。
 * 接続が1本になったことで、リポジトリ内部の `BEGIN`（`replaceAll` や `applyRetention`）が
 * 外側のトランザクションと衝突しうるため、**必ずここを経由**させる。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, LATEST_SCHEMA_VERSION } from './migrations';

/** 揮発（プロセス終了で消える）を意味する特別なパス。 */
export const MEMORY_DB_PATH = ':memory:';
/** 既定の保存先ディレクトリ（暗号鍵と同じ `~/.agentblume`）。 */
export const DEFAULT_DB_DIRECTORY_NAME = '.agentblume';
/** 既定のDBファイル名。 */
export const DEFAULT_DB_FILE_NAME = 'agentblume.db';

/** `AGENTCONTEXT_DB_PATH` も options も無いときの保存先。 */
export function defaultDatabasePath(home: string = homedir()): string {
  return join(home, DEFAULT_DB_DIRECTORY_NAME, DEFAULT_DB_FILE_NAME);
}

/** 開始済みトランザクション。commit / rollback はどちらか一度だけ効く。 */
export interface TransactionHandle {
  commit(): void;
  rollback(): void;
}

/** 共有DBハンドル。 */
export interface SqliteDatabase {
  /** 生の接続。リポジトリはこれに対してクエリを実行する。 */
  readonly handle: DatabaseSync;
  /** 開いたパス（`:memory:` を含む）。payload置き場の解決やログに使う。 */
  readonly path: string;
  /** `:memory:`（プロセス終了で消える）なら true。 */
  readonly ephemeral: boolean;
  /** マイグレーション適用後のスキーマ版。 */
  readonly schemaVersion: number;
  /** 同期の書き込みを1トランザクションで括る。入れ子は SAVEPOINT で同じ単位へ合流する。 */
  transaction<T>(work: () => T): T;
  /** 非同期処理を括るための低レベルAPI（`SqliteUnitOfWork` が使う）。 */
  enterTransaction(): TransactionHandle;
  close(): void;
}

/** パス文字列（自前で接続を開く）か、共有ハンドル（借りるだけ）か。 */
export type SqliteDatabaseSource = string | SqliteDatabase;

class SharedSqliteDatabase implements SqliteDatabase {
  readonly ephemeral: boolean;
  schemaVersion = 0;
  /** 入れ子の深さ。0 なら BEGIN、1以上なら SAVEPOINT。 */
  private depth = 0;

  constructor(readonly handle: DatabaseSync, readonly path: string) {
    this.ephemeral = path === MEMORY_DB_PATH;
  }

  enterTransaction(): TransactionHandle {
    const level = this.depth;
    const savepoint = `agentblume_sp_${level}`;
    this.handle.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    let settled = false;
    const finish = (rollback: boolean): void => {
      if (settled) return;
      settled = true;
      this.depth = level;
      if (level === 0) this.handle.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      else if (rollback) this.handle.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      else this.handle.exec(`RELEASE ${savepoint}`);
    };
    return { commit: () => finish(false), rollback: () => finish(true) };
  }

  transaction<T>(work: () => T): T {
    const transaction = this.enterTransaction();
    try {
      const result = work();
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}

/**
 * 接続を開き、起動時PRAGMAを適用してからマイグレーションを実行する。
 *
 * - `journal_mode = WAL`: ファイルDBのみ（`:memory:` では意味がないので設定しない）。
 *   読み取りが書き込みでブロックされなくなり、開発サーバーとCLIの併用でも詰まりにくい。
 * - `busy_timeout = 5000`: ロック競合を即時エラーではなく待ちにする。
 * - `foreign_keys = ON`: 将来のFK制約を有効にする（既定はOFF）。
 */
export function openSqliteDatabase(path: string = MEMORY_DB_PATH): SqliteDatabase {
  const ephemeral = path === MEMORY_DB_PATH;
  if (!ephemeral) mkdirSync(dirname(resolve(path)), { recursive: true });
  const handle = new DatabaseSync(path);
  try {
    if (!ephemeral) handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA foreign_keys = ON');
    const database = new SharedSqliteDatabase(handle, path);
    database.schemaVersion = applyMigrations(handle).to;
    return database;
  } catch (error) {
    handle.close();
    throw error;
  }
}

/** 文字列なら開き（所有する）、共有ハンドルならそのまま借りる。 */
export function resolveSqliteDatabase(
  source: SqliteDatabaseSource = MEMORY_DB_PATH,
): { readonly database: SqliteDatabase; readonly owned: boolean } {
  return typeof source === 'string'
    ? { database: openSqliteDatabase(source), owned: true }
    : { database: source, owned: false };
}

/**
 * 全 `Sqlite*Repository` の共通土台。
 *
 * スキーマ生成（旧 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`）は `migrations.ts` が持つので、
 * リポジトリはクエリだけを持つ。
 */
export abstract class SqliteRepositoryBase {
  /** 共有ハンドル（トランザクション・パス解決に使う）。 */
  protected readonly database: SqliteDatabase;
  /** クエリ用の生接続。 */
  protected readonly db: DatabaseSync;
  private readonly owned: boolean;

  protected constructor(source: SqliteDatabaseSource = MEMORY_DB_PATH) {
    const resolved = resolveSqliteDatabase(source);
    this.database = resolved.database;
    this.db = resolved.database.handle;
    this.owned = resolved.owned;
  }

  /** 自分で開いた接続だけを閉じる。共有ハンドルは Composition Root が1回だけ閉じる。 */
  close(): void {
    if (this.owned) this.database.close();
  }
}

export { LATEST_SCHEMA_VERSION };

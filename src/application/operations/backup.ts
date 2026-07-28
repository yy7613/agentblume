/**
 * application層: バックアップの作成・一覧・復元。
 *
 * ## 何をバックアップするのか
 *
 * agentblume の状態は**1ファイルに収まっていない**。
 *
 *   - `agentblume.db`（SQLite）… 定義・実行履歴・**暗号化済み**APIキー
 *   - `<db>.session-artifacts/` … セッションアーティファクトの実体（DBはカタログしか持たない）
 *   - `~/.agentblume/secret.key` … 暗号鍵。**既定ではバックアップに含めない**
 *
 * DBだけを戻すとアーティファクトの実体が無く、カタログだけが残って壊れる。だからこの2つは
 * 常に一緒に扱う。鍵を既定で含めないのは、「鍵と暗号文を別々に置く」という設計の目的
 * （DBだけが流出しても平文キーを復元できない）がバックアップで無効化されるのを防ぐため。
 * 含めるかどうかは明示的に選べる（含めた場合はマニフェストに記録し、呼び出し側へ警告を返す）。
 *
 * ## なぜファイルコピーではないのか
 *
 * 稼働中のDBは WAL モードで動いており、直近のコミットは `agentblume.db-wal` 側にしかない。
 * `agentblume.db` を `cp` すると**コミット済みのデータが欠けた**（あるいは中途半端な）
 * スナップショットになる。ここでは SQLite のオンラインバックアップAPIを使い、
 * WAL を含めた一貫したスナップショットを1ファイルへ書き出す（実装は `BackupStorePort`）。
 *
 * ## レイヤ
 *
 * ファイルシステムと `node:sqlite` への依存は `BackupStorePort` の裏側に閉じる。
 * ここに残るのは「何をどの順で置くか」「どの条件で拒否するか」という方針だけで、
 * それが fake ストアだけでテストできるということでもある。
 */
import { join } from 'node:path';
import {
  assertRestorableManifest,
  backupDirectoryName,
  BACKUP_ARTIFACTS_DIRECTORY_NAME,
  BACKUP_DATABASE_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  BACKUP_SECRET_KEY_FILE_NAME,
  createBackupManifest,
  parseBackupManifest,
  type BackupCopyStat,
  type BackupManifest,
} from '../../domain/operations/backup';
import { BackupNotFoundError, BackupValidationError } from '../../domain/operations/errors';
import { describeError, type LoggerPort } from './logger';

/** 揮発DBを表す特別なパス（`adapters/storage/sqlite-database.ts` と同じ値）。 */
const MEMORY_DATABASE_PATH = ':memory:';

/** バックアップ対象と保存先の実パス。composition が解決して渡す。 */
export interface BackupLocations {
  /** 現用のSQLiteファイル。`:memory:` ならバックアップは行えない。 */
  readonly databasePath: string;
  /** セッションアーティファクトの置き場（存在しないこともある）。 */
  readonly artifactsDirectory: string;
  /** 暗号鍵ファイル（揮発鍵の配線では undefined）。 */
  readonly secretKeyPath?: string;
  /** `backup-*` ディレクトリを作る親ディレクトリ。 */
  readonly backupRoot: string;
}

/**
 * ファイルシステムとSQLiteのオンラインバックアップを隠すPort。
 *
 * 1メソッド1操作の薄い粒度にしてあるのは、「どの順で何をするか」という判断を
 * ユースケース側に残すため（アダプタが方針を持つと、方針だけを差し替えたテストが書けなくなる）。
 */
export interface BackupStorePort {
  /** ディレクトリを作る（親も含めて）。既に在れば何もしない。 */
  createDirectory(path: string): Promise<void>;
  /** WALを含む一貫したスナップショットを1ファイルへ書く。**ファイルコピーではない**。 */
  snapshotDatabase(sourcePath: string, destinationPath: string): Promise<BackupCopyStat>;
  /** ディレクトリを再帰コピーする。source が無ければ `{ files: 0, bytes: 0 }`。 */
  copyDirectory(sourcePath: string, destinationPath: string): Promise<BackupCopyStat>;
  /** 単一ファイルをコピーする。source が無ければ undefined。 */
  copyFile(sourcePath: string, destinationPath: string): Promise<BackupCopyStat | undefined>;
  /** JSONを整形して書く。 */
  writeJson(path: string, value: unknown): Promise<void>;
  /** JSONを読む。読めない・壊れている場合は throw する。 */
  readJson(path: string): Promise<unknown>;
  /** 直下のディレクトリ名（名前昇順）。root が無ければ空配列。 */
  listDirectories(root: string): Promise<readonly string[]>;
  /** ファイル・ディレクトリの存在確認。 */
  exists(path: string): Promise<boolean>;
  /** 既存パスを `<path>.<suffix>` へ退避する。無ければ undefined（退避先を返す）。 */
  moveAside(path: string, suffix: string): Promise<string | undefined>;
  /** 復元: DBファイルを置き、**古い `-wal` / `-shm` を消す**。 */
  restoreDatabase(sourcePath: string, destinationPath: string): Promise<BackupCopyStat>;
  /** 復元: ディレクトリを丸ごと置く（source が無ければ空ディレクトリを作る）。 */
  restoreDirectory(sourcePath: string, destinationPath: string): Promise<BackupCopyStat>;
  /** 他プロセスがDBを掴んでいそうなら true（best-effort。詳細はアダプタのコメント）。 */
  isDatabaseInUse(path: string): Promise<boolean>;
}

/** 作成したバックアップ。 */
export interface CreatedBackup {
  /** ディレクトリ名（`backup-YYYYMMDD-HHMMSSmmm`）。 */
  readonly name: string;
  /** 出力先の絶対パス。 */
  readonly path: string;
  readonly manifest: BackupManifest;
  /**
   * 利用者へそのまま見せる注意書き。鍵を含めた場合など「成功したが気をつけること」を運ぶ。
   * 失敗ではないので例外にはしない。
   */
  readonly warnings: readonly string[];
}

/** 一覧の1件。マニフェストが読めなかったディレクトリも `manifest: undefined` で残す。 */
export interface BackupSummary {
  readonly name: string;
  readonly path: string;
  readonly manifest?: BackupManifest;
  /** マニフェストを読めなかった理由（読めた場合は undefined）。 */
  readonly problem?: string;
}

/** `CreateBackupUseCase.execute` の入力。 */
export interface CreateBackupInput {
  /**
   * 暗号鍵ファイルを同梱するか。既定 false。
   * true にすると、そのバックアップは**平文APIキーと同じ機密度**になる。
   */
  readonly includeSecretKey?: boolean;
}

/**
 * バックアップを1つ作る。
 *
 * 順序に意味がある。**マニフェストは最後に書く**（途中で失敗したディレクトリには
 * マニフェストが無く、一覧で「壊れている」と分かる。中途半端なものを正常扱いしない）。
 */
export class CreateBackupUseCase {
  constructor(
    private readonly store: BackupStorePort,
    private readonly locations: BackupLocations,
    private readonly schemaVersion: number,
    private readonly options: {
      readonly revision?: string;
      readonly node?: string;
      readonly now?: () => Date;
      readonly logger?: LoggerPort;
    } = {},
  ) {}

  async execute(input: CreateBackupInput = {}): Promise<CreatedBackup> {
    const source = this.locations.databasePath;
    if (source === MEMORY_DATABASE_PATH) {
      throw new BackupValidationError(
        'the database is in-memory (:memory:), so there is nothing to back up; set AGENTCONTEXT_DB_PATH to a file first',
      );
    }
    const createdAt = (this.options.now ?? (() => new Date()))();
    const name = backupDirectoryName(createdAt);
    const path = join(this.locations.backupRoot, name);
    await this.store.createDirectory(path);

    const database = await this.store.snapshotDatabase(source, join(path, BACKUP_DATABASE_FILE_NAME));
    const artifacts = await this.store.copyDirectory(this.locations.artifactsDirectory, join(path, BACKUP_ARTIFACTS_DIRECTORY_NAME));

    const warnings: string[] = [];
    let secretKeyIncluded = false;
    if (input.includeSecretKey === true) {
      const keyPath = this.locations.secretKeyPath;
      if (keyPath === undefined) {
        warnings.push('This deployment uses an ephemeral in-memory key, so there is no key file to include.');
      } else {
        const copied = await this.store.copyFile(keyPath, join(path, BACKUP_SECRET_KEY_FILE_NAME));
        secretKeyIncluded = copied !== undefined;
        warnings.push(secretKeyIncluded
          ? 'The secret key file is included. Treat this backup exactly like the plaintext API keys it can decrypt.'
          : 'No secret key file exists yet (no API key has been saved), so nothing was included.');
      }
    } else {
      warnings.push('The secret key file is NOT included. Saved API keys must be re-entered after restoring onto a machine with a different key.');
    }

    const manifest = createBackupManifest({
      createdAt,
      schemaVersion: this.schemaVersion,
      ...(this.options.revision === undefined ? {} : { revision: this.options.revision }),
      node: this.options.node ?? process.version,
      sourceDatabasePath: source,
      database,
      artifacts,
      secretKeyIncluded,
    });
    await this.store.writeJson(join(path, BACKUP_MANIFEST_FILE_NAME), manifest);
    this.options.logger?.info('backup created', { path, bytes: database.bytes + artifacts.bytes, secretKeyIncluded });
    return { name, path, manifest, warnings };
  }
}

/** バックアップ置き場の一覧。新しい順（ディレクトリ名が時刻順なので降順ソートで足りる）。 */
export class ListBackupsUseCase {
  constructor(private readonly store: BackupStorePort, private readonly locations: BackupLocations) {}

  async execute(): Promise<readonly BackupSummary[]> {
    const names = await this.store.listDirectories(this.locations.backupRoot);
    const summaries: BackupSummary[] = [];
    for (const name of [...names].sort().reverse()) {
      const path = join(this.locations.backupRoot, name);
      try {
        const manifest = parseBackupManifest(await this.store.readJson(join(path, BACKUP_MANIFEST_FILE_NAME)));
        summaries.push({ name, path, manifest });
      } catch (error) {
        // マニフェストが無い＝作成途中で落ちたディレクトリ。隠すと「消えた」と誤解されるので残す。
        summaries.push({ name, path, problem: describeError(error) });
      }
    }
    return summaries;
  }

  /** バックアップ置き場そのもののパス（UI・CLIの表示用）。 */
  root(): string {
    return this.locations.backupRoot;
  }
}

/** 復元の結果。 */
export interface RestoreResult {
  readonly name: string;
  readonly path: string;
  readonly manifest: BackupManifest;
  readonly database: BackupCopyStat;
  readonly artifacts: BackupCopyStat;
  /** 上書き前の現用データを退避したパス（無かった場合は undefined）。 */
  readonly movedAside: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * バックアップから現用の保存先へ戻す。
 *
 * **プロセスを止めてから実行する**前提のユースケースである（HTTP APIからは公開しない）。
 * 稼働中のプロセスはDBファイルを開いたまま握っており、その足元でファイルを差し替えると
 * 開いているハンドルと中身が食い違って壊れる。CLI（`npm run backup -- --restore`）から呼ぶ。
 *
 * 安全側の作法を3つ持つ。
 *   1. マニフェストを検証し、**このビルドより新しいスキーマなら拒否**する（`assertRestorableManifest`）。
 *   2. 復元先のDBが使用中に見えるなら拒否する（best-effort。アダプタのコメント参照）。
 *   3. 現用のDB・アーティファクトは**消さずに退避**する（`.pre-restore-<時刻>`）。
 *      「戻したら前より悪くなった」ときに引き返せる経路を必ず残す。
 */
export class RestoreBackupUseCase {
  constructor(
    private readonly store: BackupStorePort,
    private readonly locations: BackupLocations,
    private readonly supportedSchemaVersion: number,
    private readonly options: { readonly now?: () => Date; readonly logger?: LoggerPort } = {},
  ) {}

  async execute(nameOrPath: string): Promise<RestoreResult> {
    const target = this.locations.databasePath;
    if (target === MEMORY_DATABASE_PATH) {
      throw new BackupValidationError('the current database is in-memory (:memory:); set AGENTCONTEXT_DB_PATH to the file you want to restore into');
    }
    const path = nameOrPath.includes('/') || nameOrPath.includes('\\')
      ? nameOrPath
      : join(this.locations.backupRoot, nameOrPath);
    if (!await this.store.exists(path)) {
      throw new BackupNotFoundError(`backup not found: ${path}`);
    }

    let manifest: BackupManifest;
    try {
      manifest = parseBackupManifest(await this.store.readJson(join(path, BACKUP_MANIFEST_FILE_NAME)));
    } catch (error) {
      if (error instanceof BackupValidationError) throw error;
      throw new BackupValidationError(`backup manifest could not be read (${describeError(error)}); this backup is incomplete and must not be restored`);
    }
    assertRestorableManifest(manifest, this.supportedSchemaVersion);

    if (await this.store.isDatabaseInUse(target)) {
      throw new BackupValidationError('the database is currently in use; stop agentblume (and any CLI using the same database) before restoring');
    }

    const suffix = `pre-restore-${backupDirectoryName((this.options.now ?? (() => new Date()))()).replace('backup-', '')}`;
    const movedAside: string[] = [];
    for (const existing of [target, this.locations.artifactsDirectory]) {
      const moved = await this.store.moveAside(existing, suffix);
      if (moved !== undefined) movedAside.push(moved);
    }

    const database = await this.store.restoreDatabase(join(path, manifest.database.file), target);
    const artifacts = await this.store.restoreDirectory(join(path, manifest.artifacts.directory), this.locations.artifactsDirectory);

    const warnings: string[] = [];
    if (!manifest.secretKey.included) {
      warnings.push('This backup does not contain the secret key. If the key on this machine differs, saved API keys cannot be decrypted and must be re-entered.');
    } else {
      warnings.push(`The backup contains a secret key file. Copy it over the current key manually if you need the stored API keys: ${join(path, manifest.secretKey.file ?? BACKUP_SECRET_KEY_FILE_NAME)}`);
    }
    if (movedAside.length > 0) warnings.push(`The previous data was kept at: ${movedAside.join(', ')}`);
    this.options.logger?.info('backup restored', { path, target, bytes: database.bytes + artifacts.bytes });
    return { name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1), path, manifest, database, artifacts, movedAside, warnings };
  }
}

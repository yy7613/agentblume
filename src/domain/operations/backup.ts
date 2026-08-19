/**
 * domain層: バックアップの構造とマニフェスト。
 *
 * ## なぜ「1ファイル（zip/tar）」ではなく**ディレクトリ**なのか
 *
 * バックアップの実体は3つある。
 *
 *   1. SQLite の DB ファイル（定義・実行履歴・暗号化済みAPIキー）
 *   2. セッションアーティファクトの**実ファイル**（DBの外・`<db>.session-artifacts/`）
 *   3. （任意）秘密値の暗号鍵ファイル
 *
 * これを1ファイルへ束ねるには zip か tar が要る。Node の標準ライブラリには**アーカイバが無い**
 * （`node:zlib` は圧縮ストリームだけで、複数ファイルを束ねるコンテナ形式は持たない）。
 * 新しい依存を足すか、tar/zip のヘッダを自前で書くかの二択になるが、
 *
 *   - 依存追加は「バックアップのために依存を増やす」という本末転倒（復旧経路は依存が少ないほどよい）
 *   - 自前実装はロングパス名・タイムスタンプ・CRC・Zip64 の地雷を踏み続けることになる
 *
 * ため、どちらも採らない。**ディレクトリ出力**なら標準APIだけで完結し、中身をエクスプローラで
 * そのまま確認でき、復元は最悪コピーで済む。1ファイルが欲しい場合は利用者がOS標準のZIP機能で
 * ディレクトリごと固めればよい（runbook に手順を書く）。
 *
 * ## ディレクトリ構成
 *
 * ```
 * backup-20260728-093012345/
 *   manifest.json          … 本モジュールの BackupManifest
 *   agentblume.db          … オンラインバックアップ（WAL適用済みの単一ファイル）
 *   session-artifacts/     … セッションアーティファクトの実体
 *   secret.key             … --include-secret-key を指定したときだけ
 * ```
 *
 * ディレクトリ名は**辞書順＝時刻順**になるよう固定幅にする。`:` は Windows のファイル名に使えないため
 * ISO 文字列をそのまま使わない。
 */
import type { IsoDateTime } from '../shared/time';
import { BackupValidationError } from './errors';

/**
 * バックアップ形式の版。ディレクトリ構成・マニフェストの意味を変えたら上げる。
 * スキーマ版（`PRAGMA user_version`）とは独立した番号である点に注意。
 */
export const BACKUP_FORMAT_VERSION = 1;
/** バックアップディレクトリ直下のマニフェスト。 */
export const BACKUP_MANIFEST_FILE_NAME = 'manifest.json';
/** バックアップ内のDBファイル名（復元先のファイル名とは無関係）。 */
export const BACKUP_DATABASE_FILE_NAME = 'agentblume.db';
/** バックアップ内のセッションアーティファクト置き場。 */
export const BACKUP_ARTIFACTS_DIRECTORY_NAME = 'session-artifacts';
/** バックアップ内の暗号鍵ファイル名（含めた場合のみ存在する）。 */
export const BACKUP_SECRET_KEY_FILE_NAME = 'secret.key';
/** 生成するバックアップディレクトリ名の接頭辞。 */
export const BACKUP_DIRECTORY_PREFIX = 'backup-';

/** コピー結果の実測値（マニフェストへ載せ、復元時の目視確認に使う）。 */
export interface BackupCopyStat {
  readonly files: number;
  readonly bytes: number;
}

/** バックアップディレクトリに置く自己記述メタデータ。 */
export interface BackupManifest {
  /** `BACKUP_FORMAT_VERSION`。 */
  readonly formatVersion: number;
  /** 作成時刻（ISO8601）。 */
  readonly createdAt: IsoDateTime;
  /** 取得時点の `PRAGMA user_version`。復元時に「このビルドで開けるか」を判定する。 */
  readonly schemaVersion: number;
  /** `AGENTCONTEXT_SOURCE_REVISION`（設定されていれば）。どのビルドが書いたDBかの手掛かり。 */
  readonly revision?: string;
  /** バックアップを取ったNodeの版。`node:sqlite` の版差を追うのに使う。 */
  readonly node: string;
  /** バックアップ元のDBファイルパス（引っ越し時の参考情報）。 */
  readonly sourceDatabasePath: string;
  readonly database: BackupCopyStat & { readonly file: string };
  readonly artifacts: BackupCopyStat & { readonly directory: string };
  /**
   * 暗号鍵を**同梱したか**。同梱した場合、このディレクトリは平文APIキーと同じ機密度になる。
   * 既定は false（鍵と暗号文を一緒に運ばないため）。
   */
  readonly secretKey: { readonly included: boolean; readonly file?: string };
}

/** `CreateBackupUseCase` がマニフェストへ書き込む値。 */
export interface BackupManifestInput {
  readonly createdAt: Date;
  readonly schemaVersion: number;
  readonly revision?: string;
  readonly node: string;
  readonly sourceDatabasePath: string;
  readonly database: BackupCopyStat;
  readonly artifacts: BackupCopyStat;
  readonly secretKeyIncluded: boolean;
}

/** 2桁・3桁のゼロ埋め（`padStart` の呼び分けを1箇所へ寄せる）。 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * バックアップディレクトリ名を作る（`backup-YYYYMMDD-HHMMSSmmm`・UTC）。
 *
 * 固定幅なので**辞書順が時刻順**になり、一覧のソートに追加の解析が要らない。
 * ISO文字列をそのまま使わないのは `:` が Windows のファイル名に使えないため。
 */
export function backupDirectoryName(createdAt: Date): string {
  const date = `${createdAt.getUTCFullYear()}${pad(createdAt.getUTCMonth() + 1, 2)}${pad(createdAt.getUTCDate(), 2)}`;
  const time = `${pad(createdAt.getUTCHours(), 2)}${pad(createdAt.getUTCMinutes(), 2)}${pad(createdAt.getUTCSeconds(), 2)}${pad(createdAt.getUTCMilliseconds(), 3)}`;
  return `${BACKUP_DIRECTORY_PREFIX}${date}-${time}`;
}

/** 入力からマニフェストを組み立てる（省略可能な項目は「無いなら書かない」）。 */
export function createBackupManifest(input: BackupManifestInput): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt.toISOString(),
    schemaVersion: input.schemaVersion,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    node: input.node,
    sourceDatabasePath: input.sourceDatabasePath,
    database: { file: BACKUP_DATABASE_FILE_NAME, files: input.database.files, bytes: input.database.bytes },
    artifacts: { directory: BACKUP_ARTIFACTS_DIRECTORY_NAME, files: input.artifacts.files, bytes: input.artifacts.bytes },
    secretKey: input.secretKeyIncluded
      ? { included: true, file: BACKUP_SECRET_KEY_FILE_NAME }
      : { included: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInteger(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BackupValidationError(`backup manifest field "${key}" must be a non-negative integer`);
  }
  return value;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BackupValidationError(`backup manifest field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BackupValidationError(`backup manifest field "${key}" must be a string`);
  return value;
}

function requireRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) throw new BackupValidationError(`backup manifest field "${key}" must be an object`);
  return value;
}

function copyStat(source: Record<string, unknown>): BackupCopyStat {
  return { files: requireInteger(source, 'files'), bytes: requireInteger(source, 'bytes') };
}

/**
 * 読み込んだJSONをマニフェストとして検証する。
 *
 * 「壊れたバックアップから復元してしまう」ほうが「復元できない」より遥かに害が大きいので、
 * 欠けている・型が違う項目は**すべて拒否**する（黙って既定値を当てない）。
 */
export function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) throw new BackupValidationError('backup manifest must be a JSON object');
  const database = requireRecord(value, 'database');
  const artifacts = requireRecord(value, 'artifacts');
  const secretKey = requireRecord(value, 'secretKey');
  const included = secretKey['included'];
  if (typeof included !== 'boolean') {
    throw new BackupValidationError('backup manifest field "secretKey.included" must be a boolean');
  }
  const revision = optionalString(value, 'revision');
  const secretKeyFile = optionalString(secretKey, 'file');
  return {
    formatVersion: requireInteger(value, 'formatVersion'),
    createdAt: requireString(value, 'createdAt'),
    schemaVersion: requireInteger(value, 'schemaVersion'),
    ...(revision === undefined ? {} : { revision }),
    node: optionalString(value, 'node') ?? 'unknown',
    sourceDatabasePath: optionalString(value, 'sourceDatabasePath') ?? '',
    database: { ...copyStat(database), file: optionalString(database, 'file') ?? BACKUP_DATABASE_FILE_NAME },
    artifacts: { ...copyStat(artifacts), directory: optionalString(artifacts, 'directory') ?? BACKUP_ARTIFACTS_DIRECTORY_NAME },
    secretKey: secretKeyFile === undefined ? { included } : { included, file: secretKeyFile },
  };
}

/**
 * 復元してよいバックアップかを判定する。
 *
 * - 形式版が未知（このビルドより新しい）なら拒否。中身の並びが違う可能性がある。
 * - **スキーマ版がこのビルドの最新より新しければ拒否**。新しいagentblumeが書いたDBを
 *   古いagentblumeへ戻すと、起動時のマイグレーションも同じ理由で止まる（`migrations.ts`）。
 *   ここで先に止めれば、現用DBを潰してから気づく事故を防げる。
 */
export function assertRestorableManifest(manifest: BackupManifest, supportedSchemaVersion: number): void {
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      `backup format version ${manifest.formatVersion} is newer than this build supports (${BACKUP_FORMAT_VERSION}); upgrade agentblume before restoring`,
    );
  }
  if (manifest.schemaVersion > supportedSchemaVersion) {
    throw new BackupValidationError(
      `backup schema version ${manifest.schemaVersion} is newer than this build supports (${supportedSchemaVersion}); upgrade agentblume before restoring`,
    );
  }
}

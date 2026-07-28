import { describe, expect, it } from 'vitest';
import {
  BACKUP_ARTIFACTS_DIRECTORY_NAME,
  BACKUP_DATABASE_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  BACKUP_SECRET_KEY_FILE_NAME,
  createBackupManifest,
  type BackupCopyStat,
} from '../../domain/operations/backup';
import { BackupNotFoundError, BackupValidationError } from '../../domain/operations/errors';
import {
  CreateBackupUseCase,
  ListBackupsUseCase,
  RestoreBackupUseCase,
  type BackupLocations,
  type BackupStorePort,
} from './backup';

/** `node:path` は Windows で `\` を返す。fake の中では `/` に正規化して比較を安定させる。 */
const normalize = (value: string): string => value.replace(/\\/g, '/');

/**
 * 「どのファイルをどの順でどこへ置いたか」だけを記録する fake。
 * ファイルシステムの本物の挙動は `adapters/storage/filesystem-backup-store.test.ts` が見る。
 */
class FakeBackupStore implements BackupStorePort {
  readonly calls: string[] = [];
  readonly files = new Map<string, unknown>();
  readonly directories = new Set<string>();
  existing = new Set<string>();
  inUse = false;
  snapshotFailure?: Error;

  async createDirectory(path: string): Promise<void> { this.calls.push(`createDirectory:${normalize(path)}`); this.directories.add(normalize(path)); }
  async snapshotDatabase(source: string, destination: string): Promise<BackupCopyStat> {
    if (this.snapshotFailure !== undefined) throw this.snapshotFailure;
    this.calls.push(`snapshot:${normalize(source)}->${normalize(destination)}`);
    return { files: 1, bytes: 4096 };
  }
  async copyDirectory(source: string, destination: string): Promise<BackupCopyStat> {
    this.calls.push(`copyDirectory:${normalize(source)}->${normalize(destination)}`);
    return { files: 2, bytes: 64 };
  }
  async copyFile(source: string, destination: string): Promise<BackupCopyStat | undefined> {
    this.calls.push(`copyFile:${normalize(source)}->${normalize(destination)}`);
    return this.existing.has(normalize(source)) ? { files: 1, bytes: 45 } : undefined;
  }
  async writeJson(path: string, value: unknown): Promise<void> { this.calls.push(`writeJson:${normalize(path)}`); this.files.set(normalize(path), value); }
  async readJson(path: string): Promise<unknown> {
    if (!this.files.has(normalize(path))) throw new Error(`missing ${normalize(path)}`);
    return this.files.get(normalize(path));
  }
  async listDirectories(root: string): Promise<readonly string[]> {
    const prefix = `${normalize(root)}/`;
    return [...this.directories].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  }
  async exists(path: string): Promise<boolean> { return this.existing.has(normalize(path)) || this.directories.has(normalize(path)); }
  async moveAside(path: string, suffix: string): Promise<string | undefined> {
    if (!this.existing.has(normalize(path))) return undefined;
    this.calls.push(`moveAside:${normalize(path)}`);
    return `${normalize(path)}.${suffix}`;
  }
  async restoreDatabase(source: string, destination: string): Promise<BackupCopyStat> {
    this.calls.push(`restoreDatabase:${normalize(source)}->${normalize(destination)}`);
    return { files: 1, bytes: 4096 };
  }
  async restoreDirectory(source: string, destination: string): Promise<BackupCopyStat> {
    this.calls.push(`restoreDirectory:${normalize(source)}->${normalize(destination)}`);
    return { files: 2, bytes: 64 };
  }
  async isDatabaseInUse(): Promise<boolean> { return this.inUse; }
}

const locations: BackupLocations = {
  databasePath: '/data/agentblume.db',
  artifactsDirectory: '/data/agentblume.db.session-artifacts',
  secretKeyPath: '/home/.agentblume/secret.key',
  backupRoot: '/data/backups',
};
const now = (): Date => new Date('2026-07-28T09:30:12.345Z');
const directory = '/data/backups/backup-20260728-093012345';

describe('CreateBackupUseCase', () => {
  it('DBはスナップショット、アーティファクトはディレクトリごと、マニフェストは最後に書く', async () => {
    const store = new FakeBackupStore();
    const created = await new CreateBackupUseCase(store, locations, 2, { now, node: 'v22.19.0', revision: 'rev1' }).execute();

    expect(created.name).toBe('backup-20260728-093012345');
    expect(normalize(created.path)).toBe(directory);
    expect(store.calls.map(normalize)).toEqual([
      `createDirectory:${directory}`,
      `snapshot:/data/agentblume.db->${directory}/${BACKUP_DATABASE_FILE_NAME}`,
      `copyDirectory:/data/agentblume.db.session-artifacts->${directory}/${BACKUP_ARTIFACTS_DIRECTORY_NAME}`,
      `writeJson:${directory}/${BACKUP_MANIFEST_FILE_NAME}`,
    ]);
    expect(created.manifest).toMatchObject({
      schemaVersion: 2, revision: 'rev1', node: 'v22.19.0', sourceDatabasePath: '/data/agentblume.db',
      database: { files: 1, bytes: 4096 }, artifacts: { files: 2, bytes: 64 }, secretKey: { included: false },
    });
    expect(created.warnings.join(' ')).toMatch(/NOT included/);
  });

  it('鍵は明示したときだけ含め、含めた場合は機密度が上がることを警告する', async () => {
    const store = new FakeBackupStore();
    store.existing.add('/home/.agentblume/secret.key');
    const created = await new CreateBackupUseCase(store, locations, 2, { now }).execute({ includeSecretKey: true });

    expect(store.calls.map(normalize)).toContain(`copyFile:/home/.agentblume/secret.key->${directory}/${BACKUP_SECRET_KEY_FILE_NAME}`);
    expect(created.manifest.secretKey).toEqual({ included: true, file: BACKUP_SECRET_KEY_FILE_NAME });
    expect(created.warnings.join(' ')).toMatch(/Treat this backup exactly like the plaintext API keys/);
  });

  it('鍵ファイルがまだ無い／揮発鍵の配線では、含めた扱いにせず理由を伝える', async () => {
    const missingKey = new FakeBackupStore();
    const notSaved = await new CreateBackupUseCase(missingKey, locations, 2, { now }).execute({ includeSecretKey: true });
    expect(notSaved.manifest.secretKey.included).toBe(false);
    expect(notSaved.warnings.join(' ')).toMatch(/No secret key file exists yet/);

    const ephemeral = new FakeBackupStore();
    const { secretKeyPath: _unused, ...withoutKey } = locations;
    const created = await new CreateBackupUseCase(ephemeral, withoutKey, 2, { now }).execute({ includeSecretKey: true });
    expect(created.manifest.secretKey.included).toBe(false);
    expect(created.warnings.join(' ')).toMatch(/ephemeral in-memory key/);
    expect(ephemeral.calls.some((call) => call.startsWith('copyFile:'))).toBe(false);
  });

  it('揮発DB（:memory:）は「取るものが無い」として拒否し、ディレクトリも作らない', async () => {
    const store = new FakeBackupStore();
    const useCase = new CreateBackupUseCase(store, { ...locations, databasePath: ':memory:' }, 2, { now });
    await expect(useCase.execute()).rejects.toThrow(BackupValidationError);
    expect(store.calls).toEqual([]);
  });

  it('スナップショットに失敗したらマニフェストを書かない（未完成を正常扱いしない）', async () => {
    const store = new FakeBackupStore();
    store.snapshotFailure = new Error('ENOSPC: no space left on device');
    await expect(new CreateBackupUseCase(store, locations, 2, { now }).execute()).rejects.toThrow(/ENOSPC/);
    expect(store.files.size).toBe(0);
  });
});

describe('ListBackupsUseCase', () => {
  it('新しい順に並べ、マニフェストの無いディレクトリも理由つきで残す', async () => {
    const store = new FakeBackupStore();
    store.directories.add('/data/backups/backup-20260101-000000000');
    store.directories.add('/data/backups/backup-20260728-093012345');
    store.directories.add('/data/backups/backup-20260401-120000000');
    const manifest = createBackupManifest({
      createdAt: now(), schemaVersion: 2, node: 'v22.19.0', sourceDatabasePath: '/data/agentblume.db',
      database: { files: 1, bytes: 4096 }, artifacts: { files: 0, bytes: 0 }, secretKeyIncluded: false,
    });
    store.files.set(`/data/backups/backup-20260728-093012345/${BACKUP_MANIFEST_FILE_NAME}`, manifest);
    store.files.set(`/data/backups/backup-20260101-000000000/${BACKUP_MANIFEST_FILE_NAME}`, manifest);

    const useCase = new ListBackupsUseCase(store, locations);
    const listed = await useCase.execute();
    expect(listed.map((entry) => entry.name)).toEqual([
      'backup-20260728-093012345', 'backup-20260401-120000000', 'backup-20260101-000000000',
    ]);
    expect(listed[0]?.manifest).toEqual(manifest);
    expect(listed[1]?.manifest).toBeUndefined();
    expect(listed[1]?.problem).toMatch(/missing/);
    expect(useCase.root()).toBe('/data/backups');
  });

  it('置き場がまだ無ければ空一覧（エラーにしない）', async () => {
    expect(await new ListBackupsUseCase(new FakeBackupStore(), locations).execute()).toEqual([]);
  });
});

describe('RestoreBackupUseCase', () => {
  function seed(store: FakeBackupStore, schemaVersion: number): void {
    store.directories.add(directory);
    store.existing.add(directory);
    store.files.set(`${directory}/${BACKUP_MANIFEST_FILE_NAME}`, createBackupManifest({
      createdAt: now(), schemaVersion, node: 'v22.19.0', sourceDatabasePath: '/data/agentblume.db',
      database: { files: 1, bytes: 4096 }, artifacts: { files: 2, bytes: 64 }, secretKeyIncluded: false,
    }));
  }

  it('現用データを退避してから戻し、鍵が入っていないことを警告する', async () => {
    const store = new FakeBackupStore();
    seed(store, 2);
    store.existing.add('/data/agentblume.db');
    store.existing.add('/data/agentblume.db.session-artifacts');

    const result = await new RestoreBackupUseCase(store, locations, 2, { now }).execute('backup-20260728-093012345');
    expect(store.calls.map(normalize)).toEqual([
      'moveAside:/data/agentblume.db',
      'moveAside:/data/agentblume.db.session-artifacts',
      `restoreDatabase:${directory}/${BACKUP_DATABASE_FILE_NAME}->/data/agentblume.db`,
      `restoreDirectory:${directory}/${BACKUP_ARTIFACTS_DIRECTORY_NAME}->/data/agentblume.db.session-artifacts`,
    ]);
    expect(result.movedAside).toHaveLength(2);
    expect(result.database.bytes).toBe(4096);
    expect(result.warnings.join(' ')).toMatch(/does not contain the secret key/);
    expect(result.warnings.join(' ')).toMatch(/previous data was kept/);
  });

  it('このビルドより新しいスキーマのバックアップは、現用データへ触れる前に拒否する', async () => {
    const store = new FakeBackupStore();
    seed(store, 7);
    store.existing.add('/data/agentblume.db');
    await expect(new RestoreBackupUseCase(store, locations, 2, { now }).execute('backup-20260728-093012345'))
      .rejects.toThrow(/schema version 7 is newer than this build supports \(2\)/);
    expect(store.calls).toEqual([]);
  });

  it('マニフェストが無いバックアップは「未完成」として拒否する', async () => {
    const store = new FakeBackupStore();
    store.directories.add(directory);
    store.existing.add(directory);
    await expect(new RestoreBackupUseCase(store, locations, 2, { now }).execute(directory))
      .rejects.toThrow(/incomplete and must not be restored/);
  });

  it('存在しないバックアップ名は BackupNotFoundError', async () => {
    await expect(new RestoreBackupUseCase(new FakeBackupStore(), locations, 2, { now }).execute('backup-does-not-exist'))
      .rejects.toThrow(BackupNotFoundError);
  });

  it('復元先が使用中なら「先に止めろ」と伝えて何もしない', async () => {
    const store = new FakeBackupStore();
    seed(store, 2);
    store.inUse = true;
    await expect(new RestoreBackupUseCase(store, locations, 2, { now }).execute('backup-20260728-093012345'))
      .rejects.toThrow(/stop agentblume/);
    expect(store.calls).toEqual([]);
  });

  it('揮発DB配線では復元先が無いので拒否する', async () => {
    const store = new FakeBackupStore();
    seed(store, 2);
    await expect(new RestoreBackupUseCase(store, { ...locations, databasePath: ':memory:' }, 2, { now }).execute('backup-20260728-093012345'))
      .rejects.toThrow(BackupValidationError);
  });

  it('鍵を含むバックアップでは、鍵を自動で上書きせず手当ての場所を伝える', async () => {
    const store = new FakeBackupStore();
    store.directories.add(directory);
    store.existing.add(directory);
    store.files.set(`${directory}/${BACKUP_MANIFEST_FILE_NAME}`, createBackupManifest({
      createdAt: now(), schemaVersion: 2, node: 'v22.19.0', sourceDatabasePath: '/data/agentblume.db',
      database: { files: 1, bytes: 4096 }, artifacts: { files: 0, bytes: 0 }, secretKeyIncluded: true,
    }));
    const result = await new RestoreBackupUseCase(store, locations, 2, { now }).execute('backup-20260728-093012345');
    expect(result.warnings.join(' ')).toMatch(/contains a secret key file/);
    expect(store.calls.some((call) => call.includes('secret.key'))).toBe(false);
  });
});

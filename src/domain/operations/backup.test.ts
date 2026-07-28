import { describe, expect, it } from 'vitest';
import {
  assertRestorableManifest,
  backupDirectoryName,
  BACKUP_FORMAT_VERSION,
  createBackupManifest,
  parseBackupManifest,
} from './backup';
import { BackupValidationError } from './errors';

const base = {
  createdAt: new Date('2026-07-28T09:30:12.345Z'),
  schemaVersion: 2,
  node: 'v22.19.0',
  sourceDatabasePath: 'C:/home/.agentblume/agentblume.db',
  database: { files: 1, bytes: 20_480 },
  artifacts: { files: 3, bytes: 900 },
  secretKeyIncluded: false,
};

describe('backup manifest', () => {
  it('ディレクトリ名は固定幅UTCで辞書順＝時刻順、Windowsで使えない文字を含まない', () => {
    expect(backupDirectoryName(new Date('2026-07-28T09:30:12.345Z'))).toBe('backup-20260728-093012345');
    const earlier = backupDirectoryName(new Date('2026-07-28T09:30:12.344Z'));
    const later = backupDirectoryName(new Date('2026-12-01T00:00:00.000Z'));
    expect([later, earlier].sort()).toEqual([earlier, later]);
    expect(backupDirectoryName(new Date('2026-01-02T03:04:05.006Z'))).toBe('backup-20260102-030405006');
    expect(/[:*?"<>|]/.test(backupDirectoryName(new Date()))).toBe(false);
  });

  it('鍵を含めた／含めない がマニフェストへ記録され、往復できる', () => {
    const without = createBackupManifest(base);
    expect(without).toMatchObject({ formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: 2, createdAt: '2026-07-28T09:30:12.345Z', secretKey: { included: false } });
    expect(without.secretKey.file).toBeUndefined();
    expect(without.revision).toBeUndefined();
    expect(parseBackupManifest(JSON.parse(JSON.stringify(without)))).toEqual(without);

    const withKey = createBackupManifest({ ...base, secretKeyIncluded: true, revision: 'abc123' });
    expect(withKey.secretKey).toEqual({ included: true, file: 'secret.key' });
    expect(withKey.revision).toBe('abc123');
    expect(parseBackupManifest(JSON.parse(JSON.stringify(withKey)))).toEqual(withKey);
  });

  it('壊れたマニフェストは既定値で補わずに拒否する', () => {
    const valid = JSON.parse(JSON.stringify(createBackupManifest(base))) as Record<string, unknown>;
    expect(() => parseBackupManifest('not an object')).toThrow(BackupValidationError);
    expect(() => parseBackupManifest([])).toThrow(BackupValidationError);
    expect(() => parseBackupManifest({ ...valid, formatVersion: 'one' })).toThrow(/formatVersion/);
    expect(() => parseBackupManifest({ ...valid, schemaVersion: -1 })).toThrow(/schemaVersion/);
    expect(() => parseBackupManifest({ ...valid, createdAt: '  ' })).toThrow(/createdAt/);
    expect(() => parseBackupManifest({ ...valid, database: undefined })).toThrow(/database/);
    expect(() => parseBackupManifest({ ...valid, artifacts: { files: 1 } })).toThrow(/bytes/);
    expect(() => parseBackupManifest({ ...valid, secretKey: { included: 'yes' } })).toThrow(/secretKey.included/);
    expect(() => parseBackupManifest({ ...valid, revision: 12 })).toThrow(/revision/);
  });

  it('古いバックアップ（node/sourceDatabasePath 欠落）は既定値で読める', () => {
    const valid = JSON.parse(JSON.stringify(createBackupManifest(base))) as Record<string, unknown>;
    delete valid['node'];
    delete valid['sourceDatabasePath'];
    const parsed = parseBackupManifest(valid);
    expect(parsed.node).toBe('unknown');
    expect(parsed.sourceDatabasePath).toBe('');
  });

  it('形式・スキーマがこのビルドより新しいバックアップは復元させない', () => {
    const manifest = createBackupManifest(base);
    expect(() => assertRestorableManifest(manifest, 2)).not.toThrow();
    expect(() => assertRestorableManifest(manifest, 5)).not.toThrow();
    expect(() => assertRestorableManifest(manifest, 1)).toThrow(/schema version 2 is newer than this build supports \(1\)/);
    expect(() => assertRestorableManifest({ ...manifest, formatVersion: BACKUP_FORMAT_VERSION + 1 }, 2)).toThrow(/format version/);
  });
});

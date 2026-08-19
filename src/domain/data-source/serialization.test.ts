import { describe, expect, it } from 'vitest';
import { deserializeDataSource } from './serialization';
import { DataSourceDomainError } from './errors';
import type { DataSource } from './data-source';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

/** 保存経路(JSON.stringify)と同じ表現を経由して復元する。 */
function roundTrip(record: DataSource): DataSource {
  return deserializeDataSource(JSON.parse(JSON.stringify(record)));
}

describe('deserializeDataSource', () => {
  it('file(csv)レコードがJSON往復で等値に復元される', () => {
    const record: DataSource = { id: 'file', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    expect(roundTrip(record)).toEqual(record);
  });

  it('file(json)レコードがJSON往復で等値に復元される', () => {
    const record: DataSource = { id: 'other', tenant: scope, name: 'Other', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 2, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    expect(roundTrip(record)).toEqual(record);
  });

  it('database(defaultSchemaあり)レコードがJSON往復で等値に復元される', () => {
    const record: DataSource = { id: 'db', tenant: scope, name: 'Sales', kind: 'database', connectionId: 'sales', driver: 'postgresql', defaultSchema: 'public', createdAt: '2026-07-12T00:01:00.000Z', updatedAt: '2026-07-12T00:01:00.000Z' };
    expect(roundTrip(record)).toEqual(record);
  });

  it('database(defaultSchemaなし)レコードがJSON往復で等値に復元される', () => {
    const record: DataSource = { id: 'db', tenant: scope, name: 'Sales', kind: 'database', connectionId: 'sales', driver: 'postgresql', createdAt: '2026-07-12T00:01:00.000Z', updatedAt: '2026-07-12T00:01:00.000Z' };
    expect(roundTrip(record)).toEqual(record);
  });

  it('未知フィールドは拒否せず読み飛ばす(前方互換: 将来追加されたフィールドを含む行も読める)', () => {
    const record: DataSource = { id: 'file', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    const stored = { ...record, futureField: 'ignored', tenant: { ...record.tenant, futureNested: true } };
    expect(deserializeDataSource(JSON.parse(JSON.stringify(stored)))).toEqual(record);
  });

  it('必須フィールド欠落(name)を DataSourceDomainError で拒否する', () => {
    const record = { id: 'file', tenant: scope, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    expect(() => deserializeDataSource(record)).toThrowError(DataSourceDomainError);
    expect(() => deserializeDataSource(record)).toThrowError(/^deserializeDataSource: name: /);
  });

  it('型不一致(sizeBytes が文字列)を DataSourceDomainError で拒否する', () => {
    const record = { id: 'file', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: '4', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    expect(() => deserializeDataSource(record)).toThrowError(DataSourceDomainError);
    expect(() => deserializeDataSource(record)).toThrowError(/deserializeDataSource: sizeBytes: /);
  });

  it('database の必須フィールド欠落(connectionId)を拒否する', () => {
    const record = { id: 'db', tenant: scope, name: 'Sales', kind: 'database', driver: 'postgresql', createdAt: '2026-07-12T00:01:00.000Z', updatedAt: '2026-07-12T00:01:00.000Z' };
    expect(() => deserializeDataSource(record)).toThrowError(DataSourceDomainError);
    expect(() => deserializeDataSource(record)).toThrowError(/deserializeDataSource: connectionId: /);
  });

  it('未知の kind を拒否する', () => {
    const record = { id: 'x', tenant: scope, name: 'X', kind: 'spreadsheet', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' };
    expect(() => deserializeDataSource(record)).toThrowError(DataSourceDomainError);
    expect(() => deserializeDataSource(record)).toThrowError(/^deserializeDataSource: /);
  });

  it('オブジェクト以外(null / 文字列)を拒否する', () => {
    expect(() => deserializeDataSource(null)).toThrowError(DataSourceDomainError);
    expect(() => deserializeDataSource('file')).toThrowError(DataSourceDomainError);
  });
});

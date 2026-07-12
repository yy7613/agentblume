import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDataSourceRepository } from './sqlite-data-source-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
describe('SqliteDataSourceRepository', () => {
  const repositories: SqliteDataSourceRepository[] = [];
  afterEach(() => { repositories.splice(0).forEach((repository) => repository.close()); });

  it('ファイルpayloadをbackend SQLiteに保存し、スコープ分離と削除を維持する', async () => {
    const repository = new SqliteDataSourceRepository(); repositories.push(repository);
    await repository.save({ id: 'file', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 4, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }, 'a,b\n');
    await repository.save({ id: 'db', tenant: scope, name: 'Sales', kind: 'database', connectionId: 'sales', driver: 'postgresql', createdAt: '2026-07-12T00:01:00.000Z', updatedAt: '2026-07-12T00:01:00.000Z' });
    await repository.save({ id: 'other', tenant: { tenantId: 'other', workspaceId: 'workspace' }, name: 'Other', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 2, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }, '[]');
    expect((await repository.list(scope)).map((source) => source.id)).toEqual(['db', 'file']);
    await expect(repository.find(scope, 'file')).resolves.toMatchObject({ kind: 'file', name: 'Rows' });
    await expect(repository.find(scope, 'missing')).resolves.toBeNull();
    await expect(repository.readFile(scope, 'file')).resolves.toMatchObject({ content: 'a,b\n' });
    await repository.delete(scope, 'file');
    expect((await repository.list(scope)).map((source) => source.id)).toEqual(['db']);
  });
});

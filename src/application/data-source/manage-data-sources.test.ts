import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { DatabaseConnectionCatalog } from './manage-data-sources';
import { DataSourceValidationError, DeleteDataSourceUseCase, QueryDataSourcesUseCase, QueryDatabaseConnectionsUseCase, RegisterDatabaseDataSourceUseCase, SaveFileDataSourceUseCase } from './manage-data-sources';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const catalog: DatabaseConnectionCatalog = {
  list: () => [{ id: 'sales', driver: 'postgresql' }],
  test: async (id) => ({ id, driver: 'postgresql', available: true }),
};

describe('data source use cases', () => {
  it('CSV/JSON本文をカタログとは分離して保存し、スコープ内で一覧・削除できる', async () => {
    const repository = new InMemoryDataSourceRepository();
    const saveFile = new SaveFileDataSourceUseCase(repository, () => 'file-1', () => new Date('2026-07-12T00:00:00.000Z'));
    const saved = await saveFile.execute({ scope, name: 'customers.json', format: 'json', content: '[{"id":1}]' });
    expect(saved).toMatchObject({ id: 'file-1', kind: 'file', contentType: 'application/json', sizeBytes: 10 });
    await new InMemoryDataSourceRepository().list(scope);
    expect(await new QueryDataSourcesUseCase(repository).list(scope)).toEqual([saved]);
    await new DeleteDataSourceUseCase(repository).execute(scope, saved.id);
    expect(await repository.list(scope)).toEqual([]);
  });

  it('空・不正JSON・上限超過のファイルを拒否する', async () => {
    const saveFile = new SaveFileDataSourceUseCase(new InMemoryDataSourceRepository(), () => 'file-1');
    await expect(saveFile.execute({ scope, name: 'empty.csv', format: 'csv', content: '' })).rejects.toBeInstanceOf(DataSourceValidationError);
    await expect(saveFile.execute({ scope, name: 'bad.json', format: 'json', content: '{' })).rejects.toThrow('invalid');
    await expect(saveFile.execute({ scope, name: 'large.csv', format: 'csv', content: 'x'.repeat(5 * 1024 * 1024 + 1) })).rejects.toThrow('exceeds');
  });

  it('DBは構成済みconnectionIdだけを登録し、秘密情報なしで接続状態を照会する', async () => {
    const repository = new InMemoryDataSourceRepository();
    const register = new RegisterDatabaseDataSourceUseCase(repository, catalog, () => 'db-1', () => new Date('2026-07-12T00:00:00.000Z'));
    const saved = await register.execute({ scope, name: 'Sales reporting', connectionId: 'sales', defaultSchema: ' reporting ' });
    expect(saved).toMatchObject({ id: 'db-1', kind: 'database', connectionId: 'sales', driver: 'postgresql', defaultSchema: 'reporting' });
    await expect(register.execute({ scope, name: 'Bad', connectionId: 'unknown' })).rejects.toThrow('not configured');
    const connections = new QueryDatabaseConnectionsUseCase(catalog);
    expect(connections.list()).toEqual([{ id: 'sales', driver: 'postgresql' }]);
    await expect(connections.test('sales')).resolves.toMatchObject({ available: true });
  });
});

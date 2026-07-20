import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { EtlEngine } from '../etl/engine';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { ProfileDataSourcesUseCase } from './profile-data-sources';

const scope = { tenantId: 't', workspaceId: 'w' };

function makeUseCase(repository: InMemoryDataSourceRepository): ProfileDataSourcesUseCase {
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(repository);
  return new ProfileDataSourcesUseCase(repository, resolver, engine);
}

describe('ProfileDataSourcesUseCase', () => {
  it('CSV data sourceのスキーマとサンプル行を決定的に抽出する', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'csv-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, 'id,amount\n1,100\n2,200');
    const usecase = makeUseCase(repository);

    const profile = await usecase.execute(scope, 'csv-1');

    expect(profile.dataSourceId).toBe('csv-1');
    expect(profile.name).toBe('Sales');
    expect(profile.kind).toBe('file');
    expect(profile.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', type: 'number' }),
      expect.objectContaining({ name: 'amount', type: 'number' }),
    ]));
    expect(profile.sampleRowCount).toBe(2);
    expect(profile.sampleRows).toEqual([{ id: 1, amount: 100 }, { id: 2, amount: 200 }]);
  });

  it('JSON data sourceを解決し、サンプル行を最大20行へ切り詰める', async () => {
    const repository = new InMemoryDataSourceRepository();
    const rows = Array.from({ length: 25 }, (_v, index) => ({ n: index }));
    await repository.save({ id: 'json-1', tenant: scope, name: 'Numbers', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 100, createdAt: '', updatedAt: '' }, JSON.stringify(rows));
    const usecase = makeUseCase(repository);

    const profile = await usecase.execute(scope, 'json-1');

    expect(profile.columns).toEqual([{ name: 'n', type: 'number', nullable: false }]);
    expect(profile.sampleRowCount).toBe(20);
    expect(profile.sampleRows).toHaveLength(20);
  });

  it('executeAllは複数data sourceを順にプロファイルする', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'csv-1', tenant: scope, name: 'A', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10, createdAt: '', updatedAt: '' }, 'x\n1');
    await repository.save({ id: 'json-1', tenant: scope, name: 'B', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 10, createdAt: '', updatedAt: '' }, '[{"y":1}]');
    const usecase = makeUseCase(repository);

    const profiles = await usecase.executeAll(scope, ['csv-1', 'json-1']);

    expect(profiles.map((profile) => profile.dataSourceId)).toEqual(['csv-1', 'json-1']);
  });

  it('存在しないdata sourceはFactoryValidationErrorを投げる', async () => {
    const repository = new InMemoryDataSourceRepository();
    const usecase = makeUseCase(repository);
    await expect(usecase.execute(scope, 'missing')).rejects.toThrow(/not found/);
  });

  it('database data sourceのプロファイルはM1では未対応として拒否する', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'db-1', tenant: scope, name: 'Reporting', kind: 'database', connectionId: 'reporting', driver: 'postgresql', createdAt: '', updatedAt: '' });
    const usecase = makeUseCase(repository);
    await expect(usecase.execute(scope, 'db-1')).rejects.toThrow(/database data source profiling is not supported yet/);
  });
});

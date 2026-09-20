import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { EtlEngine } from '../etl/engine';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { detectCategoricalColumn, detectPeriodColumn, MAX_CATEGORICAL_VALUES, ProfileDataSourcesUseCase } from './profile-data-sources';

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

// ─── 期間列・低カーディナリティ列の検出（ADR-0047: e-Stat 実データの形） ────────────────────
describe('ProfileDataSourcesUseCase（期間列・低カーディナリティ列・総行数）', () => {
  /** サンプル20行を超えても全行を見ていることを確かめるため、粒度の違う行を末尾に置く。 */
  async function seedEstatLike(repository: InMemoryDataSourceRepository): Promise<void> {
    const monthly = Array.from({ length: 24 }, (_v, index) => `1975年${(index % 12) + 1}月,全国,100`);
    const rows = [
      '時点,地域,値',
      ...monthly,
      '2024年1-3月期,北海道,200',
      '2024年,北海道,300',
      '2024年度,青森県,400',
    ].join('\n');
    await repository.save({ id: 'estat', tenant: scope, name: 'Unemployment', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: rows.length, createdAt: '', updatedAt: '' }, rows);
  }

  it('正常: 粒度が混ざった期間列を検出し、粒度別件数・開始日の範囲・mixedを報告する', async () => {
    const repository = new InMemoryDataSourceRepository();
    await seedEstatLike(repository);

    const profile = await makeUseCase(repository).execute(scope, 'estat');

    const period = profile.periodColumns.find((column) => column.column === '時点');
    expect(period).toBeDefined();
    expect(period?.mixed).toBe(true);
    expect(period?.granularities).toEqual({ month: 24, quarter: 1, year: 1, 'fiscal-year': 1 });
    expect(period?.minStart).toBe('1975-01-01');
    expect(period?.maxStart).toBe('2024-04-01'); // 2024年度 = 会計年度開始月(4月)
    // サンプル行（20行）では月次しか見えない。全行を見ていなければ mixed を取りこぼす。
    expect(profile.sampleRowCount).toBe(20);
    expect(profile.rowCount).toBe(27);
  });

  it('正常: distinctが上限以下の文字列列は値を列挙する（地域名のような引数候補）', async () => {
    const repository = new InMemoryDataSourceRepository();
    await seedEstatLike(repository);

    const profile = await makeUseCase(repository).execute(scope, 'estat');

    const region = profile.categoricalColumns.find((column) => column.column === '地域');
    expect(region).toEqual({ column: '地域', distinctCount: 3, values: ['全国', '北海道', '青森県'] });
  });

  it('異常: 期間として読めない文字列列は期間列にしない（地域名を期間と誤認しない）', async () => {
    const repository = new InMemoryDataSourceRepository();
    await seedEstatLike(repository);

    const profile = await makeUseCase(repository).execute(scope, 'estat');

    expect(profile.periodColumns.map((column) => column.column)).toEqual(['時点']);
  });

  it('境界: 解釈できた割合がちょうど90%なら期間列、それを下回れば期間列にしない', async () => {
    const repository = new InMemoryDataSourceRepository();
    const atThreshold = ['label', ...Array.from({ length: 9 }, (_v, index) => `202${index}年`), 'まだ未確定'].join('\n');
    const belowThreshold = ['label', ...Array.from({ length: 8 }, (_v, index) => `202${index}年`), 'まだ未確定', '調査中'].join('\n');
    await repository.save({ id: 'at', tenant: scope, name: 'At', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: atThreshold.length, createdAt: '', updatedAt: '' }, atThreshold);
    await repository.save({ id: 'below', tenant: scope, name: 'Below', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: belowThreshold.length, createdAt: '', updatedAt: '' }, belowThreshold);
    const usecase = makeUseCase(repository);

    expect((await usecase.execute(scope, 'at')).periodColumns.map((column) => column.column)).toEqual(['label']);
    expect((await usecase.execute(scope, 'below')).periodColumns).toEqual([]);
  });

  it('境界: distinctが上限(60)ちょうどなら列挙し、超えたら列挙しない', async () => {
    const repository = new InMemoryDataSourceRepository();
    const rows = (count: number): string => ['code', ...Array.from({ length: count }, (_v, index) => `c${index}`)].join('\n');
    await repository.save({ id: 'sixty', tenant: scope, name: 'Sixty', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10, createdAt: '', updatedAt: '' }, rows(MAX_CATEGORICAL_VALUES));
    await repository.save({ id: 'sixtyone', tenant: scope, name: 'SixtyOne', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 10, createdAt: '', updatedAt: '' }, rows(MAX_CATEGORICAL_VALUES + 1));
    const usecase = makeUseCase(repository);

    expect((await usecase.execute(scope, 'sixty')).categoricalColumns[0]?.distinctCount).toBe(MAX_CATEGORICAL_VALUES);
    expect((await usecase.execute(scope, 'sixtyone')).categoricalColumns).toEqual([]);
  });

  it('例外: 空の列・値なしの列は期間列にも低カーディナリティ列にもしない（ゼロ除算しない）', () => {
    expect(detectPeriodColumn('時点', [])).toBeUndefined();
    expect(detectPeriodColumn('時点', [{ 時点: null }, { 時点: '  ' }])).toBeUndefined();
    expect(detectCategoricalColumn('地域', [{ 地域: null }])).toBeUndefined();
  });
});

/**
 * 運賃マスタの application（取得・保存・CSV・運賃の照合・ツールの行・行ソース）のテスト。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { scope } from '../../../adapters/storage/expense-repository.fixtures';
import { FIXTURE_EMPLOYEE_IDS, fixtureEmployees, fixtureFareTable, V9_AT } from '../../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpensePolicyRepository } from '../../../adapters/storage/in-memory-expense-repositories';
import { InMemoryExpenseEmployeeRepository } from '../../../adapters/storage/in-memory-expense-people-repositories';
import { InMemoryExpenseSettingsRepository } from '../../../adapters/storage/in-memory-expense-settings-repository';
import { ExpenseCsvImportError, ExpenseDomainError } from '../../../domain/expense/errors';
import { DataSourceValidationError } from '../../data-source/manage-data-sources';
import { ExpenseSettingsStore } from '../settings-store';
import type { ExpenseRepositories } from '../system-deps';
import { expenseFareRows, ExpenseFareRowsProvider } from './fare-rows';
import { ExportExpenseFaresCsvUseCase, ImportExpenseFaresCsvUseCase } from './fare-transfer';
import { LookupExpenseFareUseCase } from './lookup-fare';
import { fareTableConfigured, GetExpenseFaresUseCase, SaveExpenseFaresUseCase } from './manage-fares';
import { expenseInputRowSources } from './row-sources';

const NOW = new Date('2026-09-15T03:00:00.000Z');

describe('運賃マスタの取得・保存', () => {
  let store: ExpenseSettingsStore;
  const deps = () => ({ settings: store, now: () => NOW });

  beforeEach(() => { store = new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository()); });

  it('正常: 未保存なら空の表と saved=false（書き込まない）。保存すると saved=true で準備済みになる', async () => {
    const empty = await new GetExpenseFaresUseCase(deps()).execute(scope);
    expect(empty).toMatchObject({ saved: false, table: { routes: [], stationAliases: [] } });
    expect(fareTableConfigured(empty)).toBe(false);
    const { routes, stationAliases } = fixtureFareTable();
    const saved = await new SaveExpenseFaresUseCase(deps()).execute({ scope, routes, stationAliases });
    expect(saved.updatedAt).toBe(NOW.toISOString());
    const loaded = await new GetExpenseFaresUseCase(deps()).execute(scope);
    expect(loaded).toEqual({ table: saved, saved: true });
    expect(fareTableConfigured(loaded)).toBe(true);
    expect(fareTableConfigured({ table: { ...saved, routes: [] }, saved: true })).toBe(false);
  });

  it('異常: 同じ駅の並び × 券種で有効期間が重なる表は保存しない（ExpenseDomainError）', async () => {
    const route = fixtureFareTable().routes[0]!;
    await expect(new SaveExpenseFaresUseCase(deps()).execute({ scope, routes: [route, { ...route, id: 'copy' }], stationAliases: [] })).rejects.toThrow(ExpenseDomainError);
  });

  it('正常: CSV 出力 → 取込で経路だけを置き換え、駅名の別名は残す', async () => {
    const table = fixtureFareTable();
    await store.save(scope, 'fares', table);
    const exported = await new ExportExpenseFaresCsvUseCase(deps()).execute(scope);
    expect(exported.fileName).toBe('expense-fares.csv');
    const imported = await new ImportExpenseFaresCsvUseCase(deps()).execute({ scope, content: 'stations,fare\n渋谷 > 品川,210\n' });
    expect(imported.routes).toEqual([{ id: 'fare-2', stations: ['渋谷', '品川'], fareType: 'ic', fare: 210, bidirectional: true }]);
    expect(imported.stationAliases).toEqual(table.stationAliases);
    const roundTrip = await new ImportExpenseFaresCsvUseCase(deps()).execute({ scope, content: exported.content });
    expect(roundTrip.routes).toEqual(table.routes);
  });

  it('異常: CSV の行の誤りは行番号付き。取込に失敗したら保存済みの表を変えない', async () => {
    await store.save(scope, 'fares', fixtureFareTable());
    await expect(new ImportExpenseFaresCsvUseCase(deps()).execute({ scope, content: 'stations,fare\nA,100\n' })).rejects.toMatchObject({ row: 2 });
    await expect(new ImportExpenseFaresCsvUseCase(deps()).execute({ scope, content: 'stations,fare\nA,100\n' })).rejects.toBeInstanceOf(ExpenseCsvImportError);
    expect((await store.load(scope, 'fares')).value.routes).toHaveLength(4);
  });
});

describe('LookupExpenseFareUseCase', () => {
  let store: ExpenseSettingsStore;
  let useCase: LookupExpenseFareUseCase;
  let policies: InMemoryExpensePolicyRepository;

  beforeEach(async () => {
    store = new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository());
    const employees = new InMemoryExpenseEmployeeRepository();
    for (const employee of fixtureEmployees()) await employees.save(employee);
    policies = new InMemoryExpensePolicyRepository();
    useCase = new LookupExpenseFareUseCase({ settings: store, employeeDirectory: employees, repositories: { policies } as unknown as ExpenseRepositories, now: () => NOW, timeZone: 'Asia/Tokyo' });
    const table = fixtureFareTable();
    await store.save(scope, 'fares', { ...table, routes: [...table.routes, { id: 'fare-shinjuku-shibuya', stations: ['新宿', '渋谷'], fareType: 'ic', fare: 160, bidirectional: true }] });
  });

  it('正常: 候補と最大運賃・経路の数を返す（券種は規程の既定、日付は今日）', async () => {
    const result = await useCase.execute({ scope, stations: ['中野', '霞が関'] });
    expect(result).toMatchObject({ fareType: 'ic', maxFare: 300, routeCount: 5 });
    expect(result.candidates.map((route) => route.id)).toEqual(['fare-nakano-kasumigaseki']);
    expect(result).not.toHaveProperty('commuterHint');
  });

  it('境界: 有効期間の前の日付・券種の指定で候補が変わり、候補が無ければ maxFare を省く', async () => {
    expect((await useCase.execute({ scope, stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', date: '2026-03-31' }))).toEqual({ fareType: 'ticket', candidates: [], routeCount: 5 });
    expect((await useCase.execute({ scope, stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', date: '2026-04-01' })).maxFare).toBe(320);
  });

  it('正常: 申請者の従業員を指定すると通勤定期のヒント（全部 / 一部と金額の候補）を返す', async () => {
    expect((await useCase.execute({ scope, stations: ['新宿', '霞ケ関'], employeeId: FIXTURE_EMPLOYEE_IDS.taro })).commuterHint).toEqual({ kind: 'full', passRoute: '中野 > 新宿 > 霞ケ関', validTo: '2027-03-31' });
    expect((await useCase.execute({ scope, stations: ['中野', '新宿', '渋谷'], trips: 2, employeeId: FIXTURE_EMPLOYEE_IDS.taro })).commuterHint).toEqual({
      kind: 'partial', passRoute: '中野 > 新宿 > 霞ケ関', validTo: '2027-03-31', overlapFrom: '中野', overlapTo: '新宿', restRoute: '新宿 > 渋谷', suggestedAmount: 320,
    });
    expect((await useCase.execute({ scope, stations: ['新宿', '霞ケ関'], employeeId: FIXTURE_EMPLOYEE_IDS.saburo })).commuterHint).toEqual({ kind: 'full', passRoute: '新宿 > 霞ケ関' });
  });

  it('境界: 無効・不在の従業員、重ならない区間ではヒントを出さない', async () => {
    for (const employeeId of [FIXTURE_EMPLOYEE_IDS.shiro, 'emp-none']) {
      expect(await useCase.execute({ scope, stations: ['新宿', '霞ケ関'], employeeId })).not.toHaveProperty('commuterHint');
    }
    expect(await useCase.execute({ scope, stations: ['渋谷', '品川'], employeeId: FIXTURE_EMPLOYEE_IDS.taro })).not.toHaveProperty('commuterHint');
  });

  it('異常: 駅が 2 つ未満・回数の範囲外は ExpenseDomainError', async () => {
    await expect(useCase.execute({ scope, stations: ['中野'] })).rejects.toThrow(ExpenseDomainError);
    await expect(useCase.execute({ scope, stations: ['中野', '新宿'], trips: 0 })).rejects.toThrow(/trips/u);
    await expect(useCase.execute({ scope, stations: ['中野', '新宿'], trips: 41 })).rejects.toThrow(/trips/u);
  });
});

describe('運賃マスタの行（expense_fares）と行ソース', () => {
  it('正常: 1 行 = 1 経路。未保存なら 0 行、通勤定期は出さない', async () => {
    const table = fixtureFareTable();
    expect(expenseFareRows(table, false)).toEqual([]);
    const rows = expenseFareRows(table, true);
    expect(rows[3]).toEqual({
      route_id: 'fare-nakano-kasumigaseki-ticket', stations: '中野 > 新宿 > 霞ケ関', from: '中野', to: '霞ケ関', fare_type: 'ticket', fare: 320, bidirectional: false,
      valid_from: '2026-04-01', valid_to: null, note: '運賃は架空', saved: true, updated_at: V9_AT,
    });
    expect(Object.keys(rows[0]!)).not.toContain('commuter');
  });

  it('正常: 行ソースは expense-fares を文脈なしで解決し、設定を持たない', async () => {
    const store = new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository());
    await store.save(scope, 'fares', fixtureFareTable());
    const [resolver] = expenseInputRowSources({ settings: store });
    expect(resolver).toMatchObject({ nodeType: 'expense-fares', requirement: 'none' });
    const input = { scope, attachments: [], documents: [], arguments: {} };
    expect(await resolver!.rows!({ ...input, config: {} })).toHaveLength(4);
    await expect(resolver!.rows!({ ...input, config: { limit: 1 } })).rejects.toThrow(DataSourceValidationError);
    expect(await new ExpenseFareRowsProvider(new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository())).rows(scope)).toEqual([]);
  });
});

/**
 * 汎用 CSV の取込で、申請者を従業員マスタに当てる（docs/21 §20.1.1）。
 * 社員番号の一致 → 氏名の一意な一致の順で、有効な従業員にだけ当てる。同名が複数・無効・当たらないなら文字列のまま。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryExpenseEmployeeRepository } from '../../adapters/storage/in-memory-expense-people-repositories';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { InMemoryExpenseSettingsRepository } from '../../adapters/storage/in-memory-expense-settings-repository';
import { createExpenseEmployee } from '../../domain/expense/employee';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { ImportExpenseCsvUseCase } from './import-csv';
import { ClaimantResolver } from './manage-claims';
import { ExpenseSettingsStore, organizationReader } from './settings-store';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const AT = '2026-09-14T00:00:00.000Z';
const period = { from: '2026-09-01', to: '2026-09-30' };
const unitOfWork: UnitOfWorkPort = { withTransaction: async (work) => work() };

let employees: InMemoryExpenseEmployeeRepository;
let claims: InMemoryExpenseClaimRepository;
let settings: ExpenseSettingsStore;

beforeEach(() => {
  employees = new InMemoryExpenseEmployeeRepository();
  claims = new InMemoryExpenseClaimRepository();
  settings = new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository());
});

function useCase(withMaster = true): ImportExpenseCsvUseCase {
  let sequence = 0;
  const claimants = new ClaimantResolver(employees, organizationReader(settings));
  return new ImportExpenseCsvUseCase(
    claims, new InMemoryExpenseReceiptRepository(), new InMemoryExpensePolicyRepository(), unitOfWork,
    () => `id-${(sequence += 1)}`, () => new Date('2026-09-15T00:00:00.000Z'), undefined,
    withMaster ? { directory: employees, claimants } : undefined,
  );
}

const csv = (rows: readonly string[]): string => ['申請者,社員番号,日付,支払先,金額,費目,目的', ...rows].join('\r\n');

async function seedMaster(): Promise<void> {
  await settings.save(scope, 'organization', { departments: [{ id: 'sales', name: '営業部', enabled: true }], approverGroups: [], updatedAt: AT });
  for (const props of [
    { id: 'emp-1', code: 'E001', name: 'テスト太郎', departmentId: 'sales' },
    { id: 'emp-2', name: 'テスト花子' },
    { id: 'emp-3', name: 'テスト花子' },
    { id: 'emp-4', code: 'E004', name: 'テスト三郎', enabled: false },
    { id: 'emp-5', name: 'テスト四郎' },
  ]) {
    await employees.save(createExpenseEmployee({ tenant: scope, createdAt: AT, updatedAt: AT, ...props }));
  }
}

describe('ImportExpenseCsvUseCase: 申請者を従業員マスタに当てる', () => {
  it('正常: 社員番号の一致・氏名の一意な一致は、従業員マスタの写し（氏名・社員番号・部門）と参照 id を埋める', async () => {
    await seedMaster();
    const result = await useCase().execute({ scope, content: csv(['太郎さん,Ｅ００１,2026/09/02,東京メトロ,420,電車・バス,客先訪問', 'テスト 四郎,,2026/09/03,東京メトロ,420,電車・バス,客先訪問']), period, by: 'keiri' });
    expect(result.claims.map((claim) => claim.claimant)).toEqual([
      { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-1', departmentId: 'sales' },
      { name: 'テスト四郎', employeeId: 'emp-5' },
    ]);
  });

  it('境界: 同名が複数・無効な従業員の社員番号・当たらない申請者は、紐付けずに文字列のまま残す', async () => {
    await seedMaster();
    const result = await useCase().execute({ scope, content: csv(['テスト花子,,2026/09/02,東京メトロ,420,電車・バス,客先訪問', 'テスト三郎,E004,2026/09/02,東京メトロ,420,電車・バス,客先訪問', 'テスト五郎,,2026/09/02,東京メトロ,420,電車・バス,客先訪問']), period, by: 'keiri' });
    expect(result.claims.map((claim) => claim.claimant)).toEqual([{ name: 'テスト花子' }, { name: 'テスト三郎', employeeCode: 'E004' }, { name: 'テスト五郎' }]);
  });

  it('境界: マスタが空、またはマッチングを配線しない構成は MVP と同じ（何も当てない）', async () => {
    const row = ['テスト太郎,E001,2026/09/02,東京メトロ,420,電車・バス,客先訪問'];
    expect((await useCase().execute({ scope, content: csv(row), period, by: 'keiri' })).claims[0]?.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001' });
    await seedMaster();
    expect((await useCase(false).execute({ scope, content: csv(row), period, by: 'keiri' })).claims[0]?.claimant).toEqual({ name: 'テスト太郎', employeeCode: 'E001' });
  });
});

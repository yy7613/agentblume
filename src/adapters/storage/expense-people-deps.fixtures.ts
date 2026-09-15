/**
 * adapters層: 系統 A（人と承認）の application テスト用の依存（テスト専用。`ExpenseSystemDeps` を InMemory で組む）。
 *
 * application のテストファイルから import する（application の本体は adapters を import できないため、組み立てはここに置く）。
 * 口座番号の封緘は骨格の偽の暗号 `fixtureAccountCipher`、時計は固定、トランザクションは Noop（呼び出しは数える）。
 */
import { ExpenseSettingsStore, organizationReader } from '../../application/expense/settings-store';
import type { ExpenseRepositories, ExpenseSystemDeps } from '../../application/expense/system-deps';
import type { UnitOfWorkPort } from '../../application/persistence/unit-of-work';
import { validateApprovalSettings } from '../../domain/expense/approval';
import { defaultExpensePolicy } from '../../domain/expense/default-policy';
import type { ExpensePolicy } from '../../domain/expense/policy';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { InMemoryExpenseAdvanceRepository, InMemoryExpenseCardRepository, InMemoryExpensePayoutBatchRepository } from './in-memory-expense-money-repositories';
import { InMemoryExpensePolicyHearingRepository } from './in-memory-expense-input-repositories';
import { InMemoryExpenseEmployeeRepository } from './in-memory-expense-people-repositories';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from './in-memory-expense-repositories';
import { InMemoryExpenseSettingsRepository } from './in-memory-expense-settings-repository';
import { fixtureAccountCipher, fixtureEmployees, fixtureOrganization, scope } from './expense-v9.fixtures';

/** テストの「いま」（2026-09-20 12:00 JST）。 */
export const PEOPLE_NOW = '2026-09-20T03:00:00.000Z';

export interface PeopleTestDeps extends ExpenseSystemDeps {
  readonly repositories: ExpenseRepositories & {
    readonly claims: InMemoryExpenseClaimRepository;
    readonly employees: InMemoryExpenseEmployeeRepository;
    readonly policies: InMemoryExpensePolicyRepository;
  };
  /** `withTransaction` を呼んだ回数。 */
  readonly transactions: { count: number };
}

export function peopleTestDeps(overrides: Partial<ExpenseSystemDeps> = {}): PeopleTestDeps {
  const settingsRepo = new InMemoryExpenseSettingsRepository();
  const settings = new ExpenseSettingsStore(settingsRepo);
  const employees = new InMemoryExpenseEmployeeRepository();
  const transactions = { count: 0 };
  const unitOfWork: UnitOfWorkPort = { withTransaction: async (work) => { transactions.count += 1; return work(); } };
  return {
    repositories: {
      policies: new InMemoryExpensePolicyRepository(),
      claims: new InMemoryExpenseClaimRepository(),
      receipts: new InMemoryExpenseReceiptRepository(),
      employees,
      settings: settingsRepo,
      advances: new InMemoryExpenseAdvanceRepository(),
      cards: new InMemoryExpenseCardRepository(),
      payouts: new InMemoryExpensePayoutBatchRepository(),
      hearings: new InMemoryExpensePolicyHearingRepository(),
    },
    settings,
    employeeDirectory: employees,
    organization: organizationReader(settings),
    cipher: fixtureAccountCipher,
    unitOfWork,
    now: () => new Date(PEOPLE_NOW),
    timeZone: 'Asia/Tokyo',
    transactions,
    ...overrides,
  } as PeopleTestDeps;
}

/** 従業員 5 名と組織（`expense-v9.fixtures.ts`）を入れる。 */
export async function seedPeople(deps: ExpenseSystemDeps, tenant: TenantScope = scope): Promise<void> {
  for (const employee of fixtureEmployees(tenant)) await deps.repositories.employees.save(employee);
  await deps.repositories.settings.save(tenant, 'organization', fixtureOrganization());
}

/** 初期テンプレートに承認設定（生の値を検証して）を入れた規程。 */
export function policyWithApproval(approval: unknown, updatedAt = '2026-09-14T00:00:00.000Z'): ExpensePolicy {
  const base = defaultExpensePolicy(updatedAt);
  return { ...base, approval: validateApprovalSettings(approval, new Set(base.categories.map((category) => category.id))) };
}

/** 2 段の経路（申請者の上長 → 承認グループ「経理」）。条件なし（全申請に当たる）。 */
export const TWO_STEP_APPROVAL = {
  routes: [{
    id: 'two-step', name: '上長と経理', enabled: true, when: {},
    steps: [
      { id: 'manager', name: '上長', approver: { kind: 'claimant-manager' } },
      { id: 'accounting', name: '経理', approver: { kind: 'group', groupId: 'group-accounting' } },
    ],
  }],
} as const;

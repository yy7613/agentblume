/**
 * application層: 3 系統（A 人と承認 / B お金の流れ / C 入力と規程）のユースケースが受け取る共通の依存（docs/21 §20.13.2。骨格。凍結）。
 *
 * composition（`composition/expense-core.ts` の `ExpenseCoreServices`）がこれを満たして系統の `compose*` へ渡す。
 * 系統の担当はリポジトリを作り直さず、ここにあるものを使う（test プロファイルでは InMemory の保管庫が別になり、骨格の申請から見えなくなるため）。
 */
import type {
  ExpenseAdvanceRepository, ExpenseCardRepository, ExpenseClaimRepository, ExpenseEmployeeRepository, ExpensePayoutBatchRepository,
  ExpensePolicyHearingRepository, ExpensePolicyRepository, ExpenseReceiptRepository, ExpenseSettingsRepository,
} from '../../domain/expense/repositories';
import type { SecretCipherPort } from '../model-settings/secret-cipher';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import type { JournalDraftSink } from './draft-journal-entries';
import type { EmployeeDirectoryPort, JournalChartReadPort, OrganizationReadPort } from './ports';
import type { ExpenseSettingsStore } from './settings-store';

export interface ExpenseRepositories {
  readonly policies: ExpensePolicyRepository;
  readonly claims: ExpenseClaimRepository;
  readonly receipts: ExpenseReceiptRepository;
  readonly employees: ExpenseEmployeeRepository;
  readonly settings: ExpenseSettingsRepository;
  readonly advances: ExpenseAdvanceRepository;
  readonly cards: ExpenseCardRepository;
  readonly payouts: ExpensePayoutBatchRepository;
  readonly hearings: ExpensePolicyHearingRepository;
}

export interface ExpenseSystemDeps {
  readonly repositories: ExpenseRepositories;
  /** ワークスペースに 1 つの設定（未保存なら既定値）。 */
  readonly settings: ExpenseSettingsStore;
  readonly employeeDirectory: EmployeeDirectoryPort;
  readonly organization: OrganizationReadPort;
  /** 口座番号の封緘・開封（`bank-account-secrets.ts` を通して使う）。 */
  readonly cipher: SecretCipherPort;
  readonly unitOfWork: UnitOfWorkPort;
  /** 仕訳下書きの受け口（仕訳連携が無い構成では undefined）。 */
  readonly journalDrafts?: JournalDraftSink;
  readonly journalChart?: JournalChartReadPort;
  readonly now: () => Date;
  /** 業務のタイムゾーン（判定日・集計の月の境界）。 */
  readonly timeZone: string;
}

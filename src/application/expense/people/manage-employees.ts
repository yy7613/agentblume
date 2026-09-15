/**
 * application層: 従業員マスタの一覧・取得・登録・編集（docs/21 §20.1.1 / §20.2.5 / §20.9.2。系統 A）。
 *
 * - 削除は無い（無効化のみ。申請・振込バッチから参照されるため）。
 * - 口座番号は `bank-account-secrets.ts` の `bankAccountFromInput` で封緘する（平文はこの関数の入力にしか現れない）。
 *   応答は `maskEmployee`（末尾 4 桁）。口座番号を省略した編集は既存の封緘値を保つ。`bankAccount: null` で口座を外す。
 * - 口座の変更（口座番号の入れ直し・銀行 / 支店 / 種目 / 名義の変更・削除）は必ず履歴 `bank-account-changed` を残す（すり替え対策）。
 * - 上長は存在する従業員で、自分自身と 20 段以内の循環を拒否する。部門は組織にある部門だけ。
 * - 名義カナは保存時に全銀の規則で検査し（30 バイト超・禁止文字は 400）、欄 `bankAccount.holderKana` と変換結果を返す。
 * - 応答には振込データに使えるかの点検（`payoutReadiness`。振込元の書式設定で判定）を添える。
 */
import { randomUUID } from 'node:crypto';
import { bankAccountChanged, type BankAccount } from '../../../domain/expense/bank-account';
import {
  createExpenseEmployee, managerChainReturnsTo, maskEmployee, MANAGER_CHAIN_MAX, withEmployeeHistory,
  type CommuterPass, type ExpenseEmployee, type ExpenseEmployeeHistoryEvent, type MaskedExpenseEmployee,
} from '../../../domain/expense/employee';
import { ExpenseDomainError, ExpenseEmployeeNotFoundError } from '../../../domain/expense/errors';
import { findDepartment, type ExpenseOrganization } from '../../../domain/expense/organization';
import { employeePayoutReadiness, type EmployeePayoutReadiness, type PayoutReadinessFormat } from '../../../domain/expense/people/payout-readiness';
import type { ExpenseEmployeeListOptions } from '../../../domain/expense/repositories';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { bankAccountFromInput, type BankAccountInput } from '../bank-account-secrets';
import type { ExpenseSystemDeps } from '../system-deps';

/** 画面・CSV から受ける従業員（口座番号は平文。省略 = 既存を保つ）。 */
export interface ExpenseEmployeeInput {
  readonly id?: string;
  readonly code?: string;
  readonly name: string;
  readonly nameKana?: string;
  readonly departmentId?: string;
  readonly managerEmployeeId?: string;
  readonly loginSubjects?: readonly string[];
  /** undefined = 既存を保つ（新規なら口座なし）、null = 口座を外す。 */
  readonly bankAccount?: BankAccountInput | null;
  readonly commuterPasses?: readonly CommuterPass[];
  readonly enabled?: boolean;
  readonly note?: string;
}

/** 応答の従業員（伏せ字 + 部門名・上長名の写し + 振込データの点検）。 */
export type ExpenseEmployeeView = MaskedExpenseEmployee & {
  readonly departmentName?: string;
  readonly managerName?: string;
  readonly payoutReadiness: EmployeePayoutReadiness;
};

/** 保存に失敗した口座の欄を `bankAccount.<欄>` にして返す（画面が口座の欄へフォーカスできるように）。 */
function prefixBankField(error: unknown): unknown {
  if (!(error instanceof ExpenseDomainError)) return error;
  const field = error.details?.field;
  return new ExpenseDomainError(error.message, error.row, { ...error.details, field: field === undefined ? 'bankAccount' : field.startsWith('bankAccount') ? field : `bankAccount.${field}` });
}

function sameBankFields(existing: BankAccount, input: BankAccountInput): boolean {
  return existing.bankCode === input.bankCode && existing.branchCode === input.branchCode && existing.accountType === input.accountType
    && existing.holderKana === input.holderKana.trim() && (existing.bankNameKana ?? '') === (input.bankNameKana ?? '').trim() && (existing.branchNameKana ?? '') === (input.branchNameKana ?? '').trim();
}

/**
 * 入力から口座を決める。口座番号を入れ直した・他の欄が変わった・外したときだけ新しい値にし、変わらなければ既存の値
 * （`changedAt` を含む）をそのまま使う。封緘は毎回違う暗号文になるので、口座番号の入力の有無で「入れ直した」を判断する。
 */
export async function resolveBankAccount(deps: Pick<ExpenseSystemDeps, 'cipher'>, input: BankAccountInput | null | undefined, existing: BankAccount | undefined, by: string, at: string): Promise<BankAccount | undefined> {
  if (input === undefined) return existing;
  if (input === null) return undefined;
  const renumbered = input.accountNumber !== undefined && input.accountNumber !== '';
  if (existing !== undefined && !renumbered && sameBankFields(existing, input)) return existing;
  try {
    return await bankAccountFromInput(deps.cipher, input, existing, by, at);
  } catch (error) {
    throw prefixBankField(error);
  }
}

/** 変更の履歴（作成・編集・口座の変更・有効 / 無効）。 */
export function employeeHistoryFor(before: ExpenseEmployee | undefined, after: Omit<ExpenseEmployee, 'history'>, by: string, at: string): readonly ExpenseEmployeeHistoryEvent[] {
  if (before === undefined) return [{ type: 'created', by, at }];
  let history = before.history;
  const push = (type: ExpenseEmployeeHistoryEvent['type']) => { history = withEmployeeHistory({ ...before, history }, { type, by, at }); };
  const comparable = (employee: Omit<ExpenseEmployee, 'history'>) => JSON.stringify([
    employee.code, employee.name, employee.nameKana, employee.departmentId, employee.managerEmployeeId, employee.loginSubjects, employee.commuterPasses, employee.note,
  ]);
  if (comparable(before) !== comparable(after)) push('edited');
  if (bankAccountChanged(before.bankAccount, after.bankAccount)) push('bank-account-changed');
  if (before.enabled !== after.enabled) push(after.enabled ? 'enabled' : 'disabled');
  return history;
}

/** 部門と上長の参照を検査する（存在・自分自身・循環）。 */
async function assertReferences(deps: ExpenseSystemDeps, scope: TenantScope, id: string | undefined, input: ExpenseEmployeeInput, organization: ExpenseOrganization): Promise<void> {
  if (input.departmentId !== undefined && input.departmentId !== '' && findDepartment(organization, input.departmentId) === undefined) {
    throw new ExpenseDomainError(`部門 ${input.departmentId} は組織にありません。組織で部門を追加するか、部門を選び直してください`, undefined, { field: 'departmentId' });
  }
  const managerId = input.managerEmployeeId === '' ? undefined : input.managerEmployeeId;
  if (managerId === undefined) return;
  if (managerId === id) throw new ExpenseDomainError('上長に本人は選べません。別の従業員を選んでください', undefined, { field: 'managerEmployeeId' });
  const chain = new Map<string, Pick<ExpenseEmployee, 'managerEmployeeId'>>();
  let current: string | undefined = managerId;
  for (let depth = 0; current !== undefined && depth < MANAGER_CHAIN_MAX && !chain.has(current); depth += 1) {
    const found = await deps.employeeDirectory.findById(scope, current);
    if (found === null) {
      if (current === managerId) throw new ExpenseDomainError(`上長 ${managerId} は従業員マスタにいません。上長を選び直してください`, undefined, { field: 'managerEmployeeId' });
      break;
    }
    chain.set(current, found);
    current = found.managerEmployeeId;
  }
  if (id !== undefined && managerChainReturnsTo(id, managerId, (lookup) => chain.get(lookup))) {
    throw new ExpenseDomainError(`上長を ${managerId} にすると、上長をたどって本人に戻ります（循環）。上長の設定を見直してください`, undefined, { field: 'managerEmployeeId', employeeId: managerId });
  }
}

/** 入力と既存から従業員を組み立てる（口座の封緘・履歴を含む。参照の検査はしない）。 */
export async function buildEmployeeRecord(
  deps: Pick<ExpenseSystemDeps, 'cipher'>,
  params: { readonly scope: TenantScope; readonly input: ExpenseEmployeeInput; readonly existing?: ExpenseEmployee; readonly by: string; readonly at: string; readonly makeId: () => string },
): Promise<ExpenseEmployee> {
  const { scope, input, existing, by, at } = params;
  const bankAccount = await resolveBankAccount(deps, input.bankAccount, existing?.bankAccount, by, at);
  const draft = createExpenseEmployee({
    tenant: scope,
    ...(existing === undefined ? (input.id === undefined || input.id === '' ? {} : { id: input.id }) : { id: existing.id }),
    name: input.name,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.nameKana === undefined ? {} : { nameKana: input.nameKana }),
    ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
    ...(input.managerEmployeeId === undefined ? {} : { managerEmployeeId: input.managerEmployeeId }),
    loginSubjects: input.loginSubjects ?? [],
    ...(bankAccount === undefined ? {} : { bankAccount }),
    commuterPasses: input.commuterPasses ?? [],
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(input.note === undefined ? {} : { note: input.note }),
    history: [],
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  }, params.makeId);
  const history = employeeHistoryFor(existing, draft, by, at);
  // 何も変わっていなければ既存のまま（updatedAt も進めない）。
  if (existing !== undefined && history === existing.history) return existing;
  return { ...draft, history };
}

/** 応答の形にする（伏せ字・部門名・上長名・振込データの点検）。 */
export function employeeView(employee: ExpenseEmployee, context: { readonly organization: ExpenseOrganization; readonly names: ReadonlyMap<string, string>; readonly format: PayoutReadinessFormat; readonly now: Date }): ExpenseEmployeeView {
  const departmentName = findDepartment(context.organization, employee.departmentId)?.name;
  const managerName = employee.managerEmployeeId === undefined ? undefined : context.names.get(employee.managerEmployeeId);
  return {
    ...maskEmployee(employee),
    ...(departmentName === undefined ? {} : { departmentName }),
    ...(managerName === undefined ? {} : { managerName }),
    payoutReadiness: employeePayoutReadiness(employee, context.format, context.now),
  };
}

async function viewContext(deps: ExpenseSystemDeps, scope: TenantScope, employees: readonly ExpenseEmployee[]) {
  const [organization, payout] = await Promise.all([deps.organization.get(scope), deps.settings.load(scope, 'payout')]);
  const known = new Map(employees.map((employee) => [employee.id, employee.name] as const));
  const managerIds = [...new Set(employees.flatMap((employee) => (employee.managerEmployeeId === undefined || known.has(employee.managerEmployeeId) ? [] : [employee.managerEmployeeId])))];
  for (const manager of managerIds.length === 0 ? [] : await deps.employeeDirectory.findByIds(scope, managerIds)) known.set(manager.id, manager.name);
  return { organization, names: known, format: payout.value.format, now: deps.now() };
}

export class ListExpenseEmployeesUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, options: ExpenseEmployeeListOptions = {}): Promise<readonly ExpenseEmployeeView[]> {
    const employees = await this.deps.repositories.employees.list(scope, options);
    const context = await viewContext(this.deps, scope, employees);
    return employees.map((employee) => employeeView(employee, context));
  }
}

export class GetExpenseEmployeeUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, id: string): Promise<ExpenseEmployeeView> {
    const employee = await requireEmployee(this.deps, scope, id);
    return employeeView(employee, await viewContext(this.deps, scope, [employee]));
  }
}

export async function requireEmployee(deps: Pick<ExpenseSystemDeps, 'repositories'>, scope: TenantScope, id: string): Promise<ExpenseEmployee> {
  const employee = await deps.repositories.employees.findById(scope, id);
  if (employee === null) throw new ExpenseEmployeeNotFoundError(`expense employee not found: ${id}`);
  return employee;
}

export class SaveExpenseEmployeeUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly makeId: () => string = randomUUID,
  ) {}

  /** 新規登録。id を指定して既存と重なれば 400（上書きしない）。 */
  async create(scope: TenantScope, input: ExpenseEmployeeInput, by: string): Promise<ExpenseEmployeeView> {
    if (input.id !== undefined && input.id !== '' && await this.deps.repositories.employees.findById(scope, input.id) !== null) {
      throw new ExpenseDomainError(`従業員 id「${input.id}」は既に使われています。別の id にするか、その従業員を編集してください`, undefined, { field: 'id', conflictEmployeeId: input.id });
    }
    return this.save(scope, input, undefined, by);
  }

  async update(scope: TenantScope, id: string, input: ExpenseEmployeeInput, by: string): Promise<ExpenseEmployeeView> {
    const existing = await requireEmployee(this.deps, scope, id);
    return this.save(scope, input, existing, by);
  }

  private async save(scope: TenantScope, input: ExpenseEmployeeInput, existing: ExpenseEmployee | undefined, by: string): Promise<ExpenseEmployeeView> {
    const organization = await this.deps.organization.get(scope);
    await assertReferences(this.deps, scope, existing?.id ?? input.id, input, organization);
    const at = this.deps.now().toISOString();
    const employee = await buildEmployeeRecord(this.deps, { scope, input, ...(existing === undefined ? {} : { existing }), by, at, makeId: this.makeId });
    if (employee !== existing) await this.deps.repositories.employees.save(employee);
    return employeeView(employee, await viewContext(this.deps, scope, [employee]));
  }
}

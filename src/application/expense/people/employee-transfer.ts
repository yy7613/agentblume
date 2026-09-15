/**
 * application層: 従業員 CSV の取込と出力（docs/21 §20.9.2。系統 A）。
 *
 * - 出力は口座番号の列を空にし `account_number_last4` を出す。**口座つき出力だけ**口座番号を `openAccountNumber` で開封する
 *   （api は approve 権限と監査を求める）。鍵が変わって開封できなければ、どの従業員かを付けて止め、口座の入れ直しへ導く。
 * - 取込は社員番号（無ければ id）で upsert。上長は全行を読んでから `manager_code`（社員番号、無ければ id）で解決する。
 *   CSV に無い従業員は変えない（無効化は enabled 列で明示）。口座番号の列が空なら既存の口座番号を保つ。
 * - 行の不正（形・名義カナ・部門・上長・一意・循環）は行を捨てて理由を返し、残りを 1 トランザクションで保存する。
 *   参照先の行を捨てたら、その行を上長にしていた行も捨てる（存在しない上長を保存しない）。
 */
import { randomUUID } from 'node:crypto';
import { employeeCodeKey, managerChainReturnsTo, type CommuterPass, type ExpenseEmployee } from '../../../domain/expense/employee';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { findDepartment } from '../../../domain/expense/organization';
import { employeesToCsv, parseEmployeeCsv, type EmployeeCsvRecord } from '../../../domain/expense/people/employee-csv';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { SecretCipherError } from '../../model-settings/secret-cipher';
import { openAccountNumber } from '../bank-account-secrets';
import type { ExpenseSystemDeps } from '../system-deps';
import { buildEmployeeRecord, type ExpenseEmployeeInput } from './manage-employees';

export interface ExpenseEmployeesCsvExport {
  readonly content: string;
  readonly fileName: string;
  readonly count: number;
}

export class ExportExpenseEmployeesCsvUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, options: { readonly withBankAccounts: boolean }): Promise<ExpenseEmployeesCsvExport> {
    const employees = await this.deps.repositories.employees.list(scope);
    const codes = new Map(employees.map((employee) => [employee.id, employee.code] as const));
    let accountNumbers: Map<string, string> | undefined;
    if (options.withBankAccounts) {
      accountNumbers = new Map();
      for (const employee of employees) {
        if (employee.bankAccount === undefined) continue;
        try {
          accountNumbers.set(employee.id, await openAccountNumber(this.deps.cipher, employee.bankAccount.accountNumber));
        } catch (error) {
          if (!(error instanceof SecretCipherError)) throw error;
          throw new ExpenseDomainError(
            `${employee.name} さん（${employee.id}）の口座番号を開封できません。鍵ファイル（モデル設定と同じ鍵）が変わったか失われています。従業員の口座欄で口座番号を入れ直してください`,
            undefined,
            { field: 'bankAccount.accountNumber', employeeId: employee.id },
          );
        }
      }
    }
    return {
      content: employeesToCsv(employees, { managerCodeOf: (id) => codes.get(id), ...(accountNumbers === undefined ? {} : { accountNumbers }) }),
      fileName: options.withBankAccounts ? 'expense-employees-bank-accounts.csv' : 'expense-employees.csv',
      count: employees.length,
    };
  }
}

export interface ExpenseEmployeesCsvImportResult {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
}

/** 行の失敗を CSV の列名で言い直す（domain の英語の文言をそのまま見せない）。 */
function rowReason(error: unknown): string {
  if (!(error instanceof ExpenseDomainError)) throw error;
  const field = error.details?.field ?? '';
  const converted = error.details?.converted;
  if (field.endsWith('holderKana') && converted !== undefined) {
    return converted.invalid.length > 0
      ? `名義カナ（account_holder_kana）に振込データで使えない文字があります: ${converted.invalid.map((entry) => `「${entry.char}」（${entry.index + 1} 文字目）`).join('、')}。通帳の名義どおりにカナで入れ直してください`
      : `名義カナ（account_holder_kana）が変換後 ${converted.bytes} バイトで、上限 30 バイトを超えています。銀行に登録された略し方で 30 バイト以内にしてください`;
  }
  const labels: Readonly<Record<string, string>> = {
    'bankAccount.accountNumber': '口座番号（account_number）は 7 桁以内の数字にしてください（新しく口座を登録する行では必須です）',
    'bankAccount.bankCode': '銀行コード（bank_code）は 4 桁の数字にしてください',
    'bankAccount.branchCode': '支店コード（branch_code）は 3 桁の数字にしてください',
    'bankAccount.bankNameKana': '銀行名カナ（bank_name_kana）は変換後 15 バイト以内のカナにしてください',
    'bankAccount.branchNameKana': '支店名カナ（branch_name_kana）は変換後 15 バイト以内のカナにしてください',
    nameKana: 'name_kana は全角カナにしてください',
    id: 'id は英小文字・数字・「_ . -」の 64 文字以内にしてください',
    code: '社員番号（code）は 20 文字以内にしてください',
    loginSubjects: 'login_subjects は「;」区切りで 5 件まで・重複なしにしてください',
  };
  return labels[field] ?? error.message;
}

interface PendingRow {
  readonly record: EmployeeCsvRecord;
  readonly existing?: ExpenseEmployee;
  readonly id: string;
  managerId?: string;
  employee?: ExpenseEmployee;
}

function passesFrom(record: EmployeeCsvRecord, existing: ExpenseEmployee | undefined): readonly CommuterPass[] {
  return record.commuterPasses.flatMap((pass, index) => {
    if (pass === undefined) return [];
    const before = existing?.commuterPasses[index];
    return [{
      id: before?.id ?? `pass-${index + 1}`,
      stations: [...pass.stations],
      // CSV は開始日を持たないので、同じ枠の既存の開始日を保つ。
      ...(before?.validFrom === undefined ? {} : { validFrom: before.validFrom }),
      ...(pass.validTo === undefined ? {} : { validTo: pass.validTo }),
      ...(before?.note === undefined ? {} : { note: before.note }),
    }];
  });
}

export class ImportExpenseEmployeesCsvUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly makeId: () => string = randomUUID,
  ) {}

  async execute(scope: TenantScope, content: string, by: string): Promise<ExpenseEmployeesCsvImportResult> {
    const parsed = parseEmployeeCsv(content);
    const skipped = new Map<number, string>(parsed.skippedRows.map((entry) => [entry.row, entry.reason] as const));
    const warnings: string[] = [];
    if (parsed.records.some((record) => record.bankAccount?.accountNumber !== undefined)) {
      warnings.push('CSV に口座番号が入っています。取り込んだ後は、ファイルを共有フォルダやメールに残さず削除してください');
    }

    const [existing, organization] = await Promise.all([this.deps.repositories.employees.list(scope), this.deps.organization.get(scope)]);
    const byId = new Map(existing.map((employee) => [employee.id, employee] as const));
    const byCode = new Map(existing.flatMap((employee) => (employee.code === undefined ? [] : [[employeeCodeKey(employee.code), employee] as const])));

    // 1. 行 → 対象の従業員（社員番号 → id の順）。同じ従業員（同じ id か同じ社員番号）が 2 行あれば後の行を捨てる。
    const rows: PendingRow[] = [];
    const claimedBy = new Map<string, number>();
    for (const record of parsed.records) {
      const codeKey = record.code === undefined ? undefined : `code:${employeeCodeKey(record.code)}`;
      const target = (record.code === undefined ? undefined : byCode.get(employeeCodeKey(record.code))) ?? (record.id === undefined ? undefined : byId.get(record.id));
      const id = target?.id ?? record.id ?? `emp-${this.makeId().replaceAll('-', '').slice(0, 12).toLowerCase()}`;
      const earlier = claimedBy.get(`id:${id}`) ?? (codeKey === undefined ? undefined : claimedBy.get(codeKey));
      if (earlier !== undefined) { skipped.set(record.row, `行 ${earlier} と同じ従業員（${record.code ?? id}）です。1 人 1 行にしてください`); continue; }
      claimedBy.set(`id:${id}`, record.row);
      if (codeKey !== undefined) claimedBy.set(codeKey, record.row);
      rows.push({ record, id, ...(target === undefined ? {} : { existing: target }) });
    }

    // 2. 上長の解決（CSV の行と既存の従業員の社員番号 → id）。
    const codeToId = new Map<string, string>(existing.flatMap((employee) => (employee.code === undefined ? [] : [[employeeCodeKey(employee.code), employee.id] as const])));
    for (const row of rows) if (row.record.code !== undefined) codeToId.set(employeeCodeKey(row.record.code), row.id);
    const rowIds = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      const { record } = row;
      if (!record.present.has('manager_code')) { if (row.existing?.managerEmployeeId !== undefined) row.managerId = row.existing.managerEmployeeId; continue; }
      if (record.managerCode === undefined) continue;
      const managerId = codeToId.get(employeeCodeKey(record.managerCode)) ?? (byId.has(record.managerCode) || rowIds.has(record.managerCode) ? record.managerCode : undefined);
      if (managerId === undefined) { skipped.set(record.row, `manager_code「${record.managerCode}」の従業員が CSV にも従業員マスタにもいません。上長の社員番号を確かめてください`); continue; }
      if (managerId === row.id) { skipped.set(record.row, '上長（manager_code）に本人は選べません'); continue; }
      row.managerId = managerId;
    }

    // 3. 1 行ずつ組み立てる（口座の封緘・名義カナ・部門の検査）。
    const at = this.deps.now().toISOString();
    for (const row of rows) {
      const { record, existing: before } = row;
      if (skipped.has(record.row)) continue;
      const keep = <T>(column: Parameters<typeof record.present.has>[0], value: T | undefined, current: T | undefined): T | undefined => (record.present.has(column) ? value : current);
      const departmentId = keep('department_id', record.departmentId, before?.departmentId);
      if (departmentId !== undefined && findDepartment(organization, departmentId) === undefined) {
        skipped.set(record.row, `department_id「${departmentId}」は組織にありません。先に組織で部門を登録してください`);
        continue;
      }
      const passesPresent = record.present.has('commuter_pass_1') || record.present.has('commuter_pass_2') || record.present.has('commuter_pass_3');
      const input: ExpenseEmployeeInput = {
        id: row.id,
        name: record.name,
        ...definedEntry('code', keep('code', record.code, before?.code)),
        ...definedEntry('nameKana', keep('name_kana', record.nameKana, before?.nameKana)),
        ...definedEntry('departmentId', departmentId),
        ...definedEntry('managerEmployeeId', row.managerId),
        loginSubjects: record.present.has('login_subjects') ? record.loginSubjects : before?.loginSubjects ?? [],
        ...(record.bankAccount === undefined ? {} : { bankAccount: record.bankAccount }),
        commuterPasses: passesPresent ? passesFrom(record, before) : before?.commuterPasses ?? [],
        ...definedEntry('enabled', record.enabled),
        ...definedEntry('note', keep('note', record.note, before?.note)),
      };
      try {
        row.employee = await buildEmployeeRecord(this.deps, { scope, input, ...(before === undefined ? {} : { existing: before }), by, at, makeId: this.makeId });
      } catch (error) {
        skipped.set(record.row, rowReason(error));
      }
    }

    // 4. 一意（社員番号・ログイン ID）と上長の循環を、保存後の全体（既存 + 取り込む行）で検査する。捨てた行を参照する行も捨てる。
    for (let changed = true; changed;) {
      changed = false;
      const accepted = rows.filter((row) => row.employee !== undefined && !skipped.has(row.record.row));
      const finalById = new Map(existing.map((employee) => [employee.id, employee] as const));
      for (const row of accepted) finalById.set(row.id, row.employee as ExpenseEmployee);
      const codes = new Map<string, string>();
      const subjects = new Map<string, string>();
      const reject = (row: PendingRow, reason: string) => { skipped.set(row.record.row, reason); changed = true; };
      // 既存（CSV に無い従業員）を先に登録し、取り込む行が既存と重なったら行を捨てる。
      const ordered = [...existing.filter((employee) => !accepted.some((row) => row.id === employee.id)).map((employee) => ({ employee, row: undefined })), ...accepted.map((row) => ({ employee: row.employee as ExpenseEmployee, row }))];
      for (const { employee, row } of ordered) {
        const codeKey = employee.code === undefined ? undefined : employeeCodeKey(employee.code);
        const codeHolder = codeKey === undefined ? undefined : codes.get(codeKey);
        const subjectClash = employee.loginSubjects.find((subject) => subjects.has(subject));
        if (row !== undefined && codeHolder !== undefined) { reject(row, `社員番号「${employee.code ?? ''}」は ${codeHolder} と重なっています`); continue; }
        if (row !== undefined && subjectClash !== undefined) { reject(row, `ログイン ID「${subjectClash}」は ${subjects.get(subjectClash) ?? ''} と重なっています`); continue; }
        if (codeKey !== undefined) codes.set(codeKey, employee.id);
        for (const subject of employee.loginSubjects) subjects.set(subject, employee.id);
      }
      if (changed) continue;
      for (const row of accepted) {
        const employee = row.employee as ExpenseEmployee;
        if (employee.managerEmployeeId === undefined) continue;
        if (!finalById.has(employee.managerEmployeeId)) { reject(row, `上長（${employee.managerEmployeeId}）の行を取り込めなかったため、この行も取り込みませんでした`); continue; }
        if (managerChainReturnsTo(employee.id, employee.managerEmployeeId, (id) => finalById.get(id))) reject(row, '上長をたどると本人に戻ります（循環）。manager_code を見直してください');
      }
    }

    const toSave = rows.filter((row) => row.employee !== undefined && !skipped.has(row.record.row));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    await this.deps.unitOfWork.withTransaction(async () => {
      for (const row of toSave) {
        const employee = row.employee as ExpenseEmployee;
        if (row.existing === undefined) created += 1;
        else if (employee === row.existing) { unchanged += 1; continue; }
        else updated += 1;
        await this.deps.repositories.employees.save(employee);
      }
    });
    return { created, updated, unchanged, skippedRows: [...skipped.entries()].sort(([left], [right]) => left - right).map(([row, reason]) => ({ row, reason })), warnings };
  }
}

function definedEntry<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
}

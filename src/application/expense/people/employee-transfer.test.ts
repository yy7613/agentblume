/**
 * 従業員 CSV の取込と出力（docs/21 §20.9.2）。口座つき出力だけ開封する・取込の upsert と上長の解決・行の不正は理由つきで捨てる。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { peopleTestDeps, seedPeople } from '../../../adapters/storage/expense-people-deps.fixtures';
import { fixtureAccountCipher, scope } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { EMPLOYEE_CSV_COLUMNS, parseEmployeeCsv } from '../../../domain/expense/people/employee-csv';
import { SecretCipherError } from '../../model-settings/secret-cipher';
import { ExportExpenseEmployeesCsvUseCase, ImportExpenseEmployeesCsvUseCase } from './employee-transfer';

const by = 'keiri@example.com';
const HEADER = EMPLOYEE_CSV_COLUMNS.join(',');
const line = (values: Partial<Record<(typeof EMPLOYEE_CSV_COLUMNS)[number], string>>) => EMPLOYEE_CSV_COLUMNS.map((column) => values[column] ?? '').join(',');
const csv = (...lines: string[]) => [HEADER, ...lines].join('\r\n');

async function setup(seed = true) {
  const deps = peopleTestDeps();
  if (seed) await seedPeople(deps);
  let counter = 0;
  const makeId = () => `0000000${++counter}-aaaa-bbbb-cccc-dddddddddddd`;
  return { deps, importer: new ImportExpenseEmployeesCsvUseCase(deps, makeId), exporter: new ExportExpenseEmployeesCsvUseCase(deps) };
}

describe('ExportExpenseEmployeesCsvUseCase', () => {
  it('正常: 通常の出力は口座番号を空にし、上長は社員番号（無ければ id）で書く', async () => {
    const { exporter } = await setup();
    const exported = await exporter.execute(scope, { withBankAccounts: false });
    expect(exported).toMatchObject({ fileName: 'expense-employees.csv', count: 5 });
    const records = parseEmployeeCsv(exported.content).records;
    expect(records.find((record) => record.id === 'emp-taro')).toMatchObject({ managerCode: 'E002', bankAccount: { bankCode: '9999', holderKana: 'テスト タロウ' } });
    expect(records.find((record) => record.id === 'emp-taro')?.bankAccount).not.toHaveProperty('accountNumber');
    expect(exported.content).not.toContain('0000001');
  });

  it('正常: 口座つき出力は開封した 7 桁の口座番号を入れる', async () => {
    const { exporter } = await setup();
    const exported = await exporter.execute(scope, { withBankAccounts: true });
    expect(exported.fileName).toBe('expense-employees-bank-accounts.csv');
    expect(parseEmployeeCsv(exported.content).records.find((record) => record.id === 'emp-saburo')?.bankAccount).toMatchObject({ accountNumber: '0000004', accountType: 'savings' });
  });

  it('例外: 鍵が変わって開封できなければ、どの従業員かを付けて止め（口座の入れ直しへ）、他の例外はそのまま投げる', async () => {
    const { deps } = await setup();
    const lost = new ExportExpenseEmployeesCsvUseCase({ ...deps, cipher: { seal: fixtureAccountCipher.seal, open: async () => { throw new SecretCipherError('key changed'); } } });
    const error = await lost.execute(scope, { withBankAccounts: true }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpenseDomainError);
    expect((error as ExpenseDomainError).details).toMatchObject({ field: 'bankAccount.accountNumber' });
    expect((error as ExpenseDomainError).message).toContain('口座番号を入れ直してください');
    const crash = new ExportExpenseEmployeesCsvUseCase({ ...deps, cipher: { seal: fixtureAccountCipher.seal, open: async () => { throw new TypeError('crash'); } } });
    await expect(crash.execute(scope, { withBankAccounts: true })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('ImportExpenseEmployeesCsvUseCase', () => {
  it('正常: サンプルの従業員 CSV を空のマスタへ取り込むと、上長を社員番号で解決して全員を作る（口座番号の列があれば削除を促す）', async () => {
    const deps = peopleTestDeps();
    await deps.repositories.settings.save(scope, 'organization', (await import('../../../adapters/storage/expense-v9.fixtures')).fixtureOrganization());
    const content = readFileSync(join(process.cwd(), 'samples', 'expense', 'employees.csv'), 'utf8');
    const result = await new ImportExpenseEmployeesCsvUseCase(deps).execute(scope, content, by);
    expect(result).toMatchObject({ updated: 0, unchanged: 0, skippedRows: [] });
    expect(result.created).toBeGreaterThanOrEqual(5);
    expect(result.warnings[0]).toContain('口座番号が入っています');
    const taro = (await deps.repositories.employees.list(scope, { query: 'E001' }))[0]!;
    const hanako = (await deps.repositories.employees.list(scope, { query: 'E002' }))[0]!;
    expect(taro.managerEmployeeId).toBe(hanako.id);
    expect(taro.bankAccount?.accountNumber.hint).toBe('0001');
    expect(deps.transactions.count).toBe(1);
  });

  it('正常: 社員番号で既存を更新し、ヘッダに無い列・空の口座の列は既存を保つ。新しい行の上長は CSV の中の社員番号でも解決する', async () => {
    const { deps, importer } = await setup();
    const content = 'code,name,manager_code,enabled\r\nE001,テスト太郎,E020,\r\nE020,テスト二十郎,E003,\r\nE005,テスト四郎,,true\r\n';
    const result = await importer.execute(scope, content, by);
    expect(result).toEqual({ created: 1, updated: 2, unchanged: 0, skippedRows: [], warnings: [] });
    const taro = (await deps.repositories.employees.findById(scope, 'emp-taro'))!;
    expect(taro.managerEmployeeId).toBe('emp-00000001aaaa');
    expect(taro.loginSubjects).toEqual(['taro@example.com']);
    expect(taro.bankAccount?.accountNumber.hint).toBe('0001');
    expect(taro.history.map((event) => event.type)).toEqual(['created', 'edited']);
    const shiro = (await deps.repositories.employees.findById(scope, 'emp-shiro'))!;
    expect(shiro.managerEmployeeId).toBeUndefined();
    expect(shiro.history.map((event) => event.type)).toEqual(['created', 'disabled', 'edited', 'enabled']);
  });

  it('正常: 出力した CSV をそのまま取り込むと何も変わらない（unchanged）', async () => {
    const { importer, exporter } = await setup();
    const exported = await exporter.execute(scope, { withBankAccounts: false });
    expect(await importer.execute(scope, exported.content, by)).toEqual({ created: 0, updated: 0, unchanged: 5, skippedRows: [], warnings: [] });
  });

  it('異常: 行ごとの不正（名義カナ 31 バイト・禁止文字・口座番号・部門・上長・本人・重複行・一意・循環）は理由つきで捨て、残りを保存する', async () => {
    const { deps, importer } = await setup();
    const bank = { bank_code: '9999', branch_code: '999', account_type: 'ordinary', account_number: '1' };
    const content = csv(
      line({ code: 'N01', name: '長い名義', ...bank, account_holder_kana: `${'ガ'.repeat(15)}ア` }),
      line({ code: 'N02', name: '中点', ...bank, account_holder_kana: 'テスト・ナナ' }),
      line({ code: 'N03', name: '口座番号', ...bank, account_number: '12-3', account_holder_kana: 'ｱ' }),
      line({ code: 'N04', name: '銀行コード', ...bank, bank_code: '99', account_holder_kana: 'ｱ' }),
      line({ code: 'N05', name: '部門なし', department_id: 'dept-ghost' }),
      line({ code: 'N06', name: '上長不明', manager_code: 'Z999' }),
      line({ code: 'N07', name: '自分が上長', manager_code: 'N07' }),
      line({ code: 'N08', name: '一行目' }),
      line({ code: 'n08', name: '二行目' }),
      line({ code: 'N09', name: 'ログイン重複', login_subjects: 'taro@example.com' }),
      line({ code: 'E003', name: 'テスト次郎', manager_code: 'E001' }),
      line({ code: 'N10', name: '上長が捨てられた', manager_code: 'N01' }),
      line({ code: 'N11', name: '新しい口座に番号なし', bank_code: '9999', branch_code: '999', account_type: 'ordinary', account_holder_kana: 'ｱ' }),
      line({ code: 'N12', name: 'カナ不正', name_kana: 'abc' }),
      line({ code: 'OK1', name: '取り込める人', manager_code: 'N08' }),
    );
    const result = await importer.execute(scope, content, by);
    const reasons = Object.fromEntries(result.skippedRows.map((entry) => [entry.row, entry.reason]));
    expect(result.created).toBe(2);
    expect(Object.keys(reasons).map(Number)).toEqual([2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
    expect(reasons[2]).toContain('変換後 31 バイト');
    expect(reasons[3]).toContain('「・」（4 文字目）');
    expect(reasons[4]).toContain('口座番号（account_number）');
    expect(reasons[5]).toContain('銀行コード（bank_code）');
    expect(reasons[6]).toContain('department_id「dept-ghost」');
    expect(reasons[7]).toContain('manager_code「Z999」');
    expect(reasons[8]).toContain('本人は選べません');
    expect(reasons[10]).toContain('行 9 と同じ従業員');
    expect(reasons[11]).toContain('ログイン ID「taro@example.com」');
    expect(reasons[12]).toContain('循環');
    expect(reasons[13]).toContain('上長（');
    expect(reasons[14]).toContain('口座番号（account_number）');
    expect(reasons[15]).toContain('name_kana');
    const ok = (await deps.repositories.employees.list(scope, { query: 'OK1' }))[0]!;
    expect((await deps.repositories.employees.findById(scope, ok.managerEmployeeId!))?.code).toBe('N08');
  });

  it('正常: 社員番号は id より優先して照合する（id と社員番号が別人を指せば社員番号の人を更新）。例外: 封緘の想定外の失敗は取込全体を止める', async () => {
    const { deps, importer } = await setup();
    const renamed = await importer.execute(scope, csv(line({ id: 'emp-taro', code: 'E002', name: 'テスト太郎' })), by);
    expect(renamed).toMatchObject({ created: 0, updated: 1, skippedRows: [] });
    expect((await deps.repositories.employees.findById(scope, 'emp-hanako'))?.name).toBe('テスト太郎');
    const crash = new ImportExpenseEmployeesCsvUseCase({ ...deps, cipher: { seal: async () => { throw new TypeError('crash'); }, open: fixtureAccountCipher.open } });
    await expect(crash.execute(scope, csv(line({ name: 'x', bank_code: '9999', branch_code: '999', account_type: 'ordinary', account_number: '1', account_holder_kana: 'ｱ' })), by)).rejects.toBeInstanceOf(TypeError);
  });
});

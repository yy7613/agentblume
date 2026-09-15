/** 従業員 CSV の読み取りと書き出し（docs/21 §20.9.2）。 */
import { describe, expect, it } from 'vitest';
import type { SealedSecret } from '../../model-settings/sealed-secret';
import type { ExpenseEmployee } from '../employee';
import { ExpenseEmployeeCsvImportError } from '../errors';
import { EMPLOYEE_CSV_COLUMNS, EMPLOYEE_CSV_MAX_ROWS, employeesToCsv, parseEmployeeCsv } from './employee-csv';

const HEADER = EMPLOYEE_CSV_COLUMNS.join(',');
const csv = (...lines: string[]) => `﻿${[HEADER, ...lines].join('\r\n')}\r\n`;
/** 列の順（EMPLOYEE_CSV_COLUMNS）で 1 行を作る。 */
const line = (values: Partial<Record<(typeof EMPLOYEE_CSV_COLUMNS)[number], string>>) => EMPLOYEE_CSV_COLUMNS.map((column) => values[column] ?? '').join(',');

describe('parseEmployeeCsv', () => {
  it('正常: 全列を読み、ログイン ID は「;」、定期は「>」で区切り、口座と有効を値にする', () => {
    const result = parseEmployeeCsv(csv(line({
      id: 'emp-taro', code: 'E001', name: 'テスト太郎', name_kana: 'テストタロウ', department_id: 'dept-sales', manager_code: 'E002', login_subjects: 'taro@example.com; taro-sso ;',
      bank_code: '9999', bank_name_kana: 'サンプル', branch_code: '999', branch_name_kana: 'ホンテン', account_type: '普通', account_number: '0000001', account_holder_kana: 'テスト タロウ',
      commuter_pass_1: '中野 > 新宿>霞ケ関', commuter_pass_1_valid_to: '2027-03-31', commuter_pass_3: '新宿 > 霞ケ関', enabled: '有効', note: 'メモ',
    })));
    expect(result.skippedRows).toEqual([]);
    expect(result.columns).toEqual(EMPLOYEE_CSV_COLUMNS);
    expect(result.records[0]).toMatchObject({
      row: 2, id: 'emp-taro', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'dept-sales', managerCode: 'E002',
      loginSubjects: ['taro@example.com', 'taro-sso'],
      bankAccount: { bankCode: '9999', bankNameKana: 'サンプル', branchCode: '999', branchNameKana: 'ホンテン', accountType: 'ordinary', accountNumber: '0000001', holderKana: 'テスト タロウ' },
      commuterPasses: [{ stations: ['中野', '新宿', '霞ケ関'], validTo: '2027-03-31' }, undefined, { stations: ['新宿', '霞ケ関'] }],
      enabled: true, note: 'メモ',
    });
  });

  it('正常: ヘッダに無い列は present に入らず（既存を保つ）、空欄は値を作らない。口座の列が全部空なら口座も作らない', () => {
    const result = parseEmployeeCsv('code,Name,enabled\r\n,テスト花子,\r\nE003, テスト次郎 ,false\r\n');
    expect([...result.records[0]!.present]).toEqual(['code', 'name', 'enabled']);
    expect(result.records[0]).toEqual({ row: 2, present: result.records[0]!.present, name: 'テスト花子', loginSubjects: [], commuterPasses: [undefined, undefined, undefined] });
    expect(result.records[1]).toMatchObject({ code: 'E003', name: 'テスト次郎', enabled: false });
  });

  it('正常: 預金種目は英語・日本語・全銀のコードを受け、口座番号が空なら既存を保つ（accountNumber を作らない）', () => {
    const types = ['current', '当座', '4', 'その他', 'ORDINARY'].map((type) => parseEmployeeCsv(csv(line({ name: 'x', bank_code: '9999', branch_code: '999', account_type: type, account_holder_kana: 'ｱ' }))).records[0]?.bankAccount);
    expect(types.map((account) => account?.accountType)).toEqual(['current', 'current', 'savings', 'other', 'ordinary']);
    expect(types[0]).not.toHaveProperty('accountNumber');
  });

  it('異常: 行の不正は行番号（ヘッダ = 1）と直し方つきで捨て、残りの行は読む', () => {
    const result = parseEmployeeCsv(csv(
      // 全列が空の行は空行として数えないので、氏名だけが空の行は社員番号を入れて作る。
      line({ name: '', code: 'E009' }),
      line({ name: 'a', enabled: 'maybe' }),
      line({ name: 'b', bank_code: '9999' }),
      line({ name: 'c', bank_code: '9999', branch_code: '999', account_type: 'yen', account_holder_kana: 'ｱ' }),
      line({ name: 'd', commuter_pass_2: '新宿' }),
      line({ name: 'e', commuter_pass_1: '新宿 > 霞ケ関', commuter_pass_1_valid_to: '2027/03/31' }),
      line({ name: 'f', commuter_pass_1_valid_to: '2027-03-31' }),
      `${line({ name: 'g' })},余計な値`,
      line({ name: 'ok' }),
    ));
    expect(result.records.map((record) => record.name)).toEqual(['ok']);
    expect(result.skippedRows.map((entry) => entry.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.skippedRows[0]?.reason).toContain('氏名（name）が空です');
    expect(result.skippedRows[1]?.reason).toContain('enabled の値「maybe」');
    expect(result.skippedRows[2]?.reason).toContain('空の列: branch_code・account_type・account_holder_kana');
    expect(result.skippedRows[3]?.reason).toContain('account_type の値「yen」');
    expect(result.skippedRows[4]?.reason).toContain('commuter_pass_2 は「新宿 > 霞ケ関」のように');
    expect(result.skippedRows[5]?.reason).toContain('YYYY-MM-DD');
    expect(result.skippedRows[6]?.reason).toContain('commuter_pass_1（駅の並び）が空です');
    expect(result.skippedRows[7]?.reason).toContain('列の数');
  });

  it('例外: 必須の列が無い・行が無い・引用符が閉じていない・ヘッダが重複・行が多すぎるときは全体を止める', () => {
    const fail = (content: string) => { try { parseEmployeeCsv(content); } catch (error) { return error as ExpenseEmployeeCsvImportError; } throw new Error('expected an error'); };
    expect(fail('code,name_kana\r\nE001,テスト\r\n')).toMatchObject({ code: 'EXPENSE_EMPLOYEE_CSV_IMPORT', row: 1, missingColumns: ['name'] });
    expect(fail('')).toBeInstanceOf(ExpenseEmployeeCsvImportError);
    expect(fail('name\r\n"テスト\r\n').message).toContain('引用符');
    expect(fail('name,name\r\nx,y\r\n')).toMatchObject({ row: 1 });
    expect(fail(`name\r\n${Array.from({ length: EMPLOYEE_CSV_MAX_ROWS + 1 }, (_, index) => `n${index}`).join('\r\n')}\r\n`).message).toContain(`${EMPLOYEE_CSV_MAX_ROWS} 行まで`);
    expect(parseEmployeeCsv(`name\r\n${Array.from({ length: EMPLOYEE_CSV_MAX_ROWS }, (_, index) => `n${index}`).join('\r\n')}\r\n`).records).toHaveLength(EMPLOYEE_CSV_MAX_ROWS);
  });
});

describe('employeesToCsv', () => {
  const sealed = (hint: string) => ({ v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: 'ZA==', hint }) as SealedSecret;
  const at = '2026-09-15T00:00:00.000Z';
  const employees = [
    {
      tenant: { tenantId: 't', workspaceId: 'w' }, id: 'emp-taro', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'dept-sales', managerEmployeeId: 'emp-hanako',
      loginSubjects: ['taro@example.com', 'taro-sso'],
      bankAccount: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0001'), holderKana: 'テスト タロウ', changedAt: at, changedBy: 'k' },
      commuterPasses: [{ id: 'pass-1', stations: ['中野', '新宿'], validFrom: '2026-04-01', validTo: '2027-03-31' }],
      enabled: true, note: 'カンマ, と "引用符"', history: [], createdAt: at, updatedAt: at,
    },
    { tenant: { tenantId: 't', workspaceId: 'w' }, id: 'emp-saburo', name: 'テスト三郎', managerEmployeeId: 'emp-nocode', loginSubjects: [], commuterPasses: [], enabled: false, history: [], createdAt: at, updatedAt: at },
  ] as unknown as ExpenseEmployee[];

  it('正常: UTF-8 BOM・CRLF で書き、口座番号は空・末尾に account_number_last4、上長は社員番号（無ければ id）', () => {
    const content = employeesToCsv(employees, { managerCodeOf: (id) => (id === 'emp-hanako' ? 'E002' : undefined) });
    expect(content.startsWith(`﻿${HEADER},account_number_last4\r\n`)).toBe(true);
    expect(content.endsWith('\r\n')).toBe(true);
    const parsed = parseEmployeeCsv(content);
    expect(parsed.skippedRows).toEqual([]);
    expect(parsed.records[0]).toMatchObject({
      code: 'E001', managerCode: 'E002', loginSubjects: ['taro@example.com', 'taro-sso'], note: 'カンマ, と "引用符"', enabled: true,
      bankAccount: { bankCode: '9999', accountType: 'ordinary', holderKana: 'テスト タロウ' }, commuterPasses: [{ stations: ['中野', '新宿'], validTo: '2027-03-31' }, undefined, undefined],
    });
    expect(parsed.records[0]?.bankAccount).not.toHaveProperty('accountNumber');
    expect(parsed.records[1]).toMatchObject({ id: 'emp-saburo', managerCode: 'emp-nocode', enabled: false });
    expect(content.split('\r\n')[1]?.endsWith(',0001')).toBe(true);
  });

  it('正常: 口座つき出力は渡された平文の口座番号を入れる', () => {
    const content = employeesToCsv(employees, { managerCodeOf: () => undefined, accountNumbers: new Map([['emp-taro', '0000001']]) });
    expect(parseEmployeeCsv(content).records[0]?.bankAccount?.accountNumber).toBe('0000001');
  });
});

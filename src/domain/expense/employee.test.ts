import { describe, expect, it } from 'vitest';
import {
  createExpenseEmployee, employeeCodeKey, employeeNameKey, managerChainReturnsTo, maskEmployee, recentBankAccountChange, withEmployeeHistory,
  type CreateExpenseEmployeeProps, type ExpenseEmployee,
} from './employee';
import { ExpenseDomainError } from './errors';

const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const sealed = (plain: string) => ({ v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plain).toString('base64'), hint: plain.slice(-4) });

function employee(overrides: Partial<CreateExpenseEmployeeProps> = {}): ExpenseEmployee {
  return createExpenseEmployee({ tenant, id: 'emp-1', name: 'テスト太郎', createdAt: AT, updatedAt: AT, ...overrides });
}

function detailsOf(run: () => unknown): ExpenseDomainError {
  try { run(); } catch (error) { if (error instanceof ExpenseDomainError) return error; throw error; }
  throw new Error('expected ExpenseDomainError');
}

describe('createExpenseEmployee', () => {
  it('正常: 既定は有効・ログイン ID なし・定期なし。空の任意項目は書かない（社員番号は任意）', () => {
    const value = employee({ code: ' ', note: '', nameKana: 'テスト タロウ' });
    expect(value).toEqual({ tenant, id: 'emp-1', name: 'テスト太郎', nameKana: 'テスト タロウ', loginSubjects: [], commuterPasses: [], enabled: true, history: [], createdAt: AT, updatedAt: AT });
  });

  it('正常: id を省略すると emp- + 生成 id の先頭 12 文字', () => {
    const { id: _id, ...rest } = { tenant, id: 'x', name: 'テスト花子', createdAt: AT, updatedAt: AT };
    expect(createExpenseEmployee(rest, () => 'ABCDEF12-3456-7890-aaaa-bbbbbbbbbbbb').id).toBe('emp-abcdef123456');
  });

  it('正常: 口座・通勤定期・ログイン ID・部門・上長を持つ', () => {
    const value = employee({
      code: 'E001', departmentId: 'sales', managerEmployeeId: 'emp-2', loginSubjects: [' taro@example.com '],
      bankAccount: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0000001'), holderKana: 'テスト タロウ', changedAt: AT, changedBy: 'keiri' },
      commuterPasses: [{ id: 'p1', stations: [' 新宿 ', '四ツ谷'], validFrom: '2026-04-01', validTo: '2027-03-31', note: '' }],
    });
    expect(value.loginSubjects).toEqual(['taro@example.com']);
    expect(value.commuterPasses).toEqual([{ id: 'p1', stations: ['新宿', '四ツ谷'], validFrom: '2026-04-01', validTo: '2027-03-31' }]);
    const masked = maskEmployee(value);
    expect(masked).not.toHaveProperty('tenant');
    expect(masked.bankAccount).toMatchObject({ accountNumberLast4: '0001' });
    expect(masked.bankAccount).not.toHaveProperty('accountNumber');
    expect(maskEmployee(employee())).not.toHaveProperty('bankAccount');
  });

  it('異常: 直す欄を details.field に付けて断る', () => {
    expect(detailsOf(() => employee({ id: 'Emp 1' })).details?.field).toBe('id');
    expect(detailsOf(() => employee({ name: ' ' })).details?.field).toBe('name');
    expect(detailsOf(() => employee({ nameKana: 'てすと' })).details?.field).toBe('nameKana');
    expect(detailsOf(() => employee({ code: 'x'.repeat(21) })).details?.field).toBe('code');
    expect(detailsOf(() => employee({ managerEmployeeId: 'emp-1' })).details?.field).toBe('managerEmployeeId');
    expect(detailsOf(() => employee({ loginSubjects: ['a', 'a'] })).details?.field).toBe('loginSubjects');
    expect(detailsOf(() => employee({ loginSubjects: ['1', '2', '3', '4', '5', '6'] })).details?.field).toBe('loginSubjects');
    expect(detailsOf(() => employee({ loginSubjects: [''] })).details?.field).toBe('loginSubjects');
    expect(detailsOf(() => employee({ enabled: 'yes' as never })).details?.field).toBe('enabled');
  });

  it('異常: 通勤定期は 3 件まで・id 一意・駅は 2 駅以上・有効期間の前後・日付の形', () => {
    const pass = (id: string, extra: Record<string, unknown> = {}) => ({ id, stations: ['A', 'B'], ...extra });
    expect(() => employee({ commuterPasses: [pass('1'), pass('2'), pass('3'), pass('4')] as never })).toThrow(/at most 3/u);
    expect(() => employee({ commuterPasses: [pass('1'), pass('1')] as never })).toThrow(/ids must be unique/u);
    expect(() => employee({ commuterPasses: [{ id: 'p', stations: ['A'] }] as never })).toThrow(/2 to 30 stations/u);
    expect(() => employee({ commuterPasses: [pass('p', { validFrom: '2027-01-01', validTo: '2026-01-01' })] as never })).toThrow(/validFrom must not be after/u);
    expect(() => employee({ commuterPasses: [pass('p', { validTo: '2026/01/01' })] as never })).toThrow(/YYYY-MM-DD/u);
    expect(() => employee({ commuterPasses: [null] as never })).toThrow(/must be an object/u);
    expect(() => employee({ history: [{ type: 'moved', by: 'x', at: AT }] as never })).toThrow(/history\[0\].type/u);
    expect(() => createExpenseEmployee(null as never)).toThrow(/props are required/u);
    expect(() => employee({ tenant: { tenantId: '', workspaceId: 'w' } })).toThrow(ExpenseDomainError);
  });
});

describe('照合キー・履歴・上長の循環', () => {
  it('正常: 社員番号と氏名のキーは NFKC・空白除去・小文字化', () => {
    expect(employeeCodeKey(' Ｅ ００１ ')).toBe('e001');
    expect(employeeNameKey('テスト　太郎')).toBe('テスト太郎');
  });

  it('境界: 履歴は 50 件まで（古いものから落とす）、直近 30 日の口座変更を探す', () => {
    let value = employee();
    for (let index = 0; index < 55; index += 1) value = { ...value, history: withEmployeeHistory(value, { type: 'edited', by: 'x', at: AT, note: `${index}` }) };
    expect(value.history).toHaveLength(50);
    expect(value.history[0]?.note).toBe('5');
    const changed = { ...value, history: withEmployeeHistory(value, { type: 'bank-account-changed', by: 'keiri', at: '2026-09-01T00:00:00.000Z' }) };
    expect(recentBankAccountChange(changed, new Date('2026-09-30T00:00:00.000Z'))?.by).toBe('keiri');
    expect(recentBankAccountChange(changed, new Date('2026-10-02T00:00:00.000Z'))).toBeUndefined();
  });

  it('境界: 上長をたどって自分に戻る鎖は循環、20 段で打ち切る', () => {
    const managers = new Map([['emp-2', 'emp-3'], ['emp-3', 'emp-1']]);
    const lookup = (id: string) => ({ managerEmployeeId: managers.get(id) });
    expect(managerChainReturnsTo('emp-1', 'emp-2', lookup)).toBe(true);
    expect(managerChainReturnsTo('emp-9', 'emp-2', lookup)).toBe(false);
    expect(managerChainReturnsTo('emp-1', undefined, lookup)).toBe(false);
    const long = (id: string) => ({ managerEmployeeId: `emp-${Number(id.slice(4)) + 1}` });
    expect(managerChainReturnsTo('emp-0', 'emp-1', long)).toBe(false);
  });
});

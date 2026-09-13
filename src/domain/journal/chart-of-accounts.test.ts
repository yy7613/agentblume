import { describe, expect, it } from 'vitest';
import { createChartOfAccounts, dimensionValueName, findAccount, findAccountByName, findTaxCategory, type Account } from './chart-of-accounts';
import { DEFAULT_ACCOUNTS, DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_TAX_CATEGORIES, defaultChartOfAccounts } from './default-chart';
import { JournalDomainError } from './errors';

const at = '2026-09-13T00:00:00.000Z';
const tax = [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in' as const, rate: 10, enabled: true }, { code: 'JP-NA', name: '対象外', side: 'none' as const, enabled: true }];
const account = (overrides: Partial<Account> = {}): Account => ({ id: 'expense.supplies', name: '消耗品費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: ['消耗品'], enabled: true, sortOrder: 10, ...overrides });

describe('createChartOfAccounts', () => {
  it('正常: 科目・補助軸・税区分を検証して複製する（trim・空の別名は落とす）', () => {
    const chart = createChartOfAccounts({ accounts: [account({ name: ' 消耗品費 ', aliases: ['消耗品', ' '], code: ' 601 ' })], dimensions: [{ id: 'department', name: '部門', values: [{ id: 'sales', name: '営業', enabled: true }] }], taxCategories: tax, updatedAt: at });
    expect(chart.accounts[0]).toEqual({ id: 'expense.supplies', code: '601', name: '消耗品費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: ['消耗品'], enabled: true, sortOrder: 10 });
    expect(chart.dimensions).toEqual([{ id: 'department', name: '部門', values: [{ id: 'sales', name: '営業', enabled: true }] }]);
    expect(chart.taxCategories).toHaveLength(2);
    expect(chart.updatedAt).toBe(at);
  });

  it('境界: 空のマスタも作れる', () => {
    expect(createChartOfAccounts({ accounts: [], dimensions: [], taxCategories: [], updatedAt: at })).toEqual({ accounts: [], dimensions: [], taxCategories: [], updatedAt: at });
  });

  it('異常: id / code / 税区分コードの重複', () => {
    expect(() => createChartOfAccounts({ accounts: [account(), account({ name: '別名' })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(new JournalDomainError('createChartOfAccounts: accounts.id contains a duplicate: expense.supplies'));
    expect(() => createChartOfAccounts({ accounts: [account({ code: '1' }), account({ id: 'b', code: '1' })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(/accounts\.code contains a duplicate/u);
    expect(() => createChartOfAccounts({ accounts: [], dimensions: [], taxCategories: [...tax, tax[0]!], updatedAt: at })).toThrow(/taxCategories\.code contains a duplicate/u);
  });

  it('異常: 未知の既定税区分・不正な category・非整数 sortOrder・空の名前', () => {
    expect(() => createChartOfAccounts({ accounts: [account({ defaultTaxCode: 'NOPE' })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(/defaultTaxCode refers to an unknown tax category: NOPE/u);
    expect(() => createChartOfAccounts({ accounts: [account({ category: 'cost' as Account['category'] })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(/category must be one of/u);
    expect(() => createChartOfAccounts({ accounts: [account({ sortOrder: 1.5 })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(/sortOrder must be an integer/u);
    expect(() => createChartOfAccounts({ accounts: [account({ name: ' ' })], dimensions: [], taxCategories: tax, updatedAt: at })).toThrow(/accounts\[0\]\.name must be a non-empty string/u);
  });

  it('異常: 補助軸の値 id の重複、税区分の rate / deductionRate の範囲、updatedAt の形', () => {
    expect(() => createChartOfAccounts({ accounts: [], dimensions: [{ id: 'd', name: 'D', values: [{ id: 'x', name: 'X', enabled: true }, { id: 'x', name: 'Y', enabled: true }] }], taxCategories: [], updatedAt: at })).toThrow(/dimensions\[0\]\.values contains a duplicate id: x/u);
    expect(() => createChartOfAccounts({ accounts: [], dimensions: [], taxCategories: [{ code: 'X', name: 'X', side: 'in', rate: 101, enabled: true }], updatedAt: at })).toThrow(/rate must be a number between 0 and 100/u);
    expect(() => createChartOfAccounts({ accounts: [], dimensions: [], taxCategories: [{ code: 'X', name: 'X', side: 'in', deductionRate: 2, enabled: true }], updatedAt: at })).toThrow(/deductionRate must be a number between 0 and 1/u);
    expect(() => createChartOfAccounts({ accounts: [], dimensions: [], taxCategories: [], updatedAt: 'today' })).toThrow(/updatedAt must be an ISO 8601 date-time string/u);
  });

  it('例外: props が無い', () => {
    expect(() => createChartOfAccounts(null as unknown as Parameters<typeof createChartOfAccounts>[0])).toThrow(JournalDomainError);
  });
});

describe('lookups', () => {
  it('正常: id / コード / 名前・別名で引ける。補助軸の値名は無ければ id', () => {
    const chart = DEFAULT_CHART_OF_ACCOUNTS;
    expect(findAccount(chart, 'expense.supplies')?.name).toBe('消耗品費');
    expect(findTaxCategory(chart, 'JP-IN-8R-S')?.rate).toBe(8);
    expect(findAccountByName(chart, '文具')?.id).toBe('expense.supplies');
    expect(findAccountByName(chart, ' 消耗品費 ')?.id).toBe('expense.supplies');
    expect(findAccountByName(chart, 'none')).toBeUndefined();
    expect(findAccountByName(chart, '')).toBeUndefined();
    expect(dimensionValueName(chart, 'department', 'x')).toBe('x');
    const withValue = createChartOfAccounts({ ...chart, dimensions: [{ id: 'department', name: '部門', values: [{ id: 'x', name: '営業', enabled: true }] }] });
    expect(dimensionValueName(withValue, 'department', 'x')).toBe('営業');
  });
});

describe('DEFAULT_CHART_OF_ACCOUNTS', () => {
  it('正常: 標準セットは不変条件を満たし、docs/20 §5 の科目・税区分・補助軸を含む', () => {
    const names = DEFAULT_ACCOUNTS.map((entry) => entry.name);
    for (const name of ['売上高', '雑収入', '仕入高', '租税公課', '消耗品費', '減価償却費', '専従者給与', '現金', '普通預金', '売掛金', '未払金', '預り金', '事業主貸', '事業主借', '元入金', '資本金', '役員借入金', '一括償却資産']) expect(names).toContain(name);
    expect(new Set(DEFAULT_ACCOUNTS.map((entry) => entry.id)).size).toBe(DEFAULT_ACCOUNTS.length);
    expect(DEFAULT_ACCOUNTS.every((entry) => /^[a-z]+\.[a-z_]+$/u.test(entry.id))).toBe(true);
    expect(DEFAULT_TAX_CATEGORIES.map((entry) => entry.code)).toEqual(['JP-IN-10-S', 'JP-IN-8R-S', 'JP-IN-10-S-D80', 'JP-IN-10-S-D70', 'JP-IN-10-S-D50', 'JP-IN-10-S-D30', 'JP-IN-10-S-D0', 'JP-IN-EXEMPT', 'JP-IN-NA', 'JP-OUT-10-S', 'JP-OUT-8R-S', 'JP-OUT-EXEMPT', 'JP-OUT-EXPORT', 'JP-OUT-NA', 'JP-NA']);
    expect(findTaxCategory(DEFAULT_CHART_OF_ACCOUNTS, 'JP-IN-10-S-D80')).toMatchObject({ rate: 10, deductionRate: 0.8, mapping: { freee: '課対仕入（控80）10%' } });
    expect(DEFAULT_CHART_OF_ACCOUNTS.dimensions.map((entry) => entry.id)).toEqual(['sub_account', 'department']);
    expect(DEFAULT_ACCOUNTS.every((entry) => entry.defaultTaxCode === undefined || DEFAULT_TAX_CATEGORIES.some((taxCategory) => taxCategory.code === entry.defaultTaxCode))).toBe(true);
  });

  it('正常: defaultChartOfAccounts は指定時刻の複製を返す（元は変わらない）', () => {
    const copy = defaultChartOfAccounts('2026-10-01T00:00:00.000Z');
    expect(copy.updatedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(copy.accounts).toEqual(DEFAULT_CHART_OF_ACCOUNTS.accounts);
    expect(copy.accounts).not.toBe(DEFAULT_CHART_OF_ACCOUNTS.accounts);
    expect(DEFAULT_CHART_OF_ACCOUNTS.updatedAt).toBe('2026-09-13T00:00:00.000Z');
  });
});

import { describe, expect, it } from 'vitest';
import { ACCOUNT_CATEGORIES, createChartOfAccounts, findAccount, findAccountByName, findTaxCategory, TAX_SIDES } from './chart-of-accounts';
import { DEFAULT_ACCOUNTS, DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_CHART_UPDATED_AT, DEFAULT_DIMENSIONS, DEFAULT_TAX_CATEGORIES, defaultChartOfAccounts } from './default-chart';
import { isIsoDateTime } from '../shared/time';

describe('標準セット（seed）の不変条件', () => {
  it('正常: そのまま createChartOfAccounts を通る（seed 自体が不正なら起動時に気づける）', () => {
    expect(() => createChartOfAccounts({ ...DEFAULT_CHART_OF_ACCOUNTS, updatedAt: DEFAULT_CHART_UPDATED_AT })).not.toThrow();
    expect(DEFAULT_CHART_OF_ACCOUNTS.accounts.length).toBeGreaterThan(50);
    expect(DEFAULT_CHART_OF_ACCOUNTS.taxCategories.length).toBeGreaterThan(10);
  });

  it('正常: 科目 id は一意（重複すると id 参照が壊れる）', () => {
    const ids = DEFAULT_ACCOUNTS.map((account) => account.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('正常: 税区分コードは一意', () => {
    const codes = DEFAULT_TAX_CATEGORIES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('正常: すべての科目の defaultTaxCode が税区分に実在する（判定で unknown にならない）', () => {
    const codes = new Set(DEFAULT_TAX_CATEGORIES.map((entry) => entry.code));
    for (const account of DEFAULT_ACCOUNTS) {
      if (account.defaultTaxCode === undefined) continue;
      expect(codes.has(account.defaultTaxCode), `${account.id} (${account.name}) の defaultTaxCode: ${account.defaultTaxCode}`).toBe(true);
    }
  });

  it('正常: 科目の category はすべて既知の値。すべて有効で、名前は空でない', () => {
    for (const account of DEFAULT_ACCOUNTS) {
      expect(ACCOUNT_CATEGORIES).toContain(account.category);
      expect(account.enabled).toBe(true);
      expect(account.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('正常: 税区分の side は既知の値。税率を持つものは 0〜100', () => {
    for (const entry of DEFAULT_TAX_CATEGORIES) {
      expect(TAX_SIDES).toContain(entry.side);
      if (entry.rate !== undefined) expect(entry.rate).toBeGreaterThanOrEqual(0);
      if (entry.rate !== undefined) expect(entry.rate).toBeLessThanOrEqual(100);
      if (entry.deductionRate !== undefined) expect(entry.deductionRate).toBeGreaterThanOrEqual(0);
      if (entry.deductionRate !== undefined) expect(entry.deductionRate).toBeLessThanOrEqual(1);
    }
  });

  it('正常: 経過措置の税区分（tax.ts が返すコード）が seed に揃っている', () => {
    for (const code of ['JP-IN-10-S', 'JP-IN-10-S-D80', 'JP-IN-10-S-D70', 'JP-IN-10-S-D50', 'JP-IN-10-S-D30', 'JP-IN-10-S-D0']) {
      expect(findTaxCategory(DEFAULT_CHART_OF_ACCOUNTS, code), code).toBeDefined();
    }
  });

  it('正常: sortOrder は決算書の並びどおり単調増加（一意）', () => {
    const orders = DEFAULT_ACCOUNTS.map((account) => account.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
  });

  it('正常: 補助軸の seed は補助科目と部門（値は空。利用者が足す）', () => {
    expect(DEFAULT_DIMENSIONS.map((dimension) => dimension.id)).toEqual(['sub_account', 'department']);
    for (const dimension of DEFAULT_DIMENSIONS) expect(dimension.values).toEqual([]);
    // CSV 出力（export.ts）はこの 2 つの id を直接引くので、名前を変えても id は変えてはならない。
    expect(DEFAULT_CHART_OF_ACCOUNTS.dimensions.some((dimension) => dimension.id === 'sub_account')).toBe(true);
    expect(DEFAULT_CHART_OF_ACCOUNTS.dimensions.some((dimension) => dimension.id === 'department')).toBe(true);
  });

  it('正常: 別名は重複せず、名前でも別名でも同じ科目を引ける', () => {
    expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, '消耗品費')?.id).toBe('expense.supplies');
    expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, '事務用品')?.id).toBe('expense.supplies');
    // 全角・大文字小文字の揺れも吸収する。
    expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, ' 現金 ')?.id).toBe('asset.cash');
    expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, '存在しない科目')).toBeUndefined();
  });

  it('正常: 仕訳の相手科目（現金・普通預金・売掛金・未払金・預り金・事業主貸/借）が揃っている', () => {
    for (const id of ['asset.cash', 'asset.ordinary_deposit', 'asset.receivables', 'liability.other_payables', 'liability.deposits_received', 'equity.owner_drawings', 'equity.owner_contributions']) {
      expect(findAccount(DEFAULT_CHART_OF_ACCOUNTS, id), id).toBeDefined();
    }
  });

  it('境界: DEFAULT_CHART_UPDATED_AT は ISO 8601 日時', () => {
    expect(isIsoDateTime(DEFAULT_CHART_UPDATED_AT)).toBe(true);
    expect(DEFAULT_CHART_OF_ACCOUNTS.updatedAt).toBe(DEFAULT_CHART_UPDATED_AT);
  });
});

describe('defaultChartOfAccounts', () => {
  it('正常: 指定時刻の複製を返す（共有定数を書き換えない）', () => {
    const copy = defaultChartOfAccounts('2026-10-01T00:00:00.000Z');
    expect(copy.updatedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(copy.accounts).toHaveLength(DEFAULT_CHART_OF_ACCOUNTS.accounts.length);
    expect(copy).not.toBe(DEFAULT_CHART_OF_ACCOUNTS);
    expect(copy.accounts).not.toBe(DEFAULT_CHART_OF_ACCOUNTS.accounts);
    // 標準セット側の updatedAt は動かない。
    expect(DEFAULT_CHART_OF_ACCOUNTS.updatedAt).toBe(DEFAULT_CHART_UPDATED_AT);
  });

  it('正常: 2 回呼んでも互いに独立（呼び出し側の変更が他へ漏れない）', () => {
    const first = defaultChartOfAccounts('2026-10-01T00:00:00.000Z');
    const second = defaultChartOfAccounts('2026-10-01T00:00:00.000Z');
    expect(first).toEqual(second);
    expect(first.accounts).not.toBe(second.accounts);
  });

  it('例外: ISO 形式でない時刻は JournalDomainError', () => {
    expect(() => defaultChartOfAccounts('2026-10-01')).toThrow(/updatedAt/);
  });
});
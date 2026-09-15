import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNTS, DEFAULT_TAX_CATEGORIES } from '../journal/default-chart';
import { DEFAULT_EXPENSE_POLICY_UPDATED_AT, defaultExpensePolicy } from './default-policy';

describe('defaultExpensePolicy', () => {
  const policy = defaultExpensePolicy();

  it('正常: 既定の版は DEFAULT_EXPENSE_POLICY_UPDATED_AT、指定すればその時刻', () => {
    expect(policy.updatedAt).toBe(DEFAULT_EXPENSE_POLICY_UPDATED_AT);
    expect(defaultExpensePolicy('2026-10-01T00:00:00.000Z').updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('正常: 全費目の accountId が仕訳の標準科目に存在する', () => {
    // 初期テンプレートのまま仕訳連携したとき「科目が見つからない」で止まらないことを保証する
    const accountIds = new Set(DEFAULT_ACCOUNTS.map((account) => account.id));
    for (const category of policy.categories) expect(accountIds, category.id).toContain(category.accountId);
    expect(accountIds).toContain(policy.journal.creditAccountId);
  });

  it('正常: 全費目の税区分コードと貸方の税区分が標準の税区分に存在する', () => {
    const codes = new Set(DEFAULT_TAX_CATEGORIES.map((tax) => tax.code));
    for (const category of policy.categories) {
      for (const code of Object.values(category.taxCodeByRate)) expect(codes, category.id).toContain(code);
    }
    expect(codes).toContain(policy.journal.creditTaxCode);
  });

  it('正常: sortOrder は 10 刻みで全費目が有効', () => {
    expect(policy.categories.map((category) => category.sortOrder)).toEqual(policy.categories.map((_, index) => (index + 1) * 10));
    expect(policy.categories.every((category) => category.enabled)).toBe(true);
  });

  it('正常: 初期値の数値が判定コード（check.ts）のソースに現れない', () => {
    // 上限額は規程のデータだけに置く約束（docs/21 §5）。判定コードに埋めると規程を直しても判定が変わらない
    const source = readFileSync(fileURLToPath(new URL('./check.ts', import.meta.url)), 'utf8');
    const values = [10_000, 12_000, 3_000, 30_000, 100_000, 50_000];
    for (const value of values) {
      const plain = String(value);
      const underscored = plain.replace(/\B(?=(\d{3})+(?!\d))/gu, '_');
      const comma = plain.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
      for (const notation of [plain, underscored, comma]) {
        expect(new RegExp(`(?<![\\d_,])${notation}(?![\\d_,])`, 'u').test(source), `${notation} in check.ts`).toBe(false);
      }
    }
  });
});

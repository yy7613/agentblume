import { describe, expect, it } from 'vitest';
import { createExpenseClaim, type ExpenseClaim, type ExpenseItem } from './claim';
import type { ReceiptFacts } from './receipt-facts';
import { amountsByRate, buildJournalDrafts, departmentDimensionFor, invoiceStatusFor, renderDescriptionTemplate } from './journal-draft';
import { createExpensePolicy, type ExpenseCategory, type ExpensePolicy, type JournalLinkSettings } from './policy';

// domain のテストは adapters のフィクスチャを使えない（依存ルール domain-no-adapters）ので、ここで組み立てる
const AT = '2026-09-14T00:00:00.000Z';
function itemFixture(id: string, facts: Partial<ReceiptFacts> = {}, overrides: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id,
    categoryId: 'transport.taxi',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプル交通', amount: 3200, description: 'タクシー代', purpose: '客先訪問', ...facts },
    source: { type: 'manual' },
    extraction: { method: 'manual', warnings: [] },
    ...overrides,
  };
}
function claimFixture(id: string, props: { readonly items: readonly ExpenseItem[] }): ExpenseClaim {
  return createExpenseClaim({
    tenant: { tenantId: 'tenant', workspaceId: 'workspace' }, id, claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-10-31' },
    items: props.items, submittedBy: 'tester', createdAt: AT, updatedAt: AT,
  });
}

function category(id: string, overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id,
    name: `費目${id}`,
    enabled: true,
    sortOrder: 10,
    aliases: [],
    accountId: 'expense.travel',
    defaultTaxRate: 10,
    taxCodeByRate: { '10': 'JP-IN-10-S', '8': 'JP-IN-8R-S', '0': 'JP-IN-NA' },
    receipt: { required: true },
    invoice: { required: true },
    requires: { purpose: false, attendees: false, attendeeDetails: false },
    limits: { perPersonBasis: 'tax-included' },
    ...overrides,
  };
}

function policy(categories: readonly ExpenseCategory[] = [category('taxi')], journal: Partial<JournalLinkSettings> = {}): ExpensePolicy {
  return createExpensePolicy({
    categories,
    claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false },
    preApprovalRules: [],
    severityOverrides: {},
    journal: { creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant} {payee}', ...journal },
    updatedAt: AT,
  });
}

const REG = 'T1234567890123';
const item = (id: string, facts: Parameters<typeof itemFixture>[1] = {}, overrides: Partial<ExpenseItem> = {}): ExpenseItem => itemFixture(id, { registrationNumber: REG, ...facts }, { categoryId: 'taxi', ...overrides });
const claimWith = (...items: ExpenseItem[]) => claimFixture('c1', { items });

describe('buildJournalDrafts: 行の組み立て', () => {
  it('正常: 税率別の内訳があれば借方を税率ごとに 2 行にし、貸借が一致する', () => {
    const facts = { amount: 1640, totalsByRate: [{ rate: 10 as const, taxableAmount: 1100, amountIncludesTax: true }, { rate: 8 as const, taxableAmount: 540, amountIncludesTax: true }] };
    const { drafts, problems, warnings } = buildJournalDrafts(claimWith(item('i1', facts)), policy());
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(drafts).toHaveLength(1);
    const lines = drafts[0]!.lines;
    expect(lines).toEqual([
      { side: 'debit', accountId: 'expense.travel', taxCode: 'JP-IN-10-S', amount: 1100, partner: 'サンプル交通' },
      { side: 'debit', accountId: 'expense.travel', taxCode: 'JP-IN-8R-S', amount: 540, partner: 'サンプル交通' },
      { side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 1640, partner: 'テスト太郎' },
    ]);
    const sum = (side: string): number => lines.filter((line) => line.side === side).reduce((total, line) => total + line.amount, 0);
    expect(sum('debit')).toBe(sum('credit'));
  });

  it('正常: 内訳が無ければ費目の既定税率で借方 1 行', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1')), policy([category('taxi', { defaultTaxRate: 8 })]));
    expect(drafts[0]!.lines.filter((line) => line.side === 'debit')).toEqual([{ side: 'debit', accountId: 'expense.travel', taxCode: 'JP-IN-8R-S', amount: 3200, partner: 'サンプル交通' }]);
  });

  it('正常: 1 明細 = 1 仕訳で、日付・タグ・登録番号（qualified）を持つ', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1'), item('i2', { transactionDate: '2026-09-11' })), policy());
    expect(drafts.map((draft) => draft.source.itemId)).toEqual(['i1', 'i2']);
    expect(drafts[0]).toMatchObject({ date: '2026-09-10', invoiceStatus: 'qualified', registrationNumber: REG, tags: ['expense', 'expense-claim:c1', 'expense-item:i1'] });
  });

  it('境界: 登録番号なし・取引日 2026-09-30 は経過措置 80%（JP-IN-10-S-D80）', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1', { registrationNumber: undefined, transactionDate: '2026-09-30' })), policy());
    expect(drafts[0]!.invoiceStatus).toBe('transitional');
    expect(drafts[0]!.registrationNumber).toBeUndefined();
    expect(drafts[0]!.lines[0]!.taxCode).toBe('JP-IN-10-S-D80');
  });

  it('境界: 登録番号なし・取引日 2026-10-01 は経過措置 70%（JP-IN-10-S-D70）', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1', { registrationNumber: undefined, transactionDate: '2026-10-01' })), policy());
    expect(drafts[0]!.lines[0]!.taxCode).toBe('JP-IN-10-S-D70');
  });

  it('正常: 経過措置の 8% 行は通常コードのまま警告を付ける', () => {
    const facts = { registrationNumber: undefined, amount: 540, totalsByRate: [{ rate: 8 as const, taxableAmount: 540, amountIncludesTax: true }] };
    const { drafts, warnings } = buildJournalDrafts(claimWith(item('i1', facts)), policy());
    expect(drafts[0]!.lines[0]!.taxCode).toBe('JP-IN-8R-S');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('軽減税率の経過措置の税区分が無いため');
  });

  it('境界: invoice.exemptBelow 未満は not_required（通常コード）、ちょうどは経過措置', () => {
    const cats = [category('taxi', { invoice: { required: true, exemptBelow: 30_001 } })];
    const below = buildJournalDrafts(claimWith(item('i1', { registrationNumber: undefined, amount: 30_000 })), policy(cats));
    expect(below.drafts[0]).toMatchObject({ invoiceStatus: 'not_required' });
    expect(below.drafts[0]!.lines[0]!.taxCode).toBe('JP-IN-10-S');
    const equal = buildJournalDrafts(claimWith(item('i1', { registrationNumber: undefined, amount: 30_001 })), policy(cats));
    expect(equal.drafts[0]!.invoiceStatus).toBe('transitional');
  });

  it('正常: 費目のインボイスが不要なら登録番号があっても not_required で登録番号を載せない', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1')), policy([category('taxi', { invoice: { required: false } })]));
    expect(drafts[0]!.invoiceStatus).toBe('not_required');
    expect(drafts[0]!.registrationNumber).toBeUndefined();
  });
});

describe('buildJournalDrafts: 摘要と取引先', () => {
  it('正常: 摘要テンプレートを置換し、未知のキーは空にして空白を詰める', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1')), policy(undefined, { descriptionTemplate: '{claimant}  {unknown} {payee} {category} {purpose} {description} {claimId}' }));
    expect(drafts[0]!.description).toBe('テスト太郎 サンプル交通 費目taxi 客先訪問 タクシー代 c1');
  });

  it('境界: 置換結果が空なら費目名', () => {
    const empty = buildJournalDrafts(claimWith(item('i1')), policy(undefined, { descriptionTemplate: '' }));
    expect(empty.drafts[0]!.description).toBe('費目taxi');
    const blank = buildJournalDrafts(claimWith(item('i1', { purpose: undefined })), policy(undefined, { descriptionTemplate: ' {purpose} ' }));
    expect(blank.drafts[0]!.description).toBe('費目taxi');
  });

  it('正常: partnerFrom payee なら貸方の取引先は支払先', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1')), policy(undefined, { partnerFrom: 'payee' }));
    expect(drafts[0]!.lines.at(-1)).toMatchObject({ side: 'credit', partner: 'サンプル交通' });
  });

  it('境界: partnerFrom payee で支払先が無ければ取引先を持たない', () => {
    const { drafts } = buildJournalDrafts(claimWith(item('i1', { payeeName: undefined })), policy(undefined, { partnerFrom: 'payee' }));
    for (const line of drafts[0]!.lines) expect(line).not.toHaveProperty('partner');
  });
});

describe('buildJournalDrafts: problems', () => {
  it('異常: 費目が無い・見つからない明細は category-missing（明細へ導線）で、他の明細も作らない', () => {
    const result = buildJournalDrafts(claimWith(item('ok'), item('none', {}, { categoryId: undefined }), item('unknown', {}, { categoryId: 'gone' })), policy());
    expect(result.drafts).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.problems.map((problem) => [problem.itemId, problem.code, problem.fixTarget])).toEqual([['none', 'category-missing', 'item'], ['unknown', 'category-missing', 'item']]);
  });

  it('異常: 費目に科目が無ければ account-missing（規程の費目へ導線）', () => {
    const result = buildJournalDrafts(claimWith(item('i1')), policy([category('taxi', { accountId: undefined })]));
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual([expect.objectContaining({ itemId: 'i1', code: 'account-missing', fixTarget: 'policy-category', categoryId: 'taxi' })]);
  });

  it('異常: 取引日・金額が無い明細は date-missing / amount-missing', () => {
    const result = buildJournalDrafts(claimWith(item('i1', { transactionDate: undefined }), item('i2', { amount: 0 })), policy());
    expect(result.drafts).toEqual([]);
    expect(result.problems.map((problem) => problem.code)).toEqual(['date-missing', 'amount-missing']);
  });

  it('異常: 内訳の合計と金額が 1 円でも違えば totals-mismatch（端数を寄せない）', () => {
    const facts = { amount: 1101, totalsByRate: [{ rate: 10 as const, taxableAmount: 1100, amountIncludesTax: true }] };
    const result = buildJournalDrafts(claimWith(item('i1', facts)), policy());
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual([expect.objectContaining({ code: 'totals-mismatch', fixTarget: 'item' })]);
    expect(result.problems[0]!.message).toContain('1100 円が金額 1101 円');
  });

  it('異常: 該当税率の税区分コードが無ければ tax-code-missing', () => {
    const facts = { amount: 540, totalsByRate: [{ rate: 8 as const, taxableAmount: 540, amountIncludesTax: true }] };
    const result = buildJournalDrafts(claimWith(item('i1', facts)), policy([category('taxi', { taxCodeByRate: { '10': 'JP-IN-10-S' } })]));
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual([expect.objectContaining({ code: 'tax-code-missing', fixTarget: 'policy-category', categoryId: 'taxi' })]);
  });
});

describe('renderDescriptionTemplate / amountsByRate / invoiceStatusFor', () => {
  it('正常: renderDescriptionTemplate は値の無いキーを空にする', () => {
    expect(renderDescriptionTemplate('{a}-{b} {c}', { a: 'x', b: undefined })).toBe('x-');
  });

  it('正常: amountsByRate は税抜の内訳を税込に揃え、0% も含む', () => {
    const rows = amountsByRate({ totalsByRate: [{ rate: 10, taxableAmount: 1000, amountIncludesTax: false }, { rate: 0, taxableAmount: 50, amountIncludesTax: true }] }, { defaultTaxRate: 8 }, 1150);
    expect(rows).toEqual([{ rate: 10, amount: 1100 }, { rate: 0, amount: 50 }]);
  });

  it('境界: amountsByRate は空の内訳を内訳なしとして既定税率で全額', () => {
    expect(amountsByRate({ totalsByRate: [] }, { defaultTaxRate: 0 }, 500)).toEqual([{ rate: 0, amount: 500 }]);
  });

  it('境界: invoiceStatusFor は金額が無ければ免除額で判断しない', () => {
    expect(invoiceStatusFor({ transactionDate: '2026-09-30' }, { invoice: { required: true, exemptBelow: 100 } })).toBe('transitional');
    expect(invoiceStatusFor({ transactionDate: '2032-01-01' }, { invoice: { required: true } })).toBe('none');
  });
});

describe('departmentDimensionFor（§20.12）', () => {
  const organization = { departments: [{ id: 'sales', name: '営業部', journalDimensionValueId: 'dept-sales', enabled: true }, { id: 'admin', name: '管理本部', enabled: true }] };
  const claimOf = (departmentId?: string) => ({ claimant: { name: 'テスト太郎', ...(departmentId === undefined ? {} : { employeeId: 'emp-taro', departmentId }) } });
  const withDimension = policy(undefined, { departmentDimensionId: 'department' });

  it('正常: 規程の補助軸 id と申請者の部門の値がそろえば { 補助軸 id: 値 id }', () => {
    expect(departmentDimensionFor(claimOf('sales'), withDimension, organization)).toEqual({ department: 'dept-sales' });
  });

  it.each([
    ['規程に補助軸 id が無い', claimOf('sales'), policy(), organization],
    ['組織を渡さない', claimOf('sales'), withDimension, undefined],
    ['部門に値が無い', claimOf('admin'), withDimension, organization],
    ['組織に無い部門', claimOf('gone'), withDimension, organization],
    ['申請者に部門が無い', claimOf(), withDimension, organization],
  ])('境界: %s なら入れない（警告にもしない）', (_label, claim, target, org) => {
    expect(departmentDimensionFor(claim, target, org)).toBeUndefined();
  });
});

describe('buildJournalDrafts: 部門の補助軸と会社払い（§20.12）', () => {
  const organization = { departments: [{ id: 'sales', name: '営業部', journalDimensionValueId: 'dept-sales', enabled: true }] };
  const salesClaim = (...items: ExpenseItem[]): ExpenseClaim => createExpenseClaim({
    tenant: { tenantId: 'tenant', workspaceId: 'workspace' }, id: 'c1', claimant: { name: 'テスト太郎', employeeId: 'emp-taro', departmentId: 'sales' },
    period: { from: '2026-09-01', to: '2026-10-31' }, items, submittedBy: 'tester', createdAt: AT, updatedAt: AT,
  });
  const corporatePolicy = (): ExpensePolicy => {
    const base = policy();
    return createExpensePolicy({ ...base, card: { ...base.card, acceptCorporatePaymentItems: true, creditAccountId: 'liability.card_payables', creditTaxCode: 'JP-NA-CARD' } });
  };

  it('正常: 組織を渡すと税率ごとの借方すべてに部門の補助軸を入れ、貸方には入れない。出所は claim-item', () => {
    const facts = { amount: 1640, totalsByRate: [{ rate: 10 as const, taxableAmount: 1100, amountIncludesTax: true }, { rate: 8 as const, taxableAmount: 540, amountIncludesTax: true }] };
    const { drafts, problems } = buildJournalDrafts(salesClaim(item('i1', facts)), policy(undefined, { departmentDimensionId: 'department' }), { organization });
    expect(problems).toEqual([]);
    expect(drafts[0]!.source).toEqual({ kind: 'claim-item', id: 'c1', itemId: 'i1' });
    expect(drafts[0]!.lines).toEqual([
      { side: 'debit', accountId: 'expense.travel', taxCode: 'JP-IN-10-S', amount: 1100, partner: 'サンプル交通', dimensionValues: { department: 'dept-sales' } },
      { side: 'debit', accountId: 'expense.travel', taxCode: 'JP-IN-8R-S', amount: 540, partner: 'サンプル交通', dimensionValues: { department: 'dept-sales' } },
      { side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 1640, partner: 'テスト太郎' },
    ]);
  });

  it('境界: 組織を渡さなければ（既定）補助軸を入れない', () => {
    const { drafts } = buildJournalDrafts(salesClaim(item('i1')), policy(undefined, { departmentDimensionId: 'department' }));
    expect(drafts[0]!.lines.some((line) => 'dimensionValues' in line)).toBe(false);
  });

  it('正常: 会社払いを申請に含める運用では、会社払いの明細の貸方をカードの未払金にし、出所 card-item とタグ expense-card を付ける', () => {
    const { drafts } = buildJournalDrafts(salesClaim(item('i1'), item('i2', { corporatePayment: true, paymentMethod: 'credit_card' })), corporatePolicy(), { corporatePartner: 'サンプルカード' });
    expect(drafts[0]!.source.kind).toBe('claim-item');
    expect(drafts[0]!.lines.at(-1)).toEqual({ side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 3200, partner: 'テスト太郎' });
    expect(drafts[1]).toMatchObject({ source: { kind: 'card-item', id: 'c1', itemId: 'i2' }, tags: ['expense', 'expense-claim:c1', 'expense-item:i2', 'expense-card'] });
    expect(drafts[1]!.lines.at(-1)).toEqual({ side: 'credit', accountId: 'liability.card_payables', taxCode: 'JP-NA-CARD', amount: 3200, partner: 'サンプルカード' });
  });

  it('境界: カードの取引先が分からなければ貸方に取引先を付けない。運用が off なら会社払いでも従業員への未払のまま', () => {
    const corporate = item('i1', { corporatePayment: true, paymentMethod: 'credit_card' });
    expect(buildJournalDrafts(salesClaim(corporate), corporatePolicy()).drafts[0]!.lines.at(-1)).toEqual({ side: 'credit', accountId: 'liability.card_payables', taxCode: 'JP-NA-CARD', amount: 3200 });
    const off = buildJournalDrafts(salesClaim(corporate), policy()).drafts[0]!;
    expect(off.source.kind).toBe('claim-item');
    expect(off.lines.at(-1)).toMatchObject({ accountId: 'liability.other_payables', partner: 'テスト太郎' });
    expect(off.tags).not.toContain('expense-card');
  });
});

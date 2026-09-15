import { describe, expect, it } from 'vitest';
import { parseCsv } from '../journal/csv';
import { claimFingerprint, createExpenseClaim, type CreateExpenseClaimProps, type ExpenseClaim, type ExpenseItem } from './claim';
import { defaultExpensePolicy } from './default-policy';
import type { ReceiptFacts } from './receipt-facts';
import { buildSettlementCsv, DETAIL_COLUMNS, PAYOUT_COLUMNS } from './settlement-csv';

// domain のテストは adapters のフィクスチャを使えない（依存ルール domain-no-adapters）ので、ここで組み立てる
const AT = '2026-09-14T00:00:00.000Z';
const policyFixture = (updatedAt = AT) => defaultExpensePolicy(updatedAt);
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
function claimFixture(id: string, overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return createExpenseClaim({
    tenant: { tenantId: 'tenant', workspaceId: 'workspace' }, id, claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部' },
    period: { from: '2026-09-01', to: '2026-09-30' }, items: [itemFixture('item-1')], submittedBy: 'tester', createdAt: AT, updatedAt: AT,
    ...overrides,
  });
}

const POLICY = policyFixture(AT);
// 承認は UTC 15:30 = 日本時間の翌日。精算 CSV の承認日は業務タイムゾーンの暦日にする
const APPROVED_AT = '2026-09-30T15:30:00.000Z';

function approvedClaim(id: string, overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  const base = { status: 'approved' as const, approval: { by: 'boss-subject', displayName: '上司', at: APPROVED_AT }, journalLink: { entries: [{ itemId: 'item-1', entryId: 'entry-1' }], complete: true, draftedAt: APPROVED_AT, by: 'acct', warnings: [] } };
  return claimFixture(id, { ...base, ...overrides });
}

function judgmentOf(claim: ExpenseClaim, policyUpdatedAt: string) {
  return { verdict: 'pass' as const, items: [], claimReasons: [], totals: { amount: 0, byCategory: [] }, searchKeysComplete: true, policyUpdatedAt, itemsFingerprint: claimFingerprint(claim), checkedAt: AT };
}

const rowsOf = (content: string): string[][] => parseCsv(content);

describe('buildSettlementCsv: payout', () => {
  it('正常: BOM・CRLF・列順・YYYY/MM/DD・合計で 1 申請 1 行', () => {
    const claim = approvedClaim('c1', { items: [itemFixture('item-1', { amount: 1000 }), itemFixture('item-2', { amount: 2500 }), itemFixture('item-3', { amount: 0 })] });
    const result = buildSettlementCsv({ format: 'payout', claims: [claim], policy: POLICY, today: '2026-10-01' });
    expect(result.content.startsWith('﻿')).toBe(true);
    expect(result.content).toContain('\r\n');
    expect(result.content.replace(/\r\n/gu, '')).not.toContain('\n');
    const [header, row] = rowsOf(result.content);
    expect(header).toEqual([...PAYOUT_COLUMNS]);
    expect(row).toEqual(['c1', 'テスト太郎', 'E001', '営業部', '2026/09/01', '2026/09/30', '3', '3500', '上司', '2026/10/01']);
    expect(result).toMatchObject({ format: 'payout', fileName: 'expense-payout-2026-10-01.csv', claimCount: 1, itemCount: 3, totalAmount: 3500, warnings: [] });
  });

  it('正常: 表示名が無ければ承認者の subject、タイムゾーン指定で承認日が変わる', () => {
    const claim = approvedClaim('c1', { approval: { by: 'boss-subject', at: APPROVED_AT }, claimant: { name: '太郎' } });
    const [, row] = rowsOf(buildSettlementCsv({ format: 'payout', claims: [claim], policy: POLICY, today: '2026-10-01', timeZone: 'UTC' }).content);
    expect(row?.slice(-2)).toEqual(['boss-subject', '2026/09/30']);
    expect(row?.slice(2, 4)).toEqual(['', '']);
  });

  it('境界: 申請 0 件はヘッダだけ', () => {
    const result = buildSettlementCsv({ format: 'payout', claims: [], policy: POLICY, today: '2026-10-01' });
    expect(rowsOf(result.content)).toEqual([[...PAYOUT_COLUMNS]]);
    expect(result).toMatchObject({ claimCount: 0, itemCount: 0, totalAmount: 0, warnings: [] });
  });
});

describe('buildSettlementCsv: detail', () => {
  it('正常: 1 明細 1 行で DETAIL_COLUMNS の列順、税額列は既定税率から計算する', () => {
    const claim = approvedClaim('c1', {
      items: [itemFixture('item-1', { amount: 3300, registrationNumber: 'T1234567890123', paymentMethod: 'cash', attendees: { count: 3, names: ['甲', '乙'] }, unitCount: 2, preApprovalRef: 'R-1', dateSource: 'read' }, { receiptId: 'r1', source: { type: 'image', fileName: 'receipt.png' } })],
      acknowledgements: [{ itemId: 'item-1', code: 'purpose-missing', note: 'ok', by: 'boss', at: AT }, { itemId: 'item-1', code: 'payee-missing', note: 'ok', by: 'boss', at: AT }, { code: 'policy-unreviewed', note: 'ok', by: 'boss', at: AT }],
    });
    const result = buildSettlementCsv({ format: 'detail', claims: [claim], policy: POLICY, today: '2026-10-01' });
    const [header, row] = rowsOf(result.content);
    expect(header).toEqual([...DETAIL_COLUMNS]);
    const record = Object.fromEntries(DETAIL_COLUMNS.map((column, index) => [column, row?.[index]]));
    expect(record).toEqual({
      claim_id: 'c1', item_id: 'item-1', claimant: 'テスト太郎', employee_code: 'E001', department: '営業部', transaction_date: '2026/09/10', date_source: 'read',
      payee: 'サンプル交通', category_id: 'transport.taxi', category: 'タクシー', account_id: 'expense.travel', amount: '3300', tax_10_amount: '300', tax_8_amount: '0',
      registration_number: 'T1234567890123', invoice_status: 'qualified', payment_method: 'cash', purpose: '客先訪問', attendees: '3', attendee_names: '甲;乙',
      unit_count: '2', pre_approval_ref: 'R-1', description: 'タクシー代', receipt_file: 'receipt.png', acknowledged_codes: 'purpose-missing;payee-missing',
      approved_by: '上司', approved_at: '2026/10/01', journal_entry_id: 'entry-1',
    });
    expect(result.fileName).toBe('expense-detail-2026-10-01.csv');
  });

  it('正常: 税率別の内訳があれば税額列は内訳から、会社払いは corporate、ファイル名が無ければ証憑 id', () => {
    const claim = approvedClaim('c1', { items: [itemFixture('item-1', { amount: 1640, corporatePayment: true, paymentMethod: 'credit_card', totalsByRate: [{ rate: 10, taxableAmount: 1100, amountIncludesTax: true }, { rate: 8, taxableAmount: 540, taxAmount: 40, amountIncludesTax: true }] }, { receiptId: 'r9' })] });
    const [, row] = rowsOf(buildSettlementCsv({ format: 'detail', claims: [claim], policy: POLICY, today: '2026-10-01' }).content);
    const record = Object.fromEntries(DETAIL_COLUMNS.map((column, index) => [column, row?.[index]]));
    expect(record).toMatchObject({ tax_10_amount: '100', tax_8_amount: '40', payment_method: 'corporate', receipt_file: 'r9' });
  });

  it('境界: 費目が見つからない・金額が無い明細は税額・費目・インボイス区分を空にする', () => {
    const claim = approvedClaim('c1', { items: [itemFixture('item-1', { amount: 0 }, { categoryId: 'gone' }), itemFixture('item-2', {}, { categoryId: undefined })] });
    const [, first, second] = rowsOf(buildSettlementCsv({ format: 'detail', claims: [claim], policy: POLICY, today: '2026-10-01' }).content);
    const pick = (row: string[] | undefined) => Object.fromEntries(['category', 'account_id', 'amount', 'tax_10_amount', 'tax_8_amount', 'invoice_status', 'journal_entry_id'].map((column) => [column, row?.[DETAIL_COLUMNS.indexOf(column as (typeof DETAIL_COLUMNS)[number])]]));
    expect(pick(first)).toEqual({ category: '', account_id: '', amount: '', tax_10_amount: '', tax_8_amount: '', invoice_status: '', journal_entry_id: 'entry-1' });
    expect(pick(second)).toMatchObject({ category: '', tax_10_amount: '', invoice_status: '', journal_entry_id: '' });
  });

  it('正常: 既定税率 8% の費目は tax_8_amount に計算する', () => {
    const policy = { ...POLICY, categories: POLICY.categories.map((category) => (category.id === 'transport.taxi' ? { ...category, defaultTaxRate: 8 as const } : category)) };
    const [, row] = rowsOf(buildSettlementCsv({ format: 'detail', claims: [approvedClaim('c1', { items: [itemFixture('item-1', { amount: 1080 })] })], policy, today: '2026-10-01' }).content);
    expect([row?.[DETAIL_COLUMNS.indexOf('tax_10_amount')], row?.[DETAIL_COLUMNS.indexOf('tax_8_amount')]]).toEqual(['0', '80']);
  });
});

describe('buildSettlementCsv: warnings', () => {
  it('異常: 支払先の無い明細・仕訳下書きの無い申請・規程変更前の判定の 3 種を出す', () => {
    const noPayee = approvedClaim('c1', { items: [itemFixture('item-1', { payeeName: undefined, description: undefined })] });
    const partial = approvedClaim('c2', { journalLink: { entries: [], complete: false, draftedAt: AT, by: 'acct', warnings: [] } });
    const withoutLink = claimFixture('c3', { status: 'approved', approval: { by: 'b', at: AT } });
    const base = approvedClaim('c4');
    const oldJudgment = claimFixture('c4', { status: 'approved', approval: { by: 'b', at: AT }, journalLink: base.journalLink!, judgment: judgmentOf(base, '2020-01-01T00:00:00.000Z') });
    const currentJudgment = claimFixture('c5', { status: 'approved', approval: { by: 'b', at: AT }, journalLink: base.journalLink!, judgment: judgmentOf(base, POLICY.updatedAt) });
    const result = buildSettlementCsv({ format: 'payout', claims: [noPayee, partial, withoutLink, oldJudgment, currentJudgment], policy: POLICY, today: '2026-10-01' });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toBe('支払先が無い明細が 1 件あります（電子帳簿保存法の検索要件「取引先」を満たしません）: c1「明細 1」');
    expect(result.warnings[1]).toBe('仕訳下書きを作成していない申請が 2 件あります: c2, c3');
    expect(result.warnings[2]).toBe('規程を変更する前の規程で判定したまま承認された申請が 1 件あります: c4');
  });

  it('境界: 警告に並べる id は 5 件までで残りは件数', () => {
    const claims = Array.from({ length: 7 }, (_, index) => claimFixture(`c${index}`, { status: 'approved', approval: { by: 'b', at: AT } }));
    const result = buildSettlementCsv({ format: 'detail', claims, policy: POLICY, today: '2026-10-01' });
    expect(result.warnings).toEqual(['仕訳下書きを作成していない申請が 7 件あります: c0, c1, c2, c3, c4 ほか 2 件']);
  });
});

describe('buildSettlementCsv: 従業員へ支払う額（§20.2.3）', () => {
  const mixed = (): ExpenseClaim => approvedClaim('c1', { items: [itemFixture('item-1', { amount: 1000 }), itemFixture('item-2', { amount: 500, corporatePayment: true, paymentMethod: 'credit_card' })] });
  const accepting = { ...POLICY, card: { ...POLICY.card, acceptCorporatePaymentItems: true } };

  it('正常: 会社払いを申請に含める運用（フラグ on）では、total_amount と合計から会社払いの明細を除く（明細数は数える）', () => {
    const result = buildSettlementCsv({ format: 'payout', claims: [mixed()], policy: accepting, today: '2026-10-01' });
    expect(rowsOf(result.content)[1]?.[PAYOUT_COLUMNS.indexOf('total_amount')]).toBe('1000');
    expect(result).toMatchObject({ totalAmount: 1000, itemCount: 2, claimCount: 1 });
  });

  it('境界: フラグ off（既定）なら MVP どおり会社払いも含めた合計', () => {
    const result = buildSettlementCsv({ format: 'payout', claims: [mixed()], policy: POLICY, today: '2026-10-01' });
    expect(rowsOf(result.content)[1]?.[PAYOUT_COLUMNS.indexOf('total_amount')]).toBe('1500');
    expect(result.totalAmount).toBe(1500);
  });

  it('正常: 明細形式でも合計は支払う額で、会社払いの明細の行は残す（payment_method = corporate）', () => {
    const result = buildSettlementCsv({ format: 'detail', claims: [mixed()], policy: accepting, today: '2026-10-01' });
    expect(result.totalAmount).toBe(1000);
    const rows = rowsOf(result.content).slice(1).filter((row) => row.length > 1);
    expect(rows.map((row) => [row[DETAIL_COLUMNS.indexOf('item_id')], row[DETAIL_COLUMNS.indexOf('amount')], row[DETAIL_COLUMNS.indexOf('payment_method')]])).toEqual([['item-1', '1000', ''], ['item-2', '500', 'corporate']]);
  });
});

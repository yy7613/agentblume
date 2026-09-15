/**
 * adapters層: 経費精算リポジトリの共有契約テストが使う組み立て（テスト専用）。
 *
 * すべて domain の create* を通すので、契約テストが「保存できるはずのない値」を保存して実装差を見逃すことがない。
 */
import { createExpenseClaim, type CreateExpenseClaimProps, type ExpenseClaim, type ExpenseItem } from '../../domain/expense/claim';
import { defaultExpensePolicy } from '../../domain/expense/default-policy';
import type { ExpensePolicy } from '../../domain/expense/policy';
import { createExpenseReceipt, type ExpenseReceipt } from '../../domain/expense/receipt';
import type { ReceiptFacts } from '../../domain/expense/receipt-facts';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
export const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
export const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

export const AT = '2026-09-14T00:00:00.000Z';
/** 1x1 の PNG（形が data URL の検証を通ればよいので中身は問わない）。 */
export const SAMPLE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

export function policyFixture(updatedAt = AT): ExpensePolicy {
  return defaultExpensePolicy(updatedAt);
}

export function itemFixture(id: string, facts: Partial<ReceiptFacts> = {}, overrides: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id,
    categoryId: 'transport.taxi',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプル交通', amount: 3200, description: 'タクシー代', purpose: '客先訪問', ...facts },
    source: { type: 'manual' },
    extraction: { method: 'manual', warnings: [] },
    addedOn: '2026-09-14',
    ...overrides,
  };
}

export function claimFixture(id: string, overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return createExpenseClaim({
    tenant: scope,
    id,
    claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部' },
    period: { from: '2026-09-01', to: '2026-09-30' },
    items: [itemFixture('item-1')],
    acknowledgements: [],
    history: [{ type: 'created', by: 'tester', at: AT }],
    submittedBy: 'tester',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function receiptFixture(id: string, overrides: Partial<ExpenseReceipt> = {}): ExpenseReceipt {
  return createExpenseReceipt({
    tenant: scope,
    id,
    claimId: 'claim-1',
    itemId: 'item-1',
    source: { type: 'image', fileName: 'receipt.png', mime: 'image/png', dataUrl: SAMPLE_DATA_URL },
    sha256: SHA_A,
    createdAt: AT,
    ...overrides,
  });
}

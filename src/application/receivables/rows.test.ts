import { describe, expect, it } from 'vitest';
import {
  InMemoryBankTransactionRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository, InMemoryMatchingRepository, InMemoryReceivablesSettingsRepository,
} from '../../adapters/storage/in-memory-receivables-repositories';
import type { Row } from '../../domain/data/types';
import { createBankTransaction } from '../../domain/receivables/bank-transaction';
import { createInvoice } from '../../domain/receivables/invoice';
import type { MatchJudgment } from '../../domain/receivables/matching';
import { createMatching } from '../../domain/receivables/matching-aggregate';
import { RECEIVABLES_INVOICE_DRAFT_SCHEMA } from '../../domain/etl/nodes/receivables-invoice-draft';
import { RECEIVABLES_MATCH_CANDIDATES_SCHEMA } from '../../domain/etl/nodes/receivables-match-candidates';
import { RECEIVABLES_OUTSTANDING_SCHEMA } from '../../domain/etl/nodes/receivables-outstanding';
import { resolveRowSourceNode } from '../data-source/row-sources';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import type { OrderDocumentReaderPort } from './ports';
import { matchReasonMessage } from './reason-messages';
import { receivablesRowSources } from './row-sources';
import { InvoiceDraftRowsProvider, MatchCandidateRowsProvider, OutstandingInvoiceRowsProvider } from './rows';
import { AT, customerOf, issuerSettings, NOW, scope } from './receivables-usecases.fixtures';

const snapshot = { issuer: issuerSettings().issuer, customer: { name: '旧社名', honorific: '御中' }, roundingMode: 'floor' as const, issuedAt: AT };
const issued = (id: string, amount: number, overrides: Partial<Parameters<typeof createInvoice>[0]> = {}) => createInvoice({
  tenant: scope, id, number: `INV-${id}`, status: 'issued', customerId: 'c1', issueDate: '2026-09-01', transactionDate: '2026-09-01', dueDate: '2026-09-20',
  pricing: 'inclusive', lines: [{ description: 'x', amount, taxRate: 10 }], roundingMode: 'floor', snapshot, journal: { salesEntryId: `e-${id}` }, createdAt: AT, updatedAt: AT, ...overrides,
});
const deposit = (id: string, amount: number, payer: string, date = '2026-09-25') => createBankTransaction({
  tenant: scope, id, accountKey: 'main', date, amount, description: payer, payerName: payer, payerNameNorm: payer, source: { row: {}, rowNumber: 2 }, fingerprint: `fp-${id}`, createdAt: AT, updatedAt: AT,
});
const columnsOf = (row: Row) => Object.keys(row).sort();
const schemaColumns = (schema: { columns: readonly { name: string }[] }) => schema.columns.map((column) => column.name).sort();

async function repos() {
  const context = {
    settings: new InMemoryReceivablesSettingsRepository(), customers: new InMemoryCustomerRepository(), invoices: new InMemoryInvoiceRepository(),
    transactions: new InMemoryBankTransactionRepository(), matchings: new InMemoryMatchingRepository(),
  };
  await context.settings.save(scope, issuerSettings());
  return context;
}

describe('OutstandingInvoiceRowsProvider', () => {
  it('正常: 期日の古い順（期日なしは末尾）、固定スキーマの列、取引先名は現在のマスタ（消えていれば写し）、最終入金日', async () => {
    const context = await repos();
    await context.customers.save(customerOf('c1', { name: '山田商事' }));
    await context.invoices.save(issued('late', 30_000, { dueDate: undefined }));
    await context.invoices.save({ ...issued('partial', 20_000, { dueDate: '2026-09-10', paidAmount: 5_000, status: 'partially_paid' }) });
    await context.invoices.save(issued('gone', 10_000, { customerId: 'deleted' }));
    await context.invoices.save(createInvoice({ tenant: scope, id: 'draft', pricing: 'exclusive', lines: [], roundingMode: 'floor', createdAt: AT, updatedAt: AT }));
    await context.transactions.save(deposit('t', 5_000, 'x', '2026-09-15'));
    await context.matchings.save(createMatching({ tenant: scope, id: 'm', transactionId: 't', transactionAmount: 5_000, allocations: [{ invoiceId: 'partial', amount: 5_000 }], feeAmount: 0, decidedBy: 'manual', confirmedAt: AT, createdAt: AT, updatedAt: AT }));
    const rows = await new OutstandingInvoiceRowsProvider(context.invoices, context.customers, context.matchings, context.transactions, () => NOW).rows(scope);
    expect(rows.map((row) => [row['invoice_id'], row['customer_name'], row['outstanding_amount'], row['days_overdue'], row['last_payment_date']])).toEqual([
      ['partial', '山田商事', 15_000, 20, '2026-09-15'],
      ['gone', '旧社名', 10_000, 10, null],
      ['late', '山田商事', 30_000, 0, null],
    ]);
    expect(columnsOf(rows[0]!)).toEqual(schemaColumns(RECEIVABLES_OUTSTANDING_SCHEMA));
    expect(rows[2]).toMatchObject({ due_date: null, status: 'issued', sales_entry_id: 'e-late' });
    expect(await new OutstandingInvoiceRowsProvider(context.invoices, context.customers, context.matchings, context.transactions, () => NOW).rows(scope, { limit: 1 })).toHaveLength(1);
  });
});

describe('MatchCandidateRowsProvider', () => {
  it('正常: 候補ごとに 1 行、候補の無い入金も候補列が null の 1 行。判定は保存しない', async () => {
    const context = await repos();
    await context.customers.save(customerOf('c1', { name: 'テスト工業', kana: 'テストコウギヨウ' }));
    await context.invoices.save(issued('a', 33_000));
    await context.invoices.save(issued('b', 22_000));
    await context.transactions.save(deposit('combined', 55_000, 'テストコウギヨウ'));
    await context.transactions.save(deposit('unknown', 12_345, 'フメイ'));
    const rows = await new MatchCandidateRowsProvider(context).rows(scope, { limit: 10, maxCandidates: 5 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ transaction_id: 'combined', stage: 'candidate', reason: 'combined-payment', invoice_ids: 'a,b', invoice_numbers: 'INV-a,INV-b', customer_name: 'テスト工業', combination_size: 2, name_match: 'kana', name_score: 1, difference: 0 });
    expect(rows[0]!['reason_message']).toBe('テスト工業 の請求 2 件（INV-a、INV-b）の合計が入金額と一致しました');
    expect(rows[1]).toMatchObject({ transaction_id: 'unknown', reason: 'no-candidate', candidate_rank: null, invoice_ids: null, name_score: null });
    for (const row of rows) expect(columnsOf(row)).toEqual(schemaColumns(RECEIVABLES_MATCH_CANDIDATES_SCHEMA));
    expect((await context.transactions.findById(scope, 'combined'))!.judgment).toBeUndefined();
  });
});

describe('InvoiceDraftRowsProvider', () => {
  const reader = (read: Awaited<ReturnType<OrderDocumentReaderPort['read']>>): OrderDocumentReaderPort & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, read: async ({ fileName }) => { calls.push(fileName); return read; } };
  };

  it('正常: 1 枚ずつ読み、明細ごとに 1 行。計算値と印字の差・違反・draft_json を載せる（保存しない）', async () => {
    const context = await repos();
    const port = reader({ issuerName: '未登録商店', transactionDate: '2026-09-20', grandTotal: 3_300, totalsByRate: [{ rate: 10, taxableAmount: 3_000, taxAmount: 300, amountIncludesTax: false }], lines: [{ description: 'A', quantity: 1, unitPrice: 1_000, amount: 1_000, taxRate: 10 }, { description: 'B', amount: 2_001, taxRate: 10 }], warnings: ['読みにくい'] });
    const rows = await new InvoiceDraftRowsProvider(port, context.settings, context.customers).rows(scope, [{ name: 'po.png', dataUrl: 'data:image/png;base64,AA==' }, { name: 'second.png', dataUrl: 'data:image/png;base64,AA==' }], { limit: 1 });
    expect(port.calls).toEqual(['po.png']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ file_name: 'po.png', customer_name: '未登録商店', customer_id: null, pricing: 'exclusive', line_no: 1, unit_price: 1_000, taxable_10: 3_001, tax_10: 300, grand_total: 3_301, document_total: 3_300, total_difference: -1, violations: 'issue-date-missing' });
    expect(rows[0]!['warnings']).toBe('due-date-missing, declared-total-mismatch, 読みにくい');
    expect(JSON.parse(String(rows[0]!['draft_json']))).toMatchObject({ customerNameHint: '未登録商店', pricing: 'exclusive', lines: [{ description: 'A' }, { description: 'B' }] });
    for (const row of rows) expect(columnsOf(row)).toEqual(schemaColumns(RECEIVABLES_INVOICE_DRAFT_SCHEMA));
  });

  it('境界: 明細が読めなければ明細列が null の 1 行。合計が無ければ document_total も null', async () => {
    const context = await repos();
    const rows = await new InvoiceDraftRowsProvider(reader({ lines: [], warnings: [] }), context.settings, context.customers).rows(scope, [{ name: 'blank.png', dataUrl: 'x' }]);
    expect(rows).toEqual([expect.objectContaining({ line_no: null, description: null, amount: null, document_total: null, total_difference: null, grand_total: 0, warnings: 'due-date-missing' })]);
  });
});

describe('receivablesRowSources', () => {
  const node = (type: string, config: Record<string, unknown> = {}) => ({ id: 'n', type, config });

  it('正常: 3 つのノード型を登録し、行と固定スキーマで json-source に書き換える', async () => {
    const sources = receivablesRowSources({ outstanding: { rows: async (_scope, options) => [{ limit: options?.limit ?? null }] }, matchCandidates: { rows: async (_scope, options) => [{ max: options?.maxCandidates ?? null }] }, invoiceDraft: { rows: async (_scope, attachments) => [{ count: attachments.length }] } });
    expect(sources.map((source) => [source.nodeType, source.requirement])).toEqual([['receivables-outstanding', 'none'], ['receivables-match-candidates', 'none'], ['receivables-invoice-draft', 'attachments']]);
    expect(await resolveRowSourceNode(sources[0]!, scope, node('receivables-outstanding', { limit: 500 }), undefined)).toEqual({ id: 'n', type: 'json-source', config: { rows: [{ limit: 500 }], schema: RECEIVABLES_OUTSTANDING_SCHEMA } });
    expect((await resolveRowSourceNode(sources[1]!, scope, node('x', { maxCandidates: 5 }), undefined)).config).toMatchObject({ rows: [{ max: 5 }] });
    expect((await resolveRowSourceNode(sources[2]!, scope, node('x'), { attachments: [{ name: 'a', dataUrl: 'b' }] })).config).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('異常: 設定の形が崩れていればポートを呼ばずに落とす。未配線は理由付き。添付が無ければ何を添付するかを言う', async () => {
    const sources = receivablesRowSources({ outstanding: { rows: async () => { throw new Error('should not be called'); } } });
    await expect(resolveRowSourceNode(sources[0]!, scope, node('x', { limit: 0 }), undefined)).rejects.toThrow(/limit must be an integer between 1 and 1000/);
    await expect(resolveRowSourceNode(sources[0]!, scope, node('x', { limit: '5' }), undefined)).rejects.toBeInstanceOf(DataSourceValidationError);
    await expect(resolveRowSourceNode(sources[1]!, scope, node('x'), undefined)).rejects.toThrow('receivables match candidates are not available');
    const draft = receivablesRowSources({ invoiceDraft: { rows: async () => [] } })[2]!;
    await expect(resolveRowSourceNode(draft, scope, node('x'), { attachments: [] })).rejects.toThrow(/attach the purchase order or quotation image/);
    // 文脈の無い呼び出し（保存時の点検）では添付必須のノードを書き換えない。
    expect(await resolveRowSourceNode(draft, scope, node('receivables-invoice-draft'), undefined)).toEqual(node('receivables-invoice-draft'));
  });
});

describe('matchReasonMessage（ツールの reason_message）', () => {
  const candidate = { invoiceIds: ['i1'], allocations: [{ invoiceId: 'i1', amount: 10_000 }], candidateTotal: 10_000, difference: 440, feeAmount: 440, customerId: 'c1', nameMatch: 'kana' as const, nameScore: 1, rank: 1 };
  const context = { payerName: 'ﾃｽﾄ', amount: 9_560, customerName: (id: string) => (id === 'c1' ? 'テスト工業' : '別会社'), invoiceNumber: (id: string) => `INV-${id}` };
  const message = (judgment: MatchJudgment, overrides = {}) => matchReasonMessage(judgment, { ...context, ...overrides });

  it('正常: 全理由コードで params を展開した原因の文を返す', () => {
    expect(message({ stage: 'decided', reason: 'exact-amount-and-name', candidates: [candidate] })).toBe('「ﾃｽﾄ」は テスト工業 の INV-i1（10,000 円）と金額・名義が一致しました');
    expect(message({ stage: 'candidate', reason: 'fee-difference', candidates: [candidate] })).toContain('440 円少ない入金です');
    expect(message({ stage: 'candidate', reason: 'combined-payment-with-fee', candidates: [candidate] })).toContain('1 件の合計より 440 円少ない');
    expect(message({ stage: 'candidate', reason: 'partial-payment', candidates: [candidate] })).toBe('INV-i1（残高 10,000 円）に対して 9,560 円の入金です。一部入金の可能性があります');
    expect(message({ stage: 'candidate', reason: 'name-partial', candidates: [candidate] })).toContain('一部だけ一致');
    expect(message({ stage: 'candidate', reason: 'amount-only', candidates: [candidate] }, { payerName: '' })).toContain('名義「（名義なし）」');
    expect(message({ stage: 'unmatched', reason: 'no-candidate', candidates: [] })).toBe('金額・名義が一致する未入金の請求がありません');
    expect(message({ stage: 'unmatched', reason: 'no-open-invoice', candidates: [] })).toBe('未入金の請求がありません');
    expect(message({ stage: 'unmatched', reason: 'no-open-invoice', candidates: [], params: { customerIds: 'c1' } })).toContain('テスト工業 の請求はすべて入金済み');
    expect(message({ stage: 'unmatched', reason: 'multiple-candidates', candidates: [candidate], params: { count: 2 } })).toContain('2 件あり');
    expect(message({ stage: 'unmatched', reason: 'multiple-candidates', candidates: [candidate] })).toContain('1 件あり');
    expect(message({ stage: 'unmatched', reason: 'ambiguous-combination', candidates: [], params: { count: 3 } })).toContain('3 通り');
    expect(message({ stage: 'unmatched', reason: 'ambiguous-combination', candidates: [candidate] })).toContain('1 通り');
    expect(message({ stage: 'unmatched', reason: 'search-limit', candidates: [], params: { pool: 20, evaluations: 50_000 } })).toContain('20 件 / 50,000 通りで打ち切り');
    expect(message({ stage: 'unmatched', reason: 'search-limit', candidates: [] })).toContain('0 通り');
    expect(message({ stage: 'unmatched', reason: 'alias-conflict', candidates: [], params: { customerIds: 'c1,c2' } })).toContain('テスト工業、別会社');
    expect(message({ stage: 'unmatched', reason: 'overpayment', candidates: [candidate], params: { excess: 2_000 } })).toBe('INV-i1 の残高 10,000 円より 2,000 円多い入金です');
    expect(message({ stage: 'unmatched', reason: 'overpayment', candidates: [candidate] })).toContain('0 円多い');
  });
});

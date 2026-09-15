import { describe, expect, it } from 'vitest';
import { scope } from '../../adapters/storage/expense-repository.fixtures';
import type { Row } from '../../domain/data/types';
import { EXPENSE_CLAIMS_SCHEMA } from '../../domain/etl/nodes/expense-claims-source';
import { EXPENSE_POLICY_SCHEMA } from '../../domain/etl/nodes/expense-policy-source';
import { EXPENSE_RECEIPT_CHECK_SCHEMA } from '../../domain/etl/nodes/expense-receipt-check';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import { resolveRowSourceNode, type RowSourceResolver } from '../data-source/row-sources';
import { EXPENSE_MISSING_RECEIPT_MESSAGE, expenseRowSources, type ExpenseRowSourcePorts } from './row-sources';

const ROWS: readonly Row[] = [{ value: 1 } as Row];
const ATTACHMENT = { name: 'a.png', dataUrl: 'data:image/png;base64,AA' };

function spyPorts() {
  const calls: { port: string; args: unknown[] }[] = [];
  const ports: Required<ExpenseRowSourcePorts> = {
    receiptCheck: { rows: async (...args) => { calls.push({ port: 'receiptCheck', args }); return ROWS; } },
    claims: { rows: async (...args) => { calls.push({ port: 'claims', args }); return ROWS; } },
    policy: { rows: async (...args) => { calls.push({ port: 'policy', args }); return ROWS; } },
  };
  return { ports, calls };
}

const resolverFor = (resolvers: readonly RowSourceResolver[], nodeType: string): RowSourceResolver => resolvers.find((resolver) => resolver.nodeType === nodeType)!;
const input = (config: Record<string, unknown>, attachments = [ATTACHMENT]) => ({ scope, config, attachments, documents: [], arguments: {} });

describe('expenseRowSources', () => {
  it('正常: 3 つのノード型を固定スキーマ付きで宣言する', () => {
    const resolvers = expenseRowSources({});
    expect(resolvers.map((resolver) => [resolver.nodeType, resolver.requirement])).toEqual([['expense-receipt-check', 'attachments'], ['expense-claims', 'none'], ['expense-policy', 'none']]);
    expect(resolvers.map((resolver) => resolver.schema)).toEqual([EXPENSE_RECEIPT_CHECK_SCHEMA, EXPENSE_CLAIMS_SCHEMA, EXPENSE_POLICY_SCHEMA]);
    expect(resolvers[0]!.missingAttachmentsMessage).toBe(EXPENSE_MISSING_RECEIPT_MESSAGE);
  });

  it('異常: ポート未配線なら rows は undefined（空表で「0 件」と読ませない）', () => {
    for (const resolver of expenseRowSources({})) expect(resolver.rows).toBeUndefined();
  });

  it('正常: 領収書チェックは添付と limit をポートへ渡し、limit 省略なら options なし', async () => {
    const { ports, calls } = spyPorts();
    const resolver = resolverFor(expenseRowSources(ports), 'expense-receipt-check');
    expect(await resolver.rows!(input({ limit: 8 }))).toBe(ROWS);
    await resolver.rows!(input({}));
    expect(calls).toEqual([{ port: 'receiptCheck', args: [scope, [ATTACHMENT], { limit: 8 }] }, { port: 'receiptCheck', args: [scope, [ATTACHMENT], undefined] }]);
  });

  it.each([0, 9, 1.5, '2'])('異常: 領収書チェックの limit %s はポートを呼ぶ前に DataSourceValidationError', async (limit) => {
    const { ports, calls } = spyPorts();
    await expect(resolverFor(expenseRowSources(ports), 'expense-receipt-check').rows!(input({ limit }))).rejects.toBeInstanceOf(DataSourceValidationError);
    expect(calls).toEqual([]);
  });

  it('正常: 申請一覧は status と limit を渡し、省略したものは渡さない', async () => {
    const { ports, calls } = spyPorts();
    const resolver = resolverFor(expenseRowSources(ports), 'expense-claims');
    await resolver.rows!(input({ status: 'approved', limit: 500 }));
    await resolver.rows!(input({}));
    expect(calls.map((call) => call.args)).toEqual([[scope, { status: 'approved', limit: 500 }], [scope, {}]]);
  });

  it.each([[{ status: 'open' }], [{ limit: 0 }], [{ limit: 501 }]])('異常: 申請一覧の config %j はポートを呼ぶ前に DataSourceValidationError', async (config) => {
    const { ports, calls } = spyPorts();
    await expect(resolverFor(expenseRowSources(ports), 'expense-claims').rows!(input(config))).rejects.toThrow('expense claims source has invalid settings');
    expect(calls).toEqual([]);
  });

  it('正常: 規程は scope だけを渡す', async () => {
    const { ports, calls } = spyPorts();
    await resolverFor(expenseRowSources(ports), 'expense-policy').rows!(input({ ignored: true }));
    expect(calls).toEqual([{ port: 'policy', args: [scope] }]);
  });
});

describe('resolveRowSourceNode 経由', () => {
  const node = { id: 'n1', type: 'expense-receipt-check', config: {} };

  it('異常: 添付が無ければ直し方の分かる EXPENSE_MISSING_RECEIPT_MESSAGE で落ちる', async () => {
    const { ports, calls } = spyPorts();
    await expect(resolveRowSourceNode(resolverFor(expenseRowSources(ports), 'expense-receipt-check'), scope, node, { attachments: [] })).rejects.toThrow(EXPENSE_MISSING_RECEIPT_MESSAGE);
    expect(calls).toEqual([]);
  });

  it('異常: 未配線なら理由付きで落ちる', async () => {
    await expect(resolveRowSourceNode(resolverFor(expenseRowSources({}), 'expense-claims'), scope, { ...node, type: 'expense-claims' }, undefined)).rejects.toThrow('expense claims are not available');
  });

  it('正常: 添付があれば json-source に書き換え、固定スキーマを添える', async () => {
    const { ports } = spyPorts();
    const resolved = await resolveRowSourceNode(resolverFor(expenseRowSources(ports), 'expense-receipt-check'), scope, node, { attachments: [ATTACHMENT] });
    expect(resolved).toEqual({ id: 'n1', type: 'json-source', config: { rows: ROWS, schema: EXPENSE_RECEIPT_CHECK_SCHEMA } });
  });

  it('境界: 文脈が無い呼び出し（保存時の点検）では添付必須のノードを書き換えない', async () => {
    const { ports } = spyPorts();
    expect(await resolveRowSourceNode(resolverFor(expenseRowSources(ports), 'expense-receipt-check'), scope, node, undefined)).toBe(node);
  });
});

/**
 * ドメイン: ノード `receivables-invoice-draft`（docs/22 §10.3）。kind: source / arity: 0。
 *
 * 添付された注文書・見積書を読み、請求書案を 1 行 = 1 明細で返す（保存しない）。読み取りはモデルが行うので、
 * 行は実行直前に差し込まれる。添付が無ければデータソース解決が理由付きで落とす。未解決なら空表。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ReceivablesInvoiceDraftConfig {
  readonly limit?: number;
}

const configSchema = z.object({ limit: z.number().int().min(1).max(4).optional() });

export const RECEIVABLES_INVOICE_DRAFT_SCHEMA: Schema = {
  columns: [
    { name: 'file_name', type: 'string', nullable: false },
    { name: 'customer_name', type: 'string', nullable: true },
    { name: 'customer_id', type: 'string', nullable: true },
    { name: 'transaction_date', type: 'string', nullable: true },
    { name: 'due_date', type: 'string', nullable: true },
    { name: 'pricing', type: 'string', nullable: false },
    { name: 'line_no', type: 'number', nullable: true },
    { name: 'description', type: 'string', nullable: true },
    { name: 'quantity', type: 'number', nullable: true },
    { name: 'unit_price', type: 'number', nullable: true },
    { name: 'amount', type: 'number', nullable: true },
    { name: 'tax_rate', type: 'number', nullable: true },
    { name: 'taxable_10', type: 'number', nullable: false },
    { name: 'tax_10', type: 'number', nullable: false },
    { name: 'taxable_8', type: 'number', nullable: false },
    { name: 'tax_8', type: 'number', nullable: false },
    { name: 'taxable_0', type: 'number', nullable: false },
    { name: 'grand_total', type: 'number', nullable: false },
    { name: 'document_total', type: 'number', nullable: true },
    { name: 'total_difference', type: 'number', nullable: true },
    { name: 'violations', type: 'string', nullable: false },
    { name: 'warnings', type: 'string', nullable: false },
    { name: 'draft_json', type: 'string', nullable: false },
  ],
};

class ReceivablesInvoiceDraftNode implements EtlNode<ReceivablesInvoiceDraftConfig> {
  readonly type = 'receivables-invoice-draft';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;
  validateConfig(config: unknown): ReceivablesInvoiceDraftConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`receivables-invoice-draft: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }
  inferSchema(): SchemaInference { return { schema: RECEIVABLES_INVOICE_DRAFT_SCHEMA, state: 'confirmed', issues: [] }; }
  execute(): Table { return { schema: RECEIVABLES_INVOICE_DRAFT_SCHEMA, rows: [] }; }
}

export const receivablesInvoiceDraftNode: EtlNode<ReceivablesInvoiceDraftConfig> = new ReceivablesInvoiceDraftNode();

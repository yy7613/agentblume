/**
 * ドメイン: ノード `receivables-outstanding`（docs/22 §10.1）。kind: source / arity: 0。
 *
 * 発行済みで入金が済んでいない請求書を 1 行 = 1 請求書で返す。**このノード自身はリポジトリへ到達できない**ので、
 * 実行直前に `resolveRowSourceNode` が行を差し込む（仕訳の `journal-entries` と同じ規律）。
 * 未解決のまま実行された場合は空表を返す（拒否はデータソース解決の責務。ADR-0039）。出力スキーマは固定。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ReceivablesOutstandingConfig {
  readonly limit?: number;
}

const configSchema = z.object({ limit: z.number().int().min(1).max(1000).optional() });

export const RECEIVABLES_OUTSTANDING_SCHEMA: Schema = {
  columns: [
    { name: 'invoice_id', type: 'string', nullable: false },
    { name: 'invoice_number', type: 'string', nullable: false },
    { name: 'customer_id', type: 'string', nullable: false },
    { name: 'customer_name', type: 'string', nullable: false },
    { name: 'issue_date', type: 'string', nullable: false },
    { name: 'due_date', type: 'string', nullable: true },
    { name: 'grand_total', type: 'number', nullable: false },
    { name: 'paid_amount', type: 'number', nullable: false },
    { name: 'outstanding_amount', type: 'number', nullable: false },
    { name: 'days_overdue', type: 'number', nullable: false },
    { name: 'last_payment_date', type: 'string', nullable: true },
    { name: 'status', type: 'string', nullable: false },
    { name: 'sales_entry_id', type: 'string', nullable: true },
  ],
};

class ReceivablesOutstandingNode implements EtlNode<ReceivablesOutstandingConfig> {
  readonly type = 'receivables-outstanding';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;
  validateConfig(config: unknown): ReceivablesOutstandingConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`receivables-outstanding: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }
  inferSchema(): SchemaInference { return { schema: RECEIVABLES_OUTSTANDING_SCHEMA, state: 'confirmed', issues: [] }; }
  execute(): Table { return { schema: RECEIVABLES_OUTSTANDING_SCHEMA, rows: [] }; }
}

export const receivablesOutstandingNode: EtlNode<ReceivablesOutstandingConfig> = new ReceivablesOutstandingNode();

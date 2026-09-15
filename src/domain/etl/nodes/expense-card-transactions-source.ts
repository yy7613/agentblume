/**
 * ドメイン: ノード `expense-card-transactions`
 *
 * kind: source / arity: 0。
 * 取り込んだ法人カード利用を **1 行 = 1 利用**で、保存済みの照合結果とともに返すソース（docs/21 §20.11.3）。
 * ツールで照合し直さない。config は `{ limit? }`。実行直前にデータソース解決器が `json-source` へ書き換える。出力スキーマは固定。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ExpenseCardTransactionsSourceConfig {
  readonly limit?: number;
}

export const EXPENSE_CARD_TRANSACTIONS_SOURCE_MAX_ROWS = 2000;

const configSchema = z.object({ limit: z.number().int().min(1).max(EXPENSE_CARD_TRANSACTIONS_SOURCE_MAX_ROWS).optional() });

export const EXPENSE_CARD_TRANSACTIONS_SCHEMA: Schema = {
  columns: [
    { name: 'transaction_id', type: 'string', nullable: false },
    { name: 'card_id', type: 'string', nullable: false },
    { name: 'card_label', type: 'string', nullable: false },
    { name: 'card_last4', type: 'string', nullable: false },
    { name: 'holder', type: 'string', nullable: true },
    { name: 'used_on', type: 'string', nullable: false },
    { name: 'merchant', type: 'string', nullable: false },
    { name: 'amount', type: 'number', nullable: false },
    { name: 'status', type: 'string', nullable: false },
    { name: 'match_kind', type: 'string', nullable: true },
    { name: 'match_strength', type: 'string', nullable: true },
    { name: 'claim_id', type: 'string', nullable: true },
    { name: 'item_id', type: 'string', nullable: true },
    { name: 'claimant', type: 'string', nullable: true },
    { name: 'claim_status', type: 'string', nullable: true },
    { name: 'date_diff_days', type: 'number', nullable: true },
    { name: 'exclusion_reason', type: 'string', nullable: true },
    { name: 'import_file', type: 'string', nullable: false },
    { name: 'updated_at', type: 'string', nullable: false },
  ],
};

class ExpenseCardTransactionsSourceNode implements EtlNode<ExpenseCardTransactionsSourceConfig> {
  readonly type = 'expense-card-transactions';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseCardTransactionsSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-card-transactions: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseCardTransactionsSourceConfig): SchemaInference {
    return { schema: EXPENSE_CARD_TRANSACTIONS_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseCardTransactionsSourceConfig): Table {
    return { schema: EXPENSE_CARD_TRANSACTIONS_SCHEMA, rows: [] };
  }
}

export const expenseCardTransactionsSourceNode: EtlNode<ExpenseCardTransactionsSourceConfig> = new ExpenseCardTransactionsSourceNode();

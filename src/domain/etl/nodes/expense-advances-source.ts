/**
 * ドメイン: ノード `expense-advances`
 *
 * kind: source / arity: 0。
 * 仮払を **1 行 = 1 仮払**で返すソース（docs/21 §20.11.2）。口座番号は含めない。
 * config は `{ limit? }`。実行直前にデータソース解決器が `json-source` へ書き換える。出力スキーマは固定。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ExpenseAdvancesSourceConfig {
  readonly limit?: number;
}

export const EXPENSE_ADVANCES_SOURCE_MAX_ROWS = 500;

const configSchema = z.object({ limit: z.number().int().min(1).max(EXPENSE_ADVANCES_SOURCE_MAX_ROWS).optional() });

export const EXPENSE_ADVANCES_SCHEMA: Schema = {
  columns: [
    { name: 'advance_id', type: 'string', nullable: false },
    { name: 'employee_id', type: 'string', nullable: false },
    { name: 'employee', type: 'string', nullable: false },
    { name: 'department', type: 'string', nullable: true },
    { name: 'purpose', type: 'string', nullable: false },
    { name: 'amount', type: 'number', nullable: false },
    { name: 'status', type: 'string', nullable: false },
    { name: 'needed_on', type: 'string', nullable: false },
    { name: 'planned_settle_by', type: 'string', nullable: false },
    { name: 'overdue', type: 'boolean', nullable: false },
    { name: 'approved_at', type: 'string', nullable: true },
    { name: 'paid_on', type: 'string', nullable: true },
    { name: 'linked_claim_count', type: 'number', nullable: false },
    { name: 'linked_claim_total', type: 'number', nullable: false },
    { name: 'difference', type: 'number', nullable: true },
    { name: 'additional_payment', type: 'number', nullable: true },
    { name: 'refund', type: 'number', nullable: true },
    { name: 'settled_on', type: 'string', nullable: true },
    { name: 'updated_at', type: 'string', nullable: false },
  ],
};

class ExpenseAdvancesSourceNode implements EtlNode<ExpenseAdvancesSourceConfig> {
  readonly type = 'expense-advances';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseAdvancesSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-advances: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseAdvancesSourceConfig): SchemaInference {
    return { schema: EXPENSE_ADVANCES_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseAdvancesSourceConfig): Table {
    return { schema: EXPENSE_ADVANCES_SCHEMA, rows: [] };
  }
}

export const expenseAdvancesSourceNode: EtlNode<ExpenseAdvancesSourceConfig> = new ExpenseAdvancesSourceNode();

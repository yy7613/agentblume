/**
 * ドメイン: ノード `expense-summary`
 *
 * kind: source / arity: 0。
 * 経費の集計を **1 行 = 1 グループ**で返すソース（docs/21 §20.11.1 / §20.3.7）。
 * 粒度（group_by）・期間（period）・状態（status）はツールの引数を行ソースが直接受け取る（§20.14 G-2）。
 * config は `{ limit? }`（集計の入力に読む明細の件数ではなく、返す行の上限）。
 *
 * リポジトリへ到達できないので、実行直前にデータソース解決器が `json-source` へ書き換える。出力スキーマは固定。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ExpenseSummarySourceConfig {
  readonly limit?: number;
}

export const EXPENSE_SUMMARY_SOURCE_MAX_ROWS = 2000;

const configSchema = z.object({ limit: z.number().int().min(1).max(EXPENSE_SUMMARY_SOURCE_MAX_ROWS).optional() });

const nullableText = (name: string) => ({ name, type: 'string' as const, nullable: true });
const count = (name: string) => ({ name, type: 'number' as const, nullable: false });

export const EXPENSE_SUMMARY_SCHEMA: Schema = {
  columns: [
    nullableText('month'), nullableText('department_id'), nullableText('department'), nullableText('category_id'), nullableText('category'),
    nullableText('employee_id'), nullableText('claimant'), nullableText('status'),
    count('claim_count'), count('item_count'), count('amount'), count('reimbursable_amount'), count('corporate_amount'),
    { name: 'basis', type: 'string', nullable: false },
    { name: 'period_from', type: 'string', nullable: false },
    { name: 'period_to', type: 'string', nullable: false },
    { name: 'group_by', type: 'string', nullable: false },
  ],
};

class ExpenseSummarySourceNode implements EtlNode<ExpenseSummarySourceConfig> {
  readonly type = 'expense-summary';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseSummarySourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-summary: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseSummarySourceConfig): SchemaInference {
    return { schema: EXPENSE_SUMMARY_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseSummarySourceConfig): Table {
    return { schema: EXPENSE_SUMMARY_SCHEMA, rows: [] };
  }
}

export const expenseSummarySourceNode: EtlNode<ExpenseSummarySourceConfig> = new ExpenseSummarySourceNode();

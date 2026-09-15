/**
 * ドメイン: ノード `expense-fares`
 *
 * kind: source / arity: 0。
 * 経費精算の運賃マスタを **1 行 = 1 経路**で返すソース（docs/21 §20.11.4）。未保存なら 0 行（`saved` 列で区別）。
 * 従業員の通勤定期は出さない（個人の通勤経路はツールで持ち出さない）。
 *
 * リポジトリへ到達できないので、実行直前にデータソース解決器が `json-source` へ書き換える。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export type ExpenseFaresSourceConfig = Readonly<Record<string, never>>;

const configSchema = z.object({}).strict();

export const EXPENSE_FARES_COLUMNS = ['route_id', 'stations', 'from', 'to', 'fare_type', 'fare', 'bidirectional', 'valid_from', 'valid_to', 'note', 'saved', 'updated_at'] as const;

export const EXPENSE_FARES_SCHEMA: Schema = {
  columns: [
    { name: 'route_id', type: 'string', nullable: false },
    // 駅を ` > ` で連結（出発 > …経由 > 到着）。
    { name: 'stations', type: 'string', nullable: false },
    { name: 'from', type: 'string', nullable: false },
    { name: 'to', type: 'string', nullable: false },
    { name: 'fare_type', type: 'string', nullable: false },
    { name: 'fare', type: 'number', nullable: false },
    { name: 'bidirectional', type: 'boolean', nullable: false },
    { name: 'valid_from', type: 'string', nullable: true },
    { name: 'valid_to', type: 'string', nullable: true },
    { name: 'note', type: 'string', nullable: true },
    { name: 'saved', type: 'boolean', nullable: false },
    { name: 'updated_at', type: 'string', nullable: false },
  ],
};

class ExpenseFaresSourceNode implements EtlNode<ExpenseFaresSourceConfig> {
  readonly type = 'expense-fares';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseFaresSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-fares: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data as ExpenseFaresSourceConfig;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseFaresSourceConfig): SchemaInference {
    return { schema: EXPENSE_FARES_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseFaresSourceConfig): Table {
    return { schema: EXPENSE_FARES_SCHEMA, rows: [] };
  }
}

export const expenseFaresSourceNode: EtlNode<ExpenseFaresSourceConfig> = new ExpenseFaresSourceNode();

/**
 * ドメイン: ノード `limit`
 *
 * kind: transform / arity: 1。
 * 先頭から `count` 行だけを残す（`offset` 行スキップ後）。スキーマは不変。
 * sort → limit で「上位N件」が表現できる。
 *
 * - inferSchema: 入力スキーマそのままで 'confirmed'（列参照が無いので issue は出ない）。
 * - execute: `rows.slice(offset, offset + count)`。行数が足りなければ取れるだけ返す。
 */
import { z } from 'zod';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** `limit` の設定。`offset` 省略時は 0。 */
export interface LimitConfig {
  readonly count: number;
  readonly offset?: number;
}

const configSchema = z.object({
  count: z.number().int().min(1).max(10000),
  offset: z.number().int().min(0).optional(),
});

class LimitNode implements EtlNode<LimitConfig> {
  readonly type = 'limit';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): LimitConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`limit: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[]): SchemaInference {
    // スキーマは不変。
    return { schema: inputs[0] ?? { columns: [] }, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: LimitConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const offset = config.offset ?? 0;
    // slice は新しい配列を返すので入力行は mutate しない。
    const rows: Row[] = input.rows.slice(offset, offset + config.count);
    return { schema: input.schema, rows };
  }
}

/** `limit` ノードのシングルトン。 */
export const limitNode: EtlNode<LimitConfig> = new LimitNode();

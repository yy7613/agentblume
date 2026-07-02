/**
 * ドメイン: v1 ノード `json-source`（実装契約 §9.1）
 *
 * kind: source / arity: 0。
 * インメモリの行データ（+任意の明示スキーマ）を受け取り、そのまま Table として出力する。
 * - `schema` 指定あり → その schema を confirmed として返す。
 * - `schema` 指定なし → `inferSchemaFromRows(rows)` を inferred として返す。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { inferSchemaFromRows } from '../../data/schema';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** `json-source` の設定。 */
export interface JsonSourceConfig {
  readonly rows: Row[];
  readonly schema?: Schema;
}

/** Cell（string|number|boolean|Date|null）の緩い検証。深い検証はしない（§0）。 */
const cellSchema: z.ZodType<Cell> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Date),
  z.null(),
]);

/** Row = Record<string, Cell> の軽い検証。 */
const rowSchema: z.ZodType<Row> = z.record(z.string(), cellSchema);

const dataTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'null', 'unknown']);

const columnSchema = z.object({
  name: z.string(),
  type: dataTypeSchema,
  nullable: z.boolean(),
});

const schemaSchema = z.object({
  columns: z.array(columnSchema),
});

const configSchema = z.object({
  rows: z.array(rowSchema),
  schema: schemaSchema.optional(),
});

class JsonSourceNode implements EtlNode<JsonSourceConfig> {
  readonly type = 'json-source';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): JsonSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`json-source: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], config: JsonSourceConfig): SchemaInference {
    if (config.schema !== undefined) {
      return { schema: config.schema, state: 'confirmed', issues: [] };
    }
    return { schema: inferSchemaFromRows(config.rows), state: 'inferred', issues: [] };
  }

  execute(_inputs: readonly Table[], config: JsonSourceConfig): Table {
    const schema = config.schema ?? inferSchemaFromRows(config.rows);
    // 入力を mutate しない: 行配列を浅くコピーして新しい Table を返す。
    return { schema, rows: [...config.rows] };
  }
}

/** `json-source` ノードのシングルトン。 */
export const jsonSourceNode: EtlNode<JsonSourceConfig> = new JsonSourceNode();

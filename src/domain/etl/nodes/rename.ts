/**
 * ドメイン: v1 ノード `rename`（実装契約 §9.5）
 *
 * kind: transform / arity: 1。
 * 列名を付け替える（値は保持、順序保持）。
 * - inferSchema: 各 `from` 存在必須。リネーム適用後に列名重複が生じる → error/mismatch。
 *   正常 → 列名を置換（順序保持）、state:'confirmed'。
 * - execute: 行のキーを付け替え（値保持）。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** `rename` の設定。 */
export interface RenameConfig {
  readonly renames: { from: string; to: string }[];
}

const configSchema = z.object({
  renames: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
    }),
  ),
});

/** from → to のマップを作る（同一 from が複数あれば最後が勝つ）。 */
function buildRenameMap(renames: readonly { from: string; to: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of renames) {
    map.set(r.from, r.to);
  }
  return map;
}

/** 列名リストにリネームを適用する（順序保持）。 */
function applyRenames(names: readonly string[], map: Map<string, string>): string[] {
  return names.map((name) => map.get(name) ?? name);
}

/** 名前配列中で重複している名前（初出以外）を返す。 */
function findDuplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) dups.add(name);
    else seen.add(name);
  }
  return [...dups];
}

class RenameNode implements EtlNode<RenameConfig> {
  readonly type = 'rename';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): RenameConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`rename: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: RenameConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];

    // 各 from が存在するか。
    for (const r of config.renames) {
      if (findColumn(input, r.from) === undefined) {
        issues.push({
          severity: 'error',
          message: `rename: column not found: ${r.from}`,
          column: r.from,
        });
      }
    }

    if (issues.length > 0) {
      return { schema: input, state: 'mismatch', issues };
    }

    const map = buildRenameMap(config.renames);
    const newNames = applyRenames(
      input.columns.map((c) => c.name),
      map,
    );

    const dups = findDuplicates(newNames);
    if (dups.length > 0) {
      for (const name of dups) {
        issues.push({
          severity: 'error',
          message: `rename: duplicate column name after rename: ${name}`,
          column: name,
        });
      }
      return { schema: input, state: 'mismatch', issues };
    }

    const columns: Column[] = input.columns.map((c) => ({
      name: map.get(c.name) ?? c.name,
      type: c.type,
      nullable: c.nullable,
    }));

    return { schema: { columns }, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: RenameConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // from 欠損は実行時エラー。
    const missing = config.renames
      .filter((r) => findColumn(input.schema, r.from) === undefined)
      .map((r) => r.from);
    if (missing.length > 0) {
      throw new SchemaError(`rename: column(s) not found: ${missing.join(', ')}`);
    }

    const map = buildRenameMap(config.renames);
    const newNames = applyRenames(
      input.schema.columns.map((c) => c.name),
      map,
    );
    const dups = findDuplicates(newNames);
    if (dups.length > 0) {
      throw new SchemaError(`rename: duplicate column name after rename: ${dups.join(', ')}`);
    }

    const columns: Column[] = input.schema.columns.map((c) => ({
      name: map.get(c.name) ?? c.name,
      type: c.type,
      nullable: c.nullable,
    }));

    const rows: Row[] = input.rows.map((row) => {
      const out: Record<string, Cell> = {};
      for (const key of Object.keys(row)) {
        const newKey = map.get(key) ?? key;
        out[newKey] = row[key] ?? null;
      }
      return out;
    });

    return { schema: { columns }, rows };
  }
}

/** `rename` ノードのシングルトン。 */
export const renameNode: EtlNode<RenameConfig> = new RenameNode();

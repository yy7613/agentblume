/**
 * adapters層: スキーマ版 1 つの型と、SQL 文を並べるだけの版を作る関数。
 *
 * `migrations.ts` と業務ごとの `<業務>-migrations.ts` の両方が使うので、循環しないよう葉に置く。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 1つのスキーマ版。`apply` は呼ばれた時点で必ずトランザクション内にある。 */
export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  /**
   * 版番号だけを予約した、中身の無い版（並行実装中の業務）。
   * 版を刻むとその後に入った中身が流れなくなるので、`applyMigrations` はここで版の刻みを止める。
   */
  readonly placeholder?: boolean;
  apply(db: DatabaseSync): void;
}

/** SQL 文を順に流す版。文が 1 つも無ければ予約版（`placeholder`）になる。 */
export function statementMigration(version: number, description: string, statements: readonly string[]): SchemaMigration {
  return {
    version,
    description,
    ...(statements.length === 0 ? { placeholder: true } : {}),
    apply(db) {
      for (const statement of statements) db.exec(statement);
    },
  };
}

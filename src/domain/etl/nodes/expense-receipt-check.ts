/**
 * ドメイン: ノード `expense-receipt-check`
 *
 * kind: source / arity: 0。
 * **いまの実行に添付された領収書を読み取り、保存済みの規程で判定して、指摘を 1 行ずつ返す**ソース（docs/21 §13.1）。
 * 指摘の無い明細は `verdict = 'pass'`・`code = null` の 1 行を返す（空表にすると「読めなかった」と区別できないため）。
 *
 * **保存しない。** 申請も証憑も作らない（実際の申請は画面で取り込む）。
 *
 * このノード自身はモデルにもリポジトリにも到達できないので、実行直前にデータソース解決器が `json-source` へ書き換える。
 * 未解決のまま execute された場合は例外を投げず空テーブルを返す（拒否は application 層の責務）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ExpenseReceiptCheckSourceConfig {
  /** 読む添付の枚数上限。省略時は添付すべて。 */
  readonly limit?: number;
}

const configSchema = z.object({ limit: z.number().int().min(1).max(8).optional() });

/** 出力列名（順序は固定。application 層の行組み立てとリゾルバがこの並びを共有する）。 */
export const EXPENSE_RECEIPT_CHECK_COLUMNS = [
  'file_name', 'item_no', 'verdict', 'severity', 'code', 'message', 'fix', 'category_id', 'category',
  'transaction_date', 'payee', 'amount', 'registration_number', 'attendees', 'search_keys_complete', 'policy_saved', 'warnings', 'facts_json',
] as const;

export const EXPENSE_RECEIPT_CHECK_SCHEMA: Schema = {
  columns: [
    { name: 'file_name', type: 'string', nullable: false },
    { name: 'item_no', type: 'number', nullable: false },
    { name: 'verdict', type: 'string', nullable: false },
    { name: 'severity', type: 'string', nullable: true },
    { name: 'code', type: 'string', nullable: true },
    { name: 'message', type: 'string', nullable: true },
    { name: 'fix', type: 'string', nullable: true },
    { name: 'category_id', type: 'string', nullable: true },
    { name: 'category', type: 'string', nullable: true },
    { name: 'transaction_date', type: 'string', nullable: true },
    { name: 'payee', type: 'string', nullable: true },
    { name: 'amount', type: 'number', nullable: true },
    { name: 'registration_number', type: 'string', nullable: true },
    { name: 'attendees', type: 'number', nullable: true },
    { name: 'search_keys_complete', type: 'boolean', nullable: false },
    { name: 'policy_saved', type: 'boolean', nullable: false },
    { name: 'warnings', type: 'string', nullable: false },
    { name: 'facts_json', type: 'string', nullable: false },
  ],
};

class ExpenseReceiptCheckSourceNode implements EtlNode<ExpenseReceiptCheckSourceConfig> {
  readonly type = 'expense-receipt-check';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseReceiptCheckSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-receipt-check: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseReceiptCheckSourceConfig): SchemaInference {
    return { schema: EXPENSE_RECEIPT_CHECK_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseReceiptCheckSourceConfig): Table {
    return { schema: EXPENSE_RECEIPT_CHECK_SCHEMA, rows: [] };
  }
}

export const expenseReceiptCheckSourceNode: EtlNode<ExpenseReceiptCheckSourceConfig> = new ExpenseReceiptCheckSourceNode();

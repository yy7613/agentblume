/**
 * ドメイン: ノード `expense-policy`
 *
 * kind: source / arity: 0。
 * 経費の規程を **1 行 = 1 費目**で返すソース（docs/21 §13.3）。無効な費目も `enabled = false` で含め、
 * 申請ルール（期限・人数の数え方など）は全行に同じ値で載せる。未保存なら初期テンプレートを返す（保存しない）。
 *
 * リポジトリへ到達できないので、実行直前にデータソース解決器が `json-source` へ書き換える。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export type ExpensePolicySourceConfig = Readonly<Record<string, never>>;

const configSchema = z.object({});

export const EXPENSE_POLICY_COLUMNS = [
  'category_id', 'name', 'enabled', 'account_id', 'default_tax_rate', 'receipt_required', 'receipt_exempt_below', 'invoice_required', 'invoice_exempt_below',
  'requires_purpose', 'requires_attendees', 'requires_attendee_details', 'per_item_limit', 'per_claim_limit', 'per_person_limit', 'per_person_basis',
  'per_unit_label', 'per_unit_limit', 'pre_approval', 'aliases', 'note',
  'policy_saved', 'submission_deadline_days', 'attendees_include_claimant', 'non_reimbursable_payment_methods', 'severity_overrides_json', 'updated_at',
] as const;

export const EXPENSE_POLICY_SCHEMA: Schema = {
  columns: [
    { name: 'category_id', type: 'string', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'enabled', type: 'boolean', nullable: false },
    { name: 'account_id', type: 'string', nullable: true },
    { name: 'default_tax_rate', type: 'number', nullable: false },
    { name: 'receipt_required', type: 'boolean', nullable: false },
    { name: 'receipt_exempt_below', type: 'number', nullable: true },
    { name: 'invoice_required', type: 'boolean', nullable: false },
    { name: 'invoice_exempt_below', type: 'number', nullable: true },
    { name: 'requires_purpose', type: 'boolean', nullable: false },
    { name: 'requires_attendees', type: 'boolean', nullable: false },
    { name: 'requires_attendee_details', type: 'boolean', nullable: false },
    // null = 上限なし。
    { name: 'per_item_limit', type: 'number', nullable: true },
    { name: 'per_claim_limit', type: 'number', nullable: true },
    { name: 'per_person_limit', type: 'number', nullable: true },
    { name: 'per_person_basis', type: 'string', nullable: false },
    { name: 'per_unit_label', type: 'string', nullable: true },
    { name: 'per_unit_limit', type: 'number', nullable: true },
    { name: 'pre_approval', type: 'string', nullable: false },
    { name: 'aliases', type: 'string', nullable: false },
    { name: 'note', type: 'string', nullable: true },
    { name: 'policy_saved', type: 'boolean', nullable: false },
    { name: 'submission_deadline_days', type: 'number', nullable: true },
    { name: 'attendees_include_claimant', type: 'boolean', nullable: false },
    { name: 'non_reimbursable_payment_methods', type: 'string', nullable: false },
    { name: 'severity_overrides_json', type: 'string', nullable: false },
    { name: 'updated_at', type: 'string', nullable: false },
  ],
};

class ExpensePolicySourceNode implements EtlNode<ExpensePolicySourceConfig> {
  readonly type = 'expense-policy';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpensePolicySourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-policy: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data as ExpensePolicySourceConfig;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpensePolicySourceConfig): SchemaInference {
    return { schema: EXPENSE_POLICY_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpensePolicySourceConfig): Table {
    return { schema: EXPENSE_POLICY_SCHEMA, rows: [] };
  }
}

export const expensePolicySourceNode: EtlNode<ExpensePolicySourceConfig> = new ExpensePolicySourceNode();

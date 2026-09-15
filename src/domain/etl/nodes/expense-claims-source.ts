/**
 * ドメイン: ノード `expense-claims`
 *
 * kind: source / arity: 0。
 * 経費の申請を **1 行 = 1 申請**の要約として返すソース（docs/21 §13.2）。明細・証憑本体は含まない。
 * config は `{ status?, limit? }`（用途別ツールで条件を焼き込む余地として持つ。組込みツールは status を焼き込まない）。
 *
 * リポジトリへ到達できないので、実行直前にデータソース解決器が `json-source` へ書き換える。
 * 出力スキーマは入力にも config にも依存せず固定（inferSchema は常に confirmed）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { CLAIM_STATUSES, type ClaimStatus } from '../../expense/claim';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ExpenseClaimsSourceConfig {
  readonly status?: ClaimStatus;
  /** 読む申請の件数上限。 */
  readonly limit?: number;
}

const configSchema = z.object({
  status: z.enum(CLAIM_STATUSES).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const EXPENSE_CLAIMS_COLUMNS = [
  'claim_id', 'claimant', 'employee_code', 'department', 'period_from', 'period_to', 'title', 'status', 'verdict', 'stale',
  'item_count', 'total_amount', 'return_count', 'review_count', 'acknowledged_count', 'approved_by', 'approved_at', 'settled_at',
  'journal_linked', 'top_reasons', 'updated_at',
  // 実用化（docs/21 §20.11.5）。末尾に足す（既存の列の並びを変えない）。
  'employee_id', 'department_id', 'advance_id', 'reimbursable_amount', 'current_step', 'current_approvers',
] as const;

export const EXPENSE_CLAIMS_SCHEMA: Schema = {
  columns: [
    { name: 'claim_id', type: 'string', nullable: false },
    { name: 'claimant', type: 'string', nullable: false },
    { name: 'employee_code', type: 'string', nullable: true },
    { name: 'department', type: 'string', nullable: true },
    { name: 'period_from', type: 'string', nullable: false },
    { name: 'period_to', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: true },
    { name: 'status', type: 'string', nullable: false },
    // 未チェックは null。
    { name: 'verdict', type: 'string', nullable: true },
    { name: 'stale', type: 'boolean', nullable: false },
    { name: 'item_count', type: 'number', nullable: false },
    { name: 'total_amount', type: 'number', nullable: false },
    { name: 'return_count', type: 'number', nullable: false },
    { name: 'review_count', type: 'number', nullable: false },
    { name: 'acknowledged_count', type: 'number', nullable: false },
    { name: 'approved_by', type: 'string', nullable: true },
    { name: 'approved_at', type: 'string', nullable: true },
    { name: 'settled_at', type: 'string', nullable: true },
    { name: 'journal_linked', type: 'string', nullable: false },
    { name: 'top_reasons', type: 'string', nullable: false },
    { name: 'updated_at', type: 'string', nullable: false },
    { name: 'employee_id', type: 'string', nullable: true },
    { name: 'department_id', type: 'string', nullable: true },
    { name: 'advance_id', type: 'string', nullable: true },
    // 従業員へ支払う額（会社払いの明細を申請に含める運用では会社払いを除く）。
    { name: 'reimbursable_amount', type: 'number', nullable: false },
    // 承認中の現在の段と承認者（`in-approval` のときだけ。承認者は氏名を「、」で連結）。
    { name: 'current_step', type: 'string', nullable: true },
    { name: 'current_approvers', type: 'string', nullable: true },
  ],
};

class ExpenseClaimsSourceNode implements EtlNode<ExpenseClaimsSourceConfig> {
  readonly type = 'expense-claims';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ExpenseClaimsSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`expense-claims: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ExpenseClaimsSourceConfig): SchemaInference {
    return { schema: EXPENSE_CLAIMS_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ExpenseClaimsSourceConfig): Table {
    return { schema: EXPENSE_CLAIMS_SCHEMA, rows: [] };
  }
}

export const expenseClaimsSourceNode: EtlNode<ExpenseClaimsSourceConfig> = new ExpenseClaimsSourceNode();

/**
 * application層: 経費の行ソース（`expense-receipt-check` / `expense-claims` / `expense-policy`）の宣言（ADR-0039 §1）。
 *
 * 書き換えの規律（文脈が無ければ書き換えない・未配線は理由付きで落とす・添付必須・スキーマを添える）は
 * データソース BC の `row-sources.ts` が 1 か所で持つ。ここは「どのノードを・どのスキーマで・何を要り・
 * 設定をどう読んで・どのポートから行を取るか」だけを宣言する。経費 BC がデータソース BC の登録型へ依存するのはこのファイルだけ。
 */
import type { Row } from '../../domain/data/types';
import { EXPENSE_CLAIMS_SCHEMA } from '../../domain/etl/nodes/expense-claims-source';
import { EXPENSE_POLICY_SCHEMA } from '../../domain/etl/nodes/expense-policy-source';
import { EXPENSE_RECEIPT_CHECK_SCHEMA } from '../../domain/etl/nodes/expense-receipt-check';
import { CLAIM_STATUSES, type ClaimStatus } from '../../domain/expense/claim';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import type { ResolveAttachment, RowSourceResolver } from '../data-source/row-sources';

export interface ExpenseReceiptCheckReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

export interface ExpenseClaimReadPort {
  rows(scope: TenantScope, options?: { readonly status?: ClaimStatus; readonly limit?: number }): Promise<readonly Row[]>;
}

export interface ExpensePolicyReadPort {
  rows(scope: TenantScope): Promise<readonly Row[]>;
}

/** 省略したものは「未配線」の理由付きで落ちる（空表を返すと「申請が 0 件」と読めてしまう）。 */
export interface ExpenseRowSourcePorts {
  readonly receiptCheck?: ExpenseReceiptCheckReadPort;
  readonly claims?: ExpenseClaimReadPort;
  readonly policy?: ExpensePolicyReadPort;
}

/** 添付が無いとき。利用者が直せる状態なので、何を添付すればよいかまで言う。 */
export const EXPENSE_MISSING_RECEIPT_MESSAGE = 'no receipt is attached to this message; attach the receipt image and ask again';

function intInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** 経費の行ソース 3 種。ポートの有無に関わらず 3 つとも登録する（未配線を理由付きで拒否するため）。 */
export function expenseRowSources(ports: ExpenseRowSourcePorts): readonly RowSourceResolver[] {
  const { receiptCheck, claims, policy } = ports;
  return [
    {
      nodeType: 'expense-receipt-check',
      schema: EXPENSE_RECEIPT_CHECK_SCHEMA,
      requirement: 'attachments',
      unavailableMessage: 'expense receipt check is not available',
      missingAttachmentsMessage: EXPENSE_MISSING_RECEIPT_MESSAGE,
      rows: receiptCheck === undefined ? undefined : async ({ scope, config, attachments }) => {
        const limit = config['limit'];
        if (limit !== undefined && !intInRange(limit, 1, 8)) throw new DataSourceValidationError('expense receipt check source has invalid settings');
        return receiptCheck.rows(scope, attachments, limit === undefined ? undefined : { limit: limit as number });
      },
    },
    {
      nodeType: 'expense-claims',
      schema: EXPENSE_CLAIMS_SCHEMA,
      // 保存済みの申請を読むだけなので、実行文脈に依らない。
      requirement: 'none',
      unavailableMessage: 'expense claims are not available',
      rows: claims === undefined ? undefined : async ({ scope, config }) => {
        const { status, limit } = config;
        if ((status !== undefined && !(CLAIM_STATUSES as readonly unknown[]).includes(status)) || (limit !== undefined && !intInRange(limit, 1, 500))) {
          throw new DataSourceValidationError('expense claims source has invalid settings');
        }
        return claims.rows(scope, { ...(status === undefined ? {} : { status: status as ClaimStatus }), ...(limit === undefined ? {} : { limit: limit as number }) });
      },
    },
    {
      nodeType: 'expense-policy',
      schema: EXPENSE_POLICY_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'expense policy is not available',
      rows: policy === undefined ? undefined : async ({ scope }) => policy.rows(scope),
    },
  ];
}

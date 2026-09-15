/**
 * application層: 入金消込の行ソース（`receivables-outstanding` / `receivables-match-candidates` / `receivables-invoice-draft`）の宣言。
 *
 * 書き換えの規律（文脈が無ければ書き換えない・未配線は理由付きで落とす・添付必須・スキーマを添える）は
 * データソース BC の `row-sources.ts` が 1 か所で持つ（ADR-0039）。入金消込 BC がデータソース BC の登録型へ依存するのはこのファイルだけ。
 */
import type { Row } from '../../domain/data/types';
import { RECEIVABLES_INVOICE_DRAFT_SCHEMA } from '../../domain/etl/nodes/receivables-invoice-draft';
import { RECEIVABLES_MATCH_CANDIDATES_SCHEMA } from '../../domain/etl/nodes/receivables-match-candidates';
import { RECEIVABLES_OUTSTANDING_SCHEMA } from '../../domain/etl/nodes/receivables-outstanding';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import type { ResolveAttachment, RowSourceResolver } from '../data-source/row-sources';

export interface OutstandingInvoiceReadPort {
  rows(scope: TenantScope, options?: { readonly limit?: number }): Promise<readonly Row[]>;
}
export interface MatchCandidateReadPort {
  rows(scope: TenantScope, options?: { readonly limit?: number; readonly maxCandidates?: number }): Promise<readonly Row[]>;
}
export interface InvoiceDraftReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

/** 省略したポートは「未配線」の理由付きで落ちる（空表を返すと「未入金が 0 件」と読めてしまう）。 */
export interface ReceivablesRowSourcePorts {
  readonly outstanding?: OutstandingInvoiceReadPort;
  readonly matchCandidates?: MatchCandidateReadPort;
  readonly invoiceDraft?: InvoiceDraftReadPort;
}

const MISSING_ATTACHMENTS = 'no document is attached to this message; attach the purchase order or quotation image and ask again';

/** 整数の範囲を持つ config を読む。形が崩れていればポートを呼ぶ前に落とす。 */
function integerOptions<K extends string>(config: Readonly<Record<string, unknown>>, ranges: Readonly<Record<K, readonly [number, number]>>, label: string): Partial<Record<K, number>> {
  const options: Partial<Record<K, number>> = {};
  for (const [key, [min, max]] of Object.entries(ranges) as [K, readonly [number, number]][]) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DataSourceValidationError(`${label} has invalid settings: ${key} must be an integer between ${min} and ${max}`);
    options[key] = value;
  }
  return options;
}

export function receivablesRowSources(ports: ReceivablesRowSourcePorts): readonly RowSourceResolver[] {
  const { outstanding, matchCandidates, invoiceDraft } = ports;
  return [
    {
      nodeType: 'receivables-outstanding',
      schema: RECEIVABLES_OUTSTANDING_SCHEMA,
      // 保存済みの請求を読むだけなので実行文脈に依らない（保存時の点検でも読む）。
      requirement: 'none',
      unavailableMessage: 'receivables outstanding invoices are not available',
      rows: outstanding === undefined ? undefined : async ({ scope, config }) => outstanding.rows(scope, integerOptions(config, { limit: [1, 1000] }, 'receivables outstanding source')),
    },
    {
      nodeType: 'receivables-match-candidates',
      schema: RECEIVABLES_MATCH_CANDIDATES_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'receivables match candidates are not available',
      rows: matchCandidates === undefined ? undefined : async ({ scope, config }) => matchCandidates.rows(scope, integerOptions(config, { limit: [1, 200], maxCandidates: [1, 5] }, 'receivables match candidates source')),
    },
    {
      nodeType: 'receivables-invoice-draft',
      schema: RECEIVABLES_INVOICE_DRAFT_SCHEMA,
      requirement: 'attachments',
      unavailableMessage: 'receivables invoice draft is not available',
      missingAttachmentsMessage: MISSING_ATTACHMENTS,
      rows: invoiceDraft === undefined ? undefined : async ({ scope, config, attachments }) => invoiceDraft.rows(scope, attachments, integerOptions(config, { limit: [1, 4] }, 'receivables invoice draft source')),
    },
  ];
}

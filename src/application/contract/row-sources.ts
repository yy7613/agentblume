/**
 * application層: 契約の行ソース（`contract-review-draft` / `contract-deadlines` / `contract-clauses`）の宣言（ADR-0039）。
 *
 * 書き換えの規律（文脈が無ければ書き換えない・未配線は理由付きで落とす・添付必須・スキーマを添える）は
 * データソース BC の `row-sources.ts` が 1 か所で持つ。ここは「どのノードを・どのスキーマで・何を要り・
 * 設定をどう読んで・どのポートから行を取るか」だけを宣言する。契約 BC がデータソース BC の登録型へ依存するのはこのファイルだけ。
 */
import type { Row } from '../../domain/data/types';
import { CONTRACT_CLAUSES_SCHEMA, CONTRACT_CLAUSES_STATUSES } from '../../domain/etl/nodes/contract-clauses-source';
import { CONTRACT_DEADLINES_SCHEMA } from '../../domain/etl/nodes/contract-deadlines-source';
import { CONTRACT_REVIEW_DRAFT_SCHEMA } from '../../domain/etl/nodes/contract-review-draft';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import type { RowSourceResolver } from '../data-source/row-sources';
import type { ClauseRowsOptions, DeadlineRowsOptions } from './ledger-rows';
import type { ReviewDraftAttachments, ReviewDraftOptions } from './review-draft-rows';

export interface ContractReviewDraftReadPort {
  rows(scope: TenantScope, attachments: ReviewDraftAttachments, options?: ReviewDraftOptions): Promise<readonly Row[]>;
}
export interface ContractDeadlineReadPort {
  rows(scope: TenantScope, options?: DeadlineRowsOptions): Promise<readonly Row[]>;
}
export interface ContractClauseReadPort {
  rows(scope: TenantScope, options?: ClauseRowsOptions): Promise<readonly Row[]>;
}

/** 省略したポートは「未配線」の理由付きで落ちる（空表を返すと「期限が 0 件」と読めてしまう）。 */
export interface ContractRowSourcePorts {
  readonly reviewDraft?: ContractReviewDraftReadPort;
  readonly deadlines?: ContractDeadlineReadPort;
  readonly clauses?: ContractClauseReadPort;
}

/** 添付が無いとき。利用者が直せる状態なので、何を添付すればよいかまで言う（docs/23 §9.1）。 */
export const CONTRACT_MISSING_ATTACHMENTS = 'no contract is attached to this message; attach the contract PDF or paste its text and ask again';

const isInt = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function reviewDraftOptions(config: Readonly<Record<string, unknown>>): ReviewDraftOptions {
  const { playbookId, llmCriteria, limit } = config;
  if ((playbookId !== undefined && (typeof playbookId !== 'string' || playbookId === ''))
    || (llmCriteria !== undefined && typeof llmCriteria !== 'boolean')
    || (limit !== undefined && !isInt(limit, 1, 2))) throw new DataSourceValidationError('contract review draft source has invalid settings');
  return { ...(playbookId === undefined ? {} : { playbookId: playbookId as string }), ...(llmCriteria === undefined ? {} : { llmCriteria: llmCriteria as boolean }), ...(limit === undefined ? {} : { limit: limit as number }) };
}

function deadlineOptions(config: Readonly<Record<string, unknown>>): DeadlineRowsOptions {
  const { includeOverdue, horizonDays, limit } = config;
  if ((includeOverdue !== undefined && typeof includeOverdue !== 'boolean') || (horizonDays !== undefined && !isInt(horizonDays, 1, 36_500)) || (limit !== undefined && !isInt(limit, 1, 10_000))) {
    throw new DataSourceValidationError('contract deadlines source has invalid settings');
  }
  return { ...(includeOverdue === undefined ? {} : { includeOverdue: includeOverdue as boolean }), ...(horizonDays === undefined ? {} : { horizonDays: horizonDays as number }), ...(limit === undefined ? {} : { limit: limit as number }) };
}

function clauseOptions(config: Readonly<Record<string, unknown>>): ClauseRowsOptions {
  const { status, limit } = config;
  if ((status !== undefined && !(CONTRACT_CLAUSES_STATUSES as readonly unknown[]).includes(status)) || (limit !== undefined && !isInt(limit, 1, 10_000))) {
    throw new DataSourceValidationError('contract clauses source has invalid settings');
  }
  return { ...(status === undefined ? {} : { status: status as ClauseRowsOptions['status'] & string }), ...(limit === undefined ? {} : { limit: limit as number }) };
}

/** 契約の行ソース 3 種。ポートの有無に関わらず 3 つとも登録する（未配線を理由付きで拒否するため）。 */
export function contractRowSources(ports: ContractRowSourcePorts): readonly RowSourceResolver[] {
  const { reviewDraft, deadlines, clauses } = ports;
  return [
    {
      nodeType: 'contract-review-draft',
      schema: CONTRACT_REVIEW_DRAFT_SCHEMA,
      requirement: 'attachments-or-documents',
      unavailableMessage: 'contract review draft is not available',
      missingAttachmentsMessage: CONTRACT_MISSING_ATTACHMENTS,
      rows: reviewDraft === undefined ? undefined : async ({ scope, config, attachments, documents }) => {
        const options = reviewDraftOptions(config);
        return reviewDraft.rows(scope, { documents, images: attachments }, options);
      },
    },
    {
      nodeType: 'contract-deadlines',
      schema: CONTRACT_DEADLINES_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'contract deadlines are not available',
      rows: deadlines === undefined ? undefined : async ({ scope, config }) => deadlines.rows(scope, deadlineOptions(config)),
    },
    {
      nodeType: 'contract-clauses',
      schema: CONTRACT_CLAUSES_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'contract clauses are not available',
      rows: clauses === undefined ? undefined : async ({ scope, config }) => clauses.rows(scope, clauseOptions(config)),
    },
  ];
}

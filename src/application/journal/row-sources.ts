/**
 * application層: 仕訳の行ソース（`journal-entries` / `journal-attachment` / `journal-draft-entry`）の宣言。
 *
 * 書き換えの規律（文脈が無ければ書き換えない・未配線は理由付きで落とす・添付必須・スキーマを添える）は
 * データソース BC の `row-sources.ts` が 1 か所で持つ。ここは「どのノードを・どのスキーマで・何を要り・
 * 設定をどう読んで・どのポートから行を取るか」だけを宣言する（ADR-0039）。
 *
 * 仕訳 BC がデータソース BC の登録型へ依存するのは**このファイルだけ**にする。行の畳み方を持つ
 * `entry-rows.ts` などは従来どおりデータソース BC を知らない（ポートは構造的に満たす）。
 */
import type { Row } from '../../domain/data/types';
import { JOURNAL_ATTACHMENT_SCHEMA } from '../../domain/etl/nodes/journal-attachment';
import { JOURNAL_DRAFT_ENTRY_SCHEMA } from '../../domain/etl/nodes/journal-draft-entry';
import { JOURNAL_ENTRIES_SCHEMA, JOURNAL_ENTRIES_STATUSES, type JournalEntriesStatus } from '../../domain/etl/nodes/journal-entries-source';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import type { ResolveAttachment, RowSourceResolver } from '../data-source/row-sources';

/** 仕訳（`journal-entries` ソース）の絞り込み。ノードの config と同じ形。 */
export interface JournalEntryReadOptions {
  readonly status?: JournalEntriesStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  /** 読む仕訳の件数上限（出力行数ではない）。 */
  readonly limit?: number;
}

/** 仕訳の行を供給するポート。実装は `entry-rows.ts`（`JournalEntryRowsProvider`）。 */
export interface JournalEntryReadPort {
  rows(scope: TenantScope, options?: JournalEntryReadOptions): Promise<readonly Row[]>;
}

/** 添付帳票を読み取って行にするポート。読み取りは LLM が行う。実装は `attachment-rows.ts`。 */
export interface JournalAttachmentReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

/** 添付帳票を読み取り、保存済みのルールで判定して仕訳案にするポート（保存はしない）。実装は `draft-entry-rows.ts`。 */
export interface JournalDraftEntryReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

/** 各ポート。省略したものは「未配線」の理由付きで落ちる（空表を返すと「仕訳が 0 件」「帳票に何も書いていない」と読めてしまう）。 */
export interface JournalRowSourcePorts {
  readonly entries?: JournalEntryReadPort;
  readonly attachments?: JournalAttachmentReadPort;
  readonly draftEntries?: JournalDraftEntryReadPort;
}

/** 添付が無いとき。利用者が直せる状態なので、何を添付すればよいかまで言う。 */
const MISSING_ATTACHMENTS = 'no document is attached to this message; attach the receipt or invoice image and ask again';

/** `limit` だけを持つ config を読む。整数でなければポートを呼ぶ前に落とす。 */
function limitOption(config: Readonly<Record<string, unknown>>, invalidMessage: string): { readonly limit: number } | undefined {
  const limit = config['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) throw new DataSourceValidationError(invalidMessage);
  return limit === undefined ? undefined : { limit };
}

/** `journal-entries` の config を読む。形が崩れていればポートを呼ぶ前に落とす。 */
function entryOptions(config: Readonly<Record<string, unknown>>): JournalEntryReadOptions {
  const { status, from, to, limit } = config;
  if ((status !== undefined && (typeof status !== 'string' || !(JOURNAL_ENTRIES_STATUSES as readonly string[]).includes(status)))
    || (from !== undefined && typeof from !== 'string')
    || (to !== undefined && typeof to !== 'string')
    || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit)))) {
    throw new DataSourceValidationError('journal entries source has invalid settings');
  }
  return {
    ...(status === undefined ? {} : { status: status as JournalEntriesStatus }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** 仕訳の行ソース 3 種。ポートの有無に関わらず 3 つとも登録する（未配線を理由付きで拒否するため）。 */
export function journalRowSources(ports: JournalRowSourcePorts): readonly RowSourceResolver[] {
  const { entries, attachments, draftEntries } = ports;
  return [
    {
      nodeType: 'journal-entries',
      schema: JOURNAL_ENTRIES_SCHEMA,
      // 保存済みの仕訳を読むだけなので、実行文脈に依らない。
      requirement: 'none',
      unavailableMessage: 'journal entries are not available',
      rows: entries === undefined ? undefined : async ({ scope, config }) => entries.rows(scope, entryOptions(config)),
    },
    {
      nodeType: 'journal-attachment',
      schema: JOURNAL_ATTACHMENT_SCHEMA,
      requirement: 'attachments',
      unavailableMessage: 'journal attachment reading is not available',
      missingAttachmentsMessage: MISSING_ATTACHMENTS,
      rows: attachments === undefined ? undefined : async ({ scope, config, attachments: given }) =>
        attachments.rows(scope, given, limitOption(config, 'journal attachment source has invalid settings')),
    },
    {
      nodeType: 'journal-draft-entry',
      schema: JOURNAL_DRAFT_ENTRY_SCHEMA,
      requirement: 'attachments',
      unavailableMessage: 'journal draft entry is not available',
      missingAttachmentsMessage: MISSING_ATTACHMENTS,
      rows: draftEntries === undefined ? undefined : async ({ scope, config, attachments: given }) =>
        draftEntries.rows(scope, given, limitOption(config, 'journal draft entry source has invalid settings')),
    },
  ];
}

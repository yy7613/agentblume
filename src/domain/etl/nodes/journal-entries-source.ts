/**
 * ドメイン: ノード `journal-entries`
 *
 * kind: source / arity: 0。
 * 仕訳（JournalEntry）を **1 行 = 1 仕訳行**（借方 × 貸方の対）のテーブルとして返すソース。
 * 汎用 CSV（`export.ts` の `genericCsvRows`）と同じ畳み方だが、列名は機械可読な短い名前にし、
 * 金額は数値・日付は `YYYY-MM-DD` 文字列で返す（会計ソフトへ渡す CSV ではなく、Agent が読む表）。
 *
 * config は `{ status?, from?, to?, limit? }`（docs/20 §13 フェーズ 3 の組込みツール）。
 * - `status`: `draft` / `confirmed` / `exported`。省略時は全状態。
 * - `from` / `to`: 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。
 * - `limit`: 読む仕訳（entry）の件数上限。出力行数ではない（複合仕訳は 1 件が複数行になる）。
 *
 * **このノード自身はリポジトリへ到達できない**（domain は application/adapters を知らない）。
 * `web-search-source` と同じ規律で、実行直前に `ResolveDataSourceGraphUseCase` が
 * `json-source`（行 + 固定スキーマ）へ書き換える。したがって未解決のまま execute された場合は
 * **例外を投げず空テーブルを返す**（設計時プレビューやリゾルバ未配線の検証で落とさないため。
 * リゾルバが配線されていないときの拒否は application 層の責務）。
 *
 * 出力スキーマは入力にも config にも依存せず固定（inferSchema は常に confirmed）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** 仕訳の状態（`domain/journal/entry.ts` の `ENTRY_STATUSES` と同じ集合）。 */
export const JOURNAL_ENTRIES_STATUSES = ['draft', 'confirmed', 'exported'] as const;
export type JournalEntriesStatus = (typeof JOURNAL_ENTRIES_STATUSES)[number];

/** `journal-entries` の設定。 */
export interface JournalEntriesSourceConfig {
  readonly status?: JournalEntriesStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  /** 読む仕訳の件数上限（出力行数ではない）。 */
  readonly limit?: number;
}

/** `YYYY-MM-DD`。 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const configSchema = z.object({
  status: z.enum(JOURNAL_ENTRIES_STATUSES).optional(),
  from: z.string().regex(ISO_DATE, 'from must be a date in YYYY-MM-DD').optional(),
  to: z.string().regex(ISO_DATE, 'to must be a date in YYYY-MM-DD').optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

/** 出力列名（順序は固定。application 層の行組み立てとリゾルバがこの並びを共有する）。 */
export const JOURNAL_ENTRIES_COLUMNS = [
  'entry_id', 'line_no', 'date',
  'debit_account', 'debit_tax_code', 'debit_amount',
  'credit_account', 'credit_tax_code', 'credit_amount',
  'description', 'invoice_status', 'status', 'document_id', 'rule_id',
] as const;
export type JournalEntriesColumn = (typeof JOURNAL_ENTRIES_COLUMNS)[number];

/**
 * 固定の出力スキーマ（入力にも config にも依存しない）。
 * 借方 / 貸方の列は **複合仕訳で片側が空になる**ため nullable（単純仕訳は 1 行に両側が入る）。
 */
export const JOURNAL_ENTRIES_SCHEMA: Schema = {
  columns: [
    { name: 'entry_id', type: 'string', nullable: false },
    { name: 'line_no', type: 'number', nullable: false },
    { name: 'date', type: 'string', nullable: false },
    { name: 'debit_account', type: 'string', nullable: true },
    { name: 'debit_tax_code', type: 'string', nullable: true },
    { name: 'debit_amount', type: 'number', nullable: true },
    { name: 'credit_account', type: 'string', nullable: true },
    { name: 'credit_tax_code', type: 'string', nullable: true },
    { name: 'credit_amount', type: 'number', nullable: true },
    { name: 'description', type: 'string', nullable: false },
    { name: 'invoice_status', type: 'string', nullable: false },
    { name: 'status', type: 'string', nullable: false },
    { name: 'document_id', type: 'string', nullable: true },
    { name: 'rule_id', type: 'string', nullable: true },
  ],
};

class JournalEntriesSourceNode implements EtlNode<JournalEntriesSourceConfig> {
  readonly type = 'journal-entries';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): JournalEntriesSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`journal-entries: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: JournalEntriesSourceConfig): SchemaInference {
    return { schema: JOURNAL_ENTRIES_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: JournalEntriesSourceConfig): Table {
    // 未解決のまま実行された場合（リゾルバが書き換えていない）は空テーブル。投げない。
    return { schema: JOURNAL_ENTRIES_SCHEMA, rows: [] };
  }
}

/** `journal-entries` ノードのシングルトン。 */
export const journalEntriesSourceNode: EtlNode<JournalEntriesSourceConfig> = new JournalEntriesSourceNode();

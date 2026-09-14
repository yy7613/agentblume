/**
 * ドメイン: ノード `journal-attachment`
 *
 * kind: source / arity: 0。
 * **いまのエージェント実行に添付された帳票**（レシート・請求書の画像）を読み取り、
 * 1 行 = 1 添付のテーブルとして返すソース。列は機械可読な短い名前にし、金額は数値・
 * 日付は `YYYY-MM-DD` 文字列で返す（会計ソフトへ渡す CSV ではなく、Agent が読む表）。
 *
 * 読み取りは LLM が行うため、**このノード自身はモデルにも実行文脈にも到達できない**
 * （domain は application/adapters を知らない）。`journal-entries` と同じ規律で、実行直前に
 * `ResolveDataSourceGraphUseCase` が `json-source`（行 + 固定スキーマ）へ書き換える。
 * 未解決のまま execute された場合は **例外を投げず空テーブルを返す**（設計時プレビューや
 * リゾルバ未配線の検証で落とさないため。拒否は application 層の責務）。
 *
 * 事実は平坦な列へ展開する。セル（`Cell`）は文字列・数値・真偽・日付・null しか持てず、
 * 税率別の内訳や明細を入れ子で運べないため。取りこぼす細部は `facts_json` に JSON 文字列で添える。
 *
 * 出力スキーマは入力にも config にも依存せず固定（inferSchema は常に confirmed）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** `journal-attachment` の設定。 */
export interface JournalAttachmentSourceConfig {
  /** 読む添付の枚数上限。省略時は添付すべて。 */
  readonly limit?: number;
}

const configSchema = z.object({
  limit: z.number().int().min(1).max(8).optional(),
});

/** 出力列名（順序は固定。application 層の行組み立てとリゾルバがこの並びを共有する）。 */
export const JOURNAL_ATTACHMENT_COLUMNS = [
  'file_name', 'kind',
  'issuer_name', 'registration_number', 'invoice_status',
  'issue_date', 'transaction_date', 'grand_total',
  'tax_10_taxable', 'tax_10_tax', 'tax_8_taxable', 'tax_8_tax',
  'description', 'confidence', 'warnings', 'facts_json',
] as const;
export type JournalAttachmentColumn = (typeof JOURNAL_ATTACHMENT_COLUMNS)[number];

/**
 * 固定の出力スキーマ。
 * **読み取れなかった項目は null** になる（帳票に書いていない項目があるのは普通のこと）。
 * 常に埋まるのは添付そのものに由来する `file_name` と、分類の既定値を持つ `kind` だけ。
 */
export const JOURNAL_ATTACHMENT_SCHEMA: Schema = {
  columns: [
    { name: 'file_name', type: 'string', nullable: false },
    { name: 'kind', type: 'string', nullable: false },
    { name: 'issuer_name', type: 'string', nullable: true },
    { name: 'registration_number', type: 'string', nullable: true },
    { name: 'invoice_status', type: 'string', nullable: true },
    { name: 'issue_date', type: 'string', nullable: true },
    { name: 'transaction_date', type: 'string', nullable: true },
    { name: 'grand_total', type: 'number', nullable: true },
    { name: 'tax_10_taxable', type: 'number', nullable: true },
    { name: 'tax_10_tax', type: 'number', nullable: true },
    { name: 'tax_8_taxable', type: 'number', nullable: true },
    { name: 'tax_8_tax', type: 'number', nullable: true },
    { name: 'description', type: 'string', nullable: true },
    { name: 'confidence', type: 'number', nullable: true },
    // 読み取りの申告（税率別合計が合わない等）。無ければ空文字。
    { name: 'warnings', type: 'string', nullable: false },
    // 平坦な列に収まらない細部（明細・税率別の全内訳）。JSON 文字列。
    { name: 'facts_json', type: 'string', nullable: false },
  ],
};

class JournalAttachmentSourceNode implements EtlNode<JournalAttachmentSourceConfig> {
  readonly type = 'journal-attachment';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): JournalAttachmentSourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`journal-attachment: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: JournalAttachmentSourceConfig): SchemaInference {
    return { schema: JOURNAL_ATTACHMENT_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: JournalAttachmentSourceConfig): Table {
    // 未解決のまま実行された場合（リゾルバが書き換えていない）は空テーブル。投げない。
    return { schema: JOURNAL_ATTACHMENT_SCHEMA, rows: [] };
  }
}

/** `journal-attachment` ノードのシングルトン。 */
export const journalAttachmentSourceNode: EtlNode<JournalAttachmentSourceConfig> = new JournalAttachmentSourceNode();

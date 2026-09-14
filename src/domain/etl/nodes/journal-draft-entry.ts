/**
 * ドメイン: ノード `journal-draft-entry`
 *
 * kind: source / arity: 0。
 * **いまの実行に添付された帳票を読み取り、保存済みのルールで判定し、仕訳案まで出す**ソース。
 * 仕訳画面の 取込 → 判定 の流れを、そのまま 1 本のツールとして通すためのもの。
 *
 * 返すのは 1 行 = 1 仕訳行（借方 / 貸方それぞれ 1 行）。確定しなかった帳票は、行の代わりに
 * `decided = false` と理由（`reason`）を持つ 1 行を返す — 空表にすると「仕訳が無い」と
 * 「判定できなかった」を区別できないため。
 *
 * **保存しない。** 帳票も仕訳も作らず、判定結果を返すだけ（帳簿に残すのは画面から人が押す。docs/20 §14.1）。
 *
 * このノード自身はモデルにもリポジトリにも到達できないので、`journal-attachment` と同じ規律で
 * 実行直前に `ResolveDataSourceGraphUseCase` が `json-source` へ書き換える。未解決のまま
 * execute された場合は **例外を投げず空テーブルを返す**（拒否は application 層の責務）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

/** `journal-draft-entry` の設定。 */
export interface JournalDraftEntrySourceConfig {
  /** 読む添付の枚数上限。省略時は添付すべて。 */
  readonly limit?: number;
}

const configSchema = z.object({
  limit: z.number().int().min(1).max(8).optional(),
});

/** 出力列名（順序は固定。application 層の行組み立てとリゾルバがこの並びを共有する）。 */
export const JOURNAL_DRAFT_ENTRY_COLUMNS = [
  'file_name', 'decided', 'reason', 'rule_id', 'rule_name',
  'line_no', 'side', 'account', 'tax_code', 'amount', 'partner',
  'date', 'description', 'invoice_status', 'facts_json',
] as const;
export type JournalDraftEntryColumn = (typeof JOURNAL_DRAFT_ENTRY_COLUMNS)[number];

/**
 * 固定の出力スキーマ。
 * 確定しなかった行は仕訳の列（`line_no` 以降 `invoice_status` まで）が null になるので nullable。
 * 常に埋まるのは添付に由来する `file_name`、判定の成否 `decided`、読み取った事実 `facts_json`。
 */
export const JOURNAL_DRAFT_ENTRY_SCHEMA: Schema = {
  columns: [
    { name: 'file_name', type: 'string', nullable: false },
    { name: 'decided', type: 'boolean', nullable: false },
    // 確定しなかった理由（`no-rule` / `multiple-rules` / `missing-fact` …）。確定した行では null。
    { name: 'reason', type: 'string', nullable: true },
    { name: 'rule_id', type: 'string', nullable: true },
    { name: 'rule_name', type: 'string', nullable: true },
    { name: 'line_no', type: 'number', nullable: true },
    { name: 'side', type: 'string', nullable: true },
    { name: 'account', type: 'string', nullable: true },
    { name: 'tax_code', type: 'string', nullable: true },
    { name: 'amount', type: 'number', nullable: true },
    { name: 'partner', type: 'string', nullable: true },
    { name: 'date', type: 'string', nullable: true },
    { name: 'description', type: 'string', nullable: true },
    { name: 'invoice_status', type: 'string', nullable: true },
    // 読み取った事実そのもの（平坦な列に収まらない明細・税率別の内訳）。JSON 文字列。
    { name: 'facts_json', type: 'string', nullable: false },
  ],
};

class JournalDraftEntrySourceNode implements EtlNode<JournalDraftEntrySourceConfig> {
  readonly type = 'journal-draft-entry';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): JournalDraftEntrySourceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`journal-draft-entry: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: JournalDraftEntrySourceConfig): SchemaInference {
    return { schema: JOURNAL_DRAFT_ENTRY_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: JournalDraftEntrySourceConfig): Table {
    // 未解決のまま実行された場合（リゾルバが書き換えていない）は空テーブル。投げない。
    return { schema: JOURNAL_DRAFT_ENTRY_SCHEMA, rows: [] };
  }
}

/** `journal-draft-entry` ノードのシングルトン。 */
export const journalDraftEntrySourceNode: EtlNode<JournalDraftEntrySourceConfig> = new JournalDraftEntrySourceNode();

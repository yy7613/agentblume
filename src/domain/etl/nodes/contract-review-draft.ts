/**
 * ドメイン: ノード `contract-review-draft`（docs/23 §9.1）
 *
 * kind: source / arity: 0。**いまのエージェント実行に添付された契約書**（テキスト添付か画像）を条項に分けて
 * 審査基準で判定し、トピックごとの行 + 文書全体の所見の行を返す。何も保存しない。
 *
 * 読み取りと判定は LLM と審査基準（リポジトリ）を使うので、このノード自身はそこへ到達できない。
 * 実行直前に `ResolveDataSourceGraphUseCase` が `json-source`（行 + 固定スキーマ）へ書き換える。
 * 未解決のまま execute された場合は例外を投げず空テーブルを返す（拒否は application 層の責務）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ContractReviewDraftConfig {
  /** 使う審査基準（省略は既定）。 */
  readonly playbookId?: string;
  /** はい/いいえ型の基準をモデルに答えさせるか（既定 true）。 */
  readonly llmCriteria?: boolean;
  /** 読む添付の件数上限。 */
  readonly limit?: number;
}

const configSchema = z.object({
  playbookId: z.string().min(1).max(100).optional(),
  llmCriteria: z.boolean().optional(),
  limit: z.number().int().min(1).max(2).optional(),
});

export const CONTRACT_REVIEW_DRAFT_SCHEMA: Schema = {
  columns: [
    { name: 'file_name', type: 'string', nullable: false },
    { name: 'playbook_name', type: 'string', nullable: false },
    { name: 'overall', type: 'string', nullable: false },
    { name: 'row_type', type: 'string', nullable: false },
    { name: 'topic_id', type: 'string', nullable: true },
    { name: 'topic_label', type: 'string', nullable: true },
    { name: 'verdict', type: 'string', nullable: true },
    { name: 'present', type: 'boolean', nullable: true },
    { name: 'article_ref', type: 'string', nullable: true },
    { name: 'quote', type: 'string', nullable: true },
    { name: 'quote_verified', type: 'boolean', nullable: true },
    { name: 'value_summary', type: 'string', nullable: true },
    { name: 'reasons', type: 'string', nullable: false },
    { name: 'recommended_text', type: 'string', nullable: true },
    { name: 'findings', type: 'string', nullable: false },
    { name: 'value_json', type: 'string', nullable: false },
    { name: 'criteria_json', type: 'string', nullable: false },
  ],
};

class ContractReviewDraftSourceNode implements EtlNode<ContractReviewDraftConfig> {
  readonly type = 'contract-review-draft';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ContractReviewDraftConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`contract-review-draft: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ContractReviewDraftConfig): SchemaInference {
    return { schema: CONTRACT_REVIEW_DRAFT_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ContractReviewDraftConfig): Table {
    return { schema: CONTRACT_REVIEW_DRAFT_SCHEMA, rows: [] };
  }
}

export const contractReviewDraftSourceNode: EtlNode<ContractReviewDraftConfig> = new ContractReviewDraftSourceNode();

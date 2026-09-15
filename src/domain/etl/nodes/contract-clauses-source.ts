/**
 * ドメイン: ノード `contract-clauses`（docs/23 §9.3）
 *
 * kind: source / arity: 0。締結済み契約 × 条項の種類を 1 行で返す。**条項が無い種類も present = false の行として出す**
 * （「上限が無い契約は？」に答えるため）。検索用のタグは決定的な語彙（`clause-tags.ts`）。
 * リポジトリへ届かないので、実行直前に `ResolveDataSourceGraphUseCase` が `json-source` へ書き換える。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export const CONTRACT_CLAUSES_STATUSES = ['active', 'expired', 'terminated'] as const;

export interface ContractClausesConfig {
  readonly status?: (typeof CONTRACT_CLAUSES_STATUSES)[number];
  /** 読む契約の件数上限（行数ではない）。 */
  readonly limit?: number;
}

const configSchema = z.object({
  status: z.enum(CONTRACT_CLAUSES_STATUSES).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export const CONTRACT_CLAUSES_SCHEMA: Schema = {
  columns: [
    { name: 'contract_id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
    { name: 'counterparty', type: 'string', nullable: false },
    { name: 'signed_date', type: 'string', nullable: false },
    { name: 'contract_status', type: 'string', nullable: false },
    { name: 'topic_id', type: 'string', nullable: false },
    { name: 'topic_label', type: 'string', nullable: false },
    { name: 'present', type: 'boolean', nullable: false },
    { name: 'value_summary', type: 'string', nullable: true },
    { name: 'tags', type: 'string', nullable: false },
    { name: 'article_ref', type: 'string', nullable: true },
    { name: 'quote', type: 'string', nullable: true },
    { name: 'review_verdict', type: 'string', nullable: true },
    { name: 'value_json', type: 'string', nullable: true },
  ],
};

class ContractClausesSourceNode implements EtlNode<ContractClausesConfig> {
  readonly type = 'contract-clauses';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ContractClausesConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`contract-clauses: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ContractClausesConfig): SchemaInference {
    return { schema: CONTRACT_CLAUSES_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ContractClausesConfig): Table {
    return { schema: CONTRACT_CLAUSES_SCHEMA, rows: [] };
  }
}

export const contractClausesSourceNode: EtlNode<ContractClausesConfig> = new ContractClausesSourceNode();

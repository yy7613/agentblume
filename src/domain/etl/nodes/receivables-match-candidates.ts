/**
 * ドメイン: ノード `receivables-match-candidates`（docs/22 §10.2）。kind: source / arity: 0。
 *
 * 未消込の入金ごとにその場で判定し（保存しない）、候補ごとに 1 行を返す。候補の無い入金も候補列が null の 1 行を返す
 * （空表にすると「入金が無い」と「候補が無い」を区別できない）。行は実行直前に差し込まれ、未解決なら空表。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ReceivablesMatchCandidatesConfig {
  readonly limit?: number;
  readonly maxCandidates?: number;
}

const configSchema = z.object({ limit: z.number().int().min(1).max(200).optional(), maxCandidates: z.number().int().min(1).max(5).optional() });

export const RECEIVABLES_MATCH_CANDIDATES_SCHEMA: Schema = {
  columns: [
    { name: 'transaction_id', type: 'string', nullable: false },
    { name: 'transaction_date', type: 'string', nullable: false },
    { name: 'amount', type: 'number', nullable: false },
    { name: 'payer_name', type: 'string', nullable: false },
    { name: 'stage', type: 'string', nullable: false },
    { name: 'reason', type: 'string', nullable: false },
    { name: 'reason_message', type: 'string', nullable: false },
    { name: 'candidate_rank', type: 'number', nullable: true },
    { name: 'invoice_ids', type: 'string', nullable: true },
    { name: 'invoice_numbers', type: 'string', nullable: true },
    { name: 'customer_id', type: 'string', nullable: true },
    { name: 'customer_name', type: 'string', nullable: true },
    { name: 'candidate_total', type: 'number', nullable: true },
    { name: 'difference', type: 'number', nullable: true },
    { name: 'fee_amount', type: 'number', nullable: true },
    { name: 'combination_size', type: 'number', nullable: true },
    { name: 'name_match', type: 'string', nullable: true },
    { name: 'name_score', type: 'number', nullable: true },
  ],
};

class ReceivablesMatchCandidatesNode implements EtlNode<ReceivablesMatchCandidatesConfig> {
  readonly type = 'receivables-match-candidates';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;
  validateConfig(config: unknown): ReceivablesMatchCandidatesConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`receivables-match-candidates: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }
  inferSchema(): SchemaInference { return { schema: RECEIVABLES_MATCH_CANDIDATES_SCHEMA, state: 'confirmed', issues: [] }; }
  execute(): Table { return { schema: RECEIVABLES_MATCH_CANDIDATES_SCHEMA, rows: [] }; }
}

export const receivablesMatchCandidatesNode: EtlNode<ReceivablesMatchCandidatesConfig> = new ReceivablesMatchCandidatesNode();

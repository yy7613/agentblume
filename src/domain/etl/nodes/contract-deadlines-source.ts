/**
 * ドメイン: ノード `contract-deadlines`（docs/23 §9.2）
 *
 * kind: source / arity: 0。締結済み契約の**未完了の期限**を 1 行 = 1 期限（期限日の昇順）で返す。
 * 自動更新の契約は現在期で計算し直した期限を出す。リポジトリへ届かないので、実行直前に
 * `ResolveDataSourceGraphUseCase` が `json-source` へ書き換える（未解決なら空テーブル。投げない）。
 */
import { z } from 'zod';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference } from '../node';
import { zodMessage } from './zod-error';

export interface ContractDeadlinesConfig {
  /** 過ぎた期限を含めるか（既定 true）。 */
  readonly includeOverdue?: boolean;
  /** 今日から何日先までの期限を読むか。 */
  readonly horizonDays?: number;
  readonly limit?: number;
}

const configSchema = z.object({
  includeOverdue: z.boolean().optional(),
  horizonDays: z.number().int().min(1).max(36_500).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export const CONTRACT_DEADLINES_SCHEMA: Schema = {
  columns: [
    { name: 'contract_id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
    { name: 'counterparty', type: 'string', nullable: false },
    { name: 'kind', type: 'string', nullable: false },
    { name: 'due_date', type: 'string', nullable: false },
    { name: 'days_left', type: 'number', nullable: false },
    { name: 'state', type: 'string', nullable: false },
    { name: 'term_index', type: 'number', nullable: true },
    { name: 'term_end', type: 'string', nullable: true },
    { name: 'auto_renewal', type: 'boolean', nullable: false },
    { name: 'basis', type: 'string', nullable: false },
    { name: 'today', type: 'string', nullable: false },
  ],
};

class ContractDeadlinesSourceNode implements EtlNode<ContractDeadlinesConfig> {
  readonly type = 'contract-deadlines';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): ContractDeadlinesConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`contract-deadlines: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], _config: ContractDeadlinesConfig): SchemaInference {
    return { schema: CONTRACT_DEADLINES_SCHEMA, state: 'confirmed', issues: [] };
  }

  execute(_inputs: readonly Table[], _config: ContractDeadlinesConfig): Table {
    return { schema: CONTRACT_DEADLINES_SCHEMA, rows: [] };
  }
}

export const contractDeadlinesSourceNode: EtlNode<ContractDeadlinesConfig> = new ContractDeadlinesSourceNode();

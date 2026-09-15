/**
 * application層: 期限台帳と締結済み契約の条項を「Agent が読む表」へ畳む（組込みツール `contract_deadlines` / `contract_clauses`。docs/23 §9.2 / §9.3）。
 *
 * どちらも読むだけ。期限の完了・契約の変更はしない。
 */
import type { Row } from '../../domain/data/types';
import { clauseTags, formatTags } from '../../domain/contract/clause-tags';
import type { SignedContractRepository } from '../../domain/contract/repositories';
import { contractDisplayStatus, refreshSignedContract, type SignedContractStatus } from '../../domain/contract/signed-contract';
import { summarizeClauseValue } from '../../domain/contract/value-summary';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ContractPlaybookResolver } from './manage-playbooks';
import type { ListContractDeadlinesUseCase } from './signed-contracts';
import { localDate, systemClock, type Clock } from './support';

export interface DeadlineRowsOptions {
  readonly includeOverdue?: boolean;
  readonly horizonDays?: number;
  readonly limit?: number;
}

export class ContractDeadlineRowsProvider {
  constructor(private readonly ledger: ListContractDeadlinesUseCase) {}

  async rows(scope: TenantScope, options: DeadlineRowsOptions = {}): Promise<readonly Row[]> {
    const ledger = await this.ledger.execute({ scope, ...(options.horizonDays === undefined ? {} : { withinDays: options.horizonDays }), includeOverdue: options.includeOverdue ?? true, ...(options.limit === undefined ? {} : { limit: options.limit }) });
    // ツールは有効な契約だけを見せる（満了した非更新の契約の期限は「対応が要る期限」ではない）。
    return ledger.rows.filter((row) => row.contractStatus === 'active').map((row) => ({
      contract_id: row.contractId, title: row.title, counterparty: row.counterpartyName, kind: row.deadline.kind, due_date: row.deadline.dueDate,
      days_left: row.daysLeft, state: row.state, term_index: row.deadline.termIndex ?? null, term_end: row.deadline.termEnd ?? null,
      auto_renewal: row.autoRenewal, basis: row.deadline.basis, today: ledger.today,
    }));
  }
}

export interface ClauseRowsOptions {
  readonly status?: SignedContractStatus;
  readonly limit?: number;
}

export class ContractClauseRowsProvider {
  constructor(private readonly signed: SignedContractRepository, private readonly resolver: ContractPlaybookResolver, private readonly clock: Clock = systemClock) {}

  async rows(scope: TenantScope, options: ClauseRowsOptions = {}): Promise<readonly Row[]> {
    const now = this.clock();
    const today = localDate(now);
    const { playbook } = await this.resolver.resolve(scope);
    const status = options.status ?? 'active';
    const contracts = (await this.signed.list(scope))
      .map((contract) => refreshSignedContract(contract, today, now.toISOString()))
      .filter((contract) => contractDisplayStatus(contract, today) === status);
    const limited = options.limit === undefined ? contracts : contracts.slice(0, options.limit);
    const rows: Row[] = [];
    for (const contract of limited) {
      // 締結時の条項の写し + 今の既定の審査基準にしか無い種類（条項なしの行として出す）。
      const extraTopics = playbook.topics.filter((topic) => !contract.clauses.some((clause) => clause.topicId === topic.id)).map((topic) => ({ topicId: topic.id, topicLabel: topic.label, valueKind: topic.valueKind, present: false, quoteVerified: true }));
      for (const clause of [...contract.clauses, ...extraTopics]) {
        const value = 'value' in clause ? clause.value : undefined;
        rows.push({
          contract_id: contract.id, title: contract.title, counterparty: contract.counterpartyName, signed_date: contract.signedDate,
          contract_status: status, topic_id: clause.topicId, topic_label: clause.topicLabel, present: clause.present,
          value_summary: summarizeClauseValue(value),
          tags: formatTags(clauseTags(clause, { legal: playbook.legal, ...(contract.ourParty === undefined ? {} : { ourParty: contract.ourParty }) })),
          article_ref: 'articleRef' in clause ? clause.articleRef ?? null : null,
          quote: 'quote' in clause ? clause.quote ?? null : null,
          review_verdict: contract.reviewVerdicts[clause.topicId] ?? null,
          value_json: value === undefined ? null : JSON.stringify(value),
        });
      }
    }
    return rows;
  }
}

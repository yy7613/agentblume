import { randomUUID } from 'node:crypto';
import { FeedbackValidationError } from '../../domain/operations/errors';
import type { FeedbackThumb, RunFeedback } from '../../domain/operations/operations';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { RunNotFoundError } from '../../domain/run/errors';
import type { RunRepository } from '../../domain/run/run-repository';
import type { TenantScope } from '../../domain/tool/ids';

export interface SubmitRunFeedbackInput {
  readonly scope: TenantScope;
  readonly runId: string;
  readonly thumb: FeedbackThumb;
  readonly rating?: number;
  readonly comment?: string;
  readonly issueTags: readonly string[];
}

export class SubmitRunFeedbackUseCase {
  constructor(private readonly runs: RunRepository, private readonly operations: OperationsRepository, private readonly makeId: () => string = randomUUID, private readonly now: () => Date = () => new Date()) {}

  async execute(input: SubmitRunFeedbackInput): Promise<RunFeedback> {
    const run = await this.runs.find(input.scope, input.runId);
    if (run === null) throw new RunNotFoundError(`run not found: ${input.runId}`);
    if (run.agent?.version === undefined) throw new FeedbackValidationError('feedback requires a versioned Agent run');
    const existing = await this.operations.findFeedback(input.scope, input.runId);
    const timestamp = this.now().toISOString();
    const comment = input.comment?.trim();
    const record: RunFeedback = {
      id: existing?.id ?? this.makeId(), scope: { ...input.scope }, runId: input.runId,
      agent: { internalId: run.agent.internalId, version: run.agent.version }, thumb: input.thumb,
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(comment !== undefined && comment !== '' ? { comment } : {}),
      issueTags: [...new Set(input.issueTags.map((tag) => tag.trim()).filter((tag) => tag !== ''))],
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    await this.operations.saveFeedback(record);
    if (existing === null) {
      try { await this.operations.recordFeedbackMetric(input.scope, timestamp); } catch { /* aggregate failure is non-fatal */ }
    }
    return record;
  }
}

export class QueryRunFeedbackUseCase {
  constructor(private readonly operations: OperationsRepository) {}
  async get(scope: TenantScope, runId: string): Promise<RunFeedback | null> { return this.operations.findFeedback(scope, runId); }
}


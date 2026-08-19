/**
 * application層: Agent Factory `RetryFactoryRunUseCase`（v33 実装契約 §3 / docs/16-agent-factory.md §9）。
 *
 * 失敗したRun（`failed`）を「同じ入力で新しいRunとして起票し直す」。既存Runは監査証跡としてそのまま残し、
 * `CreateFactoryRunUseCase` に委譲して新しいRunを `queued` で作成・worker へ enqueue する
 * （`ResumeFactoryRunUseCase` のような同一Runの再開ではない。失敗Runは終端状態のため再開できない）。
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { FactoryRun } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import { FactoryNotFoundError, FactoryValidationError } from '../../domain/factory/errors';
import type { CreateFactoryRunUseCase } from './create-factory-run';

export interface RetryFactoryRunInput {
  readonly scope: TenantScope;
  readonly runId: FactoryRunId;
}

export class RetryFactoryRunUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly createFactoryRun: CreateFactoryRunUseCase,
  ) {}

  async execute(input: RetryFactoryRunInput): Promise<FactoryRun> {
    const stored = await this.runs.find(input.scope, input.runId);
    if (stored === null) throw new FactoryNotFoundError(`Factory run not found: ${input.runId}`);
    if (stored.status !== 'failed') throw new FactoryValidationError(`Factory run '${input.runId}' is not failed`);

    // 入力（goal / dataSourceIds / options / baseAgent）はそのまま引き継ぐ。options は解決済みの完全な
    // `FactoryOptions` なので `CreateFactoryRunUseCase` の既定値マージを通しても同じ値になる。
    // `baseAgent` を落とすと強化モードのRunが0→1生成モードで再実行されてしまうため必ず引き継ぐ。
    return this.createFactoryRun.execute({
      scope: input.scope,
      goal: stored.input.goal,
      dataSourceIds: stored.input.dataSourceIds,
      options: stored.input.options,
      ...(stored.input.baseAgent === undefined ? {} : { baseAgent: stored.input.baseAgent }),
    });
  }
}

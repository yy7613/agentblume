/**
 * application層: Agent Factory `CreateFactoryRunUseCase`（v33 実装契約 §3 / docs/16-agent-factory.md §9）。
 * `CreateExperimentUseCase`（v23）と同じ「保存してから非同期worker enqueue」パターン。
 */
import { randomUUID } from 'node:crypto';
import type { DataSourceId } from '../../domain/data-source/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import {
  DEFAULT_FACTORY_OPTIONS,
  startFactoryRun,
  type FactoryBaseAgentRef,
  type FactoryGoalInput,
  type FactoryOptions,
  type FactoryRun,
} from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryWorkerPort } from './factory-worker';

export interface CreateFactoryRunInput {
  readonly scope: TenantScope;
  readonly goal: FactoryGoalInput;
  readonly dataSourceIds: readonly DataSourceId[];
  readonly options?: Partial<FactoryOptions>;
  /** 強化対象の既存Agent。指定すると `dataSourceIds` は0件でもよい（未指定は0→1生成モード）。 */
  readonly baseAgent?: FactoryBaseAgentRef;
}

/** `DEFAULT_FACTORY_OPTIONS` に `overrides` を深くマージする（targets/budgetはネストしたオブジェクト）。 */
function mergeOptions(overrides: Partial<FactoryOptions> | undefined): FactoryOptions {
  if (overrides === undefined) return DEFAULT_FACTORY_OPTIONS;
  return {
    ...DEFAULT_FACTORY_OPTIONS,
    ...overrides,
    targets: { ...DEFAULT_FACTORY_OPTIONS.targets, ...overrides.targets },
    budget: { ...DEFAULT_FACTORY_OPTIONS.budget, ...overrides.budget },
  };
}

export class CreateFactoryRunUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly worker: FactoryWorkerPort,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: CreateFactoryRunInput): Promise<FactoryRun> {
    // 強化モード（`baseAgent` 指定）は「既存Agentのプロンプトだけを改善する」Runが成立するため、
    // 新規データソースを要求しない（0..5）。0→1生成モードは従来どおり最低1件必須（1..5）。
    const minDataSources = input.baseAgent === undefined ? 1 : 0;
    if (input.dataSourceIds.length < minDataSources || input.dataSourceIds.length > 5) {
      throw new FactoryValidationError(`CreateFactoryRun: dataSourceIds must contain ${minDataSources}..5 entries, got ${input.dataSourceIds.length}`);
    }
    const options = mergeOptions(input.options);
    const run = startFactoryRun({
      id: this.makeId(),
      scope: input.scope,
      input: {
        goal: input.goal,
        dataSourceIds: input.dataSourceIds,
        options,
        ...(input.baseAgent === undefined ? {} : { baseAgent: input.baseAgent }),
      },
      startedAt: this.now().toISOString(),
    });
    await this.runs.save(run);
    this.worker.enqueue(input.scope, run.id);
    return run;
  }
}

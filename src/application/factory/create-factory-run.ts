/**
 * application層: Agent Factory `CreateFactoryRunUseCase`（v33 実装契約 §3 / docs/16-agent-factory.md §9）。
 * `CreateExperimentUseCase`（v23）と同じ「保存してから非同期worker enqueue」パターン。
 */
import { randomUUID } from 'node:crypto';
import type { TenantScope } from '../../domain/tool/ids';
import {
  DEFAULT_FACTORY_OPTIONS,
  startFactoryRun,
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
  readonly dataSourceIds: readonly string[];
  readonly options?: Partial<FactoryOptions>;
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
    if (input.dataSourceIds.length < 1 || input.dataSourceIds.length > 5) {
      throw new FactoryValidationError(`CreateFactoryRun: dataSourceIds must contain 1..5 entries, got ${input.dataSourceIds.length}`);
    }
    const options = mergeOptions(input.options);
    const run = startFactoryRun({
      id: this.makeId(),
      scope: input.scope,
      input: { goal: input.goal, dataSourceIds: input.dataSourceIds, options },
      startedAt: this.now().toISOString(),
    });
    await this.runs.save(run);
    this.worker.enqueue(input.scope, run.id);
    return run;
  }
}

import type { TenantScope } from '../tool/ids';
import type { Experiment, ExperimentCaseResult, ExperimentStatus } from './experiment';

export interface ExperimentFilter { readonly status?: ExperimentStatus }
export interface ExperimentRepository {
  create(experiment: Experiment): Promise<void>;
  update(experiment: Experiment): Promise<void>;
  find(scope: TenantScope, id: string): Promise<Experiment | null>;
  list(scope: TenantScope, filter?: ExperimentFilter): Promise<Experiment[]>;
  saveCaseResult(result: ExperimentCaseResult): Promise<void>;
  listCaseResults(scope: TenantScope, experimentId: string): Promise<ExperimentCaseResult[]>;
  interruptRunning(finishedAt: string): number;
}

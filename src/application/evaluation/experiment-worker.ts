import type { TenantScope } from '../../domain/tool/ids';

export interface ExperimentWorkerPort {
  enqueue(scope: TenantScope, experimentId: string): void;
  cancel(scope: TenantScope, experimentId: string): void;
  shutdown(): void;
}

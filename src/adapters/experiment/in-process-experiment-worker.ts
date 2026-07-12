import type { RunExperimentUseCase } from '../../application/evaluation/run-experiment';
import type { ExperimentWorkerPort } from '../../application/evaluation/experiment-worker';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';

interface PendingExperiment { readonly scope: TenantScope; readonly id: string; readonly key: string }

export class InProcessExperimentWorker implements ExperimentWorkerPort {
  private readonly pending: PendingExperiment[] = [];
  private readonly known = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private draining = false;
  private stopped = false;

  constructor(private readonly runner: RunExperimentUseCase) {}

  enqueue(scope: TenantScope, experimentId: string): void {
    if (this.stopped) return;
    const key = `${tenantKey(scope)} ${experimentId}`;
    if (this.known.has(key)) return;
    this.known.add(key);
    this.pending.push({ scope: { ...scope }, id: experimentId, key });
    queueMicrotask(() => void this.drain());
  }

  cancel(scope: TenantScope, experimentId: string): void {
    const key = `${tenantKey(scope)} ${experimentId}`;
    this.active.get(key)?.abort();
    const index = this.pending.findIndex((item) => item.key === key);
    if (index >= 0) this.pending.splice(index, 1);
    this.known.delete(key);
  }

  shutdown(): void {
    this.stopped = true;
    this.pending.length = 0;
    for (const controller of this.active.values()) controller.abort();
    this.known.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const item = this.pending.shift();
        if (item === undefined) break;
        const controller = new AbortController();
        this.active.set(item.key, controller);
        try { await this.runner.execute(item.scope, item.id, controller.signal); }
        catch { /* RunExperiment persists terminal failure; worker keeps processing the queue. */ }
        finally { this.active.delete(item.key); this.known.delete(item.key); }
      }
    } finally { this.draining = false; }
  }
}

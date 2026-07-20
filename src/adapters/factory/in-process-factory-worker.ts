/**
 * adapter層: `FactoryWorkerPort` のインプロセス実装（v33 実装契約 §2 / docs/16-agent-factory.md §7）。
 * `InProcessExperimentWorker`（v23）と同じqueue / drain / cancel / shutdown規律。同時実行は1件。
 */
import type { RunFactoryUseCase } from '../../application/factory/run-factory';
import type { FactoryWorkerPort } from '../../application/factory/factory-worker';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';

interface PendingFactoryRun { readonly scope: TenantScope; readonly id: string; readonly key: string }

export class InProcessFactoryWorker implements FactoryWorkerPort {
  private readonly pending: PendingFactoryRun[] = [];
  private readonly known = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private draining = false;
  private stopped = false;

  constructor(private readonly runner: RunFactoryUseCase) {}

  enqueue(scope: TenantScope, runId: string): void {
    if (this.stopped) return;
    const key = `${tenantKey(scope)} ${runId}`;
    if (this.known.has(key)) return;
    this.known.add(key);
    this.pending.push({ scope: { ...scope }, id: runId, key });
    queueMicrotask(() => void this.drain());
  }

  cancel(scope: TenantScope, runId: string): void {
    const key = `${tenantKey(scope)} ${runId}`;
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
        catch { /* RunFactory persists terminal failure; worker keeps processing the queue. */ }
        finally { this.active.delete(item.key); this.known.delete(item.key); }
      }
    } finally { this.draining = false; }
  }
}

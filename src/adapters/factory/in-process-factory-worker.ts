/**
 * adapter層: `FactoryWorkerPort` のインプロセス実装（v33 実装契約 §2 / docs/16-agent-factory.md §7）。
 * `InProcessExperimentWorker`（v23）と同じqueue / drain / cancel / shutdown規律。同時実行は1件。
 */
import type { RunFactoryUseCase } from '../../application/factory/run-factory';
import type { FactoryWorkerPort } from '../../application/factory/factory-worker';
import { logSwallowed, type LoggerPort } from '../../application/operations/logger';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import { IdleLatch } from '../worker/idle-latch';

interface PendingFactoryRun { readonly scope: TenantScope; readonly id: string; readonly key: string }

export class InProcessFactoryWorker implements FactoryWorkerPort {
  private readonly pending: PendingFactoryRun[] = [];
  private readonly known = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  /** `drainInFlight` が実行中ジョブの完了を待つための合図。 */
  private readonly idle = new IdleLatch();
  private draining = false;
  private stopped = false;

  constructor(private readonly runner: RunFactoryUseCase, private readonly logger?: LoggerPort) {}

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

  /**
   * shutdown猶予（`AGENTCONTEXT_SHUTDOWN_GRACE_MS`）。`InProcessExperimentWorker` と同じ規律。
   * 新規enqueueとキュー消化を止め、**実行中のFactory Runだけ**を最大 `graceMs` 待ってから abort する。
   * 戻り値は猶予内に終わったか。
   */
  async drainInFlight(graceMs: number): Promise<boolean> {
    this.stopped = true;
    this.pending.length = 0;
    const finished = await this.idle.settle(this.active.size === 0, graceMs);
    if (!finished) for (const controller of this.active.values()) controller.abort();
    this.known.clear();
    return finished;
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
        // RunFactory persists terminal failure; worker keeps processing the queue.
        // ここまで例外が漏れてくるのは**Runの永続化自体が壊れている**ときで、無音だと
        // 「キューが動いているのに何も進まない」状態になる。握り潰す方針は保ったままログへ残す。
        catch (error) { logSwallowed(this.logger, 'factory run ended with an unhandled error', error, { runId: item.id }); }
        // 実行中が空になった合図は drainInFlight の待ち合わせに使う（待っていなければ no-op）。
        finally { this.active.delete(item.key); this.known.delete(item.key); if (this.active.size === 0) this.idle.release(); }
      }
    } finally { this.draining = false; }
  }
}

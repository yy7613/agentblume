import type { RunExperimentUseCase } from '../../application/evaluation/run-experiment';
import type { ExperimentWorkerPort } from '../../application/evaluation/experiment-worker';
import { logSwallowed, type LoggerPort } from '../../application/operations/logger';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { IdleLatch } from '../worker/idle-latch';

interface PendingExperiment { readonly scope: TenantScope; readonly id: string; readonly key: string }

export class InProcessExperimentWorker implements ExperimentWorkerPort {
  private readonly pending: PendingExperiment[] = [];
  private readonly known = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  /** `drainInFlight` が実行中ジョブの完了を待つための合図。 */
  private readonly idle = new IdleLatch();
  private draining = false;
  private stopped = false;

  constructor(private readonly runner: RunExperimentUseCase, private readonly logger?: LoggerPort) {}

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

  /**
   * shutdown猶予（`AGENTCONTEXT_SHUTDOWN_GRACE_MS`）。新規enqueueとキュー消化を止めたうえで、
   * **実行中のジョブだけ**は最大 `graceMs` 待ってから abort する。
   *
   * `shutdown()` との違いは待つかどうかだけ。**キューはメモリ内**なので abort された実験の途中経過は
   * 失われる（次の起動で `RecoverInterruptedRunsUseCase` が `interrupted` へ確定させ、resume で
   * 最初から流し直せる）。途中経過を捨てたくないので、待てる分は待つのが今できる最善である。
   * 未実行のキューは `shutdown()` と同様に捨てる（`queued` のまま残るので次の起動で再投入される）。
   *
   * 戻り値は **猶予内に実行中ジョブが終わったか**。呼び出し側はこれをログに出して
   * 「猶予が足りていないのか」を運用者が判断できるようにする。
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
        // RunExperiment persists terminal failure; worker keeps processing the queue.
        // ここまで漏れる例外は保存経路の破損を意味する。無音だと「キューは回っているのに
        // 実験が1件も進まない」状態が見えない。握り潰す方針は保ったままログへ残す。
        catch (error) { logSwallowed(this.logger, 'experiment ended with an unhandled error', error, { experimentId: item.id }); }
        // 実行中が空になった合図は drainInFlight の待ち合わせに使う（待っていなければ no-op）。
        finally { this.active.delete(item.key); this.known.delete(item.key); if (this.active.size === 0) this.idle.release(); }
      }
    } finally { this.draining = false; }
  }
}

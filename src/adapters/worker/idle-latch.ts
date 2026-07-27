/**
 * adapter層: 「実行中の仕事が無くなるまで、ただし最大 N ミリ秒だけ待つ」ための小さな同期プリミティブ。
 *
 * ## なぜ必要か
 *
 * shutdown で in-process ワーカーを止めるとき、以前は実行中のジョブを**即 abort** していた。
 * ジョブの永続化・再起動復旧はまだ無いため、abort されたジョブは失敗として記録されるだけで
 * 再開されない。`Ctrl+C` が「進行中の実行を捨てる」操作になっていた。
 *
 * そこで「新規受付を止めたうえで、実行中の分だけは猶予つきで待つ」を挟む。
 * `InProcessExperimentWorker` と `InProcessFactoryWorker` は独立した実装だが
 * この待ち合わせだけは同一の規律にしたいので、ここへ切り出して1箇所で検証する。
 *
 * ## 使い方
 *
 * - ジョブが1件も無くなった時点で `release()` を呼ぶ（待っている `settle()` を起こす）。
 * - 止めたい側は `settle(idle, graceMs)` を待つ。`idle` は呼び出し時点で暇かどうか。
 */
export class IdleLatch {
  /** `settle()` が積んだ「暇になったら呼んでくれ」のコールバック。 */
  private waiters: Array<() => void> = [];

  /**
   * 実行中の仕事が無くなったことを通知する。待っている `settle()` を全て `true` で解決する。
   * 誰も待っていなければ何もしない（状態は持たない = 次の `settle()` は改めて `idle` を見る）。
   */
  release(): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * 暇になるまで待つ。戻り値は **猶予内に暇になったか**（`false` なら呼び出し側が強制停止する）。
   *
   * - `idle` が既に true なら即 `true`。
   * - `graceMs <= 0` は「待たない」を意味し、即 `false`（`AGENTCONTEXT_SHUTDOWN_GRACE_MS=0` = 従来の即 abort）。
   *
   * タイマーは `unref()` する。ここはプロセス終了経路であり、待ち合わせ用のタイマーが
   * event loop を生かして終了を遅らせてはならない（待ちたいのはジョブであってタイマーではない）。
   */
  settle(idle: boolean, graceMs: number): Promise<boolean> {
    if (idle) return Promise.resolve(true);
    if (graceMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { resolve(false); }, graceMs);
      timer.unref();
      // 猶予切れ後に release() されても、解決済み Promise への resolve は無害な no-op。
      this.waiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }
}

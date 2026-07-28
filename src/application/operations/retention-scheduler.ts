/**
 * application層: retentionの定期実行 `RetentionScheduler`。
 *
 * ## なぜ必要か
 *
 * `RetentionUseCase.apply()` の本番の呼び出し元は HTTP ルート `POST /operations/retention/apply` だけで、
 * しかもUIにそれを叩くボタンが無かった。つまり**保持期限は設定できるが一度も実行されない**状態で、
 * `runs` テーブルは無制限に増え続けていた。ここで「時間が来たら勝手に走る」経路を用意する。
 *
 * ## 初回を1インターバル後にする理由
 *
 * 起動直後には走らせない。retentionは数万行のUPDATE/DELETEになり得るのに対し、開発中は
 * サーバーの再起動が何度も起きる。「起動のたびに重い削除が走る」と、再起動が遅くなるうえ
 * DBロックが起動直後のリクエストとぶつかる。保持期限は日単位なので、初回が最大1日遅れても
 * 実害は無い。すぐ流したい運用者には既存の `POST /operations/retention/apply` がある。
 *
 * ## タイマーの扱い
 *
 * `unref()` してイベントループを掴まない。retentionタイマーだけが理由でプロセスが終われなくなるのは
 * `Ctrl+C` の体験として最悪であり、掃除は次回起動時にやり直せばよい。
 */
import type { TenantScope } from '../../domain/tool/ids';
import { describeError, type LoggerPort } from './logger';
import type { RetentionSweepResult, RetentionUseCase } from './retention';

export interface RetentionSchedulerOptions {
  /** 実行間隔（ミリ秒）。`0` 以下で無効（タイマーを登録しない）。 */
  readonly intervalMs: number;
  /** Runがまだ1件も無いスコープも掃除対象に含めたいときに渡す（通常は起動スコープ1つ）。 */
  readonly scopes?: readonly TenantScope[];
  readonly logger?: LoggerPort;
}

export class RetentionScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 実行中の掃除。前回が終わる前に次のインターバルが来ても二重に走らせない。 */
  private inFlight: Promise<RetentionSweepResult | undefined> | undefined;

  constructor(private readonly retention: RetentionUseCase, private readonly options: RetentionSchedulerOptions) {}

  /** タイマーが動いているか（テストとログの確認用）。 */
  get running(): boolean { return this.timer !== undefined; }

  /**
   * 定期実行を登録する。戻り値は「登録したか」（`intervalMs <= 0` は無効化なので false）。
   * 二重に呼んでもタイマーは増えない。
   */
  start(): boolean {
    if (this.options.intervalMs <= 0) return false;
    if (this.timer !== undefined) return true;
    const timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs);
    // Node の Timeout だけが持つ API。テスト環境などで欠けていても動作は変わらない。
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
    return true;
  }

  /** shutdown で呼ぶ。登録していなければ何もしない（冪等）。 */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 1回分の掃除。**例外を外へ出さない**（`setInterval` のコールバックで throw すると
   * unhandled rejection になり、以後の実行も止まりかねない）。失敗は次回へ持ち越す。
   */
  async sweep(): Promise<RetentionSweepResult | undefined> {
    // 前回がまだ終わっていないなら相乗りする。間隔より掃除が長引いたときに
    // 同じ行を2つの掃除が同時に触りに行く（SQLiteのロック競合を自作する）のを避ける。
    if (this.inFlight !== undefined) return this.inFlight;
    const running = this.runSweep();
    this.inFlight = running;
    try { return await running; }
    finally { this.inFlight = undefined; }
  }

  private async runSweep(): Promise<RetentionSweepResult | undefined> {
    try {
      const result = await this.retention.applyAll(this.options.scopes ?? []);
      this.options.logger?.info('retention sweep completed', { ...result });
      return result;
    } catch (error) {
      this.options.logger?.error('retention sweep failed', { reason: describeError(error) });
      return undefined;
    }
  }
}

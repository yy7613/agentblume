/**
 * application層: Agent Factory 実行の中断（`AbortSignal`）を `FactoryAbortedError` へ写す小さなヘルパ。
 *
 * ロール呼び出し（`ModelProviderPort.complete(request, signal)`）はモデルadapter側で中断されるが、
 * 「中断後に次のロールを呼ばない」「修復ループの catch が中断を再試行へ丸めない」ためには、
 * 各ステップの合間で明示的に確認して専用の例外で抜ける必要がある（`run-harness.ts` の `throwIfAborted`
 * と同じ規律）。signal の `reason` が既に `FactoryAbortedError` ならそれを投げ直し、worker が付けた
 * 「利用者の cancel / shutdown」の区別を失わない。
 */
import { FactoryAbortedError } from '../../domain/factory/errors';

/** 利用者の cancel で Run に残す理由（`CancelFactoryRunUseCase` の `run_cancelled` イベントと同じ文言）。 */
export const USER_CANCEL_MESSAGE = 'Cancelled by user';
/** worker の shutdown（猶予切れ）で中断された Run に残す理由。利用者の cancel と区別できるようにする。 */
export const SHUTDOWN_ABORT_MESSAGE = 'Aborted by worker shutdown';

/** signal が abort 済みなら `FactoryAbortedError` を投げる。長いステップの合間・await の直後に置く。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw toFactoryAbortedError(signal.reason);
}

/** abort の `reason` を `FactoryAbortedError` へ正規化する（既にそうならそのまま返す）。 */
export function toFactoryAbortedError(reason: unknown): FactoryAbortedError {
  if (reason instanceof FactoryAbortedError) return reason;
  return new FactoryAbortedError('Factory run aborted');
}

/**
 * 中断された Run に残す理由文。worker が理由付きで abort していればそれを使い、理由の無い abort は
 * 「利用者の cancel ではない = このプロセスが止まる側の都合」として shutdown 扱いにする。
 */
export function describeAbort(signal: AbortSignal): string {
  return signal.reason instanceof FactoryAbortedError ? signal.reason.message : SHUTDOWN_ABORT_MESSAGE;
}

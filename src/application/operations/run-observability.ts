import type { OperationsRepository } from '../../domain/operations/operations-repository';
import type { RunEstimatedCost, RunModelSnapshot, RunRecord, RunUsage } from '../../domain/run/run';
import { logSwallowed, type LoggerPort } from './logger';
import type { PricingPort } from './pricing';

/**
 * 推定コストを計算する。価格表が引けなくてもRunは成功のまま残す（コストは付加情報）。
 * 握り潰す方針は変えないが、`logger` があれば理由を1行残す（価格表の設定ミスは無音だと気づけない）。
 */
export async function estimateRunCost(pricing: PricingPort | undefined, model: RunModelSnapshot | undefined, usage: RunUsage, at: string, logger?: LoggerPort): Promise<RunEstimatedCost | undefined> {
  if (pricing === undefined || model === undefined || (usage.promptTokens === undefined && usage.completionTokens === undefined)) return undefined;
  try {
    const price = await pricing.findPrice(model.provider, model.model, at);
    if (price === null) return undefined;
    const amount = ((usage.promptTokens ?? 0) * price.inputPerMillionTokens + (usage.completionTokens ?? 0) * price.outputPerMillionTokens) / 1_000_000;
    return {
      kind: 'estimated', amount: Number(amount.toFixed(12)), currency: price.currency,
      price: { currency: price.currency, inputPerMillionTokens: price.inputPerMillionTokens, outputPerMillionTokens: price.outputPerMillionTokens, effectiveAt: price.effectiveAt },
    };
  } catch (error) {
    logSwallowed(logger, 'run cost estimation failed', error, { provider: model.provider, model: model.model });
    return undefined;
  }
}

/** 日次集計へ1件積む。保存が失敗してもAgent実行は成功のまま返す（集計は業務の前提ではない）。 */
export async function recordRunMetricSafely(repository: OperationsRepository | undefined, run: RunRecord, logger?: LoggerPort): Promise<void> {
  if (repository === undefined || run.status === 'running' || run.latency === undefined) return;
  try {
    await repository.recordRunMetric({
      scope: run.scope, recordedAt: run.completedAt ?? run.startedAt, status: run.status,
      ...(run.purpose !== undefined ? { purpose: run.purpose } : {}), latencyMs: run.latency.totalMs,
      ...(run.usage?.totalTokens !== undefined ? { totalTokens: run.usage.totalTokens } : {}),
      ...(run.estimatedCost !== undefined ? { estimatedCost: run.estimatedCost.amount } : {}),
    });
  } catch (error) {
    // metrics storage must not fail Agent execution — だが無音にもしない（集計が欠けたことは残す）。
    logSwallowed(logger, 'run metric was not recorded', error, { runId: run.runId });
  }
}

import type { OperationsRepository } from '../../domain/operations/operations-repository';
import type { RunEstimatedCost, RunModelSnapshot, RunRecord, RunUsage } from '../../domain/run/run';
import type { PricingPort } from './pricing';

export async function estimateRunCost(pricing: PricingPort | undefined, model: RunModelSnapshot | undefined, usage: RunUsage, at: string): Promise<RunEstimatedCost | undefined> {
  if (pricing === undefined || model === undefined || (usage.promptTokens === undefined && usage.completionTokens === undefined)) return undefined;
  try {
    const price = await pricing.findPrice(model.provider, model.model, at);
    if (price === null) return undefined;
    const amount = ((usage.promptTokens ?? 0) * price.inputPerMillionTokens + (usage.completionTokens ?? 0) * price.outputPerMillionTokens) / 1_000_000;
    return {
      kind: 'estimated', amount: Number(amount.toFixed(12)), currency: price.currency,
      price: { currency: price.currency, inputPerMillionTokens: price.inputPerMillionTokens, outputPerMillionTokens: price.outputPerMillionTokens, effectiveAt: price.effectiveAt },
    };
  } catch {
    return undefined;
  }
}

export async function recordRunMetricSafely(repository: OperationsRepository | undefined, run: RunRecord): Promise<void> {
  if (repository === undefined || run.status === 'running' || run.latency === undefined) return;
  try {
    await repository.recordRunMetric({
      scope: run.scope, recordedAt: run.completedAt ?? run.startedAt, status: run.status,
      ...(run.purpose !== undefined ? { purpose: run.purpose } : {}), latencyMs: run.latency.totalMs,
      ...(run.usage?.totalTokens !== undefined ? { totalTokens: run.usage.totalTokens } : {}),
      ...(run.estimatedCost !== undefined ? { estimatedCost: run.estimatedCost.amount } : {}),
    });
  } catch { /* metrics storage must not fail Agent execution */ }
}


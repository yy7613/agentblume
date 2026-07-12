import { z } from 'zod';
import type { OperationsDailyMetric, RetentionPolicy, RunFeedback } from './operations';

const scopeSchema = z.object({ tenantId: z.string().min(1), workspaceId: z.string().min(1) });
const feedbackSchema = z.object({
  id: z.string().min(1), scope: scopeSchema, runId: z.string().min(1),
  agent: z.object({ internalId: z.string().min(1), version: z.string().min(1) }),
  thumb: z.enum(['up', 'down']), rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().min(1).max(2000).optional(), issueTags: z.array(z.string().min(1).max(50)).max(10),
  createdAt: z.string().min(1), updatedAt: z.string().min(1),
});
const metricSchema = z.object({
  scope: scopeSchema, bucketStart: z.string().min(1), runCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(), latencySamples: z.array(z.number().nonnegative()),
  totalTokens: z.number().int().nonnegative(), estimatedCost: z.number().nonnegative(),
  pricedRunCount: z.number().int().nonnegative(), feedbackCount: z.number().int().nonnegative(),
});
const retentionSchema = z.object({
  scope: scopeSchema, payloadDays: z.number().int().min(0).max(3650), traceDays: z.number().int().min(0).max(3650),
  aggregateDays: z.number().int().min(0).max(3650), updatedAt: z.string().min(1),
});

export const serializeFeedback = (value: RunFeedback): RunFeedback => structuredClone(feedbackSchema.parse(value)) as RunFeedback;
export const deserializeFeedback = (value: unknown): RunFeedback => structuredClone(feedbackSchema.parse(value)) as RunFeedback;
export const serializeDailyMetric = (value: OperationsDailyMetric): OperationsDailyMetric => structuredClone(metricSchema.parse(value)) as OperationsDailyMetric;
export const deserializeDailyMetric = (value: unknown): OperationsDailyMetric => structuredClone(metricSchema.parse(value)) as OperationsDailyMetric;
export const serializeRetentionPolicy = (value: RetentionPolicy): RetentionPolicy => structuredClone(retentionSchema.parse(value)) as RetentionPolicy;
export const deserializeRetentionPolicy = (value: unknown): RetentionPolicy => structuredClone(retentionSchema.parse(value)) as RetentionPolicy;


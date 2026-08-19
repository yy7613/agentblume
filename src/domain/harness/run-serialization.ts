/**
 * ドメイン: HarnessRun 永続化表現の構造検証(ADR-0035 — adapters での生キャスト禁止)
 *
 * 書き込み側は `JSON.stringify(record)` のままであり、ここでは読み込み側だけを検証する。
 * したがってスキーマは「実際に書き込まれる形」に対して寛容でなければならない:
 * optional なフィールドは optional のまま受け、未知フィールドは拒否しない(zod の
 * 既定 strip)。既存の AgentHarness 用 serialization.ts とは対象型が異なるため別ファイル。
 */
import { z } from 'zod';
import { HarnessValidationError } from './errors';
import { HARNESS_EVENT_KINDS, type HarnessRunRecord } from './harness-run';

const conversationMessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const budgetSchema = z.object({ remainingModelRounds: z.number(), remainingToolCalls: z.number(), remainingParticipantRuns: z.number() });
const checkpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('handoff-input'), activeSlotId: z.string(), history: z.array(conversationMessageSchema), budget: budgetSchema, expiresAt: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal('magentic-approval'), managerSlotId: z.string(), selectedSlotId: z.string(), instruction: z.string(), history: z.array(conversationMessageSchema), round: z.number(), stalls: z.number(), resets: z.number(), latest: z.string(), budget: budgetSchema, expiresAt: z.string(), plan: z.string() }),
]);
const eventSchema = z.object({
  sequence: z.number(),
  kind: z.enum(HARNESS_EVENT_KINDS),
  at: z.string(),
  slotId: z.string().optional(),
  childRunId: z.string().optional(),
  message: z.string().optional(),
});
const harnessRunRecordSchema = z.object({
  runId: z.string(),
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  harness: z.object({ internalId: z.string(), version: z.string(), displayName: z.string() }),
  mode: z.enum(['preview', 'test']),
  status: z.enum(['running', 'succeeded', 'failed', 'waiting-input', 'waiting-approval', 'cancelled']),
  message: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  response: z.string().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  checkpoint: checkpointSchema.optional(),
  events: z.array(eventSchema),
});

function parse<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> { const parsed = schema.safeParse(value); if (!parsed.success) throw new HarnessValidationError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`); return parsed.data; }

/** 永続化済み JSON(unknown)を構造検証して HarnessRunRecord へ復元する。不正構造は HarnessValidationError。 */
export function deserializeHarnessRunRecord(value: unknown): HarnessRunRecord {
  return parse(harnessRunRecordSchema, value, 'deserializeHarnessRunRecord');
}

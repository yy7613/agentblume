import { z } from 'zod';
import { SIDE_EFFECTS, type SideEffect } from '../tool/metadata';
import type { RunRecord, RunStatus } from './run';

const nodeOutputSchema = z.object({ nodeId: z.string(), rowCount: z.number().int().nonnegative(), truncated: z.boolean() });
const traceSchema = z.discriminatedUnion('kind', [
  z.object({ sequence: z.number().int().positive(), kind: z.literal('model-request'), step: z.number().int().positive(), toolNames: z.array(z.string()) }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('tool-call'), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('tool-result'), name: z.string(), terminalId: z.string(), nodes: z.array(nodeOutputSchema), outputPreview: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('model-response'), content: z.string() }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('agent_call'), toolName: z.string(), agentRef: z.object({ internalId: z.string(), version: z.string() }), childRunId: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('compaction'), beforeChars: z.number().int().nonnegative(), afterChars: z.number().int().nonnegative() }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('approval-requested'), tool: z.string(), sideEffect: z.enum(SIDE_EFFECTS as [SideEffect, ...SideEffect[]]), prompt: z.string() }),
  // decidedBy は後から足したので任意。既に保存されている Run のトレースには入っていない。
  z.object({ sequence: z.number().int().positive(), kind: z.literal('approval-resolved'), decision: z.enum(['approve', 'reject']), decidedBy: z.string().min(1).optional() }),
  z.object({ sequence: z.number().int().positive(), kind: z.literal('error'), code: z.string(), message: z.string() }),
]);

const checkpointContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), imageUrl: z.string() }),
]);
const checkpointToolCallSchema = z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) });
const checkpointMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.null(), z.array(checkpointContentPartSchema)]),
  toolCalls: z.array(checkpointToolCallSchema).optional(),
  toolCallId: z.string().optional(),
});
const checkpointSchema = z.object({
  kind: z.literal('tool-approval'),
  agentRef: z.object({ internalId: z.string().min(1), version: z.string().min(1) }),
  messages: z.array(checkpointMessageSchema),
  pendingCalls: z.array(checkpointToolCallSchema),
  executedToolRefs: z.array(z.object({ internalId: z.string().min(1), version: z.string().min(1), publishName: z.string().optional() })),
  budget: z.object({ remainingModelRounds: z.number().int(), remainingToolCalls: z.number().int() }),
  step: z.number().int().positive(),
  sessionId: z.string().min(1).optional(),
  expiresAt: z.string().min(1),
  prompt: z.string(),
});

const runSchema = z.object({
  runId: z.string().min(1),
  scope: z.object({ tenantId: z.string().min(1), workspaceId: z.string().min(1) }),
  sessionId: z.string().min(1).optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'waiting-approval'] as [RunStatus, ...RunStatus[]]),
  mode: z.enum(['preview', 'test']),
  purpose: z.enum(['interactive', 'scenario', 'evaluation', 'delegation']).optional(),
  model: z.object({ provider: z.string(), model: z.string(), modelConfigHash: z.string() }).optional(),
  tool: z.object({ internalId: z.string().min(1), version: z.string().optional(), publishName: z.string().optional() }).optional(),
  tools: z.array(z.object({ internalId: z.string().min(1), version: z.string().optional(), publishName: z.string().optional() })).optional(),
  agent: z.object({ internalId: z.string().min(1), version: z.string().optional(), publishName: z.string().optional() }).optional(),
  startedAt: z.string().min(1), completedAt: z.string().min(1).optional(), response: z.string().optional(),
  structuredResponse: z.record(z.string(), z.unknown()).optional(),
  trace: z.array(traceSchema),
  usage: z.object({ promptTokens: z.number().int().nonnegative().optional(), completionTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).optional(),
  latency: z.object({ totalMs: z.number().nonnegative(), modelMs: z.number().nonnegative(), toolMs: z.number().nonnegative() }).optional(),
  estimatedCost: z.object({
    kind: z.literal('estimated'), amount: z.number().nonnegative(), currency: z.literal('USD'),
    price: z.object({ currency: z.literal('USD'), inputPerMillionTokens: z.number().nonnegative(), outputPerMillionTokens: z.number().nonnegative(), effectiveAt: z.string().min(1) }),
  }).optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  checkpoint: checkpointSchema.optional(),
}).refine((record) => record.tool !== undefined || record.agent !== undefined, {
  message: 'run requires a tool or agent reference',
}).refine((record) => record.status === 'waiting-approval' || record.checkpoint === undefined, {
  message: 'only a waiting-approval run may carry a checkpoint',
});

export function serializeRun(record: RunRecord): RunRecord {
  return structuredClone(runSchema.parse(record)) as RunRecord;
}
export function deserializeRun(value: unknown): RunRecord {
  return structuredClone(runSchema.parse(value)) as RunRecord;
}

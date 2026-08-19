/**
 * ドメイン: Session 永続化表現の構造検証(ADR-0035 — adapters での生キャスト禁止)
 *
 * リポジトリが record_json を読み戻すときの入口。zod で構造を検証してから
 * ドメイン型として返す。スキーマは寛容に保つ:
 * - optional なフィールドは optional のまま受け付ける
 * - 未知のフィールドはエラーにしない(z.object の既定どおり読み飛ばす)
 * 書き込み側は JSON.stringify のままなので、保存済みの正当な行は必ず読める。
 */
import { z } from 'zod';
import type { AgentSession } from './agent-session';
import { SESSION_ARTIFACT_KINDS, createSessionArtifact, type SessionArtifact } from './session-artifact';
import { SessionDomainError } from './errors';

const tenantScopeSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });

const agentSessionSchema = z.object({
  id: z.string(),
  scope: tenantScopeSchema,
  rootAgent: z.object({ internalId: z.string(), version: z.string() }),
  status: z.enum(['active', 'closed', 'expired']),
  createdAt: z.string(),
  lastAccessedAt: z.string(),
  expiresAt: z.string(),
  quota: z.object({ maxBytes: z.number(), maxArtifactBytes: z.number(), maxArtifacts: z.number() }),
  closedAt: z.string().optional(),
});

const dataSchemaSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.enum(['string', 'number', 'boolean', 'date', 'null', 'unknown']), nullable: z.boolean() })),
});

const sessionArtifactSchema = z.object({
  id: z.string(),
  scope: tenantScopeSchema,
  sessionId: z.string(),
  name: z.string(),
  kind: z.enum(SESSION_ARTIFACT_KINDS),
  revision: z.number(),
  contentType: z.string(),
  schema: dataSchemaSchema.optional(),
  sizeBytes: z.number(),
  checksum: z.string(),
  counts: z.object({ rows: z.number().optional(), nodes: z.number().optional(), edges: z.number().optional() }).optional(),
  origin: z.object({ runId: z.string(), toolId: z.string(), toolVersion: z.string(), toolCallId: z.string(), sinkNodeId: z.string(), agentId: z.string().optional() }),
  createdAt: z.string(),
  expiresAt: z.string(),
});

function parse<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> { const parsed = schema.safeParse(value); if (!parsed.success) throw new SessionDomainError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`); return parsed.data; }

/** record_json から AgentSession を復元する。構造不正は SessionDomainError。 */
export function deserializeAgentSession(value: unknown): AgentSession {
  return parse(agentSessionSchema, value, 'deserializeAgentSession');
}

/** record_json から SessionArtifact を復元する。構造検証の後にドメイン不変条件も通す。 */
export function deserializeSessionArtifact(value: unknown): SessionArtifact {
  return createSessionArtifact(parse(sessionArtifactSchema, value, 'deserializeSessionArtifact'));
}

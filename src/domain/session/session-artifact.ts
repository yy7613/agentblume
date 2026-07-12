import type { Schema } from '../data/types';
import type { TenantScope } from '../tool/ids';
import { SessionDomainError } from './errors';

export const SESSION_ARTIFACT_KINDS = ['table', 'json', 'chart', 'graph', 'blob'] as const;
export type SessionArtifactKind = (typeof SESSION_ARTIFACT_KINDS)[number];

export interface SessionArtifact {
  readonly id: string;
  readonly scope: TenantScope;
  readonly sessionId: string;
  readonly name: string;
  readonly kind: SessionArtifactKind;
  readonly revision: number;
  readonly contentType: string;
  readonly schema?: Schema;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly counts?: { readonly rows?: number; readonly nodes?: number; readonly edges?: number };
  readonly origin: { readonly runId: string; readonly toolId: string; readonly toolVersion: string; readonly toolCallId: string; readonly sinkNodeId: string; readonly agentId?: string };
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SessionArtifactDescriptor extends Omit<SessionArtifact, 'scope' | 'origin'> {
  readonly preview?: unknown;
}

export function createSessionArtifact(value: SessionArtifact): SessionArtifact {
  if (value.id.trim() === '' || value.sessionId.trim() === '' || value.name.trim() === '' || value.contentType.trim() === '' || value.checksum.trim() === '') throw new SessionDomainError('artifact id, sessionId, name, contentType and checksum are required');
  if (!SESSION_ARTIFACT_KINDS.includes(value.kind)) throw new SessionDomainError(`invalid artifact kind: ${value.kind}`);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new SessionDomainError('artifact revision must be positive');
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) throw new SessionDomainError('artifact sizeBytes must be non-negative');
  if (value.expiresAt <= value.createdAt) throw new SessionDomainError('artifact expiresAt must be after createdAt');
  return structuredClone(value);
}

export function toArtifactDescriptor(artifact: SessionArtifact, preview?: unknown): SessionArtifactDescriptor {
  const { scope: _scope, origin: _origin, ...descriptor } = structuredClone(artifact);
  return { ...descriptor, ...(preview === undefined ? {} : { preview }) };
}

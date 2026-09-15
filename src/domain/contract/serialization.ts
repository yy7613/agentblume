/**
 * ドメイン: 契約 BC の直列化。
 *
 * 仕訳と同じく「Serialized 型 = domain 型、復元は必ず `create*` を通す、壊れた行は `ContractDomainError` で失敗させる」。
 * zod は**形**（トップレベルの型と必須キー）だけを見て、値の不変条件は `create*` が検証する。
 */
import { z } from 'zod';
import { createContractDocument, type ContractDocument } from './document';
import { ContractDomainError } from './errors';
import { createPlaybook, type Playbook } from './playbook';
import { createContractReview, type ContractReview } from './review';
import { createSignedContract, type SignedContract } from './signed-contract';

export type SerializedPlaybook = Playbook;
export type SerializedContractDocument = ContractDocument;
export type SerializedContractReview = ContractReview;
export type SerializedSignedContract = SignedContract;

const tenantSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });

const playbookSchema = z.object({
  tenant: tenantSchema, id: z.string(), name: z.string(), isDefault: z.boolean(), ourRole: z.string(), ourCompanyNames: z.array(z.string()),
  topics: z.array(z.record(z.string(), z.unknown())), criteria: z.array(z.record(z.string(), z.unknown())),
  legal: z.record(z.string(), z.unknown()), stampDuty: z.record(z.string(), z.unknown()), extraction: z.record(z.string(), z.unknown()),
  templateId: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});

const documentSchema = z.object({
  tenant: tenantSchema, id: z.string(), title: z.string(), source: z.record(z.string(), z.unknown()), body: z.string(),
  pages: z.array(z.record(z.string(), z.unknown())), articles: z.array(z.record(z.string(), z.unknown())), parties: z.record(z.string(), z.unknown()),
  ourParty: z.string().optional(), ourRole: z.string().optional(), counterpartyProfile: z.record(z.string(), z.unknown()),
  contractNature: z.record(z.string(), z.unknown()).optional(), contractAmount: z.number().optional(), signingDateText: z.string().optional(),
  extraction: z.record(z.string(), z.unknown()).optional(), clauses: z.array(z.record(z.string(), z.unknown())), status: z.string(),
  reviewId: z.string().optional(), signedContractId: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});

const reviewSchema = z.object({
  tenant: tenantSchema, id: z.string(), documentId: z.string(), playbookId: z.string(), playbookName: z.string(),
  playbookSnapshot: z.record(z.string(), z.unknown()), playbookSnapshotAt: z.string(), clausesFingerprint: z.string(),
  results: z.array(z.record(z.string(), z.unknown())), documentFindings: z.array(z.record(z.string(), z.unknown())), overall: z.string(),
  status: z.string(), stale: z.boolean(), llmCache: z.array(z.record(z.string(), z.unknown())),
  model: z.object({ provider: z.string(), model: z.string() }).optional(), finalizedAt: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});

const signedSchema = z.object({
  tenant: tenantSchema, id: z.string(), documentId: z.string(), reviewId: z.string().optional(), title: z.string(), counterpartyName: z.string(),
  signedDate: z.string(), signingMethod: z.string(), ourParty: z.string().optional(), clauses: z.array(z.record(z.string(), z.unknown())),
  stampDuty: z.record(z.string(), z.unknown()).optional(), deadlines: z.array(z.record(z.string(), z.unknown())), status: z.string(),
  terminatedAt: z.string().optional(), terminationReason: z.string().optional(), reviewVerdicts: z.record(z.string(), z.string()),
  warnings: z.array(z.record(z.string(), z.unknown())), createdAt: z.string(), updatedAt: z.string(),
});

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ContractDomainError(`${label}: invalid record: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function serializePlaybook(playbook: Playbook): SerializedPlaybook { return structuredClone(playbook); }
export function deserializePlaybook(value: unknown): Playbook {
  return createPlaybook(stripUndefined(parseOrThrow(playbookSchema, value, 'deserializePlaybook')) as unknown as Playbook);
}

export function serializeContractDocument(document: ContractDocument): SerializedContractDocument { return structuredClone(document); }
export function deserializeContractDocument(value: unknown): ContractDocument {
  return createContractDocument(stripUndefined(parseOrThrow(documentSchema, value, 'deserializeContractDocument')) as unknown as ContractDocument);
}

export function serializeContractReview(review: ContractReview): SerializedContractReview { return structuredClone(review); }
export function deserializeContractReview(value: unknown): ContractReview {
  return createContractReview(stripUndefined(parseOrThrow(reviewSchema, value, 'deserializeContractReview')) as unknown as ContractReview);
}

export function serializeSignedContract(contract: SignedContract): SerializedSignedContract { return structuredClone(contract); }
export function deserializeSignedContract(value: unknown): SignedContract {
  return createSignedContract(stripUndefined(parseOrThrow(signedSchema, value, 'deserializeSignedContract')) as unknown as SignedContract);
}

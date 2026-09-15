/**
 * ui/api層: 契約書レビューと期限台帳（docs/23-contract.md §6）の API クライアント（ADR-0039）。
 *
 * パスは `/contracts/*`。scope は GET / DELETE ではクエリ（`scopeQuery`）、それ以外は JSON 本文に載せる
 * （サーバーは Principal から決めるので読まれないが、他の画面と同じ規約に揃える）。
 * 文字起こし・抽出・レビューはモデルを回すので遅い。`signal` を受けて中断できるようにする。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  ClauseDto, ContractCapabilitiesDto, ContractDocumentDto, ContractDocumentStatusDto, ContractDocumentSummaryDto,
  ContractNatureDto, ContractWarningDto, DeadlinePreviewDto, HumanDecisionDto, ImportContractDocumentDto, LedgerDto, LedgerQueryDto, PartyKeyDto,
  PlaybookDto, PlaybookSummaryDto, PlaybookTemplateDto, RegisterSignedContractDto, ReviewEnvelopeDto, SavePlaybookDto, SignedClauseDto,
  SignedContractDto, SignedContractStatusDto, SigningMethodDto, TranscribeResultDto,
} from './contract-types';
import type { TenantScopeDto } from './types';

/** 旧サーバー（`contract` キー無し）や取得失敗は「使えない」として扱う。 */
export const CONTRACT_CAPABILITIES_DISABLED_DTO: ContractCapabilitiesDto = { extraction: { enabled: false, vision: false }, review: { llm: false } };

export interface ContractApi {
  capabilities(signal?: AbortSignal): Promise<ContractCapabilitiesDto>;
  listPlaybooks(scope: TenantScopeDto): Promise<{ readonly playbooks: readonly PlaybookSummaryDto[]; readonly unsaved: boolean }>;
  getPlaybook(scope: TenantScopeDto, id: string): Promise<{ readonly playbook: PlaybookDto; readonly unsaved: boolean }>;
  savePlaybook(scope: TenantScopeDto, playbook: SavePlaybookDto): Promise<PlaybookDto>;
  deletePlaybook(scope: TenantScopeDto, id: string): Promise<void>;
  listTemplates(scope: TenantScopeDto): Promise<readonly PlaybookTemplateDto[]>;
  createPlaybookFromTemplate(scope: TenantScopeDto, input: { readonly templateId: string; readonly name?: string; readonly isDefault?: boolean; readonly ourCompanyNames?: readonly string[] }): Promise<PlaybookDto>;
  listDocuments(scope: TenantScopeDto, options?: { readonly status?: ContractDocumentStatusDto; readonly limit?: number }): Promise<readonly ContractDocumentSummaryDto[]>;
  importDocument(scope: TenantScopeDto, input: ImportContractDocumentDto): Promise<{ readonly document: ContractDocumentDto; readonly warnings: readonly string[] }>;
  getDocument(scope: TenantScopeDto, id: string): Promise<ContractDocumentDto>;
  updateDocument(scope: TenantScopeDto, id: string, input: ImportContractDocumentDto): Promise<ContractDocumentDto>;
  deleteDocument(scope: TenantScopeDto, id: string): Promise<void>;
  transcribe(scope: TenantScopeDto, images: readonly string[], fileName?: string, signal?: AbortSignal): Promise<TranscribeResultDto>;
  extract(scope: TenantScopeDto, id: string, options?: { readonly scanAllArticles?: boolean; readonly articleRefs?: readonly string[]; readonly playbookId?: string }, signal?: AbortSignal): Promise<ContractDocumentDto>;
  confirmClauses(scope: TenantScopeDto, id: string, input: { readonly clauses: readonly ClauseDto[]; readonly ourParty?: PartyKeyDto; readonly contractNature?: ContractNatureDto; readonly playbookId?: string }): Promise<ContractDocumentDto>;
  runReview(scope: TenantScopeDto, documentId: string, playbookId?: string, signal?: AbortSignal): Promise<ReviewEnvelopeDto>;
  getReview(scope: TenantScopeDto, id: string): Promise<ReviewEnvelopeDto>;
  saveDecisions(scope: TenantScopeDto, id: string, decisions: readonly { readonly topicId: string; readonly decision?: HumanDecisionDto | null; readonly note?: string | null }[]): Promise<ReviewEnvelopeDto>;
  finalizeReview(scope: TenantScopeDto, id: string): Promise<ReviewEnvelopeDto>;
  previewDeadlines(scope: TenantScopeDto, input: { readonly documentId: string; readonly signedDate?: string; readonly signingMethod?: SigningMethodDto; readonly contractAmount?: number }): Promise<DeadlinePreviewDto>;
  registerSigned(scope: TenantScopeDto, input: RegisterSignedContractDto): Promise<{ readonly contract: SignedContractDto; readonly warnings: readonly ContractWarningDto[] }>;
  listSigned(scope: TenantScopeDto, options?: { readonly status?: SignedContractStatusDto; readonly counterparty?: string }): Promise<readonly SignedContractDto[]>;
  getSigned(scope: TenantScopeDto, id: string): Promise<SignedContractDto>;
  updateSigned(scope: TenantScopeDto, id: string, input: { readonly clauses?: readonly SignedClauseDto[]; readonly customDeadlines?: readonly { readonly id?: string; readonly dueDate: string; readonly basis: string; readonly note?: string }[]; readonly title?: string; readonly counterpartyName?: string }): Promise<SignedContractDto>;
  deleteSigned(scope: TenantScopeDto, id: string): Promise<void>;
  terminateSigned(scope: TenantScopeDto, id: string, terminatedAt: string, reason?: string): Promise<SignedContractDto>;
  listDeadlines(scope: TenantScopeDto, query?: LedgerQueryDto): Promise<LedgerDto>;
  completeDeadline(scope: TenantScopeDto, contractId: string, deadlineId: string, note?: string): Promise<SignedContractDto>;
}

const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({ method, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
const id = (value: string) => encodeURIComponent(value);

export function contractApi(transport: ApiTransport): ContractApi {
  return {
    async capabilities(signal) {
      const result = await transport.request<{ readonly contract?: ContractCapabilitiesDto }>('/runtime/capabilities', signal === undefined ? {} : { signal });
      return result.contract ?? CONTRACT_CAPABILITIES_DISABLED_DTO;
    },
    listPlaybooks: (scope) => transport.request(`/contracts/playbooks?${scopeQuery(scope)}`),
    getPlaybook: (scope, playbookId) => transport.request(`/contracts/playbooks/${id(playbookId)}?${scopeQuery(scope)}`),
    savePlaybook: async (scope, playbook) => (await transport.request<{ playbook: PlaybookDto }>('/contracts/playbooks', json('POST', { scope, ...playbook }))).playbook,
    deletePlaybook: async (scope, playbookId) => { await transport.request(`/contracts/playbooks/${id(playbookId)}?${scopeQuery(scope)}`, { method: 'DELETE' }); },
    listTemplates: async (scope) => (await transport.request<{ templates: readonly PlaybookTemplateDto[] }>(`/contracts/playbook-templates?${scopeQuery(scope)}`)).templates,
    createPlaybookFromTemplate: async (scope, input) => (await transport.request<{ playbook: PlaybookDto }>('/contracts/playbooks/from-template', json('POST', { scope, ...input }))).playbook,
    listDocuments: async (scope, options = {}) => {
      const query = scopeQuery(scope);
      if (options.status !== undefined) query.set('status', options.status);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      return (await transport.request<{ documents: readonly ContractDocumentSummaryDto[] }>(`/contracts/documents?${query}`)).documents;
    },
    importDocument: (scope, input) => transport.request('/contracts/documents', json('POST', { scope, ...input })),
    getDocument: async (scope, documentId) => (await transport.request<{ document: ContractDocumentDto }>(`/contracts/documents/${id(documentId)}?${scopeQuery(scope)}`)).document,
    updateDocument: async (scope, documentId, input) => (await transport.request<{ document: ContractDocumentDto }>(`/contracts/documents/${id(documentId)}`, json('PUT', { scope, ...input }))).document,
    deleteDocument: async (scope, documentId) => { await transport.request(`/contracts/documents/${id(documentId)}?${scopeQuery(scope)}`, { method: 'DELETE' }); },
    transcribe: async (scope, images, fileName, signal) => (await transport.request<{ result: TranscribeResultDto }>('/contracts/documents/transcribe', json('POST', { scope, images, ...(fileName === undefined ? {} : { fileName }) }, signal))).result,
    extract: async (scope, documentId, options = {}, signal) => (await transport.request<{ document: ContractDocumentDto }>(`/contracts/documents/${id(documentId)}/extract`, json('POST', { scope, ...options }, signal))).document,
    confirmClauses: async (scope, documentId, input) => (await transport.request<{ document: ContractDocumentDto }>(`/contracts/documents/${id(documentId)}/clauses`, json('PUT', { scope, ...input }))).document,
    runReview: (scope, documentId, playbookId, signal) => transport.request(`/contracts/documents/${id(documentId)}/reviews`, json('POST', { scope, ...(playbookId === undefined ? {} : { playbookId }) }, signal)),
    getReview: (scope, reviewId) => transport.request(`/contracts/reviews/${id(reviewId)}?${scopeQuery(scope)}`),
    saveDecisions: (scope, reviewId, decisions) => transport.request(`/contracts/reviews/${id(reviewId)}/decisions`, json('PUT', { scope, decisions })),
    finalizeReview: (scope, reviewId) => transport.request(`/contracts/reviews/${id(reviewId)}/finalize`, json('POST', { scope })),
    previewDeadlines: async (scope, input) => (await transport.request<{ preview: DeadlinePreviewDto }>('/contracts/deadlines/preview', json('POST', { scope, ...input }))).preview,
    registerSigned: (scope, input) => transport.request('/contracts/signed', json('POST', { scope, ...input })),
    listSigned: async (scope, options = {}) => {
      const query = scopeQuery(scope);
      if (options.status !== undefined) query.set('status', options.status);
      if (options.counterparty !== undefined && options.counterparty !== '') query.set('counterparty', options.counterparty);
      return (await transport.request<{ contracts: readonly SignedContractDto[] }>(`/contracts/signed?${query}`)).contracts;
    },
    getSigned: async (scope, contractId) => (await transport.request<{ contract: SignedContractDto }>(`/contracts/signed/${id(contractId)}?${scopeQuery(scope)}`)).contract,
    updateSigned: async (scope, contractId, input) => (await transport.request<{ contract: SignedContractDto }>(`/contracts/signed/${id(contractId)}`, json('PUT', { scope, ...input }))).contract,
    deleteSigned: async (scope, contractId) => { await transport.request(`/contracts/signed/${id(contractId)}?${scopeQuery(scope)}`, { method: 'DELETE' }); },
    terminateSigned: async (scope, contractId, terminatedAt, reason) => (await transport.request<{ contract: SignedContractDto }>(`/contracts/signed/${id(contractId)}/terminate`, json('POST', { scope, terminatedAt, ...(reason === undefined || reason === '' ? {} : { reason }) }))).contract,
    listDeadlines: async (scope, query = {}) => {
      const params = scopeQuery(scope);
      if (query.withinDays !== undefined) params.set('withinDays', String(query.withinDays));
      if (query.includeOverdue !== undefined) params.set('includeOverdue', String(query.includeOverdue));
      if (query.kind !== undefined) params.set('kind', query.kind);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return (await transport.request<{ ledger: LedgerDto }>(`/contracts/deadlines?${params}`)).ledger;
    },
    completeDeadline: async (scope, contractId, deadlineId, note) => (await transport.request<{ contract: SignedContractDto }>(`/contracts/signed/${id(contractId)}/deadlines/${id(deadlineId)}/complete`, json('POST', { scope, ...(note === undefined || note === '' ? {} : { note }) }))).contract,
  };
}

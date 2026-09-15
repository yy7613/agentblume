/**
 * api層: 契約書レビューと期限台帳のルート（docs/23-contract.md §6）。
 *
 * | ルート | 応答 |
 * |---|---|
 * | GET /contracts/playbooks | 200 { playbooks, unsaved } — 0 件なら既定テンプレートを保存せず返す |
 * | GET /contracts/playbooks/:id | 200 { playbook, unsaved } |
 * | POST /contracts/playbooks | 200 { playbook } — id 省略で新規。既定は 1 つ |
 * | DELETE /contracts/playbooks/:id | 204 |
 * | GET /contracts/playbook-templates | 200 { templates } |
 * | POST /contracts/playbooks/from-template | 200 { playbook } |
 * | GET /contracts/documents | 200 { documents } — **要約**（本文を含まない） |
 * | POST /contracts/documents | 200 { document, warnings } — 条文分割もここで行う |
 * | GET / PUT / DELETE /contracts/documents/:id | 200 { document } / 200 { document } / 204 |
 * | POST /contracts/documents/transcribe | 200 { result } — vision で文字起こし（**保存しない**） |
 * | POST /contracts/documents/:id/extract | 200 { document } — 条項抽出（LLM。結果を保存） |
 * | PUT /contracts/documents/:id/clauses | 200 { document } — 人が確認した条項で確定 |
 * | POST /contracts/documents/:id/reviews | 200 { review, notice } |
 * | GET /contracts/reviews/:id | 200 { review, notice } |
 * | PUT /contracts/reviews/:id/decisions | 200 { review, notice } |
 * | POST /contracts/reviews/:id/finalize | 200 { review, notice } |
 * | POST /contracts/deadlines/preview | 200 { preview } — 保存しない |
 * | POST /contracts/signed | 200 { contract, warnings } |
 * | GET /contracts/signed | 200 { contracts } |
 * | GET / PUT / DELETE /contracts/signed/:id | 200 { contract } / 200 { contract } / 204 |
 * | POST /contracts/signed/:id/terminate | 200 { contract } |
 * | GET /contracts/deadlines | 200 { ledger } — 期限の近い順 |
 * | POST /contracts/signed/:id/deadlines/:deadlineId/complete | 200 { contract } |
 *
 * 文字起こし・抽出・レビューは**モデルを回すので遅い**。利用者は待ちきれずに閉じるので `clientAbortSignal` を通す。
 * レビューの応答には「審査基準との照合であり法的判断ではない」固定文言（`notice`）を必ず添える。
 * 応答の集約は Serialized から `tenant` を除いた形（scope は Principal 由来）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { ContractCapabilities, ContractCapabilitiesUseCase } from '../application/contract/capabilities';
import type { ExtractContractClausesUseCase } from '../application/contract/extract-clauses';
import type {
  ConfirmContractClausesUseCase, DeleteContractDocumentUseCase, DocumentFields, GetContractDocumentUseCase,
  ImportContractDocumentUseCase, ListContractDocumentsUseCase, UpdateContractDocumentUseCase,
} from '../application/contract/manage-documents';
import type {
  CreatePlaybookFromTemplateUseCase, DeleteContractPlaybookUseCase, GetContractPlaybookUseCase, ListContractPlaybooksUseCase,
  ListPlaybookTemplatesUseCase, SaveContractPlaybookUseCase,
} from '../application/contract/manage-playbooks';
import { LEGAL_DISCLAIMER_JA } from '../application/contract/review-draft-rows';
import type { FinalizeContractReviewUseCase, GetContractReviewUseCase, RunContractReviewUseCase, SaveContractReviewDecisionsUseCase } from '../application/contract/run-review';
import type {
  CompleteContractDeadlineUseCase, DeleteSignedContractUseCase, GetSignedContractUseCase, ListContractDeadlinesUseCase, ListSignedContractsUseCase,
  PreviewContractDeadlinesUseCase, RegisterSignedContractUseCase, SignedContractView, TerminateSignedContractUseCase, UpdateSignedContractUseCase,
} from '../application/contract/signed-contracts';
import type { TranscribeContractPagesUseCase } from '../application/contract/transcribe-pages';
import type { Clause, ContractDocument } from '../domain/contract/document';
import type { ClauseTopic, ExtractionSettings, Playbook, PlaybookCriterion } from '../domain/contract/playbook';
import type { LegalSettings } from '../domain/contract/legal-checks';
import type { ContractReview } from '../domain/contract/review';
import type { SignedClause, SignedContract } from '../domain/contract/signed-contract';
import type { StampDutySettings } from '../domain/contract/stamp-duty';
import type { TenantScope } from '../domain/shared/tenant-scope';
import { scopeOf } from './authentication';
import { clientAbortSignal } from './client-abort';
import {
  completeDeadlineBodySchema, confirmClausesBodySchema, contractActionBodySchema, contractScopeQuerySchema, deadlineLedgerQuerySchema,
  deadlinePreviewBodySchema, documentBodySchema, documentListQuerySchema, extractBodySchema, playbookFromTemplateBodySchema,
  registerSignedBodySchema, reviewDecisionsBodySchema, runReviewBodySchema, savePlaybookBodySchema, signedListQuerySchema,
  terminateSignedBodySchema, transcribeBodySchema, updateSignedBodySchema,
} from './contract-schemas';
import { BadRequestError } from './error-mapping';

export interface ContractRouteDeps {
  readonly contractListPlaybooks: ListContractPlaybooksUseCase;
  readonly contractGetPlaybook: GetContractPlaybookUseCase;
  readonly contractSavePlaybook: SaveContractPlaybookUseCase;
  readonly contractDeletePlaybook: DeleteContractPlaybookUseCase;
  readonly contractListTemplates: ListPlaybookTemplatesUseCase;
  readonly contractCreatePlaybookFromTemplate: CreatePlaybookFromTemplateUseCase;
  readonly contractImportDocument: ImportContractDocumentUseCase;
  readonly contractUpdateDocument: UpdateContractDocumentUseCase;
  readonly contractGetDocument: GetContractDocumentUseCase;
  readonly contractListDocuments: ListContractDocumentsUseCase;
  readonly contractDeleteDocument: DeleteContractDocumentUseCase;
  readonly contractTranscribePages: TranscribeContractPagesUseCase;
  readonly contractExtractClauses: ExtractContractClausesUseCase;
  readonly contractConfirmClauses: ConfirmContractClausesUseCase;
  readonly contractRunReview: RunContractReviewUseCase;
  readonly contractGetReview: GetContractReviewUseCase;
  readonly contractSaveDecisions: SaveContractReviewDecisionsUseCase;
  readonly contractFinalizeReview: FinalizeContractReviewUseCase;
  readonly contractPreviewDeadlines: PreviewContractDeadlinesUseCase;
  readonly contractRegisterSigned: RegisterSignedContractUseCase;
  readonly contractListSigned: ListSignedContractsUseCase;
  readonly contractGetSigned: GetSignedContractUseCase;
  readonly contractUpdateSigned: UpdateSignedContractUseCase;
  readonly contractDeleteSigned: DeleteSignedContractUseCase;
  readonly contractTerminateSigned: TerminateSignedContractUseCase;
  readonly contractCompleteDeadline: CompleteContractDeadlineUseCase;
  readonly contractListDeadlines: ListContractDeadlinesUseCase;
}

export interface ContractRuntimeCapabilityDeps {
  /** 文字起こし・条項抽出・LLM 基準の可否（契約画面が取込の選択肢と案内を出し分ける）。 */
  readonly contractCapabilities: ContractCapabilitiesUseCase;
}

/** `GET /runtime/capabilities` へ足すキー（`contract` だけを返す）。 */
export async function contractRuntimeCapabilities(deps: ContractRuntimeCapabilityDeps): Promise<{ readonly contract: ContractCapabilities }> {
  return { contract: await deps.contractCapabilities.execute() };
}

/** 取込の本文上限（本文 300,000 文字 + ページ境界。docs/23 §6）。 */
export const CONTRACT_IMPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

function withoutTenant<T extends { readonly tenant: TenantScope }>(value: T): Omit<T, 'tenant'> {
  const { tenant: _tenant, ...rest } = structuredClone(value);
  return rest;
}

export const contractPlaybookResponse = (playbook: Playbook) => withoutTenant(playbook);
export const contractDocumentResponse = (document: ContractDocument) => withoutTenant(document);
export const contractReviewResponse = (review: ContractReview) => ({ review: withoutTenant(review), notice: LEGAL_DISCLAIMER_JA });
export const signedContractResponse = (contract: SignedContract) => withoutTenant(contract);
const signedViewResponse = (view: SignedContractView) => ({ ...withoutTenant(view.contract), displayStatus: view.displayStatus });

function documentFields(body: z.infer<typeof documentBodySchema>): DocumentFields {
  return {
    title: body.title, body: body.body,
    source: { type: body.source.type, ...(body.source.fileName === undefined ? {} : { fileName: body.source.fileName }), ...(body.source.pageCount === undefined ? {} : { pageCount: body.source.pageCount }), ...(body.source.sha256 === undefined ? {} : { sha256: body.source.sha256 }) },
    ...(body.pages === undefined ? {} : { pages: body.pages }),
    ...(body.parties === undefined ? {} : { parties: { ...(body.parties.A === undefined ? {} : { A: body.parties.A }), ...(body.parties.B === undefined ? {} : { B: body.parties.B }) } }),
    ...(body.ourParty === undefined ? {} : { ourParty: body.ourParty }),
    ...(body.ourRole === undefined ? {} : { ourRole: body.ourRole }),
    ...(body.counterpartyProfile === undefined ? {} : { counterpartyProfile: body.counterpartyProfile }),
    ...(body.contractNature === undefined ? {} : { contractNature: body.contractNature }),
    ...(body.contractAmount === undefined ? {} : { contractAmount: body.contractAmount }),
    ...(body.playbookId === undefined ? {} : { playbookId: body.playbookId }),
  };
}

export function registerContractRoutes(app: FastifyInstance, deps: ContractRouteDeps): void {
  /* 審査基準 ------------------------------------------------------------ */

  app.get('/contracts/playbooks', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    return deps.contractListPlaybooks.execute(scopeOf(request));
  });

  app.get('/contracts/playbook-templates', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    return { templates: deps.contractListTemplates.execute() };
  });

  app.post('/contracts/playbooks/from-template', async (request) => {
    const body = parseWith(playbookFromTemplateBodySchema, request.body, 'invalid body');
    const playbook = await deps.contractCreatePlaybookFromTemplate.execute({
      scope: scopeOf(request), templateId: body.templateId,
      ...(body.name === undefined ? {} : { name: body.name }), ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
      ...(body.ourCompanyNames === undefined ? {} : { ourCompanyNames: body.ourCompanyNames }),
    });
    return { playbook: contractPlaybookResponse(playbook) };
  });

  app.get<{ Params: { id: string } }>('/contracts/playbooks/:id', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    const { playbook, unsaved } = await deps.contractGetPlaybook.execute(scopeOf(request), request.params.id);
    return { playbook: contractPlaybookResponse(playbook), unsaved };
  });

  app.post('/contracts/playbooks', async (request) => {
    const body = parseWith(savePlaybookBodySchema, request.body, 'invalid body');
    const playbook = await deps.contractSavePlaybook.execute({
      scope: scopeOf(request), ...(body.id === undefined ? {} : { id: body.id }),
      name: body.name, isDefault: body.isDefault, ourRole: body.ourRole, ourCompanyNames: body.ourCompanyNames,
      // 入れ子の形と値の不変条件は domain の createPlaybook が検証する（400 は ContractDomainError）。
      topics: body.topics as unknown as readonly ClauseTopic[], criteria: body.criteria as unknown as readonly PlaybookCriterion[],
      legal: body.legal as unknown as LegalSettings, stampDuty: body.stampDuty as unknown as StampDutySettings, extraction: body.extraction as unknown as ExtractionSettings,
      ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
    });
    return { playbook: contractPlaybookResponse(playbook) };
  });

  app.delete<{ Params: { id: string } }>('/contracts/playbooks/:id', async (request, reply) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    await deps.contractDeletePlaybook.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  /* 文書 ---------------------------------------------------------------- */

  app.get('/contracts/documents', async (request) => {
    const query = parseWith(documentListQuerySchema, request.query, 'invalid query');
    const documents = await deps.contractListDocuments.execute(scopeOf(request), { ...(query.status === undefined ? {} : { status: query.status }), ...(query.limit === undefined ? {} : { limit: query.limit }) });
    return { documents };
  });

  // 静的パスを :id より先に登録する（意図を並びでも示す）。
  app.post('/contracts/documents/transcribe', async (request, reply) => {
    const body = parseWith(transcribeBodySchema, request.body, 'invalid body');
    const result = await deps.contractTranscribePages.execute({ images: body.images, ...(body.fileName === undefined ? {} : { fileName: body.fileName }) }, clientAbortSignal(request, reply));
    return { result };
  });

  app.post('/contracts/documents', { bodyLimit: CONTRACT_IMPORT_BODY_LIMIT_BYTES }, async (request) => {
    const body = parseWith(documentBodySchema, request.body, 'invalid body');
    const { document, warnings } = await deps.contractImportDocument.execute({ scope: scopeOf(request), ...documentFields(body) });
    return { document: contractDocumentResponse(document), warnings };
  });

  app.get<{ Params: { id: string } }>('/contracts/documents/:id', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    return { document: contractDocumentResponse(await deps.contractGetDocument.execute(scopeOf(request), request.params.id)) };
  });

  app.put<{ Params: { id: string } }>('/contracts/documents/:id', { bodyLimit: CONTRACT_IMPORT_BODY_LIMIT_BYTES }, async (request) => {
    const body = parseWith(documentBodySchema, request.body, 'invalid body');
    const document = await deps.contractUpdateDocument.execute({ scope: scopeOf(request), id: request.params.id, ...documentFields(body) });
    return { document: contractDocumentResponse(document) };
  });

  app.delete<{ Params: { id: string } }>('/contracts/documents/:id', async (request, reply) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    await deps.contractDeleteDocument.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/contracts/documents/:id/extract', async (request, reply) => {
    const body = parseWith(extractBodySchema, request.body, 'invalid body');
    const document = await deps.contractExtractClauses.execute({
      scope: scopeOf(request), documentId: request.params.id,
      ...(body?.playbookId === undefined ? {} : { playbookId: body.playbookId }),
      ...(body?.scanAllArticles === undefined ? {} : { scanAllArticles: body.scanAllArticles }),
      ...(body?.articleRefs === undefined ? {} : { articleRefs: body.articleRefs }),
    }, clientAbortSignal(request, reply));
    return { document: contractDocumentResponse(document) };
  });

  app.put<{ Params: { id: string } }>('/contracts/documents/:id/clauses', async (request) => {
    const body = parseWith(confirmClausesBodySchema, request.body, 'invalid body');
    const document = await deps.contractConfirmClauses.execute({
      scope: scopeOf(request), documentId: request.params.id, clauses: body.clauses as unknown as readonly Clause[],
      ...(body.ourParty === undefined ? {} : { ourParty: body.ourParty }),
      ...(body.contractNature === undefined ? {} : { contractNature: body.contractNature }),
      ...(body.playbookId === undefined ? {} : { playbookId: body.playbookId }),
    });
    return { document: contractDocumentResponse(document) };
  });

  /* レビュー ------------------------------------------------------------ */

  app.post<{ Params: { id: string } }>('/contracts/documents/:id/reviews', async (request, reply) => {
    const body = parseWith(runReviewBodySchema, request.body, 'invalid body');
    const review = await deps.contractRunReview.execute({ scope: scopeOf(request), documentId: request.params.id, ...(body?.playbookId === undefined ? {} : { playbookId: body.playbookId }) }, clientAbortSignal(request, reply));
    return contractReviewResponse(review);
  });

  app.get<{ Params: { id: string } }>('/contracts/reviews/:id', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    return contractReviewResponse(await deps.contractGetReview.execute(scopeOf(request), request.params.id));
  });

  app.put<{ Params: { id: string } }>('/contracts/reviews/:id/decisions', async (request) => {
    const body = parseWith(reviewDecisionsBodySchema, request.body, 'invalid body');
    const review = await deps.contractSaveDecisions.execute({ scope: scopeOf(request), reviewId: request.params.id, decisions: body.decisions.map((decision) => ({ topicId: decision.topicId, ...(decision.decision === undefined ? {} : { decision: decision.decision }), ...(decision.note === undefined ? {} : { note: decision.note }) })) });
    return contractReviewResponse(review);
  });

  app.post<{ Params: { id: string } }>('/contracts/reviews/:id/finalize', async (request) => {
    parseWith(contractActionBodySchema, request.body, 'invalid body');
    return contractReviewResponse(await deps.contractFinalizeReview.execute(scopeOf(request), request.params.id));
  });

  /* 締結登録と期限台帳 ------------------------------------------------- */

  app.post('/contracts/deadlines/preview', async (request) => {
    const body = parseWith(deadlinePreviewBodySchema, request.body, 'invalid body');
    const preview = await deps.contractPreviewDeadlines.execute({
      scope: scopeOf(request), documentId: body.documentId,
      ...(body.signedDate === undefined ? {} : { signedDate: body.signedDate }), ...(body.signingMethod === undefined ? {} : { signingMethod: body.signingMethod }),
      ...(body.contractAmount === undefined ? {} : { contractAmount: body.contractAmount }), ...(body.playbookId === undefined ? {} : { playbookId: body.playbookId }),
    });
    return { preview };
  });

  app.get('/contracts/deadlines', async (request) => {
    const query = parseWith(deadlineLedgerQuerySchema, request.query, 'invalid query');
    const ledger = await deps.contractListDeadlines.execute({
      scope: scopeOf(request),
      ...(query.withinDays === undefined ? {} : { withinDays: query.withinDays }),
      ...(query.includeOverdue === undefined ? {} : { includeOverdue: query.includeOverdue === 'true' }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { ledger };
  });

  app.post('/contracts/signed', async (request) => {
    const body = parseWith(registerSignedBodySchema, request.body, 'invalid body');
    const { contract, warnings } = await deps.contractRegisterSigned.execute({
      scope: scopeOf(request), documentId: body.documentId, signedDate: body.signedDate, signingMethod: body.signingMethod,
      ...(body.title === undefined ? {} : { title: body.title }), ...(body.counterpartyName === undefined ? {} : { counterpartyName: body.counterpartyName }),
      ...(body.stampDuty === undefined ? {} : { stampDuty: { affixed: body.stampDuty.affixed, ...(body.stampDuty.documentTypeCode === undefined ? {} : { documentTypeCode: body.stampDuty.documentTypeCode }), ...(body.stampDuty.amount === undefined ? {} : { amount: body.stampDuty.amount }) } }),
      ...(body.playbookId === undefined ? {} : { playbookId: body.playbookId }),
    });
    return { contract: signedContractResponse(contract), warnings };
  });

  app.get('/contracts/signed', async (request) => {
    const query = parseWith(signedListQuerySchema, request.query, 'invalid query');
    const contracts = await deps.contractListSigned.execute(scopeOf(request), { ...(query.status === undefined ? {} : { status: query.status }), ...(query.counterparty === undefined ? {} : { counterparty: query.counterparty }) });
    return { contracts: contracts.map(signedViewResponse) };
  });

  app.get<{ Params: { id: string } }>('/contracts/signed/:id', async (request) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    return { contract: signedViewResponse(await deps.contractGetSigned.execute(scopeOf(request), request.params.id)) };
  });

  app.put<{ Params: { id: string } }>('/contracts/signed/:id', async (request) => {
    const body = parseWith(updateSignedBodySchema, request.body, 'invalid body');
    const contract = await deps.contractUpdateSigned.execute({
      scope: scopeOf(request), id: request.params.id,
      ...(body.title === undefined ? {} : { title: body.title }), ...(body.counterpartyName === undefined ? {} : { counterpartyName: body.counterpartyName }),
      ...(body.signedDate === undefined ? {} : { signedDate: body.signedDate }), ...(body.signingMethod === undefined ? {} : { signingMethod: body.signingMethod }),
      ...(body.stampDuty === undefined ? {} : { stampDuty: { affixed: body.stampDuty.affixed, ...(body.stampDuty.documentTypeCode === undefined ? {} : { documentTypeCode: body.stampDuty.documentTypeCode }), ...(body.stampDuty.amount === undefined ? {} : { amount: body.stampDuty.amount }) } }),
      ...(body.clauses === undefined ? {} : { clauses: body.clauses as unknown as readonly SignedClause[] }),
      ...(body.customDeadlines === undefined ? {} : { customDeadlines: body.customDeadlines.map((entry) => ({ dueDate: entry.dueDate, basis: entry.basis, ...(entry.id === undefined ? {} : { id: entry.id }), ...(entry.note === undefined ? {} : { note: entry.note }) })) }),
    });
    return { contract: signedContractResponse(contract) };
  });

  app.delete<{ Params: { id: string } }>('/contracts/signed/:id', async (request, reply) => {
    parseWith(contractScopeQuerySchema, request.query, 'invalid query');
    await deps.contractDeleteSigned.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/contracts/signed/:id/terminate', async (request) => {
    const body = parseWith(terminateSignedBodySchema, request.body, 'invalid body');
    const contract = await deps.contractTerminateSigned.execute({ scope: scopeOf(request), id: request.params.id, terminatedAt: body.terminatedAt, ...(body.reason === undefined ? {} : { reason: body.reason }) });
    return { contract: signedContractResponse(contract) };
  });

  app.post<{ Params: { id: string; deadlineId: string } }>('/contracts/signed/:id/deadlines/:deadlineId/complete', async (request) => {
    const body = parseWith(completeDeadlineBodySchema, request.body, 'invalid body');
    const contract = await deps.contractCompleteDeadline.execute({ scope: scopeOf(request), contractId: request.params.id, deadlineId: request.params.deadlineId, ...(body?.note === undefined ? {} : { note: body.note }) });
    return { contract: signedContractResponse(contract) };
  });
}

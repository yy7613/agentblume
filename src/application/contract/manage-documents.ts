/**
 * application層: 契約書の取込・更新・取得・一覧・削除、条項の確定（docs/23 §3.1 / §2.5）。
 *
 * - 取込で条文分割（決定的）と甲乙の仮検出まで行い、本文を保存する。PDF・画像の原本は受け取らない。
 * - 自社がどちらか（甲 / 乙）は、利用者の指定 → 審査基準の自社名の表記ゆれとの一致、の順で決める（モデルに推測させない）。
 * - 本文を変えたら抽出とレビューを破棄して `imported` へ戻す。締結済みの文書は 409。
 */
import { normalizeForMatch } from '../../domain/contract/evidence';
import { applyConsistency } from '../../domain/contract/consistency';
import {
  assertNotSigned, createContractDocument, validateClause,
  type Clause, type ContractDocument, type ContractDocumentStatus, type ContractDocumentSummary, type ContractSource, type CounterpartyProfileDeclaration,
} from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractDomainError } from '../../domain/contract/errors';
import type { Playbook } from '../../domain/contract/playbook';
import type { ContractDocumentRepository, ContractReviewRepository } from '../../domain/contract/repositories';
import { detectParties, segmentArticles, singlePage, type ContractPage } from '../../domain/contract/segmentation';
import type { ContractNature, OurRole, PartyKey } from '../../domain/contract/vocabulary';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import type { ContractPlaybookResolver } from './manage-playbooks';
import { randomId, systemClock, type Clock, type IdGenerator } from './support';

export interface DocumentFields {
  readonly title: string;
  readonly body: string;
  readonly source: ContractSource;
  /** 本文中の文字位置で表したページ境界。省略は 1 ページ。 */
  readonly pages?: readonly ContractPage[];
  readonly parties?: { readonly A?: string; readonly B?: string };
  readonly ourParty?: PartyKey;
  readonly ourRole?: OurRole;
  readonly counterpartyProfile?: CounterpartyProfileDeclaration;
  readonly contractNature?: ContractNature;
  readonly contractAmount?: number;
  /** 条文分割の段落上限と自社名の照合に使う審査基準（省略は既定）。 */
  readonly playbookId?: string;
}

const UNKNOWN_PROFILE: CounterpartyProfileDeclaration = { toriteki: 'unknown', freelance: 'unknown' };

/** 前文の当事者名と審査基準の自社名（表記ゆれ）を照らして、自社が甲か乙かの初期値を決める。 */
export function matchOurParty(parties: { readonly A?: string; readonly B?: string }, ourCompanyNames: readonly string[]): PartyKey | undefined {
  const names = ourCompanyNames.map(normalizeForMatch).filter((name) => name !== '');
  const hits = (['A', 'B'] as const).filter((key) => {
    const party = parties[key];
    if (party === undefined) return false;
    const normalized = normalizeForMatch(party);
    return names.some((name) => normalized.includes(name) || name.includes(normalized));
  });
  // 両方に当たるなら決めない（取り違えるより人に選ばせる）。
  return hits.length === 1 ? hits[0] : undefined;
}

function buildFields(fields: DocumentFields, playbook: Playbook) {
  const pages = fields.pages === undefined || fields.pages.length === 0 ? singlePage(fields.body) : fields.pages;
  const detected = detectParties(fields.body);
  const names = { ...detected, ...Object.fromEntries(Object.entries(fields.parties ?? {}).filter(([, value]) => typeof value === 'string' && value.trim() !== '')) } as { A?: string; B?: string };
  const ourParty = fields.ourParty ?? matchOurParty(names, playbook.ourCompanyNames);
  return {
    title: fields.title,
    body: fields.body,
    source: fields.source,
    pages,
    articles: segmentArticles(fields.body, pages, playbook.extraction.chunkMaxChars),
    parties: { A: { label: '甲', ...(names.A === undefined ? {} : { name: names.A }) }, B: { label: '乙', ...(names.B === undefined ? {} : { name: names.B }) } },
    ...(ourParty === undefined ? {} : { ourParty }),
    ourRole: fields.ourRole ?? playbook.ourRole,
    counterpartyProfile: fields.counterpartyProfile ?? UNKNOWN_PROFILE,
    ...(fields.contractNature === undefined ? {} : { contractNature: { value: fields.contractNature } }),
    ...(fields.contractAmount === undefined ? {} : { contractAmount: fields.contractAmount }),
  };
}

export class ImportContractDocumentUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = randomId,
  ) {}

  async execute(input: DocumentFields & { readonly scope: TenantScope }): Promise<{ readonly document: ContractDocument; readonly warnings: readonly string[] }> {
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId);
    const now = this.clock().toISOString();
    const document = createContractDocument({ tenant: input.scope, id: this.ids(), ...buildFields(input, playbook), clauses: [], status: 'imported', createdAt: now, updatedAt: now });
    const warnings: string[] = [];
    if (document.source.sha256 !== undefined) {
      const duplicate = (await this.documents.list(input.scope)).find((entry) => entry.sha256 === document.source.sha256);
      if (duplicate !== undefined) warnings.push(`同じファイルが「${duplicate.title}」（${duplicate.id}）として取込済みです。二重に取り込んでいないか確かめてください。`);
    }
    await this.documents.save(document);
    return { document, warnings };
  }
}

export class UpdateContractDocumentUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly reviews: ContractReviewRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: DocumentFields & { readonly scope: TenantScope; readonly id: string }): Promise<ContractDocument> {
    const current = await this.documents.findById(input.scope, input.id);
    if (current === null) throw new ContractDocumentNotFoundError(`contract document not found: ${input.id}`);
    assertNotSigned(current, 'be edited');
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId ?? current.extraction?.playbookId);
    const now = this.clock().toISOString();
    const bodyChanged = input.body !== current.body;
    const fields = buildFields({ ...input, ...(input.pages === undefined && !bodyChanged ? { pages: current.pages } : {}) }, playbook);
    return this.unitOfWork.withTransaction(async () => {
      if (bodyChanged) {
        // 本文が変われば条項の位置も根拠も意味を失う。抽出とレビューを捨てて取込直後へ戻す。
        await this.reviews.deleteByDocument(input.scope, current.id);
        const reset = createContractDocument({ ...fields, tenant: current.tenant, id: current.id, clauses: [], status: 'imported', createdAt: current.createdAt, updatedAt: now });
        await this.documents.save(reset);
        return reset;
      }
      const { extraction, reviewId, signedContractId, clauses, status } = current;
      const updated = createContractDocument({
        ...fields, tenant: current.tenant, id: current.id, clauses, status,
        ...(extraction === undefined ? {} : { extraction }), ...(reviewId === undefined ? {} : { reviewId }), ...(signedContractId === undefined ? {} : { signedContractId }),
        ...(current.signingDateText === undefined ? {} : { signingDateText: current.signingDateText }),
        ...(input.contractNature === undefined && current.contractNature !== undefined ? { contractNature: current.contractNature } : {}),
        createdAt: current.createdAt, updatedAt: now,
      });
      await this.documents.save(updated);
      return updated;
    });
  }
}

export class GetContractDocumentUseCase {
  constructor(private readonly documents: ContractDocumentRepository) {}

  async execute(scope: TenantScope, id: string): Promise<ContractDocument> {
    const document = await this.documents.findById(scope, id);
    if (document === null) throw new ContractDocumentNotFoundError(`contract document not found: ${id}`);
    return document;
  }
}

export class ListContractDocumentsUseCase {
  constructor(private readonly documents: ContractDocumentRepository) {}

  async execute(scope: TenantScope, options: { readonly status?: ContractDocumentStatus; readonly limit?: number } = {}): Promise<readonly ContractDocumentSummary[]> {
    return this.documents.list(scope, options);
  }
}

export class DeleteContractDocumentUseCase {
  constructor(private readonly documents: ContractDocumentRepository, private readonly reviews: ContractReviewRepository, private readonly unitOfWork: UnitOfWorkPort) {}

  /** 締結済みの文書は台帳の根拠なので消せない（締結済み契約を先に削除する）。 */
  async execute(scope: TenantScope, id: string): Promise<void> {
    const document = await this.documents.findById(scope, id);
    if (document === null) throw new ContractDocumentNotFoundError(`contract document not found: ${id}`);
    assertNotSigned(document, 'be deleted (delete the signed contract first)');
    await this.unitOfWork.withTransaction(async () => {
      await this.reviews.deleteByDocument(scope, id);
      await this.documents.delete(scope, id);
    });
  }
}

export interface ConfirmClausesInput {
  readonly scope: TenantScope;
  readonly documentId: string;
  readonly clauses: readonly Clause[];
  readonly ourParty?: PartyKey;
  readonly contractNature?: ContractNature;
  readonly playbookId?: string;
}

/**
 * 人が確認・修正した条項で確定する（`confirmed`）。突き合わせを計算し直し、前のレビューがあれば stale にする。
 * 利用者が手で直した値は `manual`。LLM の出どころでも、人が確定した時点で根拠の照合は画面で確かめ済みとして扱う。
 */
export class ConfirmContractClausesUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly reviews: ContractReviewRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: ConfirmClausesInput): Promise<ContractDocument> {
    const current = await this.documents.findById(input.scope, input.documentId);
    if (current === null) throw new ContractDocumentNotFoundError(`contract document not found: ${input.documentId}`);
    assertNotSigned(current, 'change its clauses');
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId ?? current.extraction?.playbookId);
    const known = new Set(playbook.topics.map((topic) => topic.id));
    const unknown = input.clauses.filter((clause) => !known.has(clause.topicId)).map((clause) => clause.topicId);
    if (unknown.length > 0) throw new ContractDomainError(`confirm clauses: these clause types are not in the playbook "${playbook.name}": ${unknown.join(', ')}`);
    const validated = input.clauses.map((clause, index) => validateClause(clause, index, current.body.length));
    const clauses = applyConsistency(validated, playbook.topics);
    const now = this.clock().toISOString();
    const status = current.status === 'imported' || current.status === 'extracted' || current.status === 'reviewed' ? 'confirmed' : current.status;
    const nature = input.contractNature === undefined ? current.contractNature : { value: input.contractNature };
    const document = createContractDocument({
      ...current, clauses, status, updatedAt: now,
      ...(input.ourParty === undefined ? {} : { ourParty: input.ourParty }),
      ...(nature === undefined ? {} : { contractNature: nature }),
    });
    return this.unitOfWork.withTransaction(async () => {
      if (current.reviewId !== undefined) {
        const review = await this.reviews.findById(input.scope, current.reviewId);
        if (review !== null && !review.stale) await this.reviews.save({ ...review, stale: true, updatedAt: now });
      }
      await this.documents.save(document);
      return document;
    });
  }
}

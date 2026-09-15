/**
 * application層: 締結登録と期限台帳（docs/23 §5 / §6）。
 *
 * - 締結登録は文書の確定済みの条項を写し、期限を計算して保存する（文書は `signed` へ）。二重登録は 409。
 *   レビューしていなくても登録できる（受け取った最終版を台帳に載せるだけの運用）が、その旨を警告で返す。
 * - 自動更新の「現在期」は今日で変わるので、台帳は投影で候補を引いたうえで現在期を計算し直す（保存はしない）。
 *   期限の完了・契約の変更のときは、計算し直した期限を保存する（前の期の未完了は superseded として残る）。
 * - 期限の完了・締結登録・終了は人が画面から押す（ツールにはしない）。
 */
import { contractDisplayStatus, completeDeadline, computeDeadlines, createSignedContract, mergeDeadlines, refreshSignedContract, signingWarnings, terminateSignedContract, type ContractWarning, type Deadline, type DeadlineKind, type SignedClause, type SignedContract, type SignedContractStatus, type SignedContractStampDuty } from '../../domain/contract/signed-contract';
import { addDays, daysBetween, isIsoDate } from '../../domain/contract/calendar';
import { termMonthsOf } from '../../domain/contract/consistency';
import { deadlineDisplayState, type DeadlineDisplayState } from '../../domain/contract/deadline';
import { counterpartyNameOf, createContractDocument, type ContractDocument } from '../../domain/contract/document';
import { ContractDocumentNotFoundError, ContractDomainError, ContractStateError, SignedContractNotFoundError } from '../../domain/contract/errors';
import type { Playbook } from '../../domain/contract/playbook';
import type { ContractDocumentRepository, ContractReviewRepository, SignedContractRepository } from '../../domain/contract/repositories';
import { decidedVerdicts } from '../../domain/contract/review';
import { stampDutyCandidates, type StampDutyCandidate } from '../../domain/contract/stamp-duty';
import type { SigningMethod } from '../../domain/contract/vocabulary';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import type { ContractPlaybookResolver } from './manage-playbooks';
import { localDate, randomId, systemClock, type Clock, type IdGenerator } from './support';

/** 文書の条項 → 締結時の写し。審査基準のトピックはすべて並べ、条項が無いものは present = false にする。 */
export function signedClausesOf(document: ContractDocument, playbook: Playbook): readonly SignedClause[] {
  const topics = [...playbook.topics].sort((left, right) => left.sortOrder - right.sortOrder);
  const fromTopics = topics.map((topic): SignedClause => {
    const clause = document.clauses.find((entry) => entry.topicId === topic.id);
    const value = clause?.value?.kind === topic.valueKind ? clause.value : undefined;
    const quote = clause?.evidence[0]?.quote;
    return {
      topicId: topic.id, topicLabel: topic.label, valueKind: topic.valueKind, present: clause?.present ?? false,
      ...(clause?.articleRef === undefined ? {} : { articleRef: clause.articleRef }),
      ...(quote === undefined ? {} : { quote }),
      // 人が手入力した値は根拠の照合を画面で済ませたものとして扱う。LLM 由来は引用が全部見つかったときだけ確認済み。
      quoteVerified: clause === undefined || !clause.present || clause.source === 'manual' || clause.evidence.every((entry) => entry.verified),
      ...(value === undefined ? {} : { value }),
    };
  });
  const extra = document.clauses.filter((clause) => !topics.some((topic) => topic.id === clause.topicId) && clause.value !== undefined).map((clause): SignedClause => ({
    topicId: clause.topicId, topicLabel: clause.topicId, valueKind: clause.value!.kind, present: clause.present,
    ...(clause.articleRef === undefined ? {} : { articleRef: clause.articleRef }),
    ...(clause.evidence[0] === undefined ? {} : { quote: clause.evidence[0].quote }),
    quoteVerified: clause.source === 'manual' || clause.evidence.every((entry) => entry.verified), value: clause.value!,
  }));
  return [...fromTopics, ...extra];
}

export interface RegisterSignedContractInput {
  readonly scope: TenantScope;
  readonly documentId: string;
  readonly signedDate: string;
  readonly signingMethod: SigningMethod;
  readonly title?: string;
  readonly counterpartyName?: string;
  readonly stampDuty?: SignedContractStampDuty;
  readonly playbookId?: string;
}

export class RegisterSignedContractUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly reviews: ContractReviewRepository,
    private readonly signed: SignedContractRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = randomId,
  ) {}

  async execute(input: RegisterSignedContractInput): Promise<{ readonly contract: SignedContract; readonly warnings: readonly ContractWarning[] }> {
    const document = await this.documents.findById(input.scope, input.documentId);
    if (document === null) throw new ContractDocumentNotFoundError(`contract document not found: ${input.documentId}`);
    const existing = await this.signed.findByDocument(input.scope, document.id);
    if (document.status === 'signed' || existing !== null) {
      throw new ContractStateError(`the contract document "${document.title}" is already registered as signed; open it in the deadline ledger`, { documentId: document.id, ...(existing === null ? {} : { contractId: existing.id }) });
    }
    if (!isIsoDate(input.signedDate)) throw new ContractDomainError('register signed contract: signedDate must be a calendar date in YYYY-MM-DD');
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId ?? document.extraction?.playbookId);
    const now = this.clock();
    const today = localDate(now);
    const clauses = signedClausesOf(document, playbook);
    const computed = computeDeadlines(clauses, input.signedDate, today);
    const review = document.reviewId === undefined ? null : await this.reviews.findById(input.scope, document.reviewId);
    const warnings: ContractWarning[] = [
      ...(review === null ? [{ message: 'この文書はレビューしていません。台帳には載せますが、審査基準との照合は行っていません。' }] : review.status === 'draft' ? [{ message: 'レビューの判定を確定していません。締結前の判断として記録するなら、レビューで判定を確定してください。' }] : []),
      ...signingWarnings(computed, today),
    ];
    const iso = now.toISOString();
    const contract = createSignedContract({
      tenant: input.scope, id: this.ids(), documentId: document.id, ...(review === null ? {} : { reviewId: review.id }),
      title: input.title ?? document.title,
      counterpartyName: input.counterpartyName ?? counterpartyNameOf(document) ?? '',
      signedDate: input.signedDate, signingMethod: input.signingMethod,
      ...(document.ourParty === undefined ? {} : { ourParty: document.ourParty }),
      clauses, ...(input.stampDuty === undefined ? {} : { stampDuty: input.stampDuty }),
      // 期限日の順に並べて保存する（台帳・画面が同じ順で読む）。
      deadlines: mergeDeadlines([], computed.deadlines), status: 'active',
      reviewVerdicts: review === null ? {} : decidedVerdicts(review),
      warnings, createdAt: iso, updatedAt: iso,
    });
    await this.unitOfWork.withTransaction(async () => {
      await this.signed.save(contract);
      await this.documents.save(createContractDocument({ ...document, status: 'signed', signedContractId: contract.id, updatedAt: iso }));
    });
    return { contract, warnings };
  }
}

export interface DeadlinePreview {
  readonly deadlines: readonly Deadline[];
  readonly warnings: readonly ContractWarning[];
  readonly autoRenewal: boolean;
  readonly termEnd?: string;
  readonly stampDutyCandidates: readonly StampDutyCandidate[];
  /** レビューの状態（締結登録の画面が「レビューしていません」を出す）。 */
  readonly review: 'none' | 'draft' | 'finalized';
  readonly counterpartyName?: string;
}

/** 条項値 + 締結日から期限・突き合わせ・印紙税候補を計算する（保存しない。締結登録の画面の即時表示用）。 */
export class PreviewContractDeadlinesUseCase {
  constructor(
    private readonly documents: ContractDocumentRepository,
    private readonly reviews: ContractReviewRepository,
    private readonly resolver: ContractPlaybookResolver,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly documentId: string; readonly signedDate?: string; readonly signingMethod?: SigningMethod; readonly contractAmount?: number; readonly playbookId?: string }): Promise<DeadlinePreview> {
    const document = await this.documents.findById(input.scope, input.documentId);
    if (document === null) throw new ContractDocumentNotFoundError(`contract document not found: ${input.documentId}`);
    const { playbook } = await this.resolver.resolve(input.scope, input.playbookId ?? document.extraction?.playbookId);
    const today = localDate(this.clock());
    const clauses = signedClausesOf(document, playbook);
    const signedDate = input.signedDate !== undefined && isIsoDate(input.signedDate) ? input.signedDate : undefined;
    const computed = computeDeadlines(clauses, signedDate, today);
    const mismatches = document.clauses.flatMap((clause) => clause.warnings.filter((warning) => warning.code === 'deadline-mismatch').map((warning) => ({ code: warning.code, message: warning.message })));
    const term = clauses.find((clause) => clause.present && clause.value?.kind === 'term');
    const termMonths = term?.value?.kind === 'term' ? termMonthsOf(term.value) : undefined;
    const review = document.reviewId === undefined ? null : await this.reviews.findById(input.scope, document.reviewId);
    const amount = input.contractAmount ?? document.contractAmount;
    const counterparty = counterpartyNameOf(document);
    return {
      deadlines: computed.deadlines,
      warnings: [...(signedDate === undefined ? computed.warnings : signingWarnings(computed, today)), ...mismatches],
      autoRenewal: computed.autoRenewal,
      ...(computed.schedule === undefined ? {} : { termEnd: computed.schedule.current.end }),
      stampDutyCandidates: stampDutyCandidates({
        nature: document.contractNature?.value, ...(amount === undefined ? {} : { contractAmount: amount }), ...(termMonths === undefined ? {} : { termMonths }),
        renews: computed.autoRenewal, ...(input.signingMethod === undefined ? {} : { signingMethod: input.signingMethod }),
      }, playbook.stampDuty),
      review: review === null ? 'none' : review.status,
      ...(counterparty === undefined ? {} : { counterpartyName: counterparty }),
    };
  }
}

export interface SignedContractView {
  readonly contract: SignedContract;
  readonly displayStatus: SignedContractStatus;
}

export class ListSignedContractsUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly clock: Clock = systemClock) {}

  async execute(scope: TenantScope, options: { readonly status?: SignedContractStatus; readonly counterparty?: string } = {}): Promise<readonly SignedContractView[]> {
    const now = this.clock();
    const today = localDate(now);
    const all = await this.signed.list(scope, options.counterparty === undefined ? {} : { counterparty: options.counterparty });
    return all.map((contract) => {
      const refreshed = refreshSignedContract(contract, today, now.toISOString());
      return { contract: refreshed, displayStatus: contractDisplayStatus(refreshed, today) };
    }).filter((view) => options.status === undefined || view.displayStatus === options.status);
  }
}

export class GetSignedContractUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly clock: Clock = systemClock) {}

  async execute(scope: TenantScope, id: string): Promise<SignedContractView> {
    const contract = await this.signed.findById(scope, id);
    if (contract === null) throw new SignedContractNotFoundError(`signed contract not found: ${id}`);
    const now = this.clock();
    const today = localDate(now);
    const refreshed = refreshSignedContract(contract, today, now.toISOString());
    return { contract: refreshed, displayStatus: contractDisplayStatus(refreshed, today) };
  }
}

export interface UpdateSignedContractInput {
  readonly scope: TenantScope;
  readonly id: string;
  readonly title?: string;
  readonly counterpartyName?: string;
  readonly signedDate?: string;
  readonly signingMethod?: SigningMethod;
  readonly stampDuty?: SignedContractStampDuty;
  readonly clauses?: readonly SignedClause[];
  /** 手で足す期限の一覧（渡したら置き換える。同じ id の完了状態は保つ）。 */
  readonly customDeadlines?: readonly { readonly id?: string; readonly dueDate: string; readonly basis: string; readonly note?: string }[];
}

/** 条項・期限の手修正（監査対象）。条項を直したら期限を計算し直す。 */
export class UpdateSignedContractUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly clock: Clock = systemClock, private readonly ids: IdGenerator = randomId) {}

  async execute(input: UpdateSignedContractInput): Promise<SignedContract> {
    const current = await this.signed.findById(input.scope, input.id);
    if (current === null) throw new SignedContractNotFoundError(`signed contract not found: ${input.id}`);
    if (current.status === 'terminated') throw new ContractStateError(`the contract "${current.title}" is terminated and can no longer be edited`, { contractId: current.id });
    const now = this.clock();
    const clauses = input.clauses ?? current.clauses;
    const signedDate = input.signedDate ?? current.signedDate;
    const computed = computeDeadlines(clauses, signedDate, localDate(now));
    const customs: Deadline[] = input.customDeadlines === undefined
      ? current.deadlines.filter((deadline) => deadline.kind === 'custom')
      : input.customDeadlines.map((entry) => {
        const previous = entry.id === undefined ? undefined : current.deadlines.find((deadline) => deadline.id === entry.id && deadline.kind === 'custom');
        return { id: previous?.id ?? `custom-${this.ids()}`, kind: 'custom' as const, dueDate: entry.dueDate, basis: entry.basis, status: previous?.status ?? 'open', ...(previous?.completedAt === undefined ? {} : { completedAt: previous.completedAt }), ...(entry.note === undefined ? {} : { note: entry.note }) };
      });
    const computedExisting = current.deadlines.filter((deadline) => deadline.kind !== 'custom');
    return this.save(createSignedContract({
      ...current,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.counterpartyName === undefined ? {} : { counterpartyName: input.counterpartyName }),
      signedDate,
      ...(input.signingMethod === undefined ? {} : { signingMethod: input.signingMethod }),
      ...(input.stampDuty === undefined ? {} : { stampDuty: input.stampDuty }),
      clauses,
      deadlines: [...mergeDeadlines(computedExisting, computed.deadlines), ...customs],
      warnings: computed.warnings,
      updatedAt: now.toISOString(),
    }));
  }

  private async save(contract: SignedContract): Promise<SignedContract> {
    await this.signed.save(contract);
    return contract;
  }
}

export class DeleteSignedContractUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly documents: ContractDocumentRepository, private readonly reviews: ContractReviewRepository, private readonly unitOfWork: UnitOfWorkPort, private readonly clock: Clock = systemClock) {}

  /** 台帳から消し、文書を締結登録前の状態へ戻す（レビューを確定していれば reviewed、それ以外は confirmed）。 */
  async execute(scope: TenantScope, id: string): Promise<void> {
    const contract = await this.signed.findById(scope, id);
    if (contract === null) throw new SignedContractNotFoundError(`signed contract not found: ${id}`);
    const document = await this.documents.findById(scope, contract.documentId);
    const review = document?.reviewId === undefined ? null : await this.reviews.findById(scope, document.reviewId);
    await this.unitOfWork.withTransaction(async () => {
      await this.signed.delete(scope, id);
      if (document !== null) {
        const { signedContractId: _removed, ...rest } = document;
        await this.documents.save(createContractDocument({ ...rest, status: review?.status === 'finalized' ? 'reviewed' : 'confirmed', updatedAt: this.clock().toISOString() }));
      }
    });
  }
}

export class TerminateSignedContractUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly clock: Clock = systemClock) {}

  async execute(input: { readonly scope: TenantScope; readonly id: string; readonly terminatedAt: string; readonly reason?: string }): Promise<SignedContract> {
    const contract = await this.signed.findById(input.scope, input.id);
    if (contract === null) throw new SignedContractNotFoundError(`signed contract not found: ${input.id}`);
    if (!isIsoDate(input.terminatedAt)) throw new ContractDomainError('terminate signed contract: terminatedAt must be a calendar date in YYYY-MM-DD');
    const terminated = terminateSignedContract(contract, input.terminatedAt, input.reason, this.clock().toISOString());
    await this.signed.save(terminated);
    return terminated;
  }
}

export class CompleteContractDeadlineUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly clock: Clock = systemClock) {}

  /** 通知したという記録。現在期で計算し直してから完了にする（台帳に出ている id と保存済みの id を揃える）。 */
  async execute(input: { readonly scope: TenantScope; readonly contractId: string; readonly deadlineId: string; readonly note?: string }): Promise<SignedContract> {
    const contract = await this.signed.findById(input.scope, input.contractId);
    if (contract === null) throw new SignedContractNotFoundError(`signed contract not found: ${input.contractId}`);
    const now = this.clock();
    const refreshed = refreshSignedContract(contract, localDate(now), now.toISOString());
    if (!refreshed.deadlines.some((deadline) => deadline.id === input.deadlineId)) throw new SignedContractNotFoundError(`the contract "${contract.title}" has no deadline "${input.deadlineId}"`);
    const completed = completeDeadline(refreshed, input.deadlineId, now.toISOString(), input.note);
    await this.signed.save(completed);
    return completed;
  }
}

export interface LedgerRow {
  readonly contractId: string;
  readonly title: string;
  readonly counterpartyName: string;
  readonly deadline: Deadline;
  readonly daysLeft: number;
  readonly state: DeadlineDisplayState;
  readonly autoRenewal: boolean;
  readonly contractStatus: SignedContractStatus;
}

export interface LedgerQuery {
  readonly scope: TenantScope;
  /** 今日から何日先までの期限か（過ぎた期限は includeOverdue で決める）。 */
  readonly withinDays?: number;
  readonly includeOverdue?: boolean;
  readonly kind?: DeadlineKind;
  readonly limit?: number;
}

export interface Ledger {
  readonly today: string;
  readonly dueSoonDays: number;
  readonly rows: readonly LedgerRow[];
}

/** 期限台帳（期限の近い順）。 */
export class ListContractDeadlinesUseCase {
  constructor(private readonly signed: SignedContractRepository, private readonly resolver: ContractPlaybookResolver, private readonly clock: Clock = systemClock) {}

  async execute(query: LedgerQuery): Promise<Ledger> {
    const now = this.clock();
    const today = localDate(now);
    const { playbook } = await this.resolver.resolve(query.scope);
    const dueSoonDays = playbook.legal.dueSoonDays;
    const horizon = query.withinDays === undefined ? undefined : addDays(today, query.withinDays);
    const projections = await this.signed.listOpenDeadlines(query.scope, horizon === undefined ? {} : { dueOnOrBefore: horizon });
    const contractIds = [...new Set(projections.map((projection) => projection.contractId))];
    const rows: LedgerRow[] = [];
    for (const contractId of contractIds) {
      const stored = await this.signed.findById(query.scope, contractId);
      if (stored === null || stored.status === 'terminated') continue;
      const contract = refreshSignedContract(stored, today, now.toISOString());
      const status = contractDisplayStatus(contract, today);
      const autoRenewal = computeDeadlines(contract.clauses, contract.signedDate, today).autoRenewal;
      for (const deadline of contract.deadlines) {
        if (deadline.status !== 'open') continue;
        if (query.kind !== undefined && deadline.kind !== query.kind) continue;
        const daysLeft = daysBetween(today, deadline.dueDate);
        if (daysLeft < 0 && query.includeOverdue === false) continue;
        if (horizon !== undefined && deadline.dueDate > horizon) continue;
        rows.push({ contractId: contract.id, title: contract.title, counterpartyName: contract.counterpartyName, deadline, daysLeft, state: deadlineDisplayState(deadline.dueDate, today, dueSoonDays), autoRenewal, contractStatus: status });
      }
    }
    rows.sort((left, right) => (left.deadline.dueDate < right.deadline.dueDate ? -1 : left.deadline.dueDate > right.deadline.dueDate ? 1 : left.contractId < right.contractId ? -1 : left.contractId > right.contractId ? 1 : left.deadline.id < right.deadline.id ? -1 : 1));
    return { today, dueSoonDays, rows: query.limit === undefined ? rows : rows.slice(0, query.limit) };
  }
}

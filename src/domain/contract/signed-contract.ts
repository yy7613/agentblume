/**
 * ドメイン: 締結済み契約と期限（docs/23 §2.6 / §5）。
 *
 * 期限は締結時に確定した条項の写し（`clauses`）から暦の規則で計算する。自動更新の「現在期」は今日で変わるので、
 * 保存するのは保存時点の期の期限と、人が付けた状態（完了）だけ。表示時の overdue / due-soon は今日から派生する。
 *
 * - 期が進んだら、前の期の未完了の期限は `superseded` として履歴に残す（通知したかどうかを後から追えるように）。
 * - 中途解約の予告期間は条件であって期限ではないので台帳に載せない（`contract_clauses` で検索する）。
 * - 利用者は `custom` 期限（報告期限など）を手で足せる。計算の対象外。
 */
import type { TenantScope } from '../shared/tenant-scope';
import { compareIsoDates, daysBetween, isIsoDate } from './calendar';
import { clauseValueProblem, VALUE_KINDS, type ClauseValue, type ValueKind } from './clause-value';
import { termMonthsOf } from './consistency';
import { buildTermSchedule, noticeDeadlineByDays, noticeDeadlineByMonths, type TermSchedule } from './deadline';
import { ContractDomainError, ContractStateError } from './errors';
import type { DeadlineId, SignedContractId } from './ids';
import type { ReasonCode } from './reasons';
import type { Verdict } from './review';
import { isOneOf, PARTY_KEYS, SIGNING_METHODS, type PartyKey, type SigningMethod } from './vocabulary';

export interface SignedClause {
  readonly topicId: string;
  readonly topicLabel: string;
  readonly valueKind: ValueKind;
  readonly present: boolean;
  readonly articleRef?: string;
  readonly quote?: string;
  readonly quoteVerified: boolean;
  readonly value?: ClauseValue;
}

export const DEADLINE_KINDS = ['expiry', 'renewal_notice', 'renewal', 'custom'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];
export const DEADLINE_STATUSES = ['open', 'done', 'superseded'] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

export interface Deadline {
  readonly id: DeadlineId;
  readonly kind: DeadlineKind;
  readonly dueDate: string;
  /** 根拠（「第3条: 満了の3か月前まで」）。custom は利用者の説明。 */
  readonly basis: string;
  readonly termIndex?: number;
  readonly termEnd?: string;
  readonly status: DeadlineStatus;
  readonly completedAt?: string;
  readonly note?: string;
}

export interface ContractWarning {
  readonly code?: ReasonCode;
  readonly message: string;
}

export interface SignedContractStampDuty {
  readonly documentTypeCode?: string;
  readonly amount?: number;
  /** 貼付済みか。null は未確認。 */
  readonly affixed: boolean | null;
}

export const SIGNED_CONTRACT_STATUSES = ['active', 'expired', 'terminated'] as const;
export type SignedContractStatus = (typeof SIGNED_CONTRACT_STATUSES)[number];

export interface SignedContract {
  readonly tenant: TenantScope;
  readonly id: SignedContractId;
  readonly documentId: string;
  readonly reviewId?: string;
  readonly title: string;
  readonly counterpartyName: string;
  readonly signedDate: string;
  readonly signingMethod: SigningMethod;
  readonly ourParty?: PartyKey;
  readonly clauses: readonly SignedClause[];
  readonly stampDuty?: SignedContractStampDuty;
  readonly deadlines: readonly Deadline[];
  readonly status: SignedContractStatus;
  readonly terminatedAt?: string;
  readonly terminationReason?: string;
  /** 締結前レビューのトピックごとの判断（レビューしていなければ空）。 */
  readonly reviewVerdicts: Readonly<Record<string, Verdict>>;
  readonly warnings: readonly ContractWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateSignedContractProps = SignedContract;

function fail(message: string): never {
  throw new ContractDomainError(`createSignedContract: ${message}`);
}

export function createSignedContract(props: CreateSignedContractProps): SignedContract {
  if (props === null || typeof props !== 'object') fail('props must be an object');
  if (typeof props.tenant?.tenantId !== 'string' || typeof props.tenant.workspaceId !== 'string') fail('tenant is required');
  for (const key of ['id', 'documentId', 'createdAt', 'updatedAt'] as const) if (typeof props[key] !== 'string' || props[key] === '') fail(`${key} is required`);
  if (typeof props.title !== 'string' || props.title.trim() === '' || props.title.length > 200) fail('title must be a non-empty string of at most 200 characters');
  if (typeof props.counterpartyName !== 'string' || props.counterpartyName.trim() === '' || props.counterpartyName.length > 200) fail('counterpartyName must be a non-empty string of at most 200 characters (enter the counterparty on the sign step)');
  if (!isIsoDate(props.signedDate)) fail('signedDate must be a calendar date in YYYY-MM-DD');
  if (!isOneOf(SIGNING_METHODS, props.signingMethod)) fail('signingMethod must be paper, electronic or unknown');
  if (props.ourParty !== undefined && !isOneOf(PARTY_KEYS, props.ourParty)) fail('ourParty must be A or B');
  if (!isOneOf(SIGNED_CONTRACT_STATUSES, props.status)) fail('status must be active, expired or terminated');
  if (props.status === 'terminated' && !isIsoDate(props.terminatedAt)) fail('a terminated contract needs terminatedAt (YYYY-MM-DD)');
  if (!Array.isArray(props.clauses)) fail('clauses must be an array');
  const clauses = props.clauses.map((clause, index) => {
    if (typeof clause?.topicId !== 'string' || clause.topicId === '' || typeof clause.topicLabel !== 'string' || !isOneOf(VALUE_KINDS, clause.valueKind) || typeof clause.present !== 'boolean' || typeof clause.quoteVerified !== 'boolean') fail(`clauses[${index}] is malformed`);
    if (clause.value !== undefined) { const problem = clauseValueProblem(clause.value); if (problem !== undefined) fail(`clauses[${index}].value: ${problem}`); }
    return structuredClone(clause);
  });
  if (!Array.isArray(props.deadlines)) fail('deadlines must be an array');
  const ids = new Set<string>();
  const deadlines = props.deadlines.map((deadline, index) => {
    if (typeof deadline?.id !== 'string' || deadline.id === '' || ids.has(deadline.id)) fail(`deadlines[${index}].id must be unique`);
    ids.add(deadline.id);
    if (!isOneOf(DEADLINE_KINDS, deadline.kind)) fail(`deadlines[${index}].kind must be one of ${DEADLINE_KINDS.join(', ')}`);
    if (!isIsoDate(deadline.dueDate)) fail(`deadlines[${index}].dueDate must be a calendar date in YYYY-MM-DD`);
    if (!isOneOf(DEADLINE_STATUSES, deadline.status)) fail(`deadlines[${index}].status must be open, done or superseded`);
    if (typeof deadline.basis !== 'string' || deadline.basis.trim() === '' || deadline.basis.length > 300) fail(`deadlines[${index}].basis must be a non-empty string of at most 300 characters`);
    return structuredClone(deadline);
  });
  if (props.stampDuty !== undefined && !(props.stampDuty.affixed === null || typeof props.stampDuty.affixed === 'boolean')) fail('stampDuty.affixed must be true, false or null');
  if (props.stampDuty?.amount !== undefined && !(Number.isInteger(props.stampDuty.amount) && props.stampDuty.amount >= 0)) fail('stampDuty.amount must be a non-negative integer');
  return {
    ...structuredClone(props),
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    title: props.title.trim(),
    counterpartyName: props.counterpartyName.trim(),
    clauses,
    deadlines,
    reviewVerdicts: { ...(props.reviewVerdicts ?? {}) },
    warnings: Array.isArray(props.warnings) ? props.warnings.map((warning) => ({ ...(warning.code === undefined ? {} : { code: warning.code }), message: String(warning.message) })) : [],
  };
}

function firstPresent<K extends ClauseValue['kind']>(clauses: readonly SignedClause[], kind: K): (SignedClause & { readonly value: Extract<ClauseValue, { kind: K }> }) | undefined {
  return clauses.find((clause) => clause.present && clause.value?.kind === kind) as (SignedClause & { readonly value: Extract<ClauseValue, { kind: K }> }) | undefined;
}

export interface ComputedDeadlines {
  readonly schedule?: TermSchedule;
  readonly autoRenewal: boolean;
  /** 保存時点の期の期限（id は種類と期で決まる）。 */
  readonly deadlines: readonly Deadline[];
  readonly warnings: readonly ContractWarning[];
}

/** 条項の写し + 締結日 → 現在期の期限（R3〜R9）。 */
export function computeDeadlines(clauses: readonly SignedClause[], signedDate: string | undefined, today: string): ComputedDeadlines {
  const warnings: ContractWarning[] = [];
  const term = firstPresent(clauses, 'term');
  const renewal = firstPresent(clauses, 'auto_renewal');
  const notice = firstPresent(clauses, 'notice');
  const autoRenewal = renewal?.value.renews === true;
  if (term === undefined) return { autoRenewal, deadlines: [], warnings: [{ message: '契約期間の条項が無いので期限を計算できません。期間の条項を入力してください。' }] };
  const start = term.value.startDate ?? (term.value.startsOnSigning ? signedDate : undefined);
  if (term.value.startsOnSigning && term.value.startDate === undefined && signedDate === undefined) return { autoRenewal, deadlines: [], warnings: [{ message: '契約期間は締結日から始まりますが、締結日が未定です。締結登録で締結日を入れると期限を計算します。' }] };
  const termMonths = termMonthsOf({ ...term.value, ...(start === undefined ? {} : { startDate: start }) });
  const renewalMonths = renewal === undefined ? undefined : renewal.value.renewalMonths ?? (renewal.value.sameAsInitial ? termMonths : undefined);
  if (autoRenewal && renewalMonths === undefined) warnings.push({ message: '自動更新の期間が読み取れないので、次の期の期限は計算していません。更新期間を入力してください。' });
  const schedule = buildTermSchedule({
    ...(start === undefined ? {} : { startDate: start }),
    ...(term.value.endDate === undefined ? {} : { endDate: term.value.endDate }),
    ...(term.value.durationMonths === undefined ? {} : { durationMonths: term.value.durationMonths }),
    renews: autoRenewal,
    ...(renewalMonths === undefined ? {} : { renewalMonths }),
  }, today);
  if (schedule === undefined) return { autoRenewal, deadlines: [], warnings: [...warnings, { message: '始期・期間・満了日のどれかが足りず、満了日を計算できません。期間の条項の値を補ってください。' }] };
  if (schedule.truncated) warnings.push({ message: '自動更新を 100 期まで数えても今日に届かないので打ち切りました。期間の値を確かめてください。' });
  if (signedDate !== undefined && start !== undefined && compareIsoDates(signedDate, start) > 0) warnings.push({ message: `締結日 ${signedDate} が始期 ${start} より後です（遡って始まる契約）。` });
  const { current } = schedule;
  const termRef = term.articleRef ?? '契約期間の条項';
  const deadlines: Deadline[] = [{ id: `expiry-${current.index}`, kind: 'expiry', dueDate: current.end, basis: `${termRef}: 満了日`, termIndex: current.index, termEnd: current.end, status: 'open' }];
  if (autoRenewal && renewalMonths !== undefined) {
    const renewalDate = noticeDeadlineByDays(current.end, -1);
    deadlines.push({ id: `renewal-${current.index}`, kind: 'renewal', dueDate: renewalDate, basis: `${renewal?.articleRef ?? '自動更新の条項'}: 満了の翌日に更新`, termIndex: current.index, termEnd: current.end, status: 'open' });
    if (notice !== undefined) {
      if (notice.value.businessDays) {
        warnings.push({ code: 'value-unparsed', message: '通知期限が営業日で定められているので計算していません。休日の定義を確かめて、期限を手入力してください。' });
      } else {
        const dueDate = notice.value.unit === 'month' ? noticeDeadlineByMonths(current.end, notice.value.amount) : noticeDeadlineByDays(current.end, notice.value.amount);
        deadlines.push({ id: `renewal_notice-${current.index}`, kind: 'renewal_notice', dueDate, basis: `${notice.articleRef ?? '更新拒絶の条項'}: 満了の${notice.value.amount}${notice.value.unit === 'month' ? 'か月' : '日'}前まで`, termIndex: current.index, termEnd: current.end, status: 'open' });
      }
    }
  }
  return { schedule, autoRenewal, deadlines, warnings };
}

/**
 * 保存済みの期限へ、計算し直した期限を重ねる。
 * - 同じ id で完了済みのものは完了のまま残す。
 * - 計算で消えた未完了の期限（前の期）は superseded にする。
 * - custom はそのまま。
 */
export function mergeDeadlines(existing: readonly Deadline[], computed: readonly Deadline[]): readonly Deadline[] {
  const computedIds = new Set(computed.map((deadline) => deadline.id));
  const kept = existing.filter((deadline) => deadline.kind === 'custom' || !computedIds.has(deadline.id)).map((deadline) => deadline.kind !== 'custom' && deadline.status === 'open' ? { ...deadline, status: 'superseded' as const } : deadline);
  const merged = computed.map((deadline) => existing.find((entry) => entry.id === deadline.id && entry.status === 'done') ?? deadline);
  return [...kept, ...merged].sort((left, right) => compareIsoDates(left.dueDate, right.dueDate) || (left.id < right.id ? -1 : 1));
}

/** 表示・台帳のための再計算（純関数。保存は呼び出し側）。 */
export function refreshSignedContract(contract: SignedContract, today: string, now: string): SignedContract {
  if (contract.status === 'terminated') return contract;
  const computed = computeDeadlines(contract.clauses, contract.signedDate, today);
  const deadlines = mergeDeadlines(contract.deadlines, computed.deadlines);
  if (JSON.stringify(deadlines) === JSON.stringify(contract.deadlines)) return contract;
  return createSignedContract({ ...contract, deadlines, updatedAt: now });
}

/** 締結登録時の警告（G7: 現在期の通知期限が既に過ぎている）。 */
export function signingWarnings(computed: ComputedDeadlines, today: string): readonly ContractWarning[] {
  const passed = computed.deadlines.find((deadline) => deadline.kind === 'renewal_notice' && daysBetween(today, deadline.dueDate) < 0);
  return [...computed.warnings, ...(passed === undefined ? [] : [{ code: 'notice-deadline-passed' as const, message: `更新拒絶の通知期限 ${passed.dueDate} は既に過ぎています（締結登録時点）。` }])];
}

export function completeDeadline(contract: SignedContract, deadlineId: string, now: string, note?: string): SignedContract {
  const target = contract.deadlines.find((deadline) => deadline.id === deadlineId);
  if (target === undefined) throw new ContractDomainError(`completeDeadline: the contract "${contract.id}" has no deadline "${deadlineId}"`);
  if (target.status !== 'open') throw new ContractStateError(`the deadline "${deadlineId}" is already ${target.status}`, { contractId: contract.id });
  const deadlines = contract.deadlines.map((deadline) => deadline.id === deadlineId ? { ...deadline, status: 'done' as const, completedAt: now, ...(note === undefined || note === '' ? {} : { note: note.slice(0, 500) }) } : deadline);
  return createSignedContract({ ...contract, deadlines, updatedAt: now });
}

export function terminateSignedContract(contract: SignedContract, terminatedAt: string, reason: string | undefined, now: string): SignedContract {
  if (contract.status === 'terminated') throw new ContractStateError(`the contract "${contract.id}" is already terminated`, { contractId: contract.id });
  // 終了した契約の未完了の期限は、もう通知の必要が無いので superseded にする。
  const deadlines = contract.deadlines.map((deadline) => deadline.status === 'open' ? { ...deadline, status: 'superseded' as const } : deadline);
  return createSignedContract({ ...contract, status: 'terminated', terminatedAt, ...(reason === undefined || reason === '' ? {} : { terminationReason: reason.slice(0, 500) }), deadlines, updatedAt: now });
}

/** 表示上の状態。自動更新の無い契約が満了日を過ぎたら expired。 */
export function contractDisplayStatus(contract: SignedContract, today: string): SignedContractStatus {
  if (contract.status !== 'active') return contract.status;
  const computed = computeDeadlines(contract.clauses, contract.signedDate, today);
  return !computed.autoRenewal && computed.schedule !== undefined && compareIsoDates(computed.schedule.current.end, today) < 0 ? 'expired' : 'active';
}

/**
 * ドメイン: 規程のヒアリング（ExpensePolicyHearing。docs/21 §20.2.11 / §20.7.2。UC9。案の検証・差分・モデル呼び出しは C）。
 *
 * LLM は規程の**案**と根拠の引用を出すだけで、判定にも確認にも関与しない（ADR-0043 §12）。保存は利用者が選んだ変更だけ。
 * `basePolicyUpdatedAt` は案を作った時点の規程の版で、保存時に現在の規程と違えば 409（`ExpensePolicyConflictError`）。
 *
 * 案（`proposal.candidate`）は規程の部分の形だけを検証する（中身の検証は C の `validatePolicyProposal` が `createExpensePolicy` で行い、
 * 通った部分だけを保存する）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import type { ApprovalRoute } from './approval';
import { ExpenseDomainError } from './errors';
import type { ExpensePolicyHearingId } from './ids';
import type { ClaimRules, ExpenseCategory, PreApprovalRule } from './policy';
import type { SeverityOverride } from './reason-codes';

export const EXPENSE_POLICY_HEARING_PROMPT_VERSION = 'expense-policy-hearing/v1';
export const HEARING_MODES = ['document', 'questions'] as const;
export type HearingMode = (typeof HEARING_MODES)[number];
export const HEARING_STATUSES = ['open', 'proposed', 'accepted', 'cancelled'] as const;
export type HearingStatus = (typeof HEARING_STATUSES)[number];
export const HEARING_QUESTION_KINDS = ['single', 'multi', 'text', 'number', 'confirm'] as const;
export type HearingQuestionKind = (typeof HEARING_QUESTION_KINDS)[number];

export const HEARING_DOCUMENT_MAX = 50_000;
export const HEARING_MAX_TURNS = 6;
export const HEARING_MAX_QUESTIONS_PER_TURN = 3;

export interface HearingQuestion {
  readonly id: string;
  readonly text: string;
  readonly kind: HearingQuestionKind;
  readonly options?: readonly string[];
  /** 話題のカタログ（C の `hearing-topics.ts`）の鍵。 */
  readonly topic: string;
}

export type HearingAnswerValue = string | number | boolean | readonly string[];

export interface HearingTurn {
  readonly questions: readonly HearingQuestion[];
  readonly answers?: readonly { readonly questionId: string; readonly value: HearingAnswerValue }[];
  readonly askedAt: IsoDateTime;
  readonly answeredAt?: IsoDateTime;
}

/** 規程の案（規程の型から `enabled` / `sortOrder` / `updatedAt` 以外は同じ形の部分）。 */
export interface ProposedPolicyPatch {
  readonly categories?: readonly ExpenseCategory[];
  readonly claimRules?: Partial<ClaimRules>;
  readonly preApprovalRules?: readonly PreApprovalRule[];
  readonly approvalRoutes?: readonly ApprovalRoute[];
  readonly severityOverrides?: Readonly<Record<string, SeverityOverride>>;
}

export interface PolicyProposal {
  readonly candidate: ProposedPolicyPatch;
  readonly rationales: readonly { readonly path: string; readonly quote?: string; readonly quoteFound: boolean; readonly note?: string }[];
  readonly dropped: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export interface ExpensePolicyHearing {
  readonly tenant: TenantScope;
  readonly id: ExpensePolicyHearingId;
  readonly mode: HearingMode;
  readonly source: { readonly documentText?: string; readonly fileName?: string; readonly sha256?: string; readonly sections?: readonly { readonly heading: string; readonly start: number; readonly end: number }[] };
  readonly status: HearingStatus;
  readonly turns: readonly HearingTurn[];
  readonly proposal?: PolicyProposal;
  readonly basePolicyUpdatedAt: IsoDateTime;
  readonly acceptedChangeIds?: readonly string[];
  readonly model?: { readonly provider: string; readonly model: string };
  readonly promptVersion: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown, label: string): readonly unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw fail(`${label} must be an array`);
  return value;
}

function validateQuestion(value: unknown, label: string): HearingQuestion {
  const raw = obj(value, label);
  assertNonEmpty(raw['id'], `${label}.id`, fail);
  assertNonEmpty(raw['text'], `${label}.text`, fail);
  assertNonEmpty(raw['topic'], `${label}.topic`, fail);
  if (!(HEARING_QUESTION_KINDS as readonly unknown[]).includes(raw['kind'])) throw fail(`${label}.kind must be one of ${HEARING_QUESTION_KINDS.join(', ')}`);
  const options = optionalArray(raw['options'], `${label}.options`);
  if (options !== undefined && options.some((option) => typeof option !== 'string')) throw fail(`${label}.options must be strings`);
  return withDefined({ id: raw['id'] as string, text: raw['text'] as string, kind: raw['kind'] as HearingQuestionKind, options: options as string[] | undefined, topic: raw['topic'] as string });
}

function validateTurn(value: unknown, label: string): HearingTurn {
  const raw = obj(value, label);
  const questions = optionalArray(raw['questions'], `${label}.questions`) ?? [];
  if (questions.length === 0 || questions.length > HEARING_MAX_QUESTIONS_PER_TURN) throw fail(`${label}.questions must have 1 to ${HEARING_MAX_QUESTIONS_PER_TURN} questions`);
  assertIsoDateTime(raw['askedAt'], `${label}.askedAt`, fail);
  const answers = optionalArray(raw['answers'], `${label}.answers`)?.map((entry, index) => {
    const answer = obj(entry, `${label}.answers[${index}]`);
    assertNonEmpty(answer['questionId'], `${label}.answers[${index}].questionId`, fail);
    const answerValue = answer['value'];
    const ok = typeof answerValue === 'string' || typeof answerValue === 'number' || typeof answerValue === 'boolean' || (Array.isArray(answerValue) && answerValue.every((item) => typeof item === 'string'));
    if (!ok) throw fail(`${label}.answers[${index}].value must be a string, number, boolean or string array`);
    return { questionId: answer['questionId'] as string, value: answerValue as HearingAnswerValue };
  });
  if (raw['answeredAt'] !== undefined) assertIsoDateTime(raw['answeredAt'], `${label}.answeredAt`, fail);
  return withDefined({ questions: questions.map((question, index) => validateQuestion(question, `${label}.questions[${index}]`)), answers, askedAt: raw['askedAt'] as string, answeredAt: raw['answeredAt'] as string | undefined });
}

function validateProposal(value: unknown, label: string): PolicyProposal {
  const raw = obj(value, label);
  const candidate = obj(raw['candidate'], `${label}.candidate`);
  for (const key of ['categories', 'preApprovalRules', 'approvalRoutes'] as const) optionalArray(candidate[key], `${label}.candidate.${key}`);
  for (const key of ['claimRules', 'severityOverrides'] as const) if (candidate[key] !== undefined) obj(candidate[key], `${label}.candidate.${key}`);
  const rationales = (optionalArray(raw['rationales'], `${label}.rationales`) ?? []).map((entry, index) => {
    const item = obj(entry, `${label}.rationales[${index}]`);
    assertNonEmpty(item['path'], `${label}.rationales[${index}].path`, fail);
    if (typeof item['quoteFound'] !== 'boolean') throw fail(`${label}.rationales[${index}].quoteFound must be a boolean`);
    return withDefined({ path: item['path'] as string, quote: typeof item['quote'] === 'string' ? item['quote'] : undefined, quoteFound: item['quoteFound'], note: typeof item['note'] === 'string' ? item['note'] : undefined });
  });
  const dropped = (optionalArray(raw['dropped'], `${label}.dropped`) ?? []).map((entry, index) => {
    const item = obj(entry, `${label}.dropped[${index}]`);
    assertNonEmpty(item['path'], `${label}.dropped[${index}].path`, fail);
    assertNonEmpty(item['reason'], `${label}.dropped[${index}].reason`, fail);
    return { path: item['path'] as string, reason: item['reason'] as string };
  });
  const warnings = optionalArray(raw['warnings'], `${label}.warnings`) ?? [];
  if (warnings.some((warning) => typeof warning !== 'string')) throw fail(`${label}.warnings must be strings`);
  return { candidate: candidate as ProposedPolicyPatch, rationales, dropped, warnings: warnings as string[] };
}

export function createExpensePolicyHearing(props: ExpensePolicyHearing): ExpensePolicyHearing {
  if (props === null || typeof props !== 'object') throw fail('expense policy hearing: props are required');
  const tenant = obj(props.tenant, 'expense policy hearing: tenant');
  assertNonEmpty(tenant['tenantId'], 'expense policy hearing: tenant.tenantId', fail);
  assertNonEmpty(tenant['workspaceId'], 'expense policy hearing: tenant.workspaceId', fail);
  assertNonEmpty(props.id, 'expense policy hearing: id', fail);
  if (!HEARING_MODES.includes(props.mode)) throw fail(`expense policy hearing: mode must be one of ${HEARING_MODES.join(', ')}`);
  if (!HEARING_STATUSES.includes(props.status)) throw fail(`expense policy hearing: status must be one of ${HEARING_STATUSES.join(', ')}`);
  const source = obj(props.source, 'expense policy hearing: source');
  const documentText = source['documentText'];
  if (documentText !== undefined && (typeof documentText !== 'string' || documentText.length > HEARING_DOCUMENT_MAX)) throw fail(`expense policy hearing: source.documentText must be at most ${HEARING_DOCUMENT_MAX} characters`);
  if (props.mode === 'document' && (typeof documentText !== 'string' || documentText.trim() === '')) throw fail('expense policy hearing: a document hearing needs source.documentText');
  const sections = optionalArray(source['sections'], 'expense policy hearing: source.sections')?.map((entry, index) => {
    const item = obj(entry, `expense policy hearing: source.sections[${index}]`);
    if (typeof item['heading'] !== 'string' || typeof item['start'] !== 'number' || typeof item['end'] !== 'number' || item['start'] > item['end']) throw fail(`expense policy hearing: source.sections[${index}] must be { heading, start, end }`);
    return { heading: item['heading'], start: item['start'], end: item['end'] };
  });
  const turns = (props.turns ?? []).map((turn, index) => validateTurn(turn, `expense policy hearing: turns[${index}]`));
  if (turns.length > HEARING_MAX_TURNS) throw fail(`expense policy hearing: turns must have at most ${HEARING_MAX_TURNS} entries`);
  const proposal = props.proposal === undefined ? undefined : validateProposal(props.proposal, 'expense policy hearing: proposal');
  if ((props.status === 'proposed' || props.status === 'accepted') && proposal === undefined) throw fail(`expense policy hearing: a ${props.status} hearing must have a proposal`);
  const accepted = props.acceptedChangeIds;
  if (accepted !== undefined && (!Array.isArray(accepted) || accepted.some((id) => typeof id !== 'string'))) throw fail('expense policy hearing: acceptedChangeIds must be strings');
  if (props.status === 'accepted' && accepted === undefined) throw fail('expense policy hearing: an accepted hearing must have acceptedChangeIds');
  let model: ExpensePolicyHearing['model'];
  if (props.model !== undefined) {
    const raw = obj(props.model, 'expense policy hearing: model');
    if (typeof raw['provider'] !== 'string' || typeof raw['model'] !== 'string') throw fail('expense policy hearing: model must be { provider, model }');
    model = { provider: raw['provider'], model: raw['model'] };
  }
  assertIsoDateTime(props.basePolicyUpdatedAt, 'expense policy hearing: basePolicyUpdatedAt', fail);
  assertNonEmpty(props.promptVersion, 'expense policy hearing: promptVersion', fail);
  assertIsoDateTime(props.createdAt, 'expense policy hearing: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'expense policy hearing: updatedAt', fail);
  return withDefined({
    tenant: { tenantId: tenant['tenantId'] as string, workspaceId: tenant['workspaceId'] as string },
    id: props.id,
    mode: props.mode,
    source: withDefined({ documentText: documentText as string | undefined, fileName: typeof source['fileName'] === 'string' ? source['fileName'] : undefined, sha256: typeof source['sha256'] === 'string' ? source['sha256'] : undefined, sections }),
    status: props.status,
    turns,
    proposal,
    basePolicyUpdatedAt: props.basePolicyUpdatedAt,
    acceptedChangeIds: accepted === undefined ? undefined : [...accepted],
    model,
    promptVersion: props.promptVersion,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}

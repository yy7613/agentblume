/**
 * ドメイン: ヒアリングセッション（HearingSession）集約（docs/20 §2.5 / §7。Stage 2）。
 *
 * 質問（assistant）と回答（user）の列を持ち、最後に提案（ルール草案 + 仕訳草案 + 新科目）を付ける。
 * 状態: `open` → `proposed` → `accepted` / `cancelled`。フェーズ 1 では集約とリポジトリだけを用意し、
 * LLM による質問生成・提案はフェーズ 2 が載せる。
 *
 * 形は UI の `JournalHearingDto` と同型（テナントスコープ `tenant` を除く）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import type { Account, TaxCategory } from './chart-of-accounts';
import type { JsonValue } from './document';
import type { JournalEntryDraft } from './entry';
import { JournalDomainError } from './errors';
import type { JournalDocumentId, JournalHearingId } from './ids';
import type { JournalRuleDraft } from './rule';

export const HEARING_STATUSES = ['open', 'proposed', 'accepted', 'cancelled'] as const;
export type HearingStatus = (typeof HEARING_STATUSES)[number];

export const HEARING_QUESTION_KINDS = ['single', 'multi', 'text', 'number', 'confirm'] as const;
export type HearingQuestionKind = (typeof HEARING_QUESTION_KINDS)[number];

export interface HearingQuestion {
  readonly id: string;
  readonly text: string;
  readonly kind: HearingQuestionKind;
  readonly options?: readonly { readonly value: string; readonly label: string; readonly hint?: string }[];
  /** 回答を書き戻す facts のパス（例 `extra.purpose`）。 */
  readonly factPath?: string;
  readonly catalogId?: string;
  readonly note?: string;
}

export type HearingTurn =
  | { readonly role: 'assistant'; readonly question: HearingQuestion; readonly at: string }
  | { readonly role: 'user'; readonly answer: { readonly questionId: string; readonly value: JsonValue }; readonly at: string };

export interface HearingProposal {
  readonly rule: JournalRuleDraft;
  readonly entry: JournalEntryDraft;
  readonly newAccounts: readonly Omit<Account, 'sortOrder' | 'enabled'>[];
  readonly newDimensionValues: readonly { readonly dimensionId: string; readonly id: string; readonly name: string }[];
  readonly newTaxCategories: readonly Omit<TaxCategory, 'enabled'>[];
  readonly rationale: string;
  readonly warnings: readonly string[];
}

export interface HearingSession {
  readonly tenant: TenantScope;
  readonly id: JournalHearingId;
  readonly documentId: JournalDocumentId;
  readonly status: HearingStatus;
  readonly turns: readonly HearingTurn[];
  readonly proposal?: HearingProposal;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateHearingSessionProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly documentId: string;
  readonly status?: HearingStatus;
  readonly turns?: readonly HearingTurn[];
  readonly proposal?: HearingProposal;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const HEARING_MAX_TURNS = 60;

const fail: ErrorFactory = (message) => new JournalDomainError(message);

function validateTurn(value: HearingTurn, index: number): HearingTurn {
  const label = `createHearingSession: turns[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertIsoDateTime(value.at, `${label}.at`, fail);
  if (value.role === 'assistant') {
    const question = value.question;
    if (question === null || typeof question !== 'object') throw fail(`${label}.question must be an object`);
    assertNonEmpty(question.id, `${label}.question.id`, fail);
    assertNonEmpty(question.text, `${label}.question.text`, fail);
    if (!HEARING_QUESTION_KINDS.includes(question.kind)) throw fail(`${label}.question.kind must be one of ${HEARING_QUESTION_KINDS.join(', ')}`);
    if (question.options !== undefined && (!Array.isArray(question.options) || question.options.some((option) => typeof option?.value !== 'string' || typeof option?.label !== 'string'))) {
      throw fail(`${label}.question.options must be an array of { value, label }`);
    }
    return { role: 'assistant', question: structuredClone(question), at: value.at };
  }
  if (value.role === 'user') {
    if (value.answer === null || typeof value.answer !== 'object') throw fail(`${label}.answer must be an object`);
    assertNonEmpty(value.answer.questionId, `${label}.answer.questionId`, fail);
    if (value.answer.value === undefined) throw fail(`${label}.answer.value is required`);
    return { role: 'user', answer: { questionId: value.answer.questionId, value: structuredClone(value.answer.value) }, at: value.at };
  }
  throw fail(`${label}.role must be assistant or user`);
}

function validateProposal(value: HearingProposal): HearingProposal {
  const label = 'createHearingSession: proposal';
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  if (value.rule === null || typeof value.rule !== 'object') throw fail(`${label}.rule must be an object`);
  if (value.entry === null || typeof value.entry !== 'object') throw fail(`${label}.entry must be an object`);
  if (typeof value.rationale !== 'string') throw fail(`${label}.rationale must be a string`);
  for (const key of ['newAccounts', 'newDimensionValues', 'newTaxCategories', 'warnings'] as const) {
    if (!Array.isArray(value[key])) throw fail(`${label}.${key} must be an array`);
  }
  return structuredClone(value);
}

/** ヒアリングを組み立てて不変条件を検証する。`id` が無いときは `makeId` で生成する。 */
export function createHearingSession(props: CreateHearingSessionProps, makeId?: () => string): HearingSession {
  if (props === null || typeof props !== 'object') throw fail('createHearingSession: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('createHearingSession: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'createHearingSession: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'createHearingSession: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createHearingSession: id', fail);
  assertNonEmpty(props.documentId, 'createHearingSession: documentId', fail);
  const status = props.status ?? 'open';
  if (!HEARING_STATUSES.includes(status)) throw fail(`createHearingSession: status must be one of ${HEARING_STATUSES.join(', ')}`);
  const turns = props.turns ?? [];
  if (!Array.isArray(turns)) throw fail('createHearingSession: turns must be an array');
  if (turns.length > HEARING_MAX_TURNS) throw fail(`createHearingSession: turns must have at most ${HEARING_MAX_TURNS} entries`);
  assertIsoDateTime(props.createdAt, 'createHearingSession: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createHearingSession: updatedAt', fail);
  if (status === 'proposed' && props.proposal === undefined) throw fail('createHearingSession: a proposed hearing must have a proposal');
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    documentId: props.documentId,
    status,
    turns: turns.map(validateTurn),
    ...(props.proposal === undefined ? {} : { proposal: validateProposal(props.proposal) }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 質問または回答を追加する（open のときだけ）。 */
export function appendTurn(session: HearingSession, turn: HearingTurn, at: string): HearingSession {
  assertIsoDateTime(at, 'appendTurn: at', fail);
  if (session.status !== 'open') throw fail(`appendTurn: a ${session.status} hearing does not accept turns`);
  if (session.turns.length >= HEARING_MAX_TURNS) throw fail(`appendTurn: turns must have at most ${HEARING_MAX_TURNS} entries`);
  if (turn.role === 'user' && !session.turns.some((entry) => entry.role === 'assistant' && entry.question.id === turn.answer.questionId)) {
    throw fail(`appendTurn: unknown questionId: ${turn.answer.questionId}`);
  }
  return { ...session, turns: [...session.turns, validateTurn(turn, session.turns.length)], updatedAt: at };
}

/** 提案を付けて `proposed` にする（open のときだけ）。 */
export function attachProposal(session: HearingSession, proposal: HearingProposal, at: string): HearingSession {
  assertIsoDateTime(at, 'attachProposal: at', fail);
  if (session.status !== 'open') throw fail(`attachProposal: a ${session.status} hearing cannot receive a proposal`);
  return { ...session, status: 'proposed', proposal: validateProposal(proposal), updatedAt: at };
}

/** 提案を受け入れて閉じる（proposed のときだけ）。 */
export function acceptHearing(session: HearingSession, at: string): HearingSession {
  assertIsoDateTime(at, 'acceptHearing: at', fail);
  if (session.status !== 'proposed') throw fail(`acceptHearing: only a proposed hearing can be accepted (status: ${session.status})`);
  return { ...session, status: 'accepted', updatedAt: at };
}

/** 中止する（open / proposed のとき。accepted は戻せない、cancelled は冪等）。 */
export function cancelHearing(session: HearingSession, at: string): HearingSession {
  assertIsoDateTime(at, 'cancelHearing: at', fail);
  if (session.status === 'cancelled') return session;
  if (session.status === 'accepted') throw fail('cancelHearing: an accepted hearing cannot be cancelled');
  return { ...session, status: 'cancelled', updatedAt: at };
}

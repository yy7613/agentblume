import { describe, expect, it } from 'vitest';
import { JournalDomainError } from './errors';
import { acceptHearing, appendTurn, attachProposal, cancelHearing, createHearingSession, HEARING_MAX_TURNS, type HearingProposal, type HearingTurn } from './hearing';

const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-13T00:00:00.000Z';
const later = '2026-09-13T01:00:00.000Z';
const question: HearingTurn = { role: 'assistant', question: { id: 'q1', text: '誰との飲食ですか？', kind: 'single', options: [{ value: 'entertainment', label: '接待' }], factPath: 'extra.purpose', catalogId: 'meal_purpose' }, at };
const answer: HearingTurn = { role: 'user', answer: { questionId: 'q1', value: 'entertainment' }, at: later };
const proposal: HearingProposal = {
  rule: { name: 'r', enabled: true, mode: 'auto', priority: 1, scope: {}, conditions: [], outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: 'total' }] }, askIf: [], requiredFacts: [] },
  entry: { date: '2026-09-13', lines: [], description: '', invoiceStatus: 'none' },
  newAccounts: [], newDimensionValues: [], newTaxCategories: [], rationale: 'because', warnings: [],
};

describe('createHearingSession', () => {
  it('正常: 既定 open・turns 空。turns / proposal を受ける', () => {
    expect(createHearingSession({ tenant, id: 'h1', documentId: 'd1', createdAt: at, updatedAt: at })).toEqual({ tenant, id: 'h1', documentId: 'd1', status: 'open', turns: [], createdAt: at, updatedAt: at });
    const full = createHearingSession({ tenant, documentId: 'd1', status: 'proposed', turns: [question, answer], proposal, createdAt: at, updatedAt: at }, () => 'gen');
    expect(full.id).toBe('gen');
    expect(full.turns).toEqual([question, answer]);
    expect(full.proposal).toEqual(proposal);
  });

  it('異常: proposed に提案が無い、turn の形、status の列挙、上限', () => {
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', status: 'proposed', createdAt: at, updatedAt: at })).toThrow(new JournalDomainError('createHearingSession: a proposed hearing must have a proposal'));
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', turns: [{ role: 'user', answer: { questionId: '', value: 1 }, at }], createdAt: at, updatedAt: at })).toThrow(/turns\[0\]\.answer\.questionId must be a non-empty string/u);
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', turns: [{ role: 'assistant', question: { id: 'q', text: 't', kind: 'yesno' as 'confirm' }, at }], createdAt: at, updatedAt: at })).toThrow(/question\.kind must be one of/u);
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', status: 'done' as 'open', createdAt: at, updatedAt: at })).toThrow(/status must be one of/u);
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', turns: Array.from({ length: HEARING_MAX_TURNS + 1 }, () => question), createdAt: at, updatedAt: at })).toThrow(/turns must have at most/u);
  });

  it('例外: tenant / documentId / 時刻', () => {
    expect(() => createHearingSession({ tenant: { tenantId: 't', workspaceId: '' }, id: 'h', documentId: 'd', createdAt: at, updatedAt: at })).toThrow(/tenant\.workspaceId/u);
    expect(() => createHearingSession({ tenant, id: 'h', documentId: '', createdAt: at, updatedAt: at })).toThrow(/documentId must be a non-empty string/u);
    expect(() => createHearingSession({ tenant, id: 'h', documentId: 'd', createdAt: 'x', updatedAt: at })).toThrow(/createdAt must be an ISO 8601/u);
  });
});

describe('transitions', () => {
  const session = createHearingSession({ tenant, id: 'h1', documentId: 'd1', createdAt: at, updatedAt: at });

  it('正常: 質問 → 回答 → 提案 → 受入', () => {
    const asked = appendTurn(session, question, at);
    const answered = appendTurn(asked, answer, later);
    expect(answered.turns).toHaveLength(2);
    const proposed = attachProposal(answered, proposal, later);
    expect(proposed.status).toBe('proposed');
    expect(acceptHearing(proposed, later)).toMatchObject({ status: 'accepted', updatedAt: later });
  });

  it('異常: 未知の質問への回答、open 以外への追加、open 以外への提案', () => {
    expect(() => appendTurn(session, answer, later)).toThrow(/unknown questionId: q1/u);
    const cancelled = cancelHearing(session, later);
    expect(() => appendTurn(cancelled, question, later)).toThrow(/cancelled hearing does not accept turns/u);
    expect(() => attachProposal(cancelled, proposal, later)).toThrow(/cancelled hearing cannot receive a proposal/u);
  });

  it('異常 / 境界: open の受入は不可、accepted の中止は不可、cancelled の中止は冪等', () => {
    expect(() => acceptHearing(session, later)).toThrow(/only a proposed hearing can be accepted/u);
    const accepted = acceptHearing(attachProposal(session, proposal, later), later);
    expect(() => cancelHearing(accepted, later)).toThrow(/accepted hearing cannot be cancelled/u);
    const cancelled = cancelHearing(session, later);
    expect(cancelHearing(cancelled, later)).toBe(cancelled);
    expect(cancelHearing(attachProposal(session, proposal, later), later).status).toBe('cancelled');
  });
});

import { describe, expect, it } from 'vitest';
import { ContractDomainError, ContractStateError } from './errors';
import { completeDeadline, computeDeadlines, contractDisplayStatus, createSignedContract, mergeDeadlines, refreshSignedContract, signingWarnings, terminateSignedContract, type Deadline, type SignedClause, type SignedContract } from './signed-contract';

const tenant = { tenantId: 't1', workspaceId: 'w1' };
const NOW = '2026-09-15T09:00:00.000Z';

const termClause = (value: Partial<Extract<SignedClause['value'], { kind: 'term' }>> = {}, articleRef: string | null = '第3条'): SignedClause => ({
  topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, quoteVerified: true, ...(articleRef === null ? {} : { articleRef }),
  value: { kind: 'term', startsOnSigning: false, ...value },
});
const renewalClause = (renewalMonths: number | undefined, sameAsInitial = false, articleRef: string | null = '第4条'): SignedClause => ({
  topicId: 'auto_renewal', topicLabel: '自動更新', valueKind: 'auto_renewal', present: true, quoteVerified: true, ...(articleRef === null ? {} : { articleRef }),
  value: { kind: 'auto_renewal', renews: true, ...(renewalMonths === undefined ? {} : { renewalMonths }), sameAsInitial },
});
const noticeClause = (amount: number, unit: 'day' | 'month', businessDays = false, articleRef: string | null = '第4条第2項'): SignedClause => ({
  topicId: 'renewal_notice', topicLabel: '更新拒絶の通知期限', valueKind: 'notice', present: true, quoteVerified: true, ...(articleRef === null ? {} : { articleRef }),
  value: { kind: 'notice', amount, unit, anchor: 'expiry', businessDays },
});

const renewing = [termClause({ startDate: '2025-04-01', durationMonths: 12 }), renewalClause(12), noticeClause(3, 'month')];

const contract = (overrides: Partial<SignedContract> = {}): SignedContract => createSignedContract({
  tenant, id: 'sc1', documentId: 'doc1', title: '業務委託契約', counterpartyName: '株式会社テスト', signedDate: '2025-03-15', signingMethod: 'paper',
  clauses: renewing, deadlines: [], status: 'active', reviewVerdicts: {}, warnings: [], createdAt: NOW, updatedAt: NOW, ...overrides,
});

describe('signed-contract: computeDeadlines', () => {
  it('正常: 自動更新の契約は現在期（2 期目）の満了・更新・通知期限を出す', () => {
    const computed = computeDeadlines(renewing, '2025-03-15', '2026-09-15');
    expect(computed.autoRenewal).toBe(true);
    expect(computed.warnings).toEqual([]);
    expect(computed.schedule?.current).toEqual({ index: 2, start: '2026-04-01', end: '2027-03-31' });
    expect(computed.deadlines).toEqual([
      { id: 'expiry-2', kind: 'expiry', dueDate: '2027-03-31', basis: '第3条: 満了日', termIndex: 2, termEnd: '2027-03-31', status: 'open' },
      { id: 'renewal-2', kind: 'renewal', dueDate: '2027-04-01', basis: '第4条: 満了の翌日に更新', termIndex: 2, termEnd: '2027-03-31', status: 'open' },
      { id: 'renewal_notice-2', kind: 'renewal_notice', dueDate: '2026-12-31', basis: '第4条第2項: 満了の3か月前まで', termIndex: 2, termEnd: '2027-03-31', status: 'open' },
    ]);
  });

  it('正常: 日数の通知期限（R6）と、条番号が無いときの根拠の既定文言', () => {
    const computed = computeDeadlines([termClause({ startDate: '2026-04-01', durationMonths: 12 }, null), renewalClause(12, false, null), noticeClause(30, 'day', false, null)], undefined, '2026-09-15');
    expect(computed.deadlines.map((deadline) => [deadline.kind, deadline.dueDate, deadline.basis])).toEqual([
      ['expiry', '2027-03-31', '契約期間の条項: 満了日'],
      ['renewal', '2027-04-01', '自動更新の条項: 満了の翌日に更新'],
      ['renewal_notice', '2027-03-01', '更新拒絶の条項: 満了の30日前まで'],
    ]);
  });

  it('異常: 期間の条項が無い（または present = false）なら期限を出さず直し方を返す', () => {
    for (const clauses of [[renewalClause(12)], [{ ...termClause({ startDate: '2026-04-01', durationMonths: 12 }), present: false }, renewalClause(12)]]) {
      const computed = computeDeadlines(clauses, '2026-04-01', '2026-09-15');
      expect(computed).toEqual({ autoRenewal: true, deadlines: [], warnings: [{ message: expect.stringContaining('契約期間の条項が無い') as string }] });
    }
  });

  it('境界: R3 締結日始まりで締結日が未定なら期限を出さない', () => {
    const computed = computeDeadlines([termClause({ startsOnSigning: true, durationMonths: 12 })], undefined, '2026-09-15');
    expect(computed.deadlines).toEqual([]);
    expect(computed.warnings[0]!.message).toContain('締結日が未定');
  });

  it('正常: R3 締結日始まりは締結日を始期にする（遡及の警告は出さない）', () => {
    const computed = computeDeadlines([termClause({ startsOnSigning: true, durationMonths: 12 })], '2026-04-01', '2026-09-15');
    expect(computed.deadlines).toEqual([{ id: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31', basis: '第3条: 満了日', termIndex: 1, termEnd: '2027-03-31', status: 'open' }]);
    expect(computed.warnings).toEqual([]);
    expect(computed.autoRenewal).toBe(false);
  });

  it('正常: G6 締結日が始期より後なら遡及の警告', () => {
    const computed = computeDeadlines(renewing, '2025-05-01', '2026-09-15');
    expect(computed.warnings).toEqual([{ message: '締結日 2025-05-01 が始期 2025-04-01 より後です（遡って始まる契約）。' }]);
  });

  it('異常: 満了日が決まらなければ期限を出さない', () => {
    const computed = computeDeadlines([termClause({ startDate: '2026-04-01' })], '2026-04-01', '2026-09-15');
    expect(computed.deadlines).toEqual([]);
    expect(computed.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('満了日を計算できません')]);
  });

  it('異常: 更新期間が読めなければ警告し、更新・通知の期限は出さない', () => {
    const computed = computeDeadlines([termClause({ startDate: '2026-04-01', durationMonths: 12 }), renewalClause(undefined), noticeClause(3, 'month')], undefined, '2026-09-15');
    expect(computed.deadlines.map((deadline) => deadline.kind)).toEqual(['expiry']);
    expect(computed.warnings[0]!.message).toContain('自動更新の期間が読み取れない');
  });

  it('正常: 更新が「同一条件」なら初回の月数（満了日からの逆算を含む）で次の期を作る', () => {
    const computed = computeDeadlines([termClause({ startsOnSigning: true, endDate: '2026-03-31' }), renewalClause(undefined, true)], '2025-04-01', '2026-09-15');
    expect(computed.schedule?.current).toEqual({ index: 2, start: '2026-04-01', end: '2027-03-31' });
    expect(computed.deadlines.map((deadline) => deadline.id)).toEqual(['expiry-2', 'renewal-2']);
  });

  it('異常: 通知が営業日なら計算せず value-unparsed の警告', () => {
    const computed = computeDeadlines([termClause({ startDate: '2026-04-01', durationMonths: 12 }), renewalClause(12), noticeClause(10, 'day', true)], undefined, '2026-09-15');
    expect(computed.deadlines.map((deadline) => deadline.kind)).toEqual(['expiry', 'renewal']);
    expect(computed.warnings).toEqual([{ code: 'value-unparsed', message: expect.stringContaining('営業日') as string }]);
  });

  it('境界: 自動更新なしなら通知の条項があっても満了日だけ', () => {
    const noRenewal: SignedClause = { ...renewalClause(12), value: { kind: 'auto_renewal', renews: false, sameAsInitial: false } };
    const computed = computeDeadlines([termClause({ startDate: '2026-04-01', durationMonths: 12 }), noRenewal, noticeClause(3, 'month')], undefined, '2026-09-15');
    expect(computed.deadlines.map((deadline) => deadline.kind)).toEqual(['expiry']);
  });

  it('例外: 100 期で打ち切ったら警告する', () => {
    const computed = computeDeadlines([termClause({ startDate: '2000-01-01', durationMonths: 1 }), renewalClause(1)], undefined, '2026-09-15');
    expect(computed.schedule?.truncated).toBe(true);
    expect(computed.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('100 期')]);
    expect(computed.deadlines[0]!.id).toBe('expiry-100');
  });
});

describe('signed-contract: signingWarnings（G7）', () => {
  it('正常: 現在期の通知期限が過ぎていれば notice-deadline-passed を足す', () => {
    const computed = computeDeadlines(renewing, '2025-05-01', '2027-01-05');
    expect(signingWarnings(computed, '2027-01-05')).toEqual([
      computed.warnings[0],
      { code: 'notice-deadline-passed', message: '更新拒絶の通知期限 2026-12-31 は既に過ぎています（締結登録時点）。' },
    ]);
  });

  it('境界: 通知期限の当日はまだ過ぎていない', () => {
    expect(signingWarnings(computeDeadlines(renewing, '2025-03-15', '2026-12-31'), '2026-12-31')).toEqual([]);
  });
});

describe('signed-contract: mergeDeadlines', () => {
  const deadline = (id: string, kind: Deadline['kind'], dueDate: string, status: Deadline['status'] = 'open', extra: Partial<Deadline> = {}): Deadline => ({ id, kind, dueDate, basis: 'b', status, ...extra });

  it('正常: 完了を保持し、消えた未完了は superseded、custom はそのまま、期限日順に並べる', () => {
    const existing = [
      deadline('expiry-1', 'expiry', '2026-03-31'),
      deadline('renewal_notice-1', 'renewal_notice', '2025-12-31', 'done', { completedAt: 'c1' }),
      deadline('custom-1', 'custom', '2026-10-01'),
      deadline('renewal_notice-2', 'renewal_notice', '2026-12-31', 'done', { completedAt: 'c2' }),
      deadline('renewal-1', 'renewal', '2026-04-01', 'superseded'),
    ];
    const computed = [deadline('expiry-2', 'expiry', '2027-03-31'), deadline('renewal-2', 'renewal', '2027-04-01'), deadline('renewal_notice-2', 'renewal_notice', '2026-12-31')];
    expect(mergeDeadlines(existing, computed).map((entry) => [entry.id, entry.status])).toEqual([
      ['renewal_notice-1', 'done'], ['expiry-1', 'superseded'], ['renewal-1', 'superseded'], ['custom-1', 'open'], ['renewal_notice-2', 'done'], ['expiry-2', 'open'], ['renewal-2', 'open'],
    ]);
  });

  it('境界: 同じ id の未完了は計算し直した方で置き換え、同じ期限日は id 順', () => {
    const merged = mergeDeadlines([deadline('expiry-1', 'expiry', '2026-03-30', 'open', { basis: 'old' })], [deadline('renewal-1', 'renewal', '2026-03-31'), deadline('expiry-1', 'expiry', '2026-03-31')]);
    expect(merged.map((entry) => [entry.id, entry.dueDate, entry.basis])).toEqual([['expiry-1', '2026-03-31', 'b'], ['renewal-1', '2026-03-31', 'b']]);
  });
});

describe('signed-contract: refreshSignedContract', () => {
  it('正常: 期が進んだら前の期を superseded にして次の期を足す', () => {
    const registered = contract({ deadlines: computeDeadlines(renewing, '2025-03-15', '2025-09-15').deadlines });
    const refreshed = refreshSignedContract(registered, '2026-09-15', 'later');
    expect(refreshed.updatedAt).toBe('later');
    expect(refreshed.deadlines.map((entry) => [entry.id, entry.status])).toEqual([
      ['renewal_notice-1', 'superseded'], ['expiry-1', 'superseded'], ['renewal-1', 'superseded'], ['renewal_notice-2', 'open'], ['expiry-2', 'open'], ['renewal-2', 'open'],
    ]);
  });

  it('境界: 変わらなければ同じオブジェクトを返す（保存しない）', () => {
    const current = contract({ deadlines: mergeDeadlines([], computeDeadlines(renewing, '2025-03-15', '2026-09-15').deadlines) });
    expect(refreshSignedContract(current, '2026-09-15', 'later')).toBe(current);
  });

  it('境界: 終了した契約は計算しない', () => {
    const terminated = contract({ status: 'terminated', terminatedAt: '2026-01-01' });
    expect(refreshSignedContract(terminated, '2030-01-01', 'later')).toBe(terminated);
  });
});

describe('signed-contract: completeDeadline / terminateSignedContract', () => {
  const withDeadlines = () => contract({ deadlines: [
    { id: 'expiry-2', kind: 'expiry', dueDate: '2027-03-31', basis: 'b', status: 'open' },
    { id: 'renewal_notice-2', kind: 'renewal_notice', dueDate: '2026-12-31', basis: 'b', status: 'open' },
    { id: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2025-12-31', basis: 'b', status: 'done', completedAt: 'c' },
  ] });

  it('正常: 期限を完了にしてメモ（500 文字まで）を残す', () => {
    const done = completeDeadline(withDeadlines(), 'renewal_notice-2', 'later', 'x'.repeat(600));
    expect(done.deadlines.find((entry) => entry.id === 'renewal_notice-2')).toEqual({ id: 'renewal_notice-2', kind: 'renewal_notice', dueDate: '2026-12-31', basis: 'b', status: 'done', completedAt: 'later', note: 'x'.repeat(500) });
    expect(done.updatedAt).toBe('later');
    expect(completeDeadline(withDeadlines(), 'expiry-2', 'later', '').deadlines[0]).not.toHaveProperty('note');
  });

  it('例外: 無い期限は ContractDomainError、完了済みは ContractStateError', () => {
    expect(() => completeDeadline(withDeadlines(), 'nope', 'later')).toThrowError(ContractDomainError);
    let caught: unknown;
    try { completeDeadline(withDeadlines(), 'renewal_notice-1', 'later'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContractStateError);
    expect((caught as ContractStateError).target).toEqual({ contractId: 'sc1' });
  });

  it('正常: 終了すると未完了の期限を superseded にし、理由を 500 文字まで残す', () => {
    const terminated = terminateSignedContract(withDeadlines(), '2026-10-01', 'y'.repeat(600), 'later');
    expect(terminated).toMatchObject({ status: 'terminated', terminatedAt: '2026-10-01', terminationReason: 'y'.repeat(500), updatedAt: 'later' });
    expect(terminated.deadlines.map((entry) => entry.status)).toEqual(['superseded', 'superseded', 'done']);
    expect(terminateSignedContract(withDeadlines(), '2026-10-01', '', 'later')).not.toHaveProperty('terminationReason');
    expect(terminateSignedContract(withDeadlines(), '2026-10-01', undefined, 'later')).not.toHaveProperty('terminationReason');
  });

  it('例外: 二重の終了は ContractStateError、終了日が暦に無ければ ContractDomainError', () => {
    const terminated = terminateSignedContract(withDeadlines(), '2026-10-01', undefined, 'later');
    expect(() => terminateSignedContract(terminated, '2026-10-02', undefined, 'later')).toThrowError(ContractStateError);
    expect(() => terminateSignedContract(withDeadlines(), '2026-02-30', undefined, 'later')).toThrowError(ContractDomainError);
  });
});

describe('signed-contract: contractDisplayStatus', () => {
  const fixed = [termClause({ startDate: '2025-04-01', durationMonths: 12 })];
  it.each([
    ['自動更新なしで満了日を過ぎた', contract({ clauses: fixed }), '2026-04-01', 'expired'],
    ['自動更新なしで満了日当日', contract({ clauses: fixed }), '2026-03-31', 'active'],
    ['自動更新あり', contract(), '2030-01-01', 'active'],
    ['期間が無い', contract({ clauses: [] }), '2030-01-01', 'active'],
    ['保存済みの expired', contract({ status: 'expired' }), '2020-01-01', 'expired'],
    ['終了済み', contract({ status: 'terminated', terminatedAt: '2026-01-01' }), '2020-01-01', 'terminated'],
  ] as const)('正常/境界: %s → %s', (_label, value, today, expected) => {
    expect(contractDisplayStatus(value, today)).toBe(expected);
  });
});

describe('signed-contract: createSignedContract', () => {
  it('正常: 表記をトリムし、判断と警告を正規化する', () => {
    const created = createSignedContract({ ...contract(), title: ' 契約 ', counterpartyName: ' 相手 ', reviewVerdicts: undefined as unknown as SignedContract['reviewVerdicts'], warnings: [{ message: 1 as unknown as string }, { code: 'notice-deadline-passed', message: 'm' }], stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: null } });
    expect([created.title, created.counterpartyName]).toEqual(['契約', '相手']);
    expect(created.reviewVerdicts).toEqual({});
    expect(created.warnings).toEqual([{ message: '1' }, { code: 'notice-deadline-passed', message: 'm' }]);
    expect(createSignedContract({ ...contract(), warnings: undefined as unknown as [] }).warnings).toEqual([]);
  });

  const valid = contract();
  const deadline: Deadline = { id: 'd1', kind: 'custom', dueDate: '2026-10-01', basis: '報告期限', status: 'open' };
  const cases: readonly [string, unknown, RegExp][] = [
    ['props が null', null, /props must be an object/u],
    ['tenant なし', { ...valid, tenant: undefined }, /tenant is required/u],
    ['id が空', { ...valid, id: '' }, /id is required/u],
    ['documentId が空', { ...valid, documentId: '' }, /documentId is required/u],
    ['タイトルが空', { ...valid, title: ' ' }, /title must be a non-empty string/u],
    ['タイトル 201 文字', { ...valid, title: 'x'.repeat(201) }, /title must be/u],
    ['相手方名が空', { ...valid, counterpartyName: '' }, /counterpartyName must be a non-empty string .*enter the counterparty on the sign step/u],
    ['締結日が暦に無い', { ...valid, signedDate: '2026-02-30' }, /signedDate must be a calendar date/u],
    ['締結方法が語彙外', { ...valid, signingMethod: 'fax' }, /signingMethod must be paper, electronic or unknown/u],
    ['自社が甲乙以外', { ...valid, ourParty: 'C' }, /ourParty must be A or B/u],
    ['状態が語彙外', { ...valid, status: 'void' }, /status must be active, expired or terminated/u],
    ['終了なのに終了日なし', { ...valid, status: 'terminated' }, /a terminated contract needs terminatedAt/u],
    ['条項が配列でない', { ...valid, clauses: {} }, /clauses must be an array/u],
    ['条項の valueKind が語彙外', { ...valid, clauses: [{ ...renewing[0], valueKind: 'date' }] }, /clauses\[0\] is malformed/u],
    ['条項の値が崩れている', { ...valid, clauses: [{ ...renewing[0], value: { kind: 'term' } }] }, /clauses\[0\]\.value: value does not match/u],
    ['期限が配列でない', { ...valid, deadlines: null }, /deadlines must be an array/u],
    ['期限 id の重複', { ...valid, deadlines: [deadline, deadline] }, /deadlines\[1\]\.id must be unique/u],
    ['期限 id が空', { ...valid, deadlines: [{ ...deadline, id: '' }] }, /deadlines\[0\]\.id must be unique/u],
    ['期限の種類が語彙外', { ...valid, deadlines: [{ ...deadline, kind: 'report' }] }, /deadlines\[0\]\.kind must be one of expiry, renewal_notice, renewal, custom/u],
    ['期限日が暦に無い', { ...valid, deadlines: [{ ...deadline, dueDate: '2026-13-01' }] }, /deadlines\[0\]\.dueDate must be a calendar date/u],
    ['期限の状態が語彙外', { ...valid, deadlines: [{ ...deadline, status: 'closed' }] }, /deadlines\[0\]\.status must be open, done or superseded/u],
    ['根拠が空', { ...valid, deadlines: [{ ...deadline, basis: ' ' }] }, /deadlines\[0\]\.basis must be a non-empty string of at most 300/u],
    ['根拠 301 文字', { ...valid, deadlines: [{ ...deadline, basis: 'x'.repeat(301) }] }, /deadlines\[0\]\.basis/u],
    ['印紙の貼付が文字列', { ...valid, stampDuty: { affixed: 'yes' } }, /stampDuty\.affixed must be true, false or null/u],
    ['印紙の金額が負', { ...valid, stampDuty: { affixed: true, amount: -1 } }, /stampDuty\.amount must be a non-negative integer/u],
  ];

  it.each(cases)('異常: %s', (_label, props, message) => {
    let caught: unknown;
    try { createSignedContract(props as SignedContract); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContractDomainError);
    expect((caught as Error).message).toMatch(message);
  });
});

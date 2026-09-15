import { describe, expect, it } from 'vitest';
import type { TenantScope } from '../shared/tenant-scope';
import {
  acknowledge, appendItems, approvalBlockers, approveClaim, CLAIM_MAX_HISTORY, CLAIM_MAX_ITEMS, claimantKeyOf, claimFingerprint, claimTotalAmount,
  createExpenseClaim, editClaim, isJudgmentStale, itemLabel, markSettled, putItem, removeItem, returnClaim, toExpenseClaimSummary,
  unacknowledgedReviewReasons, unapproveClaim, withJournalLink, withJudgment, withPolicyStaleness,
  type CreateExpenseClaimProps, type ExpenseClaim, type ExpenseItem,
} from './claim';
import { ExpenseDomainError, ExpenseItemNotFoundError, ExpenseTransitionError } from './errors';
import { verdictOf, type CheckReason, type StoredClaimJudgment } from './judgment';
import { createExpensePolicy, type ExpensePolicy } from './policy';
import type { ExpenseReasonCode } from './reason-codes';
import type { ReceiptFacts } from './receipt-facts';
import { defaultExpensePolicy } from './default-policy';

// domain のテストは adapters のフィクスチャを使えない（依存ルール domain-no-adapters）ので、同じ形をここで組み立てる
const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const AT = '2026-09-14T00:00:00.000Z';
const policyFixture = (updatedAt = AT): ExpensePolicy => defaultExpensePolicy(updatedAt);
function itemFixture(id: string, facts: Partial<ReceiptFacts> = {}, overrides: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id,
    categoryId: 'transport.taxi',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプル交通', amount: 3200, description: 'タクシー代', purpose: '客先訪問', ...facts },
    source: { type: 'manual' },
    extraction: { method: 'manual', warnings: [] },
    addedOn: '2026-09-14',
    ...overrides,
  };
}
function claimFixture(id: string, overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return createExpenseClaim({
    tenant: scope, id, claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部' }, period: { from: '2026-09-01', to: '2026-09-30' },
    items: [itemFixture('item-1')], acknowledgements: [], history: [{ type: 'created', by: 'tester', at: AT }], submittedBy: 'tester', createdAt: AT, updatedAt: AT,
    ...overrides,
  });
}

const T1 = '2026-09-15T00:00:00.000Z';
const T2 = '2026-09-16T00:00:00.000Z';
const POLICY = policyFixture(AT);
const selfApprovalPolicy: ExpensePolicy = createExpensePolicy({ ...POLICY, claimRules: { ...POLICY.claimRules, forbidSelfApproval: true } });

const review = (code: ExpenseReasonCode, itemId?: string): CheckReason => ({ code, severity: 'review', params: {}, ...(itemId === undefined ? {} : { itemId }) });
const ret = (code: ExpenseReasonCode, itemId?: string): CheckReason => ({ code, severity: 'return', params: {}, ...(itemId === undefined ? {} : { itemId }) });

/** その申請の現在の指紋で判定を作る（古くない判定）。 */
function judgmentFor(claim: Pick<ExpenseClaim, 'claimant' | 'period' | 'items'>, reasons: readonly CheckReason[] = [], policyUpdatedAt = POLICY.updatedAt): StoredClaimJudgment {
  return {
    verdict: verdictOf(reasons),
    items: claim.items.map((item) => { const own = reasons.filter((reason) => reason.itemId === item.id); return { itemId: item.id, verdict: verdictOf(own), reasons: own }; }),
    claimReasons: reasons.filter((reason) => reason.itemId === undefined),
    totals: { amount: claimTotalAmount(claim), byCategory: [] },
    searchKeysComplete: true,
    policyUpdatedAt,
    itemsFingerprint: claimFingerprint(claim),
    checkedAt: T1,
  };
}

function checked(reasons: readonly CheckReason[] = [], overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  const claim = claimFixture('c1', overrides);
  return withJudgment(claim, judgmentFor(claim, reasons), T1, 'checker');
}

function approved(overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return claimFixture('c1', { status: 'approved', approval: { by: 'boss', at: T1 }, ...overrides });
}

function transitionError(action: () => unknown): ExpenseTransitionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpenseTransitionError);
    return error as ExpenseTransitionError;
  }
  throw new Error('ExpenseTransitionError was not thrown');
}

describe('createExpenseClaim', () => {
  it('正常: 既定は draft・空の明細と履歴、id が無ければ makeId で作る', () => {
    const claim = createExpenseClaim({ tenant: scope, claimant: { name: ' 太郎 ', employeeCode: ' ' }, period: { from: '2026-09-01', to: '2026-09-30' }, submittedBy: 'u', createdAt: AT, updatedAt: AT }, () => 'generated');
    expect(claim).toEqual({ tenant: scope, id: 'generated', claimant: { name: '太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [], status: 'draft', acknowledgements: [], history: [], submittedBy: 'u', createdAt: AT, updatedAt: AT });
  });

  it('正常: 承認・精算・仕訳連携・差し戻し・確認済みを持つ申請を復元できる', () => {
    const claim = claimFixture('c1', {
      status: 'settled',
      title: ' 9 月分 ',
      acknowledgements: [{ itemId: 'item-1', code: 'purpose-missing', note: '口頭で確認', by: 'boss', at: T1 }],
      returnNote: { message: '直してください', reasons: [{ code: 'receipt-missing', itemId: 'item-1', severity: 'return' }, { code: 'claim-empty', severity: 'return' }], by: 'boss', at: T1 },
      approval: { by: 'boss', displayName: '上司', at: T1, comment: 'OK' },
      settlement: { settledAt: T2, by: 'acct', exportFileName: 'a.csv' },
      journalLink: { entries: [{ itemId: 'item-1', entryId: 'e1' }], complete: true, draftedAt: T2, by: 'acct', warnings: ['w'] },
    });
    expect(claim.title).toBe('9 月分');
    expect(claim.returnNote?.reasons).toEqual([{ code: 'receipt-missing', itemId: 'item-1', severity: 'return' }, { code: 'claim-empty', severity: 'return' }]);
    expect(claim.journalLink).toEqual({ entries: [{ itemId: 'item-1', entryId: 'e1' }], complete: true, draftedAt: T2, by: 'acct', warnings: ['w'] });
  });

  it('異常: 期間の逆転を拒否する', () => {
    expect(() => claimFixture('c1', { period: { from: '2026-09-30', to: '2026-09-01' } })).toThrow(/from must not be after/u);
  });

  it('境界: 期間は 366 日まで（367 日は拒否）', () => {
    expect(claimFixture('c1', { period: { from: '2026-01-01', to: '2027-01-01' } }).period.to).toBe('2027-01-01');
    expect(() => claimFixture('c1', { period: { from: '2026-01-01', to: '2027-01-02' } })).toThrow(/at most 366 days/u);
  });

  it('異常: approved なのに approval が無い・settled なのに settlement が無いと拒否する', () => {
    expect(() => claimFixture('c1', { status: 'approved' })).toThrow(/an approved claim must have an approval/u);
    expect(() => claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 } })).toThrow(/a settled claim must have a settlement/u);
  });

  it('境界: 明細は 100 件まで（101 件は拒否）', () => {
    const items = (count: number): ExpenseItem[] => Array.from({ length: count }, (_, index) => itemFixture(`i${index}`));
    expect(claimFixture('c1', { items: items(CLAIM_MAX_ITEMS) }).items).toHaveLength(100);
    expect(() => claimFixture('c1', { items: items(CLAIM_MAX_ITEMS + 1) })).toThrow(/at most 100 entries/u);
  });

  it('境界: 復元時の履歴は新しい 200 件に切り詰める', () => {
    const history = Array.from({ length: CLAIM_MAX_HISTORY + 1 }, (_, index) => ({ type: 'edited' as const, at: AT, note: `n${index}` }));
    const claim = claimFixture('c1', { history });
    expect(claim.history).toHaveLength(200);
    expect(claim.history[0]?.note).toBe('n1');
  });

  it.each([
    ['props なし', null, /props are required/u],
    ['tenant なし', { tenant: null }, /tenant is required/u],
    ['id なし', { id: undefined }, /id/u],
    ['status', { status: 'open' }, /status must be one of/u],
    ['items の型', { items: 'x' }, /items must be an array/u],
    ['明細 id 重複', { items: [itemFixture('a'), itemFixture('a')] }, /duplicate item id: a/u],
    ['申請者名が空', { claimant: { name: ' ' } }, /claimant.name must be a non-empty string/u],
    ['申請者が object でない', { claimant: 'x' }, /claimant must be an object/u],
    ['期間が object でない', { period: null }, /period must be/u],
    ['期間の日付', { period: { from: '2026-09-01', to: '2026-09-31' } }, /to must be a date/u],
    ['確認済みのコード', { acknowledgements: [{ code: 'x', note: 'n', by: 'b', at: AT }] }, /code must be a reason code/u],
    ['確認済みの note 空', { acknowledgements: [{ code: 'purpose-missing', note: ' ', by: 'b', at: AT }] }, /note must be a non-empty string/u],
    ['確認済みが object でない', { acknowledgements: [null] }, /must be an object/u],
    ['差し戻しの文言なし', { returnNote: { message: '', reasons: [], by: 'b', at: AT } }, /returnNote.message/u],
    ['差し戻しの reasons', { returnNote: { message: 'm', reasons: 'x', by: 'b', at: AT } }, /returnNote.reasons must be an array/u],
    ['差し戻しの理由の形', { returnNote: { message: 'm', reasons: [{ code: 'claim-empty', severity: 'off' }], by: 'b', at: AT } }, /reasons\[0\]/u],
    ['仕訳連携の entries', { journalLink: { entries: [{ itemId: 1 }], complete: true, draftedAt: AT, by: 'b', warnings: [] } }, /journalLink.entries/u],
    ['仕訳連携の complete', { journalLink: { entries: [], complete: 'yes', draftedAt: AT, by: 'b', warnings: [] } }, /journalLink.complete/u],
    ['仕訳連携の warnings', { journalLink: { entries: [], complete: true, draftedAt: AT, by: 'b', warnings: [1] } }, /journalLink.warnings/u],
    ['履歴の type', { history: [{ type: 'deleted', at: AT }] }, /history\[0\]\.type/u],
    ['履歴が object でない', { history: [1] }, /history\[0\] must be an object/u],
    ['明細が object でない', { items: [null] }, /items\[0\] must be an object/u],
    ['明細 id なし', { items: [{ ...itemFixture('a'), id: '' }] }, /id must be a non-empty string/u],
    ['明細の source', { items: [{ ...itemFixture('a'), source: null }] }, /source must be an object/u],
    ['明細の source.type', { items: [{ ...itemFixture('a'), source: { type: 'fax' } }] }, /source.type must be one of/u],
    ['明細の source.row', { items: [{ ...itemFixture('a'), source: { type: 'csv-row', row: { a: 1 } } }] }, /source.row must be an object of strings/u],
    ['明細の extraction', { items: [{ ...itemFixture('a'), extraction: null }] }, /extraction must be an object/u],
    ['明細の extraction.method', { items: [{ ...itemFixture('a'), extraction: { method: 'ocr', warnings: [] } }] }, /extraction.method/u],
    ['明細の warnings', { items: [{ ...itemFixture('a'), extraction: { method: 'llm', warnings: [1] } }] }, /warnings must be an array of strings/u],
    ['明細の confidence', { items: [{ ...itemFixture('a'), extraction: { method: 'llm', warnings: [], confidence: 1.1 } }] }, /confidence must be between 0 and 1/u],
    ['明細の model', { items: [{ ...itemFixture('a'), extraction: { method: 'llm', warnings: [], model: { provider: 'x' } } }] }, /model must be/u],
    ['明細の addedOn', { items: [{ ...itemFixture('a'), addedOn: '2026/09/14' }] }, /addedOn must be a date/u],
  ])('異常: %s は ExpenseDomainError', (_label, overrides, message) => {
    const build = (): ExpenseClaim => (overrides === null
      ? createExpenseClaim(null as never)
      : claimFixture('c1', overrides as Partial<CreateExpenseClaimProps>));
    expect(build).toThrow(ExpenseDomainError);
    expect(build).toThrow(message);
  });

  it('正常: 明細の CSV 生値・モデル・確信度を複製する', () => {
    const claim = claimFixture('c1', { items: [itemFixture('a', {}, { source: { type: 'csv-row', row: { 金額: '100' } }, extraction: { method: 'llm', warnings: ['w'], model: { provider: 'p', model: 'm' }, confidence: 0.5, documentKind: 'receipt', rejectedRegistrationNumber: 'T1' } })] });
    expect(claim.items[0]).toMatchObject({ source: { type: 'csv-row', row: { 金額: '100' } }, extraction: { method: 'llm', model: { provider: 'p', model: 'm' }, confidence: 0.5, documentKind: 'receipt', rejectedRegistrationNumber: 'T1' } });
  });
});

describe('状態遷移: 編集', () => {
  it('正常: checked の申請を編集すると draft へ戻り、判定と確認済みが消える', () => {
    const base = checked([review('purpose-missing', 'item-1')]);
    const acked = acknowledge(base, { itemId: 'item-1', code: 'purpose-missing', note: '確認' }, 'boss', T1);
    const edited = editClaim(acked, { claimant: { name: '花子' }, period: { from: '2026-09-02', to: '2026-09-29' }, title: '出張' }, 'editor', T2);
    expect(edited.status).toBe('draft');
    expect(edited.judgment).toBeUndefined();
    expect(edited.acknowledgements).toEqual([]);
    expect(edited).toMatchObject({ claimant: { name: '花子' }, period: { from: '2026-09-02', to: '2026-09-29' }, title: '出張', updatedAt: T2 });
    expect(edited.history.at(-1)).toEqual({ type: 'edited', by: 'editor', at: T2 });
  });

  it('正常: title を空文字で消し、省略した項目は元のまま', () => {
    const edited = editClaim(claimFixture('c1', { title: '旧' }), { title: '' }, 'u', T1);
    expect(edited.title).toBeUndefined();
    expect(edited.claimant.name).toBe('テスト太郎');
    expect(editClaim(claimFixture('c1', { title: '旧' }), {}, 'u', T1).title).toBe('旧');
  });

  it('正常: returned の申請を編集すると draft へ戻る', () => {
    const returned = returnClaim(checked([ret('receipt-missing', 'item-1')]), '直して', 'boss', T1);
    expect(editClaim(returned, {}, 'u', T2).status).toBe('draft');
  });

  it('異常: approved は編集できず、承認取消を案内する', () => {
    const error = transitionError(() => editClaim(approved(), {}, 'u', T2));
    expect(error.nextStep).toBe('承認を取り消してから編集してください');
  });

  it('異常: settled は編集できない', () => {
    const settled = claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 }, settlement: { settledAt: T1, by: 'b' } });
    for (const action of [() => editClaim(settled, {}, 'u', T2), () => putItem(settled, itemFixture('x'), 'u', T2), () => removeItem(settled, 'item-1', 'u', T2), () => appendItems(settled, [itemFixture('x')], 'u', T2, 'csv')]) {
      expect(transitionError(action).nextStep).toContain('精算済み');
    }
  });

  it('異常: 編集内容の形が不正なら ExpenseDomainError、時刻が不正でも拒否する', () => {
    expect(() => editClaim(claimFixture('c1'), { period: { from: '2026-10-01', to: '2026-09-01' } }, 'u', T1)).toThrow(ExpenseDomainError);
    expect(() => editClaim(claimFixture('c1'), {}, 'u', 'now')).toThrow(ExpenseDomainError);
  });
});

describe('状態遷移: 明細の追加・置換・削除', () => {
  it('正常: putItem で追加すると判定が消えて draft、履歴に item added', () => {
    const next = putItem(checked(), itemFixture('item-2'), 'u', T2);
    expect(next.items.map((item) => item.id)).toEqual(['item-1', 'item-2']);
    expect(next.status).toBe('draft');
    expect(next.judgment).toBeUndefined();
    expect(next.history.at(-1)?.note).toBe('item added: item-2');
  });

  it('正常: 同じ id の putItem は置き換える', () => {
    const next = putItem(claimFixture('c1'), itemFixture('item-1', { amount: 999 }), 'u', T2);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.facts.amount).toBe(999);
    expect(next.history.at(-1)?.note).toBe('item updated: item-1');
  });

  it('境界: 100 件の申請に 101 件目を putItem すると拒否する', () => {
    const full = claimFixture('c1', { items: Array.from({ length: 100 }, (_, index) => itemFixture(`i${index}`)) });
    expect(() => putItem(full, itemFixture('extra'), 'u', T2)).toThrow(/at most 100 items/u);
    // 置き換えは件数を増やさないので通る
    expect(putItem(full, itemFixture('i0', { amount: 1 }), 'u', T2).items).toHaveLength(100);
  });

  it('正常: appendItems はまとめて足し、履歴を 1 件にする', () => {
    const next = appendItems(checked(), [itemFixture('a'), itemFixture('b')], 'u', T2, 'CSV 2 行');
    expect(next.items).toHaveLength(3);
    expect(next.status).toBe('draft');
    expect(next.judgment).toBeUndefined();
    expect(next.history.at(-1)).toEqual({ type: 'edited', by: 'u', at: T2, note: 'CSV 2 行' });
  });

  it('境界: appendItems に空配列なら同じ申請を返す（判定も残す）', () => {
    const base = checked();
    expect(appendItems(base, [], 'u', T2, 'none')).toBe(base);
  });

  it('異常: appendItems で既存と同じ id・容量超過を拒否する', () => {
    expect(() => appendItems(claimFixture('c1'), [itemFixture('item-1')], 'u', T2, 'n')).toThrow(/duplicate item id: item-1/u);
    const many = Array.from({ length: 100 }, (_, index) => itemFixture(`n${index}`));
    expect(() => appendItems(claimFixture('c1'), many, 'u', T2, 'n')).toThrow(/at most 100 items/u);
  });

  it('正常: removeItem で消すと判定が消えて draft', () => {
    const next = removeItem(checked([], { items: [itemFixture('item-1'), itemFixture('item-2')] }), 'item-1', 'u', T2);
    expect(next.items.map((item) => item.id)).toEqual(['item-2']);
    expect(next.status).toBe('draft');
    expect(next.history.at(-1)?.note).toBe('item removed: item-1');
  });

  it('異常: 無い明細の removeItem は ExpenseItemNotFoundError', () => {
    expect(() => removeItem(claimFixture('c1'), 'nothing', 'u', T2)).toThrow(ExpenseItemNotFoundError);
  });

  it('異常: approved の明細は putItem / removeItem / appendItems できない', () => {
    expect(() => putItem(approved(), itemFixture('x'), 'u', T2)).toThrow(ExpenseTransitionError);
    expect(() => removeItem(approved(), 'item-1', 'u', T2)).toThrow(ExpenseTransitionError);
    expect(() => appendItems(approved(), [itemFixture('x')], 'u', T2, 'n')).toThrow(ExpenseTransitionError);
  });
});

describe('状態遷移: チェック（withJudgment）と古さ', () => {
  it('正常: draft に判定を保存すると checked、履歴に verdict', () => {
    const claim = claimFixture('c1');
    const next = withJudgment(claim, judgmentFor(claim, [ret('receipt-missing', 'item-1')]), T1, 'checker');
    expect(next.status).toBe('checked');
    expect(next.judgment?.verdict).toBe('returned');
    expect(next.history.at(-1)).toEqual({ type: 'checked', by: 'checker', at: T1, note: 'returned' });
    expect(withJudgment(claim, judgmentFor(claim), T1).history.at(-1)).toEqual({ type: 'checked', at: T1, note: 'pass' });
  });

  it('正常: 再チェックでは、新しい判定にも要確認で残る確認済みだけを引き継ぐ', () => {
    let claim = checked([review('purpose-missing', 'item-1'), review('payee-missing', 'item-1'), review('policy-unreviewed')]);
    claim = acknowledge(claim, { itemId: 'item-1', code: 'purpose-missing', note: '確認1' }, 'boss', T1);
    claim = acknowledge(claim, { itemId: 'item-1', code: 'payee-missing', note: '確認2' }, 'boss', T1);
    claim = acknowledge(claim, { code: 'policy-unreviewed', note: '確認3' }, 'boss', T1);
    // purpose-missing は消え、payee-missing は差し戻しに重くなり、policy-unreviewed は要確認のまま
    const next = withJudgment(claim, judgmentFor(claim, [ret('payee-missing', 'item-1'), review('policy-unreviewed')]), T2);
    expect(next.acknowledgements.map((entry) => entry.code)).toEqual(['policy-unreviewed']);
  });

  it('異常: approved / settled は再チェックしない', () => {
    const claim = approved();
    expect(() => withJudgment(claim, judgmentFor(claim), T2)).toThrow(ExpenseTransitionError);
  });

  it('異常: 判定の形が不正なら ExpenseDomainError', () => {
    expect(() => withJudgment(claimFixture('c1'), { verdict: 'ok' } as never, T1)).toThrow(ExpenseDomainError);
  });

  it('正常: isJudgmentStale は判定なしなら false、同じ規程と明細なら false', () => {
    expect(isJudgmentStale(claimFixture('c1'), POLICY)).toBe(false);
    expect(isJudgmentStale(checked(), POLICY)).toBe(false);
  });

  it('異常: 規程の updatedAt が変わると古い', () => {
    expect(isJudgmentStale(checked(), { updatedAt: T2 })).toBe(true);
  });

  it('異常: 明細・申請者・期間が変わると古い', () => {
    const claim = checked();
    expect(isJudgmentStale({ ...claim, items: [itemFixture('item-1', { amount: 3201 })] }, POLICY)).toBe(true);
    expect(isJudgmentStale({ ...claim, claimant: { name: '別人' } }, POLICY)).toBe(true);
    expect(isJudgmentStale({ ...claim, period: { from: '2026-09-02', to: '2026-09-30' } }, POLICY)).toBe(true);
  });
});

describe('状態遷移: 確認済み（acknowledge）', () => {
  it('正常: 要確認の理由を根拠付きで確認済みにし、同じ理由は上書きする', () => {
    const base = checked([review('purpose-missing', 'item-1')]);
    const once = acknowledge(base, { itemId: 'item-1', code: 'purpose-missing', note: ' 1 回目 ' }, 'boss', T1);
    const twice = acknowledge(once, { itemId: 'item-1', code: 'purpose-missing', note: '2 回目' }, 'boss2', T2);
    expect(once.acknowledgements).toEqual([{ itemId: 'item-1', code: 'purpose-missing', note: '1 回目', by: 'boss', at: T1 }]);
    expect(twice.acknowledgements).toEqual([{ itemId: 'item-1', code: 'purpose-missing', note: '2 回目', by: 'boss2', at: T2 }]);
    expect(twice.status).toBe('checked');
    expect(twice.history.at(-1)).toEqual({ type: 'acknowledged', by: 'boss2', at: T2, note: 'purpose-missing (item-1): 2 回目' });
  });

  it('正常: 申請単位の理由も確認済みにできる', () => {
    const next = acknowledge(checked([review('policy-unreviewed')]), { code: 'policy-unreviewed', note: '見た' }, 'boss', T1);
    expect(next.acknowledgements[0]).toEqual({ code: 'policy-unreviewed', note: '見た', by: 'boss', at: T1 });
    expect(next.history.at(-1)?.note).toBe('policy-unreviewed: 見た');
  });

  it('異常: 差し戻しの理由は確認済みにできない（blockingReasons 付き）', () => {
    const error = transitionError(() => acknowledge(checked([ret('receipt-missing', 'item-1')]), { itemId: 'item-1', code: 'receipt-missing', note: 'いいよ' }, 'boss', T1));
    expect(error.blockingReasons).toEqual([{ code: 'receipt-missing', itemId: 'item-1' }]);
    expect(error.nextStep).toContain('差し戻しの理由は確認済みにできません');
    const claimLevel = transitionError(() => acknowledge(checked([ret('per-claim-limit-exceeded')]), { code: 'per-claim-limit-exceeded', note: 'x' }, 'boss', T1));
    expect(claimLevel.blockingReasons).toEqual([{ code: 'per-claim-limit-exceeded' }]);
  });

  it('異常: note が空なら拒否する', () => {
    const error = transitionError(() => acknowledge(checked([review('purpose-missing', 'item-1')]), { itemId: 'item-1', code: 'purpose-missing', note: '  ' }, 'boss', T1));
    expect(error.nextStep).toContain('根拠');
  });

  it('異常: 該当する理由が判定に無ければ拒否する（別の明細の同じコードも該当しない）', () => {
    const base = checked([review('purpose-missing', 'item-1')]);
    expect(transitionError(() => acknowledge(base, { itemId: 'item-2', code: 'purpose-missing', note: 'x' }, 'boss', T1)).message).toContain('for item item-2');
    expect(transitionError(() => acknowledge(base, { code: 'purpose-missing', note: 'x' }, 'boss', T1)).nextStep).toContain('開き直して');
  });

  it('異常: checked 以外（draft / returned / approved / settled）は拒否し、状態に応じた次の一手を返す', () => {
    const input = { code: 'purpose-missing', note: 'x' };
    expect(transitionError(() => acknowledge(claimFixture('c1'), input, 'b', T1)).nextStep).toBe('チェックしてから操作してください');
    const returned = returnClaim(checked([ret('receipt-missing', 'item-1')]), '直して', 'boss', T1);
    expect(transitionError(() => acknowledge(returned, input, 'b', T1)).nextStep).toContain('差し戻した申請です');
    expect(transitionError(() => acknowledge(approved(), input, 'b', T1)).nextStep).toContain('承認済み');
    const settled = claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 }, settlement: { settledAt: T1, by: 'b' } });
    expect(transitionError(() => acknowledge(settled, input, 'b', T1)).nextStep).toContain('精算済み');
  });

  it('境界: checked でも判定が無ければ該当理由なしで拒否する', () => {
    const noJudgment = claimFixture('c1', { status: 'checked' });
    expect(() => acknowledge(noJudgment, { code: 'purpose-missing', note: 'x' }, 'b', T1)).toThrow(/has no reason/u);
  });
});

describe('状態遷移: 差し戻し（returnClaim）', () => {
  it('正常: 差し戻し理由と未確認の要確認を写し、確認済みの要確認は写さない', () => {
    let claim = checked([ret('receipt-missing', 'item-1'), review('purpose-missing', 'item-1'), review('policy-unreviewed')]);
    claim = acknowledge(claim, { code: 'policy-unreviewed', note: '見た' }, 'boss', T1);
    const returned = returnClaim(claim, ' 領収書を添付してください ', 'boss', T2);
    expect(returned.status).toBe('returned');
    expect(returned.returnNote).toEqual({
      message: '領収書を添付してください',
      reasons: [{ code: 'receipt-missing', itemId: 'item-1', severity: 'return' }, { code: 'purpose-missing', itemId: 'item-1', severity: 'review' }],
      by: 'boss',
      at: T2,
    });
    expect(returned.history.at(-1)).toEqual({ type: 'returned', by: 'boss', at: T2 });
  });

  it('異常: 文言が空なら拒否する', () => {
    expect(transitionError(() => returnClaim(checked(), ' ', 'boss', T1)).nextStep).toContain('文言');
  });

  it('異常: checked 以外は拒否する', () => {
    expect(() => returnClaim(claimFixture('c1'), 'm', 'boss', T1)).toThrow(ExpenseTransitionError);
  });
});

describe('状態遷移: 承認（approveClaim）', () => {
  it('正常: 差し戻し理由 0 件・未確認の要確認 0 件なら承認し、表示名とコメントを残す', () => {
    const claim = acknowledge(checked([review('purpose-missing', 'item-1')]), { itemId: 'item-1', code: 'purpose-missing', note: '確認' }, 'boss', T1);
    const next = approveClaim(claim, POLICY, 'boss', T2, { displayName: ' 上司 ', comment: ' OK ' });
    expect(next.status).toBe('approved');
    expect(next.approval).toEqual({ by: 'boss', displayName: '上司', at: T2, comment: 'OK' });
    expect(next.history.at(-1)).toEqual({ type: 'approved', by: 'boss', at: T2, note: 'OK' });
    expect(approveClaim(checked(), POLICY, 'boss', T2).history.at(-1)).toEqual({ type: 'approved', by: 'boss', at: T2 });
  });

  it('異常: 判定が古いと judgment-stale で拒否し、再チェックを案内する', () => {
    const error = transitionError(() => approveClaim(checked([ret('receipt-missing', 'item-1')]), createExpensePolicy({ ...POLICY, updatedAt: T2 }), 'boss', T2));
    // 古い判定の理由は並べない（いまの規程では違う結果になりうるため）
    expect(error.blockingReasons).toEqual([{ code: 'judgment-stale' }]);
    expect(error.nextStep).toContain('もう一度チェック');
  });

  it('異常: 判定が無い checked は judgment-missing で拒否する', () => {
    const error = transitionError(() => approveClaim(claimFixture('c1', { status: 'checked' }), POLICY, 'boss', T2));
    expect(error.blockingReasons).toEqual([{ code: 'judgment-missing' }]);
  });

  it('異常: 差し戻し理由が 1 件でもあれば拒否し、差し戻しを案内する', () => {
    const error = transitionError(() => approveClaim(checked([ret('receipt-missing', 'item-1'), ret('claim-empty')]), POLICY, 'boss', T2));
    expect(error.blockingReasons).toEqual([{ code: 'claim-empty' }, { code: 'receipt-missing', itemId: 'item-1' }]);
    expect(error.nextStep).toContain('差し戻しの理由が残っています');
  });

  it('異常: 未確認の要確認があれば拒否し、確認済みにするよう案内する', () => {
    const error = transitionError(() => approveClaim(checked([review('purpose-missing', 'item-1')]), POLICY, 'boss', T2));
    expect(error.blockingReasons).toEqual([{ code: 'purpose-missing', itemId: 'item-1' }]);
    expect(error.nextStep).toBe('要確認の理由をすべて確認済みにしてから承認してください');
  });

  it('異常: 自己承認の禁止が有効なら取り込んだ本人は承認できない', () => {
    const claim = checked([], { submittedBy: 'me' });
    const error = transitionError(() => approveClaim(claim, selfApprovalPolicy, 'me', T2));
    expect(error.blockingReasons).toEqual([{ code: 'self-approval' }]);
    expect(error.nextStep).toContain('別の人');
    expect(approveClaim(claim, selfApprovalPolicy, 'other', T2).status).toBe('approved');
    // 禁止が無効なら本人でも承認できる
    expect(approveClaim(claim, POLICY, 'me', T2).status).toBe('approved');
  });

  it('正常: approvalBlockers は by を渡さなければ自己承認を見ない', () => {
    expect(approvalBlockers(checked([], { submittedBy: 'me' }), selfApprovalPolicy)).toEqual([]);
  });

  it('異常: checked 以外は拒否する', () => {
    expect(() => approveClaim(claimFixture('c1'), POLICY, 'boss', T2)).toThrow(ExpenseTransitionError);
    expect(() => approveClaim(approved(), POLICY, 'boss', T2)).toThrow(ExpenseTransitionError);
  });

  it('正常: unacknowledgedReviewReasons は判定が無ければ空', () => {
    expect(unacknowledgedReviewReasons(claimFixture('c1'))).toEqual([]);
  });
});

describe('状態遷移: 承認取消（unapproveClaim）', () => {
  it('正常: 承認済みを checked に戻し、承認を落として理由を履歴に残す', () => {
    const next = unapproveClaim(approved(), 'boss', T2, ' 金額誤り ');
    expect(next.status).toBe('checked');
    expect(next.approval).toBeUndefined();
    expect(next.history.at(-1)).toEqual({ type: 'unapproved', by: 'boss', at: T2, note: '金額誤り' });
  });

  it('異常: 仕訳下書きがあれば取り消せない', () => {
    const claim = approved({ journalLink: { entries: [], complete: false, draftedAt: T1, by: 'b', warnings: [] } });
    expect(transitionError(() => unapproveClaim(claim, 'boss', T2, '理由')).nextStep).toContain('仕訳下書きを作成済み');
  });

  it('異常: 精算の記録があれば取り消せない', () => {
    const claim = approved({ settlement: { settledAt: T1, by: 'b' } });
    expect(transitionError(() => unapproveClaim(claim, 'boss', T2, '理由')).message).toContain('already settled');
  });

  it('異常: 理由が空なら取り消せない', () => {
    expect(transitionError(() => unapproveClaim(approved(), 'boss', T2, '')).nextStep).toBe('承認を取り消す理由を書いてください');
  });

  it('異常: approved 以外は拒否する（settled と未承認で次の一手が違う）', () => {
    const settled = claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 }, settlement: { settledAt: T1, by: 'b' } });
    expect(transitionError(() => unapproveClaim(settled, 'boss', T2, 'x')).nextStep).toBe('精算済みの申請は承認を取り消せません');
    expect(transitionError(() => unapproveClaim(checked(), 'boss', T2, 'x')).nextStep).toBe('承認されていない申請です');
  });
});

describe('状態遷移: 精算済み（markSettled）', () => {
  it('正常: 承認済みを精算済みにし、ファイル名を残す', () => {
    const next = markSettled(approved(), 'acct', T2, ' payout.csv ');
    expect(next.status).toBe('settled');
    expect(next.settlement).toEqual({ settledAt: T2, by: 'acct', exportFileName: 'payout.csv' });
    expect(next.history.at(-1)).toEqual({ type: 'settled', by: 'acct', at: T2, note: 'payout.csv' });
    expect(markSettled(approved(), 'acct', T2).history.at(-1)).toEqual({ type: 'settled', by: 'acct', at: T2 });
  });

  it('境界: settled は冪等（同じ値を返す）', () => {
    const settled = markSettled(approved(), 'acct', T2);
    expect(markSettled(settled, 'other', '2026-09-20T00:00:00.000Z')).toBe(settled);
  });

  it('異常: approved 以外は拒否する', () => {
    expect(transitionError(() => markSettled(checked(), 'acct', T2)).nextStep).toBe('承認してから精算済みにしてください');
  });
});

describe('状態遷移: 仕訳連携（withJournalLink）', () => {
  const partial = { entries: [{ itemId: 'item-1', entryId: 'e1' }], complete: false, warnings: ['w1'] };

  it('正常: 途中まで（complete false）は記録するが履歴は積まない', () => {
    const base = approved();
    const next = withJournalLink(base, partial, 'acct', T2);
    expect(next.journalLink).toEqual({ entries: [{ itemId: 'item-1', entryId: 'e1' }], complete: false, draftedAt: T2, by: 'acct', warnings: ['w1'] });
    expect(next.history).toBe(base.history);
  });

  it('正常: partial は続きで上書きでき、complete で journal-drafted の履歴を積む', () => {
    const first = withJournalLink(approved(), partial, 'acct', T1);
    const done = withJournalLink(first, { entries: [{ itemId: 'item-1', entryId: 'e1' }, { itemId: 'item-2', entryId: 'e2' }], complete: true, warnings: [] }, 'acct', T2);
    expect(done.journalLink?.complete).toBe(true);
    expect(done.journalLink?.entries).toHaveLength(2);
    expect(done.history.at(-1)).toEqual({ type: 'journal-drafted', by: 'acct', at: T2, note: '2 entries' });
  });

  it('正常: settled の申請にも作成できる', () => {
    const settled = claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 }, settlement: { settledAt: T1, by: 'b' } });
    expect(withJournalLink(settled, { ...partial, complete: true }, 'acct', T2).journalLink?.complete).toBe(true);
  });

  it('異常: complete 済みは作り直せない', () => {
    const done = withJournalLink(approved(), { ...partial, complete: true }, 'acct', T1);
    expect(transitionError(() => withJournalLink(done, partial, 'acct', T2)).nextStep).toContain('作成済み');
  });

  it('異常: approved / settled 以外は拒否する', () => {
    expect(transitionError(() => withJournalLink(checked(), partial, 'acct', T2)).nextStep).toBe('承認してから仕訳下書きを作成してください');
  });
});

describe('履歴の上限', () => {
  it('境界: 200 件ある履歴に積むと古いものから落として 200 件を保つ', () => {
    const history = Array.from({ length: CLAIM_MAX_HISTORY }, (_, index) => ({ type: 'edited' as const, at: AT, note: `n${index}` }));
    const next = editClaim(claimFixture('c1', { history }), {}, 'u', T2);
    expect(next.history).toHaveLength(200);
    expect(next.history[0]?.note).toBe('n1');
    expect(next.history.at(-1)).toEqual({ type: 'edited', by: 'u', at: T2 });
  });
});

describe('要約・指紋・キー', () => {
  it('正常: toExpenseClaimSummary は理由の件数・多い順の topReasons（同数は評価順・最大 5 件）を返す', () => {
    const items = ['a', 'b', 'c'].map((id) => itemFixture(id));
    const reasons = [
      ret('per-claim-limit-exceeded'),
      review('purpose-missing', 'a'), review('purpose-missing', 'b'), review('purpose-missing', 'c'),
      ret('receipt-missing', 'a'), ret('receipt-missing', 'b'),
      review('payee-missing', 'a'), ret('amount-missing', 'a'), ret('date-missing', 'a'), review('policy-unreviewed'),
    ];
    let claim = claimFixture('c1', { items });
    claim = withJudgment(claim, judgmentFor(claim, reasons), T1);
    claim = acknowledge(claim, { code: 'policy-unreviewed', note: 'ok' }, 'boss', T1);
    const summary = toExpenseClaimSummary(claim);
    expect(summary.topReasons).toEqual(['purpose-missing', 'receipt-missing', 'policy-unreviewed', 'amount-missing', 'date-missing']);
    expect(summary.reasonCounts).toEqual({ return: 5, review: 5, acknowledged: 1 });
    expect(summary).toMatchObject({ id: 'c1', status: 'checked', verdict: 'returned', stale: false, itemCount: 3, totalAmount: 9600, journalLinked: 'none', judgedPolicyUpdatedAt: POLICY.updatedAt, submittedBy: 'tester' });
  });

  it('正常: 未チェックの要約は verdict なし・stale false・理由 0', () => {
    const summary = toExpenseClaimSummary(claimFixture('c1'));
    expect(summary.verdict).toBeUndefined();
    expect(summary.stale).toBe(false);
    expect(summary.topReasons).toEqual([]);
    expect(summary.judgedPolicyUpdatedAt).toBeUndefined();
  });

  it('正常: journalLinked は partial / complete、承認・精算の時刻を載せる', () => {
    const partial = approved({ journalLink: { entries: [], complete: false, draftedAt: T1, by: 'b', warnings: [] } });
    expect(toExpenseClaimSummary(partial)).toMatchObject({ journalLinked: 'partial', approvedBy: 'boss', approvedAt: T1 });
    const settled = claimFixture('c1', { status: 'settled', approval: { by: 'b', at: T1 }, settlement: { settledAt: T2, by: 'b' }, journalLink: { entries: [], complete: true, draftedAt: T1, by: 'b', warnings: [] } });
    expect(toExpenseClaimSummary(settled)).toMatchObject({ journalLinked: 'complete', settledAt: T2 });
  });

  it('異常: 明細の指紋が変わった要約は stale', () => {
    const claim = checked();
    expect(toExpenseClaimSummary({ ...claim, items: [itemFixture('item-1', { amount: 1 })] }).stale).toBe(true);
  });

  it('正常: withPolicyStaleness は規程の版の違いを古さに足す', () => {
    const summary = toExpenseClaimSummary(checked());
    expect(withPolicyStaleness(summary, POLICY).stale).toBe(false);
    expect(withPolicyStaleness(summary, { updatedAt: T2 }).stale).toBe(true);
    const unchecked = toExpenseClaimSummary(claimFixture('c1'));
    expect(withPolicyStaleness(unchecked, { updatedAt: T2 })).toBe(unchecked);
  });

  it('正常: claimantKeyOf は NFKC・空白除去・小文字化し、社員番号を足す', () => {
    expect(claimantKeyOf({ name: 'Ｔａｒｏ　Yamada', employeeCode: ' Ｅ001 ' })).toBe('taroyamada#e001');
    expect(claimantKeyOf({ name: '太郎' })).toBe('太郎');
    expect(claimantKeyOf({ name: '太郎', employeeCode: ' ' })).toBe('太郎');
  });

  it('正常: claimFingerprint はオブジェクトのキー順に依らない', () => {
    const claim = claimFixture('c1');
    const item = claim.items[0]!;
    const reordered = { ...claim, claimant: { department: '営業部', employeeCode: 'E001', name: 'テスト太郎' }, items: [{ extraction: item.extraction, source: item.source, facts: { purpose: '客先訪問', description: 'タクシー代', amount: 3200, payeeName: 'サンプル交通', transactionDate: '2026-09-10' }, categoryId: item.categoryId, id: item.id, addedOn: item.addedOn }] } as ExpenseClaim;
    expect(claimFingerprint(reordered)).toBe(claimFingerprint(claim));
  });

  it('異常: claimFingerprint は金額・証憑の有無が変わると変わり、undefined の項目は無いものと同じ', () => {
    const claim = claimFixture('c1');
    expect(claimFingerprint({ ...claim, items: [itemFixture('item-1', { amount: 3201 })] })).not.toBe(claimFingerprint(claim));
    expect(claimFingerprint({ ...claim, items: [itemFixture('item-1', {}, { receiptId: 'r1' })] })).not.toBe(claimFingerprint(claim));
    expect(claimFingerprint({ ...claim, title: 'x' } as ExpenseClaim)).toBe(claimFingerprint(claim));
    expect(claimFingerprint({ ...claim, items: [{ ...claim.items[0]!, categoryText: undefined }] })).toBe(claimFingerprint(claim));
  });

  it('正常: claimTotalAmount は 0 円以下を数えない、itemLabel は摘要 → 支払先 → 何件目', () => {
    expect(claimTotalAmount({ items: [itemFixture('a', { amount: 100 }), itemFixture('b', { amount: 0 })] })).toBe(100);
    expect(itemLabel({ facts: { description: '摘要', payeeName: '店' } }, 0)).toBe('摘要');
    expect(itemLabel({ facts: { payeeName: '店' } }, 0)).toBe('店');
    expect(itemLabel({ facts: {} }, 2)).toBe('明細 3');
  });
});

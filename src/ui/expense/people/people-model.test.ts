import { describe, expect, it } from 'vitest';
import type { ExpenseApprovalRouteDto, ExpenseApprovalSettingsDto, ExpenseApprovalStepDefDto } from '../../api/expense-types';
import type { ExpenseApprovalFlowViewDto, ExpenseEmployeeDto } from '../../api/expense-people-types';
import { emptyClaimDraft, type Translate } from '../expense-model';
import {
  DEFAULT_APPROVAL_SETTINGS, accountTypeLabel, approvalIssues, approvalOf, approverForKind, approverKindLabel, claimDraftWithEmployee, cleanDigits, conflictClaimIds,
  defaultLinkSelection, emptyEmployeeForm, employeeFieldElementId, employeeFieldOf, employeeFormFrom, employeeInputFromForm, employeeSaveProblem, filterEmployees,
  flowStepRows, flowStepStateLabel, formatStations, historyTypeLabel, isHolderKanaConversion, isMinimalFlow, linkMatchLabel, maskedAccountNumber, moveAt,
  newApprovalRoute, newApprovalStep, newApproverGroup, newCommuterPass, newDepartment, nextId, organizationIssues, parseStations, payoutMarkOf, removeAt, replaceAt,
  routeIsUnconditional, sendsAccountNumber, splitLines, unresolvedStepView, withText, yuchoToZengin, type EmployeeFormDraft, type EmployeeFormField,
} from './people-model';

const en: Translate = (english) => english;
const ja: Translate = (_english, japanese) => japanese;

function employee(overrides: Partial<ExpenseEmployeeDto> = {}): ExpenseEmployeeDto {
  return {
    id: 'e1', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'd1', departmentName: '営業部', loginSubjects: ['taro'], commuterPasses: [], enabled: true,
    history: [], createdAt: 'x', updatedAt: 'x', payoutReadiness: { problems: [], warnings: [] }, ...overrides,
  };
}

const bankAccount = { bankCode: '0001', branchCode: '001', accountType: 'ordinary' as const, accountNumberLast4: '0001', holderKana: 'ﾃｽﾄ ﾀﾛｳ', changedAt: 'x', changedBy: 'u1' };

function form(overrides: Partial<EmployeeFormDraft> = {}): EmployeeFormDraft {
  return { ...emptyEmployeeForm(), name: 'テスト太郎', ...overrides };
}

describe('小さな道具', () => {
  it('正常: replaceAt / removeAt / moveAt は新しい配列を返し、範囲外へは動かさない', () => {
    expect(replaceAt(['a', 'b'], 1, 'c')).toEqual(['a', 'c']);
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(moveAt(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveAt(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    const list = ['a', 'b'];
    expect(moveAt(list, 0, -1)).toBe(list);
    expect(moveAt(list, 1, 1)).toBe(list);
    expect(moveAt(list, 5, -1)).toBe(list);
    expect(moveAt(list, -1, 1)).toBe(list);
  });

  it('正常: withText は空白を削って入れ、空ならキーごと消す。nextId は重ならない id を作る', () => {
    expect(withText({ a: 1 }, 'b', '  x ')).toEqual({ a: 1, b: 'x' });
    expect(withText({ a: 1, b: 'old' }, 'b', '  ')).toEqual({ a: 1 });
    expect(nextId('route', [])).toBe('route-1');
    expect(nextId('route', ['route-2', 'x'])).toBe('route-3');
    expect(nextId('route', ['route-2'])).toBe('route-3');
  });
});

describe('口座番号・ゆうちょ', () => {
  it('正常: cleanDigits はハイフン・空白を外し、外したかを返す。全角数字は半角にするだけで「外した」にしない', () => {
    expect(cleanDigits('123-4567')).toEqual({ value: '1234567', removed: true });
    expect(cleanDigits('１２３　４ー５')).toEqual({ value: '12345', removed: true });
    expect(cleanDigits('１２３')).toEqual({ value: '123', removed: false });
    expect(cleanDigits('1234567')).toEqual({ value: '1234567', removed: false });
  });

  it('正常: 記号が 1 始まりは支店 = 2〜3 桁目 + 8・番号の末尾 1 を除く・普通', () => {
    expect(yuchoToZengin('12345', '12345671')).toEqual({ ok: true, bankCode: '9900', branchCode: '238', accountType: 'ordinary', accountNumber: '1234567' });
    expect(yuchoToZengin('1-2345', '1231')).toEqual({ ok: true, bankCode: '9900', branchCode: '238', accountType: 'ordinary', accountNumber: '0000123' });
  });

  it('正常: 記号が 0 始まりは支店 = 2〜3 桁目 + 9・番号を前ゼロ 7 桁・当座', () => {
    expect(yuchoToZengin('01234', '123')).toEqual({ ok: true, bankCode: '9900', branchCode: '129', accountType: 'current', accountNumber: '0000123' });
  });

  it('異常: 記号・番号の形が違えば、直す欄と直し方を返す', () => {
    expect(yuchoToZengin('22345', '12345671')).toMatchObject({ ok: false, field: 'symbol' });
    expect(yuchoToZengin('1234', '12345671')).toMatchObject({ ok: false, field: 'symbol' });
    expect(yuchoToZengin('12345', '12345670')).toMatchObject({ ok: false, field: 'number' });
    expect(yuchoToZengin('12345', '123456781')).toMatchObject({ ok: false, field: 'number' });
    expect(yuchoToZengin('12345', '1')).toMatchObject({ ok: false, field: 'number' });
    expect(yuchoToZengin('01234', '12345678')).toMatchObject({ ok: false, field: 'number' });
    expect(yuchoToZengin('01234', '')).toMatchObject({ ok: false, field: 'number' });
  });

  it('正常: 預金種目のラベルと伏せ字', () => {
    expect(['ordinary', 'current', 'savings', 'other'].map((type) => accountTypeLabel(type as 'ordinary', ja))).toEqual(['普通', '当座', '貯蓄', 'その他']);
    expect(accountTypeLabel('savings', en)).toBe('Savings');
    expect(maskedAccountNumber('0001')).toBe('***0001');
  });
});

describe('従業員フォーム', () => {
  it('正常: 駅の並びは「>」「＞」・改行で区切り、行は空を捨てる', () => {
    expect(parseStations('新宿 > 代々木＞ 東京\r\n品川\n\n')).toEqual(['新宿', '代々木', '東京', '品川']);
    expect(formatStations(['新宿', '東京'])).toBe('新宿 > 東京');
    expect(splitLines(' a \n\r\nb')).toEqual(['a', 'b']);
  });

  it('正常: 保存済みの従業員 → 下書き（口座番号は空、末尾 4 桁を持つ）', () => {
    const draft = employeeFormFrom(employee({ managerEmployeeId: 'e2', note: 'メモ', bankAccount: { ...bankAccount, bankNameKana: 'ﾐｽﾞﾎ', branchNameKana: 'ﾎﾝﾃﾝ' }, commuterPasses: [{ id: 'p1', stations: ['新宿', '東京'], validFrom: '2026-04-01', validTo: '2026-09-30', note: '通勤' }] }));
    expect(draft).toMatchObject({ id: 'e1', code: 'E001', managerEmployeeId: 'e2', loginSubjects: 'taro', note: 'メモ', hadBankAccount: true });
    expect(draft.bank).toMatchObject({ present: true, bankNameKana: 'ﾐｽﾞﾎ', branchNameKana: 'ﾎﾝﾃﾝ', accountNumber: '', changeNumber: false, last4: '0001' });
    expect(draft.passes).toEqual([{ id: 'p1', stations: '新宿 > 東京', validFrom: '2026-04-01', validTo: '2026-09-30', note: '通勤' }]);
    const bare = employeeFormFrom(employee({ code: undefined, nameKana: undefined, departmentId: undefined, commuterPasses: [{ id: 'p1', stations: ['a', 'b'] }] }));
    expect(bare).toMatchObject({ code: '', nameKana: '', departmentId: '', hadBankAccount: false });
    expect(bare.bank.present).toBe(false);
    expect(bare.passes[0]).toEqual({ id: 'p1', stations: 'a > b', validFrom: '', validTo: '', note: '' });
    expect(newCommuterPass(bare.passes).id).toBe('pass-2');
  });

  it('正常: 口座番号を送るのは新しい口座か「変更する」を押したときだけ', () => {
    const base = emptyEmployeeForm().bank;
    expect(sendsAccountNumber(base)).toBe(false);
    expect(sendsAccountNumber({ ...base, present: true })).toBe(true);
    expect(sendsAccountNumber({ ...base, present: true, last4: '0001' })).toBe(false);
    expect(sendsAccountNumber({ ...base, present: true, last4: '0001', changeNumber: true })).toBe(true);
  });

  it('正常: 新規は id・任意項目・口座番号・定期を本文に載せる', () => {
    const result = employeeInputFromForm(form({
      id: 'emp-1', code: ' E001 ', nameKana: 'テストタロウ', departmentId: 'd1', managerEmployeeId: 'e2', loginSubjects: 'taro\nt@example.com', note: ' ',
      bank: { ...emptyEmployeeForm().bank, present: true, bankCode: '0001', bankNameKana: 'ﾐｽﾞﾎ', branchCode: '001', holderKana: ' テスト タロウ ', accountNumber: '1234567' },
      passes: [{ id: 'pass-1', stations: '新宿 > 東京', validFrom: '2026-04-01', validTo: '', note: '' }],
    }), { isNew: true });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      id: 'emp-1', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'd1', managerEmployeeId: 'e2', loginSubjects: ['taro', 't@example.com'], enabled: true,
      bankAccount: { bankCode: '0001', bankNameKana: 'ﾐｽﾞﾎ', branchCode: '001', accountType: 'ordinary', holderKana: 'テスト タロウ', accountNumber: '1234567' },
      commuterPasses: [{ id: 'pass-1', stations: ['新宿', '東京'], validFrom: '2026-04-01' }],
    });
  });

  it('正常: 編集で「変更する」を押さなければ口座番号を送らず（id も載せない）、口座を外すと null を送る', () => {
    const edited = employeeFormFrom(employee({ bankAccount }));
    const kept = employeeInputFromForm(edited, { isNew: false });
    expect(kept.input?.bankAccount).toEqual({ bankCode: '0001', branchCode: '001', accountType: 'ordinary', holderKana: 'ﾃｽﾄ ﾀﾛｳ' });
    expect(kept.input).not.toHaveProperty('id');
    const removed = employeeInputFromForm({ ...edited, bank: { ...edited.bank, present: false } }, { isNew: false });
    expect(removed.input?.bankAccount).toBeNull();
    expect(employeeInputFromForm(form(), { isNew: false }).input).not.toHaveProperty('bankAccount');
  });

  it('異常: 画面で分かる誤りは欄ごとに返し、本文を作らない', () => {
    const bad = employeeInputFromForm({
      ...emptyEmployeeForm(), id: 'Bad Id', managerEmployeeId: 'Bad Id', loginSubjects: 'a\nb\nc\nd\ne\nf',
      bank: { ...emptyEmployeeForm().bank, present: true, bankCode: '12', branchCode: '1', holderKana: ' ', accountNumber: '12345678' },
      passes: [{ id: 'p', stations: '新宿', validFrom: '', validTo: '', note: '' }],
    }, { isNew: true });
    expect(bad.input).toBeUndefined();
    expect(Object.keys(bad.errors).sort()).toEqual(['accountNumber', 'bankCode', 'branchCode', 'commuterPasses', 'holderKana', 'id', 'loginSubjects', 'managerEmployeeId', 'name'].sort());
    expect(bad.errors.loginSubjects?.[1]).toContain('1 件減らして');
    const pass = (validFrom: string, validTo: string) => ({ id: 'p', stations: 'a>b', validFrom, validTo, note: '' });
    expect(employeeInputFromForm(form({ passes: [pass('', ''), pass('', ''), pass('', ''), pass('', '')] }), { isNew: false }).errors.commuterPasses?.[0]).toContain('Up to 3');
    expect(employeeInputFromForm(form({ passes: [pass('2026-10-01', '2026-09-01')] }), { isNew: false }).errors.commuterPasses?.[0]).toContain('after');
    // 編集では id の形を見ない（保存済みの id は変えられないため）。
    expect(employeeInputFromForm(form({ id: 'Bad Id' }), { isNew: false }).errors).toEqual({});
  });
});

describe('保存の 400 → 欄・原因・直し方', () => {
  it('正常: 名義カナの変換結果の形を確かめる', () => {
    expect(isHolderKanaConversion({ text: 'ｱ', bytes: 1, invalid: [{ char: '・', index: 0 }] })).toBe(true);
    expect(isHolderKanaConversion(null)).toBe(false);
    expect(isHolderKanaConversion('x')).toBe(false);
    expect(isHolderKanaConversion({ text: 'ｱ', bytes: '1', invalid: [] })).toBe(false);
    expect(isHolderKanaConversion({ text: 'ｱ', bytes: 1, invalid: [{ char: 1, index: 0 }] })).toBe(false);
    expect(isHolderKanaConversion({ text: 'ｱ', bytes: 1, invalid: [null] })).toBe(false);
  });

  it('正常: サーバーの欄のパスをフォームの欄と DOM id に写す', () => {
    expect(employeeFieldOf(undefined)).toBeUndefined();
    expect(employeeFieldOf('')).toBeUndefined();
    expect(employeeFieldOf('bankAccount.holderKana')).toBe('holderKana');
    expect(employeeFieldOf('commuterPasses.0.stations')).toBe('commuterPasses');
    expect(employeeFieldOf('loginSubjects[1]')).toBe('loginSubjects');
    expect(employeeFieldOf('bankAccount.somethingElse')).toBe('bankCode');
    expect(employeeFieldOf('name.first')).toBe('name');
    expect(employeeFieldOf('unknown')).toBeUndefined();
    const fields: readonly EmployeeFormField[] = ['id', 'code', 'name', 'nameKana', 'departmentId', 'managerEmployeeId', 'loginSubjects', 'note', 'enabled', 'bankCode', 'bankNameKana', 'branchCode', 'branchNameKana', 'accountType', 'accountNumber', 'holderKana', 'commuterPasses'];
    const ids = fields.map(employeeFieldElementId);
    expect(new Set(ids).size).toBe(fields.length);
    expect(employeeFieldElementId('holderKana')).toBe('expense-people-holder-kana');
    expect(employeeFieldElementId('code')).toBe('expense-people-employee-code');
  });

  it('正常: 名義カナは使えない文字の位置とバイト数を平易に言い、切り詰めないことを伝える', () => {
    const both = employeeSaveProblem({ field: 'bankAccount.holderKana', converted: { text: 'ｶ)ﾃｽﾄ･ﾀﾛｳ', bytes: 34, invalid: [{ char: '・', index: 3 }] } }, 'x', en);
    expect(both.field).toBe('holderKana');
    expect(both.cause).toContain('「・」(4)');
    expect(both.cause).toContain('34 bytes, over the 30-byte limit');
    expect(both.cause).toContain('Converted: ｶ)ﾃｽﾄ･ﾀﾛｳ');
    expect(both.fix).toContain('never cut automatically');
    expect(both.converted?.bytes).toBe(34);
    const bytesOnly = employeeSaveProblem({ field: 'bankAccount.holderKana', converted: { text: 'ｱ', bytes: 31, invalid: [] } }, 'x', ja);
    expect(bytesOnly.cause).toContain('上限の 30 バイト');
    expect(bytesOnly.cause).not.toContain('使えない文字');
    const invalidOnly = employeeSaveProblem({ field: 'bankAccount.holderKana', converted: { text: 'ｱ', bytes: 2, invalid: [{ char: '漢', index: 0 }] } }, 'x', ja);
    expect(invalidOnly.fix).toContain('漢字はカタカナ');
    const neither = employeeSaveProblem({ field: 'bankAccount.holderKana', converted: { text: 'ｱ', bytes: 2, invalid: [] } }, 'x', en);
    expect(neither.cause).toContain('cannot be used in transfer files');
    expect(neither.fix).toContain('katakana');
    expect(employeeSaveProblem({ field: 'bankAccount.holderKana' }, 'x', en).converted).toBeUndefined();
  });

  it('正常: 一意違反は相手の従業員 id を返し、欄ごとに原因を分ける', () => {
    expect(employeeSaveProblem({ field: 'code', conflictEmployeeId: 'e9' }, 'x', en)).toMatchObject({ field: 'code', conflictEmployeeId: 'e9', cause: expect.stringContaining('already uses this employee code') });
    expect(employeeSaveProblem({ field: 'code' }, 'x', en).cause).toContain('not in a usable form');
    expect(employeeSaveProblem({ field: 'loginSubjects', conflictEmployeeId: 'e9' }, 'x', en).cause).toContain('already uses this login ID');
    expect(employeeSaveProblem({ field: 'loginSubjects' }, 'x', en).fix).toContain('one per line');
    expect(employeeSaveProblem({ field: 'id', conflictEmployeeId: '' }, 'x', en).conflictEmployeeId).toBeUndefined();
    expect(employeeSaveProblem({ field: 'id', conflictEmployeeId: 'e9' }, 'x', en).cause).toContain('already uses this id');
    expect(employeeSaveProblem({ field: 'id' }, 'x', en).cause).toContain('not in a usable form');
    for (const field of ['managerEmployeeId', 'departmentId', 'bankAccount.accountNumber', 'bankAccount.bankCode', 'bankAccount.branchCode', 'bankAccount.accountType', 'bankAccount.bankNameKana', 'bankAccount.branchNameKana', 'commuterPasses', 'name', 'nameKana']) {
      const problem = employeeSaveProblem({ field }, 'fallback', ja);
      expect(problem.field, field).toBe(employeeFieldOf(field));
      expect(problem.cause, field).not.toBe('fallback');
      expect(problem.fix, field).not.toBe('');
    }
    expect(employeeSaveProblem(undefined, 'サーバーの文言', en)).toEqual({ field: undefined, cause: 'サーバーの文言', fix: 'Check the highlighted values and save again.' });
    expect(employeeSaveProblem({ field: 42 }, 'fallback', en).field).toBeUndefined();
    expect(employeeSaveProblem({ field: 'note' }, 'fallback', en).cause).toBe('fallback');
  });
});

describe('一覧・組織・紐付け・申請者', () => {
  it('正常: 氏名・カナ（半角も NFKC で）・社員番号の部分一致と、部門・有効で絞る', () => {
    const list = [employee(), employee({ id: 'e2', code: 'E002', name: '山田 花子', nameKana: 'ヤマダハナコ', departmentId: 'd2', enabled: false }), employee({ id: 'e3', code: undefined, nameKana: undefined, name: '佐藤' })];
    const all = { query: '', departmentId: '', enabled: 'all' as const };
    expect(filterEmployees(list, all)).toHaveLength(3);
    expect(filterEmployees(list, { ...all, query: 'ﾔﾏﾀﾞ' }).map((entry) => entry.id)).toEqual(['e2']);
    expect(filterEmployees(list, { ...all, query: 'e00 1' }).map((entry) => entry.id)).toEqual(['e1']);
    expect(filterEmployees(list, { ...all, enabled: 'enabled' }).map((entry) => entry.id)).toEqual(['e1', 'e3']);
    expect(filterEmployees(list, { ...all, enabled: 'disabled' }).map((entry) => entry.id)).toEqual(['e2']);
    expect(filterEmployees(list, { ...all, departmentId: 'd2' }).map((entry) => entry.id)).toEqual(['e2']);
  });

  it('正常: 振込の印と履歴のラベル', () => {
    expect(payoutMarkOf(employee())).toBe('no-account');
    expect(payoutMarkOf(employee({ bankAccount }))).toBe('ready');
    expect(payoutMarkOf(employee({ bankAccount, payoutReadiness: { problems: [{ code: 'x', message: 'm', fixTarget: 'employee' }], warnings: [] } }))).toBe('blocked');
    expect((['created', 'edited', 'bank-account-changed', 'disabled', 'enabled'] as const).map((type) => historyTypeLabel(type, ja))).toEqual(['登録', '編集', '口座の変更', '無効化', '有効化']);
  });

  it('正常: 組織の行の追加と、保存前の点検（空・重複・自分を親）', () => {
    expect(newDepartment([{ id: 'dept-1', name: 'a', enabled: true }])).toEqual({ id: 'dept-2', name: '', enabled: true });
    expect(newApproverGroup([])).toEqual({ id: 'group-1', name: '', memberEmployeeIds: [], enabled: true });
    expect(organizationIssues([{ id: 'd1', name: '営業', enabled: true }], [{ id: 'g1', name: '経理', memberEmployeeIds: [], enabled: true }])).toEqual([]);
    const issues = organizationIssues(
      [{ id: 'd1', name: '営業', enabled: true, parentId: 'd1' }, { id: 'd1', name: '', enabled: true }, { id: ' ', name: 'x', enabled: true }],
      [{ id: 'g1', name: '', memberEmployeeIds: [], enabled: true }],
    );
    expect(issues.map((issue) => issue.path)).toEqual(['departments.1.id', 'departments.1.name', 'departments.2.id', 'approverGroups.0.name', 'departments.0.parentId']);
  });

  it('正常: 紐付け候補は社員番号の一致・同名 1 人だけを既定で選び、409 の申請 id を読む', () => {
    const claimant = { name: 'テスト' };
    const candidates = [{ id: 'e1', name: 'テスト' }, { id: 'e2', name: 'テスト' }];
    expect(defaultLinkSelection([
      { claimId: 'c1', claimant, status: 'draft', match: 'exact-code', candidates },
      { claimId: 'c2', claimant, status: 'draft', match: 'unique-name', candidates: [{ id: 'e3', name: 'x' }] },
      { claimId: 'c3', claimant, status: 'draft', match: 'ambiguous', candidates },
      { claimId: 'c4', claimant, status: 'draft', match: 'none', candidates: [] },
      { claimId: 'c5', claimant, status: 'draft', match: 'exact-code', candidates: [] },
    ])).toEqual({ c1: 'e1', c2: 'e3' });
    expect((['exact-code', 'unique-name', 'ambiguous', 'none'] as const).map((match) => linkMatchLabel(match, en))).toEqual(['Employee code matches', 'Only one employee with this name', 'Several candidates: choose one', 'No candidate']);
    expect(conflictClaimIds(undefined)).toEqual([]);
    expect(conflictClaimIds({ claims: 'c1' })).toEqual([]);
    expect(conflictClaimIds({ claims: ['c1', { claimId: 'c2' }, { id: 'c3' }, { id: 4 }, null, 5] })).toEqual(['c1', 'c2', 'c3']);
  });

  it('正常: 従業員を選ぶと紐付けと写し（氏名・社員番号・部門）を下書きに入れる', () => {
    const draft = emptyClaimDraft(new Date(2026, 8, 1));
    expect(claimDraftWithEmployee(draft, employee())).toMatchObject({ employeeId: 'e1', name: 'テスト太郎', employeeCode: 'E001', department: '営業部' });
    expect(claimDraftWithEmployee(draft, employee({ code: undefined, departmentName: undefined }))).toMatchObject({ employeeCode: '', department: '' });
  });
});

describe('承認経路の下書き', () => {
  const step = (id: string, overrides: Partial<ExpenseApprovalStepDefDto> = {}): ExpenseApprovalStepDefDto => ({ id, name: id, approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false, ...overrides });
  const route = (id: string, overrides: Partial<ExpenseApprovalRouteDto> = {}): ExpenseApprovalRouteDto => ({ id, name: id, enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [step('s1')], ...overrides });

  it('正常: approval が無ければ MVP と同じ 1 段の既定を使う', () => {
    expect(approvalOf({})).toBe(DEFAULT_APPROVAL_SETTINGS);
    const own: ExpenseApprovalSettingsDto = { ...DEFAULT_APPROVAL_SETTINGS, requireDistinctApprovers: true };
    expect(approvalOf({ approval: own })).toBe(own);
    expect(DEFAULT_APPROVAL_SETTINGS.defaultSteps).toEqual([{ id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }]);
  });

  it('正常: 承認者の種類のラベルと、種類を変えたときの指定', () => {
    expect((['claimant-manager', 'department-head', 'employee', 'group', 'any-approver'] as const).map((kind) => approverKindLabel(kind, ja))).toEqual(['申請者の上長', '部門長', '指定の従業員', '承認グループ', '承認権限を持つ人なら誰でも']);
    const head = { kind: 'department-head' as const, departmentId: 'd1' };
    expect(approverForKind('department-head', head)).toBe(head);
    expect(approverForKind('department-head', { kind: 'any-approver' })).toEqual({ kind: 'department-head' });
    expect(approverForKind('employee', head)).toEqual({ kind: 'employee', employeeId: '' });
    expect(approverForKind('group', head)).toEqual({ kind: 'group', groupId: '' });
    expect(approverForKind('claimant-manager', head)).toEqual({ kind: 'claimant-manager' });
    expect(approverForKind('any-approver', head)).toEqual({ kind: 'any-approver' });
  });

  it('正常: 経路と段の追加は重ならない id で、条件なし・承認権限を持つ誰でもから始める', () => {
    expect(newApprovalStep([step('step-1')], '承認')).toEqual({ id: 'step-2', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false });
    expect(newApprovalRoute([route('route-1')], '新しい経路', '承認')).toEqual({ id: 'route-2', name: '新しい経路', enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [{ id: 'step-1', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }] });
    expect(routeIsUnconditional(route('r'))).toBe(true);
    expect(routeIsUnconditional(route('r', { when: { categoryIds: ['meal'], departmentIds: [] } }))).toBe(false);
    expect(routeIsUnconditional(route('r', { when: { categoryIds: [], departmentIds: ['d1'] } }))).toBe(false);
    expect(routeIsUnconditional(route('r', { when: { categoryIds: [], departmentIds: [], minClaimAmount: 0 } }))).toBe(false);
  });

  it('正常: 条件なしの経路が有効な経路より上にあれば知らせる（下が無効だけなら言わない）', () => {
    expect(approvalIssues({ ...DEFAULT_APPROVAL_SETTINGS, routes: [route('conditional', { when: { categoryIds: ['meal'], departmentIds: [] } }), route('fallback')] })).toEqual([]);
    expect(approvalIssues({ ...DEFAULT_APPROVAL_SETTINGS, routes: [route('fallback'), route('off', { enabled: false })] })).toEqual([]);
    expect(approvalIssues({ ...DEFAULT_APPROVAL_SETTINGS, routes: [route('fallback'), route('later')] }).map((issue) => issue.path)).toEqual(['routes.0.when']);
  });

  it('異常: 名前・重複 id・段の数・段の名前・選んでいない承認者を返す', () => {
    const issues = approvalIssues({
      routes: [
        route('r1', { name: '', when: { categoryIds: ['x'], departmentIds: [] }, steps: [] }),
        route('r1', { when: { categoryIds: ['x'], departmentIds: [] }, steps: [step('a'), step('a', { name: ' ' }), step('b', { name: 'x'.repeat(41), approver: { kind: 'employee', employeeId: '' } }), step('c', { approver: { kind: 'group', groupId: '' } }), step('d'), step('e')] }),
      ],
      defaultSteps: [],
      forbidClaimantApproval: true, requireDistinctApprovers: false,
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'routes.0.name', 'routes.0.steps', 'routes.1.id', 'routes.1.steps', 'routes.1.steps.1.name', 'routes.1.steps.1.id', 'routes.1.steps.2.name', 'routes.1.steps.2.approver', 'routes.1.steps.3.approver', 'defaultSteps',
    ]);
    expect(issues.find((issue) => issue.path === 'routes.1.steps')?.message[1]).toContain('5 つまで');
  });
});

describe('決まらない段・承認の流れ', () => {
  const unresolved = (cause: string, params: Record<string, string | null> = {}) => ({ stepId: 's1', stepName: '上長', cause, params });

  it('正常: 上長系・申請者の紐付け・指定の従業員は従業員へ、部門長・グループは組織へ、本人しかいないは承認経路へ', () => {
    expect(unresolvedStepView(unresolved('manager-missing', { claimant: 'テスト', employeeId: 'e5' }), { claimantEmployeeId: 'e1' }, en)).toMatchObject({
      key: 's1:manager-missing', stepName: '上長', cause: 'テスト has no manager set', fix: 'Set the manager in the employee master', target: { internalId: 'e5', section: 'employee' }, actionLabel: 'Open the employee',
    });
    expect(unresolvedStepView(unresolved('claimant-unlinked'), { claimantEmployeeId: 'e1' }, en).target).toEqual({ internalId: 'e1', section: 'employee' });
    expect(unresolvedStepView(unresolved('claimant-unlinked'), {}, en).target).toEqual({ internalId: '', section: 'employee' });
    expect(unresolvedStepView(unresolved('manager-disabled', { managerEmployeeId: 'e7' }), {}, en).target).toEqual({ internalId: 'e7', section: 'employee' });
    expect(unresolvedStepView(unresolved('manager-disabled', { employeeId: '' }), { claimantEmployeeId: 'e1' }, en).target).toEqual({ internalId: 'e1', section: 'employee' });
    expect(unresolvedStepView(unresolved('employee-disabled'), { spec: { kind: 'employee', employeeId: 'e8' } }, en).target).toEqual({ internalId: 'e8', section: 'employee' });
    expect(unresolvedStepView(unresolved('employee-disabled'), { spec: { kind: 'any-approver' } }, en).target).toEqual({ internalId: '', section: 'employee' });
    expect(unresolvedStepView(unresolved('department-head-missing', { departmentId: 'd3' }), {}, en)).toMatchObject({ target: { internalId: 'd3', section: 'organization' }, actionLabel: 'Open the organization' });
    expect(unresolvedStepView(unresolved('department-head-missing'), { spec: { kind: 'department-head', departmentId: 'd2' }, departmentId: 'd1' }, en).target.internalId).toBe('d2');
    expect(unresolvedStepView(unresolved('department-head-missing'), { spec: { kind: 'department-head' }, departmentId: 'd1' }, en).target.internalId).toBe('d1');
    expect(unresolvedStepView(unresolved('department-head-missing'), {}, en).target.internalId).toBe('');
    expect(unresolvedStepView(unresolved('group-empty', { groupId: 'g2' }), {}, en).target).toEqual({ internalId: 'g2', section: 'organization' });
    expect(unresolvedStepView(unresolved('group-empty'), { spec: { kind: 'group', groupId: 'g1' } }, en).target.internalId).toBe('g1');
    expect(unresolvedStepView(unresolved('group-empty'), {}, en).target.internalId).toBe('');
    expect(unresolvedStepView(unresolved('only-claimant'), { routeId: 'high' }, ja)).toMatchObject({ target: { internalId: 'high', section: 'approval' }, actionLabel: '承認経路を開く', cause: '承認者が申請者本人しかいません' });
    expect(unresolvedStepView(unresolved('something-new'), {}, en).target).toEqual({ internalId: '', section: 'approval' });
  });

  it('正常: 段の状態のラベル', () => {
    expect((['approved', 'pending', 'skipped', 'planned'] as const).map((state) => flowStepStateLabel(state, ja))).toEqual(['済み', '待ち', '飛ばし', '予定']);
  });

  const planStep = (stepId: string, overrides: Partial<ExpenseApprovalFlowViewDto['plan']['steps'][number]> = {}) => ({ stepId, name: stepId, approverKind: 'any-approver' as const, approvers: [], skipped: false, ...overrides });
  const flowStep = (stepId: string, overrides: Partial<NonNullable<ExpenseApprovalFlowViewDto['flow']>['steps'][number]> = {}) => ({ stepId, name: stepId, approverKind: 'claimant-manager' as const, approvers: [], status: 'pending' as const, ...overrides });

  it('正常: 保存済みの流れがあればその状態・判断・現在の段、無ければ予定（飛ばし・未解決の印）', () => {
    const decision = { by: 'u2', at: 'x', proxy: true };
    const flow = { routeId: 'high', routeName: '高額', resolvedAt: 'x', policyUpdatedAt: 'p', currentIndex: 1, steps: [flowStep('a', { status: 'approved', decision }), flowStep('b'), flowStep('c', { status: 'skipped' })] };
    const plan = { routeId: 'high', routeName: '高額', steps: [planStep('a'), planStep('b'), planStep('c', { skipped: true })], unresolved: [{ stepId: 'b', stepName: 'b', cause: 'group-empty', params: {} }] };
    const rows = flowStepRows({ plan, flow });
    expect(rows.map((row) => [row.state, row.current, row.unresolved])).toEqual([['approved', false, false], ['pending', true, true], ['skipped', false, false]]);
    expect(rows[0]?.decision).toEqual(decision);
    expect(rows[1]).not.toHaveProperty('decision');
    expect(flowStepRows({ plan, flow, current: { index: 2, stepId: 'c', stepName: 'c', approvers: [] } }).map((row) => row.current)).toEqual([false, false, true]);
    expect(flowStepRows({ plan }).map((row) => [row.state, row.current, row.unresolved])).toEqual([['planned', false, false], ['planned', false, true], ['skipped', false, false]]);
    expect(flowStepRows({ plan, current: { index: 0, stepId: 'a', stepName: 'a', approvers: [] } })[0]?.current).toBe(true);
  });

  it('正常: 表示を最小にするのは、経路なし・1 段・承認権限を持つ誰でも・未承認・代理でない・未解決なしのときだけ', () => {
    const plan = { routeName: '既定', steps: [planStep('approve')], unresolved: [] };
    expect(isMinimalFlow({ plan, proxy: false })).toBe(true);
    expect(isMinimalFlow({ plan: { ...plan, routeId: 'r' }, proxy: false })).toBe(false);
    expect(isMinimalFlow({ plan, proxy: true })).toBe(false);
    expect(isMinimalFlow({ plan: { ...plan, steps: [planStep('a'), planStep('b')] }, proxy: false })).toBe(false);
    expect(isMinimalFlow({ plan: { ...plan, steps: [planStep('a', { approverKind: 'group' })] }, proxy: false })).toBe(false);
    expect(isMinimalFlow({ plan: { ...plan, steps: [] }, proxy: false })).toBe(false);
    expect(isMinimalFlow({ plan: { ...plan, unresolved: [{ stepId: 'approve', stepName: '承認', cause: 'x', params: {} }] }, proxy: false })).toBe(false);
    const flow = { routeName: '既定', resolvedAt: 'x', policyUpdatedAt: 'p', currentIndex: 0, steps: [flowStep('approve', { approverKind: 'any-approver' })] };
    expect(isMinimalFlow({ plan, flow, proxy: false })).toBe(true);
    expect(isMinimalFlow({ plan, flow: { ...flow, currentIndex: 1, steps: [flowStep('approve', { approverKind: 'any-approver', status: 'approved' })] }, proxy: false })).toBe(false);
  });
});

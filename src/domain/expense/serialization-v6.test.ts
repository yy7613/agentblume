/**
 * 直列化の後方互換（docs/21 §20.2.13）と、実用化の集約の往復。
 *
 * `__fixtures__/v6-*.json` は実用化の実装に手を付ける**前**の MVP のコードで作り、1 回の復元・再直列化を通した正規形で保存したもの。
 * 実用化の後のコードで読んでも、未定義のキーを書かず、指紋も変わらないことを固定する（既存の判定を古くしない）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultApprovalSettings } from './approval';
import { claimFingerprint, createExpenseClaim, isJudgmentStale } from './claim';
import { ExpenseDomainError } from './errors';
import { DEFAULT_ADVANCE_POLICY_SETTINGS, DEFAULT_CARD_POLICY_SETTINGS, DEFAULT_TRANSPORT_SETTINGS } from './policy';
import {
  deserializeExpenseAdvance, deserializeExpenseCardImport, deserializeExpenseCardTransaction, deserializeExpenseClaim, deserializeExpenseEmployee,
  deserializeExpensePayoutBatch, deserializeExpensePolicy, deserializeExpensePolicyHearing, deserializeExpenseSettings,
  serializeExpenseAdvance, serializeExpenseCardImport, serializeExpenseCardTransaction, serializeExpenseClaim, serializeExpenseEmployee,
  serializeExpensePayoutBatch, serializeExpensePolicy, serializeExpensePolicyHearing, serializeExpenseSettings,
} from './serialization';
import { defaultExpenseSettings, EXPENSE_SETTINGS_KINDS } from './settings';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
const viaJson = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** MVP の実装で計算した指紋（テストに文字列で固定する。§20.2.13）。 */
const MVP_FINGERPRINT = 'f4a1f48034a7842949c';
const V6_POLICY_UPDATED_AT = '2026-09-14T09:00:00.000Z';
const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 'local', workspaceId: 'default' };
const sealed = (plain: string) => ({ v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plain).toString('base64'), hint: plain.slice(-4) });

describe('v6 の申請（MVP で保存した record_json）', () => {
  it.each(['draft', 'checked', 'approved', 'settled'])('正常: %s は読めて、再直列化がバイト同一', (state) => {
    const raw = fixture(`v6-claim-${state}.json`);
    const claim = deserializeExpenseClaim(JSON.parse(raw));
    expect(JSON.stringify(serializeExpenseClaim(claim))).toBe(raw);
    expect(claim).not.toHaveProperty('approvalFlow');
    expect(claim).not.toHaveProperty('advanceId');
    expect(claim.items.every((item) => item.extraction.flags === undefined && item.facts.route === undefined)).toBe(true);
  });

  it('正常: 指紋は MVP の実装の値と一致し、判定は古くならない', () => {
    for (const state of ['draft', 'checked', 'approved', 'settled']) {
      expect(claimFingerprint(deserializeExpenseClaim(JSON.parse(fixture(`v6-claim-${state}.json`))))).toBe(MVP_FINGERPRINT);
    }
    const checked = deserializeExpenseClaim(JSON.parse(fixture('v6-claim-checked.json')));
    expect(isJudgmentStale(checked, { updatedAt: V6_POLICY_UPDATED_AT })).toBe(false);
  });

  it('境界: 従業員の参照 id を足しても指紋は変わらず、仮払の紐付けは変わる', () => {
    const claim = deserializeExpenseClaim(JSON.parse(fixture('v6-claim-approved.json')));
    expect(claimFingerprint({ ...claim, claimant: { ...claim.claimant, employeeId: 'emp-1', departmentId: 'sales' } })).toBe(MVP_FINGERPRINT);
    expect(claimFingerprint({ ...claim, advanceId: 'adv-1' })).not.toBe(MVP_FINGERPRINT);
  });
});

describe('v6 の規程', () => {
  it('正常: 新しい節は既定値で補い、updatedAt と既存の項目は変えない', () => {
    const raw = JSON.parse(fixture('v6-policy.json')) as { categories: unknown; updatedAt: string };
    const policy = deserializeExpensePolicy(raw);
    expect(policy.updatedAt).toBe(V6_POLICY_UPDATED_AT);
    expect(policy.categories).toEqual(raw.categories);
    expect(policy.approval).toEqual(defaultApprovalSettings());
    expect(policy.transport).toEqual(DEFAULT_TRANSPORT_SETTINGS);
    expect(policy.card).toEqual(DEFAULT_CARD_POLICY_SETTINGS);
    expect(policy.advance).toEqual(DEFAULT_ADVANCE_POLICY_SETTINGS);
    // 次に保存すると既定値が明示的に書かれ、読み直しても同じ。
    expect(deserializeExpensePolicy(viaJson(serializeExpensePolicy(policy)))).toEqual(policy);
  });
});

describe('実用化の項目を持つ申請の往復', () => {
  const inApproval = createExpenseClaim({
    tenant, id: 'c9', claimant: { name: 'テスト太郎', employeeId: 'emp-1', departmentId: 'sales' }, period: { from: '2026-09-01', to: '2026-09-30' }, advanceId: 'adv-1',
    items: [{
      id: 'i1', categoryId: 'transport.public', facts: { transactionDate: '2026-09-10', amount: 420, route: { stations: ['新宿', '霞ケ関'], trips: 2, fareType: 'ic' } },
      source: { type: 'manual' }, extraction: { method: 'manual', warnings: [], flags: ['route-read', 'route-read'] },
    }],
    status: 'in-approval',
    approval: undefined,
    approvalFlow: {
      routeId: 'r1', routeName: '部門長 → 経理', resolvedAt: AT, policyUpdatedAt: AT, currentIndex: 1,
      steps: [
        { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'emp-2', name: 'テスト花子' }], status: 'approved', decision: { by: 'hanako', employeeId: 'emp-2', at: AT, proxy: false } },
        { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [], status: 'pending' },
      ],
    },
    history: [{ type: 'approval-step', by: 'hanako', at: AT, proxy: true }],
    submittedBy: 'keiri', createdAt: AT, updatedAt: AT,
  });

  it('正常: 承認中の流れ・仮払・参照 id・区間・印が往復で一致する（重複した印は 1 つにする）', () => {
    expect(inApproval.items[0]?.extraction.flags).toEqual(['route-read']);
    expect(deserializeExpenseClaim(viaJson(serializeExpenseClaim(inApproval)))).toEqual(inApproval);
  });

  it('異常: 壊れた新しい項目は ExpenseDomainError', () => {
    const broken = viaJson(inApproval) as Record<string, unknown>;
    expect(() => deserializeExpenseClaim({ ...broken, approvalFlow: { ...(broken['approvalFlow'] as object), currentIndex: 5 } })).toThrow(/currentIndex/u);
    expect(() => deserializeExpenseClaim({ ...broken, approvalFlow: undefined })).toThrow(/in-approval claim must have an approval flow/u);
    expect(() => deserializeExpenseClaim({ ...broken, status: 'checked' })).toThrow(/must not have an approval flow/u);
    expect(() => deserializeExpenseClaim({ ...broken, payout: { batchId: 'b1', exportedAt: AT } })).toThrow(/must not be in a payout batch/u);
    expect(() => deserializeExpenseClaim({ ...broken, history: [{ type: 'approval-step', at: AT, proxy: 'yes' }] })).toThrow(/proxy must be a boolean/u);
    const items = broken['items'] as Record<string, unknown>[];
    expect(() => deserializeExpenseClaim({ ...broken, items: [{ ...items[0], extraction: { method: 'manual', warnings: [], flags: ['unknown-flag'] } }] })).toThrow(ExpenseDomainError);
  });
});

describe('実用化の集約の往復', () => {
  const employee = deserializeExpenseEmployee({
    tenant, id: 'emp-1', code: 'E001', name: 'テスト太郎', nameKana: 'テスト タロウ', departmentId: 'sales', loginSubjects: ['taro@example.com'],
    bankAccount: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0000001'), holderKana: 'テスト タロウ', changedAt: AT, changedBy: 'keiri' },
    commuterPasses: [{ id: 'p1', stations: ['新宿', '四ツ谷'], validTo: '2027-03-31' }], enabled: true, history: [{ type: 'created', by: 'keiri', at: AT }], createdAt: AT, updatedAt: AT,
  });

  it('正常: 従業員・仮払・カード取込・カード利用・振込バッチ・ヒアリング・設定', () => {
    expect(deserializeExpenseEmployee(viaJson(serializeExpenseEmployee(employee)))).toEqual(employee);
    const advance = deserializeExpenseAdvance({
      tenant, id: 'adv-1', employeeId: 'emp-1', employeeSnapshot: { name: 'テスト太郎' }, purpose: '大阪出張', amount: 50000, neededOn: '2026-09-01', plannedSettleBy: '2026-09-30',
      status: 'paid', approval: { by: 'boss', at: AT, proxy: false }, payment: { paidOn: '2026-09-01', method: 'cash', by: 'keiri', at: AT }, submittedBy: 'keiri', history: [], createdAt: AT, updatedAt: AT,
    });
    expect(deserializeExpenseAdvance(viaJson(serializeExpenseAdvance(advance)))).toEqual(advance);
    const importRecord = deserializeExpenseCardImport({
      tenant, id: 'imp-1', fileName: 'card.csv', fileSha256: 'a'.repeat(64), mapping: { columns: { usedOn: '利用日', merchant: '利用先', amount: '金額' }, amountSign: 'charge-positive', skipLinesBefore: 0 },
      rowCount: 2, importedCount: 1, duplicateCount: 1, skippedRows: [], periodFrom: '2026-09-01', periodTo: '2026-09-30', by: 'keiri', createdAt: AT,
    });
    expect(deserializeExpenseCardImport(viaJson(serializeExpenseCardImport(importRecord)))).toEqual(importRecord);
    const transaction = deserializeExpenseCardTransaction({
      tenant, id: 'tx-1', importId: 'imp-1', cardId: 'card-1', usedOn: '2026-09-10', merchantRaw: 'サンプルマート', merchantKey: 'サンプルマート', amount: 1200, row: { 金額: '1200' },
      dedupeKey: 'card-1|2026-09-10|1200|サンプルマート|0', status: 'unmatched', createdAt: AT, updatedAt: AT,
    });
    expect(deserializeExpenseCardTransaction(viaJson(serializeExpenseCardTransaction(transaction)))).toEqual(transaction);
    const batch = deserializeExpensePayoutBatch({
      tenant, id: 'batch-1', status: 'exported', transferDate: '2026-09-25',
      lines: [{ employeeId: 'emp-1', name: 'テスト太郎', holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank: employee.bankAccount, amount: 420, sources: [{ kind: 'claim', id: 'c1', amount: 420 }] }],
      recordCount: 1, totalAmount: 420, fileName: 'zengin.txt', fileSha256: 'b'.repeat(64), settingsSnapshot: defaultExpenseSettings('payout'), acknowledgedWarnings: [], by: 'boss', createdAt: AT,
    });
    expect(deserializeExpensePayoutBatch(viaJson(serializeExpensePayoutBatch(batch)))).toEqual(batch);
    const hearing = deserializeExpensePolicyHearing({
      tenant, id: 'h1', mode: 'questions', source: {}, status: 'open', turns: [{ questions: [{ id: 'q1', text: '交際費の基準は？', kind: 'number', topic: 'entertainment' }], askedAt: AT }],
      basePolicyUpdatedAt: AT, promptVersion: 'expense-policy-hearing/v1', createdAt: AT, updatedAt: AT,
    });
    expect(deserializeExpensePolicyHearing(viaJson(serializeExpensePolicyHearing(hearing)))).toEqual(hearing);
    for (const kind of EXPENSE_SETTINGS_KINDS) {
      const value = defaultExpenseSettings(kind);
      expect(deserializeExpenseSettings(kind, viaJson(serializeExpenseSettings(kind, value)))).toEqual(value);
    }
  });

  it('異常: 壊れた record は復元元のラベル付きの ExpenseDomainError', () => {
    expect(() => deserializeExpenseEmployee({ id: 'x' })).toThrow(/deserializeExpenseEmployee: invalid record/u);
    expect(() => deserializeExpenseEmployee({ ...(viaJson(employee) as object), name: '' })).toThrow(/deserializeExpenseEmployee: expense employee: name/u);
    expect(() => deserializeExpenseAdvance({ tenant, id: 'a', status: 'paid' })).toThrow(/deserializeExpenseAdvance/u);
    expect(() => deserializeExpenseCardImport({ tenant, id: 'i' })).toThrow(/deserializeExpenseCardImport/u);
    expect(() => deserializeExpenseCardTransaction({ tenant, id: 't' })).toThrow(/deserializeExpenseCardTransaction/u);
    expect(() => deserializeExpensePayoutBatch({ tenant, id: 'b' })).toThrow(/deserializeExpensePayoutBatch/u);
    expect(() => deserializeExpensePolicyHearing({ tenant, id: 'h' })).toThrow(/deserializeExpensePolicyHearing/u);
    expect(() => deserializeExpenseSettings('organization', {})).toThrow(/deserializeExpenseSettings\(organization\): invalid record/u);
    expect(() => deserializeExpenseSettings('fares', { updatedAt: 'x' })).toThrow(/deserializeExpenseSettings\(fares\)/u);
  });
});

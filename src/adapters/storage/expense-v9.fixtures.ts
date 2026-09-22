/**
 * adapters層: 経費精算の実用化（docs/21 §20）の共通フィクスチャ（テスト専用。3 系統 A / B / C が使う完成品）。
 *
 * - すべて domain の create* を通す（契約テストが「保存できるはずのない値」を保存して実装差を見逃さないように）。
 * - 人名はテスト太郎〜テスト四郎、銀行コード・支店コードは形式だけ正しい**未割当の架空値**（9999 / 999）、
 *   口座番号は 0000001 形式。駅名は実在でよいが運賃は架空（§20.15）。
 * - 口座番号は封緘値で持つ（§20.17-1）。テストでは鍵を用意せずに済むよう、形だけ `SealedSecret` を満たす
 *   可逆な偽の暗号 `fixtureAccountCipher` を使う（暗号ではない。base64 にしただけ）。
 * - 値は呼ぶたびに新しく作る（テスト間で書き換えが漏れないように）。
 */
import { createExpenseAdvance, type AdvanceStatus, type CreateExpenseAdvanceProps, type ExpenseAdvance } from '../../domain/expense/advance';
import type { BankAccount } from '../../domain/expense/bank-account';
import {
  cardDedupeKey, createExpenseCardImport, createExpenseCardSettings, createExpenseCardTransaction,
  type ExpenseCardImport, type ExpenseCardSettings, type ExpenseCardTransaction,
} from '../../domain/expense/card';
import { payeeKeyOf } from '../../domain/expense/duplicates';
import { createExpenseEmployee, type CreateExpenseEmployeeProps, type ExpenseEmployee } from '../../domain/expense/employee';
import { createExpenseFareTable, type ExpenseFareTable } from '../../domain/expense/fare-table';
import { createExpenseOrganization, type ExpenseOrganization } from '../../domain/expense/organization';
import { createExpensePayoutBatch, createExpensePayoutSettings, type ExpensePayoutBatch, type ExpensePayoutSettings } from '../../domain/expense/payout';
import { createExpensePolicyHearing, type ExpensePolicyHearing } from '../../domain/expense/policy-hearing';
import type { SealedSecret } from '../../domain/model-settings/sealed-secret';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SecretCipherError, type SecretCipherPort } from '../../application/model-settings/secret-cipher';
import { scope } from './expense-repository.fixtures';

export { otherTenant, otherWorkspace, scope } from './expense-repository.fixtures';

export const V9_AT = '2026-09-15T00:00:00.000Z';

/**
 * 規程ヒアリングの版のフィクスチャ用の写し。版の正は `prompts/expense/policy-hearing.md` の frontmatter
 * （v48 / ADR-0052）で、domain には定数を置かない。ここは固定のテストデータが持つ値をそのまま書く。
 */
const V9_POLICY_HEARING_PROMPT_VERSION = 'expense-policy-hearing/v1';

/** 偽の暗号の印（本物の封緘値と取り違えないよう iv / tag を固定の値にする）。 */
const FIXTURE_IV = 'Zml4dHVyZS1pdg==';
const FIXTURE_TAG = 'Zml4dHVyZS10YWc=';

/** 7 桁の口座番号を封緘値の形にする（同期版。フィクスチャを async にしないため）。 */
export function fixtureSealAccountNumber(plain7digits: string): SealedSecret {
  if (!/^\d{7}$/u.test(plain7digits)) throw new Error(`fixtureSealAccountNumber: expected 7 digits, got "${plain7digits}"`);
  return { v: 1, alg: 'aes-256-gcm', iv: FIXTURE_IV, tag: FIXTURE_TAG, data: Buffer.from(plain7digits, 'utf8').toString('base64'), hint: plain7digits.slice(-4) };
}

/** テスト用の可逆な暗号（`SecretCipherPort`）。偽の印が無い封緘値は本物の暗号と同じく開封に失敗させる。 */
export const fixtureAccountCipher: SecretCipherPort = {
  async seal(plaintext: string): Promise<SealedSecret> {
    return { v: 1, alg: 'aes-256-gcm', iv: FIXTURE_IV, tag: FIXTURE_TAG, data: Buffer.from(plaintext, 'utf8').toString('base64'), hint: plaintext.slice(-4) };
  },
  async open(sealed: SealedSecret): Promise<string> {
    if (sealed.iv !== FIXTURE_IV || sealed.tag !== FIXTURE_TAG) throw new SecretCipherError('fixtureAccountCipher: not sealed by the fixture cipher');
    return Buffer.from(sealed.data, 'base64').toString('utf8');
  },
};

/* ---------------------------------------------------------------------------
 * 従業員（5 名）と組織
 * ------------------------------------------------------------------------- */

export const FIXTURE_EMPLOYEE_IDS = {
  taro: 'emp-taro',
  hanako: 'emp-hanako',
  jiro: 'emp-jiro',
  saburo: 'emp-saburo',
  shiro: 'emp-shiro',
} as const;

export const FIXTURE_DEPARTMENT_IDS = { admin: 'dept-admin', sales: 'dept-sales', accounting: 'dept-accounting' } as const;
export const FIXTURE_GROUP_IDS = { accounting: 'group-accounting' } as const;

export function bankAccountFixture(accountNumber: string, holderKana: string, overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    bankCode: '9999',
    branchCode: '999',
    accountType: 'ordinary',
    accountNumber: fixtureSealAccountNumber(accountNumber),
    holderKana,
    changedAt: V9_AT,
    changedBy: 'keiri@example.com',
    ...overrides,
  };
}

export function employeeFixture(id: string, overrides: Partial<CreateExpenseEmployeeProps> = {}): ExpenseEmployee {
  return createExpenseEmployee({
    tenant: scope,
    id,
    name: 'テスト太郎',
    loginSubjects: [],
    commuterPasses: [],
    history: [{ type: 'created', by: 'keiri@example.com', at: V9_AT }],
    createdAt: V9_AT,
    updatedAt: V9_AT,
    ...overrides,
  });
}

/**
 * 5 名: 太郎（営業部・上長は花子・定期あり）/ 花子（営業部長・上長は次郎）/ 次郎（管理本部長・上長なし）/
 * 三郎（経理部・**社員番号なし**・定期あり）/ 四郎（営業部・**無効**）。
 */
export function fixtureEmployees(tenant: TenantScope = scope): readonly ExpenseEmployee[] {
  return [
    employeeFixture(FIXTURE_EMPLOYEE_IDS.taro, {
      tenant, code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: FIXTURE_DEPARTMENT_IDS.sales, managerEmployeeId: FIXTURE_EMPLOYEE_IDS.hanako,
      loginSubjects: ['taro@example.com'], bankAccount: bankAccountFixture('0000001', 'テスト タロウ'),
      commuterPasses: [{ id: 'pass-taro', stations: ['中野', '新宿', '霞ケ関'], validFrom: '2026-04-01', validTo: '2027-03-31' }],
    }),
    employeeFixture(FIXTURE_EMPLOYEE_IDS.hanako, {
      tenant, code: 'E002', name: 'テスト花子', nameKana: 'テストハナコ', departmentId: FIXTURE_DEPARTMENT_IDS.sales, managerEmployeeId: FIXTURE_EMPLOYEE_IDS.jiro,
      loginSubjects: ['hanako@example.com'], bankAccount: bankAccountFixture('0000002', 'テスト ハナコ'),
    }),
    employeeFixture(FIXTURE_EMPLOYEE_IDS.jiro, {
      tenant, code: 'E003', name: 'テスト次郎', nameKana: 'テストジロウ', departmentId: FIXTURE_DEPARTMENT_IDS.admin,
      loginSubjects: ['jiro@example.com'], bankAccount: bankAccountFixture('0000003', 'テスト ジロウ'),
    }),
    employeeFixture(FIXTURE_EMPLOYEE_IDS.saburo, {
      tenant, name: 'テスト三郎', nameKana: 'テストサブロウ', departmentId: FIXTURE_DEPARTMENT_IDS.accounting, managerEmployeeId: FIXTURE_EMPLOYEE_IDS.jiro,
      loginSubjects: ['saburo@example.com', 'saburo-sso'], bankAccount: bankAccountFixture('0000004', 'テスト サブロウ', { accountType: 'savings' }),
      commuterPasses: [{ id: 'pass-saburo', stations: ['新宿', '霞ケ関'] }],
    }),
    employeeFixture(FIXTURE_EMPLOYEE_IDS.shiro, {
      tenant, code: 'E005', name: 'テスト四郎', nameKana: 'テストシロウ', departmentId: FIXTURE_DEPARTMENT_IDS.sales, managerEmployeeId: FIXTURE_EMPLOYEE_IDS.hanako,
      bankAccount: bankAccountFixture('0000005', 'テスト シロウ'), enabled: false,
      history: [{ type: 'created', by: 'keiri@example.com', at: V9_AT }, { type: 'disabled', by: 'keiri@example.com', at: '2026-09-15T01:00:00.000Z' }],
      updatedAt: '2026-09-15T01:00:00.000Z',
    }),
  ];
}

/** 部門 3（管理本部 > 営業部 / 経理部。経理部は部門長が空で親の部門長〈次郎〉へたどる）と承認グループ「経理」。 */
export function fixtureOrganization(updatedAt = V9_AT): ExpenseOrganization {
  return createExpenseOrganization({
    departments: [
      { id: FIXTURE_DEPARTMENT_IDS.admin, code: 'D100', name: '管理本部', headEmployeeId: FIXTURE_EMPLOYEE_IDS.jiro, enabled: true },
      { id: FIXTURE_DEPARTMENT_IDS.sales, code: 'D200', name: '営業部', parentId: FIXTURE_DEPARTMENT_IDS.admin, headEmployeeId: FIXTURE_EMPLOYEE_IDS.hanako, journalDimensionValueId: 'dept-sales', enabled: true },
      { id: FIXTURE_DEPARTMENT_IDS.accounting, code: 'D110', name: '経理部', parentId: FIXTURE_DEPARTMENT_IDS.admin, enabled: true },
    ],
    approverGroups: [
      { id: FIXTURE_GROUP_IDS.accounting, name: '経理', memberEmployeeIds: [FIXTURE_EMPLOYEE_IDS.saburo, FIXTURE_EMPLOYEE_IDS.jiro], enabled: true },
    ],
    updatedAt,
  });
}

/* ---------------------------------------------------------------------------
 * お金の流れ（カード・振込・仮払）
 * ------------------------------------------------------------------------- */

export const FIXTURE_CARD_IDS = { sales: 'card-sales', shared: 'card-shared' } as const;

/** カード 2（太郎の保有 / 共用）とプロファイル 1（汎用の見出し）。 */
export function fixtureCardSettings(updatedAt = V9_AT): ExpenseCardSettings {
  return createExpenseCardSettings({
    cards: [
      { id: FIXTURE_CARD_IDS.sales, label: '営業用カード', issuerName: 'サンプルカード', last4: '1111', holderEmployeeId: FIXTURE_EMPLOYEE_IDS.taro, enabled: true },
      { id: FIXTURE_CARD_IDS.shared, label: '共用カード', issuerName: 'サンプルカード', last4: '2222', enabled: true },
    ],
    profiles: [
      {
        id: 'profile-generic', name: 'サンプルカード 汎用', headerSignature: ['利用日', '利用店名', '利用金額', 'カード番号下4桁', '備考'],
        columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額', cardLast4: 'カード番号下4桁', memo: '備考' }, amountSign: 'charge-positive', skipLinesBefore: 0,
      },
    ],
    updatedAt,
  });
}

/** 振込元（9999 / 998 の架空口座）。依頼人コードも架空。 */
export function fixturePayoutSettings(updatedAt = V9_AT): ExpensePayoutSettings {
  return createExpensePayoutSettings({
    source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: fixtureSealAccountNumber('0000009') },
    requesterCode: '0000000001',
    requesterNameKana: 'サンプルシヨウジ',
    journal: { createPaymentEntry: false, sourceAccountId: 'asset.ordinary_deposit' },
    updatedAt,
  });
}

export function cardImportFixture(id: string, overrides: Partial<ExpenseCardImport> = {}): ExpenseCardImport {
  return createExpenseCardImport({
    tenant: scope,
    id,
    fileName: 'card-statement-generic.csv',
    fileSha256: 'd'.repeat(64),
    profileId: 'profile-generic',
    mapping: { columns: { usedOn: '利用日', merchant: '利用店名', amount: '利用金額' }, amountSign: 'charge-positive', skipLinesBefore: 0 },
    cardId: FIXTURE_CARD_IDS.sales,
    rowCount: 3,
    importedCount: 3,
    duplicateCount: 0,
    skippedRows: [],
    periodFrom: '2026-09-01',
    periodTo: '2026-09-30',
    by: 'keiri@example.com',
    createdAt: V9_AT,
    ...overrides,
  });
}

/** 利用 1 行。`dedupeKey` は既定で `cardId|usedOn|amount|merchantKey|0`。 */
export function cardTransactionFixture(id: string, overrides: Partial<ExpenseCardTransaction> = {}): ExpenseCardTransaction {
  const cardId = overrides.cardId ?? FIXTURE_CARD_IDS.sales;
  const usedOn = overrides.usedOn ?? '2026-09-10';
  const amount = overrides.amount ?? 3200;
  const merchantRaw = overrides.merchantRaw ?? 'サンプルマート 霞が関店';
  const merchantKey = overrides.merchantKey ?? payeeKeyOf(merchantRaw) ?? '';
  return createExpenseCardTransaction({
    tenant: scope,
    id,
    importId: 'import-1',
    cardId,
    usedOn,
    merchantRaw,
    merchantKey,
    amount,
    row: { 利用日: usedOn.replaceAll('-', '/'), 利用店名: merchantRaw, 利用金額: String(amount) },
    dedupeKey: cardDedupeKey(cardId, usedOn, amount, merchantKey, 0),
    status: 'unmatched',
    createdAt: V9_AT,
    updatedAt: V9_AT,
    ...overrides,
  });
}

/** 振込バッチ（太郎 1 行・申請 1 件）。口座は太郎の口座の写し（封緘値のまま）。 */
export function payoutBatchFixture(id: string, overrides: Partial<ExpensePayoutBatch> = {}): ExpensePayoutBatch {
  return createExpensePayoutBatch({
    tenant: scope,
    id,
    status: 'exported',
    transferDate: '2026-09-25',
    lines: [{
      employeeId: FIXTURE_EMPLOYEE_IDS.taro, name: 'テスト太郎', holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank: bankAccountFixture('0000001', 'テスト タロウ'),
      amount: 5180, sources: [{ kind: 'claim', id: 'claim-a', amount: 5180 }],
    }],
    recordCount: 1,
    totalAmount: 5180,
    fileName: 'zengin-2026-09-25.txt',
    fileSha256: 'c'.repeat(64),
    settingsSnapshot: fixturePayoutSettings(),
    acknowledgedWarnings: [],
    by: 'keiri@example.com',
    createdAt: V9_AT,
    ...overrides,
  });
}

/** 仮払の見本（requested: 太郎 / paid: 花子 / settled: 三郎〈差額 0〉）。 */
export function advanceFixture(id: string, status: Extract<AdvanceStatus, 'requested' | 'paid' | 'settled'> = 'requested', overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  const approval = { by: 'shonin@example.com', employeeId: FIXTURE_EMPLOYEE_IDS.jiro, at: '2026-09-02T00:00:00.000Z', proxy: false };
  const payment = { paidOn: '2026-09-03', method: 'transfer' as const, by: 'keiri@example.com', at: '2026-09-03T00:00:00.000Z' };
  const byStatus: Record<typeof status, Partial<CreateExpenseAdvanceProps>> = {
    requested: {},
    paid: { employeeId: FIXTURE_EMPLOYEE_IDS.hanako, employeeSnapshot: { name: 'テスト花子', departmentId: FIXTURE_DEPARTMENT_IDS.sales }, approval, payment },
    settled: {
      employeeId: FIXTURE_EMPLOYEE_IDS.saburo, employeeSnapshot: { name: 'テスト三郎', departmentId: FIXTURE_DEPARTMENT_IDS.accounting }, approval, payment,
      settlement: { computedAt: '2026-09-20T00:00:00.000Z', claimIds: ['claim-advance-1'], claimsTotal: 30000, difference: 0, settledOn: '2026-09-20' },
    },
  };
  return createExpenseAdvance({
    tenant: scope,
    id,
    employeeId: FIXTURE_EMPLOYEE_IDS.taro,
    employeeSnapshot: { name: 'テスト太郎', departmentId: FIXTURE_DEPARTMENT_IDS.sales },
    purpose: '大阪出張の交通費と宿泊費',
    amount: 30000,
    neededOn: '2026-09-05',
    plannedSettleBy: '2026-09-30',
    status,
    submittedBy: 'taro@example.com',
    history: [{ type: 'requested', by: 'taro@example.com', at: '2026-09-01T00:00:00.000Z' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...byStatus[status],
    ...overrides,
  });
}

export function fixtureAdvances(): readonly ExpenseAdvance[] {
  return [advanceFixture('adv-requested', 'requested'), advanceFixture('adv-paid', 'paid'), advanceFixture('adv-settled', 'settled')];
}

/* ---------------------------------------------------------------------------
 * 入力と規程（運賃マスタ・ヒアリング）
 * ------------------------------------------------------------------------- */

/** 数経路（片道・双方向・経由あり・切符・有効期間つき）と表記揺れの別名。運賃は架空。 */
export function fixtureFareTable(updatedAt = V9_AT): ExpenseFareTable {
  return createExpenseFareTable({
    routes: [
      { id: 'fare-nakano-shinjuku', stations: ['中野', '新宿'], fareType: 'ic', fare: 170, bidirectional: true },
      { id: 'fare-shinjuku-kasumigaseki', stations: ['新宿', '霞ケ関'], fareType: 'ic', fare: 200, bidirectional: true },
      { id: 'fare-nakano-kasumigaseki', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ic', fare: 300, bidirectional: true },
      { id: 'fare-nakano-kasumigaseki-ticket', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', fare: 320, bidirectional: false, validFrom: '2026-04-01', note: '運賃は架空' },
    ],
    stationAliases: [{ name: '霞ケ関', aliases: ['霞が関', '霞ヶ関'] }],
    updatedAt,
  });
}

export function hearingFixture(id: string, overrides: Partial<ExpensePolicyHearing> = {}): ExpensePolicyHearing {
  return createExpensePolicyHearing({
    tenant: scope,
    id,
    mode: 'questions',
    source: {},
    status: 'open',
    turns: [{ questions: [{ id: 'q1', text: 'タクシーの利用に上限はありますか', kind: 'number', topic: 'transport.taxi.limit' }], askedAt: V9_AT }],
    basePolicyUpdatedAt: '2026-09-14T09:00:00.000Z',
    promptVersion: V9_POLICY_HEARING_PROMPT_VERSION,
    createdAt: V9_AT,
    updatedAt: V9_AT,
    ...overrides,
  });
}

/** ヒアリングの見本（質問モードの open と、文書モードの proposed）。 */
export function fixtureHearings(): readonly ExpensePolicyHearing[] {
  return [
    hearingFixture('hearing-open'),
    hearingFixture('hearing-proposed', {
      mode: 'document',
      source: { documentText: '株式会社サンプル商事 旅費・経費規程\n第5条 タクシーは1回5,000円までとする。', fileName: 'policy-document-sample.md', sections: [{ heading: '第5条', start: 19, end: 43 }] },
      status: 'proposed',
      turns: [],
      proposal: {
        candidate: { severityOverrides: { 'amount-over-limit': 'return' } },
        rationales: [{ path: 'severityOverrides.amount-over-limit', quote: 'タクシーは1回5,000円までとする。', quoteFound: true }],
        dropped: [],
        warnings: [],
      },
      model: { provider: 'lm-studio', model: 'gemma-3-12b' },
      updatedAt: '2026-09-15T02:00:00.000Z',
    }),
  ];
}

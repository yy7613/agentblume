import { describe, expect, it } from 'vitest';
import { defaultExpensePolicy } from './default-policy';
import { ExpenseDomainError } from './errors';
import {
  categoryKey, createExpensePolicy, findCategory, guessCategory, POLICY_AMOUNT_MAX, POLICY_AMOUNT_MIN, preApprovalRulesFor, resolveCategory,
  type CreateExpensePolicyProps, type ExpenseCategory, type PreApprovalRule,
} from './policy';

function category(id: string, overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id,
    name: id,
    enabled: true,
    sortOrder: 10,
    aliases: [],
    accountId: 'expense.travel',
    defaultTaxRate: 10,
    taxCodeByRate: { '10': 'JP-IN-10-S' },
    receipt: { required: false },
    invoice: { required: false },
    requires: { purpose: false, attendees: false, attendeeDetails: false },
    limits: { perPersonBasis: 'tax-included' },
    ...overrides,
  };
}

function props(overrides: Partial<CreateExpensePolicyProps> = {}): CreateExpensePolicyProps {
  return {
    categories: [category('taxi', { name: 'タクシー', aliases: ['ハイヤー'] }), category('meal', { name: '会議費', aliases: ['打合せ'] })],
    claimRules: { submissionDeadlineDays: 31, nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false },
    preApprovalRules: [],
    severityOverrides: {},
    journal: { creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant}' },
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

const rule = (overrides: Partial<PreApprovalRule> = {}): PreApprovalRule => ({ id: 'r1', name: '条件', enabled: true, categoryIds: ['taxi'], ...overrides });
const withCategory = (overrides: Partial<ExpenseCategory>): CreateExpensePolicyProps => props({ categories: [category('taxi', overrides)] });
const create = (value: unknown): unknown => createExpensePolicy(value as CreateExpensePolicyProps);

describe('createExpensePolicy', () => {
  it('正常: 初期テンプレートが検証を通る', () => {
    const policy = defaultExpensePolicy();
    expect(createExpensePolicy(policy)).toEqual(policy);
  });

  it('正常: 名前・別名・税区分の前後空白を落とし、空の別名を除く', () => {
    const policy = createExpensePolicy(withCategory({ name: ' タクシー ', aliases: [' ハイヤー ', '  '], taxCodeByRate: { '10': ' JP-IN-10-S ', '8': '' } }));
    expect(policy.categories[0]).toMatchObject({ name: 'タクシー', aliases: ['ハイヤー'], taxCodeByRate: { '10': 'JP-IN-10-S' } });
    expect(policy.categories[0]?.taxCodeByRate['8']).toBeUndefined();
  });

  it('異常: 費目 id の重複を拒否する', () => {
    expect(() => createExpensePolicy(props({ categories: [category('taxi'), category('taxi', { name: '別名前' })] }))).toThrow(/duplicate category id/u);
  });

  it('異常: 有効な費目間で名前が衝突すると拒否する（NFKC・大小無視）', () => {
    expect(() => createExpensePolicy(props({ categories: [category('a', { name: 'Taxi' }), category('b', { name: 'ｔａｘｉ' })] }))).toThrow(ExpenseDomainError);
  });

  it('異常: 有効な費目の名前と別の費目の別名が衝突すると拒否する', () => {
    expect(() => createExpensePolicy(props({ categories: [category('a', { name: 'タクシー' }), category('b', { name: 'ハイヤー', aliases: ['タクシー'] })] }))).toThrow(/used by both a and b/u);
  });

  it('正常: 片方が無効な費目なら名前・別名の衝突を許す', () => {
    // 論理削除した旧費目と同名の新費目を作れないと、費目の作り直しができない
    const policy = createExpensePolicy(props({ categories: [category('a', { name: 'タクシー', enabled: false }), category('b', { name: 'タクシー', aliases: ['タクシー'] })] }));
    expect(policy.categories).toHaveLength(2);
  });

  it('異常: perPerson の上限があるのに人数必須でない費目を拒否する', () => {
    expect(() => createExpensePolicy(withCategory({ limits: { perPerson: 5000, perPersonBasis: 'tax-included' } }))).toThrow(/perPerson needs requires.attendees/u);
  });

  it('正常: perPerson の上限と人数必須の組み合わせは通る', () => {
    const policy = createExpensePolicy(withCategory({ requires: { purpose: false, attendees: true, attendeeDetails: false }, limits: { perPerson: 5000, perPersonBasis: 'tax-excluded' } }));
    expect(policy.categories[0]?.limits).toEqual({ perPerson: 5000, perPersonBasis: 'tax-excluded' });
  });

  it('異常: adjustable に無い重さを拒否する', () => {
    expect(() => createExpensePolicy(props({ severityOverrides: { 'receipt-missing': 'off' } }))).toThrow(/must be one of review, return \(received off\)/u);
    expect(() => createExpensePolicy(props({ severityOverrides: { 'purpose-missing': 'fatal' as never } }))).toThrow(ExpenseDomainError);
  });

  it('異常: 変更不可コードの上書きを拒否する', () => {
    expect(() => createExpensePolicy(props({ severityOverrides: { 'amount-missing': 'review' } }))).toThrow(/amount-missing cannot be changed/u);
  });

  it('異常: 未知の理由コードの上書きを拒否する', () => {
    expect(() => createExpensePolicy(props({ severityOverrides: { 'no-such-code': 'review' } }))).toThrow(/unknown reason code/u);
  });

  it('正常: 選べる重さの上書きは保存される', () => {
    expect(createExpensePolicy(props({ severityOverrides: { 'purpose-missing': 'off' } })).severityOverrides).toEqual({ 'purpose-missing': 'off' });
  });

  it('異常: 費目も金額条件も無い事前承認条件を拒否する', () => {
    expect(() => createExpensePolicy(props({ preApprovalRules: [rule({ categoryIds: [] })] }))).toThrow(/matches every item/u);
  });

  it('正常: 費目が空でも金額条件があれば通り、費目 id は重複を除く', () => {
    const policy = createExpensePolicy(props({ preApprovalRules: [rule({ categoryIds: [], minPerPerson: 5000 }), rule({ id: 'r2', categoryIds: ['taxi', 'taxi'] })] }));
    expect(policy.preApprovalRules[1]?.categoryIds).toEqual(['taxi']);
  });

  it('異常: 存在しない費目を指す事前承認条件を拒否する', () => {
    expect(() => createExpensePolicy(props({ preApprovalRules: [rule({ categoryIds: ['nothing'] })] }))).toThrow(/not in the policy: nothing/u);
  });

  it('異常: 事前承認条件の id 重複を拒否する', () => {
    expect(() => createExpensePolicy(props({ preApprovalRules: [rule(), rule({ name: '別' })] }))).toThrow(/duplicate pre-approval rule id/u);
  });

  it('境界: 金額 1 と 100,000,000 は通る', () => {
    expect(createExpensePolicy(withCategory({ limits: { perItem: POLICY_AMOUNT_MIN, perClaim: POLICY_AMOUNT_MAX, perPersonBasis: 'tax-included' } })).categories[0]?.limits)
      .toMatchObject({ perItem: 1, perClaim: 100_000_000 });
  });

  it.each([0, 100_000_001, 1.5, -1])('境界: 金額 %s は拒否する', (amount) => {
    expect(() => createExpensePolicy(withCategory({ limits: { perItem: amount, perPersonBasis: 'tax-included' } }))).toThrow(/integer between 1 and 100000000/u);
  });

  it('境界: 免除額にも同じ範囲を課す', () => {
    expect(() => createExpensePolicy(withCategory({ receipt: { required: true, exemptBelow: 0 } }))).toThrow(ExpenseDomainError);
  });

  it('境界: perUnit.label は 1〜4 字（0 字・空白だけ・5 字は拒否）', () => {
    expect(createExpensePolicy(withCategory({ limits: { perPersonBasis: 'tax-included', perUnit: { label: ' 泊 ', amount: 1 } } })).categories[0]?.limits.perUnit).toEqual({ label: '泊', amount: 1 });
    expect(createExpensePolicy(withCategory({ limits: { perPersonBasis: 'tax-included', perUnit: { label: '四文字だ', amount: 1 } } })).categories).toHaveLength(1);
    for (const label of ['', '  ', '五文字です']) {
      expect(() => createExpensePolicy(withCategory({ limits: { perPersonBasis: 'tax-included', perUnit: { label, amount: 1 } } }))).toThrow(/perUnit.label must be 1 to 4/u);
    }
  });

  it('異常: perUnit の金額が無い・範囲外は拒否する', () => {
    expect(() => create(withCategory({ limits: { perPersonBasis: 'tax-included', perUnit: { label: '泊' } as never } }))).toThrow(/perUnit.amount is required/u);
    expect(() => createExpensePolicy(withCategory({ limits: { perPersonBasis: 'tax-included', perUnit: { label: '泊', amount: 0 } } }))).toThrow(ExpenseDomainError);
  });

  it.each([
    ['id の形', { id: 'Bad Id' }, /id must match/u],
    ['sortOrder', { sortOrder: Number.NaN }, /sortOrder must be a number/u],
    ['aliases', { aliases: [1] }, /aliases must be an array of strings/u],
    ['defaultTaxRate', { defaultTaxRate: 5 }, /defaultTaxRate must be one of/u],
    ['taxCodeByRate', { taxCodeByRate: [] }, /taxCodeByRate must be an object/u],
    ['requires', { requires: null }, /requires must be/u],
    ['limits', { limits: null }, /limits must be an object/u],
    ['perPersonBasis', { limits: { perPersonBasis: 'gross' } }, /perPersonBasis must be one of/u],
    ['receipt', { receipt: null }, /receipt must be/u],
    ['enabled', { enabled: 'yes' }, /enabled must be a boolean/u],
    ['note の長さ', { note: 'x'.repeat(501) }, /note must be at most 500/u],
    ['code の型', { code: 1 }, /code must be a string/u],
  ])('異常: 費目の %s が不正なら拒否する', (_label, overrides, message) => {
    expect(() => create(withCategory(overrides as Partial<ExpenseCategory>))).toThrow(message);
  });

  it('異常: 費目が object でなければ拒否する', () => {
    expect(() => create(props({ categories: [null as never] }))).toThrow(/categories\[0\] must be an object/u);
  });

  it('異常: 規程全体の形が不正なら拒否する', () => {
    expect(() => create(null)).toThrow(/props are required/u);
    expect(() => create({ ...props(), categories: 'x' })).toThrow(/categories must be an array/u);
    expect(() => create({ ...props(), categories: Array.from({ length: 201 }, (_, index) => category(`c${index}`)) })).toThrow(/at most 200/u);
    expect(() => create({ ...props(), claimRules: null })).toThrow(/claimRules must be an object/u);
    expect(() => create({ ...props(), preApprovalRules: 'x' })).toThrow(/preApprovalRules must be an array/u);
    expect(() => create({ ...props(), preApprovalRules: Array.from({ length: 51 }, (_, index) => rule({ id: `r${index}` })) })).toThrow(/at most 50/u);
    expect(() => create({ ...props(), severityOverrides: [] })).toThrow(/severityOverrides must be an object/u);
    expect(() => create({ ...props(), journal: null })).toThrow(/journal must be an object/u);
    expect(() => create({ ...props(), updatedAt: 'yesterday' })).toThrow(ExpenseDomainError);
  });

  it.each([0, 3651, 1.5, '30'])('異常: 提出期限 %s は拒否する', (days) => {
    expect(() => create(props({ claimRules: { ...props().claimRules, submissionDeadlineDays: days as number } }))).toThrow(/submissionDeadlineDays/u);
  });

  it('正常: 提出期限 null は省略として扱い、支払方法の重複を除く', () => {
    const policy = create(props({ claimRules: { submissionDeadlineDays: null as never, nonReimbursablePaymentMethods: ['cash', 'cash'], attendeesIncludeClaimant: false, forbidSelfApproval: true } })) as ReturnType<typeof createExpensePolicy>;
    expect(policy.claimRules).toEqual({ nonReimbursablePaymentMethods: ['cash'], attendeesIncludeClaimant: false, forbidSelfApproval: true });
  });

  it('異常: 未知の支払方法・真偽でない規則を拒否する', () => {
    expect(() => create(props({ claimRules: { ...props().claimRules, nonReimbursablePaymentMethods: ['paypay' as never] } }))).toThrow(/nonReimbursablePaymentMethods/u);
    expect(() => create(props({ claimRules: { ...props().claimRules, forbidSelfApproval: 'no' as never } }))).toThrow(/forbidSelfApproval must be a boolean/u);
  });

  it('異常: 事前承認条件の形が不正なら拒否する', () => {
    expect(() => create(props({ preApprovalRules: [null as never] }))).toThrow(/must be an object/u);
    expect(() => create(props({ preApprovalRules: [rule({ id: 'A B' })] }))).toThrow(/id must match/u);
    expect(() => create(props({ preApprovalRules: [rule({ categoryIds: [1 as never] })] }))).toThrow(/categoryIds must be an array of strings/u);
  });

  it('異常: 仕訳連携の設定が不正なら拒否する', () => {
    const journal = props().journal;
    expect(() => create(props({ journal: { ...journal, creditAccountId: ' ' } }))).toThrow(ExpenseDomainError);
    expect(() => create(props({ journal: { ...journal, partnerFrom: 'vendor' as never } }))).toThrow(/partnerFrom must be one of/u);
    expect(() => create(props({ journal: { ...journal, descriptionTemplate: 'x'.repeat(201) } }))).toThrow(/descriptionTemplate/u);
  });

  it('境界: 摘要テンプレートは 200 字まで・空文字も可', () => {
    expect(createExpensePolicy(props({ journal: { ...props().journal, descriptionTemplate: 'x'.repeat(200) } })).journal.descriptionTemplate).toHaveLength(200);
    expect(createExpensePolicy(props({ journal: { ...props().journal, descriptionTemplate: '' } })).journal.descriptionTemplate).toBe('');
  });
});

describe('categoryKey / findCategory', () => {
  it('正常: NFKC・前後空白除去・小文字化', () => {
    expect(categoryKey(' ＴＡＸＩ ')).toBe('taxi');
  });

  it('正常: id で費目を引き、無効な費目も返す', () => {
    const policy = createExpensePolicy(props({ categories: [category('old', { enabled: false })] }));
    expect(findCategory(policy, 'old')?.id).toBe('old');
    expect(findCategory(policy, 'none')).toBeUndefined();
    expect(findCategory(policy, undefined)).toBeUndefined();
  });
});

describe('resolveCategory', () => {
  const policy = createExpensePolicy(props({
    categories: [
      category('taxi', { name: 'タクシー', aliases: ['ハイヤー', 'Cab'] }),
      category('meal', { name: '会議費', aliases: ['打合せ', '共通'] }),
      category('supplies', { name: '消耗品', aliases: ['共通2'] }),
      category('retired', { name: '旧費目', aliases: ['旧'], enabled: false }),
    ],
  }));

  it('正常: id 完全一致 → 名前 → 別名の順に当てる', () => {
    expect(resolveCategory(policy, ' taxi ')?.id).toBe('taxi');
    expect(resolveCategory(policy, '会議費')?.id).toBe('meal');
    expect(resolveCategory(policy, 'ハイヤー')?.id).toBe('taxi');
  });

  it('正常: NFKC・大小無視で別名に当てる', () => {
    expect(resolveCategory(policy, 'ｃａｂ')?.id).toBe('taxi');
    expect(resolveCategory(policy, 'ﾀｸｼｰ')?.id).toBe('taxi');
  });

  it('異常: 無効な費目には当てない', () => {
    expect(resolveCategory(policy, 'retired')).toBeUndefined();
    expect(resolveCategory(policy, '旧費目')).toBeUndefined();
    expect(resolveCategory(policy, '旧')).toBeUndefined();
  });

  it('境界: undefined・空白だけ・どれにも当たらない文字列は undefined', () => {
    expect(resolveCategory(policy, undefined)).toBeUndefined();
    expect(resolveCategory(policy, '  ')).toBeUndefined();
    expect(resolveCategory(policy, '交際費')).toBeUndefined();
  });

  it('境界: 複数に一致したら undefined（規程の検証を通らない形でも決めつけない）', () => {
    // 規程の検証は有効な費目間の衝突を断るので、ここは検証を通さない組み立てで防御を確かめる
    const ambiguousByAlias = { categories: [category('a', { aliases: ['共通'] }), category('b', { aliases: ['共通'] })] };
    const ambiguousByName = { categories: [category('a', { name: '同名' }), category('b', { name: '同名' })] };
    expect(resolveCategory(ambiguousByAlias, '共通')).toBeUndefined();
    expect(resolveCategory(ambiguousByName, '同名')).toBeUndefined();
  });
});

describe('guessCategory', () => {
  const policy = createExpensePolicy(props({
    categories: [
      category('taxi', { name: 'タクシー', aliases: ['タクシー代'] }),
      category('meal', { name: '会議費', aliases: ['弁当'] }),
      category('retired', { name: '旧', aliases: ['書籍'], enabled: false }),
    ],
  }));

  it('正常: 説明・支払先のどれかに別名が 1 費目だけ含まれれば当てる', () => {
    expect(guessCategory(policy, [undefined, '会議用の弁当 3 個'])?.id).toBe('meal');
  });

  it('異常: 2 費目以上に当たるなら決めつけない', () => {
    expect(guessCategory(policy, ['タクシー代と弁当'])).toBeUndefined();
  });

  it('境界: 無効な費目・何も無い入力は当てない', () => {
    expect(guessCategory(policy, ['書籍'])).toBeUndefined();
    expect(guessCategory(policy, [undefined, ''])).toBeUndefined();
  });
});

describe('preApprovalRulesFor', () => {
  it('正常: 有効な条件のうち、その費目を含むものと空の categoryIds（全費目）を返す', () => {
    const policy = createExpensePolicy(props({
      preApprovalRules: [rule({ id: 'taxi-only' }), rule({ id: 'all', categoryIds: [], minAmount: 1 }), rule({ id: 'meal-only', categoryIds: ['meal'] }), rule({ id: 'off', enabled: false })],
    }));
    expect(preApprovalRulesFor(policy, 'taxi').map((entry) => entry.id)).toEqual(['taxi-only', 'all']);
    expect(preApprovalRulesFor(policy, 'meal').map((entry) => entry.id)).toEqual(['all', 'meal-only']);
  });
});

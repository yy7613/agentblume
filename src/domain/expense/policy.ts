/**
 * ドメイン: 経費の規程（ExpensePolicy）集約（docs/21 §5 / ADR-0040 §3）。
 *
 * ワークスペースに 1 つ。**数値・費目・条件はすべてデータ**で、コードに上限額や費目名の列挙を持たない
 * （`default-policy.ts` の初期テンプレートだけが例外で、そこも初期値に過ぎない）。費目は id で参照し、削除は論理（`enabled: false`）。
 *
 * 事前承認条件は汎用の条件式にせず「費目 × 1 件の金額以上 × 1 人あたりの金額以上」の AND に限る
 * （経理担当が上限を 1 つ直すのに条件式を読ませないため）。
 */
import { PAYMENT_METHODS, type PaymentMethod } from '../journal/document';
import { assertNonEmpty } from '../shared/assert';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { validateApprovalSettings, type ApprovalSettings } from './approval';
import { ExpenseDomainError } from './errors';
import { ROUTE_FARE_TYPES, type FareType } from './receipt-facts';
import type { ExpenseCategoryId, PreApprovalRuleId } from './ids';
import { isReasonCode, REASON_CATALOG, SEVERITY_OVERRIDES, type ExpenseReasonCode, type SeverityOverride } from './reason-codes';

export const EXPENSE_TAX_RATES = [10, 8, 0] as const;
export type ExpenseTaxRate = (typeof EXPENSE_TAX_RATES)[number];
export const PER_PERSON_BASES = ['tax-included', 'tax-excluded'] as const;
export type PerPersonBasis = (typeof PER_PERSON_BASES)[number];
export const PARTNER_FROM = ['claimant', 'payee'] as const;
export type JournalPartnerFrom = (typeof PARTNER_FROM)[number];

export const CATEGORY_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
export const POLICY_MAX_CATEGORIES = 200;
export const POLICY_MAX_PRE_APPROVAL_RULES = 50;
/** 金額の設定値の範囲（上限・閾値）。 */
export const POLICY_AMOUNT_MIN = 1;
export const POLICY_AMOUNT_MAX = 100_000_000;
export const DESCRIPTION_TEMPLATE_MAX = 200;
export const PER_UNIT_LABEL_MAX = 4;
export const SUBMISSION_DEADLINE_MAX_DAYS = 3650;

export interface Requirement {
  readonly required: boolean;
  /** この金額未満は不要（省略 = 金額に関係なく required に従う）。 */
  readonly exemptBelow?: number;
}

export interface CategoryLimits {
  readonly perItem?: number;
  readonly perClaim?: number;
  readonly perPerson?: number;
  readonly perPersonBasis: PerPersonBasis;
  /** 日当・宿泊など単位あたりの上限。単位の表示名（日・泊）はデータで、コードは単位の種類を知らない。 */
  readonly perUnit?: { readonly label: string; readonly amount: number };
}

export interface ExpenseCategory {
  readonly id: ExpenseCategoryId;
  readonly code?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
  readonly aliases: readonly string[];
  /** 仕訳の科目 id。規程側では存在を検証しない（科目マスタは仕訳 BC のデータ。連携時に検証する）。 */
  readonly accountId?: string;
  readonly defaultTaxRate: ExpenseTaxRate;
  readonly taxCodeByRate: { readonly '10'?: string; readonly '8'?: string; readonly '0'?: string };
  readonly receipt: Requirement;
  readonly invoice: Requirement;
  readonly requires: { readonly purpose: boolean; readonly attendees: boolean; readonly attendeeDetails: boolean };
  readonly limits: CategoryLimits;
  readonly note?: string;
  /** 交通費の検査（UC8。§20.2.2）。省略 = 区間の記入も照合もしない。 */
  readonly route?: CategoryRouteSettings;
}

export interface CategoryRouteSettings {
  /** 区間（出発駅・到着駅）の記入が必要か（`route-missing`）。 */
  readonly required: boolean;
  /** 通勤定期と重なる区間を検出するか。 */
  readonly commuterPass: boolean;
  /** 運賃マスタと照合するか。 */
  readonly fareTable: boolean;
}

export interface PreApprovalRule {
  readonly id: PreApprovalRuleId;
  readonly name: string;
  readonly enabled: boolean;
  /** 空 = 全費目。 */
  readonly categoryIds: readonly string[];
  readonly minAmount?: number;
  readonly minPerPerson?: number;
  readonly note?: string;
}

export interface ClaimRules {
  /** 取引日から取込までの期限（日）。省略で `submission-late` を出さない。 */
  readonly submissionDeadlineDays?: number;
  readonly nonReimbursablePaymentMethods: readonly PaymentMethod[];
  readonly attendeesIncludeClaimant: boolean;
  readonly forbidSelfApproval: boolean;
}

export interface JournalLinkSettings {
  readonly creditAccountId: string;
  readonly creditTaxCode: string;
  readonly partnerFrom: JournalPartnerFrom;
  /** `{claimant}` `{payee}` `{category}` `{purpose}` `{description}` `{claimId}` を置換する。 */
  readonly descriptionTemplate: string;
  /** 仕訳の補助軸 id（標準セットは `department`）。設定すると費用行へ部門の値を入れる（§20.12）。 */
  readonly departmentDimensionId?: string;
}

/** 交通費の照合（UC8。§20.2.2）。 */
export interface TransportSettings {
  /** 定期区間の照合をするか（従業員に定期が無ければ何もしない）。 */
  readonly commuterPassDeduction: boolean;
  /** 運賃超過の許容差（円）。 */
  readonly fareToleranceYen: number;
  /** 明細の区間に IC / 切符の別が無いとき。 */
  readonly defaultFareType: FareType;
}

/** 法人カードの照合と会社払いの明細（UC5。§20.2.2）。`ExpenseCardSettings`（カードの登録）とは別の、規程側の運用。 */
export interface CardPolicySettings {
  /** 会社払いの明細を申請に含める運用か（§20.17-4 の決定で既定 off。off なら MVP どおり `payment-not-reimbursable`）。 */
  readonly acceptCorporatePaymentItems: boolean;
  readonly dateToleranceDays: number;
  readonly amountToleranceYen: number;
  /** 加盟店名が食い違うときでも弱い一致にする最低金額（少額の偶然の一致を拾わない）。 */
  readonly weakMatchMinAmount: number;
  /** 会社払い明細の仕訳の貸方（未払金）。 */
  readonly creditAccountId: string;
  readonly creditTaxCode: string;
}

/** 仮払の仕訳の科目（UC4。§20.2.2）。 */
export interface AdvancePolicySettings {
  readonly advanceAccountId: string;
  readonly paymentAccountId: string;
  readonly refundAccountId: string;
  /** 支払から精算までの目安（台帳の「期限切れ」表示。理由コードにしない）。 */
  readonly settleWithinDays?: number;
}

export interface ExpensePolicy {
  readonly categories: readonly ExpenseCategory[];
  readonly claimRules: ClaimRules;
  readonly preApprovalRules: readonly PreApprovalRule[];
  readonly severityOverrides: Readonly<Partial<Record<ExpenseReasonCode, SeverityOverride>>>;
  readonly journal: JournalLinkSettings;
  /** 承認経路（UC2）。経路を設定しない会社は 1 段の承認（MVP と同じ）。 */
  readonly approval: ApprovalSettings;
  readonly transport: TransportSettings;
  readonly card: CardPolicySettings;
  readonly advance: AdvancePolicySettings;
  readonly updatedAt: IsoDateTime;
}

/*
 * 実用化の設定の既定値（§20.2.2）。MVP で保存した規程にはこれらのキーが無く、読み込むと `createExpensePolicy` がこの値で補う
 * （`updatedAt` は変えないので既存の判定は古くならない）。科目 id は仕訳の標準セット（`journal/default-chart.ts`）のもの。
 */
export const DEFAULT_TRANSPORT_SETTINGS: TransportSettings = { commuterPassDeduction: true, fareToleranceYen: 0, defaultFareType: 'ic' };
export const DEFAULT_CARD_POLICY_SETTINGS: CardPolicySettings = {
  acceptCorporatePaymentItems: false, dateToleranceDays: 3, amountToleranceYen: 0, weakMatchMinAmount: 3000, creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA',
};
export const DEFAULT_ADVANCE_POLICY_SETTINGS: AdvancePolicySettings = { advanceAccountId: 'asset.suspense_paid', paymentAccountId: 'asset.ordinary_deposit', refundAccountId: 'asset.ordinary_deposit' };

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** 名前・別名の照合キー（NFKC・前後空白除去・小文字化）。 */
export function categoryKey(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

function optionalText(value: unknown, label: string, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(`${label} must be at most ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

function optionalAmount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < POLICY_AMOUNT_MIN || value > POLICY_AMOUNT_MAX) {
    throw fail(`${label} must be an integer between ${POLICY_AMOUNT_MIN} and ${POLICY_AMOUNT_MAX}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw fail(`${label} must be a boolean`);
  return value;
}

function validateRequirement(value: unknown, label: string): Requirement {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be { required, exemptBelow? }`);
  const raw = value as Record<string, unknown>;
  return withDefined({ required: requireBoolean(raw['required'], `${label}.required`), exemptBelow: optionalAmount(raw['exemptBelow'], `${label}.exemptBelow`) });
}

function validateCategoryRoute(value: unknown, label: string): CategoryRouteSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be { required, commuterPass, fareTable }`);
  const raw = value as Record<string, unknown>;
  return { required: requireBoolean(raw['required'], `${label}.required`), commuterPass: requireBoolean(raw['commuterPass'], `${label}.commuterPass`), fareTable: requireBoolean(raw['fareTable'], `${label}.fareTable`) };
}

function section(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boolOr(value: unknown, fallback: boolean, label: string): boolean {
  return value === undefined || value === null ? fallback : requireBoolean(value, label);
}

function intOr(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function textOr(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 128) throw fail(`${label} must be 1 to 128 characters`);
  return value.trim();
}

/** 交通費の設定（省略した項目は既定値）。 */
export function validateTransportSettings(value: unknown, label = 'expense policy: transport'): TransportSettings {
  const raw = section(value, label);
  const fareType = raw['defaultFareType'] ?? DEFAULT_TRANSPORT_SETTINGS.defaultFareType;
  if (!(ROUTE_FARE_TYPES as readonly unknown[]).includes(fareType)) throw fail(`${label}.defaultFareType must be one of ${ROUTE_FARE_TYPES.join(', ')}`);
  return {
    commuterPassDeduction: boolOr(raw['commuterPassDeduction'], DEFAULT_TRANSPORT_SETTINGS.commuterPassDeduction, `${label}.commuterPassDeduction`),
    fareToleranceYen: intOr(raw['fareToleranceYen'], DEFAULT_TRANSPORT_SETTINGS.fareToleranceYen, 0, 10_000, `${label}.fareToleranceYen`),
    defaultFareType: fareType as FareType,
  };
}

/** カードの運用の設定（省略した項目は既定値）。 */
export function validateCardPolicySettings(value: unknown, label = 'expense policy: card'): CardPolicySettings {
  const raw = section(value, label);
  const defaults = DEFAULT_CARD_POLICY_SETTINGS;
  return {
    acceptCorporatePaymentItems: boolOr(raw['acceptCorporatePaymentItems'], defaults.acceptCorporatePaymentItems, `${label}.acceptCorporatePaymentItems`),
    dateToleranceDays: intOr(raw['dateToleranceDays'], defaults.dateToleranceDays, 0, 10, `${label}.dateToleranceDays`),
    amountToleranceYen: intOr(raw['amountToleranceYen'], defaults.amountToleranceYen, 0, 1_000, `${label}.amountToleranceYen`),
    weakMatchMinAmount: intOr(raw['weakMatchMinAmount'], defaults.weakMatchMinAmount, 1, 1_000_000, `${label}.weakMatchMinAmount`),
    creditAccountId: textOr(raw['creditAccountId'], defaults.creditAccountId, `${label}.creditAccountId`),
    creditTaxCode: textOr(raw['creditTaxCode'], defaults.creditTaxCode, `${label}.creditTaxCode`),
  };
}

/** 仮払の設定（省略した項目は既定値）。 */
export function validateAdvancePolicySettings(value: unknown, label = 'expense policy: advance'): AdvancePolicySettings {
  const raw = section(value, label);
  const defaults = DEFAULT_ADVANCE_POLICY_SETTINGS;
  const within = raw['settleWithinDays'];
  return withDefined({
    advanceAccountId: textOr(raw['advanceAccountId'], defaults.advanceAccountId, `${label}.advanceAccountId`),
    paymentAccountId: textOr(raw['paymentAccountId'], defaults.paymentAccountId, `${label}.paymentAccountId`),
    refundAccountId: textOr(raw['refundAccountId'], defaults.refundAccountId, `${label}.refundAccountId`),
    settleWithinDays: within === undefined || within === null ? undefined : intOr(within, 1, 1, 365, `${label}.settleWithinDays`),
  });
}

function validateCategory(value: unknown, index: number): ExpenseCategory {
  const label = `expense policy: categories[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || !CATEGORY_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${CATEGORY_ID_PATTERN.source}`);
  assertNonEmpty(raw['name'], `${label}.name`, fail);
  if (typeof raw['sortOrder'] !== 'number' || !Number.isFinite(raw['sortOrder'])) throw fail(`${label}.sortOrder must be a number`);
  if (!Array.isArray(raw['aliases']) || raw['aliases'].some((alias) => typeof alias !== 'string')) throw fail(`${label}.aliases must be an array of strings`);
  if (!(EXPENSE_TAX_RATES as readonly unknown[]).includes(raw['defaultTaxRate'])) throw fail(`${label}.defaultTaxRate must be one of ${EXPENSE_TAX_RATES.join(', ')}`);
  const taxCodes = raw['taxCodeByRate'];
  if (taxCodes === null || typeof taxCodes !== 'object' || Array.isArray(taxCodes)) throw fail(`${label}.taxCodeByRate must be an object`);
  const taxCodeByRate = withDefined({
    '10': optionalText((taxCodes as Record<string, unknown>)['10'], `${label}.taxCodeByRate.10`, 64),
    '8': optionalText((taxCodes as Record<string, unknown>)['8'], `${label}.taxCodeByRate.8`, 64),
    '0': optionalText((taxCodes as Record<string, unknown>)['0'], `${label}.taxCodeByRate.0`, 64),
  });
  const requires = raw['requires'] as Record<string, unknown> | null | undefined;
  if (requires === null || typeof requires !== 'object') throw fail(`${label}.requires must be { purpose, attendees, attendeeDetails }`);
  const limits = raw['limits'] as Record<string, unknown> | null | undefined;
  if (limits === null || typeof limits !== 'object') throw fail(`${label}.limits must be an object`);
  if (!(PER_PERSON_BASES as readonly unknown[]).includes(limits['perPersonBasis'])) throw fail(`${label}.limits.perPersonBasis must be one of ${PER_PERSON_BASES.join(', ')}`);
  let perUnit: CategoryLimits['perUnit'];
  if (limits['perUnit'] !== undefined && limits['perUnit'] !== null) {
    const unit = limits['perUnit'] as Record<string, unknown>;
    if (typeof unit !== 'object') throw fail(`${label}.limits.perUnit must be { label, amount }`);
    if (typeof unit['label'] !== 'string' || unit['label'].trim().length === 0 || unit['label'].trim().length > PER_UNIT_LABEL_MAX) {
      throw fail(`${label}.limits.perUnit.label must be 1 to ${PER_UNIT_LABEL_MAX} characters`);
    }
    const amount = optionalAmount(unit['amount'], `${label}.limits.perUnit.amount`);
    if (amount === undefined) throw fail(`${label}.limits.perUnit.amount is required`);
    perUnit = { label: unit['label'].trim(), amount };
  }
  const category: ExpenseCategory = withDefined({
    id: raw['id'],
    code: optionalText(raw['code'], `${label}.code`, 64),
    name: (raw['name'] as string).trim(),
    enabled: requireBoolean(raw['enabled'], `${label}.enabled`),
    sortOrder: raw['sortOrder'],
    aliases: (raw['aliases'] as string[]).map((alias) => alias.trim()).filter((alias) => alias.length > 0),
    accountId: optionalText(raw['accountId'], `${label}.accountId`, 128),
    defaultTaxRate: raw['defaultTaxRate'] as ExpenseTaxRate,
    taxCodeByRate,
    receipt: validateRequirement(raw['receipt'], `${label}.receipt`),
    invoice: validateRequirement(raw['invoice'], `${label}.invoice`),
    requires: {
      purpose: requireBoolean(requires['purpose'], `${label}.requires.purpose`),
      attendees: requireBoolean(requires['attendees'], `${label}.requires.attendees`),
      attendeeDetails: requireBoolean(requires['attendeeDetails'], `${label}.requires.attendeeDetails`),
    },
    limits: withDefined({
      perItem: optionalAmount(limits['perItem'], `${label}.limits.perItem`),
      perClaim: optionalAmount(limits['perClaim'], `${label}.limits.perClaim`),
      perPerson: optionalAmount(limits['perPerson'], `${label}.limits.perPerson`),
      perPersonBasis: limits['perPersonBasis'] as PerPersonBasis,
      perUnit,
    }),
    note: optionalText(raw['note'], `${label}.note`),
    route: validateCategoryRoute(raw['route'], `${label}.route`),
  });
  // 人数が無いと 1 人あたりを判定できない（黙って判定しないより、設定の時点で直させる）。
  if (category.limits.perPerson !== undefined && !category.requires.attendees) {
    throw fail(`${label}: limits.perPerson needs requires.attendees to be true (a per-person limit cannot be checked without the number of attendees)`);
  }
  return category;
}

function validatePreApprovalRule(value: unknown, index: number, categoryIds: ReadonlySet<string>): PreApprovalRule {
  const label = `expense policy: preApprovalRules[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || !CATEGORY_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${CATEGORY_ID_PATTERN.source}`);
  assertNonEmpty(raw['name'], `${label}.name`, fail);
  if (!Array.isArray(raw['categoryIds']) || raw['categoryIds'].some((id) => typeof id !== 'string')) throw fail(`${label}.categoryIds must be an array of strings`);
  const rule: PreApprovalRule = withDefined({
    id: raw['id'],
    name: (raw['name'] as string).trim(),
    enabled: requireBoolean(raw['enabled'], `${label}.enabled`),
    categoryIds: [...new Set(raw['categoryIds'] as string[])],
    minAmount: optionalAmount(raw['minAmount'], `${label}.minAmount`),
    minPerPerson: optionalAmount(raw['minPerPerson'], `${label}.minPerPerson`),
    note: optionalText(raw['note'], `${label}.note`),
  });
  // 費目も金額条件も無い条件は全明細に当たり、全件が事前承認待ちになる（設定の誤りとして断る）。
  if (rule.categoryIds.length === 0 && rule.minAmount === undefined && rule.minPerPerson === undefined) {
    throw fail(`${label} (${rule.name}) matches every item: choose categories or set minAmount / minPerPerson`);
  }
  const unknown = rule.categoryIds.filter((id) => !categoryIds.has(id));
  if (unknown.length > 0) throw fail(`${label} (${rule.name}) refers to categories that are not in the policy: ${unknown.join(', ')}`);
  return rule;
}

export interface CreateExpensePolicyProps {
  readonly categories: readonly ExpenseCategory[];
  readonly claimRules: ClaimRules;
  readonly preApprovalRules: readonly PreApprovalRule[];
  readonly severityOverrides: Readonly<Partial<Record<string, SeverityOverride>>>;
  readonly journal: JournalLinkSettings;
  /** 実用化の設定。省略（MVP で保存した規程）は既定値で補う。 */
  readonly approval?: unknown;
  readonly transport?: Partial<TransportSettings>;
  readonly card?: Partial<CardPolicySettings>;
  readonly advance?: Partial<AdvancePolicySettings>;
  readonly updatedAt: string;
}

/** 規程を組み立てて不変条件を検証する。 */
export function createExpensePolicy(props: CreateExpensePolicyProps): ExpensePolicy {
  if (props === null || typeof props !== 'object') throw fail('expense policy: props are required');
  if (!Array.isArray(props.categories)) throw fail('expense policy: categories must be an array');
  if (props.categories.length > POLICY_MAX_CATEGORIES) throw fail(`expense policy: categories must have at most ${POLICY_MAX_CATEGORIES} entries`);
  const categories = props.categories.map((category, index) => validateCategory(category, index));

  const ids = new Set<string>();
  for (const category of categories) {
    if (ids.has(category.id)) throw fail(`expense policy: duplicate category id: ${category.id}`);
    ids.add(category.id);
  }
  // 名前と別名は有効な費目の間で一意（どちらに当てるか決められない取込を作らない）。
  const keys = new Map<string, string>();
  for (const category of categories.filter((entry) => entry.enabled)) {
    const own = new Set([category.name, ...category.aliases].map(categoryKey));
    for (const key of own) {
      const holder = keys.get(key);
      if (holder !== undefined) throw fail(`expense policy: the name or alias "${key}" is used by both ${holder} and ${category.id} (enabled categories must not share names or aliases)`);
      keys.set(key, category.id);
    }
  }

  const rules = props.claimRules as unknown as Record<string, unknown> | null;
  if (rules === null || typeof rules !== 'object') throw fail('expense policy: claimRules must be an object');
  const deadline = rules['submissionDeadlineDays'];
  if (deadline !== undefined && deadline !== null && (typeof deadline !== 'number' || !Number.isInteger(deadline) || deadline < 1 || deadline > SUBMISSION_DEADLINE_MAX_DAYS)) {
    throw fail(`expense policy: claimRules.submissionDeadlineDays must be an integer between 1 and ${SUBMISSION_DEADLINE_MAX_DAYS}`);
  }
  const methods = rules['nonReimbursablePaymentMethods'];
  if (!Array.isArray(methods) || methods.some((method) => !(PAYMENT_METHODS as readonly unknown[]).includes(method))) {
    throw fail(`expense policy: claimRules.nonReimbursablePaymentMethods must be an array of ${PAYMENT_METHODS.join(', ')}`);
  }
  const claimRules: ClaimRules = withDefined({
    submissionDeadlineDays: deadline === null ? undefined : deadline as number | undefined,
    nonReimbursablePaymentMethods: [...new Set(methods as PaymentMethod[])],
    attendeesIncludeClaimant: requireBoolean(rules['attendeesIncludeClaimant'], 'expense policy: claimRules.attendeesIncludeClaimant'),
    forbidSelfApproval: requireBoolean(rules['forbidSelfApproval'], 'expense policy: claimRules.forbidSelfApproval'),
  });

  if (!Array.isArray(props.preApprovalRules)) throw fail('expense policy: preApprovalRules must be an array');
  if (props.preApprovalRules.length > POLICY_MAX_PRE_APPROVAL_RULES) throw fail(`expense policy: preApprovalRules must have at most ${POLICY_MAX_PRE_APPROVAL_RULES} entries`);
  const preApprovalRules = props.preApprovalRules.map((rule, index) => validatePreApprovalRule(rule, index, ids));
  const ruleIds = new Set<string>();
  for (const rule of preApprovalRules) {
    if (ruleIds.has(rule.id)) throw fail(`expense policy: duplicate pre-approval rule id: ${rule.id}`);
    ruleIds.add(rule.id);
  }

  const overrides = props.severityOverrides as unknown;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) throw fail('expense policy: severityOverrides must be an object');
  const severityOverrides: Partial<Record<ExpenseReasonCode, SeverityOverride>> = {};
  for (const [code, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!isReasonCode(code)) throw fail(`expense policy: severityOverrides has an unknown reason code: ${code}`);
    const adjustable = REASON_CATALOG[code].adjustable;
    if (!(SEVERITY_OVERRIDES as readonly unknown[]).includes(value) || !adjustable.includes(value as SeverityOverride)) {
      throw fail(adjustable.length === 0
        ? `expense policy: severityOverrides.${code} cannot be changed`
        : `expense policy: severityOverrides.${code} must be one of ${adjustable.join(', ')} (received ${String(value)})`);
    }
    severityOverrides[code] = value as SeverityOverride;
  }

  const journal = props.journal as unknown as Record<string, unknown> | null;
  if (journal === null || typeof journal !== 'object') throw fail('expense policy: journal must be an object');
  assertNonEmpty(journal['creditAccountId'], 'expense policy: journal.creditAccountId', fail);
  assertNonEmpty(journal['creditTaxCode'], 'expense policy: journal.creditTaxCode', fail);
  if (!(PARTNER_FROM as readonly unknown[]).includes(journal['partnerFrom'])) throw fail(`expense policy: journal.partnerFrom must be one of ${PARTNER_FROM.join(', ')}`);
  if (typeof journal['descriptionTemplate'] !== 'string' || journal['descriptionTemplate'].length > DESCRIPTION_TEMPLATE_MAX) {
    throw fail(`expense policy: journal.descriptionTemplate must be a string of at most ${DESCRIPTION_TEMPLATE_MAX} characters`);
  }
  const dimension = journal['departmentDimensionId'];
  if (dimension !== undefined && dimension !== null && dimension !== '' && (typeof dimension !== 'string' || dimension.trim().length > 64)) {
    throw fail('expense policy: journal.departmentDimensionId must be a string of at most 64 characters');
  }
  assertIsoDateTime(props.updatedAt, 'expense policy: updatedAt', fail);

  return {
    categories,
    claimRules,
    preApprovalRules,
    severityOverrides,
    journal: withDefined({
      creditAccountId: (journal['creditAccountId'] as string).trim(),
      creditTaxCode: (journal['creditTaxCode'] as string).trim(),
      partnerFrom: journal['partnerFrom'] as JournalPartnerFrom,
      descriptionTemplate: journal['descriptionTemplate'],
      departmentDimensionId: typeof dimension === 'string' && dimension.trim() !== '' ? dimension.trim() : undefined,
    }),
    approval: validateApprovalSettings(props.approval, ids),
    transport: validateTransportSettings(props.transport),
    card: validateCardPolicySettings(props.card),
    advance: validateAdvancePolicySettings(props.advance),
    updatedAt: props.updatedAt,
  };
}

/** id で費目を引く（無効な費目も返す）。 */
export function findCategory(policy: Pick<ExpensePolicy, 'categories'>, id: string | undefined): ExpenseCategory | undefined {
  return id === undefined ? undefined : policy.categories.find((category) => category.id === id);
}

/**
 * 取込時の費目文字列から費目を当てる: 有効な費目の id 完全一致 → 名前 → 別名（NFKC・前後空白除去・小文字化）。
 * 複数に当たる・どれにも当たらないときは undefined（`category-missing`。取込時の文字列は `categoryText` に残す）。
 */
export function resolveCategory(policy: Pick<ExpensePolicy, 'categories'>, text: string | undefined): ExpenseCategory | undefined {
  if (text === undefined) return undefined;
  const key = categoryKey(text);
  if (key === '') return undefined;
  const enabled = policy.categories.filter((category) => category.enabled);
  const byId = enabled.find((category) => category.id === text.trim());
  if (byId !== undefined) return byId;
  const byName = enabled.filter((category) => categoryKey(category.name) === key);
  if (byName.length > 0) return byName.length === 1 ? byName[0] : undefined;
  const byAlias = enabled.filter((category) => category.aliases.some((alias) => categoryKey(alias) === key));
  return byAlias.length === 1 ? byAlias[0] : undefined;
}

/**
 * 読取した説明・支払先から費目を推定する（ツールの試算用）。**別名が 1 つの費目だけ**含まれるときに限る
 * （2 つ以上に当たるなら決めつけず、利用者に聞かせる）。
 */
export function guessCategory(policy: Pick<ExpensePolicy, 'categories'>, texts: readonly (string | undefined)[]): ExpenseCategory | undefined {
  const haystack = categoryKey(texts.filter((text): text is string => text !== undefined).join(' '));
  if (haystack === '') return undefined;
  const matched = policy.categories.filter((category) => category.enabled
    && category.aliases.some((alias) => { const key = categoryKey(alias); return key !== '' && haystack.includes(key); }));
  return matched.length === 1 ? matched[0] : undefined;
}

/** その費目に当たる事前承認条件（有効なものだけ。空の categoryIds は全費目）。 */
export function preApprovalRulesFor(policy: Pick<ExpensePolicy, 'preApprovalRules'>, categoryId: string): readonly PreApprovalRule[] {
  return policy.preApprovalRules.filter((rule) => rule.enabled && (rule.categoryIds.length === 0 || rule.categoryIds.includes(categoryId)));
}

/**
 * ドメイン: 審査基準（Playbook）の集約（docs/23 §2.1〜§2.4、ADR-0042 §3）。
 *
 * 条項の種類（トピック）・基準・推奨文案・法令照合の日数・印紙税の表は**ワークスペースのデータ**で、
 * 同梱テンプレートは初期値に過ぎない。コードに持つのは値の型（valueKind）・比較演算子・検査の種類だけ。
 *
 * 利用者データなので、基準を壊すと判定が一斉に `field-missing` になる。そこで保存時に
 * 「トピック id の一意性」「基準の topicId 参照」「condition のパスがそのトピックの valueKind にあるか」
 * 「推奨文案の置換子が既知か」を検証して 400 で返す（ADR-0042 帰結）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import { isFieldPathFor, PAYMENT_METHODS, VALUE_KINDS, type ValueKind } from './clause-value';
import { conditionValueProblem, isConditionOp, type Condition } from './conditions';
import { ContractDomainError } from './errors';
import type { PlaybookId } from './ids';
import type { LegalSettings } from './legal-checks';
import type { StampDutySettings, StampDutyTier } from './stamp-duty';
import { CONTRACT_NATURES, isOneOf, OUR_ROLES, type OurRole } from './vocabulary';

export interface ClauseTopic {
  readonly id: string;
  readonly label: string;
  readonly valueKind: ValueKind;
  readonly keywords: readonly string[];
  readonly guidance: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export const LEGAL_RULES = ['payment-max-days', 'prohibited-payment-method'] as const;
export type LegalRule = (typeof LEGAL_RULES)[number];

export type CriterionCheck =
  | { readonly type: 'required' }
  | { readonly type: 'condition'; readonly conditions: readonly Condition[] }
  | { readonly type: 'legal'; readonly rule: LegalRule }
  | { readonly type: 'llm'; readonly question: string; readonly passWhen: 'yes' | 'no' };

export interface PlaybookCriterion {
  readonly id: string;
  readonly topicId: string;
  /** 省略は全立場。 */
  readonly appliesToRoles?: readonly OurRole[];
  readonly check: CriterionCheck;
  readonly onFail: 'negotiate' | 'reject';
  /** 推奨修正文案。置換子 `{counterparty}` `{us}` `{paymentMaxDays}` `{articleRef}` を持てる。 */
  readonly recommendedText?: string;
  readonly rationale: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export interface ExtractionSettings {
  readonly scanAllArticles: boolean;
  readonly chunkMaxChars: number;
}

export interface Playbook {
  readonly tenant: TenantScope;
  readonly id: PlaybookId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly ourRole: OurRole;
  readonly ourCompanyNames: readonly string[];
  readonly topics: readonly ClauseTopic[];
  readonly criteria: readonly PlaybookCriterion[];
  readonly legal: LegalSettings;
  readonly stampDuty: StampDutySettings;
  readonly extraction: ExtractionSettings;
  /** どのテンプレートから作ったか（表示用）。 */
  readonly templateId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreatePlaybookProps = Playbook;

export interface PlaybookSummary {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly ourRole: OurRole;
  readonly topicCount: number;
  readonly criterionCount: number;
  readonly templateId?: string;
  readonly updatedAt: string;
}

export const RECOMMENDED_TEXT_PLACEHOLDERS = ['counterparty', 'us', 'paymentMaxDays', 'articleRef'] as const;
export type RecommendedTextPlaceholder = (typeof RECOMMENDED_TEXT_PLACEHOLDERS)[number];

export const CHUNK_MAX_CHARS_RANGE = { min: 1000, max: 20_000 } as const;
const TOPIC_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HTTP_URL = /^https?:\/\/\S+$/u;

function fail(message: string): never {
  throw new ContractDomainError(`createPlaybook: ${message}`);
}
function nonEmpty(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  if (value.length > max) fail(`${label} must be at most ${max} characters`);
  return value;
}
function intIn(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}
function stringList(value: unknown, label: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must be an array of at most ${maxItems} strings`);
  return value.map((entry, index) => nonEmpty(entry, `${label}[${index}]`, maxLength));
}

/** 推奨文案の中の置換子で、既知でないもの。 */
export function unknownPlaceholders(text: string): readonly string[] {
  return [...text.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1]!).filter((name) => !(RECOMMENDED_TEXT_PLACEHOLDERS as readonly string[]).includes(name));
}

export function expandRecommendedText(text: string, values: Readonly<Record<RecommendedTextPlaceholder, string>>): string {
  return text.replace(/\{(counterparty|us|paymentMaxDays|articleRef)\}/gu, (_whole, name: RecommendedTextPlaceholder) => values[name]);
}

function validateTopic(topic: ClauseTopic, index: number): ClauseTopic {
  const label = `topics[${index}]`;
  if (typeof topic?.id !== 'string' || !TOPIC_ID.test(topic.id)) fail(`${label}.id must be lower-case letters, digits, "_" or "-" (1-64 characters)`);
  if (!isOneOf(VALUE_KINDS, topic.valueKind)) fail(`${label}.valueKind is not supported: ${String(topic.valueKind)}`);
  return {
    id: topic.id,
    label: nonEmpty(topic.label, `${label}.label`, 100),
    valueKind: topic.valueKind,
    keywords: stringList(topic.keywords, `${label}.keywords`, 30, 50),
    guidance: typeof topic.guidance === 'string' && topic.guidance.length <= 1000 ? topic.guidance : fail(`${label}.guidance must be a string of at most 1000 characters`),
    enabled: boolean(topic.enabled, `${label}.enabled`),
    sortOrder: intIn(topic.sortOrder, `${label}.sortOrder`, -1_000_000, 1_000_000),
  };
}

function validateCheck(check: CriterionCheck, topic: ClauseTopic, label: string): CriterionCheck {
  switch (check?.type) {
    case 'required': return { type: 'required' };
    case 'condition': {
      if (!Array.isArray(check.conditions) || check.conditions.length === 0 || check.conditions.length > 10) fail(`${label}.conditions must have 1 to 10 conditions`);
      return {
        type: 'condition',
        conditions: check.conditions.map((condition, index) => {
          const at = `${label}.conditions[${index}]`;
          if (typeof condition?.field !== 'string' || !isFieldPathFor(topic.valueKind, condition.field)) fail(`${at}.field "${String(condition?.field)}" is not a field of the clause type "${topic.id}" (${topic.valueKind})`);
          if (!isConditionOp(condition.op)) fail(`${at}.op is not supported: ${String(condition.op)}`);
          const problem = conditionValueProblem(condition);
          if (problem !== undefined) fail(`${at}: ${problem}`);
          return { field: condition.field, op: condition.op, ...(condition.value === undefined ? {} : { value: Array.isArray(condition.value) ? [...condition.value] : condition.value }) };
        }),
      };
    }
    case 'legal':
      if (!isOneOf(LEGAL_RULES, check.rule)) fail(`${label}.rule is not supported: ${String(check.rule)}`);
      if (topic.valueKind !== 'payment_terms') fail(`${label}: legal checks need a clause type of payment_terms (topic "${topic.id}" is ${topic.valueKind})`);
      return { type: 'legal', rule: check.rule };
    case 'llm':
      if (check.passWhen !== 'yes' && check.passWhen !== 'no') fail(`${label}.passWhen must be yes or no`);
      return { type: 'llm', question: nonEmpty(check.question, `${label}.question`, 500), passWhen: check.passWhen };
    default:
      return fail(`${label}.type must be required, condition, legal or llm`);
  }
}

function validateCriterion(criterion: PlaybookCriterion, index: number, topics: ReadonlyMap<string, ClauseTopic>): PlaybookCriterion {
  const label = `criteria[${index}]`;
  const id = nonEmpty(criterion?.id, `${label}.id`, 64);
  const topic = topics.get(criterion.topicId);
  if (topic === undefined) fail(`${label}.topicId "${String(criterion.topicId)}" does not match any clause type`);
  if (criterion.appliesToRoles !== undefined && (!Array.isArray(criterion.appliesToRoles) || criterion.appliesToRoles.length === 0 || !criterion.appliesToRoles.every((role) => isOneOf(OUR_ROLES, role)))) fail(`${label}.appliesToRoles must list client, vendor or mutual`);
  if (criterion.onFail !== 'negotiate' && criterion.onFail !== 'reject') fail(`${label}.onFail must be negotiate or reject`);
  let recommendedText: string | undefined;
  if (criterion.recommendedText !== undefined && criterion.recommendedText !== '') {
    recommendedText = nonEmpty(criterion.recommendedText, `${label}.recommendedText`, 2000);
    const unknown = unknownPlaceholders(recommendedText);
    if (unknown.length > 0) fail(`${label}.recommendedText has unknown placeholders: ${unknown.map((name) => `{${name}}`).join(', ')} (use {counterparty}, {us}, {paymentMaxDays}, {articleRef})`);
  }
  return {
    id,
    topicId: topic.id,
    ...(criterion.appliesToRoles === undefined ? {} : { appliesToRoles: [...criterion.appliesToRoles] }),
    check: validateCheck(criterion.check, topic, `${label}.check`),
    onFail: criterion.onFail,
    ...(recommendedText === undefined ? {} : { recommendedText }),
    rationale: typeof criterion.rationale === 'string' && criterion.rationale.length <= 1000 ? criterion.rationale : fail(`${label}.rationale must be a string of at most 1000 characters`),
    enabled: boolean(criterion.enabled, `${label}.enabled`),
    sortOrder: intIn(criterion.sortOrder, `${label}.sortOrder`, -1_000_000, 1_000_000),
  };
}

function validateLegal(legal: LegalSettings): LegalSettings {
  if (legal === null || typeof legal !== 'object') fail('legal must be an object');
  if (!Array.isArray(legal.prohibitedPaymentMethods) || !legal.prohibitedPaymentMethods.every((method) => isOneOf(PAYMENT_METHODS, method))) fail(`legal.prohibitedPaymentMethods must list ${PAYMENT_METHODS.join(', ')}`);
  if (!Array.isArray(legal.sources) || legal.sources.length > 20) fail('legal.sources must be an array of at most 20 links');
  return {
    paymentMaxDays: intIn(legal.paymentMaxDays, 'legal.paymentMaxDays', 1, 365),
    freelancePaymentMaxDays: intIn(legal.freelancePaymentMaxDays, 'legal.freelancePaymentMaxDays', 1, 365),
    freelanceRedelegationMaxDays: intIn(legal.freelanceRedelegationMaxDays, 'legal.freelanceRedelegationMaxDays', 1, 365),
    prohibitedPaymentMethods: [...new Set(legal.prohibitedPaymentMethods)],
    allowMonthEndNextMonthEnd: boolean(legal.allowMonthEndNextMonthEnd, 'legal.allowMonthEndNextMonthEnd'),
    dueSoonDays: intIn(legal.dueSoonDays, 'legal.dueSoonDays', 0, 365),
    sources: legal.sources.map((source, index) => {
      const url = nonEmpty(source?.url, `legal.sources[${index}].url`, 500);
      if (!HTTP_URL.test(url)) fail(`legal.sources[${index}].url must be an http(s) URL`);
      return { label: nonEmpty(source.label, `legal.sources[${index}].label`, 200), url };
    }),
  };
}

function validateStampDuty(settings: StampDutySettings): StampDutySettings {
  if (settings === null || typeof settings !== 'object' || !Array.isArray(settings.documentTypes) || settings.documentTypes.length > 30) fail('stampDuty.documentTypes must be an array of at most 30 document types');
  const codes = new Set<string>();
  return {
    enabled: boolean(settings.enabled, 'stampDuty.enabled'),
    documentTypes: settings.documentTypes.map((type, index) => {
      const label = `stampDuty.documentTypes[${index}]`;
      const code = nonEmpty(type?.code, `${label}.code`, 20);
      if (codes.has(code)) fail(`${label}.code "${code}" is used twice`);
      codes.add(code);
      if (!Array.isArray(type.natures) || type.natures.length === 0 || !(type.natures as readonly unknown[]).every((nature: unknown) => isOneOf(CONTRACT_NATURES, nature))) fail(`${label}.natures must list contract natures (${CONTRACT_NATURES.join(', ')})`);
      const tiers = type.tiers?.map((tier: StampDutyTier, tierIndex: number) => {
        const upTo = tier?.upTo === null ? null : intIn(tier?.upTo, `${label}.tiers[${tierIndex}].upTo`, 0, Number.MAX_SAFE_INTEGER);
        return { upTo, amount: intIn(tier.amount, `${label}.tiers[${tierIndex}].amount`, 0, 100_000_000) };
      });
      if (tiers !== undefined && tiers.slice(0, -1).some((tier: StampDutyTier) => tier.upTo === null)) fail(`${label}.tiers: only the last tier may have no upper bound`);
      if (type.fixedAmount === undefined && (tiers === undefined || tiers.length === 0)) fail(`${label} needs either fixedAmount or tiers`);
      const condition = type.condition === undefined ? undefined : {
        ...(type.condition.excludeTermMonthsAtMost === undefined ? {} : { excludeTermMonthsAtMost: intIn(type.condition.excludeTermMonthsAtMost, `${label}.condition.excludeTermMonthsAtMost`, 1, 1200) }),
        ...(type.condition.unlessRenewal === undefined ? {} : { unlessRenewal: boolean(type.condition.unlessRenewal, `${label}.condition.unlessRenewal`) }),
      };
      return {
        code,
        name: nonEmpty(type.name, `${label}.name`, 100),
        natures: [...type.natures],
        ...(condition === undefined ? {} : { condition }),
        ...(type.fixedAmount === undefined ? {} : { fixedAmount: intIn(type.fixedAmount, `${label}.fixedAmount`, 0, 100_000_000) }),
        ...(tiers === undefined ? {} : { tiers }),
        ...(type.noAmountStated === undefined ? {} : { noAmountStated: intIn(type.noAmountStated, `${label}.noAmountStated`, 0, 100_000_000) }),
        sourceUrl: typeof type.sourceUrl === 'string' && type.sourceUrl.length <= 500 ? type.sourceUrl : fail(`${label}.sourceUrl must be a string`),
        note: typeof type.note === 'string' && type.note.length <= 500 ? type.note : fail(`${label}.note must be a string of at most 500 characters`),
      };
    }),
  };
}

export function createPlaybook(props: CreatePlaybookProps): Playbook {
  if (props === null || typeof props !== 'object') fail('props must be an object');
  if (typeof props.tenant?.tenantId !== 'string' || typeof props.tenant.workspaceId !== 'string') fail('tenant is required');
  if (!isOneOf(OUR_ROLES, props.ourRole)) fail('ourRole must be client, vendor or mutual');
  if (!Array.isArray(props.topics) || props.topics.length === 0 || props.topics.length > 50) fail('topics must have 1 to 50 clause types');
  if (!Array.isArray(props.criteria) || props.criteria.length > 200) fail('criteria must be an array of at most 200 criteria');
  const topics = props.topics.map(validateTopic);
  const topicMap = new Map<string, ClauseTopic>();
  for (const topic of topics) {
    if (topicMap.has(topic.id)) fail(`topic id "${topic.id}" is used twice`);
    topicMap.set(topic.id, topic);
  }
  const criteria = props.criteria.map((criterion, index) => validateCriterion(criterion, index, topicMap));
  const criterionIds = new Set<string>();
  for (const criterion of criteria) {
    if (criterionIds.has(criterion.id)) fail(`criterion id "${criterion.id}" is used twice`);
    criterionIds.add(criterion.id);
  }
  if (props.extraction === null || typeof props.extraction !== 'object') fail('extraction must be an object');
  return {
    tenant: { tenantId: nonEmpty(props.tenant.tenantId, 'tenant.tenantId', 200), workspaceId: nonEmpty(props.tenant.workspaceId, 'tenant.workspaceId', 200) },
    id: nonEmpty(props.id, 'id', 100),
    name: nonEmpty(props.name, 'name', 100),
    isDefault: boolean(props.isDefault, 'isDefault'),
    ourRole: props.ourRole,
    ourCompanyNames: stringList(props.ourCompanyNames, 'ourCompanyNames', 20, 100),
    topics,
    criteria,
    legal: validateLegal(props.legal),
    stampDuty: validateStampDuty(props.stampDuty),
    extraction: {
      scanAllArticles: boolean(props.extraction.scanAllArticles, 'extraction.scanAllArticles'),
      chunkMaxChars: intIn(props.extraction.chunkMaxChars, 'extraction.chunkMaxChars', CHUNK_MAX_CHARS_RANGE.min, CHUNK_MAX_CHARS_RANGE.max),
    },
    ...(props.templateId === undefined ? {} : { templateId: nonEmpty(props.templateId, 'templateId', 64) }),
    createdAt: nonEmpty(props.createdAt, 'createdAt', 40),
    updatedAt: nonEmpty(props.updatedAt, 'updatedAt', 40),
  };
}

export function toPlaybookSummary(playbook: Playbook): PlaybookSummary {
  return {
    id: playbook.id, name: playbook.name, isDefault: playbook.isDefault, ourRole: playbook.ourRole,
    topicCount: playbook.topics.length, criterionCount: playbook.criteria.length,
    ...(playbook.templateId === undefined ? {} : { templateId: playbook.templateId }),
    updatedAt: playbook.updatedAt,
  };
}

/** 有効なトピックを表示順に。 */
export function enabledTopics(playbook: Pick<Playbook, 'topics'>): readonly ClauseTopic[] {
  return playbook.topics.filter((topic) => topic.enabled).sort((left, right) => left.sortOrder - right.sortOrder);
}

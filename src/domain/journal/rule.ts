/**
 * ドメイン: 自動仕訳ルール（JournalRule）集約（docs/20 §2.3）。
 *
 * freee / MF / 弥生 の自動仕訳ルールの共通形。`mode: 'auto'` は Stage 1 で確定してよいルール、
 * `'suggest'` は一致しても Stage 2 に回す（freee の「推測」）。競合は priority → 特異度 → createdAt。
 * 科目は id で参照し、名称変更に追従する（消えた / 無効化された科目は判定時に `unknown-account`）。
 *
 * 形は UI の `JournalRuleDto` と同型（テナントスコープ `tenant` を除く。`scope` はルールの適用範囲）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { DIRECTIONS, DOCUMENT_KINDS, INVOICE_STATUSES, type Direction, type DocumentKind, type InvoiceStatus, type JsonValue } from './document';
import { JournalDomainError } from './errors';
import type { JournalRuleId } from './ids';

export const CONDITION_OPS = ['equals', 'contains', 'startsWith', 'endsWith', 'regex', 'between', 'gte', 'lte', 'in', 'exists', 'notExists', 'isTrue', 'isFalse'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface RuleCondition {
  /** facts のパス（`descriptionNorm`, `grandTotal`, `lines[].description`, `extra.<key>` …）。 */
  readonly field: string;
  readonly op: ConditionOp;
  readonly value?: JsonValue;
}

export const RULE_MODES = ['auto', 'suggest'] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const ENTRY_SIDES = ['debit', 'credit'] as const;
export type EntrySide = (typeof ENTRY_SIDES)[number];

export const AMOUNT_SPEC_KEYWORDS = ['total', 'taxable:10', 'taxable:8', 'tax:10', 'tax:8', 'remainder'] as const;
export type AmountSpecKeyword = (typeof AMOUNT_SPEC_KEYWORDS)[number];
export type AmountSpec = AmountSpecKeyword | { readonly fixed: number } | { readonly ratio: number };

export type PartnerFrom = 'issuerName' | 'counterpartyHint' | { readonly fixed: string };

export interface OutcomeLine {
  readonly side: EntrySide;
  readonly accountId: string;
  readonly dimensionValues?: { readonly [dimensionId: string]: string };
  readonly taxCode: string;
  readonly amount: AmountSpec;
  readonly partnerFrom?: PartnerFrom;
}

export interface RuleOutcome {
  readonly lines: readonly OutcomeLine[];
  /** `{issuerName}` `{description}` `{counterpartyHint}` `{transactionDate}` `{grandTotal}` `{extra.<key>}` を置換する。 */
  readonly descriptionTemplate?: string;
  /** `auto` は登録番号の有無と取引日から決める。省略も `auto`。 */
  readonly invoiceStatus?: InvoiceStatus | 'auto';
}

export interface AskIf {
  readonly conditions: readonly RuleCondition[];
  readonly questionId: string;
  readonly prompt: string;
}

export interface RuleScope {
  readonly documentKinds?: readonly DocumentKind[];
  readonly direction?: Direction;
  readonly accountHints?: readonly string[];
}

export const RULE_ORIGINS = ['manual', 'hearing', 'seed'] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

export interface RuleProvenance {
  readonly origin: RuleOrigin;
  readonly hearingId?: string;
  readonly exampleDocumentIds: readonly string[];
}

export interface JournalRule {
  readonly tenant: TenantScope;
  readonly id: JournalRuleId;
  readonly name: string;
  readonly enabled: boolean;
  readonly mode: RuleMode;
  /** 整数。大きいほど優先。 */
  readonly priority: number;
  readonly scope: RuleScope;
  readonly conditions: readonly RuleCondition[];
  readonly outcome: RuleOutcome;
  readonly askIf: readonly AskIf[];
  /** 確定に必要な facts パス。欠けていれば `undecided(missing-fact)`。 */
  readonly requiredFacts: readonly string[];
  readonly provenance: RuleProvenance;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/** ルールの草案（保存前・テスト用）。`JournalRule` から id / 時刻 / scope を除き、provenance を任意にした形。 */
export interface JournalRuleDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly mode: RuleMode;
  readonly priority: number;
  readonly scope: RuleScope;
  readonly conditions: readonly RuleCondition[];
  readonly outcome: RuleOutcome;
  readonly askIf: readonly AskIf[];
  readonly requiredFacts: readonly string[];
  readonly provenance?: RuleProvenance;
}

export interface CreateJournalRuleProps extends JournalRuleDraft {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const RULE_NAME_MAX_LENGTH = 120;
export const RULE_MAX_CONDITIONS = 50;

/** descriptionTemplate に書ける置換子（`extra.<key>` は任意のキー）。 */
export const TEMPLATE_PLACEHOLDERS = ['issuerName', 'recipientName', 'description', 'descriptionNorm', 'counterpartyHint', 'transactionDate', 'issueDate', 'grandTotal', 'accountHint', 'registrationNumber'] as const;

const fail: ErrorFactory = (message) => new JournalDomainError(message);

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

/** 条件を検証して複製する（ルール本体と askIf の両方が使う）。 */
export function validateRuleCondition(value: RuleCondition, label: string): RuleCondition {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertNonEmpty(value.field, `${label}.field`, fail);
  if (!CONDITION_OPS.includes(value.op)) throw fail(`${label}.op must be one of ${CONDITION_OPS.join(', ')}`);
  const field = value.field.trim();
  const needsValue = !['exists', 'notExists', 'isTrue', 'isFalse'].includes(value.op);
  if (needsValue && value.value === undefined) throw fail(`${label}.value is required for op '${value.op}'`);
  if (value.value !== undefined && !isJsonValue(value.value)) throw fail(`${label}.value must be a JSON value`);
  if (value.op === 'regex') {
    if (typeof value.value !== 'string') throw fail(`${label}.value must be a regular expression string for op 'regex'`);
    try { new RegExp(value.value, 'iu'); } catch { throw fail(`${label}.value is not a valid regular expression: ${value.value}`); }
  }
  if (value.op === 'between') {
    if (!Array.isArray(value.value) || value.value.length !== 2 || !value.value.every((entry) => typeof entry === 'number' || typeof entry === 'string')) {
      throw fail(`${label}.value must be a [low, high] pair for op 'between'`);
    }
  }
  if (value.op === 'in' && !Array.isArray(value.value)) throw fail(`${label}.value must be an array for op 'in'`);
  if ((value.op === 'contains' || value.op === 'startsWith' || value.op === 'endsWith') && typeof value.value !== 'string') throw fail(`${label}.value must be a string for op '${value.op}'`);
  if ((value.op === 'gte' || value.op === 'lte') && typeof value.value !== 'number' && typeof value.value !== 'string') throw fail(`${label}.value must be a number or string for op '${value.op}'`);
  return { field, op: value.op, ...(value.value === undefined ? {} : { value: structuredClone(value.value) }) };
}

function validateAmountSpec(value: AmountSpec, label: string): AmountSpec {
  if (typeof value === 'string') {
    if (!AMOUNT_SPEC_KEYWORDS.includes(value)) throw fail(`${label} must be one of ${AMOUNT_SPEC_KEYWORDS.join(', ')} or { fixed } / { ratio }`);
    return value;
  }
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an amount spec`);
  if ('fixed' in value) {
    if (!Number.isInteger(value.fixed) || value.fixed < 0) throw fail(`${label}.fixed must be a non-negative integer`);
    return { fixed: value.fixed };
  }
  if ('ratio' in value) {
    if (typeof value.ratio !== 'number' || !Number.isFinite(value.ratio) || value.ratio < 0 || value.ratio > 1) throw fail(`${label}.ratio must be a number between 0 and 1`);
    return { ratio: value.ratio };
  }
  throw fail(`${label} must be an amount spec`);
}

function validateOutcomeLine(value: OutcomeLine, index: number): OutcomeLine {
  const label = `createJournalRule: outcome.lines[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  if (!ENTRY_SIDES.includes(value.side)) throw fail(`${label}.side must be debit or credit`);
  assertNonEmpty(value.accountId, `${label}.accountId`, fail);
  assertNonEmpty(value.taxCode, `${label}.taxCode`, fail);
  let dimensionValues: OutcomeLine['dimensionValues'];
  if (value.dimensionValues !== undefined) {
    if (value.dimensionValues === null || typeof value.dimensionValues !== 'object' || Array.isArray(value.dimensionValues) || Object.values(value.dimensionValues).some((entry) => typeof entry !== 'string')) {
      throw fail(`${label}.dimensionValues must be an object of strings`);
    }
    dimensionValues = { ...value.dimensionValues };
  }
  let partnerFrom: PartnerFrom | undefined;
  if (value.partnerFrom !== undefined) {
    if (value.partnerFrom === 'issuerName' || value.partnerFrom === 'counterpartyHint') partnerFrom = value.partnerFrom;
    else if (value.partnerFrom !== null && typeof value.partnerFrom === 'object' && typeof value.partnerFrom.fixed === 'string') partnerFrom = { fixed: value.partnerFrom.fixed };
    else throw fail(`${label}.partnerFrom must be issuerName, counterpartyHint or { fixed }`);
  }
  return {
    side: value.side,
    accountId: value.accountId.trim(),
    ...(dimensionValues === undefined ? {} : { dimensionValues }),
    taxCode: value.taxCode.trim(),
    amount: validateAmountSpec(value.amount, `${label}.amount`),
    ...(partnerFrom === undefined ? {} : { partnerFrom }),
  };
}

function validateTemplate(template: string | undefined): string | undefined {
  if (template === undefined) return undefined;
  if (typeof template !== 'string') throw fail('createJournalRule: outcome.descriptionTemplate must be a string');
  for (const match of template.matchAll(/\{([^{}]*)\}/gu)) {
    const placeholder = match[1]!.trim();
    if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(placeholder)) continue;
    if (/^extra\.[^.\s]+$/u.test(placeholder)) continue;
    throw fail(`createJournalRule: outcome.descriptionTemplate has an unknown placeholder: {${placeholder}}`);
  }
  return template;
}

function validateRuleScope(value: RuleScope): RuleScope {
  const label = 'createJournalRule: scope';
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  if (value.documentKinds !== undefined) {
    if (!Array.isArray(value.documentKinds)) throw fail(`${label}.documentKinds must be an array`);
    for (const kind of value.documentKinds) if (!DOCUMENT_KINDS.includes(kind)) throw fail(`${label}.documentKinds contains an unknown kind: ${String(kind)}`);
  }
  if (value.direction !== undefined && !DIRECTIONS.includes(value.direction)) throw fail(`${label}.direction must be in or out`);
  if (value.accountHints !== undefined && (!Array.isArray(value.accountHints) || value.accountHints.some((hint) => typeof hint !== 'string'))) throw fail(`${label}.accountHints must be an array of strings`);
  return {
    ...(value.documentKinds === undefined ? {} : { documentKinds: [...value.documentKinds] }),
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...(value.accountHints === undefined ? {} : { accountHints: value.accountHints.map((hint) => hint.trim()).filter((hint) => hint.length > 0) }),
  };
}

function validateProvenance(value: RuleProvenance | undefined): RuleProvenance {
  if (value === undefined) return { origin: 'manual', exampleDocumentIds: [] };
  if (value === null || typeof value !== 'object') throw fail('createJournalRule: provenance must be an object');
  if (!RULE_ORIGINS.includes(value.origin)) throw fail(`createJournalRule: provenance.origin must be one of ${RULE_ORIGINS.join(', ')}`);
  if (value.hearingId !== undefined && typeof value.hearingId !== 'string') throw fail('createJournalRule: provenance.hearingId must be a string');
  const ids = value.exampleDocumentIds ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw fail('createJournalRule: provenance.exampleDocumentIds must be an array of strings');
  return { origin: value.origin, ...(value.hearingId === undefined ? {} : { hearingId: value.hearingId }), exampleDocumentIds: [...ids] };
}

/** ルールを組み立てて不変条件を検証する。`id` が無いときは `makeId` で生成する。 */
export function createJournalRule(props: CreateJournalRuleProps, makeId?: () => string): JournalRule {
  if (props === null || typeof props !== 'object') throw fail('createJournalRule: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('createJournalRule: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'createJournalRule: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'createJournalRule: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createJournalRule: id', fail);
  assertNonEmpty(props.name, 'createJournalRule: name', fail);
  const name = props.name.trim();
  if (name.length > RULE_NAME_MAX_LENGTH) throw fail(`createJournalRule: name must be at most ${RULE_NAME_MAX_LENGTH} characters`);
  if (typeof props.enabled !== 'boolean') throw fail('createJournalRule: enabled must be a boolean');
  if (!RULE_MODES.includes(props.mode)) throw fail('createJournalRule: mode must be auto or suggest');
  if (!Number.isInteger(props.priority)) throw fail('createJournalRule: priority must be an integer');
  if (!Array.isArray(props.conditions)) throw fail('createJournalRule: conditions must be an array');
  if (props.conditions.length > RULE_MAX_CONDITIONS) throw fail(`createJournalRule: conditions must have at most ${RULE_MAX_CONDITIONS} entries`);
  if (props.outcome === null || typeof props.outcome !== 'object') throw fail('createJournalRule: outcome must be an object');
  if (!Array.isArray(props.outcome.lines) || props.outcome.lines.length === 0) throw fail('createJournalRule: outcome.lines must have at least one line');
  if (props.outcome.invoiceStatus !== undefined && props.outcome.invoiceStatus !== 'auto' && !INVOICE_STATUSES.includes(props.outcome.invoiceStatus)) {
    throw fail(`createJournalRule: outcome.invoiceStatus must be auto or one of ${INVOICE_STATUSES.join(', ')}`);
  }
  if (!Array.isArray(props.askIf)) throw fail('createJournalRule: askIf must be an array');
  if (!Array.isArray(props.requiredFacts) || props.requiredFacts.some((path) => typeof path !== 'string' || path.trim().length === 0)) throw fail('createJournalRule: requiredFacts must be an array of non-empty strings');
  assertIsoDateTime(props.createdAt, 'createJournalRule: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createJournalRule: updatedAt', fail);

  const template = validateTemplate(props.outcome.descriptionTemplate);
  const askIf = props.askIf.map((entry, index) => {
    const label = `createJournalRule: askIf[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${label} must be an object`);
    assertNonEmpty(entry.questionId, `${label}.questionId`, fail);
    assertNonEmpty(entry.prompt, `${label}.prompt`, fail);
    if (!Array.isArray(entry.conditions)) throw fail(`${label}.conditions must be an array`);
    return { conditions: entry.conditions.map((condition: RuleCondition, conditionIndex: number) => validateRuleCondition(condition, `${label}.conditions[${conditionIndex}]`)), questionId: entry.questionId.trim(), prompt: entry.prompt.trim() };
  });

  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    name,
    enabled: props.enabled,
    mode: props.mode,
    priority: props.priority,
    scope: validateRuleScope(props.scope ?? {}),
    conditions: props.conditions.map((condition, index) => validateRuleCondition(condition, `createJournalRule: conditions[${index}]`)),
    outcome: {
      lines: props.outcome.lines.map(validateOutcomeLine),
      ...(template === undefined ? {} : { descriptionTemplate: template }),
      ...(props.outcome.invoiceStatus === undefined ? {} : { invoiceStatus: props.outcome.invoiceStatus }),
    },
    askIf,
    requiredFacts: props.requiredFacts.map((path) => path.trim()),
    provenance: validateProvenance(props.provenance),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 条件 1 つの特異度（docs/20 §2.3: equals 2 / startsWith・endsWith 1.5 / contains・regex 1 / その他 0）に条件数 1 を足した値。 */
function conditionPoints(condition: RuleCondition): number {
  switch (condition.op) {
    case 'equals': return 2;
    case 'startsWith':
    case 'endsWith': return 1.5;
    case 'contains':
    case 'regex': return 1;
    default: return 0;
  }
}

/** 特異度: 条件数 + 演算子ごとの点 + scope 指定ごとに 1 点。競合解決は priority → 特異度 → createdAt。 */
export function ruleSpecificity(rule: Pick<JournalRule, 'conditions' | 'scope'>): number {
  let score = rule.conditions.length;
  for (const condition of rule.conditions) score += conditionPoints(condition);
  if (rule.scope.documentKinds !== undefined && rule.scope.documentKinds.length > 0) score += 1;
  if (rule.scope.direction !== undefined) score += 1;
  if (rule.scope.accountHints !== undefined && rule.scope.accountHints.length > 0) score += 1;
  return score;
}

/** 競合解決の並び（priority 降順 → 特異度 降順 → createdAt 昇順 → id 昇順で安定）。 */
export function compareRulePrecedence(left: JournalRule, right: JournalRule): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  const leftSpecificity = ruleSpecificity(left);
  const rightSpecificity = ruleSpecificity(right);
  if (leftSpecificity !== rightSpecificity) return rightSpecificity - leftSpecificity;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

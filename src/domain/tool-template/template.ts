/**
 * ドメイン: ツールテンプレートの外部ファイル形式（v43 実装契約 §2 / ADR-0049）。
 *
 * Tool を 1 から組む代わりに「テンプレートを選び、スロットを埋める」経路の**正本の型**と、
 * ファイル 1 つを読み込むときの検査（`parseToolTemplate`）を持つ。テンプレートはコードではなく
 * 外部 JSON なので、壊れたファイルは**読み飛ばして理由と直し方を出す**のが仕事の半分である。
 * したがってこの file の問題文は例外なく「何が悪いか」と「どう直すか」を 1 文に含める
 * （このリポジトリの UX 規律: 診断は直し方と修正箇所への導線を最優先する）。
 *
 * 層の規律: domain は application / adapters を参照できないので、ノード種別が登録済みかの検査は
 * ここでは行わない（application の `checkTemplateAgainstRegistry` が registry を見る）。
 * ここで行うのは registry を要しない検査すべて（§2.4）である。
 */
import { z } from 'zod';
import type { PeriodGranularity } from '../etl/nodes/parse-period';
import type { Flavor } from '../shared/brand';

/** 対応するファイル形式の版。互換性のない変更を入れるときに上げる。 */
export const TOOL_TEMPLATE_FORMAT_VERSION = 1;

/** テンプレートの実体化・検証が失敗したときの例外（呼び出し側が理由をそのまま人へ見せる）。 */
export class ToolTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTemplateError';
  }
}

// ── 語彙（JSON Schema・UI・テストが同じ 1 本を共有する） ──────────────────────────────

/** スロットの種類。 */
export const TOOL_TEMPLATE_SLOT_KINDS = ['dataSource', 'column', 'joinKeys', 'choice', 'number', 'text', 'intent'] as const;
export type TemplateSlotKind = (typeof TOOL_TEMPLATE_SLOT_KINDS)[number];

/** `column` スロットが絞る列の役割。 */
export const TEMPLATE_COLUMN_ROLES = ['period', 'category', 'value', 'text', 'any'] as const;
export type TemplateColumnRole = (typeof TEMPLATE_COLUMN_ROLES)[number];

/**
 * `config` の中に書ける置換ディレクティブ（オブジェクト 1 つにつき 1 つだけ）。
 *
 * `$sourceType` は契約 §2.2 の表に無かったものをここで足した拡張で、データソースを読むノードの
 * `type` を「そのデータソースの形式（csv / json）」から決める（テンプレートを csv 専用にしない）。
 */
export const TOOL_TEMPLATE_DIRECTIVES = ['$slot', '$each', '$intent', '$profile', '$argument', '$number', '$concat', '$sourceType'] as const;
export type TemplateDirectiveKey = (typeof TOOL_TEMPLATE_DIRECTIVES)[number];

/** `$profile` で使える関数名。 */
export const TEMPLATE_PROFILE_FUNCTIONS = ['periodMin', 'periodMax', 'firstValues', 'firstValuesCsv'] as const;
export type TemplateProfileFunction = (typeof TEMPLATE_PROFILE_FUNCTIONS)[number];

/** 引数の型（`agent-input` の列型のうちツール引数に使える 4 つ）。 */
export const TEMPLATE_ARGUMENT_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type TemplateArgumentType = (typeof TEMPLATE_ARGUMENT_TYPES)[number];

/** 実体化が置く `agent-input` ノードの id。テンプレートはこの id を使えない。 */
export const TEMPLATE_ARGUMENTS_NODE_ID = 'args';

/** `parse-period` が足す列名（テンプレートは素の文字列で書く）。 */
export const TEMPLATE_PERIOD_START_COLUMN = 'periodStart';
export const TEMPLATE_PERIOD_GRANULARITY_COLUMN = 'periodGranularity';

/** id・スロット名・引数名の形。 */
export const TOOL_TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
export const TEMPLATE_SLOT_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
export const TEMPLATE_ARGUMENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** ツールテンプレートの id（v43 §2）。素の string から代入可能な弱ブランド（ADR-0034）。 */
export type ToolTemplateId = Flavor<string, 'ToolTemplateId'>;

// ── 型 ───────────────────────────────────────────────────────────────────────────

/** 日本語 / 英語の 1 行。 */
export interface LocalizedText {
  readonly ja: string;
  readonly en: string;
}

/** 日本語 / 英語の箇条書き。 */
export interface LocalizedList {
  readonly ja: readonly string[];
  readonly en: readonly string[];
}

/** ノード・引数・エッジに付ける条件。 */
export type TemplateWhen =
  | string
  | { readonly slot: string; readonly equals: string }
  | { readonly slot: string; readonly notEquals: string }
  | { readonly not: TemplateWhen };

interface TemplateSlotBase {
  readonly name: string;
  readonly label: LocalizedText;
  readonly help?: LocalizedText;
  /** true なら埋めなくてよい（埋まらなければ `when` が偽になる）。 */
  readonly optional?: boolean;
}

export interface TemplateDataSourceSlot extends TemplateSlotBase {
  readonly kind: 'dataSource';
}

export interface TemplateColumnSlot extends TemplateSlotBase {
  readonly kind: 'column';
  /** どの `dataSource` スロットの列か。 */
  readonly source: string;
  readonly role: TemplateColumnRole;
  /** 列の型でも絞る（`DataType` の文字列）。 */
  readonly types?: readonly string[];
  /** 複数選ぶ列（配列値になる）。 */
  readonly multiple?: { readonly min: number; readonly max: number };
  /** 同じ列を選んではいけない他の `column` スロット。 */
  readonly distinctFrom?: readonly string[];
}

export interface TemplateJoinKeysSlot extends TemplateSlotBase {
  readonly kind: 'joinKeys';
  readonly left: string;
  readonly right: string;
  readonly multiple: { readonly min: number; readonly max: number };
}

export interface TemplateChoiceOption {
  readonly value: string;
  readonly label: LocalizedText;
}

export interface TemplateChoiceSlot extends TemplateSlotBase {
  readonly kind: 'choice';
  readonly options?: readonly TemplateChoiceOption[];
  /** `granularities:<periodColumnSlot>` だけを受ける（データに在る粒度を選択肢にする）。 */
  readonly optionsFrom?: string;
  readonly default?: string;
}

export interface TemplateNumberSlot extends TemplateSlotBase {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
  readonly default: number;
}

export interface TemplateTextSlot extends TemplateSlotBase {
  readonly kind: 'text';
  readonly maxLength: number;
  readonly pattern?: string;
  readonly default: string;
}

export interface TemplateIntentSlot extends TemplateSlotBase {
  readonly kind: 'intent';
  readonly maxLength: number;
}

export type ToolTemplateSlot =
  | TemplateDataSourceSlot
  | TemplateColumnSlot
  | TemplateJoinKeysSlot
  | TemplateChoiceSlot
  | TemplateNumberSlot
  | TemplateTextSlot
  | TemplateIntentSlot;

export interface ToolTemplateArgument {
  readonly name: string;
  readonly type: TemplateArgumentType;
  /** 既定の必須 / 任意（作成画面で切り替えられる。`lock` があれば切り替えられない）。 */
  readonly nullable: boolean;
  /**
   * 作成画面で必須 / 任意を切り替えさせない理由（v46 §B）。書いてある引数は `nullable` に固定され、
   * 画面は切り替えの代わりにこの文を出す。任意の引数は省略されると束縛された条件ごと外れる
   * （`graphWithArguments`）ので、外れると結果の意味が変わる引数（粒度など）に書く。
   */
  readonly lock?: LocalizedText;
  readonly when?: TemplateWhen;
  readonly description: LocalizedText;
  /** 設計時サンプル（リテラル / `{"$slot":…}` / `{"$profile":…}`）。 */
  readonly sample: unknown;
}

export interface ToolTemplateNode {
  readonly id: string;
  /** 登録済みノード種別、または `{"$sourceType": "<dataSource スロット>"}`。 */
  readonly type: string | { readonly $sourceType: string };
  readonly config: unknown;
  readonly when?: TemplateWhen;
}

export interface ToolTemplateEdge {
  readonly from: string;
  readonly to: string;
  readonly toInput?: number;
  readonly when?: TemplateWhen;
}

export interface ToolTemplate {
  readonly formatVersion: 1;
  readonly id: ToolTemplateId;
  readonly version: string;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly whenToUse: LocalizedList;
  readonly notFor?: LocalizedList;
  readonly tags: readonly string[];
  readonly sources: { readonly min: number; readonly max: number };
  readonly slots: readonly ToolTemplateSlot[];
  readonly arguments: readonly ToolTemplateArgument[];
  readonly nodes: readonly ToolTemplateNode[];
  readonly edges: readonly ToolTemplateEdge[];
  readonly description: LocalizedText;
  /** 作者向けのメモ（実行時は無視する）。 */
  readonly notes?: string;
  /** 実装担当への申し送り（解決したら削除して `notes` へ要点を残す）。 */
  readonly implementationNotes?: string;
}

/** 読み込み結果。失敗しても例外にせず、直し方つきの問題文を並べて返す。 */
export type ParsedToolTemplate =
  | { readonly ok: true; readonly template: ToolTemplate }
  | { readonly ok: false; readonly problems: readonly string[] };

// ── zod スキーマ ──────────────────────────────────────────────────────────────────

const localizedText = z.object({ ja: z.string().min(1), en: z.string().min(1) }).strict();
const localizedList = z.object({ ja: z.array(z.string().min(1)), en: z.array(z.string().min(1)) }).strict();

const whenSchema: z.ZodType<TemplateWhen> = z.lazy(() => z.union([
  z.string().min(1),
  z.object({ slot: z.string().min(1), equals: z.string() }).strict(),
  z.object({ slot: z.string().min(1), notEquals: z.string() }).strict(),
  z.object({ not: whenSchema }).strict(),
]));

const multipleSchema = z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).strict();

const slotBase = {
  name: z.string(),
  label: localizedText,
  help: localizedText.optional(),
  optional: z.boolean().optional(),
};

const slotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dataSource'), ...slotBase }).strict(),
  z.object({
    kind: z.literal('column'),
    ...slotBase,
    source: z.string().min(1),
    role: z.enum(TEMPLATE_COLUMN_ROLES),
    types: z.array(z.string().min(1)).min(1).optional(),
    multiple: multipleSchema.optional(),
    distinctFrom: z.array(z.string().min(1)).min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('joinKeys'),
    ...slotBase,
    left: z.string().min(1),
    right: z.string().min(1),
    multiple: multipleSchema,
  }).strict(),
  z.object({
    kind: z.literal('choice'),
    ...slotBase,
    options: z.array(z.object({ value: z.string().min(1), label: localizedText }).strict()).min(1).optional(),
    optionsFrom: z.string().min(1).optional(),
    default: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('number'),
    ...slotBase,
    min: z.number(),
    max: z.number(),
    integer: z.boolean().optional(),
    default: z.number(),
  }).strict(),
  z.object({
    kind: z.literal('text'),
    ...slotBase,
    maxLength: z.number().int().min(1).max(4000),
    pattern: z.string().min(1).optional(),
    default: z.string(),
  }).strict(),
  z.object({ kind: z.literal('intent'), ...slotBase, maxLength: z.number().int().min(1).max(4000) }).strict(),
]);

const argumentSchema = z.object({
  name: z.string(),
  type: z.enum(TEMPLATE_ARGUMENT_TYPES),
  nullable: z.boolean(),
  lock: localizedText.optional(),
  when: whenSchema.optional(),
  description: localizedText,
  sample: z.unknown(),
}).strict();

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.union([z.string().min(1), z.object({ $sourceType: z.string().min(1) }).strict()]),
  config: z.unknown(),
  when: whenSchema.optional(),
}).strict();

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  toInput: z.number().int().min(0).max(1).optional(),
  when: whenSchema.optional(),
}).strict();

const templateSchema = z.object({
  $schema: z.string().optional(),
  formatVersion: z.literal(TOOL_TEMPLATE_FORMAT_VERSION),
  id: z.string(),
  version: z.string().min(1),
  title: localizedText,
  summary: localizedText,
  whenToUse: localizedList,
  notFor: localizedList.optional(),
  tags: z.array(z.string().min(1)).default([]),
  sources: z.object({ min: z.number().int().min(1).max(5), max: z.number().int().min(1).max(5) }).strict(),
  slots: z.array(slotSchema),
  arguments: z.array(argumentSchema).default([]),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  description: localizedText,
  notes: z.string().optional(),
  implementationNotes: z.string().optional(),
}).strict();

// ── 置換の走査（参照の実在検査と実体化が同じ規則を共有する） ────────────────────────────

/** 置換ディレクティブ 1 つ。 */
export interface TemplateDirective {
  readonly key: TemplateDirectiveKey;
  readonly value: Record<string, unknown>;
}

const DIRECTIVE_KEYS = new Set<string>(TOOL_TEMPLATE_DIRECTIVES);

/**
 * 値が置換ディレクティブなら、そのキーを返す。ディレクティブのキーを 2 つ持つオブジェクトは
 * 「どちらの意味か決まらない」ので `'ambiguous'` を返し、呼び出し側が問題として報告する。
 */
export function directiveKeyOf(value: unknown): TemplateDirectiveKey | 'ambiguous' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>).filter((key) => DIRECTIVE_KEYS.has(key));
  if (keys.length === 0) return undefined;
  if (keys.length > 1) return 'ambiguous';
  return keys[0] as TemplateDirectiveKey;
}

/** 文字列の中の `{{name}}` をすべて拾う。 */
export function interpolationNamesOf(text: string): string[] {
  const names: string[] = [];
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
  let matched = pattern.exec(text);
  while (matched !== null) {
    names.push(matched[1]!);
    matched = pattern.exec(text);
  }
  return names;
}

/** `$profile` の引数文字列（`firstValues:categoryColumn:2`）の分解結果。 */
export interface ParsedProfileExpression {
  readonly fn: TemplateProfileFunction;
  readonly slot: string;
  readonly count?: number;
}

/** `$profile` の引数文字列を読む。形が違えば undefined（呼び出し側が直し方つきで報告する）。 */
export function parseProfileExpression(text: string): ParsedProfileExpression | undefined {
  const parts = text.split(':');
  const fn = parts[0];
  const slot = parts[1];
  if (fn === undefined || slot === undefined || slot === '') return undefined;
  if (!(TEMPLATE_PROFILE_FUNCTIONS as readonly string[]).includes(fn)) return undefined;
  if (fn === 'periodMin' || fn === 'periodMax') {
    return parts.length === 2 ? { fn, slot } : undefined;
  }
  if (parts.length !== 3) return undefined;
  const count = Number(parts[2]);
  if (!Number.isInteger(count) || count < 1 || count > 100) return undefined;
  return { fn: fn as TemplateProfileFunction, slot, count };
}

/** 走査が見つけた参照 1 件（実在検査・実体化の両方が使う）。 */
export interface TemplateReference {
  /** 参照の種類。 */
  readonly kind: 'slot' | 'argument' | 'profile' | 'intent' | 'sourceType' | 'malformed';
  /** 参照している名前（`malformed` では原文）。 */
  readonly name: string;
  /** どこに書いてあるか（`nodes[2].config.column` のような道筋）。問題文にそのまま載せる。 */
  readonly path: string;
  /** `$each` の中など、ループ変数が使える文脈か（`$slot` がループ変数を指しうる）。 */
  readonly scope: ReadonlySet<string>;
  /** `{{ }}` / `$slot` / `$number` のように、スロットの**値そのもの**を要求する参照か。 */
  readonly requiresValue: boolean;
}

/**
 * `config`（や `sample`・説明文）の中の参照をすべて拾う。
 * 実体化と読み込み時検査が同じ walker を使うので、「検査は通るのに実体化で落ちる」が起きない。
 */
export function collectReferences(value: unknown, path: string, scope: ReadonlySet<string> = new Set()): TemplateReference[] {
  const found: TemplateReference[] = [];
  const visit = (node: unknown, at: string, inScope: ReadonlySet<string>): void => {
    if (typeof node === 'string') {
      for (const name of interpolationNamesOf(node)) {
        found.push({ kind: 'slot', name, path: at, scope: inScope, requiresValue: true });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}[${index}]`, inScope));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const directive = directiveKeyOf(node);
    if (directive === 'ambiguous') {
      found.push({ kind: 'malformed', name: Object.keys(record).filter((key) => DIRECTIVE_KEYS.has(key)).join(' + '), path: at, scope: inScope, requiresValue: false });
      return;
    }
    switch (directive) {
      case '$slot':
      case '$number': {
        const name = record[directive];
        if (typeof name !== 'string') {
          found.push({ kind: 'malformed', name: `${directive} takes a slot name`, path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'slot', name, path: at, scope: inScope, requiresValue: true });
        return;
      }
      case '$argument': {
        const name = record['$argument'];
        if (typeof name !== 'string') {
          found.push({ kind: 'malformed', name: '$argument takes an argument name', path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'argument', name, path: at, scope: inScope, requiresValue: false });
        return;
      }
      case '$intent': {
        const name = record['$intent'];
        if (typeof name !== 'string') {
          found.push({ kind: 'malformed', name: '$intent takes a slot name', path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'intent', name, path: at, scope: inScope, requiresValue: false });
        return;
      }
      case '$sourceType': {
        const name = record['$sourceType'];
        if (typeof name !== 'string') {
          found.push({ kind: 'malformed', name: '$sourceType takes a dataSource slot name', path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'sourceType', name, path: at, scope: inScope, requiresValue: false });
        return;
      }
      case '$profile': {
        const text = record['$profile'];
        if (typeof text !== 'string') {
          found.push({ kind: 'malformed', name: '$profile takes a string like "periodMin:<slot>"', path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'profile', name: text, path: at, scope: inScope, requiresValue: false });
        return;
      }
      case '$concat': {
        const parts = record['$concat'];
        if (!Array.isArray(parts)) {
          found.push({ kind: 'malformed', name: '$concat takes an array of expressions', path: at, scope: inScope, requiresValue: false });
          return;
        }
        parts.forEach((part, index) => visit(part, `${at}.$concat[${index}]`, inScope));
        return;
      }
      case '$each': {
        const name = record['$each'];
        const as = record['as'];
        if (typeof name !== 'string' || typeof as !== 'string' || as === '' || !('item' in record)) {
          found.push({ kind: 'malformed', name: '$each takes { "$each": "<slot>", "as": "<name>", "item": <json> }', path: at, scope: inScope, requiresValue: false });
          return;
        }
        found.push({ kind: 'slot', name, path: at, scope: inScope, requiresValue: false });
        visit(record['item'], `${at}.item`, new Set([...inScope, as]));
        return;
      }
      default:
        break;
    }
    for (const [key, item] of Object.entries(record)) visit(item, `${at}.${key}`, inScope);
  };
  visit(value, path, scope);
  return found;
}

/** `when` が参照するスロット名をすべて拾う。 */
export function whenSlotNames(when: TemplateWhen | undefined): string[] {
  if (when === undefined) return [];
  if (typeof when === 'string') return [when];
  if ('not' in when) return whenSlotNames(when.not);
  return [when.slot];
}

// ── 読み込み時の検査（§2.4） ──────────────────────────────────────────────────────

/** zod の失敗を「どの項目が・どうあるべきか」の 1 行へ落とす。 */
function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `${path}: ${issue.message}; fix that field and read templates/tools/tool-template.schema.json for the shape it must have`;
  });
}

/** ノード種別の文字列（`$sourceType` なら undefined）。 */
export function nodeTypeNameOf(node: ToolTemplateNode): string | undefined {
  return typeof node.type === 'string' ? node.type : undefined;
}

interface CheckState {
  readonly template: ToolTemplate;
  readonly problems: string[];
  readonly slots: ReadonlyMap<string, ToolTemplateSlot>;
  readonly argumentNames: ReadonlySet<string>;
}

function checkNames(state: CheckState): void {
  const { template, problems } = state;
  if (!TOOL_TEMPLATE_ID_PATTERN.test(template.id)) {
    problems.push(`id '${template.id}' does not match ${TOOL_TEMPLATE_ID_PATTERN.source}; rename it to lowercase letters, digits and hyphens (for example "period-series")`);
  }
  const seenSlots = new Set<string>();
  for (const slot of template.slots) {
    if (!TEMPLATE_SLOT_NAME_PATTERN.test(slot.name)) {
      problems.push(`slot name '${slot.name}' does not match ${TEMPLATE_SLOT_NAME_PATTERN.source}; rename it to lowerCamelCase (for example "periodColumn")`);
    }
    if (seenSlots.has(slot.name)) {
      problems.push(`slot '${slot.name}' is declared twice; give each slot a unique name or delete the duplicate`);
    }
    seenSlots.add(slot.name);
  }
  const seenArguments = new Set<string>();
  for (const argument of template.arguments) {
    if (!TEMPLATE_ARGUMENT_NAME_PATTERN.test(argument.name)) {
      problems.push(`argument name '${argument.name}' does not match ${TEMPLATE_ARGUMENT_NAME_PATTERN.source}; rename it to snake_case (for example "period_from")`);
    }
    if (seenArguments.has(argument.name)) {
      problems.push(`argument '${argument.name}' is declared twice; give each argument a unique name or delete the duplicate`);
    }
    seenArguments.add(argument.name);
  }
  const seenNodes = new Set<string>();
  for (const node of template.nodes) {
    if (seenNodes.has(node.id)) {
      problems.push(`node id '${node.id}' is used twice; give each node a unique id or delete the duplicate`);
    }
    seenNodes.add(node.id);
    if (node.id === TEMPLATE_ARGUMENTS_NODE_ID) {
      problems.push(`node id '${TEMPLATE_ARGUMENTS_NODE_ID}' is reserved for the generated agent-input node; rename this node (for example "arguments_input")`);
    }
    if (nodeTypeNameOf(node) === 'agent-input') {
      problems.push(`node '${node.id}' has type 'agent-input'; delete it and declare the tool arguments under "arguments" — the agent-input node is generated from them`);
    }
  }
}

function checkSources(state: CheckState): void {
  const { template, problems } = state;
  if (template.sources.min > template.sources.max) {
    problems.push(`sources.min (${template.sources.min}) is greater than sources.max (${template.sources.max}); set min to the smallest number of data sources this template reads and max to the largest`);
  }
  const dataSourceSlots = template.slots.filter((slot) => slot.kind === 'dataSource');
  if (dataSourceSlots.length !== template.sources.max) {
    problems.push(`this template declares ${dataSourceSlots.length} 'dataSource' slot(s) but sources.max is ${template.sources.max}; put exactly one 'dataSource' slot per source (add the missing slot, or change sources.max to ${dataSourceSlots.length})`);
  }
  // データソースを読むノード = config に `dataSourceId` を持つノード。1 スロットにつきちょうど 1 つ。
  const readers = new Map<string, string[]>();
  let unresolved = 0;
  for (const node of template.nodes) {
    const config = node.config;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
    if (!('dataSourceId' in (config as Record<string, unknown>))) continue;
    const reference = (config as Record<string, unknown>)['dataSourceId'];
    const key = directiveKeyOf(reference) === '$slot' ? (reference as { $slot: string }).$slot : undefined;
    if (key === undefined) {
      unresolved += 1;
      problems.push(`node '${node.id}' sets config.dataSourceId to something other than a slot; write { "dataSourceId": { "$slot": "<a dataSource slot>" } } so the template works for any data source`);
      continue;
    }
    readers.set(key, [...(readers.get(key) ?? []), node.id]);
  }
  for (const slot of dataSourceSlots) {
    const nodes = readers.get(slot.name) ?? [];
    if (nodes.length === 0) {
      problems.push(`the 'dataSource' slot '${slot.name}' is never read; add a source node with config { "dataSourceId": { "$slot": "${slot.name}" } }, or delete the slot`);
    } else if (nodes.length > 1) {
      problems.push(`the 'dataSource' slot '${slot.name}' is read by ${nodes.length} nodes (${nodes.join(', ')}); keep exactly one source node per data source`);
    }
  }
  const total = [...readers.values()].reduce((sum, nodes) => sum + nodes.length, 0) + unresolved;
  if (total > template.sources.max) {
    problems.push(`this template has ${total} node(s) that read a data source but sources.max is ${template.sources.max}; remove the extra source nodes or raise sources.max`);
  }
}

function checkSlotCrossReferences(state: CheckState): void {
  const { template, problems, slots } = state;
  const dataSourceNames = new Set(template.slots.filter((slot) => slot.kind === 'dataSource').map((slot) => slot.name));
  const columnNames = new Set(template.slots.filter((slot) => slot.kind === 'column').map((slot) => slot.name));
  for (const slot of template.slots) {
    if (slot.kind === 'column') {
      if (!dataSourceNames.has(slot.source)) {
        problems.push(`slot '${slot.name}' reads columns of the source '${slot.source}', which is not a 'dataSource' slot; set "source" to one of ${[...dataSourceNames].join(', ') || 'the dataSource slots you declare'}`);
      }
      for (const other of slot.distinctFrom ?? []) {
        if (!columnNames.has(other)) {
          problems.push(`slot '${slot.name}' has distinctFrom '${other}', which is not a 'column' slot; point it at another column slot or remove it`);
        } else if (other === slot.name) {
          problems.push(`slot '${slot.name}' lists itself in distinctFrom; remove it (a slot is always allowed to equal itself)`);
        }
      }
      if (slot.multiple !== undefined && slot.multiple.min > slot.multiple.max) {
        problems.push(`slot '${slot.name}' has multiple.min (${slot.multiple.min}) greater than multiple.max (${slot.multiple.max}); swap them`);
      }
      continue;
    }
    if (slot.kind === 'joinKeys') {
      for (const [side, name] of [['left', slot.left], ['right', slot.right]] as const) {
        if (!dataSourceNames.has(name)) {
          problems.push(`slot '${slot.name}' has ${side} '${name}', which is not a 'dataSource' slot; set it to one of ${[...dataSourceNames].join(', ') || 'the dataSource slots you declare'}`);
        }
      }
      if (slot.left === slot.right) {
        problems.push(`slot '${slot.name}' joins '${slot.left}' with itself; point left and right at two different dataSource slots`);
      }
      continue;
    }
    if (slot.kind === 'choice') {
      const hasOptions = slot.options !== undefined;
      const hasOptionsFrom = slot.optionsFrom !== undefined;
      if (hasOptions === hasOptionsFrom) {
        problems.push(`slot '${slot.name}' must have either "options" or "optionsFrom", not ${hasOptions ? 'both' : 'neither'}; list the fixed options, or set "optionsFrom": "granularities:<a period column slot>"`);
      }
      if (slot.optionsFrom !== undefined) {
        const [fn, target] = slot.optionsFrom.split(':');
        if (fn !== 'granularities' || target === undefined || target === '') {
          problems.push(`slot '${slot.name}' has optionsFrom '${slot.optionsFrom}', which is not understood; the only supported form is "granularities:<a column slot whose role is period>"`);
        } else {
          const referenced = slots.get(target);
          if (referenced === undefined || referenced.kind !== 'column' || referenced.role !== 'period') {
            problems.push(`slot '${slot.name}' takes its options from '${target}', which is not a column slot with "role": "period"; point optionsFrom at the period column slot of this template`);
          }
        }
      }
      if (slot.default !== undefined && slot.options !== undefined && !slot.options.some((option) => option.value === slot.default)) {
        problems.push(`slot '${slot.name}' has default '${slot.default}', which is not one of its options (${slot.options.map((option) => option.value).join(', ')}); use one of them or drop the default`);
      }
      continue;
    }
    if (slot.kind === 'number') {
      if (slot.min > slot.max) {
        problems.push(`slot '${slot.name}' has min (${slot.min}) greater than max (${slot.max}); swap them`);
      }
      if (slot.default < slot.min || slot.default > slot.max) {
        problems.push(`slot '${slot.name}' has default ${slot.default}, which is outside ${slot.min}..${slot.max}; pick a default inside the range`);
      }
      continue;
    }
    if (slot.kind === 'text') {
      if (slot.default.length > slot.maxLength) {
        problems.push(`slot '${slot.name}' has a default longer than maxLength (${slot.maxLength}); shorten the default or raise maxLength`);
      }
      if (slot.pattern !== undefined) {
        try {
          new RegExp(slot.pattern);
        } catch {
          problems.push(`slot '${slot.name}' has pattern '${slot.pattern}', which is not a valid regular expression; fix the pattern or remove it`);
        }
      }
    }
  }
}

function checkEdges(state: CheckState): void {
  const { template, problems } = state;
  const ids = new Set(template.nodes.map((node) => node.id));
  for (const edge of template.edges) {
    for (const [side, id] of [['from', edge.from], ['to', edge.to]] as const) {
      if (!ids.has(id)) {
        problems.push(`edge '${edge.from}' -> '${edge.to}': node '${id}' does not exist; add a node with id "${id}" or fix the edge's "${side}"`);
      }
    }
  }
  // 循環（`when` に関係なく、書いてあるエッジだけで見る）。
  const outgoing = new Map<string, string[]>();
  for (const edge of template.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const state1 = new Map<string, 'visiting' | 'done'>();
  const cycles: string[] = [];
  const walk = (id: string, trail: readonly string[]): void => {
    const status = state1.get(id);
    if (status === 'done') return;
    if (status === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(id)), id].join(' -> '));
      return;
    }
    state1.set(id, 'visiting');
    for (const next of outgoing.get(id) ?? []) walk(next, [...trail, id]);
    state1.set(id, 'done');
  };
  for (const node of template.nodes) walk(node.id, []);
  for (const cycle of [...new Set(cycles)]) {
    problems.push(`the edges form a cycle (${cycle}); a tool graph must be acyclic — remove one of those edges`);
  }
}

function checkTerminal(state: CheckState): void {
  const { template, problems } = state;
  const sinks = template.nodes.filter((node) => nodeTypeNameOf(node) === 'agent-output');
  if (sinks.length !== 1) {
    problems.push(`this template has ${sinks.length} 'agent-output' node(s); write exactly one — it is what the tool returns to the agent`);
  }
  for (const sink of sinks) {
    if (sink.when !== undefined) {
      problems.push(`the 'agent-output' node '${sink.id}' has a "when"; the tool must always return something — remove the condition`);
    }
  }
}

function checkConditionalNodes(state: CheckState): void {
  const { template, problems } = state;
  for (const node of template.nodes) {
    if (node.when === undefined) continue;
    const incoming = template.edges.filter((edge) => edge.to === node.id).length;
    const outgoing = template.edges.filter((edge) => edge.from === node.id).length;
    if (incoming === 1 && outgoing === 1) continue;
    problems.push(`node '${node.id}' has a "when" but ${incoming} incoming and ${outgoing} outgoing edge(s); only a node with exactly one of each can be dropped and its neighbours bridged — put the condition on a single-input, single-output node, or build a separate template for that shape`);
  }
}

/** 参照 1 件を検査する（スロット・引数・`$profile`・`$intent`・`$sourceType` の実在と使い方）。 */
function checkReference(state: CheckState, reference: TemplateReference, owner: { readonly when?: TemplateWhen; readonly label: string }): void {
  const { problems, slots, argumentNames } = state;
  const known = [...slots.keys()].join(', ');
  switch (reference.kind) {
    case 'malformed':
      problems.push(`${reference.path} is not a valid substitution (${reference.name}); write one directive per object, chosen from ${TOOL_TEMPLATE_DIRECTIVES.join(', ')}`);
      return;
    case 'slot': {
      if (reference.scope.has(reference.name)) return; // `$each` のループ変数。
      const slot = slots.get(reference.name);
      if (slot === undefined) {
        problems.push(`${reference.path} refers to the slot '${reference.name}', which this template does not declare; add a slot named "${reference.name}" or use one of ${known}`);
        return;
      }
      if (reference.requiresValue && slot.optional === true && !whenSlotNames(owner.when).includes(reference.name)) {
        problems.push(`${reference.path} uses the value of the optional slot '${reference.name}', but ${owner.label} has no matching "when"; add "when": "${reference.name}" so it is dropped when the slot is left empty, or make the slot required`);
      }
      return;
    }
    case 'argument': {
      if (!argumentNames.has(reference.name)) {
        problems.push(`${reference.path} binds the argument '${reference.name}', which this template does not declare; add it to "arguments" or bind an argument that exists (${[...argumentNames].join(', ') || 'none declared'})`);
      }
      return;
    }
    case 'intent': {
      const slot = slots.get(reference.name);
      if (slot === undefined) {
        problems.push(`${reference.path} refers to the slot '${reference.name}', which this template does not declare; add an "intent" slot named "${reference.name}"`);
        return;
      }
      if (slot.kind !== 'intent') {
        problems.push(`${reference.path} uses $intent with the '${slot.kind}' slot '${reference.name}'; $intent only works with a slot of kind "intent" — change the slot's kind`);
      }
      return;
    }
    case 'sourceType': {
      const slot = slots.get(reference.name);
      if (slot === undefined || slot.kind !== 'dataSource') {
        problems.push(`${reference.path} uses $sourceType with '${reference.name}', which is not a 'dataSource' slot; point it at the dataSource slot the node reads`);
      }
      return;
    }
    default: {
      const parsed = parseProfileExpression(reference.name);
      if (parsed === undefined) {
        problems.push(`${reference.path} has $profile "${reference.name}", which is not understood; use "periodMin:<slot>", "periodMax:<slot>", "firstValues:<slot>:<n>" or "firstValuesCsv:<slot>:<n>" (n between 1 and 100)`);
        return;
      }
      const slot = slots.get(parsed.slot);
      if (slot === undefined) {
        problems.push(`${reference.path} takes a profile fact from the slot '${parsed.slot}', which this template does not declare; use one of ${known}`);
        return;
      }
      if (slot.kind !== 'column') {
        problems.push(`${reference.path} takes a profile fact from the '${slot.kind}' slot '${parsed.slot}'; $profile only reads column slots — point it at a column slot`);
      }
    }
  }
}

function checkSubstitutions(state: CheckState): void {
  const { template, problems, slots } = state;
  const usedArguments = new Set<string>();
  const intentNodes = new Map<string, string>();

  const record = (references: readonly TemplateReference[], owner: { readonly when?: TemplateWhen; readonly label: string }): void => {
    for (const reference of references) {
      if (reference.kind === 'argument') usedArguments.add(reference.name);
      checkReference(state, reference, owner);
    }
  };

  template.nodes.forEach((node, index) => {
    const label = `node '${node.id}'`;
    const owner = { ...(node.when === undefined ? {} : { when: node.when }), label };
    record(collectReferences(node.type, `nodes[${index}].type`), owner);
    record(collectReferences(node.config, `nodes[${index}].config`), owner);
    // `$intent` は calculate の `expression` にしか置けない（§2.4）。
    const intents = collectReferences(node.config, `nodes[${index}].config`).filter((reference) => reference.kind === 'intent');
    for (const intent of intents) {
      if (nodeTypeNameOf(node) !== 'calculate') {
        problems.push(`${intent.path} uses $intent on a '${String(nodeTypeNameOf(node) ?? 'computed')}' node; $intent only fills the "expression" of a 'calculate' node — move it there`);
        continue;
      }
      if (intent.path !== `nodes[${index}].config.expression`) {
        problems.push(`${intent.path} uses $intent outside the calculate node's "expression"; write { "expression": { "$intent": "${intent.name}" } } instead`);
        continue;
      }
      intentNodes.set(node.id, intent.name);
    }
    for (const name of whenSlotNames(node.when)) {
      if (slots.has(name)) continue;
      problems.push(`the "when" of node '${node.id}' refers to the slot '${name}', which this template does not declare; use one of ${[...slots.keys()].join(', ')}`);
    }
  });

  template.arguments.forEach((argument, index) => {
    const label = `argument '${argument.name}'`;
    const owner = { ...(argument.when === undefined ? {} : { when: argument.when }), label };
    record(collectReferences(argument.sample, `arguments[${index}].sample`), owner);
    record(collectReferences(argument.description, `arguments[${index}].description`), owner);
    for (const name of whenSlotNames(argument.when)) {
      if (slots.has(name)) continue;
      problems.push(`the "when" of argument '${argument.name}' refers to the slot '${name}', which this template does not declare; use one of ${[...slots.keys()].join(', ')}`);
    }
  });

  template.edges.forEach((edge, index) => {
    for (const name of whenSlotNames(edge.when)) {
      if (slots.has(name)) continue;
      problems.push(`the "when" of edges[${index}] ('${edge.from}' -> '${edge.to}') refers to the slot '${name}', which this template does not declare; use one of ${[...slots.keys()].join(', ')}`);
    }
  });

  record(collectReferences(template.description, 'description'), { label: 'the description' });

  for (const argument of template.arguments) {
    if (usedArguments.has(argument.name)) continue;
    problems.push(`argument '${argument.name}' is declared but never used; bind it with { "$argument": "${argument.name}" } in a filter condition's "valueBinding", or delete the argument`);
  }
  for (const slot of template.slots) {
    if (slot.kind !== 'intent') continue;
    if ([...intentNodes.values()].includes(slot.name)) continue;
    problems.push(`the 'intent' slot '${slot.name}' is never used; put { "$intent": "${slot.name}" } in a calculate node's "expression", or delete the slot`);
  }
}

/**
 * ファイル 1 つを読み込む（§2.4 のうち registry を要しない検査すべて）。
 *
 * 失敗しても例外にせず、**問題ごとに直し方を添えた文**を並べて返す。呼び出し側（カタログ）は
 * それをそのまま `invalid[]` へ載せ、Tool Builder と `GET /tool-templates` が人へ見せる。
 */
export function parseToolTemplate(json: unknown): ParsedToolTemplate {
  const parsed = templateSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, problems: zodProblems(parsed.error) };
  }
  const { $schema: _schema, ...rest } = parsed.data;
  const template = rest as unknown as ToolTemplate;
  const state: CheckState = {
    template,
    problems: [],
    slots: new Map(template.slots.map((slot) => [slot.name, slot] as const)),
    argumentNames: new Set(template.arguments.map((argument) => argument.name)),
  };
  checkNames(state);
  checkSources(state);
  checkSlotCrossReferences(state);
  checkEdges(state);
  checkTerminal(state);
  checkConditionalNodes(state);
  checkSubstitutions(state);
  return state.problems.length === 0 ? { ok: true, template } : { ok: false, problems: state.problems };
}

// ── 実体化の文脈（application が `DataProfile` から作る最小の材料） ───────────────────

/** 1 列の名前と型（`DataProfile.columns` の部分集合）。 */
export interface TemplateColumnContext {
  readonly name: string;
  readonly type: string;
}

/** 期間ラベル列 1 つ（存在する粒度と、解釈できた開始日の範囲）。 */
export interface TemplatePeriodColumnContext {
  readonly column: string;
  readonly granularities: readonly PeriodGranularity[];
  readonly minStart?: string;
  readonly maxStart?: string;
}

/** 値を列挙できる列 1 つ。 */
export interface TemplateCategoryColumnContext {
  readonly column: string;
  readonly values: readonly string[];
}

/** このテンプレートが読むデータソース 1 件ぶんの文脈。 */
export interface TemplateSourceContext {
  readonly dataSourceId: string;
  readonly name: string;
  /** ファイル形式。`$sourceType` が `csv-source` / `json-source` を選ぶのに使う。 */
  readonly format: 'csv' | 'json';
  readonly columns: readonly TemplateColumnContext[];
  readonly periodColumns: readonly TemplatePeriodColumnContext[];
  readonly categoricalColumns: readonly TemplateCategoryColumnContext[];
}

/** 2 ソース間の結合キー候補。 */
export interface TemplateJoinCandidateContext {
  readonly leftDataSourceId: string;
  readonly rightDataSourceId: string;
  readonly keys: readonly string[];
}

/**
 * 候補算出・検証・実体化が使う文脈。
 *
 * v42 の `ToolSpecContext` は**再利用しない**: あちらは (1) 期間列の実測範囲（`minStart` /
 * `maxStart`。`$profile` の `periodMin` / `periodMax` が要る）、(2) ソースのファイル形式
 * （`$sourceType`）、(3) **ソースの組ごと**の結合キー候補（`joinKeys` スロットは左右 2 つの
 * スロットを名指しするので、全ソースの和集合では「その 2 つで結べるか」を判定できない）
 * を持たない。3 つとも足すと `ToolSpecContext` の意味が変わり v42 側の検証に影響するため、
 * 別の型として定義する。
 */
export interface TemplateContext {
  readonly sources: readonly TemplateSourceContext[];
  readonly joinCandidates: readonly TemplateJoinCandidateContext[];
}

/**
 * `$profile` が読む事実。必要な材料は `TemplateContext` と同じなので別名にする
 * （契約 §3 の名前を残しつつ、application が 2 つの型を組み立て分けなくて済むようにする）。
 */
export type TemplateProfileFacts = TemplateContext;

/**
 * application層: テンプレート経路の 2 つのタスク（v43 実装契約 §4 / ADR-0049 決定 3）。
 *
 * テンプレート経路でモデルがする仕事は 2 つしかない:
 * 1. `select-template` — 当てはまるテンプレートの中から **id を 1 つ選ぶ**（`none` も選べる）。
 * 2. `fill-slots` — そのテンプレートのスロットを、**候補の中から**埋める。
 *
 * どちらもグラフの JSON を書かない。構成はテンプレートが持ち、候補は `slotCandidates` が
 * プロファイルから決定的に作るので、12B 級のモデルでも「列名の書き間違い」は構造的に起きない。
 *
 * 規律は v42 の設計タスクと同じ 3 つ:
 * - **選択肢を閉じる**: 列・結合キー・粒度・選択肢は enum、数値は min/max、自由記述は列名と意図文だけ。
 * - **材料は最小**: プロファイル全体（サンプル行・全列）は渡さない。候補に挙がった列の
 *   「選ぶのに要る事実」（カテゴリの実在値 8 件・粒度の内訳と範囲・結合キーの重なり）だけを載せる。
 * - **スキーマで言えないことは `parse` で言う**: 依存する候補（`granularities:<slot>` や
 *   `distinctFrom`）は `validateSlotValues` で決定的に検査し、そのままモデルへ差し戻せる文で返す。
 */
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import {
  slotCandidates,
  withSlotDefaults,
  validateSlotValues,
  type SlotCandidates,
  type TemplateSlotValues,
} from '../../../domain/tool-template/instantiate';
import type {
  TemplateContext,
  TemplateSourceContext,
  ToolTemplate,
  ToolTemplateSlot,
} from '../../../domain/tool-template/template';
import type { JsonSchemaObject, JsonSchemaProperty } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import type { DataProfile } from '../profile-data-sources';
import type { RoleTask, RoleTaskParseResult } from './role-task';

/** カテゴリ列ごとに材料として見せる実在値の件数（v42 の設計タスクと同じ上限）。 */
export const TEMPLATE_CATEGORY_VALUE_SAMPLE = 8;

/** 「どのテンプレートも合わない」を表す選択肢（enum に必ず入れる）。 */
export const NO_TEMPLATE = 'none';

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quote(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value) ?? 'nothing';
}

function list(values: readonly string[]): string {
  return values.join(', ');
}

function parseJsonObject(content: string | null): RoleTaskParseResult<Record<string, unknown>> {
  if (content === null || content.trim() === '') {
    return { ok: false, issues: ['The response was empty. Return a JSON object matching the schema.'] };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, issues: ['The response was not valid JSON. Return only a JSON object matching the schema.'] };
  }
  if (!isRecord(value)) return { ok: false, issues: ['The response must be a JSON object.'] };
  return { ok: true, value };
}

function planMaterial(plan: FactoryToolPlan): Record<string, unknown> {
  return {
    purpose: plan.purpose,
    ...(plan.argumentSummary === undefined ? {} : { argumentSummary: plan.argumentSummary }),
    ...(plan.outputShape === undefined ? {} : { outputShape: plan.outputShape }),
  };
}

function goalMaterial(goal: FactoryGoalInput): Record<string, unknown> {
  return {
    goal: goal.goal,
    ...(goal.constraints === undefined ? {} : { constraints: goal.constraints }),
    language: goal.language,
  };
}

// ---------------------------------------------------------------------------
// T1 select-template
// ---------------------------------------------------------------------------

export interface SelectTemplateInput {
  readonly plan: FactoryToolPlan;
  readonly goal: FactoryGoalInput;
  /** `applicableTemplates` が既に絞ったもの（このデータで埋められるものだけ）。 */
  readonly templates: readonly ToolTemplate[];
}

export interface SelectTemplateOutput {
  /** 選ばれたテンプレート。`none`（どれも合わない）なら undefined。 */
  readonly template?: ToolTemplate;
  readonly reason: string;
}

/** 選択肢の id（`none` を必ず末尾に足す）。 */
export function templateChoices(input: SelectTemplateInput): string[] {
  return [...input.templates.map((template) => template.id), NO_TEMPLATE];
}

/** このタスクがモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/tasks/select-template.md`。 */
export const SELECT_TEMPLATE_PROMPT: PromptSpec = { id: 'factory/tasks/select-template', sections: ['goal', 'rules'] };

export const selectTemplateTaskOf = (prompts: PromptCatalogPort): RoleTask<SelectTemplateInput, SelectTemplateOutput> => ({
  name: 'select-template',
  goal: prompts.get(SELECT_TEMPLATE_PROMPT.id).render('goal'),
  rules: prompts.get(SELECT_TEMPLATE_PROMPT.id).render('rules', { noTemplate: NO_TEMPLATE }).split('\n'),
  schema(input) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['templateId', 'reason'],
      properties: {
        templateId: { type: 'string', enum: templateChoices(input) },
        reason: { type: 'string' },
      },
    };
  },
  payload(input) {
    const language = input.goal.language;
    return {
      ...planMaterial(input.plan),
      ...goalMaterial(input.goal),
      templates: input.templates.map((template) => ({
        id: template.id,
        summary: template.summary[language],
        whenToUse: template.whenToUse[language],
        ...(template.notFor === undefined ? {} : { notFor: template.notFor[language] }),
      })),
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const choices = templateChoices(input);
    const templateId = root.value['templateId'];
    if (typeof templateId !== 'string' || !choices.includes(templateId)) {
      return { ok: false, issues: [`templateId must be one of: ${list(choices)}. Received ${quote(templateId)}.`] };
    }
    const reason = root.value['reason'];
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text === '') {
      return { ok: false, issues: ['reason must be one short sentence saying why you chose that template.'] };
    }
    if (templateId === NO_TEMPLATE) return { ok: true, value: { reason: text } };
    const template = input.templates.find((candidate) => candidate.id === templateId);
    // enum に入っている以上ここへは来ない（防御的）。
    if (template === undefined) {
      return { ok: false, issues: [`templateId must be one of: ${list(choices)}. Received ${quote(templateId)}.`] };
    }
    return { ok: true, value: { template, reason: text } };
  },
});

// ---------------------------------------------------------------------------
// T2 fill-slots
// ---------------------------------------------------------------------------

export interface FillSlotsInput {
  readonly template: ToolTemplate;
  readonly context: TemplateContext;
  /** このツールが読むプロファイル（主 → 追加の順）。候補に添える事実を引くためだけに使う。 */
  readonly profiles: readonly DataProfile[];
  readonly plan: FactoryToolPlan;
  readonly goal: FactoryGoalInput;
  /**
   * 決定的に割り当てた `dataSource` スロット（主ソースが先、続いて計画の追加ソース順）。
   * モデルには**訊かない**: どのソースを読むかは Tool 計画が既に決めている。
   */
  readonly dataSources: Readonly<Record<string, string>>;
}

/** モデルへ訊くスロット（`dataSource` 以外すべて）。 */
export function askedSlots(template: ToolTemplate): ToolTemplateSlot[] {
  return template.slots.filter((slot) => slot.kind !== 'dataSource');
}

/** 割り当て済みの dataSource を当てはめた候補（依存する候補はこれで絞られる）。 */
export function candidatesOf(input: FillSlotsInput): Record<string, SlotCandidates> {
  return slotCandidates(input.template, input.context, input.dataSources);
}

function namesOf(candidates: SlotCandidates | undefined): string[] {
  return Array.isArray(candidates) ? [...candidates] : [];
}

/** その `column` スロットが読むソースの文脈（`dataSource` スロットの割り当てを辿る）。 */
function sourceOfSlot(input: FillSlotsInput, sourceSlot: string): TemplateSourceContext | undefined {
  const id = input.dataSources[sourceSlot];
  return input.context.sources.find((source) => source.dataSourceId === id);
}

function profileOf(input: FillSlotsInput, sourceSlot: string): DataProfile | undefined {
  const id = input.dataSources[sourceSlot];
  return input.profiles.find((profile) => profile.dataSourceId === id);
}

/**
 * 候補 1 スロットぶんの材料。列名だけでは選べない役割には、選ぶのに要る事実を添える:
 * カテゴリ列は実在値の例、期間列は粒度ごとの件数と範囲、結合キーは重なりと一意性。
 */
export function slotMaterialOf(input: FillSlotsInput, slot: ToolTemplateSlot, candidates: Record<string, SlotCandidates>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: slot.name,
    label: slot.label[input.goal.language],
    ...(slot.help === undefined ? {} : { help: slot.help[input.goal.language] }),
    kind: slot.kind,
    optional: slot.optional === true,
  };
  const options = candidates[slot.name];
  switch (slot.kind) {
    case 'column': {
      const names = namesOf(options);
      const source = sourceOfSlot(input, slot.source);
      const profile = profileOf(input, slot.source);
      if (slot.role === 'category') {
        return {
          ...base,
          role: slot.role,
          ...(slot.multiple === undefined ? {} : { choose: slot.multiple }),
          ...(slot.distinctFrom === undefined ? {} : { mustDifferFrom: [...slot.distinctFrom] }),
          candidates: names.map((name) => ({
            column: name,
            values: (source?.categoricalColumns.find((column) => column.column === name)?.values ?? []).slice(0, TEMPLATE_CATEGORY_VALUE_SAMPLE),
          })),
        };
      }
      if (slot.role === 'period') {
        return {
          ...base,
          role: slot.role,
          ...(slot.multiple === undefined ? {} : { choose: slot.multiple }),
          candidates: names.map((name) => {
            const period = profile?.periodColumns.find((column) => column.column === name);
            return {
              column: name,
              granularities: period?.granularities ?? {},
              ...(period?.minStart === undefined ? {} : { minStart: period.minStart }),
              ...(period?.maxStart === undefined ? {} : { maxStart: period.maxStart }),
            };
          }),
        };
      }
      return {
        ...base,
        role: slot.role,
        ...(slot.multiple === undefined ? {} : { choose: slot.multiple }),
        ...(slot.distinctFrom === undefined ? {} : { mustDifferFrom: [...slot.distinctFrom] }),
        candidates: names,
      };
    }
    case 'joinKeys': {
      const left = sourceOfSlot(input, slot.left);
      const right = sourceOfSlot(input, slot.right);
      const candidate = (input.profiles[0]?.joinCandidates ?? []).find((entry) =>
        (entry.leftDataSourceId === left?.dataSourceId && entry.rightDataSourceId === right?.dataSourceId)
        || (entry.leftDataSourceId === right?.dataSourceId && entry.rightDataSourceId === left?.dataSourceId));
      return {
        ...base,
        choose: slot.multiple,
        candidates: namesOf(options).map((name) => ({
          column: name,
          ...(candidate?.overlap[name] === undefined ? {} : { overlap: candidate.overlap[name] }),
        })),
        ...(candidate === undefined ? {} : { uniqueLeft: candidate.uniqueLeft, uniqueRight: candidate.uniqueRight }),
      };
    }
    case 'number':
      return { ...base, min: slot.min, max: slot.max, integer: slot.integer === true, default: slot.default };
    case 'choice':
      return { ...base, candidates: namesOf(options), ...(slot.default === undefined ? {} : { default: slot.default }) };
    case 'text':
      return { ...base, maxLength: slot.maxLength, default: slot.default };
    case 'intent':
      return { ...base, maxLength: slot.maxLength };
    default:
      // `dataSource` スロットはモデルへ訊かない（`askedSlots` が除く）ので、ここへは来ない。
      return base;
  }
}

/** スロット 1 つぶんの JSON Schema（候補を enum で閉じる）。 */
export function slotSchemaOf(slot: ToolTemplateSlot, candidates: Record<string, SlotCandidates>): JsonSchemaProperty {
  const optional = slot.optional === true;
  const options = candidates[slot.name];
  const names = namesOf(options);
  switch (slot.kind) {
    case 'column': {
      const item: JsonSchemaProperty = names.length === 0 ? { type: 'string' } : { type: 'string', enum: names };
      if (slot.multiple !== undefined) {
        return {
          type: optional ? ['array', 'null'] : 'array',
          items: item,
          minItems: optional ? 0 : slot.multiple.min,
          maxItems: slot.multiple.max,
        };
      }
      if (!optional) return item;
      return names.length === 0 ? { type: ['string', 'null'] } : { type: ['string', 'null'], enum: [...names, null] };
    }
    case 'joinKeys': {
      const item: JsonSchemaProperty = names.length === 0 ? { type: 'string' } : { type: 'string', enum: names };
      return { type: 'array', items: item, minItems: slot.multiple.min, maxItems: slot.multiple.max };
    }
    case 'choice': {
      if (names.length === 0) return { type: optional ? ['string', 'null'] : 'string' };
      return optional ? { type: ['string', 'null'], enum: [...names, null] } : { type: 'string', enum: names };
    }
    case 'number':
      return { type: slot.integer === true ? 'integer' : 'number', minimum: slot.min, maximum: slot.max };
    case 'text':
    case 'intent':
      return { type: optional ? ['string', 'null'] : 'string', maxLength: slot.maxLength };
    default:
      // `dataSource` スロットはモデルへ訊かない（`askedSlots` が除く）ので、ここへは来ない。
      return { type: 'string' };
  }
}

/** モデルの 1 スロットぶんの応答を、スロット値の型（文字列 / 数値 / 配列）へ寄せる。 */
function slotValueOf(slot: ToolTemplateSlot, raw: unknown): string | number | readonly string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (slot.kind === 'number') return typeof raw === 'number' ? raw : Number(raw);
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (typeof raw === 'string') return raw;
  return String(raw);
}

/** このタスクがモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/tasks/fill-slots.md`。 */
export const FILL_SLOTS_PROMPT: PromptSpec = { id: 'factory/tasks/fill-slots', sections: ['goal', 'rules'] };

export const fillSlotsTaskOf = (prompts: PromptCatalogPort): RoleTask<FillSlotsInput, TemplateSlotValues> => ({
  name: 'fill-slots',
  goal: prompts.get(FILL_SLOTS_PROMPT.id).render('goal'),
  rules: prompts.get(FILL_SLOTS_PROMPT.id).render('rules').split('\n'),
  schema(input) {
    const candidates = candidatesOf(input);
    const properties: Record<string, JsonSchemaProperty> = {};
    const required: string[] = [];
    for (const slot of askedSlots(input.template)) {
      properties[slot.name] = slotSchemaOf(slot, candidates);
      required.push(slot.name);
    }
    const schema: JsonSchemaObject = { type: 'object', additionalProperties: false, required, properties };
    return schema;
  },
  payload(input) {
    const candidates = candidatesOf(input);
    return {
      ...planMaterial(input.plan),
      ...goalMaterial(input.goal),
      template: { id: input.template.id, summary: input.template.summary[input.goal.language] },
      slots: askedSlots(input.template).map((slot) => slotMaterialOf(input, slot, candidates)),
    };
  },
  parse(content, input) {
    const root = parseJsonObject(content);
    if (!root.ok) return root;
    const given: Record<string, string | number | readonly string[] | undefined> = {};
    const issues: string[] = [];
    for (const slot of askedSlots(input.template)) {
      const raw = root.value[slot.name];
      if (slot.kind === 'number' && raw !== null && raw !== undefined && typeof raw !== 'number' && Number.isNaN(Number(raw))) {
        issues.push(`${slot.name} must be a number between ${slot.min} and ${slot.max}. Received ${quote(raw)}.`);
        continue;
      }
      const value = slotValueOf(slot, raw);
      if (value !== undefined) given[slot.name] = value;
    }
    if (issues.length > 0) return { ok: false, issues };

    // どのソースを読むかは計画が決めているので、モデルの答えへ決定的に足してから検証する。
    const merged = withSlotDefaults(input.template, { ...given, ...input.dataSources });
    const violations = validateSlotValues(input.template, merged, input.context);
    if (violations.length > 0) return { ok: false, issues: violations.map((violation) => violation.message) };
    return { ok: true, value: merged };
  },
});

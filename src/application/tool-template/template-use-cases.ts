/**
 * application層: ツールテンプレートを**人が**使うためのユースケース（v43 実装契約 §5 / ADR-0049）。
 *
 * Factory（モデル）とツール作成画面（人）は同じファイル・同じ候補・同じ実体化を通る。ここは
 * その「人の側の入口」で、HTTP へそのまま載る形（DTO）へ落とす仕事だけを持つ:
 *
 * 1. `ListToolTemplatesUseCase` — 一覧（読めたもの + 読めなかったものの理由と直し方）。
 * 2. `TemplateSlotCandidatesUseCase` — スロットごとの候補。**なぜその候補なのか**を人が読めるよう、
 *    列の型・カテゴリ列の実在値・期間列の粒度と範囲・結合キーの重なりと一意性を一緒に返す
 *    （画面がドロップダウンの横に出す。選択の根拠が見えないと、人は当てずっぽうで選ぶ）。
 * 3. `InstantiateToolTemplateUseCase` — スロット検証 → 実体化 → 既存の検査（手で組んだ Tool と同じ）。
 *    保存はしない。返すのはキャンバスへ展開するための `graph` / `inputSchema` / `agentTool`。
 *
 * 失敗は必ず**どのスロットを直せばよいか**を持つ（`ToolTemplateSlotsError`）。画面はそれを
 * スロットの真横へ出す（このリポジトリの UX 規律: 診断は直し方と修正箇所への導線を最優先する）。
 */
import type { DataSourceId } from '../../domain/data-source/ids';
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import {
  slotCandidates,
  validateSlotValues,
  instantiateTemplate,
  withSlotDefaults,
  type SlotCandidates,
  type TemplateSlotValues,
} from '../../domain/tool-template/instantiate';
import {
  ToolTemplateError,
  type LocalizedText,
  type TemplateSlotKind,
  type ToolTemplate,
  type ToolTemplateSlot,
} from '../../domain/tool-template/template';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { DataProfile, ProfileDataSourcesUseCase } from '../factory/profile-data-sources';
import type { InvalidToolTemplate, ToolTemplateCatalogPort } from './catalog-port';
import { templateContextOf } from './template-context';
import { validateInstantiatedTemplate } from './validate-instantiated';

/** カテゴリ列の候補に添える実在値の件数（多すぎると選択肢が読めなくなる）。 */
export const MAX_CANDIDATE_EXAMPLES = 8;

// ── エラー ───────────────────────────────────────────────────────────────────────

/** 指定された id のテンプレートが（置き場所のどこにも）無い。 */
export class ToolTemplateNotFoundError extends Error {
  readonly code = 'TOOL_TEMPLATE_NOT_FOUND';

  constructor(templateId: string, known: readonly string[]) {
    super(`tool template '${templateId}' was not found; choose one of ${known.join(', ') || 'none — no template file could be read (see the invalid list)'}`);
    this.name = 'ToolTemplateNotFoundError';
  }
}

/** スロット 1 つぶんの問題。`slot` が分かるものは必ず持つ（画面がその欄の真下へ出す）。 */
export interface ToolTemplateSlotProblem {
  readonly slot?: string;
  readonly message: string;
}

/** スロットの選び方が成立しない（どの欄を選び直せばよいかを持つ）。 */
export class ToolTemplateSlotsError extends Error {
  readonly code = 'TOOL_TEMPLATE_SLOTS';

  constructor(message: string, readonly slots: readonly ToolTemplateSlotProblem[]) {
    super(message);
    this.name = 'ToolTemplateSlotsError';
  }
}

// ── 一覧の DTO ───────────────────────────────────────────────────────────────────

/** 一覧が返すスロット宣言（テンプレートのスロットをそのまま + `optional` を必ず持つ形）。 */
export interface ToolTemplateSlotView {
  readonly name: string;
  readonly kind: TemplateSlotKind;
  readonly label: LocalizedText;
  readonly help?: LocalizedText;
  readonly optional: boolean;
  /** `column`: どの `dataSource` スロットの列か / 役割 / 型の絞り / 複数選択 / 重複禁止。 */
  readonly source?: string;
  readonly role?: string;
  readonly types?: readonly string[];
  readonly multiple?: { readonly min: number; readonly max: number };
  readonly distinctFrom?: readonly string[];
  /** `joinKeys`: 左右の `dataSource` スロット。 */
  readonly left?: string;
  readonly right?: string;
  /** `choice`: 固定の選択肢とラベル。 */
  readonly options?: readonly { readonly value: string; readonly label: LocalizedText }[];
  readonly optionsFrom?: string;
  /** `choice` / `number` / `text` の既定値（画面の初期値）。 */
  readonly default?: string | number;
  /** `number`: 範囲と整数制約。 */
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  /** `text` / `intent`: 文字数上限と形。 */
  readonly maxLength?: number;
  readonly pattern?: string;
}

/** 一覧が返すテンプレート 1 件（ノード・エッジは人が選ぶ材料ではないので載せない）。 */
export interface ToolTemplateView {
  readonly id: string;
  readonly version: string;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly whenToUse: { readonly ja: readonly string[]; readonly en: readonly string[] };
  readonly notFor?: { readonly ja: readonly string[]; readonly en: readonly string[] };
  readonly tags: readonly string[];
  readonly sources: { readonly min: number; readonly max: number };
  readonly slots: readonly ToolTemplateSlotView[];
}

export interface ToolTemplateCatalogView {
  readonly templates: readonly ToolTemplateView[];
  readonly invalid: readonly InvalidToolTemplate[];
}

/** スロット宣言 → DTO。kind ごとの項目は「あるものだけ」を載せる（undefined のキーを作らない）。 */
export function slotViewOf(slot: ToolTemplateSlot): ToolTemplateSlotView {
  const base = {
    name: slot.name,
    kind: slot.kind,
    label: slot.label,
    ...(slot.help === undefined ? {} : { help: slot.help }),
    optional: slot.optional === true,
  };
  switch (slot.kind) {
    case 'column':
      return {
        ...base,
        source: slot.source,
        role: slot.role,
        ...(slot.types === undefined ? {} : { types: slot.types }),
        ...(slot.multiple === undefined ? {} : { multiple: slot.multiple }),
        ...(slot.distinctFrom === undefined ? {} : { distinctFrom: slot.distinctFrom }),
      };
    case 'joinKeys':
      return { ...base, left: slot.left, right: slot.right, multiple: slot.multiple };
    case 'choice':
      return {
        ...base,
        ...(slot.options === undefined ? {} : { options: slot.options }),
        ...(slot.optionsFrom === undefined ? {} : { optionsFrom: slot.optionsFrom }),
        ...(slot.default === undefined ? {} : { default: slot.default }),
      };
    case 'number':
      return { ...base, min: slot.min, max: slot.max, ...(slot.integer === undefined ? {} : { integer: slot.integer }), default: slot.default };
    case 'text':
      return { ...base, maxLength: slot.maxLength, ...(slot.pattern === undefined ? {} : { pattern: slot.pattern }), default: slot.default };
    case 'intent':
      return { ...base, maxLength: slot.maxLength };
    default:
      return base;
  }
}

/** テンプレート → 一覧の DTO。 */
export function templateViewOf(template: ToolTemplate): ToolTemplateView {
  return {
    id: template.id,
    version: template.version,
    title: template.title,
    summary: template.summary,
    whenToUse: template.whenToUse,
    ...(template.notFor === undefined ? {} : { notFor: template.notFor }),
    tags: template.tags,
    sources: template.sources,
    slots: template.slots.map(slotViewOf),
  };
}

/**
 * テンプレート一覧。**読めなかったファイルも一緒に返す**のが要（黙って落とすと
 * 「足したのに出てこない」になり、利用者は何が悪いか分からない）。
 */
export class ListToolTemplatesUseCase {
  constructor(private readonly catalog: ToolTemplateCatalogPort) {}

  async execute(): Promise<ToolTemplateCatalogView> {
    const catalog = await this.catalog.list();
    return { templates: catalog.templates.map(templateViewOf), invalid: catalog.invalid };
  }
}

// ── 候補の DTO ───────────────────────────────────────────────────────────────────

/**
 * 候補 1 件。値（`value`）のほかに「なぜこれを選べるのか」を人が読める材料を添える。
 * 種類ごとに項目が違うので、**あるものだけ**を載せる（無いキーは作らない）。
 */
export interface SlotOptionView {
  /** スロットへ入れる値（データソース id / 列名 / 選択肢の値）。 */
  readonly value: string;
  /** `choice` の表示名（固定の選択肢だけが持つ）。 */
  readonly label?: LocalizedText;
  /** `dataSource`: データソースの表示名。 */
  readonly name?: string;
  /** `column`: 列の型。 */
  readonly type?: string;
  /** `column`（カテゴリ列）: 実在値の例（最大 `MAX_CANDIDATE_EXAMPLES` 件）。 */
  readonly examples?: readonly string[];
  /** `column`（カテゴリ列）: 相異なる値の総数（例より多いことを人へ伝える）。 */
  readonly distinctCount?: number;
  /** `column`（期間列）: 粒度ごとの行数。 */
  readonly granularities?: Readonly<Record<string, number>>;
  /** `column`（期間列）: 解釈できた開始日の最小 / 最大。 */
  readonly minStart?: string;
  readonly maxStart?: string;
  /** `joinKeys`: 値の重なり（小さい方の distinct 集合に対する割合。0..1）。 */
  readonly overlap?: number;
  /** `joinKeys`: この候補の組み合わせが左 / 右で行を一意に決めるか。 */
  readonly uniqueLeft?: boolean;
  readonly uniqueRight?: boolean;
}

/** スロット 1 つぶんの候補。 */
export interface SlotCandidatesView {
  readonly slot: string;
  readonly kind: TemplateSlotKind;
  /** 選べる値（`dataSource` / `column` / `joinKeys` / `choice`）。自由記述と数値では省略。 */
  readonly options?: readonly SlotOptionView[];
  /** `number` の範囲。 */
  readonly range?: { readonly min: number; readonly max: number };
  /** `text` / `intent`（自由記述）。 */
  readonly freeText?: true;
}

export interface SlotCandidatesResult {
  readonly templateId: string;
  readonly version: string;
  readonly candidates: readonly SlotCandidatesView[];
}

// ── 候補・実体化が共有する読み込み ───────────────────────────────────────────────

/** 候補・実体化の共通入力（どのテンプレートを、どのデータソースに対して）。 */
export interface ToolTemplateRequest {
  readonly scope: TenantScope;
  readonly templateId: string;
  readonly dataSourceIds: readonly DataSourceId[];
  /** 既に決まっているスロット（部分でよい）。依存する候補がこれに合わせて絞られる。 */
  readonly values?: TemplateSlotValues;
}

async function loadTemplate(catalog: ToolTemplateCatalogPort, templateId: string): Promise<ToolTemplate> {
  const listed = await catalog.list();
  const template = listed.templates.find((candidate) => candidate.id === templateId);
  if (template === undefined) throw new ToolTemplateNotFoundError(templateId, listed.templates.map((candidate) => candidate.id));
  return template;
}

/**
 * データソースの数がテンプレートの `sources` に収まるかを見る。
 * 収まらないまま実体化すると「ソースノードの config が空」のような分かりにくい失敗になるので、
 * ここで**いくつ選べばよいか**を言って止める。
 */
function checkSourceCount(template: ToolTemplate, dataSourceIds: readonly DataSourceId[]): void {
  const { min, max } = template.sources;
  if (dataSourceIds.length >= min && dataSourceIds.length <= max) return;
  const expected = min === max ? `exactly ${min}` : `between ${min} and ${max}`;
  throw new ToolTemplateError(`the template '${template.id}' reads ${expected} data source(s), but ${dataSourceIds.length} were given; pick ${expected} data source(s) and try again`);
}

/** 粒度ごとの行数・実在値・重なりは `TemplateContext` に無いので、プロファイルから直に読む。 */
function profileOf(profiles: readonly DataProfile[], dataSourceId: string | undefined): DataProfile | undefined {
  return dataSourceId === undefined ? undefined : profiles.find((profile) => profile.dataSourceId === dataSourceId);
}

/**
 * その `dataSource` スロットが指すソース id。
 * 値があればそれ、無ければ**宣言順**で対応するソース（domain の `slotCandidates` と同じ規則）。
 */
function sourceIdFor(template: ToolTemplate, profiles: readonly DataProfile[], values: TemplateSlotValues, slotName: string): string | undefined {
  const chosen = values[slotName];
  if (typeof chosen === 'string' && chosen !== '') return chosen;
  const index = template.slots.filter((slot) => slot.kind === 'dataSource').findIndex((slot) => slot.name === slotName);
  return index < 0 ? undefined : profiles[index]?.dataSourceId;
}

// ── 候補ユースケース ─────────────────────────────────────────────────────────────

/**
 * スロットごとの候補を、選ぶ根拠つきで返す。
 *
 * `values`（部分でよい）を渡すと、それに依存する候補（列・結合キー・粒度）がそのソース／その列に
 * 合わせて絞られる。画面はスロットを 1 つ変えるたびに呼び直す。
 */
export class TemplateSlotCandidatesUseCase {
  constructor(
    private readonly catalog: ToolTemplateCatalogPort,
    private readonly profiler: ProfileDataSourcesUseCase,
  ) {}

  async execute(request: ToolTemplateRequest): Promise<SlotCandidatesResult> {
    const template = await loadTemplate(this.catalog, request.templateId);
    checkSourceCount(template, request.dataSourceIds);
    // `executeAll` は結合キー候補（重なり・一意性）も埋めるので、複数ソースのテンプレートでも同じ呼び方でよい。
    const profiles = await this.profiler.executeAll(request.scope, request.dataSourceIds);
    const context = templateContextOf({ dataSourceIds: request.dataSourceIds }, profiles);
    const values = withSlotDefaults(template, request.values ?? {});
    const candidates = slotCandidates(template, context, values);

    return {
      templateId: template.id,
      version: template.version,
      candidates: template.slots.map((slot) => this.viewOf(template, slot, candidates[slot.name] ?? [], profiles, values)),
    };
  }

  private viewOf(
    template: ToolTemplate,
    slot: ToolTemplateSlot,
    candidate: SlotCandidates,
    profiles: readonly DataProfile[],
    values: TemplateSlotValues,
  ): SlotCandidatesView {
    const base = { slot: slot.name, kind: slot.kind };
    if (candidate === 'free-text') return { ...base, freeText: true };
    if (!Array.isArray(candidate)) return { ...base, range: candidate as { readonly min: number; readonly max: number } };
    const options = candidate as readonly string[];
    switch (slot.kind) {
      case 'dataSource':
        return { ...base, options: options.map((id) => ({ value: id, name: profileOf(profiles, id)?.name ?? id })) };
      case 'column': {
        const profile = profileOf(profiles, sourceIdFor(template, profiles, values, slot.source));
        return { ...base, options: options.map((column) => columnOptionOf(column, profile)) };
      }
      case 'joinKeys': {
        const left = sourceIdFor(template, profiles, values, slot.left);
        const right = sourceIdFor(template, profiles, values, slot.right);
        return { ...base, options: options.map((key) => joinKeyOptionOf(key, options, profiles, left, right)) };
      }
      default: {
        const declared = slot.kind === 'choice' ? slot.options : undefined;
        return {
          ...base,
          options: options.map((value) => {
            const label = declared?.find((option) => option.value === value)?.label;
            return label === undefined ? { value } : { value, label };
          }),
        };
      }
    }
  }
}

/** 列の候補 1 件（型 + カテゴリ列の実在値 + 期間列の粒度と範囲）。 */
function columnOptionOf(column: string, profile: DataProfile | undefined): SlotOptionView {
  const type = profile?.columns.find((candidate) => candidate.name === column)?.type;
  const categorical = profile?.categoricalColumns.find((candidate) => candidate.column === column);
  const period = profile?.periodColumns.find((candidate) => candidate.column === column);
  return {
    value: column,
    ...(type === undefined ? {} : { type }),
    ...(categorical === undefined ? {} : { examples: categorical.values.slice(0, MAX_CANDIDATE_EXAMPLES), distinctCount: categorical.distinctCount }),
    ...(period === undefined ? {} : {
      granularities: period.granularities as Readonly<Record<string, number>>,
      ...(period.minStart === undefined ? {} : { minStart: period.minStart }),
      ...(period.maxStart === undefined ? {} : { maxStart: period.maxStart }),
    }),
  };
}

/**
 * 結合キーの候補 1 件（重なりと一意性）。
 *
 * 一意性はプロファイルが「候補キー**全部**を使ったとき」について測った値である。画面は
 * 「候補を全部選べば行は増えない」を示すために使う（1 つだけ選ぶと行が増えうる、の警告）。
 */
function joinKeyOptionOf(
  key: string,
  allKeys: readonly string[],
  profiles: readonly DataProfile[],
  left: string | undefined,
  right: string | undefined,
): SlotOptionView {
  const candidate = left === undefined || right === undefined ? undefined : profiles
    .flatMap((profile) => profile.joinCandidates)
    .find((entry) =>
      (entry.leftDataSourceId === left && entry.rightDataSourceId === right)
      || (entry.leftDataSourceId === right && entry.rightDataSourceId === left));
  const overlap = candidate?.overlap[key];
  // 一意性は「候補キーを全部選んだとき」の値なので、候補の一部しか無い組では意味を持たない。
  const complete = candidate !== undefined && candidate.keys.length === allKeys.length;
  return {
    value: key,
    ...(overlap === undefined ? {} : { overlap }),
    ...(complete ? { uniqueLeft: candidate.uniqueLeft, uniqueRight: candidate.uniqueRight } : {}),
  };
}

// ── 実体化ユースケース ───────────────────────────────────────────────────────────

export interface InstantiateToolTemplateRequest extends ToolTemplateRequest {
  readonly values: TemplateSlotValues;
  readonly language: 'ja' | 'en';
  /** エージェントへ公開する function 名。省略するとテンプレート id を使う（人が後で直せる）。 */
  readonly toolName?: string;
}

export interface InstantiateToolTemplateResult {
  readonly template: { readonly id: string; readonly version: string };
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;
  readonly agentTool: { readonly name: string; readonly description: string };
  /** 式が空の calculate ノード（画面が「AI に式を書かせる」へ意図文を入れておく）。 */
  readonly pendingExpressions: readonly { readonly nodeId: string; readonly intent: string }[];
}

/**
 * スロット値を検証し、実体化し、**手で組んだ Tool と同じ検査**へ掛ける（テンプレート経路だけの
 * 抜け道を作らない）。保存はしない — 返すのはキャンバスへ展開するためのグラフである。
 *
 * `$intent` を持つテンプレート（式を AI に書かせるもの）は、実体化の時点で式が空なので
 * エンジンの検査には掛けられない。その場合は `pendingExpressions` を付けて返し、式が入った後の
 * 検査はツール作成画面の自動プレビュー（保存前の検証）に委ねる。
 */
export class InstantiateToolTemplateUseCase {
  constructor(
    private readonly catalog: ToolTemplateCatalogPort,
    private readonly profiler: ProfileDataSourcesUseCase,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources: ResolveDataSourceGraphUseCase,
  ) {}

  async execute(request: InstantiateToolTemplateRequest): Promise<InstantiateToolTemplateResult> {
    const template = await loadTemplate(this.catalog, request.templateId);
    checkSourceCount(template, request.dataSourceIds);
    const profiles = await this.profiler.executeAll(request.scope, request.dataSourceIds);
    const context = templateContextOf({ dataSourceIds: request.dataSourceIds }, profiles);

    const violations = validateSlotValues(template, request.values, context);
    if (violations.length > 0) {
      throw new ToolTemplateSlotsError(
        `${violations.length} slot(s) of the template '${template.id}' need a different value`,
        violations.map((violation) => ({ slot: violation.slot, message: violation.message })),
      );
    }

    const instantiated = instantiateTemplate(template, request.values, context, {
      toolName: request.toolName ?? template.id,
      language: request.language,
    });

    if (instantiated.pendingExpressions.length === 0) {
      const problems = await validateInstantiatedTemplate(this.engine, instantiated, (graph) => this.resolveDataSources.execute(request.scope, graph));
      if (problems.length > 0) {
        throw new ToolTemplateSlotsError(
          `the tool built from the template '${template.id}' did not pass the same checks a hand-built tool passes`,
          problems.map((problem) => ({ ...(problem.slot === undefined ? {} : { slot: problem.slot }), message: problem.message })),
        );
      }
    }

    return {
      template: { id: template.id, version: template.version },
      graph: instantiated.graph,
      ...(instantiated.inputSchema === undefined ? {} : { inputSchema: instantiated.inputSchema }),
      agentTool: instantiated.agentTool,
      pendingExpressions: instantiated.pendingExpressions,
    };
  }
}

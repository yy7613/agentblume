/**
 * application層: Agent Factory Stage 1 Plannerロール（v33 実装契約 §3 / docs/16-agent-factory.md §3, §4 Stage 1）。
 *
 * 「system prompt テンプレート + 構造化出力スキーマ + 温度0の1回呼び出し」で `ModelProviderPort` を呼び、
 * `FactoryPlan` を提案させる（`suggest-analysis-config.ts` と同じ形: LLM提案 → JSON.parse → アプリ側で
 * `validateFactoryPlan` により再検証）。データソースの列・サンプル行はuntrusted dataとしてuser message側へ
 * 隔離し、system命令へは混ぜない。
 */
import type { DataSourceId } from '../../../domain/data-source/ids';
import { FactoryValidationError } from '../../../domain/factory/errors';
import { MAX_ADDITIONAL_DATA_SOURCES, validateFactoryPlan, type FactoryPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput, FactoryOptions } from '../../../domain/factory/factory-run';
import type { JsonSchemaObject, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import type { DataProfile } from '../profile-data-sources';
import type { ExistingToolCatalog } from '../tool-catalog';
import { describeScenarioGroundingViolations } from './plan-grounding';
import { wrapUntrusted } from './untrusted';

/** docs/16-agent-factory.md §4 Stage 1: Tool ≤4 / Skill ≤3（固定）。Persona / Scenario は options 由来。 */
const MAX_TOOLS = 4;
const MAX_SKILLS = 3;
/** Plannerへ提示するプロファイルあたりのサンプル行数（Stage 0本体は最大20行を保持する）。 */
const PROMPT_SAMPLE_ROWS = 3;

/**
 * この役割がモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/planner.md` にあり、
 * ここに残るのは「どの節をどの順に使うか」だけ。
 *
 * - `rules.templates`: このデータで使えるツールテンプレートを渡したときだけ足す（v43 / ADR-0049）。
 * - `rules.enhancement`: 既存Agent強化モード（`currentAgent` 指定時）だけ足す「ギャップ計画」の規律。
 *   出力スキーマは生成モードと同一で、意味だけが「Agent一式の設計」から「既存Agentへの差分」に変わる。
 * - `repair`: 計画が `validateFactoryPlan` に落ちたとき、理由を添えて 1 回だけ出し直させる文。
 */
export const PLANNER_PROMPT: PromptSpec = {
  id: 'factory/planner',
  sections: ['system', 'rules.templates', 'rules.enhancement', 'closing', 'repair'],
};

const FACTORY_PLAN_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['agentBrief', 'tools', 'skills', 'personas', 'scenarios'],
  properties: {
    agentBrief: {
      type: 'object',
      additionalProperties: false,
      required: ['displayName', 'role'],
      properties: {
        displayName: { type: 'string' },
        role: { type: 'string' },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'displayName', 'purpose', 'dataSourceId', 'sideEffect'],
        properties: {
          key: { type: 'string' },
          displayName: { type: 'string' },
          purpose: { type: 'string' },
          dataSourceId: { type: 'string' },
          sideEffect: { type: 'string', enum: ['read-only', 'session-write'] },
          outputShape: { type: 'string' },
          argumentSummary: { type: 'string' },
          // 同じキー（同じ時点・同じ地域…）で値を並べる必要があるとき、1つのToolへ join で束ねる
          // 追加のデータソース（ADR-0047 round 3）。単一ソースのToolでは設定しない。
          additionalDataSourceIds: { type: 'array', items: { type: 'string' } },
          // 既存Toolで足りる場合だけ設定する（設定した計画はStage 2でToolSmithを呼ばずそのToolを参照する）。
          reuse: {
            type: 'object',
            additionalProperties: false,
            required: ['internalId'],
            properties: {
              internalId: { type: 'string' },
              rationale: { type: 'string' },
            },
          },
        },
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'displayName', 'responsibility', 'activationCondition', 'toolKeys'],
        properties: {
          key: { type: 'string' },
          displayName: { type: 'string' },
          responsibility: { type: 'string' },
          activationCondition: { type: 'string' },
          toolKeys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'archetype', 'knowledgeLevel', 'patience', 'tone', 'verbosity', 'language'],
        properties: {
          key: { type: 'string' },
          archetype: { type: 'string', enum: ['novice', 'expert', 'busy', 'vague', 'skeptical', 'custom'] },
          knowledgeLevel: { type: 'string', enum: ['low', 'mid', 'high'] },
          patience: { type: 'string', enum: ['low', 'mid', 'high'] },
          tone: { type: 'string' },
          verbosity: { type: 'string', enum: ['terse', 'normal', 'chatty'] },
          language: { type: 'string', enum: ['ja', 'en'] },
          extraInstructions: { type: 'string' },
        },
      },
    },
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'goal', 'personaKey', 'expectedToolKeys', 'maxUserTurns'],
        properties: {
          key: { type: 'string' },
          goal: { type: 'string' },
          context: { type: 'string' },
          personaKey: { type: 'string' },
          expectedToolKeys: { type: 'array', items: { type: 'string' } },
          maxUserTurns: { type: 'number' },
        },
      },
    },
  },
};

/**
 * 強化対象の既存Agentの現状（既存Agent強化モードでのみ渡す）。
 *
 * これが渡されると Planner は「0→1の設計」ではなく「ギャップ計画」を立てる: 既にAgentが持っている
 * 能力は計画し直さず、不足している分だけを新しいTool/Skillとして計画する。`systemPrompt` は利用者が
 * 書いた文章なので、他のpayload同様 untrusted data として user message 側へ隔離する。
 */
export interface PlannerCurrentAgent {
  readonly displayName: string;
  readonly systemPrompt: string;
  readonly tools: readonly { readonly publishName: string; readonly description: string }[];
  readonly skills: readonly { readonly displayName: string; readonly responsibility: string }[];
}

export interface PlannerRoleInput {
  readonly goal: FactoryGoalInput;
  readonly profiles: readonly DataProfile[];
  readonly dataSourceIds: readonly DataSourceId[];
  readonly options: FactoryOptions;
  /**
   * 同じworkspaceに保存済みの再利用候補Tool（`buildExistingToolCatalog` の結果）。
   * 取得はuse case側の責務で、ロールは値として受け取るだけ（repositoryを触らない）。
   */
  readonly existingTools?: ExistingToolCatalog;
  /**
   * このデータで使えるツールテンプレート（v43 / ADR-0049）の `id` と要約（目標の言語）。
   * 取得と適用判定は use case 側の責務で、ロールは値として受け取るだけ（カタログを触らない）。
   * 渡されたときだけ「テンプレートで作れる形の Tool を優先する」規則を足す（計画の形は変えない）。
   */
  readonly templates?: readonly { readonly id: string; readonly summary: string }[];
  /** 既存Agent強化モードでのみ設定する。未設定なら従来どおり0→1生成の計画を立てさせる。 */
  readonly currentAgent?: PlannerCurrentAgent;
  /** revise応答時のみ設定する。人間のフィードバックもuntrusted dataとして扱う。 */
  readonly feedback?: string;
}

export class PlannerRole {
  constructor(private readonly model: ModelProviderPort, private readonly prompts: PromptCatalogPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  async propose(input: PlannerRoleInput, signal?: AbortSignal): Promise<FactoryPlan> {
    if (!this.available()) throw new FactoryValidationError('PlannerRole: model does not support structured output');
    const prompt = this.prompts.get(PLANNER_PROMPT.id);
    // 規則の由来: ADR-0047（粒度混在の期間列・行数溢れ・値を知らない引数・結合）/ ADR-0050（擬似ユーザーの
    // 人物像とデータに根拠のあるシナリオ）/ ADR-0049（テンプレートで組める形を優先する）。文は prompts/ 側。
    const system = [
      prompt.render('system', {
        maxTools: MAX_TOOLS,
        maxSkills: MAX_SKILLS,
        maxPersonas: input.options.personaCount,
        maxScenarios: input.options.scenarioCount,
        maxAdditionalDataSources: MAX_ADDITIONAL_DATA_SOURCES,
      }),
      ...(input.templates === undefined || input.templates.length === 0 ? [] : [prompt.render('rules.templates')]),
      ...(input.currentAgent === undefined ? [] : [prompt.render('rules.enhancement')]),
      prompt.render('closing'),
    ].join('\n');
    const catalog = input.existingTools;
    const payload = {
      goal: input.goal,
      dataSourceIds: input.dataSourceIds,
      profiles: input.profiles.map((profile) => ({
        dataSourceId: profile.dataSourceId,
        name: profile.name,
        columns: profile.columns,
        rowCount: profile.rowCount,
        periodColumns: profile.periodColumns ?? [],
        categoricalColumns: profile.categoricalColumns ?? [],
        sampleRows: profile.sampleRows.slice(0, PROMPT_SAMPLE_ROWS),
      })),
      // 結合候補はRun全体で1つの一覧（どのプロファイルも同じ内容を持つ）。1回だけ載せる。
      joinCandidates: input.profiles[0]?.joinCandidates ?? [],
      // テンプレートの要約は外部ファイル（利用者が足せる）由来なので、他の材料と同じuntrusted data側へ載せる。
      ...(input.templates === undefined || input.templates.length === 0 ? {} : { toolTemplates: input.templates.map((template) => ({ id: template.id, summary: template.summary })) }),
      // 既存Toolの表示名・説明は利用者が書いた値なので、プロファイル同様untrusted data側へ載せる。
      existingTools: (catalog?.entries ?? []).map((entry) => ({
        internalId: entry.internalId,
        name: entry.toolName,
        displayName: entry.displayName,
        description: entry.description,
        inputs: entry.inputs,
        sideEffect: entry.sideEffect,
      })),
      ...(catalog === undefined || catalog.totalCount <= catalog.entries.length
        ? {}
        : { existingToolsOmitted: catalog.totalCount - catalog.entries.length }),
      // 既存Agentの表示名・システムプロンプト・Tool/Skillの説明は利用者が書いた値なのでuntrusted data側へ載せる。
      ...(input.currentAgent === undefined ? {} : { currentAgent: input.currentAgent }),
      ...(input.feedback === undefined ? {} : { revisionFeedback: input.feedback }),
    };
    const request: ModelCompletionRequest = {
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: wrapUntrusted('factory-planner-input', payload) },
      ],
      responseFormat: { name: 'factory_plan', strict: true, schema: planSchemaFor(input.dataSourceIds) },
    };
    // `checkGrounding` は 1 回目の応答にだけ立てる（ADR-0050 / v44 §4.2）。データの期間外の年を
    // 名指しするシナリオは「柔らかい違反」として理由つきで 1 回だけ出し直させるが、2 回目にも
    // 残っていたら Run は落とさず受理する（検証シナリオの言い回し 1 つで生成を失敗させない）。
    const accept = (content: string | null, checkGrounding: boolean): FactoryPlan => {
      const plan = inferAdditionalDataSources(normalizePlan(repairDataSourceIds(parsePlan(content), input.dataSourceIds), catalog), input.profiles);
      validateFactoryPlan(plan, {
        dataSourceIds: input.dataSourceIds,
        limits: { maxTools: MAX_TOOLS, maxSkills: MAX_SKILLS, maxPersonas: input.options.personaCount, maxScenarios: input.options.scenarioCount },
      });
      if (checkGrounding) {
        const violations = describeScenarioGroundingViolations(plan, input.profiles);
        if (violations.length > 0) throw new FactoryValidationError(violations.join('; '));
      }
      return plan;
    };
    const first = await this.model.complete(request, signal);
    try {
      return accept(first.message.content, true);
    } catch (error) {
      if (!(error instanceof FactoryValidationError)) throw error;
      // 計画の検証落ちで Run ごと失敗させない。何が規則に反したかを添えて 1 回だけ出し直させる
      // （実測: 再利用と結合先を同じ Tool に書いて、計画段階で Run が即失敗した）。2 回目も落ちれば従来どおり投げる。
      const second = await this.model.complete({
        ...request,
        messages: [
          ...request.messages,
          { role: 'assistant', content: first.message.content },
          { role: 'user', content: prompt.render('repair', { reason: error.message }) },
        ],
      }, signal);
      return accept(second.message.content, false);
    }
  }
}

/**
 * 構造化出力のモデルが任意項目を埋めてしまう癖を、意味を変えない範囲で受け流す。
 * - `reuse.internalId` が渡した既存ツールカタログに無い → 再利用指定なし（存在しない Tool は再利用できない）。
 * - 再利用計画に付いた `additionalDataSourceIds` → 落とす（再利用は既存 Tool のグラフをそのまま使うので、結合先は意味を持たない）。
 */
export function normalizePlan(plan: FactoryPlan, catalog: ExistingToolCatalog | undefined): FactoryPlan {
  const known = new Set((catalog?.entries ?? []).map((entry) => entry.internalId));
  return {
    ...plan,
    tools: plan.tools.map((tool) => {
      if (tool.reuse === undefined) return tool;
      if (!known.has(tool.reuse.internalId)) {
        const { reuse: _unknown, ...rest } = tool;
        return rest;
      }
      if (tool.additionalDataSourceIds === undefined) return tool;
      const { additionalDataSourceIds: _ignored, ...rest } = tool;
      return rest;
    }),
  };
}

/** 単位の注記（`現金給与総額【円】` の `【円】`）を外した列名。計画の文章は単位抜きで列を呼ぶことが多い。 */
function bareColumnName(column: string): string {
  return column.replace(/[【（(\[].*$/u, '').trim();
}

/**
 * 計画の文章が別のデータソースの列を名指ししているのに `additionalDataSourceIds` が無い Tool へ、結合先を補う。
 *
 * 実測（e-Stat・12B）: purpose に「現金給与総額と総実労働時間を結合して割る」と書きながら結合先を書き忘れ、
 * 1 ソースの Tool になって、エージェントが給与総額を「円/時間」と答えた。モデルに出し直させるより、
 * 「そのソースにしか無い列名が文章に出ている」という決定的な手掛かりで補うほうが確実である。
 * 補うのは結合候補（joinCandidates）がある相手だけ。再利用計画と、結合先が既に書かれた Tool は触らない。
 */
export function inferAdditionalDataSources(plan: FactoryPlan, profiles: readonly DataProfile[]): FactoryPlan {
  if (profiles.length < 2) return plan;
  const joinable = (left: string, right: string): boolean => (profiles[0]?.joinCandidates ?? []).some((candidate) =>
    (candidate.leftDataSourceId === left && candidate.rightDataSourceId === right)
    || (candidate.leftDataSourceId === right && candidate.rightDataSourceId === left));
  return {
    ...plan,
    tools: plan.tools.map((tool) => {
      if (tool.reuse !== undefined || (tool.additionalDataSourceIds?.length ?? 0) > 0) return tool;
      const own = profiles.find((profile) => profile.dataSourceId === tool.dataSourceId);
      if (own === undefined) return tool;
      const ownColumns = new Set(own.columns.map((column) => column.name));
      const text = [tool.displayName, tool.purpose, tool.argumentSummary].join('\n');
      const mentioned = profiles.filter((profile) => profile.dataSourceId !== tool.dataSourceId
        && joinable(tool.dataSourceId, profile.dataSourceId)
        && profile.columns.some((column) => {
          if (ownColumns.has(column.name)) return false;
          const bare = bareColumnName(column.name);
          return text.includes(column.name) || (bare.length >= MIN_MENTIONED_COLUMN_LENGTH && text.includes(bare));
        }));
      if (mentioned.length === 0) return tool;
      return { ...tool, additionalDataSourceIds: mentioned.slice(0, MAX_ADDITIONAL_DATA_SOURCES).map((profile) => profile.dataSourceId) };
    }),
  };
}

/** 単位を外した列名で照合するときの最短の長さ（「値」「計」のような短い語の偶然の一致を避ける）。 */
const MIN_MENTIONED_COLUMN_LENGTH = 3;

/**
 * `tools[].dataSourceId` を入力の id（と再利用計画用の空文字）だけに縛ったスキーマ。
 * id は UUID で、モデルは長い id を写し間違える（実測: `…4e1a…` を `…4e-1a…` と書いて計画検証で Run ごと落ちた）。
 * 構造化出力の enum にすれば、写し間違い自体が起きない。
 */
export function planSchemaFor(dataSourceIds: readonly string[]): JsonSchemaObject {
  const tools = FACTORY_PLAN_SCHEMA.properties['tools'];
  const items = tools?.items;
  if (tools === undefined || items?.properties === undefined || dataSourceIds.length === 0) return FACTORY_PLAN_SCHEMA;
  return {
    ...FACTORY_PLAN_SCHEMA,
    properties: {
      ...FACTORY_PLAN_SCHEMA.properties,
      tools: {
        ...tools,
        items: {
          ...items,
          properties: {
            ...items.properties,
            dataSourceId: { type: 'string', enum: [...dataSourceIds, ''] },
            // 結合先の id も同じ enum で縛る（写し間違いを構造化出力の段階で起こさせない）。
            // 空文字は入れない: 結合相手は必ず実在のデータソースでなければならない。
            additionalDataSourceIds: { type: 'array', items: { type: 'string', enum: [...dataSourceIds] } },
          },
        },
      },
    },
  };
}

/** 編集距離（挿入・削除・置換）。id の写し間違いの補正にだけ使う小さな実装。 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** これ以下の編集距離なら「同じ id の写し間違い」とみなす（UUID 同士は通常 20 以上離れている）。 */
const MAX_ID_TYPO_DISTANCE = 3;

/**
 * enum を守らないモデル（構造化出力が緩いプロバイダ）への保険。未知の `dataSourceId` は、
 * 入力の id のうち編集距離が MAX_ID_TYPO_DISTANCE 以下で**一意に最も近い**ものへ直す。
 * 近い候補が無い・複数ある場合は触らず、検証が従来どおり「未知のデータソース」として落とす（当て推量で別の表を読ませない）。
 */
export function repairDataSourceIds(plan: FactoryPlan, dataSourceIds: readonly string[]): FactoryPlan {
  const known = new Set<string>(dataSourceIds);
  /** 1つの id を直す（直せなければそのまま返す）。主 id・結合先 id の両方がこの規則を共有する。 */
  const repair = (value: string): string => {
    if (value === '' || known.has(value)) return value;
    const ranked = dataSourceIds.map((id) => ({ id, distance: editDistance(value, id) })).sort((left, right) => left.distance - right.distance);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best === undefined || best.distance > MAX_ID_TYPO_DISTANCE || (runnerUp !== undefined && runnerUp.distance === best.distance)) return value;
    return best.id;
  };
  return {
    ...plan,
    tools: plan.tools.map((tool) => {
      const dataSourceId = typeof tool.dataSourceId === 'string' ? repair(tool.dataSourceId) : tool.dataSourceId;
      // 結合先の id も同じ規則で直す。ここを直さないと、join を計画した瞬間に写し間違いで Run ごと落ちる。
      const additional = Array.isArray(tool.additionalDataSourceIds)
        ? tool.additionalDataSourceIds.map((id) => (typeof id === 'string' ? repair(id) : id))
        : undefined;
      const additionalChanged = additional !== undefined
        && additional.some((id, index) => id !== tool.additionalDataSourceIds?.[index]);
      if (dataSourceId === tool.dataSourceId && !additionalChanged) return tool;
      return {
        ...tool,
        dataSourceId: dataSourceId as typeof tool.dataSourceId,
        ...(additional === undefined ? {} : { additionalDataSourceIds: additional as typeof tool.additionalDataSourceIds }),
      };
    }),
  };
}

function parsePlan(content: string | null): FactoryPlan {
  if (content === null) throw new FactoryValidationError('PlannerRole: model returned empty content');
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new FactoryValidationError(`PlannerRole: invalid JSON: ${String(error)}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FactoryValidationError('PlannerRole: response is not a JSON object');
  const record = value as Record<string, unknown>;
  if (record['agentBrief'] === null || typeof record['agentBrief'] !== 'object') throw new FactoryValidationError('PlannerRole: plan is missing agentBrief');
  if (!Array.isArray(record['tools']) || !Array.isArray(record['skills']) || !Array.isArray(record['personas']) || !Array.isArray(record['scenarios'])) {
    throw new FactoryValidationError('PlannerRole: plan is missing tools/skills/personas/scenarios arrays');
  }
  // strict構造化出力のモデルは「再利用しないツール」にも空のreuse({internalId: ''}等)を埋めがちなので、
  // 実質的に空のreuseは「reuse指定なし」として落とす（検証で実行全体を落とさない）。
  for (const tool of record['tools']) {
    if (tool === null || typeof tool !== 'object') continue;
    const entry = tool as Record<string, unknown>;
    const reuse = entry['reuse'];
    if (reuse === undefined) continue;
    const internalId = (reuse as { internalId?: unknown } | null)?.internalId;
    if (reuse === null || typeof internalId !== 'string' || internalId.trim() === '') delete entry['reuse'];
  }
  return value as FactoryPlan;
}

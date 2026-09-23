/**
 * application層: Agent Factory 改善ループ Analystロール（v33 実装契約 §3 / docs/16-agent-factory.md §3, §5）。
 *
 * 検証結果（メトリクス・Scenario別サマリ）と現行資産の契約（Agent systemPrompt / Skill instructions /
 * Tool contract）を入力に、`Finding[]` + `ImprovementProposal[]` + 総括summaryを提案させる。
 * Scenario別サマリ（感想・トランスクリプト由来の要約）は疑似ユーザー発話・アンケート自由記述に由来する
 * untrusted dataであり、v25 Judgeと同じく system命令から隔離して user message 側（`<untrusted-data>`）へ渡す
 * （他のロール同様、payload全体を隔離する）。
 *
 * `system-prompt-revision` は `sections.role` / `sections.rules` の両方に「差分ではなく完全な置換テキスト」を
 * 必須で書かせる（application側の `ApplyImprovementsUseCase` はAssemblerの決定的合成部分（skillGuide /
 * toolUsageGuide）だけを再合成し、role/rulesはAnalystの出力をそのまま使うため、部分差分を渡されても
 * 元テキストへ復元する手段がない）。
 *
 * 提案の target 参照（agentId / skillId / toolId）は保存前にアプリ側で再検証する（docs/16 §5.3, §8）:
 * 実在しない参照（currentAgent.id と不一致 / currentSkills・currentToolsに無い id）を持つ提案は、Run全体を
 * 失敗させず黙って破棄する（構造自体が壊れている場合は他ロール同様 `FactoryValidationError` を投げる）。
 *
 * 能力追加（`add-tool` / `add-skill`）も提案できる。ただし改善ループの主目的は既存資産の改訂なので、
 * 1イテレーションの追加提案は合計 `MAX_ADDITIVE_PROPOSALS_PER_ITERATION` 件までに決定的に絞る。
 * `add-tool` は `availableDataSources`（任意入力）が渡されている場合のみ有効で、そこに無い
 * `dataSourceId` を指す提案は破棄する（適用側でも解決できず、提案枠を空振りさせるだけのため）。
 */
import type { AgentId } from '../../../domain/agent/ids';
import type { DataSourceId } from '../../../domain/data-source/ids';
import { FactoryValidationError } from '../../../domain/factory/errors';
import type { FactoryAddSkillPlan, FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput, IterationMetrics } from '../../../domain/factory/factory-run';
import type { Finding, ImprovementProposal } from '../../../domain/factory/improvement-proposal';
import type { ToolGraph } from '../../../domain/etl/graph';
import type { SkillId } from '../../../domain/skill/ids';
import type { ToolId } from '../../../domain/tool/ids';
import type { ScenarioId } from '../../../domain/validation/ids';
import type { JsonSchemaObject, JsonSchemaProperty, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import { wrapUntrusted } from './untrusted';

/**
 * この役割がモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/analyst.md` にあり、
 * ここに残るのは「どの節をどの順に使うか」だけ。
 *
 * - `rules.budget`: 1 会話あたりのツール呼び出し上限を渡されたときだけ足す（ADR-0047 round 2 /
 *   Defect C: 「一度に一つ」へ絞る改訂が会話ごと落とした実測への対策）。
 * - `rules.language`: 総括（summary）と所見（findings[].detail）を Run の言語（`goal.language`、無ければ `ja`）で
 *   書かせる（v54 G2: 日本語の画面に英語の総括が出ていた）。どちらも画面にそのまま出る文なので。
 * - `repair.empty-proposals`: 「総括では改訂すると言っているのに proposals が空」というロール失敗を
 *   差し戻すときの文言（`RunFactoryUseCase` が `emptyProposalsFeedback()` 経由で使う）。
 */
export const ANALYST_PROMPT: PromptSpec = {
  id: 'factory/analyst',
  sections: ['system', 'rules.budget', 'rules', 'rules.language', 'closing', 'repair.empty-proposals'],
};

/**
 * 1回のツール呼び出しの要約（Agent Run のトレース由来）。
 *
 * 実測（ADR-0047）では、Analystへ「呼ばれたTool名」しか渡していなかったため、
 * 「引数の書式が違って0行 → それでも数字を答えた」という本当の失敗が見えず、
 * 「Toolを呼んでいない」と誤診してsystem promptを削る提案しか出なかった。
 */
export interface AnalystToolCallSummary {
  /** エージェントが呼んだ関数名（トレースの `tool-call` 名）。 */
  readonly name: string;
  /** 実際に渡した引数（untrusted data 側に載せる）。 */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** 返ってきた終端の行数（トレースの `tool-result` 由来。取れなければ未設定）。 */
  readonly rowCount?: number;
  /** ツールが「該当なし」を明示した場合の要約（トレースが持っていれば）。 */
  readonly noMatch?: Readonly<Record<string, unknown>>;
  /** ツール呼び出しが失敗した場合の理由。 */
  readonly error?: string;
}

export interface AnalystScenarioSummary {
  readonly scenarioId: ScenarioId;
  readonly status: string;
  readonly goalAchieved: boolean | null;
  readonly satisfaction?: number;
  readonly impressions: string;
  readonly toolHitRate?: number;
  /** 期待したTool名（`Scenario.expectedTools`）と実際に呼ばれた名前。名前の食い違いを見分けられるようにする。 */
  readonly expectedTools?: readonly string[];
  readonly calledTools?: readonly string[];
  /** 失敗した段と理由（`ScenarioRun.error`）。`survey` 段だけの失敗は会話自体は成立している。 */
  readonly errorStage?: string;
  readonly errorMessage?: string;
  /** 総合満足度（`q2`）を回収できたか。false なら満足度の欠測であって「満足度が低い」ではない。 */
  readonly surveyCollected: boolean;
  /** この会話で実際に行われたツール呼び出し（引数・行数つき）。 */
  readonly toolCalls?: readonly AnalystToolCallSummary[];
  /**
   * 0行（または該当なし）を返したツール結果の後に、エージェントが数字入りの回答をしたターンがあるか。
   * true は「データに無い数字を作文した」の強い兆候で、プロンプトではなくToolの引数契約を疑うべき合図。
   */
  readonly answeredWithNumbersAfterZeroRows?: boolean;
}

export interface AnalystCurrentSkill {
  readonly id: SkillId;
  readonly instructions: string;
}

export interface AnalystCurrentTool {
  readonly id: ToolId;
  readonly name: string;
  readonly description: string;
}

/**
 * `add-tool` を提案してよいデータソースの一覧（Stage 0 `DataProfile` の要約）。
 *
 * 任意フィールド: 未指定なら `add-tool` は提案させない（存在しない `dataSourceId` を書かせても
 * 適用側でプロファイル解決に失敗して却下されるだけで、提案枠を1つ無駄にするため）。
 */
export interface AnalystDataSourceSummary {
  readonly dataSourceId: DataSourceId;
  readonly name: string;
  readonly format?: string;
  /** 列の要約（`name:type` 形式を想定）。 */
  readonly columns: readonly string[];
}

export interface AnalystRoleInput {
  readonly goal: FactoryGoalInput;
  readonly metrics: IterationMetrics;
  readonly scenarioSummaries: readonly AnalystScenarioSummary[];
  /** `id` は提案の `agentId` 参照整合検証に使う（対象は常にRun内で唯一のAgent）。 */
  readonly currentAgent: { readonly id: AgentId; readonly systemPrompt: string };
  readonly currentSkills: readonly AnalystCurrentSkill[];
  readonly currentTools: readonly AnalystCurrentTool[];
  /**
   * `add-tool` の判断材料。未指定・空なら `add-tool` 提案は生成させず、出てきても破棄する
   * （呼び出し側が渡すようになるまでは `add-skill` と改訂系だけが有効になる）。
   */
  readonly availableDataSources?: readonly AnalystDataSourceSummary[];
  /**
   * 直前の分析が「改訂すると書きながら proposals を1件も返さなかった」場合の差し戻し文言（ADR-0047）。
   * 1イテレーションにつき1回だけ設定して再依頼する。
   */
  readonly feedback?: string;
  /**
   * 前イテレーションからの**悪化**（決定的に算出した一覧）。実測では goalAchievedRate が 0.5→0 へ落ち、
   * 1件が `agent` 段で失敗したイテレーションで、Analystが findings を1件も出さなかった。
   * 「何が悪くなったか」を推測させず、事実として渡す（ADR-0047 round 2）。
   */
  readonly regressions?: readonly string[];
  /**
   * 1回の会話でエージェントが呼べるツールの上限（`MAX_TOOL_CALLS`）。これを知らないと
   * 「対象ごとに1回ずつ呼ぶ」設計（= 比較質問で必ず落ちる）を平気で提案する。
   */
  readonly toolCallBudget?: number;
}

export interface AnalystProposal {
  readonly findings: readonly Finding[];
  readonly proposals: readonly ImprovementProposal[];
  readonly summary: string;
}

const FINDING_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'severity', 'area', 'detail'],
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
    area: { type: 'string' },
    detail: { type: 'string' },
  },
};

const SYSTEM_PROMPT_REVISION_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'agentId', 'sections', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['system-prompt-revision'] },
    agentId: { type: 'string' },
    sections: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'rules'],
      properties: { role: { type: 'string', description: 'Full replacement text for the role section, not a diff.' }, rules: { type: 'string', description: 'Full replacement text for the extra rules section, not a diff.' } },
    },
    rationale: { type: 'string' },
  },
};

const SKILL_INSTRUCTIONS_REVISION_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'skillId', 'instructions', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['skill-instructions-revision'] },
    skillId: { type: 'string' },
    instructions: { type: 'string' },
    activationCondition: { type: 'string' },
    rationale: { type: 'string' },
  },
};

const TOOL_CONTRACT_REVISION_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'toolId', 'agentTool', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['tool-contract-revision'] },
    toolId: { type: 'string' },
    agentTool: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, description: { type: 'string' } },
    },
    rationale: { type: 'string' },
  },
};

const TOOL_GRAPH_REVISION_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'toolId', 'graph', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['tool-graph-revision'] },
    toolId: { type: 'string' },
    graph: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes', 'edges'],
      properties: {
        nodes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'config'], properties: { id: { type: 'string' }, type: { type: 'string' }, config: { type: 'object', additionalProperties: true } } } },
        edges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, toInput: { type: 'number' } } } },
      },
    },
    rationale: { type: 'string' },
  },
};

const ADD_TOOL_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'plan', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['add-tool'] },
    plan: {
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
      },
    },
    rationale: { type: 'string' },
  },
};

const ADD_SKILL_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'plan', 'rationale'],
  properties: {
    kind: { type: 'string', enum: ['add-skill'] },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'displayName', 'responsibility', 'activationCondition', 'instructions', 'toolRefs'],
      properties: {
        key: { type: 'string', description: 'Short machine-safe key for this new skill, unique within this response.' },
        displayName: { type: 'string' },
        responsibility: { type: 'string' },
        activationCondition: { type: 'string' },
        inputDescription: { type: 'string' },
        outputDescription: { type: 'string' },
        instructions: { type: 'string', description: 'Full instructions text of the new skill, written the same way as an existing skill instructions.' },
        toolRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools this skill uses: an id or name taken from currentTools, or the plan.key of an add-tool proposal in this same response.',
        },
      },
    },
    rationale: { type: 'string' },
  },
};

const ANALYST_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'proposals', 'summary'],
  properties: {
    findings: { type: 'array', items: FINDING_SCHEMA },
    proposals: {
      type: 'array',
      items: { anyOf: [SYSTEM_PROMPT_REVISION_SCHEMA, SKILL_INSTRUCTIONS_REVISION_SCHEMA, TOOL_CONTRACT_REVISION_SCHEMA, TOOL_GRAPH_REVISION_SCHEMA, ADD_TOOL_SCHEMA, ADD_SKILL_SCHEMA] },
    },
    summary: { type: 'string' },
  },
};

/**
 * 1イテレーションで受け付ける「能力追加」提案（`add-tool` + `add-skill`）の合計上限。
 *
 * `maxProposalsPerIteration`（既定4）は提案全体の上限で、そこに追加提案が並ぶと改訂（既存資産を
 * 直す方）の枠を食い潰す。改善ループの主目的は既存資産の改訂であり、追加はあくまで穴埋めなので、
 * 追加系だけ別枠で絞る。超過分はプロンプトでも禁じた上で、ここでも決定的に破棄する。
 */
export const MAX_ADDITIVE_PROPOSALS_PER_ITERATION = 2;

/** 総括を書かせる言語の名前（モデルへの指示文に埋める）。古い保存データで言語が欠けていても既定の日本語に倒す。 */
function languageName(language: FactoryGoalInput['language'] | undefined): string {
  return language === 'en' ? 'English' : 'Japanese';
}

export class AnalystRole {
  constructor(private readonly model: ModelProviderPort, private readonly prompts: PromptCatalogPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  /**
   * 「総括では改訂すると言っているのに proposals が空」というロール失敗を差し戻すときの文言。
   * `RunFactoryUseCase` がこれで再依頼し、テストも同じ節を読む（文面の二重管理を避ける）。
   */
  emptyProposalsFeedback(): string {
    return this.prompts.get(ANALYST_PROMPT.id).render('repair.empty-proposals');
  }

  async propose(input: AnalystRoleInput, signal?: AbortSignal): Promise<AnalystProposal> {
    if (!this.available()) throw new FactoryValidationError('AnalystRole: model does not support structured output');
    const prompt = this.prompts.get(ANALYST_PROMPT.id);
    const system = [
      prompt.render('system'),
      ...(input.toolCallBudget === undefined ? [] : [prompt.render('rules.budget', { toolCallBudget: input.toolCallBudget })]),
      prompt.render('rules', { maxAdditiveProposals: MAX_ADDITIVE_PROPOSALS_PER_ITERATION }),
      prompt.render('rules.language', { languageName: languageName(input.goal.language) }),
      prompt.render('closing'),
    ].join('\n');
    const payload = {
      goal: input.goal,
      metrics: input.metrics,
      scenarioSummaries: input.scenarioSummaries,
      currentAgent: input.currentAgent,
      currentSkills: input.currentSkills,
      currentTools: input.currentTools,
      ...(input.availableDataSources === undefined ? {} : { availableDataSources: input.availableDataSources }),
      ...(input.regressions === undefined || input.regressions.length === 0 ? {} : { regressions: input.regressions }),
      ...(input.toolCallBudget === undefined ? {} : { toolCallBudget: input.toolCallBudget }),
      ...(input.feedback === undefined ? {} : { feedbackOnYourPreviousResponse: input.feedback }),
    };
    const completion = await this.model.complete({
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: wrapUntrusted('factory-analyst-input', payload) },
      ],
      responseFormat: { name: 'factory_analyst_proposal', strict: true, schema: ANALYST_SCHEMA },
    }, signal);
    const parsed = parseAnalystOutput(completion.message.content);

    const targets: ProposalTargets = {
      agentId: input.currentAgent.id,
      skillIds: new Set(input.currentSkills.map((skill) => skill.id)),
      // add-skill の toolRefs は internalId でも Tool契約名でも書けるため、両方を受理集合に入れる。
      toolIds: new Set(input.currentTools.map((tool) => tool.id)),
      toolNames: new Set(input.currentTools.map((tool) => tool.name)),
      dataSourceIds: new Set((input.availableDataSources ?? []).map((source) => source.dataSourceId)),
      // 同一レスポンス内の add-tool が払い出す計画キー（add-skill から前方参照できる）。
      addedToolKeys: new Set(parsed.proposals.filter((proposal) => proposal.kind === 'add-tool').map((proposal) => proposal.plan.key)),
    };
    const proposals = limitAdditiveProposals(parsed.proposals.filter((proposal) => isValidTarget(proposal, targets)));

    return { findings: parsed.findings, proposals, summary: parsed.summary };
  }
}

interface ProposalTargets {
  readonly agentId: string;
  readonly skillIds: ReadonlySet<string>;
  readonly toolIds: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
  readonly dataSourceIds: ReadonlySet<string>;
  readonly addedToolKeys: ReadonlySet<string>;
}

function isValidTarget(proposal: ImprovementProposal, targets: ProposalTargets): boolean {
  switch (proposal.kind) {
    case 'system-prompt-revision':
      return proposal.agentId === targets.agentId;
    case 'skill-instructions-revision':
      return targets.skillIds.has(proposal.skillId);
    case 'tool-contract-revision':
      return targets.toolIds.has(proposal.toolId);
    case 'tool-graph-revision':
      return targets.toolIds.has(proposal.toolId);
    case 'add-tool':
      // 提示していないデータソースを指すTool追加は適用側でも解決できない（提案枠の空振りを避ける）。
      return targets.dataSourceIds.has(proposal.plan.dataSourceId);
    case 'add-skill':
      return proposal.plan.toolRefs.every((ref) => targets.toolIds.has(ref) || targets.toolNames.has(ref) || targets.addedToolKeys.has(ref));
  }
}

/** 能力追加（add-tool / add-skill）の合計件数を上限で切る。改訂系はそのまま通す。 */
function limitAdditiveProposals(proposals: readonly ImprovementProposal[]): ImprovementProposal[] {
  let additive = 0;
  return proposals.filter((proposal) => {
    if (proposal.kind !== 'add-tool' && proposal.kind !== 'add-skill') return true;
    additive += 1;
    return additive <= MAX_ADDITIVE_PROPOSALS_PER_ITERATION;
  });
}

function parseAnalystOutput(content: string | null): { findings: Finding[]; proposals: ImprovementProposal[]; summary: string } {
  if (content === null) throw new FactoryValidationError('AnalystRole: model returned empty content');
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new FactoryValidationError(`AnalystRole: invalid JSON: ${String(error)}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FactoryValidationError('AnalystRole: response is not a JSON object');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['findings'])) throw new FactoryValidationError('AnalystRole: response is missing findings array');
  if (!Array.isArray(record['proposals'])) throw new FactoryValidationError('AnalystRole: response is missing proposals array');
  if (typeof record['summary'] !== 'string') throw new FactoryValidationError('AnalystRole: response is missing string summary');
  const findings = record['findings'].map((item, index) => parseFinding(item, index));
  const proposals = record['proposals'].map((item, index) => parseProposal(item, index));
  return { findings, proposals, summary: record['summary'] };
}

function parseFinding(raw: unknown, index: number): Finding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FactoryValidationError(`AnalystRole: findings.${index} is not an object`);
  const record = raw as Record<string, unknown>;
  if (typeof record['id'] !== 'string') throw new FactoryValidationError(`AnalystRole: findings.${index}.id must be a string`);
  if (record['severity'] !== 'info' && record['severity'] !== 'warning' && record['severity'] !== 'critical') {
    throw new FactoryValidationError(`AnalystRole: findings.${index}.severity is invalid: ${String(record['severity'])}`);
  }
  if (typeof record['area'] !== 'string') throw new FactoryValidationError(`AnalystRole: findings.${index}.area must be a string`);
  if (typeof record['detail'] !== 'string') throw new FactoryValidationError(`AnalystRole: findings.${index}.detail must be a string`);
  return { id: record['id'], severity: record['severity'], area: record['area'], detail: record['detail'] };
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FactoryValidationError(`AnalystRole: ${label} is not an object`);
  return raw as Record<string, unknown>;
}

function parseProposal(raw: unknown, index: number): ImprovementProposal {
  const record = asRecord(raw, `proposals.${index}`);
  const rationale = record['rationale'];
  if (typeof rationale !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.rationale must be a string`);
  const kind = record['kind'];

  switch (kind) {
    case 'system-prompt-revision': {
      if (typeof record['agentId'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.agentId must be a string`);
      const sections = asRecord(record['sections'], `proposals.${index}.sections`);
      if (typeof sections['role'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.sections.role must be a string`);
      if (typeof sections['rules'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.sections.rules must be a string`);
      return { kind: 'system-prompt-revision', agentId: record['agentId'], sections: { role: sections['role'], rules: sections['rules'] }, rationale };
    }
    case 'skill-instructions-revision': {
      if (typeof record['skillId'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.skillId must be a string`);
      if (typeof record['instructions'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.instructions must be a string`);
      const activationCondition = record['activationCondition'];
      if (activationCondition !== undefined && typeof activationCondition !== 'string') {
        throw new FactoryValidationError(`AnalystRole: proposals.${index}.activationCondition must be a string`);
      }
      return {
        kind: 'skill-instructions-revision',
        skillId: record['skillId'],
        instructions: record['instructions'],
        ...(activationCondition !== undefined ? { activationCondition } : {}),
        rationale,
      };
    }
    case 'tool-contract-revision': {
      if (typeof record['toolId'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.toolId must be a string`);
      const agentTool = asRecord(record['agentTool'], `proposals.${index}.agentTool`);
      const name = agentTool['name'];
      const description = agentTool['description'];
      if (name !== undefined && typeof name !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.agentTool.name must be a string`);
      if (description !== undefined && typeof description !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.agentTool.description must be a string`);
      return {
        kind: 'tool-contract-revision',
        toolId: record['toolId'],
        agentTool: { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) },
        rationale,
      };
    }
    case 'tool-graph-revision': {
      if (typeof record['toolId'] !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.toolId must be a string`);
      const graph = asRecord(record['graph'], `proposals.${index}.graph`);
      if (!Array.isArray(graph['nodes']) || !Array.isArray(graph['edges'])) {
        throw new FactoryValidationError(`AnalystRole: proposals.${index}.graph is missing nodes/edges arrays`);
      }
      return { kind: 'tool-graph-revision', toolId: record['toolId'], graph: graph as unknown as ToolGraph, rationale };
    }
    case 'add-tool': {
      const plan = asRecord(record['plan'], `proposals.${index}.plan`);
      if (typeof plan['key'] !== 'string' || typeof plan['displayName'] !== 'string' || typeof plan['purpose'] !== 'string' || typeof plan['dataSourceId'] !== 'string') {
        throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan is missing required string fields`);
      }
      if (plan['sideEffect'] !== 'read-only' && plan['sideEffect'] !== 'session-write') {
        throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan.sideEffect must be 'read-only' or 'session-write'`);
      }
      return { kind: 'add-tool', plan: plan as unknown as FactoryToolPlan, rationale };
    }
    case 'add-skill': {
      const plan = asRecord(record['plan'], `proposals.${index}.plan`);
      const text = (field: string): string => {
        const value = plan[field];
        if (typeof value !== 'string' || value.trim() === '') {
          throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan.${field} must be a non-empty string`);
        }
        return value;
      };
      const toolRefs = plan['toolRefs'];
      if (!Array.isArray(toolRefs) || toolRefs.some((ref) => typeof ref !== 'string')) {
        throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan.toolRefs must be an array of strings`);
      }
      const inputDescription = plan['inputDescription'];
      const outputDescription = plan['outputDescription'];
      if (inputDescription !== undefined && typeof inputDescription !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan.inputDescription must be a string`);
      if (outputDescription !== undefined && typeof outputDescription !== 'string') throw new FactoryValidationError(`AnalystRole: proposals.${index}.plan.outputDescription must be a string`);
      const addSkillPlan: FactoryAddSkillPlan = {
        key: text('key'),
        displayName: text('displayName'),
        responsibility: text('responsibility'),
        activationCondition: text('activationCondition'),
        instructions: text('instructions'),
        ...(inputDescription === undefined ? {} : { inputDescription }),
        ...(outputDescription === undefined ? {} : { outputDescription }),
        toolRefs: toolRefs as string[],
      };
      return { kind: 'add-skill', plan: addSkillPlan, rationale };
    }
    default:
      throw new FactoryValidationError(`AnalystRole: proposals.${index}.kind is invalid: ${String(kind)}`);
  }
}

/**
 * application層: Agent Factory Stage 4 Assemblerロール（v33 実装契約 §3 / docs/16-agent-factory.md §3, §4 Stage 4）。
 *
 * 役割文（role）と追加実行規則（rules）のみを起草する。Skillガイド・Tool使用ガイド・協働者ガイドは
 * `GenerateAgentPromptUseCase` の決定的合成で作られたものをそのまま使い、本ロールが上書き生成しては
 * ならない（出所が機械的に追跡できる部分を保つ、docs/16 §4 Stage 4）。goal はオペレータの自由記述
 * （targetUsers/constraintsを含む）であり、v25 Judgeと同じくuntrusted dataとしてsystem命令から隔離する。
 *
 * 既存Agent強化モードで `promptStrategy: 'rewrite'` を選んだ場合は `currentPrompt`（既存Agentの
 * systemPrompt全文）を添えて呼ばれ、「0→1の起草」ではなく「既存プロンプトの改訂」として振る舞う。
 */
import { FactoryValidationError } from '../../../domain/factory/errors';
import type { FactoryAgentBrief } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { JsonSchemaObject, ModelProviderPort } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import { wrapUntrusted } from './untrusted';

/**
 * この役割がモデルへ送る文（v48 / ADR-0052）。文は `prompts/factory/assembler.md` にあり、
 * ここに残るのは「どの節をどの順に使うか」だけ。
 *
 * - `task.draft` / `task.revise` と `closing.draft` / `closing.revise`: 既存プロンプトの改訂かで
 *   入れ替わる 1〜2 行（改訂では untrusted data の一覧に既存プロンプトが加わる）。
 * - `rules.budget`: 1 会話あたりのツール呼び出し上限を渡されたときだけ足す（ADR-0047）。
 * - `rules.revise`: 全面的な作り替えを禁じ、既存の意図・業務ルール・語調を引き継がせる規則。
 */
export const ASSEMBLER_PROMPT: PromptSpec = {
  id: 'factory/assembler',
  sections: ['system', 'task.draft', 'task.revise', 'rules', 'rules.budget', 'rules.revise', 'closing.draft', 'closing.revise', 'closing'],
};

const ASSEMBLER_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'rules'],
  properties: {
    role: { type: 'string' },
    rules: { type: 'string' },
  },
};

export interface AssemblerRoleInput {
  readonly goal: FactoryGoalInput;
  readonly agentBrief: FactoryAgentBrief;
  readonly skillGuide: string;
  readonly toolUsageGuide: string;
  /**
   * 既存Agent強化モードで `promptStrategy: 'rewrite'` を選んだときの、改訂対象の systemPrompt 全文。
   * 指定すると「0→1の起草」ではなく「既存プロンプトの改訂」として振る舞う（既存の意図・業務ルール・
   * 語調を引き継ぐ規則が加わる）。利用者が書いた本文なので goal と同じく untrusted data として
   * `<untrusted-data>` の中（payload側）へ入れ、system命令からは隔離する。
   */
  readonly currentPrompt?: string;
  /**
   * 1回の会話でエージェントが呼べるツールの上限（`MAX_TOOL_CALLS`）。実測では「対象ごとに1回ずつ
   * ツールを呼ぶ」書き方が上限に当たって会話ごと失敗したため、規則を書く側へ数字を渡す（ADR-0047）。
   */
  readonly toolCallBudget?: number;
}

export interface AssemblerProposal {
  readonly role: string;
  readonly rules: string;
}

export class AssemblerRole {
  constructor(private readonly model: ModelProviderPort, private readonly prompts: PromptCatalogPort) {}

  available(): boolean {
    return this.model.capabilities().includes('structured-output');
  }

  async propose(input: AssemblerRoleInput, signal?: AbortSignal): Promise<AssemblerProposal> {
    if (!this.available()) throw new FactoryValidationError('AssemblerRole: model does not support structured output');
    const revising = input.currentPrompt !== undefined;
    const prompt = this.prompts.get(ASSEMBLER_PROMPT.id);
    const system = [
      prompt.render('system'),
      revising ? prompt.render('task.revise') : prompt.render('task.draft'),
      prompt.render('rules'),
      ...(input.toolCallBudget === undefined ? [] : [prompt.render('rules.budget', { toolCallBudget: input.toolCallBudget })]),
      // 既存プロンプトの改訂であることを明示する（全面的な作り替えは利用者の資産を壊すため禁止する）。
      ...(revising ? [prompt.render('rules.revise')] : []),
      revising ? prompt.render('closing.revise') : prompt.render('closing.draft'),
      prompt.render('closing'),
    ].join('\n');
    const payload = {
      goal: input.goal, agentBrief: input.agentBrief, skillGuide: input.skillGuide, toolUsageGuide: input.toolUsageGuide,
      ...(input.toolCallBudget === undefined ? {} : { toolCallBudget: input.toolCallBudget }),
      ...(input.currentPrompt === undefined ? {} : { currentPrompt: input.currentPrompt }),
    };
    const completion = await this.model.complete({
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: wrapUntrusted('factory-assembler-input', payload) },
      ],
      responseFormat: { name: 'factory_assembler_proposal', strict: true, schema: ASSEMBLER_SCHEMA },
    }, signal);
    return parseProposal(completion.message.content);
  }
}

function parseProposal(content: string | null): AssemblerProposal {
  if (content === null) throw new FactoryValidationError('AssemblerRole: model returned empty content');
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new FactoryValidationError(`AssemblerRole: invalid JSON: ${String(error)}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FactoryValidationError('AssemblerRole: response is not a JSON object');
  const record = value as Record<string, unknown>;
  if (typeof record['role'] !== 'string' || typeof record['rules'] !== 'string') throw new FactoryValidationError('AssemblerRole: response must have string role/rules');
  return { role: record['role'], rules: record['rules'] };
}

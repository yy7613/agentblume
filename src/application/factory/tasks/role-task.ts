/**
 * application層: Agent Factory の「小さな目的別タスク」ランナー（v42 実装契約 §4）。
 *
 * 1 タスク 1 目的・入力は必要な分だけ・出力は小さな構造化 JSON、という規律を 1 か所に閉じ込める。
 * 既存ロール（Planner / ToolSmith）と同じく温度 0・`responseFormat.strict: true` の 1 回呼び出しで、
 * 材料（プロファイル由来の列名・値・目標文）は `wrapUntrusted` で user message 側へ隔離する。
 *
 * `parse` が落ちたときは、**前回の応答と違反文言を添えて 1 回だけ**やり直す（12B 級のモデルは、
 * 何が駄目だったかを具体的に言えば直せることが多い。2 回目も落ちれば諦めて呼び出し側の差し戻しへ渡す）。
 */
import { FactoryValidationError } from '../../../domain/factory/errors';
import type { JsonSchemaObject, ModelCompletionRequest, ModelProviderPort, ModelRequestMessage } from '../../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../../prompt/prompt-catalog-port';
import { wrapUntrusted } from '../roles/untrusted';
import type { ToolSpecTaskName } from '../../../domain/factory/tool-spec';

/**
 * テンプレート経路（v43 §4）のタスク名。
 *
 * v42 の `ToolSpecTaskName` は `ToolSpec` の語彙に属する名前（どの決定をやり直すか）なので、
 * テンプレート経路の 2 つのタスクをそこへ足すと domain の型の意味が変わる。ランナーが受け付ける
 * 名前の集合だけをここで広げる（`ToolSpecTaskName` は部分集合のままなので、既存の呼び出しは無変更）。
 */
export type TemplateTaskName = 'select-template' | 'fill-slots';

/** `runRoleTask` が回せるタスクの名前（v42 の設計タスク + v43 のテンプレートタスク）。 */
export type RoleTaskName = ToolSpecTaskName | TemplateTaskName;

/** `parse` の結果。違反は「モデルがそのまま直せる英文」の配列で返す。 */
export type RoleTaskParseResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface RoleTask<Input, Output> {
  readonly name: RoleTaskName;
  /** 1 文の目的（system プロンプトの先頭に入る）。 */
  readonly goal: string;
  /** 規則（短い箇条書き。5〜8 行まで）。 */
  readonly rules: readonly string[];
  /** 入力ごとに enum を埋めた厳格スキーマ。 */
  schema(input: Input): JsonSchemaObject;
  /** untrusted data として渡す最小の材料（プロファイル全体は渡さない）。 */
  payload(input: Input): unknown;
  /** 構造を検証して Output へ。違反は文言の配列で返す。 */
  parse(content: string | null, input: Input): RoleTaskParseResult<Output>;
}

export interface RoleTaskResult<Output> {
  readonly value: Output;
  /** モデルを呼んだ回数（1 か 2）。 */
  readonly attempts: number;
  /** やり直しで通ったか。 */
  readonly repaired: boolean;
}

export interface RoleTaskOptions {
  /** 差し戻し理由。あれば最初の呼び出しから payload へ `revisionFeedback` として載せる。 */
  readonly feedback?: string;
  readonly signal?: AbortSignal;
  /** モデル呼び出しごとに 1 回呼ばれる（Run の `maxRoleCalls` 会計用）。 */
  readonly onCall?: () => void;
}

/**
 * 全タスク共通の文（v48 / ADR-0052）。文は `prompts/factory/tasks/common.md` にある。
 *
 * - `rules.header`: 規則の箇条書きを始める 1 行。
 * - `standing`: 締めの規則（Planner / ToolSmith と同じ言い回しを保つ）。untrusted data の扱いと
 *   「JSON だけ返す」は、タスクごとの規則ではなくランナーの責務。
 * - `repair`: 応答が `parse` に落ちたときの差し戻し文（違反はコード側が `- ` 付きの行にして渡す）。
 */
export const ROLE_TASK_COMMON_PROMPT: PromptSpec = {
  id: 'factory/tasks/common',
  sections: ['rules.header', 'standing', 'repair'],
};

/** 構造化出力の schema 名（`-` は使えないプロバイダがあるため `_` にする）。 */
export function roleTaskResponseName(name: RoleTaskName): string {
  return name.replaceAll('-', '_');
}

/** system プロンプト = 目的の 1 文 + 規則の見出し + タスクの規則 + 共通の規則。 */
export function buildRoleTaskSystemPrompt<I, O>(prompts: PromptCatalogPort, task: RoleTask<I, O>): string {
  const common = prompts.get(ROLE_TASK_COMMON_PROMPT.id);
  return [task.goal, common.render('rules.header'), ...task.rules, common.render('standing')].join('\n');
}

/**
 * user message へ載せる材料。`feedback` は payload の `revisionFeedback` として同じ untrusted 側に置く
 * （差し戻し理由も人が書いた文なので、system 命令へは混ぜない）。
 */
export function buildRoleTaskPayload<I, O>(task: RoleTask<I, O>, input: I, feedback: string | undefined): unknown {
  const payload = task.payload(input);
  if (feedback === undefined) return payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), revisionFeedback: feedback };
  }
  return { value: payload, revisionFeedback: feedback };
}

/** やり直しの指示文（前回の応答は assistant メッセージとして別に添える）。 */
export function buildRoleTaskRepairInstruction(prompts: PromptCatalogPort, issues: readonly string[]): string {
  return prompts.get(ROLE_TASK_COMMON_PROMPT.id).render('repair', { issues: issues.map((issue) => `- ${issue}`) });
}

export async function runRoleTask<I, O>(
  model: ModelProviderPort,
  prompts: PromptCatalogPort,
  task: RoleTask<I, O>,
  input: I,
  options: RoleTaskOptions = {},
): Promise<RoleTaskResult<O>> {
  if (!model.capabilities().includes('structured-output')) {
    throw new FactoryValidationError(`${task.name}: model does not support structured output`);
  }
  const request: ModelCompletionRequest = {
    temperature: 0,
    messages: [
      { role: 'system', content: buildRoleTaskSystemPrompt(prompts, task) },
      { role: 'user', content: wrapUntrusted(`factory-task-${task.name}`, buildRoleTaskPayload(task, input, options.feedback)) },
    ],
    responseFormat: { name: roleTaskResponseName(task.name), strict: true, schema: task.schema(input) },
  };

  options.onCall?.();
  const first = await model.complete(request, options.signal);
  const firstParsed = task.parse(first.message.content, input);
  if (firstParsed.ok) return { value: firstParsed.value, attempts: 1, repaired: false };

  const repairMessages: readonly ModelRequestMessage[] = [
    ...request.messages,
    { role: 'assistant', content: first.message.content },
    { role: 'user', content: buildRoleTaskRepairInstruction(prompts, firstParsed.issues) },
  ];
  options.onCall?.();
  const second = await model.complete({ ...request, messages: repairMessages }, options.signal);
  const secondParsed = task.parse(second.message.content, input);
  if (secondParsed.ok) return { value: secondParsed.value, attempts: 2, repaired: true };

  throw new FactoryValidationError(`${task.name}: ${secondParsed.issues.join(' ')}`);
}

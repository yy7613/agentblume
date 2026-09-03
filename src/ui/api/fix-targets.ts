/**
 * ui/api層: Run の失敗（code + message + 失敗箇所）→「直す場所」への遷移先。
 *
 * エラー文言は「次に何をするか」まで書くようになった（error-messages.ts）が、書かれている画面へ
 * 行く手段が無く、利用者は左ナビから探し直していた。ここで失敗の形から遷移先（画面 + 開く対象 +
 * 画面内の区画 / ノード）を決め、RunFailureNotice がボタンにする。判定は React の外で純粋関数に
 * しておき、単体テストで固定する。
 *
 * 判定に使う message は**サーバーの生メッセージ**（英語定型文）を想定する。ローカライズ済み文言を
 * 渡された場合も 'MCP' のような言語非依存の語では判定できるが、英語形の判定は効かない。
 */
import type { OpenTarget } from '../navigation';
import type { ScreenName } from '../screens';
import type { RunFailureToolRefDto } from './types';

export interface FixTarget {
  readonly screen: ScreenName;
  /** 遷移先の画面で開く項目。nodeId / section は「開いたうえで直す場所まで連れて行く」ための任意情報。 */
  readonly open?: OpenTarget;
  /** ボタンの文言。遷移先（ツール名・ノードID）を名指しする。 */
  readonly label: readonly [en: string, ja: string];
}

export interface FailureForFixTargets {
  readonly code: string;
  readonly message: string;
  readonly tool?: RunFailureToolRefDto;
  readonly nodeId?: string;
  readonly agent?: { readonly internalId: string };
}

/** Tool 画面の区画（navigation.tsx の OpenTarget.section と合わせる）。 */
export type ToolSection = 'agent-context' | 'output';
/** Agent 画面の区画。 */
export type AgentSection = 'harness' | 'tools' | 'mcp';

const MODEL_LABEL: FixTarget['label'] = ['Open model settings', 'モデル設定を開く'];
const MCP_LABEL: FixTarget['label'] = ['Open MCP settings', 'MCP設定を開く'];
const AGENT_LABEL: FixTarget['label'] = ['Open agent settings', 'エージェント設定を開く'];

/** 関数名・引数定義（Tool Builder「エージェント向けコンテキスト」区画）で直す形。 */
const AGENT_CONTEXT_SHAPES: readonly RegExp[] = [
  /tool name is not a valid function name/,
  /agentTool\.name must be a valid function name/,
  /tool inputSchema/,
  /tool declares inputSchema/,
  /Agent input binding/,
  /required argument missing/,
  /invalid argument/,
  /unknown argument\(s\)/,
  /invalid operator/,
  /operator (?:binding|argument)/,
];

/** 出力ノード・出力スキーマ（Tool Builder「出力」区画）で直す形。 */
const OUTPUT_SHAPES: readonly RegExp[] = [
  /tool output/,
  /agent-output exceeds maxBytes/,
  /declared output schema/,
  /workspace output requires sideEffect/,
];

/** ツール定義そのものが原因の形（上の2区画 + フィルタの引数参照）。 */
const TOOL_DEFINITION_SHAPES: readonly RegExp[] = [...AGENT_CONTEXT_SHAPES, ...OUTPUT_SHAPES, /filter node '.+' references/];

/** モデル設定が原因の形（modelMessage の対象と、能力不足・未設定・診断の model 検査）。 */
const MODEL_SHAPES: readonly RegExp[] = [
  /configured model provider does not support/,
  /model is not configured/i,
  /model settings/i,
];

/** エージェントのハーネス設定（上限・予算・ツール実行の可否）で直す形。 */
const HARNESS_SHAPES: readonly RegExp[] = [/limit exceeded/, /budget exhausted/, /function invocation is disabled/];
/** エージェントの「ツール」区画（接続ツール・スキル・関数名）で直す形。 */
const TOOLS_SHAPES: readonly RegExp[] = [/model requested unknown tool/, /referenced (?:tool|skill) not found/, /ambiguous tool versions/, /duplicate function name/];
/** エージェント定義が原因の形（区画を特定できないものも含む）。 */
const AGENT_SHAPES: readonly RegExp[] = [...HARNESS_SHAPES, ...TOOLS_SHAPES, /referenced .+ not found/, /sub-agent/];

function matchesAny(message: string, shapes: readonly RegExp[]): boolean {
  return shapes.some((shape) => shape.test(message));
}

function toolSectionFor(input: FailureForFixTargets): ToolSection | undefined {
  if (matchesAny(input.message, OUTPUT_SHAPES)) return 'output';
  // TOOL_ARGUMENTS は引数定義（説明・型・演算子）の問題なので、形が未知でも区画は決まる。
  if (input.code === 'TOOL_ARGUMENTS' || matchesAny(input.message, AGENT_CONTEXT_SHAPES)) return 'agent-context';
  return undefined;
}

function agentSectionFor(message: string): AgentSection | undefined {
  // MCP 絡みの失敗は、エージェント側では MCP サーバー一覧の区画が直す場所。
  if (message.includes('MCP')) return 'mcp';
  if (matchesAny(message, HARNESS_SHAPES)) return 'harness';
  if (matchesAny(message, TOOLS_SHAPES)) return 'tools';
  return undefined;
}

function toolLabel(name: string, nodeId: string | undefined): FixTarget['label'] {
  return nodeId === undefined
    ? [`Open tool "${name}"`, `ツール「${name}」を開いて直す`]
    : [`Open node "${nodeId}" in tool "${name}"`, `ツール「${name}」のノード「${nodeId}」を開いて直す`];
}

/**
 * 失敗から遷移先を決める。より具体的な遷移先（失敗したツールのノード）を先頭にし、同じ画面は1つに畳む。
 * 何も当たらなければ空配列（通知はボタン無しで文言だけを出す）。
 */
export function fixTargetsForFailure(input: FailureForFixTargets): readonly FixTarget[] {
  const targets: FixTarget[] = [];
  const add = (target: FixTarget): void => {
    if (!targets.some((existing) => existing.screen === target.screen)) targets.push(target);
  };

  const toolTarget = (): FixTarget | undefined => {
    if (input.tool === undefined) return undefined;
    const section = toolSectionFor(input);
    return {
      screen: 'Tool',
      open: {
        internalId: input.tool.internalId,
        ...(input.tool.version === undefined ? {} : { version: input.tool.version }),
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        ...(section === undefined ? {} : { section }),
      },
      label: toolLabel(input.tool.publishName ?? input.tool.internalId, input.nodeId),
    };
  };
  const agentTarget = (): FixTarget => {
    const section = agentSectionFor(input.message);
    return {
      screen: 'Agent',
      ...(input.agent === undefined ? {} : { open: { internalId: input.agent.internalId, ...(section === undefined ? {} : { section }) } }),
      label: AGENT_LABEL,
    };
  };

  // 1. 失敗したツールが分かっているなら、それ（と失敗ノード）を開くのが最短。
  const knownTool = toolTarget();
  if (knownTool !== undefined) add(knownTool);

  // 2. ツール定義由来（ETL_* / TOOL_ARGUMENTS / 定義不整合の定型文）。ツールが不明ならエージェント側から辿る。
  if (input.code.startsWith('ETL_') || input.code === 'TOOL_ARGUMENTS' || matchesAny(input.message, TOOL_DEFINITION_SHAPES)) {
    add(knownTool ?? agentTarget());
  }

  // 3. モデル設定。
  if (input.code === 'MODEL_PROVIDER' || input.code === 'JUDGE_PROVIDER' || matchesAny(input.message, MODEL_SHAPES)) {
    add({ screen: 'Settings', label: MODEL_LABEL });
  }

  // 4. MCP サーバー（登録・有効化・接続）。
  if (input.message.includes('MCP')) add({ screen: 'MCP', label: MCP_LABEL });

  // 5. エージェント定義（接続ツール・サブエージェント・ハーネス上限）。
  if (matchesAny(input.message, AGENT_SHAPES)) add(agentTarget());

  return targets;
}

/**
 * アプリ層: Tool 単体のプリフライト診断。
 *
 * 「作った Tool がエージェントから呼び出せない」とき、原因は function 定義・スキーマ不整合・
 * データソース欠落・ノード実行エラーなど複数の段階に分かれて潜むが、実行時には**最初に踏んだ1つ**
 * が Run 失敗の1行になって返るだけで全体像が見えない。ここでは実行経路と同じ関数
 * （`toolToModelDefinition` / `agentInputInconsistency` / `propagateSchemas` / `preview` /
 * `schemaIncompatibility` / `operatorArgumentSummaries`）で各段階を**個別に**検査し、
 * どの段階で何が壊れているかの一覧を返す。検証ロジックは実行側と共有し、二重実装を作らない
 * — 診断が ok の項目は、実行時にも同じ理由では落ちない。
 *
 * 入力はメモリ上の `Tool` で、保存済みである必要はない（Tool エディタの未保存 draft も同じ
 * 検査を受ける）。Agent 単位の診断（diagnose-agent-tools.ts）は参照解決だけを担い、
 * Tool 単位の検査はここへ委譲する。
 *
 * 検査は静的（モデル呼び出しなし・副作用なし）。engine.preview は設計時サンプル値での
 * ドライランで、sink の副作用は application 層の dispatcher が担うため発生しない。
 */
import { schemaIncompatibility } from '../../domain/data/schema';
import type { ToolGraph } from '../../domain/etl/graph';
import { listValueArgumentSummaries, operatorArgumentSummaries } from '../../domain/etl/nodes/filter';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { Tool } from '../../domain/tool/tool';
import { agentInputInconsistency, toolToModelDefinition } from '../agent/tool-schema';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { ResolveAiJudgmentsUseCase } from './resolve-ai-judgments';

export type DiagnosticStatus = 'ok' | 'warning' | 'error';

/** Tool単位の検査項目。実行時に対応する失敗地点がある順に並べる。 */
export type ToolCheckId =
  | 'resolved'            // Tool version が存在するか（AgentValidationError: referenced tool not found。Agent 診断だけが出す）
  | 'state'               // 公開状態。archived は Agent に付けるべきでなく（error）、deprecated は今後 archived になり得る（warning）
  | 'function-definition' // LLMへ公開する function definition を組めるか（AgentRunError: invalid function name 等）
  | 'agent-input'         // inputSchema と agent-input ノードの一致（graphWithArguments の実行時検査と同一）
  | 'data-sources'        // データソース参照の解決（DataSourceValidationError）
  | 'graph'               // 解決済みグラフのスキーマ伝播（GraphError / schema issue）
  | 'execution'           // 設計時サンプル値でのドライラン（ノード実行エラー）
  | 'output-schema'       // 宣言 outputSchema と推論終端の整合（assertOutputMatchesSchema と同一規則）
  | 'operator-arguments'  // opBinding の許可リスト・既定演算子・引数宣言の整合
  | 'list-arguments'      // in/notIn の valueBinding 先が「カンマ区切りの値の並び」を運べる string 引数か
  | 'side-effect';        // 非 read-only は承認ゲートで停止する（失敗ではないので warning）

export interface DiagnosticCheck<Id extends string = string> {
  readonly id: Id;
  readonly status: DiagnosticStatus;
  /** 原因の生メッセージ（実行時エラーと同じ英語文）。ok のときは省略。 */
  readonly detail?: string;
  /**
   * 失敗がグラフ内の特定ノード由来のとき、そのノード id（graph / execution 検査）。
   * UI が該当ノードを強調表示するために使う。特定できないときは省略。
   */
  readonly nodeId?: string;
}

export interface ToolDiagnostics {
  readonly internalId: string;
  readonly version: string;
  /** 参照の出所。skill 経由なら skillId を持つ。単体診断は常に 'direct'。 */
  readonly source: 'direct' | 'skill';
  readonly skillId?: string;
  /** LLMへ公開される function 名（定義を組めた場合のみ）。 */
  readonly functionName?: string;
  readonly status: DiagnosticStatus;
  readonly checks: readonly DiagnosticCheck<ToolCheckId>[];
}

export function worst(statuses: readonly DiagnosticStatus[]): DiagnosticStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

export function ok<Id extends string>(id: Id): DiagnosticCheck<Id> { return { id, status: 'ok' }; }
export function error<Id extends string>(id: Id, detail: string, nodeId?: string): DiagnosticCheck<Id> {
  return { id, status: 'error', detail, ...(nodeId === undefined ? {} : { nodeId }) };
}
export function warning<Id extends string>(id: Id, detail: string): DiagnosticCheck<Id> { return { id, status: 'warning', detail }; }
export function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

/**
 * 例外に付いたノード id を防御的に読む。EtlEngine はノードの validateConfig / execute が投げた
 * EtlError に `nodeId` を付けるが、構造違反（GraphError）など付かない経路もあるため、
 * 文字列でなければ「特定できない」として扱う。
 */
export function nodeIdOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const nodeId = (cause as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : undefined;
}

export class DiagnoseToolUseCase {
  constructor(
    private readonly engine: EtlEngine,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
    /** ドライラン（execution 検査）の前に AI 判定を解く。解けなければ execution の error になる。 */
    private readonly resolveAiJudgments?: ResolveAiJudgmentsUseCase,
  ) {}

  async execute(scope: TenantScope, tool: Tool): Promise<ToolDiagnostics> {
    const checks: DiagnosticCheck<ToolCheckId>[] = [];

    checks.push(checkState(tool));

    // LLMへ公開する function definition（名前の形式・引数スキーマ）。
    let functionName: string | undefined;
    try {
      functionName = toolToModelDefinition(tool).name;
      checks.push(ok('function-definition'));
    } catch (cause) {
      checks.push(error('function-definition', messageOf(cause)));
    }

    // 実行時 `graphWithArguments` が投げる2つの検査を、実行せずに同じメッセージで再現する。
    const inconsistency = agentInputInconsistency(tool);
    checks.push(inconsistency === undefined ? ok('agent-input') : error('agent-input', inconsistency));

    // データソース解決 → グラフ検証 → ドライラン → 出力スキーマ整合。
    // 前段が失敗したら後段は検査しない（解決できないグラフは検証も実行もできない）。
    const resolved = await this.checkDataSources(scope, tool, checks);
    if (resolved !== undefined) {
      // ドライラン用のグラフは AI 判定まで解いておく（checkGraph は同期なので、解決はここで済ませる）。
      // 解決自体の失敗（モデル未設定・件数上限）は「実行してみたら落ちる」ことと同義なので、
      // 実行時と同じ nodeId 付きで execution 検査の error として報告する。
      const judged = await this.resolveJudgments(resolved);
      if (judged.ok) this.checkGraph(tool, judged.graph, checks);
      else this.checkGraph(tool, resolved, checks, judged.failure);
    }

    checks.push(...checkOperatorArguments(tool));
    checks.push(...checkListArguments(tool));

    if (tool.sideEffect !== 'read-only') {
      checks.push(warning('side-effect', `side effect '${tool.sideEffect}' pauses the run for approval before this tool executes`));
    }

    return {
      internalId: tool.metadata.internalId,
      version: tool.metadata.version.toString(),
      source: 'direct',
      ...(functionName === undefined ? {} : { functionName }),
      status: worst(checks.map((check) => check.status)),
      checks,
    };
  }

  private async checkDataSources(scope: TenantScope, tool: Tool, checks: DiagnosticCheck<ToolCheckId>[]): Promise<ToolGraph | undefined> {
    if (this.resolveDataSources === undefined) {
      // 実行側も resolver 未配線ならグラフをそのまま流す。診断も同じ前提に立つ。
      checks.push(ok('data-sources'));
      return tool.graph;
    }
    try {
      const resolved = await this.resolveDataSources.execute(scope, tool.graph);
      checks.push(ok('data-sources'));
      return resolved;
    } catch (cause) {
      checks.push(error('data-sources', messageOf(cause)));
      return undefined;
    }
  }

  /**
   * AI 判定を解く。ai-judge ノードが無ければ素通り（モデルも見ない）。
   * 失敗は投げずに返し、execution 検査へ回す（グラフ検査そのものは判定の有無に関わらず行える）。
   */
  private async resolveJudgments(resolved: ToolGraph): Promise<{ readonly ok: true; readonly graph: ToolGraph } | { readonly ok: false; readonly failure: unknown }> {
    if (this.resolveAiJudgments === undefined) return { ok: true, graph: resolved };
    try { return { ok: true, graph: await this.resolveAiJudgments.execute(resolved) }; }
    catch (cause) { return { ok: false, failure: cause }; }
  }

  private checkGraph(tool: Tool, resolved: ToolGraph, checks: DiagnosticCheck<ToolCheckId>[], judgmentFailure?: unknown): void {
    try {
      const propagation = this.engine.propagateSchemas(resolved);
      if (propagation.hasErrors) {
        // トポロジカル順（propagation.order）で最初のエラーノードが根本原因
        // （下流は「上流の config が不正」という派生 issue を持つだけ）。
        // `Object.values(propagation.nodes)` は使わない: JS は整数風のキー（'10' など）を
        // 挿入順ではなく数値昇順で先に並べるため、下流ノードが先頭に来て nodeId が根本原因を外す。
        const failing = propagation.order
          .flatMap((id) => { const node = propagation.nodes[id]; return node === undefined ? [] : [node]; })
          .map((node) => ({ nodeId: node.nodeId, issues: node.issues.filter((issue) => issue.severity === 'error') }))
          .filter((node) => node.issues.length > 0);
        const messages = failing.flatMap((node) => node.issues.map((issue) => `${node.nodeId}: ${issue.message}`)).join('; ');
        checks.push(error('graph', messages, failing[0]?.nodeId));
        return;
      }
      checks.push(ok('graph'));

      // 設計時サンプル値でのドライラン（副作用なし。ノード実行時にしか出ないエラーを拾う）。
      // AI 判定を解けなかったときは preview を試すまでもなく（ai-judge が同じ理由で落ちる）、
      // 解決器の理由をそのまま execution の error にする。
      if (judgmentFailure !== undefined) {
        checks.push(error('execution', messageOf(judgmentFailure), nodeIdOf(judgmentFailure)));
      } else {
        try {
          this.engine.preview(resolved, { rowLimit: 100 });
          checks.push(ok('execution'));
        } catch (cause) {
          checks.push(error('execution', messageOf(cause), nodeIdOf(cause)));
        }
      }

      if (tool.outputSchema !== undefined) {
        const terminalSchema = propagation.nodes[propagation.terminalId]?.schema;
        const incompatibility = terminalSchema === undefined ? undefined : schemaIncompatibility(terminalSchema, tool.outputSchema);
        checks.push(incompatibility === undefined
          ? ok('output-schema')
          : error('output-schema', `declared output schema does not match the graph's inferred output (${incompatibility}) — the run fails after the tool executes; re-save the tool to refresh its output schema`));
      }
    } catch (cause) {
      // GraphError（構造違反）等。伝播自体ができないグラフはドライランも出力整合も検査できない。
      checks.push(error('graph', messageOf(cause), nodeIdOf(cause)));
    }
  }
}

/**
 * 公開状態。参照の存在や実行可否とは独立に「その Tool を Agent に付けてよいか」を伝える。
 * archived は引退済みなので付けるべきでない（error）。deprecated は今は動くが archived に
 * 移る予告なので warning に留める。
 */
function checkState(tool: Tool): DiagnosticCheck<ToolCheckId> {
  switch (tool.metadata.state) {
    case 'archived': return error('state', 'tool is archived, so it should not be attached to an agent');
    case 'deprecated': return warning('state', 'tool is deprecated and may be archived later');
    default: return ok('state');
  }
}

function checkOperatorArguments(tool: Tool): DiagnosticCheck<ToolCheckId>[] {
  const summaries = operatorArgumentSummaries(
    tool.graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config),
  );
  if (summaries.length === 0) return [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const summary of summaries) {
    const column = tool.inputSchema?.columns.find((candidate) => candidate.name === summary.field);
    if (summary.allowed.length === 0) errors.push(`operator argument '${summary.field}' has no operator that every condition allows`);
    if (summary.defaultOpMixed) errors.push(`operator argument '${summary.field}' has conflicting default operators across conditions`);
    if (column === undefined) warnings.push(`operator argument '${summary.field}' is not declared in the input schema, so the binding is inactive at run time`);
    else if (column.type !== 'string') errors.push(`operator argument '${summary.field}' must be declared as a string argument, but it is '${column.type}'`);
  }
  if (errors.length > 0) return [error('operator-arguments', [...errors, ...warnings].join('; '))];
  if (warnings.length > 0) return [warning('operator-arguments', warnings.join('; '))];
  return [ok('operator-arguments')];
}

/**
 * `in`/`notIn` の値引数（valueBinding 先）が、カンマ区切りの値の並びを運べる形で宣言されているか。
 * 保存時（SaveTool）と同じ規則を、実行せずに同じ英文で先に見せる。
 */
function checkListArguments(tool: Tool): DiagnosticCheck<ToolCheckId>[] {
  const sites = listValueArgumentSummaries(
    tool.graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config),
  );
  if (sites.length === 0) return [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const site of sites) {
    const column = tool.inputSchema?.columns.find((candidate) => candidate.name === site.field);
    if (column === undefined) warnings.push(`list argument '${site.field}' is not declared in the input schema, so the binding is inactive at run time`);
    else if (column.type !== 'string') errors.push(`list argument '${site.field}' must be declared as a string argument to carry a comma-separated list, but it is '${column.type}'`);
  }
  if (errors.length > 0) return [error('list-arguments', [...errors, ...warnings].join('; '))];
  if (warnings.length > 0) return [warning('list-arguments', warnings.join('; '))];
  return [ok('list-arguments')];
}

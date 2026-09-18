/**
 * application層: 保存済み Tool を引数付きで単体実行し、期待との合否を返す（ツール検証の中核）。
 *
 * ## Agent 実行との対応
 * 引数の検証（validateToolArguments）・グラフへの束縛（graphWithArguments）・データソース解決・
 * 全行実行（engine.preview）は Agent がツールを呼ぶ経路（run-agent-preview）と**同じ関数**を通す。
 * 「検証では通るのに Agent から呼ぶと落ちる」を作らないための規律で、差し替えてはならない。
 *
 * ## 副作用を起こさない
 * Agent 経路の最後にある ToolOutputDispatcher（セッション成果物の書き込み）は**呼ばない**。
 * engine.preview 内では sink ノード（workspace-output / agent-output 等）は表を通すだけで
 * 外部へ何も書かない（不活性）ので、write ツールも安全に全行で走らせられる。
 *
 * ## 失敗を結果として返す
 * 引数不正（ToolArgumentsError）・inputSchema と agent-input の不整合（AgentRunError）・ノードの
 * 実行エラー（EtlError, nodeId 付き）は HTTP エラーではなく `status: 'error'` の結果にする。
 * この画面の仕事は「実行すると何が起きるか」を見せることだからで、Tool が存在しない
 * （ToolNotFoundError → 404）と想定外の例外（→ 500）だけを投げる。
 *
 * `expectations.outcome: 'error'` の異常系ケースでは、この失敗が**合格**（`status: 'passed'`）になる。
 * `error` は表示のためにそのまま残す（評価は tool-check-result の evaluateFailedRun）。
 */
import { performance } from 'node:perf_hooks';
import type { Table } from '../../domain/data/types';
import { EtlError } from '../../domain/etl/errors';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { JsonCell, ToolCheckExpectations } from '../../domain/tool-check/tool-check-case';
import { AgentRunError } from '../agent/errors';
import { validateToolArguments } from '../agent/tool-schema';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { DEFAULT_ROW_LIMIT, type EtlEngine } from '../etl/engine';
import type { ResolveAiJudgmentsUseCase } from '../tool/resolve-ai-judgments';
import { graphWithArguments } from '../tool/tool-execution';
import { extractJudgments, type ToolCheckJudgmentTable } from './judgments';
import { EMPTY_TABLE, evaluateFailedRun, evaluateSuccessfulRun, type ToolCheckJudgmentSnapshot, type ToolCheckRunError, type ToolCheckRunResult, type ToolCheckToolRef } from './tool-check-result';

export interface RunToolCheckInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  /** 省略時は最新版。 */
  readonly version?: SemVer;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations?: ToolCheckExpectations;
  /** 表示用スナップショットの行数（既定 100、0 で本文なし）。 */
  readonly rowLimit?: number;
}

export interface ToolCheckClock {
  /** 結果の checkedAt に使う実時刻。 */
  readonly now?: () => Date;
  /** 所要時間の計測に使う単調時計（ms）。 */
  readonly monotonicNow?: () => number;
}

export class RunToolCheckUseCase {
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly tools: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
    clock: ToolCheckClock = {},
    /** データソース解決の後・実行の前に AI 判定を解く（Agent 経路と同じ順序）。 */
    private readonly resolveAiJudgments?: ResolveAiJudgmentsUseCase,
  ) {
    this.now = clock.now ?? (() => new Date());
    this.monotonicNow = clock.monotonicNow ?? (() => performance.now());
  }

  /** Tool を解決する（版指定なら固定版、無ければ最新版）。無ければ ToolNotFoundError。 */
  async loadTool(scope: TenantScope, toolId: ToolId, version?: SemVer): Promise<Tool> {
    const tool = version === undefined ? await this.tools.findLatest(scope, toolId) : await this.tools.findVersion(scope, toolId, version);
    if (tool === null) {
      throw new ToolNotFoundError(version === undefined ? `tool not found: ${toolId}` : `tool not found: ${toolId}@${version.toString()}`);
    }
    return tool;
  }

  async execute(input: RunToolCheckInput): Promise<ToolCheckRunResult> {
    const tool = await this.loadTool(input.scope, input.toolId, input.version);
    return this.executeWith(tool, input);
  }

  /** 解決済みの Tool に対して実行する（ケース実行が「版が消えた」を自前で扱うために分けてある）。 */
  async executeWith(tool: Tool, input: Omit<RunToolCheckInput, 'toolId' | 'version'>): Promise<ToolCheckRunResult> {
    const ref: ToolCheckToolRef = { internalId: tool.metadata.internalId, version: tool.metadata.version.toString(), publishName: tool.metadata.publishName };
    const rowLimit = input.rowLimit ?? DEFAULT_ROW_LIMIT;
    const startedAt = this.monotonicNow();
    const elapsed = (): number => Math.max(0, Math.round(this.monotonicNow() - startedAt));
    let output: Table;
    let fullOutput: Table;
    let nodes: ToolCheckRunResult['nodes'];
    let judgments: readonly ToolCheckJudgmentTable[] = [];
    let judgedBy: string | undefined;
    try {
      const row = validateToolArguments(tool.inputSchema, input.arguments);
      const graph = graphWithArguments(tool, row);
      const withSources = this.resolveDataSources === undefined ? graph : await this.resolveDataSources.execute(input.scope, graph);
      const executable = this.resolveAiJudgments === undefined ? withSources : await this.resolveAiJudgments.execute(withSources);
      // sink ノードは preview の中では表を通すだけで外部へ書かない。ここで出力ディスパッチャは呼ばない。
      const preview = this.engine.preview(executable, { rowLimit });
      output = preview.output;
      fullOutput = preview.fullOutput;
      nodes = Object.values(preview.nodes).map((node) => ({ nodeId: node.nodeId, rowCount: node.rowCount }));
      // AI 判定の期待は終端ではなくノードの判定表に対して評価する（keep / exclude で消えた行も見える）。
      judgments = extractJudgments(this.engine, executable);
      if (judgments.length > 0 && this.resolveAiJudgments !== undefined) judgedBy = await this.resolveAiJudgments.describeModel();
    } catch (error) {
      const failure = toRunError(error);
      if (failure === undefined) throw error;
      const { status, assertions } = evaluateFailedRun(input.expectations, failure);
      return { tool: ref, status, assertions, output: EMPTY_TABLE, rowCount: 0, nodes: [], durationMs: elapsed(), error: failure, checkedAt: this.now().toISOString() };
    }
    const durationMs = elapsed();
    const { status, assertions } = evaluateSuccessfulRun(input.expectations, fullOutput, durationMs, judgments);
    const snapshots: ToolCheckJudgmentSnapshot[] = judgments.map((judgment) => ({ nodeId: judgment.nodeId, verdictColumn: judgment.verdictColumn, reasonColumn: judgment.reasonColumn, table: { schema: judgment.table.schema, rows: judgment.table.rows.slice(0, rowLimit) }, rowCount: judgment.table.rows.length }));
    return {
      tool: ref,
      status,
      assertions,
      output,
      rowCount: fullOutput.rows.length,
      nodes,
      ...(snapshots.length === 0 ? {} : { judgments: snapshots }),
      ...(judgedBy === undefined ? {} : { judgedBy }),
      durationMs,
      checkedAt: this.now().toISOString(),
    };
  }
}

/** 「結果として見せる失敗」なら error 情報へ、想定外なら undefined（呼び出し側が投げ直す）。 */
function toRunError(error: unknown): ToolCheckRunError | undefined {
  if (error instanceof AgentRunError) return { code: error.code, message: error.message };
  if (error instanceof EtlError) return { code: error.code, message: error.message, ...(error.nodeId === undefined ? {} : { nodeId: error.nodeId }) };
  return undefined;
}

import type { RunFailureToolRef } from '../../domain/run/run';

export class AgentRunError extends Error {
  readonly code: string = 'AGENT_RUN';

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export class ToolArgumentsError extends AgentRunError {
  override readonly code = 'TOOL_ARGUMENTS';

  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentsError';
  }
}

export class UnsafeToolError extends AgentRunError {
  override readonly code = 'UNSAFE_TOOL';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeToolError';
  }
}

/**
 * 保存済みToolの実行失敗を「どのToolのどのノードで起きたか」と一緒に運ぶラッパー。
 *
 * AgentRunError を継承**しない**: 修復ループ（ToolArgumentsError）や承認待ちの instanceof 判定に
 * 混ざらないようにするため。`code` は元例外の文字列 code（無ければ AGENT_RUN）を写し、
 * message は元例外のまま（利用者向けのローカライズが message の一致に依存している）。
 * HTTP 変換（api/error-mapping）と Run の failure は cause を辿って元の status/code を決める。
 */
export class ToolExecutionError extends Error {
  readonly code: string;
  readonly tool: RunFailureToolRef;
  /** EtlEngine が元例外に付けたノード id（ETL 以外の失敗には無い）。 */
  readonly nodeId?: string;

  constructor(tool: RunFailureToolRef, override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'tool execution failed');
    this.name = 'ToolExecutionError';
    this.code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'AGENT_RUN';
    this.tool = { ...tool };
    const nodeId = cause instanceof Error && 'nodeId' in cause ? cause.nodeId : undefined;
    if (typeof nodeId === 'string') this.nodeId = nodeId;
  }
}

export class RunFailedError extends Error {
  readonly code = 'RUN_FAILED';

  constructor(readonly runId: string, override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'agent run failed');
    this.name = 'RunFailedError';
  }
}

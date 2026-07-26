import type { TenantScope } from '../tool/ids';
import type { SideEffect } from '../tool/metadata';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'waiting-approval';
export type RunMode = 'preview' | 'test';
export type RunPurpose = 'interactive' | 'scenario' | 'evaluation' | 'delegation';

export interface RunNodeOutput {
  readonly nodeId: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}
export type RunTraceEvent =
  | { readonly sequence: number; readonly kind: 'model-request'; readonly step: number; readonly toolNames: readonly string[] }
  | { readonly sequence: number; readonly kind: 'tool-call'; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly sequence: number; readonly kind: 'tool-result'; readonly name: string; readonly terminalId: string; readonly nodes: readonly RunNodeOutput[]; readonly outputPreview: readonly Readonly<Record<string, unknown>>[] }
  | { readonly sequence: number; readonly kind: 'model-response'; readonly content: string }
  | { readonly sequence: number; readonly kind: 'agent_call'; readonly toolName: string; readonly agentRef: { readonly internalId: string; readonly version: string }; readonly childRunId: string; readonly ok: boolean; readonly summary: string }
  /** ランタイムハーネスの自動圧縮が走ったモデル往復（beforeChars → afterChars）。 */
  | { readonly sequence: number; readonly kind: 'compaction'; readonly beforeChars: number; readonly afterChars: number }
  /** toolApproval: 非read-onlyツールの実行前に人間の承認を要求してRunを止めた。 */
  | { readonly sequence: number; readonly kind: 'approval-requested'; readonly tool: string; readonly sideEffect: SideEffect; readonly prompt: string }
  /** toolApproval: 人間が承認/拒否を返してRunを再開した。 */
  | { readonly sequence: number; readonly kind: 'approval-resolved'; readonly decision: 'approve' | 'reject' }
  | { readonly sequence: number; readonly kind: 'error'; readonly code: string; readonly message: string };

// ---------------------------------------------------------------------------
// 承認待ちcheckpoint
//
// domain層はapplication層（ModelRequestMessage など）をimportできないため、再開に必要な
// 会話履歴の構造だけをここで定義する（domain/harness の HarnessConversationMessage と同じ手法）。
// ---------------------------------------------------------------------------

/** マルチモーダル入力の1パーツ。application層の ModelContentPart と相互変換する。 */
export type RunCheckpointContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly imageUrl: string };

/** モデルが発行したツール呼び出し1件。 */
export interface RunCheckpointToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 再開に必要な会話メッセージ1件（assistantのtoolCalls / toolのtoolCallIdを含む）。 */
export interface RunCheckpointMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null | readonly RunCheckpointContentPart[];
  readonly toolCalls?: readonly RunCheckpointToolCall[];
  readonly toolCallId?: string;
}

/** 再開後も同じ上限を消費する、ツリー共有バジェットの残り。 */
export interface RunCheckpointBudget {
  readonly remainingModelRounds: number;
  readonly remainingToolCalls: number;
}

/**
 * `waiting-approval` のRunだけが持つ、再開に必要な永続実行コンテキスト。
 * JSON永続化されるため、プロセスをまたいでも再開できる。
 */
export interface RunApprovalCheckpoint {
  readonly kind: 'tool-approval';
  readonly agentRef: { readonly internalId: string; readonly version: string };
  /** ループ再開に必要な全メッセージ（assistantのtoolCallsを含む）。 */
  readonly messages: readonly RunCheckpointMessage[];
  /** 未実行のツール呼び出し。先頭が承認対象。 */
  readonly pendingCalls: readonly RunCheckpointToolCall[];
  /** ツール呼び出し上限のカウントと結果recordの tools 復元に使う実行済みTool。 */
  readonly executedToolRefs: readonly { readonly internalId: string; readonly version: string; readonly publishName?: string }[];
  readonly budget: RunCheckpointBudget;
  /** 再開時のモデル往復番号。 */
  readonly step: number;
  readonly sessionId?: string;
  /** ISO。作成 + INTERACTIVE_CHECKPOINT_TTL_MS(24h)。 */
  readonly expiresAt: string;
  /** 人間向け: どのツールがなぜ承認要求しているか。 */
  readonly prompt: string;
}

export interface RunUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface RunModelSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly modelConfigHash: string;
}

export interface RunLatencyBreakdown {
  readonly totalMs: number;
  readonly modelMs: number;
  readonly toolMs: number;
}

export interface RunPriceSnapshot {
  readonly currency: 'USD';
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
  readonly effectiveAt: string;
}

export interface RunEstimatedCost {
  readonly kind: 'estimated';
  readonly amount: number;
  readonly currency: 'USD';
  readonly price: RunPriceSnapshot;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
}

export interface RunArtifactRef {
  readonly internalId: string;
  readonly version?: string;
  readonly publishName?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly scope: TenantScope;
  /** Agent Session Workspaceとの対応。旧Runは未指定を許容する。 */
  readonly sessionId?: string;
  readonly status: RunStatus;
  readonly mode: RunMode;
  /** v26追加。旧recordでは未指定を許容しinteractiveとして解釈する。 */
  readonly purpose?: RunPurpose;
  readonly model?: RunModelSnapshot;
  readonly tool?: RunArtifactRef;
  readonly tools?: readonly RunArtifactRef[];
  readonly agent?: RunArtifactRef;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage?: RunUsage;
  readonly latency?: RunLatencyBreakdown;
  readonly estimatedCost?: RunEstimatedCost;
  readonly failure?: RunFailure;
  /** waiting-approval 状態だけで保持する、再開に必要な永続実行コンテキスト。 */
  readonly checkpoint?: RunApprovalCheckpoint;
}

export interface StartRunProps {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly sessionId?: string;
  readonly mode: RunMode;
  readonly purpose?: RunPurpose;
  readonly model?: RunModelSnapshot;
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly agent?: RunRecord['agent'];
  readonly startedAt: string;
}

export function startRun(props: StartRunProps): RunRecord {
  return {
    ...props,
    scope: { ...props.scope },
    ...(props.tool !== undefined ? { tool: { ...props.tool } } : {}),
    ...(props.tools !== undefined ? { tools: props.tools.map((tool) => ({ ...tool })) } : {}),
    ...(props.agent !== undefined ? { agent: { ...props.agent } } : {}),
    ...(props.model !== undefined ? { model: { ...props.model } } : {}),
    status: 'running',
    trace: [],
  };
}

export function succeedRun(record: RunRecord, result: {
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly agent?: RunRecord['agent'];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
  readonly latency?: RunLatencyBreakdown;
  readonly estimatedCost?: RunEstimatedCost;
  readonly completedAt: string;
}): RunRecord {
  assertRunning(record);
  return {
    ...record,
    status: 'succeeded',
    // succeeded/failed は再開点を持たない（checkpointは waiting-approval だけの状態）。
    checkpoint: undefined,
    ...(result.tool !== undefined ? { tool: { ...result.tool } } : {}),
    ...(result.tools !== undefined ? { tools: result.tools.map((tool) => ({ ...tool })) } : {}),
    ...(result.agent !== undefined ? { agent: { ...result.agent } } : {}),
    response: result.response,
    ...(result.structuredResponse !== undefined ? { structuredResponse: structuredClone(result.structuredResponse) } : {}),
    trace: structuredClone(result.trace),
    usage: { ...result.usage },
    ...(result.latency !== undefined ? { latency: { ...result.latency } } : {}),
    ...(result.estimatedCost !== undefined ? { estimatedCost: { ...result.estimatedCost, price: { ...result.estimatedCost.price } } } : {}),
    completedAt: result.completedAt,
  };
}

export function failRun(record: RunRecord, result: {
  readonly trace: readonly RunTraceEvent[];
  readonly failure: RunFailure;
  readonly latency?: RunLatencyBreakdown;
  readonly completedAt: string;
}): RunRecord {
  assertRunning(record);
  return { ...record, status: 'failed', checkpoint: undefined, trace: structuredClone(result.trace), failure: { ...result.failure }, ...(result.latency !== undefined ? { latency: { ...result.latency } } : {}), completedAt: result.completedAt };
}

/**
 * ツール承認待ちでRunを停止する。失敗ではなく永続的な状態遷移として扱い、
 * 再開に必要な checkpoint と、その時点までの trace / usage / latency を保存する。
 */
export function waitRunForApproval(record: RunRecord, checkpoint: RunApprovalCheckpoint, progress?: {
  readonly trace?: readonly RunTraceEvent[];
  readonly usage?: RunUsage;
  readonly latency?: RunLatencyBreakdown;
  readonly response?: string;
}): RunRecord {
  assertRunning(record);
  return {
    ...record,
    status: 'waiting-approval',
    checkpoint: structuredClone(checkpoint),
    ...(progress?.trace !== undefined ? { trace: structuredClone(progress.trace) } : {}),
    ...(progress?.usage !== undefined ? { usage: { ...progress.usage } } : {}),
    ...(progress?.latency !== undefined ? { latency: { ...progress.latency } } : {}),
    ...(progress?.response !== undefined ? { response: progress.response } : {}),
  };
}

/** 承認結果を受け取ってRunを running へ戻す（checkpointは再開時に消費して除去する）。 */
export function resumeRunRecord(record: RunRecord): RunRecord {
  if (record.status !== 'waiting-approval') throw new Error(`run '${record.runId}' is not waiting for approval`);
  return { ...record, status: 'running', checkpoint: undefined };
}

export function redactRun(record: RunRecord, parts: { readonly payload: boolean; readonly trace: boolean }): RunRecord {
  return {
    ...record,
    ...(parts.payload ? {
      response: undefined,
      structuredResponse: undefined,
      // checkpointは会話履歴そのものなのでpayloadとして落とす（保持期限を過ぎたRunは再開しない）。
      checkpoint: undefined,
      ...(record.failure !== undefined ? { failure: { code: record.failure.code, message: '[redacted]' } } : {}),
    } : {}),
    ...(parts.trace ? { trace: [] } : {}),
  };
}

function assertRunning(record: RunRecord): void {
  if (record.status !== 'running') throw new Error(`run '${record.runId}' is already ${record.status}`);
}

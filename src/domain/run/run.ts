import type { AgentId } from '../agent/ids';
import type { NodeId } from '../etl/ids';
import type { SessionId } from '../session/ids';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';
import type { ToolId } from '../tool/ids';
import type { SideEffect } from '../tool/metadata';
import type { RunId, TerminalId, ToolCallId } from './ids';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'waiting-approval';
export type RunMode = 'preview' | 'test';
export type RunPurpose = 'interactive' | 'scenario' | 'evaluation' | 'delegation';

export interface RunNodeOutput {
  readonly nodeId: NodeId;
  readonly rowCount: number;
  readonly truncated: boolean;
}
/** 失敗したツール実行の識別。`publishName` はモデルへ公開した function 名（呼び出し名）。 */
export interface RunFailureToolRef {
  readonly internalId: ToolId;
  readonly version?: string;
  readonly publishName?: string;
}

/**
 * 0 件だった filter 条件 1 つ分の内訳。`value` は JSON で運べる形（日付は ISO 文字列）に寄せる。
 * モデルへ返すツール結果と、この tool-result イベントが**同じ形**を共有する（分析者が見るものと
 * モデルが読んだものを一致させるため）。
 */
export interface RunNoMatchCondition {
  readonly column: string;
  readonly op: string;
  /** この値を供給した Agent Tool の引数名（固定値の条件には無い）。 */
  readonly argument?: string;
  readonly value: string | number | boolean | null;
  /** 複数値条件（in/notIn）で要求した値の並び（上限あり。単値条件には無い）。 */
  readonly values?: readonly (string | number | boolean | null)[];
  /** この条件**だけ**を入力行へ当てたときに残る行数。 */
  readonly matchingRows: number;
  /** 複数値条件（in）で、要求したのに1行も当たらなかった値（どれが外れたかを名指しする）。 */
  readonly unmatchedValues?: readonly string[];
  /** その列に実在する値の例（eq/contains/in の文字列列。要求値に近いものを優先）。 */
  readonly availableValues?: readonly string[];
  readonly distinctValues?: number;
  /** number / date 列の最小・最大（日付は ISO 文字列）。 */
  readonly min?: string | number;
  readonly max?: string | number;
}

/**
 * ツール実行が 0 行になった理由（LLM を使わない決定的な診断）。
 * 空の `[]` だけを返すとモデルは「どの引数が外れたのか」も「どんな値があるのか」も分からず、
 * 記憶から答えを捏造する。どの条件が何行に当たったかと実在する値を添えて差し戻す。
 */
export interface RunNoMatch {
  readonly message: string;
  /** 0 行になったノードの id。 */
  readonly nodeId: NodeId;
  readonly combine: 'and' | 'or';
  readonly conditions: readonly RunNoMatchCondition[];
}

export type RunTraceEvent =
  | { readonly sequence: number; readonly kind: 'model-request'; readonly step: number; readonly toolNames: readonly string[] }
  | { readonly sequence: number; readonly kind: 'tool-call'; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  /** `noMatch` は 0 行だった実行だけが持つ（後から足した任意フィールド。旧 Run には無い）。 */
  | { readonly sequence: number; readonly kind: 'tool-result'; readonly name: string; readonly terminalId: TerminalId; readonly nodes: readonly RunNodeOutput[]; readonly outputPreview: readonly Readonly<Record<string, unknown>>[]; readonly noMatch?: RunNoMatch }
  | { readonly sequence: number; readonly kind: 'model-response'; readonly content: string }
  | { readonly sequence: number; readonly kind: 'agent_call'; readonly toolName: string; readonly agentRef: { readonly internalId: AgentId; readonly version: string }; readonly childRunId: RunId; readonly ok: boolean; readonly summary: string }
  /** ランタイムハーネスの自動圧縮が走ったモデル往復（beforeChars → afterChars）。 */
  | { readonly sequence: number; readonly kind: 'compaction'; readonly beforeChars: number; readonly afterChars: number }
  /** toolApproval: 非read-onlyツールの実行前に人間の承認を要求してRunを止めた。 */
  | { readonly sequence: number; readonly kind: 'approval-requested'; readonly tool: string; readonly sideEffect: SideEffect; readonly prompt: string }
  /**
   * toolApproval: 人間が承認/拒否を返してRunを再開した。
   *
   * `decidedBy` は承認した主体（`Principal.subject`）。**任意**なのは、認可・監査を入れる前に
   * 保存された Run のトレースにこのキーが無いため（必須にすると既存Runの参照が全滅する）。
   * 新しく記録するイベントには必ず入る。
   */
  | { readonly sequence: number; readonly kind: 'approval-resolved'; readonly decision: 'approve' | 'reject'; readonly decidedBy?: string }
  /**
   * Agentが参照するMCPサーバーを解決できず、そのサーバーのツールを注入しなかった（Runは続く）。
   * 黙って落とすと「ツールが無い」理由が利用者に見えないため、Run開始時に1サーバー1件で残す。
   */
  | { readonly sequence: number; readonly kind: 'mcp-server-skipped'; readonly server: string; readonly reason: 'not-found' | 'disabled' | 'unreachable'; readonly detail?: string }
  /** `tool` / `nodeId` はツール実行由来の失敗だけが持つ（どのToolのどのノードで落ちたか）。古いRunには無い。 */
  | { readonly sequence: number; readonly kind: 'error'; readonly code: string; readonly message: string; readonly tool?: RunFailureToolRef; readonly nodeId?: string };

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
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 再開に必要な会話メッセージ1件（assistantのtoolCalls / toolのtoolCallIdを含む）。 */
export interface RunCheckpointMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null | readonly RunCheckpointContentPart[];
  readonly toolCalls?: readonly RunCheckpointToolCall[];
  readonly toolCallId?: ToolCallId;
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
  readonly agentRef: { readonly internalId: AgentId; readonly version: string };
  /** ループ再開に必要な全メッセージ（assistantのtoolCallsを含む）。 */
  readonly messages: readonly RunCheckpointMessage[];
  /** 未実行のツール呼び出し。先頭が承認対象。 */
  readonly pendingCalls: readonly RunCheckpointToolCall[];
  /** ツール呼び出し上限のカウントと結果recordの tools 復元に使う実行済みTool。 */
  readonly executedToolRefs: readonly { readonly internalId: ToolId; readonly version: string; readonly publishName?: string }[];
  readonly budget: RunCheckpointBudget;
  /** 再開時のモデル往復番号。 */
  readonly step: number;
  readonly sessionId?: SessionId;
  /** ISO。作成 + INTERACTIVE_CHECKPOINT_TTL_MS(24h)。 */
  readonly expiresAt: IsoDateTime;
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
  readonly effectiveAt: IsoDateTime;
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
  /** ツール実行由来の失敗だけが持つ: どのToolのどのノードで落ちたか。古いRunには無い。 */
  readonly tool?: RunFailureToolRef;
  readonly nodeId?: string;
}

export interface RunArtifactRef {
  /** Tool参照（`tool` / `tools`）ならToolId、Agent参照（`agent`）ならAgentId。両用のためstringのまま(ADR-0034)。 */
  readonly internalId: string;
  readonly version?: string;
  readonly publishName?: string;
}

export interface RunRecord {
  readonly runId: RunId;
  readonly scope: TenantScope;
  /** Agent Session Workspaceとの対応。旧Runは未指定を許容する。 */
  readonly sessionId?: SessionId;
  readonly status: RunStatus;
  readonly mode: RunMode;
  /** v26追加。旧recordでは未指定を許容しinteractiveとして解釈する。 */
  readonly purpose?: RunPurpose;
  readonly model?: RunModelSnapshot;
  readonly tool?: RunArtifactRef;
  readonly tools?: readonly RunArtifactRef[];
  readonly agent?: RunArtifactRef;
  readonly startedAt: IsoDateTime;
  readonly completedAt?: IsoDateTime;
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
  readonly runId: RunId;
  readonly scope: TenantScope;
  readonly sessionId?: SessionId;
  readonly mode: RunMode;
  readonly purpose?: RunPurpose;
  readonly model?: RunModelSnapshot;
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly agent?: RunRecord['agent'];
  readonly startedAt: IsoDateTime;
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
  readonly completedAt: IsoDateTime;
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
  readonly completedAt: IsoDateTime;
}): RunRecord {
  assertRunning(record);
  return { ...record, status: 'failed', checkpoint: undefined, trace: structuredClone(result.trace), failure: cloneFailure(result.failure), ...(result.latency !== undefined ? { latency: { ...result.latency } } : {}), completedAt: result.completedAt };
}

/** failure を複製する。`tool` は入れ子オブジェクトなので浅い spread だけでは呼び出し側と共有されてしまう。 */
function cloneFailure(failure: RunFailure): RunFailure {
  return { ...failure, ...(failure.tool !== undefined ? { tool: { ...failure.tool } } : {}) };
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
      // tool / nodeId は「どこで落ちたか」の識別でペイロードではないので、message だけを落とす。
      ...(record.failure !== undefined ? { failure: { ...cloneFailure(record.failure), message: '[redacted]' } } : {}),
    } : {}),
    ...(parts.trace ? { trace: [] } : {}),
  };
}

function assertRunning(record: RunRecord): void {
  if (record.status !== 'running') throw new Error(`run '${record.runId}' is already ${record.status}`);
}

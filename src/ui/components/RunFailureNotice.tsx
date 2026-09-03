import { describeMcpServerSkipped, localizeRunTraceError, splitFailureMessage } from '../api/error-messages';
import { fixTargetsForFailure } from '../api/fix-targets';
import type { RunFailureToolRefDto, RunTraceEventDto } from '../api/types';
import { useI18n } from '../i18n';
import { useNavigateScreen, useOpenInScreen } from '../navigation';

/**
 * Run 失敗の通知（Chat / Tool Builder のエージェントチャット / ステータスの3画面で共通）。
 *
 * 並びは**次の一手 → 原因 → 失敗箇所 → 直す場所へのボタン**。利用者が最初に読むのは「何をすればよいか」で、
 * 説明文はその次。生の `code: message` とモデルが渡した引数は折りたたみ（技術的な詳細）に入れ、画面を
 * 支配させない。
 *
 * - `message` はローカライズ済み（ApiError.message / localizeRunFailure の結果）。原因と次の一手の分割は
 *   splitFailureMessage に委ねる（分けられなければ全文を次の一手として太字で出す）。
 * - `serverMessage` はサーバーの生メッセージ。遷移先の判定（fixTargetsForFailure）は英語定型文で行うため、
 *   分かるときは必ず渡す。無ければ `message` で判定する（'MCP' など言語非依存の語だけ効く）。
 * - 失敗箇所（tool / nodeId）は props 優先。無ければ trace の error イベントが持つものを使う
 *   （保存済み Run や、失敗箇所をエラー本文に載せない古い応答のため）。
 */
export interface RunFailureNoticeProps {
  readonly code: string;
  readonly message: string;
  readonly serverMessage?: string;
  readonly tool?: RunFailureToolRefDto;
  readonly nodeId?: string;
  readonly runId?: string;
  readonly agent?: { readonly internalId: string };
  readonly trace?: readonly RunTraceEventDto[];
}

export function RunFailureNotice({ code, message, serverMessage, tool, nodeId, runId, agent, trace }: RunFailureNoticeProps) {
  const { language, text } = useI18n();
  const navigate = useNavigateScreen();
  const openInScreen = useOpenInScreen();
  const evidence = trace === undefined ? undefined : failureEvidence(trace);
  const failedTool = tool ?? evidence?.error?.tool;
  const failedNodeId = nodeId ?? evidence?.error?.nodeId;
  const targets = fixTargetsForFailure({
    code,
    message: serverMessage ?? message,
    ...(failedTool === undefined ? {} : { tool: failedTool }),
    ...(failedNodeId === undefined ? {} : { nodeId: failedNodeId }),
    ...(agent === undefined ? {} : { agent }),
  });
  const { cause, action } = splitFailureMessage(message, language);
  const toolName = failedTool === undefined ? undefined : (failedTool.publishName ?? failedTool.internalId);

  return (
    <div className="api-error run-failure" role="alert">
      <p><strong>{action}</strong></p>
      {cause !== undefined && <p>{cause}</p>}
      {(toolName !== undefined || failedNodeId !== undefined) && (
        <p className="run-failure-where">
          {toolName !== undefined && <>{text('Failed in tool', '失敗箇所: ツール')} <code>{toolName}</code>{failedTool?.version === undefined ? '' : ` v${failedTool.version}`}</>}
          {toolName !== undefined && failedNodeId !== undefined && ' · '}
          {failedNodeId !== undefined && <>{toolName === undefined ? text('Failed in node', '失敗箇所: ノード') : text('node', 'ノード')} <code>{failedNodeId}</code></>}
        </p>
      )}
      {targets.length > 0 && (
        <div className="run-failure-actions">
          {targets.map((target) => (
            <button
              type="button"
              className="secondary"
              key={target.screen}
              onClick={() => { if (target.open === undefined) navigate(target.screen); else openInScreen(target.screen, target.open); }}
            >
              {text(target.label[0], target.label[1])}
            </button>
          ))}
        </div>
      )}
      <details className="run-failure-trace">
        <summary>{text('Technical details', '技術的な詳細')}</summary>
        <p><code>{code}: {serverMessage ?? message}</code></p>
        {runId !== undefined && <p><small>run {runId}</small></p>}
        {evidence?.call !== undefined && (
          <p>
            {text('Last tool call before the failure:', '失敗直前のツール呼び出し:')}{' '}
            <strong>{evidence.call.name}</strong>{' '}
            <code>{JSON.stringify(evidence.call.arguments)}</code>
          </p>
        )}
        {evidence?.skipped.map((event) => <p key={event.sequence}>{describeMcpServerSkipped(event, language)}</p>)}
        {evidence?.error !== undefined && evidence.error.message !== (serverMessage ?? message) && <p>{localizeRunTraceError(evidence.error, language)}</p>}
      </details>
    </div>
  );
}

type ToolCallEvent = Extract<RunTraceEventDto, { kind: 'tool-call' }>;
type ErrorEvent = Extract<RunTraceEventDto, { kind: 'error' }>;
type McpSkippedEvent = Extract<RunTraceEventDto, { kind: 'mcp-server-skipped' }>;

/**
 * 最後の error イベントと、その直前の tool-call を取り出す。error が無い（サーバーが失敗を
 * トレースに書く前に落ちた）場合は末尾の tool-call を「最後に何を呼んだか」として出す。
 */
function failureEvidence(trace: readonly RunTraceEventDto[]): { readonly call?: ToolCallEvent; readonly error?: ErrorEvent; readonly skipped: readonly McpSkippedEvent[] } {
  let errorIndex = -1;
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (trace[index]?.kind === 'error') { errorIndex = index; break; }
  }
  const error = errorIndex === -1 ? undefined : trace[errorIndex] as ErrorEvent;
  let call: ToolCallEvent | undefined;
  for (let index = (errorIndex === -1 ? trace.length : errorIndex) - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event?.kind === 'tool-call') { call = event; break; }
  }
  const skipped = trace.filter((event): event is McpSkippedEvent => event.kind === 'mcp-server-skipped');
  return { ...(call === undefined ? {} : { call }), ...(error === undefined ? {} : { error }), skipped };
}

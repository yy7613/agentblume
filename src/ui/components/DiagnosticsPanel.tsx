import { localizeDiagnosticDetail } from '../api/error-messages';
import type { AgentDiagnosticsDto, DiagnosticCheckDto, DiagnosticStatusDto, ToolDiagnosticsDto } from '../api/types';
import { useI18n } from '../i18n';
import { useNavigateScreen, useOpenInScreen, type OpenTarget } from '../navigation';

type Translate = (english: string, japanese: string) => string;

/**
 * どの画面に埋め込まれているか。修正ボタンの出し分けに使う。
 * - inspector: 動作確認画面。ツール・エージェントどちらへも「開いて直す」導線を出す。
 * - agent-editor: エージェント編集中。自分自身を別画面で開かず、画面内の区画（ツール選択・実行オプション…）へ移る。
 * - tool-editor: ツール編集中。自分自身を別画面で開かず、キャンバス上のノード選択やパネルへ移る。
 */
export type DiagnosticsContext = 'inspector' | 'agent-editor' | 'tool-editor';

/** エージェント全体の診断か、Tool単体（下書き）の診断か。 */
export type DiagnosticsInput = AgentDiagnosticsDto | { readonly kind: 'tool'; readonly tool: ToolDiagnosticsDto };

/**
 * 編集中の対象そのものの中で「直す場所」。画面遷移を伴わない。
 * tool-editor: nodeId（キャンバスのノードを選択）/ section 'agent-context' | 'output'。
 * agent-editor: section 'tools' | 'sub-agents' | 'skills' | 'mcp' | 'harness'。
 */
export interface LocalTarget { readonly nodeId?: string; readonly section?: string }

/** Tool 画面の区画。診断の検査idから「どこを直すか」へ写す。 */
export const TOOL_SECTION = { agentContext: 'agent-context', output: 'output' } as const;
/** Agent 画面の区画。 */
export const AGENT_SECTION = { tools: 'tools', skills: 'skills', subAgents: 'sub-agents', mcp: 'mcp', harness: 'harness' } as const;

/** 検査項目idの表示ラベル。サーバー側 DiagnoseAgentToolsUseCase / Tool draft 診断の id と対で保守する。未知idはそのまま表示する。 */
export const DIAGNOSTIC_CHECK_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  skills: ['Skill references', 'スキル参照'],
  'tool-versions': ['Tool version consistency', 'ツールバージョン整合'],
  'sub-agents': ['Sub-agent references', 'サブエージェント参照'],
  'function-names': ['Function name uniqueness', 'Function名の一意性'],
  'mcp-servers': ['MCP servers', 'MCPサーバー参照'],
  model: ['Model capabilities', 'モデルの対応機能'],
  harness: ['Harness features', 'ハーネス機能の前提'],
  resolved: ['Tool version exists', 'ツールバージョンの存在'],
  'function-definition': ['Function definition', 'Function定義'],
  'agent-input': ['Input schema matches agent-input', '入力スキーマとAgent Inputの一致'],
  'data-sources': ['Data source resolution', 'データソース解決'],
  graph: ['Graph validation', 'グラフ検証'],
  execution: ['Sample execution', 'サンプル実行'],
  'output-schema': ['Output schema consistency', '出力スキーマ整合'],
  'operator-arguments': ['Operator arguments', '演算子引数'],
  'list-arguments': ['Multi-value arguments', '複数値の引数'],
  'side-effect': ['Side effect / approval', '副作用と承認'],
  state: ['Tool lifecycle state', 'ツールの公開状態'],
};

export function diagnosticCheckLabel(id: string, text: Translate): string {
  const pair = DIAGNOSTIC_CHECK_LABELS[id];
  return pair === undefined ? id : text(pair[0], pair[1]);
}

/** ツール検査の「直す場所」。nodeId があれば必ずそのノード、無ければ検査idごとの区画。 */
export function toolCheckTarget(check: DiagnosticCheckDto): LocalTarget {
  if (check.nodeId !== undefined) return { nodeId: check.nodeId };
  switch (check.id) {
    case 'function-definition':
    case 'agent-input':
    case 'operator-arguments':
    case 'list-arguments':
      return { section: TOOL_SECTION.agentContext };
    case 'output-schema':
      return { section: TOOL_SECTION.output };
    default:
      return {};
  }
}

/** 診断結果の中で最初に問題になっている検査（ツール行のバッジ用）。 */
export function topIssue(checks: readonly DiagnosticCheckDto[]): DiagnosticCheckDto | undefined {
  return checks.find((check) => check.status === 'error') ?? checks.find((check) => check.status === 'warning');
}

/** 一手で直しに行くためのボタン。label と実行する遷移。 */
interface FixAction { readonly label: string; readonly run: () => void }

function isToolInput(input: DiagnosticsInput): input is { readonly kind: 'tool'; readonly tool: ToolDiagnosticsDto } {
  return 'kind' in input && input.kind === 'tool';
}

function countStatus(checks: readonly DiagnosticCheckDto[], status: DiagnosticStatusDto): number {
  return checks.filter((check) => check.status === status).length;
}

export function DiagnosticStatusMark({ status }: { readonly status: DiagnosticStatusDto }) {
  return <span className={`ins-diag-mark ${status}`} aria-hidden="true">{status === 'ok' ? '✓' : status === 'warning' ? '!' : '✕'}</span>;
}

/**
 * 検査1行。ok は1行に畳んで、問題のある行だけを「原因（次の一手つき）→ どこを直すか」の順で広げる。
 * 見出し（検査ラベル）と生のid・ノードidは小さく添える。
 */
function DiagnosticCheckRow({ check, fix, onRowClick, text, language }: {
  readonly check: DiagnosticCheckDto;
  readonly fix: FixAction | undefined;
  /** 行クリックで直す場所へ移る（tool-editor のノード行）。 */
  readonly onRowClick?: () => void;
  readonly text: Translate;
  readonly language: 'en' | 'ja';
}) {
  const label = diagnosticCheckLabel(check.id, text);
  if (check.status === 'ok') {
    return (
      <li className="ins-diag-check ok">
        <DiagnosticStatusMark status="ok" />
        <span className="ins-diag-label">{label}</span>
      </li>
    );
  }
  const detail = check.detail === undefined ? undefined : localizeDiagnosticDetail(check.detail, language);
  return (
    <li className={`ins-diag-check ${check.status} ${onRowClick === undefined ? '' : 'clickable'}`} onClick={onRowClick}>
      <DiagnosticStatusMark status={check.status} />
      <div className="ins-diag-body">
        <small className="ins-diag-label"><span>{label}</span> <code className="ins-diag-id">{check.id}</code></small>
        <p className="ins-diag-detail">{detail ?? label}</p>
        <div className="ins-diag-actions">
          {check.nodeId !== undefined && <span className="ins-diag-node" title={text('Node in the tool graph', 'ツールグラフ内のノード')}>{text('node', 'ノード')}: <code>{check.nodeId}</code></span>}
          {fix !== undefined && <button type="button" className="ghost diag-fix-btn" onClick={(event) => { event.stopPropagation(); fix.run(); }}>{fix.label}</button>}
        </div>
      </div>
    </li>
  );
}

/**
 * Tool呼び出しのプリフライト診断結果を、動作確認画面・エージェント編集・ツール編集で共通に描く。
 *
 * 検査の detail はサーバーの英語定型文なので、実行時エラーと同じ変換表（localizeDiagnosticDetail）で
 * 「原因 + 次の一手」の文言へ直し、行の主文にする。問題のある行には、直す場所（ノード・区画・画面）まで
 * 一手で連れて行くボタンを付ける。
 */
export function DiagnosticsPanel({ diagnostics, context, onClose, onOpenHarness, onOpenLocal, agentId }: {
  readonly diagnostics: DiagnosticsInput;
  readonly context: DiagnosticsContext;
  readonly onClose?: () => void;
  /** agent-editor だけ: ハーネス（実行オプション）ダイアログを開く。 */
  readonly onOpenHarness?: () => void;
  /** 編集画面だけ: 編集中の対象の中で直す場所へ移る（tool-editor: ノード選択・パネル、agent-editor: 区画）。 */
  readonly onOpenLocal?: (target: LocalTarget) => void;
  /** エージェント検査の修正ボタンで開くエージェント。省略時は診断結果のエージェントID。 */
  readonly agentId?: string;
}) {
  const { text, language } = useI18n();
  const navigate = useNavigateScreen();
  const openIn = useOpenInScreen();

  const tools: readonly ToolDiagnosticsDto[] = isToolInput(diagnostics) ? [diagnostics.tool] : diagnostics.tools;
  const agentChecks: readonly DiagnosticCheckDto[] = isToolInput(diagnostics) ? [] : diagnostics.checks;
  const overall: DiagnosticStatusDto = isToolInput(diagnostics) ? diagnostics.tool.status : diagnostics.status;
  const allChecks = [...agentChecks, ...tools.flatMap((tool) => tool.checks)];
  const errors = countStatus(allChecks, 'error');
  const warnings = countStatus(allChecks, 'warning');
  const badge = overall === 'ok'
    ? text('No blockers', '問題なし')
    : overall === 'warning' ? text('Needs attention', '要確認') : text('Blocked', '呼び出し不可あり');
  const subject = isToolInput(diagnostics)
    ? `${diagnostics.tool.internalId}@${diagnostics.tool.version}`
    : `${diagnostics.agent.internalId}@${diagnostics.agent.version}`;
  const targetAgentId = agentId ?? (isToolInput(diagnostics) ? undefined : diagnostics.agent.internalId);
  const targetAgentVersion = isToolInput(diagnostics) ? undefined : diagnostics.agent.version;

  /** エージェント画面の区画へ。編集中なら画面内で移り、それ以外は Agent 画面でそのエージェントを開いて移る。 */
  function agentSectionFix(section: string, editorLabel: string, remoteLabel: (id: string) => string): FixAction | undefined {
    if (context === 'agent-editor') {
      if (section === AGENT_SECTION.harness && onOpenHarness !== undefined) return { label: editorLabel, run: onOpenHarness };
      return onOpenLocal === undefined ? undefined : { label: editorLabel, run: () => onOpenLocal({ section }) };
    }
    if (targetAgentId === undefined) return undefined;
    const target: OpenTarget = { internalId: targetAgentId, section, ...(targetAgentVersion === undefined ? {} : { version: targetAgentVersion }) };
    return { label: remoteLabel(targetAgentId), run: () => openIn('Agent', target) };
  }

  function agentFix(check: DiagnosticCheckDto): FixAction | undefined {
    switch (check.id) {
      case 'skills':
        return { label: text('Open Skill screen', 'スキル画面を開く'), run: () => navigate('Skill') };
      case 'tool-versions':
      case 'function-names':
        return agentSectionFix(AGENT_SECTION.tools, text('Go to tool selection', 'ツール選択へ移動'), (id) => text(`Open agent "${id}" (tools)`, `エージェント「${id}」のツール選択を開く`));
      case 'sub-agents':
        return agentSectionFix(AGENT_SECTION.subAgents, text('Go to sub-agent selection', 'サブエージェント選択へ移動'), (id) => text(`Open agent "${id}" (sub-agents)`, `エージェント「${id}」のサブエージェント選択を開く`));
      case 'mcp-servers':
        return { label: text('Open MCP settings', 'MCP設定を開く'), run: () => navigate('MCP') };
      case 'model':
        return { label: text('Open model settings', 'モデル設定を開く'), run: () => navigate('Settings') };
      case 'harness':
        // ダイアログの表示名は「実行オプション」（マルチエージェント画面の「ハーネス」と取り違えないため）。検査名との対応が分かるよう括弧で添える。
        return agentSectionFix(AGENT_SECTION.harness, text('Open runtime options (harness)', '実行オプション（ハーネス）を開く'), (id) => text(`Open agent "${id}" (runtime options)`, `エージェント「${id}」の実行オプションを開く`));
      default:
        return undefined;
    }
  }

  function toolFix(tool: ToolDiagnosticsDto, check: DiagnosticCheckDto): FixAction | undefined {
    const name = tool.functionName ?? tool.internalId;
    const local = toolCheckTarget(check);
    if (context === 'tool-editor') {
      if (onOpenLocal === undefined) return undefined;
      if (local.nodeId !== undefined) return { label: text(`Open node "${local.nodeId}"`, `ノード「${local.nodeId}」を開いて直す`), run: () => onOpenLocal(local) };
      if (local.section === TOOL_SECTION.agentContext) return { label: text('Go to Agent context', 'エージェント向けコンテキストへ移動'), run: () => onOpenLocal(local) };
      if (local.section === TOOL_SECTION.output) return { label: text('Select the output node', '出力ノードを選択'), run: () => onOpenLocal(local) };
      return undefined;
    }
    const target: OpenTarget = { internalId: tool.internalId, version: tool.version, ...local };
    const run = () => openIn('Tool', target);
    if (local.nodeId !== undefined) return { label: text(`Open node "${local.nodeId}"`, `ノード「${local.nodeId}」を開いて直す`), run };
    if (local.section === TOOL_SECTION.agentContext) return { label: text(`Open tool "${name}" (agent context)`, `ツール「${name}」のエージェント向け設定を開く`), run };
    if (local.section === TOOL_SECTION.output) return { label: text(`Open tool "${name}" (output)`, `ツール「${name}」の出力設定を開く`), run };
    return { label: text(`Open tool "${name}"`, `ツール「${name}」を開いて直す`), run };
  }

  return (
    <section className={`ins-diag ins-diag-${context}`} aria-label={text('Tool call diagnostics', 'ツール呼び出し診断')}>
      <header className="ins-diag-head">
        <h4>{text('Tool call diagnostics', 'ツール呼び出し診断')} <small>{subject}</small></h4>
        <span className={`ins-diag-badge ${overall}`}>{badge}</span>
        <span className="ins-diag-counts">{text(`${errors} error(s) · ${warnings} warning(s)`, `エラー ${errors} 件 · 警告 ${warnings} 件`)}</span>
        {onClose !== undefined && <button type="button" className="ghost" aria-label={text('Close diagnostics', '診断を閉じる')} onClick={onClose}>×</button>}
      </header>
      {agentChecks.length > 0 && (
        <ul className="ins-diag-list" aria-label={text('Agent checks', 'エージェント検査')}>
          {agentChecks.map((check) => <DiagnosticCheckRow key={check.id} check={check} fix={agentFix(check)} text={text} language={language} />)}
        </ul>
      )}
      {!isToolInput(diagnostics) && tools.length === 0 && <p className="ins-none">{text('This agent references no tools.', 'このエージェントはツールを参照していません。')}</p>}
      {tools.map((tool) => (
        <div className="ins-diag-tool" key={`${tool.internalId}@${tool.version}`}>
          <div className="ins-diag-tool-head">
            <DiagnosticStatusMark status={tool.status} />
            <b>{tool.functionName ?? tool.internalId}</b>
            <small>{tool.internalId}@{tool.version}</small>
            {tool.source === 'skill' && <span className="ins-chip skill">{text('via skill', 'スキル経由')}{tool.skillId === undefined ? '' : `: ${tool.skillId}`}</span>}
          </div>
          <ul className="ins-diag-list" aria-label={text(`Checks for ${tool.internalId}`, `${tool.internalId} の検査`)}>
            {tool.checks.map((check) => {
              // tool-editor では、ノードを名指しする行はどこをクリックしてもそのノードへ移れる。
              const rowClick = context === 'tool-editor' && onOpenLocal !== undefined && check.nodeId !== undefined && check.status !== 'ok'
                ? () => onOpenLocal({ nodeId: check.nodeId })
                : undefined;
              return <DiagnosticCheckRow key={check.id} check={check} fix={toolFix(tool, check)} {...(rowClick === undefined ? {} : { onRowClick: rowClick })} text={text} language={language} />;
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

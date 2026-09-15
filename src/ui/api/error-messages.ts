/**
 * ui/api層: サーバーのエラーコード + 生メッセージ → ユーザー向けローカライズ文言。
 *
 * この層は React の外（ApiError 構築時）で動くため i18n.tsx の text() に依存できない。
 * 言語は localStorage からエラー発生時点で遅延判定する。
 * 変換できなかった部分は原文をそのまま残す（詳細を握りつぶさない）。
 */

import type { Bilingual, BusinessErrorMessages, ErrorLanguage } from './business-error-types';
import { JOURNAL_ERROR_MESSAGES } from './journal-error-messages';
import { EXPENSE_ERROR_MESSAGES } from './expense-error-messages';
import { RECEIVABLES_ERROR_MESSAGES } from './receivables-error-messages';
import { CONTRACT_ERROR_MESSAGES } from './contract-error-messages';

export type { ErrorLanguage } from './business-error-types';

const LANGUAGE_KEY = 'agentcontext.language';

/** localStorage 不可用（SSR / プライベートモード）では 'en' へフォールバックする。 */
export function detectErrorLanguage(): ErrorLanguage {
  try { return localStorage.getItem(LANGUAGE_KEY) === 'ja' ? 'ja' : 'en'; }
  catch { return 'en'; }
}

function pick(bilingual: Bilingual, language: ErrorLanguage): string {
  return language === 'ja' ? bilingual[1] : bilingual[0];
}

/**
 * 判定モデル（judge スロット）が未設定のときの文言。起票の拒否（`JUDGE_MODEL_NOT_CONFIGURED`・409）と、
 * 判定 1 件の失敗（`JUDGE_PROVIDER` + "is not configured"）の両方で同じ次の一手（設定画面の judge スロット）を示す。
 * 原文は次の一手を含まないので括弧で残さない。
 */
const JUDGE_MODEL_NOT_CONFIGURED_MESSAGE: Bilingual = [
  'The judge model is not configured. Set the judge slot in Settings before running experiments that use a judge rubric',
  '判定モデルが設定されていません。審査ルーブリックを使う実験の前に、設定画面の judge スロットでモデルを設定してください',
];

/**
 * error.code ごとの見出し。src/api/error-mapping.ts が返す code 体系に対応する。
 * HTTP_ERROR / 未知の code は status から見出しを決める（statusHeading）。
 */
const CORE_HEADINGS: Record<string, Bilingual> = {
  BAD_REQUEST: ['Please check your input', '入力内容を確認してください'],
  // 401。トークンを入れる場所（設定 → アクセス）まで案内する。
  UNAUTHENTICATED: [
    'Sign-in is required. Open Settings → Access and enter your access token',
    '認証が必要です。設定画面の「アクセス」でアクセストークンを入力してください',
  ],
  NOT_FOUND: ['The requested item was not found', '対象が見つかりませんでした'],
  CONFLICT: ['The request conflicts with the current state. Reload the latest data, then retry', '現在の状態と競合しました。最新の内容を読み込んでから再試行してください'],
  INTERNAL: ['The server hit an internal error. Wait a moment, then retry', 'サーバー内部でエラーが発生しました。時間をおいて再試行してください'],
  INVALID_API_RESPONSE: ['The API returned a non-JSON response. Check that the API server is running and the dev proxy is configured', 'APIサーバーからJSON以外の応答が返りました。APIサーバーの起動状態と開発プロキシ設定を確認してください'],
  INVALID_FILE_CONTENT: ['The uploaded file could not be parsed. Check its format and character encoding, then upload again', 'アップロードしたファイルを解析できませんでした。ファイル形式と文字コードを確認して、もう一度アップロードしてください'],

  TOOL_NOT_FOUND: ['The tool was not found', 'ツールが見つかりませんでした'],
  TOOL_VERSION_CONFLICT: ['That tool version already exists. Bump the version, then save again', '同じツールバージョンが既に存在します。バージョンを上げて保存し直してください'],
  TOOL_VALIDATION: ['Please check the tool definition', 'ツール定義を確認してください'],
  TOOL_ARGUMENTS: ['The agent called the tool with invalid arguments. Review the tool schema and the prompt', 'エージェントがツールを不正な引数で呼び出しました。ツールのスキーマとプロンプトを見直してください'],
  UNSAFE_TOOL: ['This tool is not allowed to run in the current mode', 'このツールは現在のモードでは実行できません'],

  AGENT_NOT_FOUND: ['The agent was not found', 'エージェントが見つかりませんでした'],
  AGENT_VERSION_CONFLICT: ['That agent version already exists. Bump the version, then save again', '同じエージェントバージョンが既に存在します。バージョンを上げて保存し直してください'],
  AGENT_VALIDATION: ['Please check the agent definition', 'エージェント定義を確認してください'],
  AGENT_RUN: ['The agent run failed', 'エージェントの実行に失敗しました'],
  RUN_CANCELLED: ['The run was cancelled', '実行を中断しました'],

  SKILL_NOT_FOUND: ['The skill was not found', 'スキルが見つかりませんでした'],
  SKILL_VERSION_CONFLICT: ['That skill version already exists. Bump the version, then save again', '同じスキルバージョンが既に存在します。バージョンを上げて保存し直してください'],
  SKILL_VALIDATION: ['Please check the skill definition', 'スキル定義を確認してください'],

  HARNESS_NOT_FOUND: ['The multi-agent configuration was not found', 'マルチエージェント構成が見つかりませんでした'],
  HARNESS_RUN_NOT_FOUND: ['The multi-agent run was not found', 'マルチエージェント実行が見つかりませんでした'],
  HARNESS_VERSION_CONFLICT: ['That multi-agent configuration version already exists. Bump the version, then save again', '同じマルチエージェント構成バージョンが既に存在します。バージョンを上げて保存し直してください'],
  HARNESS_VALIDATION: ['Please check the multi-agent definition', 'マルチエージェント定義を確認してください'],
  HARNESS_RUN: ['The multi-agent run failed', 'マルチエージェントの実行に失敗しました'],

  FACTORY_NOT_FOUND: ['The factory run was not found', 'ファクトリ実行が見つかりませんでした'],
  FACTORY_VALIDATION: ['Please check the factory run settings', 'ファクトリ実行の設定を確認してください'],

  RUN_NOT_FOUND: ['The run was not found', '実行履歴が見つかりませんでした'],
  RUN_FAILED: ['The run failed', '実行が失敗しました'],

  VALIDATION_DOMAIN: ['Please check the validation settings', '検証設定を確認してください'],
  PERSONA_NOT_FOUND: ['The persona was not found', 'ペルソナが見つかりませんでした'],
  SCENARIO_NOT_FOUND: ['The scenario was not found', 'シナリオが見つかりませんでした'],
  SCENARIO_RUN_NOT_FOUND: ['The scenario run was not found', 'シナリオ実行が見つかりませんでした'],

  EVALUATION_DOMAIN: ['Please check the evaluation settings', '評価設定を確認してください'],
  EVALUATION_DATASET_NOT_FOUND: ['The evaluation dataset was not found', '評価データセットが見つかりませんでした'],
  EVALUATOR_PROFILE_NOT_FOUND: ['The evaluator profile was not found', '評価者プロファイルが見つかりませんでした'],
  EVALUATION_VERSION_CONFLICT: ['That version already exists. Bump the version, then save again', '同じバージョンが既に存在します。バージョンを上げて保存し直してください'],
  EXPERIMENT_NOT_FOUND: ['The experiment was not found', '実験が見つかりませんでした'],
  EXPERIMENT_CONFLICT: ['The experiment is not in a state that allows this operation', '実験の状態がこの操作を許可していません'],
  QUALITY_GATE_NOT_FOUND: ['The gate policy was not found', 'ゲートポリシーが見つかりませんでした'],
  QUALITY_GATE_CONFLICT: ['The gate policy conflicts with the current state', 'ゲートポリシーが現在の状態と競合しました'],
  JUDGE_RUBRIC_NOT_FOUND: ['The judge rubric was not found', '審査ルーブリックが見つかりませんでした'],
  JUDGE_INPUT: ['Please check the input given to the judge', '審査に渡す入力を確認してください'],
  JUDGE_SCHEMA: ['The judge response did not match the expected shape. Retry, or pick a different model', '審査結果が期待した形式ではありませんでした。再試行するか、別のモデルを選んでください'],
  JUDGE_UNASSESSABLE: ['The judge could not assess any criterion', '審査者はどの基準も判定できませんでした'],
  // 実験の起票時（POST /experiments・409）。判定モデル未設定は「設定画面の judge スロット」へ、軌跡必須は「ルーブリックの軌跡ポリシー」へ導く。
  JUDGE_MODEL_NOT_CONFIGURED: JUDGE_MODEL_NOT_CONFIGURED_MESSAGE,

  MEMORY_DOMAIN: ['Please check the memory input', '記憶の入力内容を確認してください'],
  WIKI_PAGE_NOT_FOUND: ['The wiki page was not found', 'Wikiページが見つかりませんでした'],
  WIKI_SPACE_NOT_FOUND: ['The wiki was not found', 'Wikiが見つかりませんでした'],
  MEMORY_PROPOSAL_NOT_FOUND: ['The memory proposal was not found', '記憶の提案が見つかりませんでした'],

  FEEDBACK_VALIDATION: ['Please check the feedback input', 'フィードバックの入力内容を確認してください'],

  SESSION_DOMAIN: ['Please check the session request', 'セッションの操作内容を確認してください'],
  SESSION_NOT_FOUND: ['The session was not found', 'セッションが見つかりませんでした'],
  SESSION_CLOSED: ['The session is already closed. Start a new session', 'セッションは既に終了しています。新しいセッションを開始してください'],
  SESSION_EXPIRED: ['The session has expired. Start a new session', 'セッションの有効期限が切れました。新しいセッションを開始してください'],
  ARTIFACT_NOT_FOUND: ['The artifact was not found', '成果物が見つかりませんでした'],
  SESSION_QUOTA_EXCEEDED: ['The session storage limit was exceeded. Delete unused artifacts, then retry', 'セッションの保存上限を超えました。不要な成果物を削除して再試行してください'],

  DATA_SOURCE_VALIDATION: ['Please check the data source settings', 'データソースの設定を確認してください'],
  WEB_SEARCH_VALIDATION: ['Please check the web search settings', 'Web検索の設定を確認してください'],

  // MCPクライアント: サーバー設定の入力不正（400）と未登録サーバー（404）。src/domain/mcp/errors.ts の
  // McpValidationError / McpNotFoundError に対応する（接続失敗の McpClientError・502 は別系統）。
  MCP_VALIDATION: ['Please check the MCP server settings', 'MCPサーバー設定の入力内容を確認してください'],
  MCP_NOT_FOUND: ['The MCP server was not found', 'MCPサーバーが見つかりませんでした'],

  // モデル設定の入力不正（400）。LM Studio 前提の実行エラー文言に混ぜない。
  MODEL_SETTINGS_VALIDATION: ['Please check the model settings', 'モデル設定の入力内容を確認してください'],
  // モデル一覧の取得失敗（502）。実行エラーではなく「一覧が引けない」だけ。
  MODEL_CATALOG: ['Could not fetch the model list. Check the endpoint and its API key, then retry', 'モデル一覧を取得できませんでした。エンドポイントとAPIキーを確認して再試行してください'],

  ETL_GRAPH: ['Please check the node connections', 'ノードの接続を確認してください'],
  ETL_CONFIG: ['Please check the node settings', 'ノードの設定を確認してください'],
  ETL_SCHEMA: ['The column names or types do not match. Check the upstream node output', '列名または型が一致していません。上流ノードの出力を確認してください'],
};

/** 業務（仕訳・経費精算・入金消込・契約）の見出し。業務ごとの `<業務>-error-messages.ts` が持つ（ADR-0039）。 */
const BUSINESS_ERROR_MESSAGES: readonly BusinessErrorMessages[] = [JOURNAL_ERROR_MESSAGES, EXPENSE_ERROR_MESSAGES, RECEIVABLES_ERROR_MESSAGES, CONTRACT_ERROR_MESSAGES];

/** 見出しの全体（共通 + 業務）。 */
const HEADINGS: Readonly<Record<string, Bilingual>> = Object.assign({}, CORE_HEADINGS, ...BUSINESS_ERROR_MESSAGES.map((messages) => messages.headings));

/** code が無い / 汎用 HTTP 失敗の見出し（status ベース）。 */
const STATUS_HEADINGS: Record<number, Bilingual> = {
  400: ['Please check your input', '入力内容を確認してください'],
  401: ['Sign-in is required', '認証が必要です'],
  403: ['This operation is not permitted', 'この操作は許可されていません'],
  404: ['The requested item was not found', '対象が見つかりませんでした'],
  409: ['The request conflicts with the current state. Reload the latest data, then retry', '現在の状態と競合しました。最新の内容を読み込んでから再試行してください'],
  410: ['The target has expired', '対象の有効期限が切れています'],
  413: ['The data exceeds the allowed size', 'データ量が上限を超えています'],
  422: ['Please check your input', '入力内容を確認してください'],
  429: ['Too many requests. Wait a moment, then retry', 'リクエストが多すぎます。しばらく待って再試行してください'],
  500: ['The server hit an internal error. Wait a moment, then retry', 'サーバー内部でエラーが発生しました。時間をおいて再試行してください'],
  502: ['Could not reach the API server. Check that it is running, then retry', 'APIサーバーに接続できませんでした。稼働状況を確認して再試行してください'],
  503: ['The API server is unavailable. Wait a moment, then retry', 'APIサーバーが応答できません。時間をおいて再試行してください'],
  504: ['The request timed out. Wait a moment, then retry', 'リクエストがタイムアウトしました。時間をおいて再試行してください'],
};

/**
 * SECRET_CIPHER は status で意味が違う（src/api/error-mapping.ts）。
 * 500 = 鍵ファイル自体が読めない（再入力しても直らない運用障害）、409 = 保存済みキーを復号できない（再入力で直る）。
 */
const SECRET_CIPHER_KEY_FILE: Bilingual = [
  'The encryption key file could not be read. Check AGENTCONTEXT_SECRET_KEY_PATH (re-entering the API key will not fix this)',
  '鍵ファイルが読めない、または不正です。AGENTCONTEXT_SECRET_KEY_PATH を確認してください（APIキーの再入力では復旧しません）',
];
const SECRET_CIPHER_DECRYPT: Bilingual = [
  'The saved API key could not be decrypted. Enter the API key again, then save',
  '保存済みAPIキーを復号できません。APIキーを再入力して保存し直してください',
];

const SERVER_HEADING: Bilingual = ['The server hit an error. Wait a moment, then retry', 'サーバーでエラーが発生しました。時間をおいて再試行してください'];
const CLIENT_HEADING: Bilingual = ['The request was rejected. Please check your input', 'リクエストが受け付けられませんでした。入力内容を確認してください'];
const GENERIC_HEADING: Bilingual = ['The request failed', 'リクエストに失敗しました'];

/** 詳細が英語定型文（statusText / 'internal error' / 見出しの原文）で情報量が無い code。 */
const OPAQUE_DETAIL = new Set(['INTERNAL', 'HTTP_ERROR', 'INVALID_API_RESPONSE']);

/** JUDGE_TRACE_UNAVAILABLE（409）: ルーブリック ID が分かれば文中に埋め、分からなければ一般形にする。 */
function judgeTraceUnavailableMessage(rubricId: string | undefined, language: ErrorLanguage): string {
  if (language === 'ja') {
    return rubricId === undefined
      ? 'ルーブリックがツール呼び出しの軌跡を必須にしていますが、シナリオ事例では軌跡が得られません。軌跡ポリシーを「任意」にするか、ターン事例だけのデータセットを使ってください'
      : `ルーブリック '${rubricId}' はツール呼び出しの軌跡を必須にしていますが、シナリオ事例では軌跡が得られません。軌跡ポリシーを「任意」にするか、ターン事例だけのデータセットを使ってください`;
  }
  return rubricId === undefined
    ? 'The rubric requires a tool trace, but scenario cases never produce one. Set its trace policy to optional, or use a dataset with turn cases only'
    : `Rubric '${rubricId}' requires a tool trace, but scenario cases never produce one. Set its trace policy to optional, or use a dataset with turn cases only`;
}

/**
 * 判定モデル未設定の失敗か（起票の 409 `JUDGE_MODEL_NOT_CONFIGURED`、または判定 1 件の `JUDGE_PROVIDER` で
 * 原文が "is not configured"）。画面はこれで「設定で判定モデルを設定」ボタンを出す。
 */
export function isJudgeModelNotConfigured(failure: { readonly code: string; readonly message: string }): boolean {
  return failure.code === 'JUDGE_MODEL_NOT_CONFIGURED' || (failure.code === 'JUDGE_PROVIDER' && /not configured/i.test(failure.message));
}

/** tool-output-dispatcher.ts が agent-output の maxBytes 超過で投げる文（SESSION_QUOTA_EXCEEDED の見出しを使わない）。 */
const AGENT_OUTPUT_TOO_LARGE = /^agent-output exceeds maxBytes \(\d+ > \d+\)/;
/** セミコロンを含む1文として届く実行エラー・診断の定型文。localizeDetail の `;` 分割より先に丸ごと判定する対象。 */
const SEMICOLON_WHOLE_SHAPES: readonly RegExp[] = [
  AGENT_OUTPUT_TOO_LARGE,
  /^(?:SaveTool: )?declared output schema does not match the graph's inferred output \(/,
];

/** Zod のフィールド名 → 画面ラベル。src/api/schemas.ts のキーに対応する。 */
const FIELDS: Record<string, Bilingual> = {
  internalId: ['Internal ID', '内部ID'], workingName: ['Working name', '作業名'], displayName: ['Display name', '表示名'],
  publishName: ['Publish name', '公開名'], owner: ['Owner', '所有者'], systemPrompt: ['System prompt', 'システムプロンプト'],
  name: ['Name', '名前'], version: ['Version', 'バージョン'], id: ['ID', 'ID'], tenantId: ['Tenant ID', 'テナントID'],
  workspaceId: ['Workspace ID', 'ワークスペースID'], scope: ['Scope', 'スコープ'], description: ['Description', '説明'],
  instructions: ['Instructions', '手順'], message: ['Message', 'メッセージ'], mode: ['Mode', 'モード'], kind: ['Kind', '種別'],
  sideEffect: ['Side effect', '副作用'], graph: ['Graph', 'グラフ'], nodes: ['Nodes', 'ノード'], edges: ['Edges', 'エッジ'],
  config: ['Configuration', '設定'], type: ['Type', '種類'], bump: ['Version bump', 'バージョン更新'],
  tool: ['Tool', 'ツール'], tools: ['Tools', 'ツール'], agent: ['Agent', 'エージェント'], agents: ['Agents', 'エージェント'],
  agentTool: ['Agent tool', 'エージェントツール'], agentInternalId: ['Agent internal ID', 'エージェント内部ID'],
  skills: ['Skills', 'スキル'], targetSkillId: ['Target skill ID', '対象スキルID'], harness: ['Multi-Agent', 'マルチエージェント'],
  slots: ['Slots', 'スロット'], persona: ['Persona', 'ペルソナ'], personaVersion: ['Persona version', 'ペルソナバージョン'],
  personaCount: ['Persona count', 'ペルソナ数'], pseudoUser: ['Pseudo user', '疑似ユーザー'],
  scenarioId: ['Scenario ID', 'シナリオID'], scenarioCount: ['Scenario count', 'シナリオ数'],
  dataset: ['Dataset', 'データセット'], cases: ['Cases', 'ケース'], input: ['Input', '入力'], output: ['Output', '出力'],
  inputSchema: ['Input schema', '入力スキーマ'], outputSchema: ['Output schema', '出力スキーマ'],
  inputDescription: ['Input description', '入力の説明'], outputDescription: ['Output description', '出力の説明'],
  reference: ['Reference answer', '参照解'], referencePolicy: ['Reference policy', '参照ポリシー'],
  evaluatorProfile: ['Evaluator profile', '評価者プロファイル'], metrics: ['Metrics', '指標'], criteria: ['Criteria', '評価基準'],
  policies: ['Policies', 'ポリシー'], rules: ['Rules', 'ルール'], targets: ['Targets', '対象'], target: ['Target', '対象'],
  format: ['Format', '形式'], content: ['Content', '内容'], title: ['Title', 'タイトル'], body: ['Body', '本文'],
  tags: ['Tags', 'タグ'], fields: ['Fields', '項目'], columns: ['Columns', '列'], required: ['Required', '必須'],
  nullable: ['Nullable', 'NULL許可'], pattern: ['Pattern', 'パターン'], min: ['Minimum', '最小値'], max: ['Maximum', '最大値'],
  from: ['From', '開始'], to: ['To', '終了'], toInput: ['Target input', '接続先入力'],
  query: ['Query', 'クエリ'], q: ['Search keyword', '検索キーワード'], limit: ['Limit', '取得上限'],
  status: ['Status', '状態'], state: ['State', '状態'], provider: ['Provider', 'プロバイダ'],
  connectionId: ['Connection ID', '接続ID'], defaultSchema: ['Default schema', '既定スキーマ'],
  dataSourceIds: ['Data source IDs', 'データソースID'], dataUrl: ['Data URL', 'データURL'], images: ['Images', '画像'],
  goal: ['Goal', 'ゴール'], options: ['Options', 'オプション'], context: ['Context', 'コンテキスト'],
  constraints: ['Constraints', '制約'], budget: ['Budget', '予算'], planning: ['Planning', '計画'],
  approvals: ['Approvals', '承認'], memory: ['Memory', '記憶'], survey: ['Survey', 'アンケート'],
  requirePlanApproval: ['Plan approval requirement', '計画承認の要否'], patience: ['Patience', '忍耐度'],
  promptStrategy: ['Prompt strategy', 'プロンプトの扱い'],
  knowledgeLevel: ['Knowledge level', '知識レベル'], archetype: ['Archetype', 'アーキタイプ'], tone: ['Tone', 'トーン'],
  verbosity: ['Verbosity', '詳細度'], usage: ['Usage', '用途'], assignment: ['Assignment', '割り当て'],
  responsibility: ['Responsibility', '責務'], activationCondition: ['Activation condition', '起動条件'],
  expectedTools: ['Expected tools', '期待するツール'], extraInstructions: ['Extra instructions', '追加指示'],
  promptOverride: ['Prompt override', 'プロンプト上書き'], decision: ['Decision', '判定'],
  feedback: ['Feedback', 'フィードバック'], response: ['Response', '応答'], failure: ['Failure', '失敗内容'],
  sessionId: ['Session ID', 'セッションID'], runId: ['Run ID', '実行ID'], sourceRunId: ['Source run ID', '元実行ID'],
  wikiId: ['Wiki ID', 'WikiID'], wikis: ['Wikis', 'Wiki'], targetWikiId: ['Target wiki ID', '対象WikiID'],
  memoryPageIds: ['Memory page IDs', '記憶ページID'], existingWikiPageId: ['Existing wiki page ID', '既存Wikiページ ID'],
  rowLimit: ['Row limit', '取得行数'], maxResults: ['Max results', '最大件数'], includeDomains: ['Included domains', '対象ドメイン'],
  maxIterations: ['Max iterations', '最大反復回数'], maxDurationMs: ['Max duration (ms)', '最大実行時間(ms)'],
  maxRepairAttempts: ['Max repair attempts', '最大修復試行回数'], maxUserTurns: ['Max user turns', '最大ユーザーターン数'],
  maxRoleCalls: ['Max role calls', '最大ロール呼び出し数'], maxScenarioRuns: ['Max scenario runs', '最大シナリオ実行数'],
  maxProposalsPerIteration: ['Max proposals per iteration', '反復あたり最大提案数'],
  repetitions: ['Repetitions', '繰り返し回数'], targetUsers: ['Target users', '対象ユーザー'],
  language: ['Language', '言語'], textEn: ['English text', '英語テキスト'], textJa: ['Japanese text', '日本語テキスト'],
};

/** Zod の `expected <type>` → 型の言い換え。 */
const TYPES: Record<string, Bilingual> = {
  string: ['must be text', '文字列を入力してください'],
  number: ['must be a number', '数値を入力してください'],
  int: ['must be a whole number', '整数を入力してください'],
  bigint: ['must be a whole number', '整数を入力してください'],
  boolean: ['must be true or false', 'true または false を指定してください'],
  array: ['must be a list', '配列を指定してください'],
  object: ['must be an object', 'オブジェクトを指定してください'],
  date: ['must be a date', '日付を指定してください'],
};

const REQUEST_LABEL = /^invalid (?:body|query|request|params|input):\s*/i;
// `-` を許すのは、診断の graph 検査が `<nodeId>: <issue>` の形（nodeId は `filter-1` など）で届くため。
// Zod のフィールドパスに `-` は現れないので、既存の挙動は変わらない。
const FIELD_PATH = /^(\(root\)|[A-Za-z0-9_.-]+):\s+(.+)$/;

/**
 * **モデル「実行」の失敗**だけを次の行動が分かる文言へ置き換える対象コード。
 *
 * `code.startsWith('MODEL')` の前方一致にすると、モデル設定の入力不正（`MODEL_SETTINGS_VALIDATION`・400）や
 * モデル一覧の取得失敗（`MODEL_CATALOG`・502）まで「モデル実行に失敗しました」に化ける。
 * どちらも実行前の設定操作なので、完全一致リストで実行エラーとは分けて扱う。
 */
const MODEL_RUN_CODES = new Set(['MODEL_PROVIDER', 'JUDGE_PROVIDER']);
/** MODEL 接頭辞を持つが実行エラーではないコード（見出し + 原文で扱う）。 */
const MODEL_SETTINGS_CODES = new Set(['MODEL_SETTINGS_VALIDATION', 'MODEL_CATALOG']);

function isModelFailure(code: string, raw: string): boolean {
  if (MODEL_SETTINGS_CODES.has(code)) return false;
  return MODEL_RUN_CODES.has(code) || raw.includes('LM Studio');
}

/**
 * モデル実行失敗の文言。**プロバイダ中立**にする（v36でモデルプロバイダを選べるようになったため、
 * OpenAI のキー誤りに「LM Studioを確認」と促すのは誤誘導）。ローカル LM Studio 利用者向けの
 * 確認事項は括弧の補足に留める。
 */
function modelMessage(raw: string, language: ErrorLanguage): string {
  const ja = language === 'ja';
  const suggestion = toolCheckSuggestionMessage(raw, ja);
  if (suggestion !== undefined) return suggestion;
  if (/not configured/i.test(raw)) {
    return ja
      ? 'モデルが未設定です。設定画面でモデルを選ぶか、環境変数 LM_STUDIO_MODEL を設定してください。'
      : 'The model is not configured. Choose a model in model settings, or set the LM_STUDIO_MODEL environment variable.';
  }
  if (/abort|timed out|timeout/i.test(raw)) {
    return ja
      ? 'モデル実行がタイムアウトしました。モデルサーバーの応答とモデルのロード状況を確認して再試行してください（ローカルLM Studioを使う場合は起動しているか確認）。'
      : 'The model run timed out. Check that the model server responds and the model is loaded, then retry (if you use a local LM Studio, check that it is running).';
  }
  const http = /HTTP (\d{3})/.exec(raw);
  if (http !== null) {
    if (http[1] === '401' || http[1] === '403') {
      return ja
        ? `モデルサーバーの認証に失敗しました（HTTP ${http[1]}）。設定画面のAPIキーを確認して再試行してください。`
        : `The model server rejected the credentials (HTTP ${http[1]}). Check the API key in model settings, then retry.`;
    }
    return ja
      ? `モデルサーバーがHTTP ${http[1]} を返しました。設定画面のモデル設定とエンドポイントを確認して再試行してください。`
      : `The model server returned HTTP ${http[1]}. Check the model settings and endpoint, then retry.`;
  }
  if (/invalid|non-object|no completion/i.test(raw)) {
    return ja
      ? 'モデルの応答を解釈できませんでした。ツール呼び出しに対応したモデルを選び直すか、プロンプトを短くして再試行してください。'
      : 'The model response could not be parsed. Pick a tool-capable model or shorten the prompt, then retry.';
  }
  if (/fail|refus|econnrefused|fetch|connect/i.test(raw)) {
    return ja
      ? 'モデルサーバーに接続できませんでした。設定画面のモデル設定とエンドポイントを確認してください（ローカルLM Studioを使う場合は起動しているか確認）。'
      : 'Could not reach the model server. Check the model settings and endpoint (if you use a local LM Studio, check that it is running).';
  }
  const detail = raw === '' ? '' : (ja ? `（${raw}）` : ` (${raw})`);
  return ja
    ? `モデル実行に失敗しました。設定画面のモデル設定を確認して再試行してください。${detail}`
    : `The model run failed. Check the model settings, then retry.${detail}`;
}

/**
 * ツール検証の「LLM でケースを提案」（POST /tool-checks/suggest、502 MODEL_PROVIDER）の失敗文言。
 * 汎用のモデル実行文言（「モデルが未設定」「応答を解釈できない」）より先に判定する。提案は構造化出力
 * （JSON スキーマ）に依存するので、次の一手は「設定画面で対応モデルを確認 → もう一度提案 → focus を具体的に」。
 * サーバー定型文（src/application/tool-check/suggest と対で保守）:
 * `tool check suggestions are not configured` / `... returned invalid JSON` / `... returned no usable case`
 */
function toolCheckSuggestionMessage(raw: string, ja: boolean): string | undefined {
  if (!/tool check suggestion/i.test(raw)) return undefined;
  if (/not configured/i.test(raw)) {
    return ja
      ? 'ケース提案に使うモデルが設定されていません。設定画面で構造化出力（JSON スキーマ）に対応したモデルを選んでから、もう一度提案してください。'
      : 'No model is configured for case suggestions. Choose a model that supports structured output (JSON schema) in Settings, then suggest again.';
  }
  if (/invalid JSON/i.test(raw)) {
    return ja
      ? 'モデルの応答が JSON として読めませんでした。設定画面で構造化出力に対応したモデルか確認し、もう一度提案してください。続くときは「重点」を具体的に書くと安定します。'
      : 'The model reply was not valid JSON. Check in Settings that the model supports structured output, then suggest again. If it keeps happening, make the focus more specific.';
  }
  if (/no usable case/i.test(raw)) {
    return ja
      ? 'モデルは使えるケースを 1 件も返しませんでした（引数がツールの入力に合わない等）。「重点」を具体的に書いてもう一度提案するか、設定画面で別のモデルを試してください。'
      : 'The model returned no usable case (for example, arguments that do not match the tool input). Make the focus more specific and suggest again, or try another model in Settings.';
  }
  return undefined;
}

function statusHeading(status: number, language: ErrorLanguage): string {
  const known = STATUS_HEADINGS[status];
  if (known !== undefined) return pick(known, language);
  if (status >= 500) return pick(SERVER_HEADING, language);
  if (status >= 400) return pick(CLIENT_HEADING, language);
  return pick(GENERIC_HEADING, language);
}

function localizeFieldPath(path: string, language: ErrorLanguage): string {
  return path.split('.').map((part) => {
    const known = FIELDS[part];
    if (known !== undefined) return pick(known, language);
    if (/^\d+$/.test(part)) return language === 'ja' ? `${Number(part) + 1}件目` : `#${Number(part) + 1}`;
    return part;
  }).join('.');
}

/** join / analyze系ノードが使うデータ型 → 表示用の日本語名（ETLの型不一致メッセージで使う）。 */
const DATA_TYPE_JA: Record<string, string> = {
  string: '文字列', number: '数値', boolean: '真偽値', date: '日付', null: 'NULL', unknown: '不明',
};

/**
 * ETL（Tool Builder）固有の定型文の日本語化。src/domain/etl の GraphError / ConfigError /
 * SchemaError、および SchemaIssue.message（ノード単位の伝播issue）が生成する英語定型文をここで拾う。
 *
 * 英語UIでは原文で十分に情報量があるため、ja のときだけ変換し、en は常に undefined を返して
 * 呼び出し側（localizeMessageText / localizeSchemaIssueMessage）に原文の保持を委ねる。
 */
function localizeEtlDetail(message: string, language: ErrorLanguage): string | undefined {
  if (language !== 'ja') return undefined;

  // 先頭の言い換えに続けて「次に何をするか」を添える（先頭句は既存表示・テストと合わせて固定）。
  let matched = /^node '(.+)' \(type '(.+)'\) expects (\d+) input\(s\) but has in-degree (\d+)$/.exec(message);
  if (matched !== null) return `ノード「${matched[1]}」(${matched[2]})には${matched[3]}本の入力が必要ですが、${matched[4]}本接続されています。ノード「${matched[1]}」への接続を${matched[3]}本に直してください（余分な接続を外すか、足りない入力をつなぐ）`;

  matched = /^graph must have exactly one terminal node, found (\d+): (.+)$/.exec(message);
  if (matched !== null) return `グラフの終端ノードは1つだけにしてください(現在${matched[1]}個: ${matched[2]})。${matched[2]} のうち1つだけを最終出力として残し、他のノードは削除するか下流へつないでください`;

  if (message === 'graph has no terminal node (out-degree 0)') return '終端ノード(出力)がありません。「出力」からエージェント出力などのノードを置き、最後のノードにつないでください';
  if (message === 'graph has a cycle') return 'グラフに循環(ループ)があります。下流から上流へ戻っている接続を1本外してください';

  matched = /^duplicate node id: (.+)$/.exec(message);
  if (matched !== null) return `ノードID「${matched[1]}」が重複しています`;

  matched = /^edge references unknown node id: (.+)$/.exec(message);
  if (matched !== null) return `存在しないノード「${matched[1]}」への接続があります`;

  matched = /^sink node '(.+)' must be terminal \(no downstream nodes\)$/.exec(message);
  if (matched !== null) return `出力ノード「${matched[1]}」の後ろにノードは繋げられません`;

  matched = /^edge to '(.+)' uses input port (\d+) but node type '(.+)' accepts (\d+) input\(s\)$/.exec(message);
  if (matched !== null) return `ノード「${matched[1]}」の入力ポート${matched[2]}は範囲外です(${matched[3]}の入力は${matched[4]}本)`;

  matched = /^node '(.+)' has multiple edges on input port (\d+)$/.exec(message);
  if (matched !== null) return `ノード「${matched[1]}」の入力ポート${matched[2]}に複数の接続があります`;

  matched = /^node '(.+)' \(type '(.+)'\) requires explicit input ports on incoming edges$/.exec(message);
  if (matched !== null) return `ノード「${matched[1]}」への接続には入力ポートの指定が必要です`;

  matched = /^join: key column\(s\) not found: (.+)$/.exec(message);
  if (matched !== null) return `結合キーの列が見つかりません: ${matched[1]}。結合(join)ノードのキー列「${matched[1]}」を、左右の入力に実際にある列名へ直してください`;

  matched = /^([A-Za-z][A-Za-z0-9_-]*): column\(s\) must be number: (.+)$/.exec(message);
  if (matched !== null) return `数値列が必要です: ${matched[2]}`;

  // 列不存在（`select` / `sort` / `group-by` などが共通で使う形。join のキー専用形は上で処理済み）。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): column\(s\) not found: (.+)$/.exec(message);
  if (matched !== null) return `列が見つかりません: ${matched[2]}。${matched[1]}ノードで参照している列「${matched[2]}」を上流ノードの出力にある列名へ直すか、上流ノードの設定を見直してください`;

  // 単一列の型不一致（chart-output / analysis-utils / group-by が使う形）。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): column '(.+)' must be (.+)$/.exec(message);
  if (matched !== null) {
    const types = (matched[3] ?? '').split(/ or |, /).map((type) => DATA_TYPE_JA[type.trim()] ?? type.trim()).join(' / ');
    return `列「${matched[2]}」の型は ${types} が必要です。${matched[1]}ノードの手前に「型変換」(cast)ノードを挟んで列「${matched[2]}」を変換するか、別の列を選んでください`;
  }

  matched = /^([A-Za-z][A-Za-z0-9_-]*): duplicate aggregate name: (.+)$/.exec(message);
  if (matched !== null) return `集計の出力列名が重複しています: ${matched[2]}`;

  matched = /^([A-Za-z][A-Za-z0-9_-]*): aggregate '(.+)' requires a column for op '(.+)'$/.exec(message);
  if (matched !== null) return `集計「${matched[2]}」には ${matched[3]} の対象列が必要です`;

  // filter の opBinding（演算子のAI引数化）の検証（src/domain/etl/nodes/filter.ts）。
  matched = /^filter: default operator '(.+)' is not in opBinding\.allowed \((.+)\)$/.exec(message);
  if (matched !== null) return `既定の演算子「${matched[1]}」がAIに許可する演算子(${matched[2]})に含まれていません`;

  // セミコロンを含む1つの文。localizeDetail の `;` 分割より先の丸ごと判定（etlWhole）で拾う。
  matched = /^filter: opBinding on '(.+)' allows operator\(s\) (.+) which require column type number\|date, but '.+' is '(.+)'; restrict opBinding\.allowed$/.exec(message);
  if (matched !== null) return `列「${matched[1]}」(${DATA_TYPE_JA[matched[3] ?? ''] ?? matched[3]})では大小比較の演算子(${matched[2]})をAIに許可できません。AIに許可する演算子を絞ってください`;

  if (/^join: output exceeded 100,?000 rows(?:;\s*check join keys)?\.?$/.test(message)) return '結合結果が10万行を超えました。結合キーが正しいか確認してください';

  // 実行上限（engine.preview の maxRows）。計算は全行で行うため、切り詰めではなくエラーで止まる。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): produced ([\d,]+) rows, exceeding the execution limit of ([\d,]+) rows$/.exec(message);
  if (matched !== null) return `ノード（${matched[1]}）の出力が ${Number(matched[2]?.replace(/,/g, '')).toLocaleString('ja-JP')} 行になり、実行上限の ${Number(matched[3]?.replace(/,/g, '')).toLocaleString('ja-JP')} 行を超えました。上流でフィルタや集計を入れて行数を減らすか、データソースの範囲を絞ってください`;

  matched = /^preview: rowLimit must be a non-negative integer, received (.+)$/.exec(message);
  if (matched !== null) return `プレビューの表示行数（rowLimit）は 0 以上の整数で指定してください（受け取った値: ${matched[1]}）`;

  matched = /^preview: maxRows must be a positive integer, received (.+)$/.exec(message);
  if (matched !== null) return `実行上限（maxRows）は 1 以上の整数で指定してください（受け取った値: ${matched[1]}）`;

  // 時系列の欠損補完の上限。セミコロンを含む1文なので localizeDetail の分割前（etlWhole）で拾う。
  matched = /^time-series-analysis: fill would generate more than ([\d,]+) buckets; narrow the time range or choose a coarser interval$/.exec(message);
  if (matched !== null) return `時系列分析の欠損補完が ${Number(matched[1]?.replace(/,/g, '')).toLocaleString('ja-JP')} バケットを超えます。期間（timeColumn の範囲）を狭めるか、interval を粗く（時間→日→週）してください`;

  matched = /^join: key type mismatch: (.+) \('(.+)'\) vs (.+) \('(.+)'\)$/.exec(message);
  if (matched !== null) {
    const leftType = DATA_TYPE_JA[matched[2] ?? ''] ?? matched[2];
    const rightType = DATA_TYPE_JA[matched[4] ?? ''] ?? matched[4];
    return `結合キーの型が一致しません: ${matched[1]} (${leftType}) と ${matched[3]} (${rightType})`;
  }

  matched = /^join: key type may mismatch: (.+) \('(.+)'\) vs (.+) \('(.+)'\)$/.exec(message);
  if (matched !== null) {
    const leftType = DATA_TYPE_JA[matched[2] ?? ''] ?? matched[2];
    const rightType = DATA_TYPE_JA[matched[4] ?? ''] ?? matched[4];
    return `結合キーの型が一致しない可能性があります: ${matched[1]} (${leftType}) と ${matched[3]} (${rightType})`;
  }

  matched = /^join: keys compared as text: (.+) \('(.+)'\) vs (.+) \('(.+)'\)$/.exec(message);
  if (matched !== null) {
    const leftType = DATA_TYPE_JA[matched[2] ?? ''] ?? matched[2];
    const rightType = DATA_TYPE_JA[matched[4] ?? ''] ?? matched[4];
    return `結合キーを文字列として比較します: ${matched[1]} (${leftType}) と ${matched[3]} (${rightType})`;
  }

  // SchemaIssue頻出形（ノード単位の伝播issue。localizeSchemaIssueMessage経由でも使う）。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): mapping '(.+)' is required$/.exec(message);
  if (matched !== null) return `${matched[1]}: 「${matched[2]}」の設定が必要です`;

  matched = /^([A-Za-z][A-Za-z0-9_-]*): invalid config: (.+)$/.exec(message);
  if (matched !== null) return `${matched[1]}: 設定が不正です(${localizeDetail(matched[2] ?? '', 'ja')})。${matched[1]}ノードの設定パネルで該当項目を直してください`;

  matched = /^upstream node '(.+)' has invalid config$/.exec(message);
  if (matched !== null) return `上流ノード「${matched[1]}」の設定が不正です`;

  matched = /^union: strict mode requires identical column sets, mismatched: (.+)$/.exec(message);
  if (matched !== null) return `union: 列構成が一致しません(厳密一致モード): ${matched[1]}`;

  matched = /^([A-Za-z][A-Za-z0-9_-]*): input column '(.+)' conflicts with generated column$/.exec(message);
  if (matched !== null) return `${matched[1]}: 入力列「${matched[2]}」が自動生成される列と重複しています`;

  return undefined;
}

/**
 * エージェント実行の内部エラー（`AGENT_RUN` / `TOOL_ARGUMENTS` / `UNSAFE_TOOL`）の定型文。
 *
 * `src/application/agent/**` が投げる英語メッセージはそのままだと「何が起きたか」しか分からず、
 * **次に何をすればよいか**が書かれていない（これがこの層の一番の空白だった）。ここでは
 * 原因の言い換えに加えて必ず次の一手（モデルを替える / ツールを繋ぐ / 質問を分ける等）を添える。
 *
 * `modelMessage()` と同じく **en / ja 両方**を返す（原文は「何が起きたか」しか語らないので、
 * 英語UIでも原文のままでは次の一手が分からない）。未知の形は undefined を返し、
 * 呼び出し側が原文を括弧で残す。
 */
function localizeAgentRunDetail(message: string, language: ErrorLanguage): string | undefined {
  const ja = language === 'ja';

  // --- モデルがツールを呼び間違えた / 呼べない ---------------------------------
  let matched = /^(?:model requested unknown tool|unknown MCP tool|unknown runtime harness tool): (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルが存在しないツール「${matched[1]}」を呼ぼうとしました。エージェントに必要なツールが接続されているか確認してください`
      : `the model called a tool named '${matched[1]}' that is not connected. Check the tools attached to this agent`;
  }

  matched = /^MCP tool '(.+)' is unavailable: its MCP server could not be resolved for this run$/.exec(message);
  if (matched !== null) {
    return ja
      ? `MCPツール「${matched[1]}」のMCPサーバーへ接続できませんでした。MCP設定画面で接続をテストしてから、もう一度実行してください`
      : `the MCP server behind '${matched[1]}' could not be reached. Test the connection in MCP settings, then run again`;
  }

  if (message === 'model reported tool_calls without a tool call') {
    return ja
      ? 'モデルが「ツールを呼ぶ」と応答しながら呼び出す内容を返しませんでした。ツール呼び出しに対応したモデルを選び直してください'
      : 'the model said it would call a tool but returned no call. Pick a model with reliable tool-calling support';
  }
  if (message === 'model requested a tool call but function invocation is disabled for this agent') {
    return ja
      ? 'このエージェントはツールの自動実行が無効ですが、モデルがツールを呼ぼうとしました。ハーネス設定でツール実行を有効にするか、ツールの接続を外してください'
      : 'tool execution is turned off for this agent but the model tried to call a tool. Enable tool execution in the harness settings, or detach the tools';
  }

  // --- 上限・予算 -------------------------------------------------------------
  matched = /^tool call limit exceeded: maximum (\d+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `1回の実行で使えるツール呼び出しの上限（${matched[1]}回）に達しました。目的を分けて質問するか、エージェントのハーネス設定で上限を広げてください`
      : `the run hit its tool-call limit (${matched[1]}). Split the request into smaller questions, or raise the limit in the agent harness settings`;
  }

  matched = /^model round limit exceeded: maximum (\d+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルとの往復回数の上限（${matched[1]}回）に達しました。手順が少なく済むよう指示を具体的にするか、エージェントのハーネス設定で上限を広げてください`
      : `the run hit its model round limit (${matched[1]}). Make the request more specific so it needs fewer steps, or raise the limit in the agent harness settings`;
  }

  matched = /^run budget exhausted: (model rounds|tool calls)$/.exec(message);
  if (matched !== null) {
    const what = matched[1] === 'model rounds' ? (ja ? 'モデル往復' : 'model rounds') : (ja ? 'ツール呼び出し' : 'tool calls');
    return ja
      ? `実行全体の${what}の予算を使い切りました。サブエージェントへの委譲を減らすか、質問を分けて実行してください`
      : `the run used up its shared budget for ${what}. Delegate to fewer sub-agents, or split the request`;
  }

  // --- 構造化出力 -------------------------------------------------------------
  matched = /^structured response is missing required field '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルの応答に必要な項目「${matched[1]}」がありませんでした。別のモデルを試すか、構造化出力の項目を減らしてください`
      : `the model response was missing the required field '${matched[1]}'. Try another model, or reduce the structured output fields`;
  }

  matched = /^structured response contains unknown field '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルの応答に定義していない項目「${matched[1]}」が含まれていました。構造化出力の定義を見直すか、別のモデルを試してください`
      : `the model response contained an undeclared field '${matched[1]}'. Review the structured output definition, or try another model`;
  }

  matched = /^structured response field '(.+)' must be (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルの応答の項目「${matched[1]}」の型が違います（${matched[2]} が必要）。別のモデルを試すか、構造化出力の型を見直してください`
      : `the model returned the wrong type for '${matched[1]}' (expected ${matched[2]}). Try another model, or review the field type`;
  }

  if (message === 'structured response is not valid JSON' || message === 'structured response must be a JSON object') {
    return ja
      ? 'モデルの応答をJSONとして解釈できませんでした。構造化出力に対応したモデルを選び直すか、構造化出力の項目を減らしてください'
      : 'the model response could not be read as JSON. Pick a model that supports structured output, or reduce the fields';
  }

  // --- モデルの能力不足 -------------------------------------------------------
  matched = /^configured model provider does not support (tool-calling|structured output|image input)$/.exec(message);
  if (matched !== null) {
    if (matched[1] === 'tool-calling') {
      return ja
        ? '選択中のモデルはツール呼び出しに対応していません。設定画面でツール呼び出しに対応したモデルへ切り替えてください'
        : 'the selected model does not support tool calling. Switch to a tool-capable model in model settings';
    }
    if (matched[1] === 'structured output') {
      return ja
        ? '選択中のモデルは構造化出力に対応していません。設定画面で対応モデルへ切り替えるか、エージェントの構造化出力を外してください'
        : 'the selected model does not support structured output. Switch models in model settings, or remove the structured output from this agent';
    }
    return ja
      ? '選択中のモデルは画像入力に対応していません。画像を外して送るか、設定画面で画像対応のモデルへ切り替えてください'
      : 'the selected model does not accept images. Send without the attachments, or switch to a vision model in model settings';
  }

  // --- ツール引数（TOOL_ARGUMENTS） -------------------------------------------
  matched = /^required argument missing: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルがツールの必須引数「${matched[1]}」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください`
      : `the model omitted the required tool argument '${matched[1]}'. Describe that argument more concretely in the tool, or state its value in your request`;
  }

  // received 部は新形式のみ持つ（旧Runの保存済みトレースには無い）ため任意マッチにする。
  matched = /^invalid argument '(.+)': expected (\w+)(?:, received (.+))?$/.exec(message);
  if (matched !== null) {
    const received = matched[3];
    return ja
      ? `ツールの引数「${matched[1]}」の型が違います（${matched[2]} が必要${received === undefined ? '' : `、受け取った値: ${received}`}）。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください`
      : `the tool argument '${matched[1]}' had the wrong type (expected ${matched[2]}${received === undefined ? '' : `, received ${received}`}). Describe that argument more concretely in the tool, or state its value in your request`;
  }

  matched = /^unknown argument\(s\): (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルがツールに存在しない引数「${matched[1]}」を渡しました。ツールの引数定義とプロンプトの説明を見直してください`
      : `the model passed arguments the tool does not accept: ${matched[1]}. Review the tool argument definition and its description`;
  }

  // --- 副作用ガード（UNSAFE_TOOL） --------------------------------------------
  matched = /^Agent preview refuses (\S+) effective side-effect for (?:additional sub-)?agent '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `エージェント「${matched[2]}」は副作用「${matched[1]}」を持つためプレビュー実行できません。読み取り専用（read-only / session-write）のツールだけを接続してください`
      : `agent '${matched[2]}' has the '${matched[1]}' side effect, which preview runs refuse. Attach only read-only or session-write tools`;
  }

  matched = /^Agent preview refuses (\S+) tool '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツール「${matched[2]}」は副作用「${matched[1]}」を持つためプレビュー実行できません。読み取り専用（read-only / session-write）のツールへ差し替えてください`
      : `tool '${matched[2]}' has the '${matched[1]}' side effect, which preview runs refuse. Replace it with a read-only or session-write tool`;
  }

  // --- 承認・セッション・記憶 -------------------------------------------------
  matched = /^run '(.+)' is not waiting for approval$/.exec(message);
  if (matched !== null) {
    return ja
      ? `実行「${matched[1]}」は承認待ちではありません。画面を開き直して最新の状態を確認してください`
      : `run '${matched[1]}' is not waiting for approval. Reopen the screen to see its current state`;
  }

  matched = /^(?:run '.+' )?approval checkpoint expired at (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツール承認の期限（${matched[1]}）が切れました。同じ指示をもう一度送り直してください`
      : `the tool approval expired at ${matched[1]}. Send the same request again`;
  }

  if (message === 'agent session belongs to a different Agent version') {
    return ja
      ? 'このセッションは別バージョンのエージェントのものです。「新しいチャット」を開始してください'
      : 'this session belongs to a different agent version. Start a new chat';
  }

  matched = /^memory page '(.+)' is outside Agent wiki allowlist$/.exec(message);
  if (matched !== null) {
    return ja
      ? `記憶ページ「${matched[1]}」はこのエージェントが参照できるWikiの範囲外です。エージェントの参照Wiki設定を確認してください`
      : `memory page '${matched[1]}' is outside the wikis this agent may read. Check the agent's wiki settings`;
  }

  matched = /^workspace artifact not found: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `セッション内の成果物「${matched[1]}」が見つかりませんでした。「新しいチャット」を開始してやり直してください`
      : `the session artifact '${matched[1]}' no longer exists. Start a new chat and try again`;
  }

  if (message === 'web_search has no configured search provider') {
    return ja
      ? 'Web検索に使う検索プロバイダが設定されていません。設定画面で検索プロバイダを登録してください'
      : 'no search provider is configured for web search. Register one in settings';
  }

  // --- 構成・定義の不整合 -----------------------------------------------------
  if (message === 'saved Agent execution is not configured') {
    return ja
      ? '保存済みエージェントを実行できる構成になっていません。サーバーの起動設定を確認してください'
      : 'saved agent execution is not wired up on this server. Check the server startup configuration';
  }

  matched = /^additional sub-agent not found: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `委譲先のサブエージェント「${matched[1]}」が見つかりませんでした。該当バージョンが削除されていないか確認してください`
      : `the sub-agent '${matched[1]}' was not found. Check whether that version was deleted`;
  }

  matched = /^filter node '(.+)' references an unavailable Agent input$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツールのフィルタ「${matched[1]}」が受け取れない引数を参照しています。ツール画面で引数（Agent Input）の宣言と接続を見直してください`
      : `the filter node '${matched[1]}' references an argument the tool never receives. Review the Agent Input declaration and its wiring`;
  }

  matched = /^tool inputSchema does not match agent-input node '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツールの引数定義とAgent Inputノード「${matched[1]}」の列が一致していません。ツール画面で引数を保存し直してください`
      : `the tool argument definition does not match the Agent Input node '${matched[1]}'. Save the arguments again in the tool screen`;
  }

  if (message === 'tool declares inputSchema but has no agent-input node') {
    return ja
      ? 'ツールが引数を宣言していますが、受け取るAgent Inputノードがありません。ツール画面で引数ノードを追加してください'
      : 'the tool declares arguments but has no Agent Input node to receive them. Add the argument node in the tool screen';
  }

  // SaveTool の opBinding（演算子のAI引数化）検証。TOOL_VALIDATION の詳細として出る（application/tool/save-tool.ts）。
  matched = /^SaveTool: operator binding for argument '(.+)' requires a string argument, but it is declared as '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `演算子を受け取る引数「${matched[1]}」は string 型で宣言する必要がありますが、${matched[2]} 型になっています。Agent Inputノードで型を string に変更してください`
      : `the operator-bound argument '${matched[1]}' must be a string argument, but it is declared as '${matched[2]}'. Change its type to string on the Agent Input node`;
  }

  matched = /^SaveTool: operator binding for argument '(.+)' has no operator that every condition allows$/.exec(message);
  if (matched !== null) {
    return ja
      ? `引数「${matched[1]}」で演算子を受け取る条件の間に、共通して許可された演算子が1つもありません。各条件の「AIに許可する演算子」を見直してください`
      : `no operator is allowed by every condition that binds argument '${matched[1]}'. Align the allowed operator lists of those conditions`;
  }

  if (message === 'SaveTool: operator binding is missing its input field') {
    return ja
      ? '演算子をエージェント入力から受け取る設定に、参照する入力フィールドが選ばれていません。フィルタ条件の「エージェント入力フィールド（演算子）」を選択してください'
      : 'an operator binding has no input field selected. Pick the agent input field (operator) on the filter condition';
  }

  if (message === 'SaveTool: value binding is missing its input field') {
    return ja
      ? '条件値をエージェント入力から受け取る設定に、参照する入力フィールドが選ばれていません。フィルタ条件の「エージェント入力フィールド」を選択してください'
      : 'a value binding has no input field selected. Pick the agent input field on the filter condition';
  }

  matched = /^SaveTool: argument '(.+)' is bound as both a comparison value and an operator; declare two separate arguments$/.exec(message);
  if (matched !== null) {
    return ja
      ? `引数「${matched[1]}」が比較値と演算子の両方に束縛されています。Agent Inputノードで引数を2つに分けて宣言し、それぞれを束縛してください`
      : `the argument '${matched[1]}' is bound as both a comparison value and an operator. Declare two separate arguments on the Agent Input node and bind them individually`;
  }

  matched = /^SaveTool: operator binding allows isNull\/notNull, so the value argument '(.+)' must be nullable$/.exec(message);
  if (matched !== null) {
    return ja
      ? `AIに許可する演算子に isNull/notNull が含まれるため、値を受け取る引数「${matched[1]}」は任意（nullable）にする必要があります。Agent Inputノードでその引数を任意に変更してください`
      : `the operator binding allows isNull/notNull, so the value argument '${matched[1]}' must be nullable. Mark that argument as optional on the Agent Input node`;
  }

  matched = /^SaveTool: operator binding for argument '(.+)' must use the same default operator in every condition$/.exec(message);
  if (matched !== null) {
    return ja
      ? `引数「${matched[1]}」で演算子を受け取る条件の間で「既定の演算子」が一致していません。各条件の既定の演算子を同じ値に揃えてください`
      : `the conditions that bind argument '${matched[1]}' use different default operators. Set the same default operator on every condition`;
  }

  // --- ツール定義（保存時 SaveTool / createTool）と実行時の同形メッセージ ------------
  // 保存時は `SaveTool: ` が付き、実行時・診断では付かない。どちらも同じ直し方なので前置詞は任意にする。
  if (message === 'SaveTool: workspace output requires sideEffect session-write or stronger') {
    return ja
      ? 'ワークスペース出力ノードを使うツールは副作用を session-write 以上にする必要があります。ツール画面のメタデータで副作用を session-write に変更してください'
      : 'a tool with a workspace-output node needs side effect session-write or stronger. Set the side effect to session-write in the Tool Builder metadata';
  }

  if (message === 'SaveTool: Agent input bindings require an inputSchema') {
    return ja
      ? 'フィルタ条件がエージェント入力を参照していますが、ツールに引数（inputSchema）が宣言されていません。Agent Inputノードを追加して引数を宣言してください'
      : 'a filter condition binds an agent input, but the tool declares no arguments (inputSchema). Add an Agent Input node and declare the arguments';
  }

  matched = /^SaveTool: Agent input binding references unknown field '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `フィルタ条件が宣言されていない引数「${matched[1]}」を参照しています。Agent Inputノードに「${matched[1]}」を追加するか、条件の参照先を既存の引数に変更してください`
      : `a filter condition references the undeclared argument '${matched[1]}'. Add '${matched[1]}' to the Agent Input node, or point the condition at an existing argument`;
  }

  // 保存時（SaveTool:）と診断（output-schema 検査。末尾に「実行後に落ちる／再保存」の注記が付く）の両形。
  matched = /^(?:SaveTool: )?declared output schema does not match the graph's inferred output \((.+?)\)(?: — the run fails after the tool executes; re-save the tool to refresh its output schema)?$/.exec(message);
  if (matched !== null) {
    const detail = localizeSchemaIncompatibility(matched[1] ?? '', language);
    return ja
      ? `宣言した出力スキーマがグラフから推論した出力と一致しません（${detail}）。ツール画面で出力スキーマを更新して保存し直してください`
      : `the declared output schema does not match the output inferred from the graph (${detail}). Refresh the output schema in the Tool Builder and save again`;
  }

  if (message === 'createTool: agentTool.name must be a valid function name') {
    return ja
      ? 'エージェント向けのツール名が関数名として使えません。ツール画面の「エージェント向けコンテキスト」で、英数字・_・- のみ1〜64文字の名前を設定してください'
      : 'the agent-facing tool name is not a valid function name. In the Tool Builder "Agent context" panel, set a name of 1-64 ASCII letters, digits, _ or -';
  }

  matched = /^sub-agent tool name is not a valid function name: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `サブエージェントの委譲ツール名「${matched[1]}」は関数名として使えません。サブエージェントの公開名を英数字・_・- のみに変更してください`
      : `the sub-agent delegation tool name '${matched[1]}' is not a valid function name. Change the sub-agent's publish name to ASCII letters, digits, _ or -`;
  }

  // 実行時（tool-schema.ts）と保存時（SaveTool: 前置詞は localizeDetail が剥がす）。
  matched = /^tool name is not a valid function name: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツール名「${matched[1]}」は関数名として使えません。ツール画面の「エージェント向けコンテキスト」で、英数字・_・- のみ1〜64文字の名前を設定してください`
      : `the tool name '${matched[1]}' is not a valid function name. In the Tool Builder "Agent context" panel, set an agent-facing name of 1-64 ASCII letters, digits, _ or -`;
  }

  // opBinding: モデルが許可リスト外の演算子を渡した（TOOL_ARGUMENTS）。
  matched = /^invalid operator '(.+)' for argument '(.+)': expected one of (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルが引数「${matched[2]}」に許可されていない演算子「${matched[1]}」を渡しました（許可: ${matched[3]}）。ツールの引数の説明で使える演算子を明示するか、フィルタ条件の「AIに許可する演算子」を広げてください`
      : `the model passed the operator '${matched[1]}' for argument '${matched[2]}', which is not allowed (allowed: ${matched[3]}). Describe the allowed operators in the tool argument, or widen the allowed operators on the filter condition`;
  }

  // agent-output の上限超過。SessionQuotaExceededError（413）で届くが、成果物の削除では直らない。
  matched = /^agent-output exceeds maxBytes \((\d+) > (\d+)\); reduce rows or use workspace-output$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツールの出力（${matched[1]} バイト）がエージェント出力の上限（${matched[2]} バイト）を超えました。ツール画面で「行数制限」ノードなどで行数を減らすか、出力ノードを「ワークスペース出力」に切り替えてください`
      : `the tool output (${matched[1]} bytes) exceeds the agent-output limit (${matched[2]} bytes). In the Tool Builder, reduce the rows (for example with a Limit node) or switch the output node to Workspace output`;
  }

  // --- プリフライト診断（diagnose-agent-tools.ts）の detail ---------------------
  // 実行時に同文で落ちるものも多いので、実行エラーと同じ表で拾う。
  matched = /^referenced (tool|skill|sub-agent) not found: (.+)$/.exec(message);
  if (matched !== null) {
    const kindJa = matched[1] === 'tool' ? 'ツール' : matched[1] === 'skill' ? 'スキル' : 'サブエージェント';
    const sectionEn = matched[1] === 'tool' ? 'Tools' : matched[1] === 'skill' ? 'Skills' : 'Sub-agents';
    return ja
      ? `参照している${kindJa}「${matched[2]}」が見つかりません。エージェント画面の「${kindJa}」で参照を外すか、存在するバージョンへ付け替えてください`
      : `the referenced ${matched[1]} '${matched[2]}' does not exist. In Agent Builder → ${sectionEn}, detach it or point the reference at an existing version`;
  }

  matched = /^ambiguous tool versions: (.+)@(.+) and \1@(.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツール「${matched[1]}」が複数のバージョン（${matched[2]} と ${matched[3]}）で参照されています。エージェント画面で直付けツールとスキル経由のツールを同じバージョンに揃えてください`
      : `the tool '${matched[1]}' is referenced at two versions (${matched[2]} and ${matched[3]}). Align the direct tool reference and the skill's tool reference on one version in Agent Builder`;
  }

  matched = /^sub-agent tool name collides with an existing tool or sub-agent: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `サブエージェントの委譲ツール名「${matched[1]}」が既存のツールまたはサブエージェントと重複しています。サブエージェントの公開名を変えるか、重複するツールをエージェントから外してください`
      : `the sub-agent delegation tool name '${matched[1]}' collides with an existing tool or sub-agent. Rename the sub-agent's publish name, or detach the conflicting tool from the agent`;
  }

  matched = /^duplicate function name\(s\): (.+) — later tools with the same name are unreachable$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデルへ公開する関数名「${matched[1]}」が重複しています（後ろのツールはモデルから呼べません）。ツール画面の「エージェント向けコンテキスト」で名前を変えるか、重複するツールをエージェントから外してください`
      : `the function name(s) '${matched[1]}' are exposed to the model more than once (the later tools are unreachable). Rename them in the Tool Builder "Agent context" panel, or detach the duplicates from the agent`;
  }

  matched = /^side effect '(.+)' pauses the run for approval before this tool executes$/.exec(message);
  if (matched !== null) {
    return ja
      ? `副作用「${matched[1]}」のツールは実行前に承認待ちで停止します。自動で流したい場合はエージェントのハーネス設定でツール承認を無効にするか、read-only のツールへ差し替えてください`
      : `the '${matched[1]}' side effect pauses the run for approval before this tool executes. To run unattended, turn off tool approval in the agent's harness settings, or switch to a read-only tool`;
  }

  matched = /^referenced MCP server not found: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `参照しているMCPサーバー「${matched[1]}」が登録されていません。MCP設定画面でサーバーを登録するか、エージェント画面のMCPサーバー一覧から外してください`
      : `the referenced MCP server '${matched[1]}' is not registered. Register it in MCP settings, or remove it from the agent's MCP server list`;
  }

  matched = /^MCP server '(.+)' is disabled, so its tools are skipped at run time$/.exec(message);
  if (matched !== null) {
    return ja
      ? `MCPサーバー「${matched[1]}」は無効化されているため、そのツールは実行時に読み込まれません。MCP設定画面でサーバーを有効化してください`
      : `the MCP server '${matched[1]}' is disabled, so its tools are skipped at run time. Enable it in MCP settings`;
  }

  // 診断の検査内部で起きた基盤側の失敗（検査全体を落とさず detail として報告される）。
  // mcp-servers 検査: サーバー設定の解決に失敗。原文（接続エラー等）は括弧で残す。
  matched = /^MCP server '(.+)' could not be resolved: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `MCPサーバー「${matched[1]}」を解決できませんでした（${matched[2]}）。MCP設定画面でサーバーの登録内容と接続を確認してから、診断をもう一度実行してください`
      : `the MCP server '${matched[1]}' could not be resolved (${matched[2]}). Check the server registration and connection in MCP settings, then re-run the check`;
  }

  // harness 検査: Web検索プロバイダの設定（環境変数）の解決に失敗。
  matched = /^search provider configuration could not be resolved: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `Web検索プロバイダの設定を解決できませんでした（${matched[1]}）。設定画面または .env の検索プロバイダの環境変数を確認してから、診断をもう一度実行してください`
      : `the web search provider configuration could not be resolved (${matched[1]}). Check the search provider environment variables in Settings or .env, then re-run the check`;
  }

  matched = /^model settings could not be resolved: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `モデル設定を解決できませんでした（${matched[1]}）。設定画面のモデル設定でメインモデルを保存し、「テスト」で疎通を確認してください`
      : `the model settings could not be resolved (${matched[1]}). Save the main model in model settings and run "Test" to check the connection`;
  }

  if (message === 'harness enables web search but no search provider is configured, so the web_search tool is not offered') {
    return ja
      ? 'ハーネス設定でWeb検索が有効ですが検索プロバイダが未設定のため、web_search ツールはモデルへ提供されません。サーバーの環境変数で検索プロバイダを設定するか、ハーネス設定のWeb検索を無効にしてください'
      : 'the harness enables web search, but no search provider is configured, so the web_search tool is not offered. Configure a search provider in the server environment, or turn off web search in the harness settings';
  }

  if (message === 'harness enables file memory but the agent references no wiki, so memory tools have nothing to read') {
    return ja
      ? 'ハーネス設定でファイル記憶が有効ですがエージェントが参照するWikiが無いため、記憶ツールは何も読めません。エージェント画面で参照Wikiを追加するか、ハーネス設定のファイル記憶を無効にしてください'
      : 'the harness enables file memory, but the agent references no wiki, so the memory tools have nothing to read. Add a wiki reference in Agent Builder, or turn off file memory in the harness settings';
  }

  if (message === 'tool is archived, so it should not be attached to an agent') {
    return ja
      ? 'このツールはアーカイブ済みのため、エージェントに接続したままにしないでください。エージェント画面で外すか、後継バージョンへ付け替えてください'
      : 'this tool is archived and should not stay attached to an agent. Detach it in Agent Builder, or point the reference at a successor version';
  }

  if (message === 'tool is deprecated and may be archived later') {
    return ja
      ? 'このツールは非推奨で、今後アーカイブされる可能性があります。エージェント画面で後継バージョンへ付け替えることを検討してください'
      : 'this tool is deprecated and may be archived later. Consider moving the reference to a successor version in Agent Builder';
  }

  // opBinding の診断（diagnose-agent-tools.ts checkOperatorArguments の4形）。
  matched = /^operator argument '(.+)' has no operator that every condition allows$/.exec(message);
  if (matched !== null) {
    return ja
      ? `演算子を受け取る引数「${matched[1]}」に、すべての条件が共通して許可する演算子がありません。ツール画面のフィルタ条件で「AIに許可する演算子」を揃えてください`
      : `no operator is allowed by every filter condition that binds argument '${matched[1]}'. Align the allowed operator lists on those conditions in the Tool Builder`;
  }

  matched = /^operator argument '(.+)' has conflicting default operators across conditions$/.exec(message);
  if (matched !== null) {
    return ja
      ? `演算子を受け取る引数「${matched[1]}」の既定の演算子が条件間で一致していません。ツール画面のフィルタ条件で既定の演算子を同じ値に揃えてください`
      : `the conditions that bind argument '${matched[1]}' use different default operators. Set the same default operator on every condition in the Tool Builder`;
  }

  matched = /^operator argument '(.+)' is not declared in the input schema, so the binding is inactive at run time$/.exec(message);
  if (matched !== null) {
    return ja
      ? `演算子を受け取る引数「${matched[1]}」がツールの引数に宣言されていないため、実行時にこの束縛は無効になります。Agent Inputノードに string 型の引数「${matched[1]}」を追加してください`
      : `the operator argument '${matched[1]}' is not declared in the tool's arguments, so the binding is inactive at run time. Add a string argument '${matched[1]}' on the Agent Input node`;
  }

  matched = /^operator argument '(.+)' must be declared as a string argument, but it is '(.+)'$/.exec(message);
  if (matched !== null) {
    return ja
      ? `演算子を受け取る引数「${matched[1]}」は string 型で宣言する必要がありますが、${matched[2]} 型になっています。Agent Inputノードで型を string に変更してください`
      : `the operator argument '${matched[1]}' must be declared as a string argument, but it is '${matched[2]}'. Change its type to string on the Agent Input node`;
  }

  if (message === 'run cancelled by the user') return ja ? '実行を中断しました' : 'the run was cancelled';

  return undefined;
}

/** schemaIncompatibility（domain/data/schema.ts）が返す不一致の要約。 */
function localizeSchemaIncompatibility(detail: string, language: ErrorLanguage): string {
  if (language !== 'ja') return detail;
  const count = /^column count mismatch: expected (\d+), received (\d+)$/.exec(detail);
  if (count !== null) return `列数の不一致: 宣言 ${count[1]} 列 / 推論 ${count[2]} 列`;
  const column = /^mismatch at '(.+)'$/.exec(detail);
  if (column !== null) return `列「${column[1]}」が不一致`;
  return detail;
}

/**
 * assertHttpUrl 前置詞 → URL フィールドの画面上の呼び名。
 * モデル設定のフィールドは baseUrl なので「ベースURL」、MCPサーバー設定は transport.url なので「URL」。
 */
function urlFieldLabel(prefix: string | undefined, language: ErrorLanguage): string {
  if (prefix === 'createModelSettings') return language === 'ja' ? 'ベースURL' : 'the base URL';
  return language === 'ja' ? 'URL' : 'the URL';
}

/**
 * モデル設定（`src/domain/model-settings`）と MCPサーバー設定（`src/domain/mcp`）の検証定型文。
 * `MODEL_SETTINGS_VALIDATION` / `MCP_VALIDATION` の見出しに続く詳細として出るため、
 * 「何をどう直すか」が分かる文へ置き換える（実行エラー文言とは別系統）。
 *
 * URL 検証は domain/shared/assert.ts の assertHttpUrl（ADR-0035）に共通化されており、
 * `createModelSettings:` / `createMcpServerConfig:` の2前置詞で同形メッセージを生成する。
 * ここでも前置詞グループで共通に拾い、URL フィールドの呼び名だけを前置詞で分ける
 * （urlFieldLabel）。createModelSettings 側の出力文言は共通化前とバイト単位で一致させている。
 */
function localizeSettingsValidationDetail(message: string, language: ErrorLanguage): string | undefined {
  const ja = language === 'ja';
  let matched = /^createModelSettings: [A-Za-z0-9_.]+ must be in 'provider\/model' form(?:, but got '(.*)')?$/.exec(message);
  if (matched !== null) {
    const got = matched[1] === undefined ? '' : (ja ? `、入力値: ${matched[1]}` : `, received '${matched[1]}'`);
    return ja ? `モデルは provider/model 形式で入力してください（例: openai/gpt-4o${got}）` : `the model must be in 'provider/model' form (for example openai/gpt-4o${got})`;
  }

  // リンクローカル拒否（src/domain/model-settings/model-settings.ts）。SSRF（クラウドメタデータ
  // 窃取）対策で常に拒否している旨まで伝え、「形式を直せば通る」と誤解させない。
  if (/^createModelSettings: [A-Za-z0-9_.]+ must not target a link-local address/.test(message)) {
    return ja
      ? 'ベースURLにリンクローカルアドレス（169.254.x.x / fe80::）は指定できません。クラウドメタデータの窃取（SSRF）を防ぐため、この宛先は常に拒否しています'
      : 'the base URL must not target a link-local address (169.254.x.x / fe80::). These destinations are always rejected to prevent SSRF against cloud metadata endpoints';
  }

  // MCP の name は末尾に入力値が付く独自形（src/domain/mcp/mcp-server.ts の name 長さ検証）。
  matched = /^createMcpServerConfig: name must be at most (\d+) characters: (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `名前: ${matched[1]}文字以内で入力してください（入力値: ${matched[2]}）`
      : `Name: must be at most ${matched[1]} characters (received '${matched[2]}')`;
  }

  matched = /^(createModelSettings|createMcpServerConfig): [A-Za-z0-9_.]+ must be a valid URL: (.+)$/.exec(message);
  if (matched !== null) {
    const url = urlFieldLabel(matched[1], language);
    return ja ? `${url}の形式が正しくありません: ${matched[2]}` : `${url} is not a valid URL: ${matched[2]}`;
  }

  matched = /^(createModelSettings|createMcpServerConfig): [A-Za-z0-9_.]+ must use http\(s\): (.+)$/.exec(message);
  if (matched !== null) {
    const url = urlFieldLabel(matched[1], language);
    return ja ? `${url}は http または https を指定してください: ${matched[2]}` : `${url} must use http(s): ${matched[2]}`;
  }

  matched = /^(createModelSettings|createMcpServerConfig): [A-Za-z0-9_.]+ must not embed credentials/.exec(message);
  if (matched !== null) {
    const url = urlFieldLabel(matched[1], language);
    return ja ? `${url}に認証情報（user:password@host）を含めないでください` : `${url} must not embed credentials (user:password@host)`;
  }

  // 長さ上限の共通形（shared/assert.ts の maxLength と model-settings の bounded が生成）。
  matched = /^(?:createModelSettings|createMcpServerConfig): ([A-Za-z0-9_.]+) must be at most (\d+) characters$/.exec(message);
  if (matched !== null) {
    const field = localizeFieldPath(matched[1] ?? '', language);
    return ja ? `${field}: ${matched[2]}文字以内で入力してください` : `${field}: must be at most ${matched[2]} characters`;
  }

  matched = /^(?:createModelSettings|createMcpServerConfig): ([A-Za-z0-9_.]+) must be a non-empty string$/.exec(message);
  if (matched !== null) return ja ? `${localizeFieldPath(matched[1] ?? '', language)}: 必須です` : `${localizeFieldPath(matched[1] ?? '', language)}: is required`;

  return undefined;
}

/**
 * 認可の拒否（403 `FORBIDDEN`。`src/api/authorization.ts`）の定型文
 * `this operation requires the '<kind>:<action>' permission` に対する説明。
 *
 * 見出し「この操作は許可されていません」に原文を括弧で添えるだけでは、利用者は
 * **どのロールが要るのか・誰に頼めばよいのか**が分からない。権限ごとに「何の操作に・どのロールが
 * 要るか」を書く。ここに無い権限は権限名だけを言い換え、原文は捨てない。
 */
const PERMISSION_EXPLANATIONS: Record<string, Bilingual> = {
  // MCPサーバー設定はサーバーホスト上の子プロセス起動＝ホストでのコード実行権限に等しい（docs/08 §3.2）。
  'mcp-server:operate': [
    "Changing MCP server settings and running connection tests requires the 'mcp-server:operate' permission (operator or workspace-admin role). This permission is equivalent to running commands on the server host, so ask an administrator to grant the role if you need it",
    'MCPサーバーの設定変更と接続テストには operate 権限（operator / workspace-admin）が必要です。この権限はサーバーホスト上でコマンドを実行できる権限に等しいため、必要な場合は管理者にロールの付与を依頼してください',
  ],
};
const PERMISSION_REQUIRED = /^this operation requires the '([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)' permission$/;

/** 認可拒否の定型文なら説明文（en / ja）。定型文でなければ undefined。 */
function localizePermissionDetail(message: string, language: ErrorLanguage): string | undefined {
  const matched = PERMISSION_REQUIRED.exec(message);
  if (matched === null) return undefined;
  const permission = matched[1] ?? '';
  const known = PERMISSION_EXPLANATIONS[permission];
  if (known !== undefined) return pick(known, language);
  // 英語は原文で十分に伝わる（権限名がそのまま出る）ので言い換えない。
  return language === 'ja' ? `この操作には '${permission}' 権限が必要です。必要な場合は管理者にロールの付与を依頼してください` : undefined;
}

/** 変換できたら平易な文言、できなければ undefined（呼び出し側が原文を残す）。 */
function localizeMessageText(message: string, language: ErrorLanguage): string | undefined {
  const etl = localizeEtlDetail(message, language);
  if (etl !== undefined) return etl;

  const permission = localizePermissionDetail(message, language);
  if (permission !== undefined) return permission;

  // 汎用の `... not found: id` / `already exists: id` より先に判定する（実行エラーの具体的な
  // 言い換えを、後段の「ID: x」だけの薄い変換に食われないようにする）。
  const agentRun = localizeAgentRunDetail(message, language);
  if (agentRun !== undefined) return agentRun;

  const settings = localizeSettingsValidationDetail(message, language);
  if (settings !== undefined) return settings;

  const ja = language === 'ja';
  const required = ja ? '必須です' : 'is required';
  if (message === 'Invalid input') return ja ? '入力値が不正です' : 'is invalid';
  if (message === 'Invalid URL') return ja ? 'URLの形式が正しくありません' : 'must be a valid URL';
  if (message === 'Invalid email address') return ja ? 'メールアドレスの形式が正しくありません' : 'must be a valid email address';
  if (message === 'Invalid date') return ja ? '日付の形式が正しくありません' : 'must be a valid date';

  // api/schemas.ts の modelBaseUrlSchema（zod refine）。書き込み経路（PUT /model-settings /
  // POST /model-catalog/openai-compatible-models）ではドメイン検証より先にここで落ちるため、
  // 実際に UI へ届く baseUrl 不正はこの1文になる。`invalid body: main.baseUrl: <この文>` のように
  // フィールドパス付きで届き、localizeSegment がパスを剥がした本文がここへ来る。
  // en は zod 定型文と同じ体裁で原文のまま十分伝わるため変換しない（原文を保持）。
  if (message === 'must be an http(s) URL without embedded credentials') {
    return ja ? 'http(s) のURLを指定してください。URLに認証情報（user:password@）は埋め込めません' : undefined;
  }

  if (/^Invalid input: expected \w+, received (?:undefined|null|nan)$/.test(message)) return required;

  let matched = /^Invalid input: expected (\w+), received \w+$/.exec(message);
  if (matched !== null) {
    const known = TYPES[matched[1] ?? ''];
    return known === undefined ? undefined : pick(known, language);
  }

  matched = /^Invalid input: expected (.+)$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]} を指定してください` : `must be ${matched[1]}`;

  matched = /^Too small: expected string to have >=(\d+) characters?$/.exec(message);
  if (matched !== null) return matched[1] === '1' ? required : (ja ? `${matched[1]}文字以上で入力してください` : `must be at least ${matched[1]} characters`);

  matched = /^Too big: expected string to have <=(\d+) characters?$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]}文字以内で入力してください` : `must be at most ${matched[1]} characters`;

  matched = /^Too small: expected array to have >=(\d+) items?$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]}件以上を指定してください` : `needs at least ${matched[1]} item(s)`;

  matched = /^Too big: expected array to have <=(\d+) items?$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]}件以内で指定してください` : `must have at most ${matched[1]} item(s)`;

  matched = /^Too small: expected (?:number|int|bigint) to be >=?(-?[\d.]+)$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]}以上の値を入力してください` : `must be at least ${matched[1]}`;

  matched = /^Too big: expected (?:number|int|bigint) to be <=?(-?[\d.]+)$/.exec(message);
  if (matched !== null) return ja ? `${matched[1]}以下の値を入力してください` : `must be at most ${matched[1]}`;

  matched = /^Invalid option: expected one of (.+)$/.exec(message);
  if (matched !== null) {
    const options = (matched[1] ?? '').split('|').map((option) => option.trim().replace(/^"|"$/g, '')).join(' / ');
    return ja ? `次のいずれかを指定してください: ${options}` : `must be one of: ${options}`;
  }

  matched = /^Unrecognized keys?: (.+)$/.exec(message);
  if (matched !== null) return ja ? `不明な項目です: ${matched[1]}` : `is an unknown field: ${matched[1]}`;

  matched = /^Invalid string: must match pattern (.+)$/.exec(message);
  if (matched !== null) return ja ? `形式が正しくありません（パターン: ${matched[1]}）` : `must match ${matched[1]}`;

  matched = /^invalid version string: (.+)$/i.exec(message);
  if (matched !== null) return ja ? `バージョン指定の形式が正しくありません: ${matched[1]}` : `is not a valid version string: ${matched[1]}`;

  // アップロード本文の検証（src/domain/data-source/file-content-validation.ts）。
  matched = /^(csv|json) content could not be parsed:\s*(.+)$/i.exec(message);
  if (matched !== null) {
    const format = (matched[1] ?? '').toUpperCase();
    const reason = matched[2] ?? '';
    const control = /^contains a control character (\S+) at position (\d+)$/.exec(reason);
    if (control !== null) {
      return ja
        ? `${format}: ${control[2]}文字目に制御文字 ${control[1]} が含まれています（バイナリファイルの可能性があります）`
        : `${format}: contains control character ${control[1]} at position ${control[2]} (it may be a binary file)`;
    }
    if (reason === 'header row is missing') return ja ? `${format}: ヘッダー行がありません` : `${format}: the header row is missing`;
    return `${format}: ${reason}`;
  }

  // ドメイン層の定型文（`DeleteHarness: harness not found: id` / `Agent version already exists: id@1.0.0`）。
  matched = /^(?:[A-Z][A-Za-z0-9]*: )?[A-Za-z][A-Za-z ]*? not found:\s*(.+)$/.exec(message);
  if (matched !== null) return ja ? `ID: ${matched[1]}` : `id: ${matched[1]}`;

  matched = /^(?:[A-Z][A-Za-z0-9]*: )?[A-Za-z][A-Za-z ]*? already exists:\s*(.+)$/.exec(message);
  if (matched !== null) return ja ? `既存: ${matched[1]}` : `existing: ${matched[1]}`;

  return undefined;
}

function localizeSegment(segment: string, language: ErrorLanguage): string {
  // ドメイン定型文（`DeleteHarness: harness not found: id`）はフィールドパスと誤認しやすいので先に判定する。
  const whole = localizeMessageText(segment, language);
  if (whole !== undefined) return whole;
  const matched = FIELD_PATH.exec(segment);
  if (matched === null) return segment;
  const path = matched[1] ?? '';
  const message = matched[2] ?? '';
  const text = localizeMessageText(message, language) ?? message;
  return path === '(root)' ? text : `${localizeFieldPath(path, language)}: ${text}`;
}

/** `invalid body: a: msg; b: msg` を全件ローカライズして「、」区切りで連結する。 */
function localizeDetail(raw: string, language: ErrorLanguage): string {
  if (raw === '' || raw.toLowerCase() === 'internal error') return '';
  const stripped = raw.replace(REQUEST_LABEL, '').trim();
  // ETL定型文（例: `join: output exceeded 100000 rows; check join keys`）はセミコロンを含む
  // 1つの文なので、以下の `;` 分割より先に丸ごと判定する。分割してしまうと "check join keys"
  // が原文のまま別セグメントとして残り、日本語訳と重複した表示になる。
  const etlWhole = localizeEtlDetail(stripped, language);
  if (etlWhole !== undefined) return etlWhole;
  // 実行エラー・診断の定型文にもセミコロンを含む1文がある（`agent-output exceeds maxBytes (...); reduce rows ...` /
  // `declared output schema ... — the run fails after the tool executes; re-save ...`）。その形だけ分割前に丸ごと判定する。
  // 全メッセージで丸ごと判定すると、`; ` 連結された診断の複数 detail を貪欲な `(.+)` が1件として飲み込む。
  if (SEMICOLON_WHOLE_SHAPES.some((shape) => shape.test(stripped))) {
    const runWhole = localizeAgentRunDetail(stripped, language);
    if (runWhole !== undefined) return runWhole;
  }
  // SaveTool 由来の詳細もセミコロンを含む1文があり得るため、`;` 分割より先に丸ごと判定する。
  // - `SaveTool: graph validation failed: <nodeId>: <issue>` は <issue> 部分（単一 issue）を丸ごと
  //   和訳判定へ回し、和訳できたら `<nodeId>: <和訳文>` として返す（見出しは code 側が補う）。
  //   複数 issue が '; ' で連結された形は `; <nodeId>: ` の有無で見分けて従来の分割動作へ
  //   フォールバックする（連結境界の曖昧さで誤訳しないための段階的実装）。
  // - `SaveTool: argument '...' is bound as both ...; declare two separate arguments` のような
  //   直接メッセージも分割前に丸ごと判定する。
  if (stripped.startsWith('SaveTool: ')) {
    const wrapped = /^SaveTool: graph validation failed: ([^:]+): (.+)$/.exec(stripped);
    if (wrapped !== null && !/;\s*[A-Za-z0-9_-]+:\s/.test(wrapped[2] ?? '')) {
      const issue = localizeMessageText(wrapped[2] ?? '', language);
      if (issue !== undefined) return `${wrapped[1]}: ${issue}`;
    }
    const saveToolWhole = localizeMessageText(stripped, language);
    if (saveToolWhole !== undefined) return saveToolWhole;
    // 保存時は実行時と同文の検査に `SaveTool: ` を前置して投げる（`SaveTool: tool inputSchema does not match ...` /
    // `SaveTool: tool name is not a valid function name: ...`）。前置詞を剥がして実行時の表で拾う。
    const saveToolBody = localizeMessageText(stripped.slice('SaveTool: '.length), language);
    if (saveToolBody !== undefined) return saveToolBody;
  }
  return stripped
    .split(/;\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .map((segment) => localizeSegment(segment, language))
    .join(language === 'ja' ? '、' : ', ');
}

export interface ApiErrorPayload {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;
  /** JUDGE_TRACE_UNAVAILABLE がエラー本文に載せるルーブリック参照（文言に ID を埋めるため）。 */
  readonly rubric?: { readonly id: string; readonly version: string };
  /** JOURNAL_CSV_IMPORT がエラー本文に載せる失敗行（1 始まり。ヘッダー行を含む行番号）。 */
  readonly row?: number;
  /** サーバーが error 本文へ足した、共通で解釈しない項目（業務の見出しが読む。ADR-0039）。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** code（+ SECRET_CIPHER は status）から見出しを決める。 */
function headingFor(payload: ApiErrorPayload, language: ErrorLanguage): string {
  // 業務が本文の項目（CSV の行番号など）で作る見出しを先に使う（直す場所そのものなので）。
  for (const messages of BUSINESS_ERROR_MESSAGES) {
    const heading = messages.heading?.(payload, language);
    if (heading !== undefined) return heading;
  }
  if (payload.code === 'SECRET_CIPHER') return pick(payload.status === 500 ? SECRET_CIPHER_KEY_FILE : SECRET_CIPHER_DECRYPT, language);
  const known = HEADINGS[payload.code];
  return known === undefined ? statusHeading(payload.status, language) : pick(known, language);
}

/** サーバー生メッセージをユーザー向け文言へ。language 省略時はエラー発生時点で判定する。 */
export function localizeApiErrorMessage(payload: ApiErrorPayload, language: ErrorLanguage = detectErrorLanguage()): string {
  const raw = payload.serverMessage.trim();
  // 判定モデル未設定は「設定画面の judge スロット」へ導く固定文（main スロット向けの LM_STUDIO_MODEL 案内にしない）。
  if (isJudgeModelNotConfigured({ code: payload.code, message: raw })) return pick(JUDGE_MODEL_NOT_CONFIGURED_MESSAGE, language);
  // 本文の rubric が無い旧形式でも、原文の `rubric '<id>'` から ID を拾って文中に埋める。
  if (payload.code === 'JUDGE_TRACE_UNAVAILABLE') return judgeTraceUnavailableMessage(payload.rubric?.id ?? /rubric '([^']+)'/i.exec(raw)?.[1], language);
  if (isModelFailure(payload.code, raw)) return modelMessage(raw, language);
  // agent-output の上限超過は SessionQuotaExceededError（413・SESSION_QUOTA_EXCEEDED）として届くが、
  // 見出しの「不要な成果物を削除」では直らない（ツールの出力行数の問題）。詳細文だけを出す。
  if (payload.code === 'SESSION_QUOTA_EXCEEDED' && AGENT_OUTPUT_TOO_LARGE.test(raw)) return localizeDetail(raw, language);
  // 認可の拒否は見出し（「許可されていません」）より、どの権限・ロールが要るかを1文で伝えるほうが役に立つ。
  if (payload.code === 'FORBIDDEN') {
    const permission = localizePermissionDetail(raw, language);
    if (permission !== undefined) return permission;
  }
  const heading = headingFor(payload, language);
  const detail = OPAQUE_DETAIL.has(payload.code) ? '' : localizeDetail(raw, language);
  // 詳細が見出しと同文なら重ねない。英語は詳細が括弧内の小文字始まり（'the run was cancelled'）、
  // 見出しが大文字始まり（'The run was cancelled'）なので大小を無視して比べる。
  if (detail === '' || detail.toLowerCase() === heading.toLowerCase()) return heading;
  return language === 'ja' ? `${heading}（${detail}）` : `${heading} (${detail})`;
}

/**
 * 保存済み Run の `failure`（code + message。HTTP status は持たない）の表示文言。
 * code に見出しがあれば `localizeApiErrorMessage` と同じ「見出し（詳細）」、無ければ status 由来の
 * 汎用見出しを付けずに詳細だけを出す（「リクエストに失敗しました」は保存済み Run には合わない）。
 */
export function localizeRunFailure(failure: { readonly code: string; readonly message: string }, language: ErrorLanguage = detectErrorLanguage()): string {
  const raw = failure.message.trim();
  if (HEADINGS[failure.code] === undefined && !isModelFailure(failure.code, raw)) return localizeDetail(raw, language) || raw;
  return localizeApiErrorMessage({ status: 0, code: failure.code, serverMessage: raw }, language);
}

/**
 * 判定（LLM-as-judge）1 件の失敗（実験結果の `judgeEvaluations[].error`）の表示文言。
 * code ごとに「原因。次の一手」を固定文で返す（原文は原因の補足として括弧に残す）。
 * - JUDGE_INPUT: ルーブリックが required にした実行履歴／参照が事例に無い → ポリシーを任意にするか、
 *   ツールを使う（参照つきの）事例で実行する。原文に reference があれば参照側の案内にする。
 * - JUDGE_UNASSESSABLE: どの基準も判定できなかった → 基準の説明を具体的にする／必要な参照や履歴を渡す。
 * - JUDGE_SCHEMA: 修復を 1 回試みても出力が不正 → 判定モデルを構造化出力に強いものへ（設定画面の judge スロット）。
 * - JUDGE_PROVIDER で原文が "is not configured": 判定モデル未設定 → 設定画面の judge スロットで設定する
 *   （JUDGE_MODEL_NOT_CONFIGURED と同文。画面はこの場合だけ設定画面へのボタンを添える）。
 * - JUDGE_MODEL_NOT_CONFIGURED / JUDGE_TRACE_UNAVAILABLE: 起票時の 409（localizeApiErrorMessage が扱う）。
 * - JUDGE_PROVIDER（その他）・未知の code: 既存の実行失敗文言（プロバイダ中立のモデル案内）に委ねる。
 */
export function localizeJudgeFailure(failure: { readonly code: string; readonly message: string }, language: ErrorLanguage = detectErrorLanguage()): string {
  const ja = language === 'ja';
  const raw = failure.message.trim();
  const detail = raw === '' ? '' : (ja ? `（${raw}）` : ` (${raw})`);
  if (isJudgeModelNotConfigured({ code: failure.code, message: raw })) return pick(JUDGE_MODEL_NOT_CONFIGURED_MESSAGE, language);
  switch (failure.code) {
    case 'JUDGE_INPUT': {
      if (/reference/i.test(raw) && !/trace|history|tool/i.test(raw)) {
        return ja
          ? `ルーブリックが必須にしている参照回答がこの事例にありません${detail}。ルーブリックの参照ポリシーを「任意」にするか、参照回答つきの事例で実行してください`
          : `The rubric requires a reference answer but this case has none${detail}. Set the rubric's reference policy to optional, or run cases that carry a reference answer`;
      }
      return ja
        ? `ルーブリックが必須にしている実行履歴がこの事例にありません${detail}。ルーブリックの実行履歴ポリシーを「任意」にするか、ツールを使う事例で実行してください`
        : `The rubric requires a tool trace but this case has none${detail}. Set the rubric's trace policy to optional, or run cases that use tools`;
    }
    case 'JUDGE_UNASSESSABLE':
      return ja
        ? `審査者はどの基準も判定できませんでした${detail}。基準の説明を具体的にするか、必要な参照回答や実行履歴を判定者に渡してください`
        : `The judge could not assess any criterion${detail}. Make the criterion descriptions more concrete, or give the judge the reference answer or trace it needs`;
    case 'JUDGE_SCHEMA':
      return ja
        ? `判定結果が期待した形式ではありませんでした（修復を 1 回試みても不正）${detail}。設定画面の judge スロットで、構造化出力に強い判定モデルへ切り替えてください`
        : `The judge output did not match the expected shape even after one repair${detail}. In Settings, switch the judge slot to a model that is strong at structured output`;
    default:
      return localizeRunFailure(failure, language);
  }
}

/**
 * ノード単位のSchemaIssue（propagation issue）の日本語化。ToolNode / PreviewPanel の
 * issue描画から呼ぶ想定で、見出しは付けずメッセージ本文だけを返す。
 *
 * `language` は ui/i18n.tsx の `Language`（'en' | 'ja'）と同じ値域。この層は i18n.tsx に
 * 依存できないため型は再エクスポートせず、構造的に同じ ErrorLanguage を使う。
 * 変換できなければ原文をそのまま返す（詳細を握りつぶさない）。
 */
export function localizeSchemaIssueMessage(message: string, language: ErrorLanguage): string {
  return localizeMessageText(message, language) ?? message;
}

/**
 * プリフライト診断（DiagnoseAgentToolsUseCase / Tool draft 診断）の `detail` の文言。
 * detail は実行時エラーと同じ英語定型文なので、実行エラーと同じ変換表を通す。
 * 変換できなければ原文をそのまま返す。
 */
export function localizeDiagnosticDetail(message: string, language: ErrorLanguage = detectErrorLanguage()): string {
  return localizeDetail(message, language) || message;
}

/**
 * Run トレースの `error` イベント（`code` + `message`）の表示文言。
 * 引数修復の再試行は `<message> (retrying 1/1)` の形で保存されるため、接尾辞を剥がしてから
 * 本文を変換し、再試行の注記を言語に合わせて付け直す。
 */
export function localizeRunTraceError(event: { readonly code: string; readonly message: string }, language: ErrorLanguage = detectErrorLanguage()): string {
  // 末尾の空白は許す。`$` 直前に空白があると接尾辞が本文側に残り、`required argument missing: (.+)` の
  // 引数名として「month (retrying 1/1)」のように取り込まれてしまう。
  const retry = /\s*\(retrying (\d+)\/(\d+)\)\s*$/.exec(event.message);
  const body = retry === null ? event.message : event.message.slice(0, retry.index);
  const localized = localizeDetail(body, language) || body.trim();
  if (retry === null) return localized;
  const note = language === 'ja' ? `（再試行 ${retry[1]}/${retry[2]}）` : `(retrying ${retry[1]}/${retry[2]})`;
  // 本文が無い（接尾辞だけ）なら区切りの空白を付けない。
  if (localized === '') return note;
  return language === 'ja' ? `${localized}${note}` : `${localized} ${note}`;
}

/**
 * ローカライズ済みの失敗文言を「原因」と「次の一手」に分ける（RunFailureNotice が次の一手を先頭に太字で出すため）。
 *
 * この層の文言は「原因。次の一手」（ja）/「cause. Next step」（en）の形で、見出しつきなら
 * 「見出し（原因。次の一手）」。最後の文境界で切り、見出しは原因側へ戻す。末尾の括弧書き
 * （`... retry. (offline)` のような原文の補足）は文として扱わず、その前の境界で切る。
 * 分けられなければ全文を次の一手として返す（何も落とさない）。
 */
export function splitFailureMessage(message: string, language: ErrorLanguage): { readonly cause?: string; readonly action: string } {
  const ja = language === 'ja';
  const trimmed = message.trim().replace(ja ? /。$/ : /\.$/, '');
  const separator = ja ? '。' : '. ';
  // 末尾の括弧書きを飛ばして、最後の文境界を探す。
  const lastBoundary = (body: string): number => {
    let index = body.lastIndexOf(separator);
    while (index !== -1) {
      const after = body.slice(index + separator.length).trim();
      if (after !== '' && !after.startsWith('(') && !after.startsWith('（')) return index;
      index = index === 0 ? -1 : body.lastIndexOf(separator, index - 1);
    }
    return -1;
  };
  // 「見出し（本文）」の形で本文に文境界があれば本文を分け、見出しは原因側へ戻す（見出し自体に文境界があってもよい）。
  const wrapped = (ja ? /^(.*?)（(.+)）$/ : /^(.*?) \((.+)\)$/).exec(trimmed);
  if (wrapped !== null) {
    const heading = wrapped[1] ?? '';
    const body = wrapped[2] ?? '';
    const index = lastBoundary(body);
    if (index !== -1) {
      const bodyCause = body.slice(0, index).trim();
      return { cause: ja ? `${heading}（${bodyCause}）` : `${heading} (${bodyCause})`, action: body.slice(index + separator.length).trim() };
    }
  }
  const index = lastBoundary(trimmed);
  if (index === -1) return { action: trimmed };
  // 文境界で始まる文（先頭が「。」）では原因が空になる。空の原因行を描かせない。
  const cause = trimmed.slice(0, index).trim();
  const action = trimmed.slice(index + separator.length).trim();
  return cause === '' ? { action } : { cause, action };
}

/**
 * Run トレースの `mcp-server-skipped` イベントの表示文言。
 * MCPサーバーを解決できずツールを注入しなかった（Run 自体は続く）ことと、理由別の直し方を1文で伝える。
 * `detail` は接続失敗の生メッセージなので括弧で原文を残す（握りつぶさない）。
 */
export function describeMcpServerSkipped(
  event: { readonly server: string; readonly reason: 'not-found' | 'disabled' | 'unreachable'; readonly detail?: string },
  language: ErrorLanguage = detectErrorLanguage(),
): string {
  const ja = language === 'ja';
  const detail = event.detail === undefined || event.detail === '' ? '' : (ja ? `。詳細: ${event.detail}` : `. Detail: ${event.detail}`);
  if (event.reason === 'not-found') {
    return ja
      ? `MCPサーバー「${event.server}」のツールを読み込めませんでした（未登録）。MCP設定画面でサーバーを登録・有効化し、接続をテストしてください${detail}`
      : `The tools of MCP server '${event.server}' were not loaded (server not registered). Register and enable the server in MCP settings, then test the connection${detail}`;
  }
  if (event.reason === 'disabled') {
    return ja
      ? `MCPサーバー「${event.server}」のツールを読み込めませんでした（無効化中）。MCP設定画面でサーバーを有効化し、接続をテストしてください${detail}`
      : `The tools of MCP server '${event.server}' were not loaded (server disabled). Enable the server in MCP settings, then test the connection${detail}`;
  }
  if (event.reason === 'unreachable') {
    return ja
      ? `MCPサーバー「${event.server}」のツールを読み込めませんでした（接続失敗）。MCP設定画面で接続をテストし、サーバーの起動状態・URL・コマンドを確認してください${detail}`
      : `The tools of MCP server '${event.server}' were not loaded (unreachable). Test the connection in MCP settings and check that the server is running and its URL or command is correct${detail}`;
  }
  // 型上は到達しないが、新しいサーバーが未知の reason を送ってきても「接続失敗」と言い切らず、理由をそのまま添える。
  const reason: string = event.reason;
  return ja
    ? `MCPサーバー「${event.server}」のツールを読み込めませんでした（${reason}）。MCP設定画面でサーバーの設定と接続を確認してください${detail}`
    : `The tools of MCP server '${event.server}' were not loaded (${reason}). Check the server settings and test the connection in MCP settings${detail}`;
}

/**
 * ツール検証（Tool Check）の期待・実測の定型文（`ToolCheckAssertionResultDto.expected / actual`）の日本語化。
 * サーバーは英語定型文だけを返し、言語化は UI が担う。形が合わなければ原文をそのまま返す（en は常に原文）。
 *
 * 定型文（src/application/tool-check と対で保守する）:
 * - 期待: `row count == 3` / `column 'total' exists` / `some row has total >= 100` / `every row has region == "east"` / `duration <= 500ms`
 * - 実測: `row count 5` / `columns: a, b, c` / `columns: (none)` / `2 of 5 rows match` / `column 'total' not in output` / `812ms`
 * - 結末: 期待 `outcome error` / `outcome success`、実測 `outcome success` / `outcome error (TOOL_ARGUMENTS)`
 */
export function localizeToolCheckAssertion(text: string, language: ErrorLanguage, role: 'expected' | 'actual' = 'expected'): string {
  if (language !== 'ja') return text;
  const trimmed = text.trim();
  let matched = /^row count (==|>=|<=) (\d+)$/.exec(trimmed);
  if (matched !== null) return `行数 ${matched[1]} ${matched[2]}`;
  matched = /^row count (\d+)$/.exec(trimmed);
  if (matched !== null) return `行数 ${matched[1]}`;
  matched = /^column '(.+)' exists$/.exec(trimmed);
  if (matched !== null) return `列「${matched[1]}」がある`;
  matched = /^column '(.+)' not in output$/.exec(trimmed);
  if (matched !== null) return `列「${matched[1]}」は出力にない`;
  if (trimmed === 'columns: (none)') return '列: （なし）';
  matched = /^columns: (.+)$/.exec(trimmed);
  if (matched !== null) return `列: ${matched[1]}`;
  matched = /^some row has (.+)$/.exec(trimmed);
  if (matched !== null) return `いずれかの行で ${matched[1]}`;
  matched = /^every row has (.+)$/.exec(trimmed);
  if (matched !== null) return `すべての行で ${matched[1]}`;
  matched = /^(\d+) of (\d+) rows match$/.exec(trimmed);
  if (matched !== null) return `${matched[2]} 行中 ${matched[1]} 行が該当`;
  matched = /^duration <= (\d+)ms$/.exec(trimmed);
  if (matched !== null) return `所要時間 <= ${matched[1]}ms`;
  // 実行の結末。同じ `outcome success` でも、期待欄は「〜すること」、実測欄は「〜した」で読み分ける（role で区別）。
  matched = /^outcome error \((.+)\)$/.exec(trimmed);
  if (matched !== null) return `失敗した（${matched[1]}）`;
  if (trimmed === 'outcome error') return role === 'actual' ? '失敗した' : '実行が失敗すること';
  if (trimmed === 'outcome success') return role === 'actual' ? '成功した' : '実行が成功すること';
  return text;
}

/**
 * 仕訳の Stage 1 判定が「未確定」になった理由（`JournalUndecidedReasonDto.code`）の短い見出し。
 * 判定タブは summarizeJudgment（原因 → 次の一手 → ボタン）で詳しく描くが、一覧のチップやテスト結果の
 * 1 行表示にはこの見出しだけを使う。未知の code はそのまま返す（新しいサーバーに追従できるよう握りつぶさない）。
 */
export function localizeJournalReason(reason: { readonly code: string }, text: (en: string, ja: string) => string): string {
  switch (reason.code) {
    case 'no-rule': return text('No matching rule', '該当ルール無し');
    case 'multiple-rules': return text('Several rules tie', '複数ルールが同点');
    case 'missing-fact': return text('Required facts missing', '必要項目の不足');
    case 'ask-if': return text('Needs an answer', '追加質問あり');
    case 'rule-suggest-mode': return text('Only suggest-mode rules matched', '推測ルールのみ一致');
    case 'unknown-account': return text('Account missing from the chart', '科目がマスタに無い');
    case 'unbalanced': return text('Debit and credit differ', '貸借不一致');
    default: return reason.code;
  }
}

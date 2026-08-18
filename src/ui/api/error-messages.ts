/**
 * ui/api層: サーバーのエラーコード + 生メッセージ → ユーザー向けローカライズ文言。
 *
 * この層は React の外（ApiError 構築時）で動くため i18n.tsx の text() に依存できない。
 * 言語は localStorage からエラー発生時点で遅延判定する。
 * 変換できなかった部分は原文をそのまま残す（詳細を握りつぶさない）。
 */

export type ErrorLanguage = 'en' | 'ja';
type Bilingual = readonly [en: string, ja: string];

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
 * error.code ごとの見出し。src/api/error-mapping.ts が返す code 体系に対応する。
 * HTTP_ERROR / 未知の code は status から見出しを決める（statusHeading）。
 */
const HEADINGS: Record<string, Bilingual> = {
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

  // モデル設定の入力不正（400）。LM Studio 前提の実行エラー文言に混ぜない。
  MODEL_SETTINGS_VALIDATION: ['Please check the model settings', 'モデル設定の入力内容を確認してください'],
  // モデル一覧の取得失敗（502）。実行エラーではなく「一覧が引けない」だけ。
  MODEL_CATALOG: ['Could not fetch the model list. Check the endpoint and its API key, then retry', 'モデル一覧を取得できませんでした。エンドポイントとAPIキーを確認して再試行してください'],

  ETL_GRAPH: ['Please check the node connections', 'ノードの接続を確認してください'],
  ETL_CONFIG: ['Please check the node settings', 'ノードの設定を確認してください'],
  ETL_SCHEMA: ['The column names or types do not match. Check the upstream node output', '列名または型が一致していません。上流ノードの出力を確認してください'],
};

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
const FIELD_PATH = /^(\(root\)|[A-Za-z0-9_.]+):\s+(.+)$/;

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

  let matched = /^node '(.+)' \(type '(.+)'\) expects (\d+) input\(s\) but has in-degree (\d+)$/.exec(message);
  if (matched !== null) return `ノード「${matched[1]}」(${matched[2]})には${matched[3]}本の入力が必要ですが、${matched[4]}本接続されています`;

  matched = /^graph must have exactly one terminal node, found (\d+): (.+)$/.exec(message);
  if (matched !== null) return `グラフの終端ノードは1つだけにしてください(現在${matched[1]}個: ${matched[2]})`;

  if (message === 'graph has no terminal node (out-degree 0)') return '終端ノード(出力)がありません';
  if (message === 'graph has a cycle') return 'グラフに循環(ループ)があります。接続を見直してください';

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
  if (matched !== null) return `結合キーの列が見つかりません: ${matched[1]}`;

  matched = /^([A-Za-z][A-Za-z0-9_-]*): column\(s\) must be number: (.+)$/.exec(message);
  if (matched !== null) return `数値列が必要です: ${matched[2]}`;

  // 列不存在（`select` / `sort` / `group-by` などが共通で使う形。join のキー専用形は上で処理済み）。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): column\(s\) not found: (.+)$/.exec(message);
  if (matched !== null) return `列が見つかりません: ${matched[2]}`;

  // 単一列の型不一致（chart-output / analysis-utils / group-by が使う形）。
  matched = /^([A-Za-z][A-Za-z0-9_-]*): column '(.+)' must be (.+)$/.exec(message);
  if (matched !== null) {
    const types = (matched[3] ?? '').split(/ or |, /).map((type) => DATA_TYPE_JA[type.trim()] ?? type.trim()).join(' / ');
    return `列「${matched[2]}」の型は ${types} が必要です`;
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
  if (matched !== null) return `${matched[1]}: 設定が不正です(${localizeDetail(matched[2] ?? '', 'ja')})`;

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

  matched = /^invalid argument '(.+)': expected (.+)$/.exec(message);
  if (matched !== null) {
    return ja
      ? `ツールの引数「${matched[1]}」の型が違います（${matched[2]} が必要）。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください`
      : `the tool argument '${matched[1]}' had the wrong type (expected ${matched[2]}). Describe that argument more concretely in the tool, or state its value in your request`;
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

  if (message === 'run cancelled by the user') return ja ? '実行を中断しました' : 'the run was cancelled';

  return undefined;
}

/**
 * モデル設定（`src/domain/model-settings`）の検証定型文。`MODEL_SETTINGS_VALIDATION` の見出しに続く
 * 詳細として出るため、「何をどう直すか」が分かる文へ置き換える（実行エラー文言とは別系統）。
 */
function localizeModelSettingsDetail(message: string, language: ErrorLanguage): string | undefined {
  const ja = language === 'ja';
  let matched = /^createModelSettings: [A-Za-z0-9_.]+ must be in 'provider\/model' form(?:, but got '(.*)')?$/.exec(message);
  if (matched !== null) {
    const got = matched[1] === undefined ? '' : (ja ? `、入力値: ${matched[1]}` : `, received '${matched[1]}'`);
    return ja ? `モデルは provider/model 形式で入力してください（例: openai/gpt-4o${got}）` : `the model must be in 'provider/model' form (for example openai/gpt-4o${got})`;
  }

  matched = /^createModelSettings: [A-Za-z0-9_.]+ must be a valid URL: (.+)$/.exec(message);
  if (matched !== null) return ja ? `ベースURLの形式が正しくありません: ${matched[1]}` : `the base URL is not a valid URL: ${matched[1]}`;

  matched = /^createModelSettings: [A-Za-z0-9_.]+ must use http\(s\): (.+)$/.exec(message);
  if (matched !== null) return ja ? `ベースURLは http または https を指定してください: ${matched[1]}` : `the base URL must use http(s): ${matched[1]}`;

  if (/^createModelSettings: [A-Za-z0-9_.]+ must not embed credentials/.test(message)) {
    return ja ? 'ベースURLに認証情報（user:password@host）を含めないでください' : 'the base URL must not embed credentials (user:password@host)';
  }

  matched = /^createModelSettings: ([A-Za-z0-9_.]+) must be a non-empty string$/.exec(message);
  if (matched !== null) return ja ? `${localizeFieldPath(matched[1] ?? '', language)}: 必須です` : `${localizeFieldPath(matched[1] ?? '', language)}: is required`;

  return undefined;
}

/** 変換できたら平易な文言、できなければ undefined（呼び出し側が原文を残す）。 */
function localizeMessageText(message: string, language: ErrorLanguage): string | undefined {
  const etl = localizeEtlDetail(message, language);
  if (etl !== undefined) return etl;

  // 汎用の `... not found: id` / `already exists: id` より先に判定する（実行エラーの具体的な
  // 言い換えを、後段の「ID: x」だけの薄い変換に食われないようにする）。
  const agentRun = localizeAgentRunDetail(message, language);
  if (agentRun !== undefined) return agentRun;

  const modelSettings = localizeModelSettingsDetail(message, language);
  if (modelSettings !== undefined) return modelSettings;

  const ja = language === 'ja';
  const required = ja ? '必須です' : 'is required';
  if (message === 'Invalid input') return ja ? '入力値が不正です' : 'is invalid';
  if (message === 'Invalid URL') return ja ? 'URLの形式が正しくありません' : 'must be a valid URL';
  if (message === 'Invalid email address') return ja ? 'メールアドレスの形式が正しくありません' : 'must be a valid email address';
  if (message === 'Invalid date') return ja ? '日付の形式が正しくありません' : 'must be a valid date';

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
}

/** code（+ SECRET_CIPHER は status）から見出しを決める。 */
function headingFor(payload: ApiErrorPayload, language: ErrorLanguage): string {
  if (payload.code === 'SECRET_CIPHER') return pick(payload.status === 500 ? SECRET_CIPHER_KEY_FILE : SECRET_CIPHER_DECRYPT, language);
  const known = HEADINGS[payload.code];
  return known === undefined ? statusHeading(payload.status, language) : pick(known, language);
}

/** サーバー生メッセージをユーザー向け文言へ。language 省略時はエラー発生時点で判定する。 */
export function localizeApiErrorMessage(payload: ApiErrorPayload, language: ErrorLanguage = detectErrorLanguage()): string {
  const raw = payload.serverMessage.trim();
  if (isModelFailure(payload.code, raw)) return modelMessage(raw, language);
  const heading = headingFor(payload, language);
  const detail = OPAQUE_DETAIL.has(payload.code) ? '' : localizeDetail(raw, language);
  if (detail === '' || detail === heading) return heading;
  return language === 'ja' ? `${heading}（${detail}）` : `${heading} (${detail})`;
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeMcpServerSkipped, detectErrorLanguage, isJudgeModelNotConfigured, localizeApiErrorMessage, localizeDiagnosticDetail, localizeJudgeFailure, localizeRunFailure, localizeRunTraceError, localizeSchemaIssueMessage, localizeToolCheckAssertion, splitFailureMessage } from './error-messages';

function ja(status: number, code: string, serverMessage: string): string {
  return localizeApiErrorMessage({ status, code, serverMessage }, 'ja');
}
function en(status: number, code: string, serverMessage: string): string {
  return localizeApiErrorMessage({ status, code, serverMessage }, 'en');
}
function badRequest(detail: string, language: 'en' | 'ja' = 'ja'): string {
  return localizeApiErrorMessage({ status: 400, code: 'BAD_REQUEST', serverMessage: `invalid body: ${detail}` }, language);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('detectErrorLanguage', () => {
  it("localStorage が 'ja' のときだけ ja を返す", () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('ja') });
    expect(detectErrorLanguage()).toBe('ja');
  });

  it('未設定・別言語は en へフォールバックする', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null) });
    expect(detectErrorLanguage()).toBe('en');
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('fr') });
    expect(detectErrorLanguage()).toBe('en');
  });

  it('localStorage 不可用（例外）でも en を返す', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(detectErrorLanguage()).toBe('en');
  });

  it('language 省略時はエラー発生時点の localStorage を参照する', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('ja') });
    expect(localizeApiErrorMessage({ status: 404, code: 'TOOL_NOT_FOUND', serverMessage: 'Tool not found: a/b' }))
      .toBe('ツールが見つかりませんでした（ID: a/b）');
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('en') });
    expect(localizeApiErrorMessage({ status: 404, code: 'TOOL_NOT_FOUND', serverMessage: 'Tool not found: a/b' }))
      .toBe('The tool was not found (id: a/b)');
  });
});

describe('Zod 詳細の平易化', () => {
  it('必須（Too small >=1）を「内部ID: 必須です」形式へ変換する', () => {
    expect(badRequest('internalId: Too small: expected string to have >=1 characters'))
      .toBe('入力内容を確認してください（内部ID: 必須です）');
  });

  it('複数フィールドを全件「、」区切りで列挙する', () => {
    const detail = 'internalId: Too small: expected string to have >=1 characters; displayName: Invalid input: expected string, received undefined; owner: Too small: expected string to have >=1 characters';
    expect(badRequest(detail)).toBe('入力内容を確認してください（内部ID: 必須です、表示名: 必須です、所有者: 必須です）');
    expect(badRequest(detail, 'en')).toBe('Please check your input (Internal ID: is required, Display name: is required, Owner: is required)');
  });

  it('invalid query / invalid request のラベルも剥がす', () => {
    expect(ja(400, 'BAD_REQUEST', 'invalid query: tenantId: Too small: expected string to have >=1 characters'))
      .toBe('入力内容を確認してください（テナントID: 必須です）');
    expect(ja(400, 'BAD_REQUEST', 'invalid request: sessionId: Invalid input: expected string, received undefined'))
      .toBe('入力内容を確認してください（セッションID: 必須です）');
  });

  it('ネストパスと配列インデックスを解決する', () => {
    expect(badRequest('scope.workspaceId: Too small: expected string to have >=1 characters'))
      .toBe('入力内容を確認してください（スコープ.ワークスペースID: 必須です）');
    expect(badRequest('tools.0.internalId: Too small: expected string to have >=1 characters'))
      .toBe('入力内容を確認してください（ツール.1件目.内部ID: 必須です）');
    expect(badRequest('tools.0.internalId: Too small: expected string to have >=1 characters', 'en'))
      .toBe('Please check your input (Tools.#1.Internal ID: is required)');
  });

  it('辞書に無いフィールド名は原文のまま残す', () => {
    expect(badRequest('mysteryField: Too small: expected string to have >=1 characters'))
      .toBe('入力内容を確認してください（mysteryField: 必須です）');
  });

  it('(root) パスはフィールド接頭辞を付けない', () => {
    expect(badRequest('(root): Unrecognized key: "extra"'))
      .toBe('入力内容を確認してください（不明な項目です: "extra"）');
    expect(badRequest('(root): Unrecognized keys: "a", "b"', 'en'))
      .toBe('Please check your input (is an unknown field: "a", "b")');
  });

  it.each([
    ['name: Invalid input: expected string, received number', '名前: 文字列を入力してください', 'Name: must be text'],
    ['limit: Invalid input: expected number, received string', '取得上限: 数値を入力してください', 'Limit: must be a number'],
    ['limit: Invalid input: expected int, received number', '取得上限: 整数を入力してください', 'Limit: must be a whole number'],
    ['required: Invalid input: expected boolean, received string', '必須: true または false を指定してください', 'Required: must be true or false'],
    ['tools: Invalid input: expected array, received string', 'ツール: 配列を指定してください', 'Tools: must be a list'],
    ['graph: Invalid input: expected object, received number', 'グラフ: オブジェクトを指定してください', 'Graph: must be an object'],
    ['name: Invalid input: expected string, received null', '名前: 必須です', 'Name: is required'],
    ['displayName: Too big: expected string to have <=100 characters', '表示名: 100文字以内で入力してください', 'Display name: must be at most 100 characters'],
    ['systemPrompt: Too small: expected string to have >=10 characters', 'システムプロンプト: 10文字以上で入力してください', 'System prompt: must be at least 10 characters'],
    ['cases: Too small: expected array to have >=1 items', 'ケース: 1件以上を指定してください', 'Cases: needs at least 1 item(s)'],
    ['tags: Too big: expected array to have <=5 items', 'タグ: 5件以内で指定してください', 'Tags: must have at most 5 item(s)'],
    ['rowLimit: Too small: expected number to be >=1', '取得行数: 1以上の値を入力してください', 'Row limit: must be at least 1'],
    ['limit: Too big: expected number to be <=100', '取得上限: 100以下の値を入力してください', 'Limit: must be at most 100'],
    ['mode: Invalid option: expected one of "preview"|"test"', 'モード: 次のいずれかを指定してください: preview / test', 'Mode: must be one of: preview / test'],
    ['kind: Invalid input: expected "input"', '種別: "input" を指定してください', 'Kind: must be "input"'],
    ['version: Invalid string: must match pattern /^\\d+$/', 'バージョン: 形式が正しくありません（パターン: /^\\d+$/）', 'Version: must match /^\\d+$/'],
    ['dataUrl: Invalid URL', 'データURL: URLの形式が正しくありません', 'Data URL: must be a valid URL'],
    ['owner: Invalid email address', '所有者: メールアドレスの形式が正しくありません', 'Owner: must be a valid email address'],
    ['from: Invalid date', '開始: 日付の形式が正しくありません', 'From: must be a valid date'],
    ['response: Invalid input', '応答: 入力値が不正です', 'Response: is invalid'],
  ])('代表的なZod文言 %s を平易化する', (detail, japanese, english) => {
    expect(badRequest(detail)).toBe(`入力内容を確認してください（${japanese}）`);
    expect(badRequest(detail, 'en')).toBe(`Please check your input (${english})`);
  });

  it('未知のZod型・未知の文言は原文を残す（握りつぶさない）', () => {
    expect(badRequest('name: Invalid input: expected symbol, received string'))
      .toBe('入力内容を確認してください（名前: Invalid input: expected symbol, received string）');
    expect(badRequest('name: must be a business email'))
      .toBe('入力内容を確認してください（名前: must be a business email）');
    expect(ja(400, 'BAD_REQUEST', 'graph must contain at least one terminal node'))
      .toBe('入力内容を確認してください（graph must contain at least one terminal node）');
  });

  it('不正 version 文字列を平易化する', () => {
    expect(ja(400, 'BAD_REQUEST', 'invalid version string: "1.x"'))
      .toBe('入力内容を確認してください（バージョン指定の形式が正しくありません: "1.x"）');
    expect(en(400, 'BAD_REQUEST', 'invalid version string: "1.x"'))
      .toBe('Please check your input (is not a valid version string: "1.x")');
  });
});

describe('code ベースの見出し', () => {
  it('NOT_FOUND 系はドメイン定型文から ID だけを取り出す', () => {
    expect(ja(404, 'HARNESS_NOT_FOUND', 'DeleteHarness: harness not found: support-bot'))
      .toBe('マルチエージェント構成が見つかりませんでした（ID: support-bot）');
    expect(ja(404, 'AGENT_NOT_FOUND', 'RunAgentPreview: agent not found: triage (version 1.2.0 requested)'))
      .toBe('エージェントが見つかりませんでした（ID: triage (version 1.2.0 requested)）');
    expect(en(404, 'WIKI_PAGE_NOT_FOUND', 'DeleteWiki: wiki page not found: page-1'))
      .toBe('The wiki page was not found (id: page-1)');
    expect(ja(404, 'NOT_FOUND', 'ScenarioRun not found: run-1')).toBe('対象が見つかりませんでした（ID: run-1）');
  });

  it('バージョン競合は既存バージョンを添えて次の行動を示す', () => {
    expect(ja(409, 'AGENT_VERSION_CONFLICT', 'Agent version already exists: triage@1.0.0'))
      .toBe('同じエージェントバージョンが既に存在します。バージョンを上げて保存し直してください（既存: triage@1.0.0）');
    expect(en(409, 'CONFLICT', 'Harness version already exists: bot@2.0.0'))
      .toBe('The request conflicts with the current state. Reload the latest data, then retry (existing: bot@2.0.0)');
  });

  it('INTERNAL / HTTP_ERROR / INVALID_API_RESPONSE は英語定型文を出さない', () => {
    expect(ja(500, 'INTERNAL', 'internal error')).toBe('サーバー内部でエラーが発生しました。時間をおいて再試行してください');
    expect(ja(404, 'HTTP_ERROR', 'Not Found')).toBe('対象が見つかりませんでした');
    expect(ja(500, 'HTTP_ERROR', 'Internal Server Error')).toBe('サーバー内部でエラーが発生しました。時間をおいて再試行してください');
    expect(ja(200, 'INVALID_API_RESPONSE', 'API returned a non-JSON response. Check that the API server is running and the development proxy is configured.'))
      .toBe('APIサーバーからJSON以外の応答が返りました。APIサーバーの起動状態と開発プロキシ設定を確認してください');
    expect(en(200, 'INVALID_API_RESPONSE', 'whatever')).toContain('non-JSON');
  });

  it('アップロードファイル解析失敗を再アップロード導線付きで伝える', () => {
    const heading = 'アップロードしたファイルを解析できませんでした。ファイル形式と文字コードを確認して、もう一度アップロードしてください';
    expect(ja(400, 'INVALID_FILE_CONTENT', 'csv content could not be parsed: header row is missing'))
      .toBe(`${heading}（CSV: ヘッダー行がありません）`);
    expect(en(400, 'INVALID_FILE_CONTENT', 'csv content could not be parsed: header row is missing'))
      .toBe('The uploaded file could not be parsed. Check its format and character encoding, then upload again (CSV: the header row is missing)');
    expect(ja(400, 'INVALID_FILE_CONTENT', 'csv content could not be parsed: contains a control character U+0000 at position 12'))
      .toBe(`${heading}（CSV: 12文字目に制御文字 U+0000 が含まれています（バイナリファイルの可能性があります））`);
    expect(en(400, 'INVALID_FILE_CONTENT', 'csv content could not be parsed: contains a control character U+0000 at position 12'))
      .toContain('U+0000 at position 12');
    expect(ja(400, 'INVALID_FILE_CONTENT', 'json content could not be parsed: Unexpected end of JSON input'))
      .toBe(`${heading}（JSON: Unexpected end of JSON input）`);
    expect(en(400, 'INVALID_FILE_CONTENT', '')).toBe('The uploaded file could not be parsed. Check its format and character encoding, then upload again');
  });

  it('ETL / セッション / 検証系の見出しを日本語化する', () => {
    expect(ja(422, 'ETL_GRAPH', 'cycle detected: a -> b -> a')).toBe('ノードの接続を確認してください（cycle detected: a -> b -> a）');
    expect(ja(422, 'ETL_SCHEMA', '')).toBe('列名または型が一致していません。上流ノードの出力を確認してください');
    expect(ja(410, 'SESSION_EXPIRED', '')).toBe('セッションの有効期限が切れました。新しいセッションを開始してください');
    expect(ja(413, 'SESSION_QUOTA_EXCEEDED', '')).toBe('セッションの保存上限を超えました。不要な成果物を削除して再試行してください');
    expect(ja(400, 'DATA_SOURCE_VALIDATION', '')).toBe('データソースの設定を確認してください');
    expect(ja(422, 'JUDGE_SCHEMA', '')).toContain('別のモデルを選んでください');
  });
});

/**
 * 403 の原文（`src/api/authorization.ts`）は必要な権限名しか言わない。画面では
 * 「何の操作に・どのロールが要るか・誰に頼むか」まで出す。
 */
describe('認可の拒否（403 FORBIDDEN）', () => {
  const MCP_DENIED = "this operation requires the 'mcp-server:operate' permission";

  it('mcp-server:operate は必要なロールと理由まで書き、見出しの「許可されていません」だけで終わらせない', () => {
    expect(ja(403, 'FORBIDDEN', MCP_DENIED)).toBe('MCPサーバーの設定変更と接続テストには operate 権限（operator / workspace-admin）が必要です。この権限はサーバーホスト上でコマンドを実行できる権限に等しいため、必要な場合は管理者にロールの付与を依頼してください');
    expect(en(403, 'FORBIDDEN', MCP_DENIED)).toBe("Changing MCP server settings and running connection tests requires the 'mcp-server:operate' permission (operator or workspace-admin role). This permission is equivalent to running commands on the server host, so ask an administrator to grant the role if you need it");
  });

  it('他の権限は権限名を言い換え、英語は原文を残す', () => {
    expect(ja(403, 'FORBIDDEN', "this operation requires the 'tool:delete' permission")).toBe("この操作には 'tool:delete' 権限が必要です。必要な場合は管理者にロールの付与を依頼してください");
    expect(en(403, 'FORBIDDEN', "this operation requires the 'tool:delete' permission")).toBe("This operation is not permitted (this operation requires the 'tool:delete' permission)");
    // ハンドラ内の追加判定（`authorizeOf`）はリソース種別無しの権限名で来る。
    expect(ja(403, 'FORBIDDEN', "this operation requires the 'approve' permission")).toBe("この操作には 'approve' 権限が必要です。必要な場合は管理者にロールの付与を依頼してください");
  });

  it('定型文でない 403 は見出し + 原文のまま（詳細を握りつぶさない）', () => {
    expect(ja(403, 'FORBIDDEN', 'workspace is read-only')).toBe('この操作は許可されていません（workspace is read-only）');
    expect(ja(403, 'FORBIDDEN', '')).toBe('この操作は許可されていません');
  });

  it('code が FORBIDDEN でなければ定型文でも見出しを付ける（別系統の 403 と混同しない）', () => {
    expect(ja(403, 'UNSAFE_TOOL', MCP_DENIED)).toContain('このツールは現在のモードでは実行できません');
  });
});

describe('status フォールバック（未知の code）', () => {
  it.each([
    [401, '認証が必要です'],
    [403, 'この操作は許可されていません'],
    [409, '現在の状態と競合しました。最新の内容を読み込んでから再試行してください'],
    [410, '対象の有効期限が切れています'],
    [413, 'データ量が上限を超えています'],
    [422, '入力内容を確認してください'],
    [429, 'リクエストが多すぎます。しばらく待って再試行してください'],
    [502, 'APIサーバーに接続できませんでした。稼働状況を確認して再試行してください'],
    [503, 'APIサーバーが応答できません。時間をおいて再試行してください'],
    [504, 'リクエストがタイムアウトしました。時間をおいて再試行してください'],
    [599, 'サーバーでエラーが発生しました。時間をおいて再試行してください'],
    [451, 'リクエストが受け付けられませんでした。入力内容を確認してください'],
    [0, 'リクエストに失敗しました'],
  ])('status %i の見出しを決める', (status, expected) => {
    expect(ja(status, 'SOMETHING_NEW', '')).toBe(expected);
  });

  it('未知 status でも英語見出しを返す', () => {
    expect(en(599, 'SOMETHING_NEW', '')).toBe('The server hit an error. Wait a moment, then retry');
    expect(en(451, 'SOMETHING_NEW', '')).toBe('The request was rejected. Please check your input');
    expect(en(0, 'SOMETHING_NEW', '')).toBe('The request failed');
  });
});

describe('モデル実行の失敗（プロバイダ中立）', () => {
  it('タイムアウト・中断は応答確認とリトライを促す（LM Studioは括弧の補足に留める）', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'Model request was aborted or timed out'))
      .toBe('モデル実行がタイムアウトしました。モデルサーバーの応答とモデルのロード状況を確認して再試行してください（ローカルLM Studioを使う場合は起動しているか確認）。');
    expect(en(502, 'MODEL_PROVIDER', 'Model request was aborted or timed out'))
      .toContain('The model run timed out.');
  });

  it('未設定は設定画面かLM_STUDIO_MODELへ誘導する（v36の新メッセージ）', () => {
    const raw = 'Model is not configured. Choose a model in model settings, or set the LM_STUDIO_MODEL environment variable.';
    expect(ja(502, 'MODEL_PROVIDER', raw)).toBe('モデルが未設定です。設定画面でモデルを選ぶか、環境変数 LM_STUDIO_MODEL を設定してください。');
    expect(en(502, 'MODEL_PROVIDER', raw)).toContain('Choose a model in model settings');
  });

  it('HTTP失敗は認証エラーとそれ以外を分ける（プロバイダを決め打ちしない）', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'Model request failed with HTTP 401')).toBe('モデルサーバーの認証に失敗しました（HTTP 401）。設定画面のAPIキーを確認して再試行してください。');
    expect(en(502, 'MODEL_PROVIDER', 'Model request failed with HTTP 403')).toContain('Check the API key in model settings');
    expect(ja(502, 'MODEL_PROVIDER', 'Model request failed with HTTP 404')).toBe('モデルサーバーがHTTP 404 を返しました。設定画面のモデル設定とエンドポイントを確認して再試行してください。');
    expect(en(502, 'MODEL_PROVIDER', 'Model request failed with HTTP 404')).toContain('HTTP 404');
    expect(ja(502, 'MODEL_PROVIDER', 'Model request failed with HTTP 404')).not.toContain('LM Studio');
  });

  it('応答不正・空応答・接続失敗をそれぞれ案内する', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'Model returned an invalid chat completion')).toContain('ツール呼び出しに対応したモデル');
    expect(en(502, 'MODEL_PROVIDER', 'Model stream returned no completion choice')).toContain('shorten the prompt');
    expect(ja(502, 'MODEL_PROVIDER', 'Model stream returned no completion choice')).toContain('モデルの応答を解釈できませんでした');
    expect(ja(502, 'MODEL_PROVIDER', 'Model request failed')).toBe('モデルサーバーに接続できませんでした。設定画面のモデル設定とエンドポイントを確認してください（ローカルLM Studioを使う場合は起動しているか確認）。');
    expect(en(502, 'MODEL_PROVIDER', 'fetch failed')).toContain('Could not reach the model server.');
  });

  it('未知のモデル失敗は原文を添えて案内する', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'offline')).toBe('モデル実行に失敗しました。設定画面のモデル設定を確認して再試行してください。（offline）');
    expect(en(502, 'MODEL_PROVIDER', 'offline')).toBe('The model run failed. Check the model settings, then retry. (offline)');
    expect(ja(502, 'MODEL_PROVIDER', '')).toBe('モデル実行に失敗しました。設定画面のモデル設定を確認して再試行してください。');
    expect(en(502, 'MODEL_PROVIDER', '')).toBe('The model run failed. Check the model settings, then retry.');
  });

  it('正常: ツール検証の LLM 提案（未設定）は「構造化出力対応モデルを設定画面で選ぶ」へ導く（ja / en）', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'tool check suggestions are not configured')).toBe('ケース提案に使うモデルが設定されていません。設定画面で構造化出力（JSON スキーマ）に対応したモデルを選んでから、もう一度提案してください。');
    expect(en(502, 'MODEL_PROVIDER', 'tool check suggestions are not configured')).toBe('No model is configured for case suggestions. Choose a model that supports structured output (JSON schema) in Settings, then suggest again.');
    // 汎用の「モデルが未設定（LM_STUDIO_MODEL）」に落ちない。
    expect(ja(502, 'MODEL_PROVIDER', 'tool check suggestions are not configured')).not.toContain('LM_STUDIO_MODEL');
  });

  it('正常: LLM 提案の JSON 不正 / 使えるケース無しは「もう一度提案・重点を具体的に」へ導く（ja / en）', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'tool check suggestions: model returned invalid JSON')).toBe('モデルの応答が JSON として読めませんでした。設定画面で構造化出力に対応したモデルか確認し、もう一度提案してください。続くときは「重点」を具体的に書くと安定します。');
    expect(en(502, 'MODEL_PROVIDER', 'tool check suggestions: model returned invalid JSON')).toContain('make the focus more specific');
    expect(ja(502, 'MODEL_PROVIDER', 'tool check suggestions: model returned no usable case')).toBe('モデルは使えるケースを 1 件も返しませんでした（引数がツールの入力に合わない等）。「重点」を具体的に書いてもう一度提案するか、設定画面で別のモデルを試してください。');
    expect(en(502, 'MODEL_PROVIDER', 'tool check suggestions: model returned no usable case')).toBe('The model returned no usable case (for example, arguments that do not match the tool input). Make the focus more specific and suggest again, or try another model in Settings.');
  });

  it('[回帰固定] 境界: 「tool check suggestion」を含むが未知の文は従来どおり汎用のモデル失敗文言に落ちる', () => {
    expect(ja(502, 'MODEL_PROVIDER', 'tool check suggestions exploded')).toContain('モデル実行に失敗しました');
    // 「tool check suggestion」を含まない invalid JSON は従来の「応答を解釈できません」のまま。
    expect(ja(502, 'MODEL_PROVIDER', 'Model returned invalid JSON')).toContain('モデルの応答を解釈できませんでした');
  });

  it('審査プロバイダ失敗とメッセージ内 LM Studio 検出も同じ導線にする', () => {
    expect(ja(502, 'JUDGE_PROVIDER', 'judge model timed out')).toContain('タイムアウト');
    expect(ja(500, 'INTERNAL', 'LM Studio request was aborted or timed out')).toContain('モデル実行がタイムアウト');
  });
});

describe('モデル設定・カタログの失敗は実行エラーと混ぜない', () => {
  it('MODEL_SETTINGS_VALIDATION は入力ミスとして扱い、provider/model 形式を案内する', () => {
    const raw = "createModelSettings: main.model must be in 'provider/model' form, but got 'gpt-4o'";
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', raw)).toBe('モデル設定の入力内容を確認してください（モデルは provider/model 形式で入力してください（例: openai/gpt-4o、入力値: gpt-4o））');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', raw)).not.toContain('LM Studio');
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', raw)).toContain("must be in 'provider/model' form");
  });

  it('ベースURLの不正もモデル実行エラーにしない', () => {
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must use http(s): ftp://x')).toContain('http または https');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must be a valid URL: not a url')).toContain('ベースURLの形式');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must not embed credentials (user:password@host)')).toContain('認証情報');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.model must be a non-empty string')).toContain('必須です');
    // 未知の検証文言は見出し + 原文で残す。
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: props is required')).toBe('モデル設定の入力内容を確認してください（createModelSettings: props is required）');
  });

  it('MODEL_CATALOG（一覧取得失敗・502）は「実行に失敗」ではなく一覧取得の失敗として出す', () => {
    const raw = 'Could not list models from http://127.0.0.1:1234/v1/models';
    expect(ja(502, 'MODEL_CATALOG', raw)).toBe(`モデル一覧を取得できませんでした。エンドポイントとAPIキーを確認して再試行してください（${raw}）`);
    expect(ja(502, 'MODEL_CATALOG', raw)).not.toContain('LM Studio');
    expect(en(502, 'MODEL_CATALOG', 'Model list response did not contain a data array')).toContain('Could not fetch the model list');
  });

  it('SECRET_CIPHER は 500（鍵ファイル不正）と 409（復号失敗）で文言を分ける', () => {
    expect(ja(500, 'SECRET_CIPHER', 'Secret key file is unreadable')).toContain('AGENTCONTEXT_SECRET_KEY_PATH');
    expect(ja(500, 'SECRET_CIPHER', 'Secret key file is unreadable')).toContain('再入力では復旧しません');
    expect(en(500, 'SECRET_CIPHER', 'Secret key file is unreadable')).toContain('will not fix this');
    expect(ja(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted')).toContain('APIキーを再入力');
    expect(ja(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted')).not.toContain('AGENTCONTEXT_SECRET_KEY_PATH');
    expect(en(409, 'SECRET_CIPHER', 'Stored secret could not be decrypted')).toContain('Enter the API key again');
  });
});

describe('ETL定型文の日本語化（GraphError / ConfigError / SchemaError）', () => {
  it.each([
    [
      "node 'join-1' (type 'join') expects 2 input(s) but has in-degree 3",
      'ノード「join-1」(join)には2本の入力が必要ですが、3本接続されています。ノード「join-1」への接続を2本に直してください（余分な接続を外すか、足りない入力をつなぐ）',
    ],
    [
      'graph must have exactly one terminal node, found 2: a, b',
      'グラフの終端ノードは1つだけにしてください(現在2個: a, b)。a, b のうち1つだけを最終出力として残し、他のノードは削除するか下流へつないでください',
    ],
    ['graph has no terminal node (out-degree 0)', '終端ノード(出力)がありません。「出力」からエージェント出力などのノードを置き、最後のノードにつないでください'],
    ['graph has a cycle', 'グラフに循環(ループ)があります。下流から上流へ戻っている接続を1本外してください'],
    ['duplicate node id: source-1', 'ノードID「source-1」が重複しています'],
    ['edge references unknown node id: ghost-1', '存在しないノード「ghost-1」への接続があります'],
    [
      "sink node 'out-1' must be terminal (no downstream nodes)",
      '出力ノード「out-1」の後ろにノードは繋げられません',
    ],
    [
      "edge to 'join-1' uses input port 2 but node type 'join' accepts 2 input(s)",
      'ノード「join-1」の入力ポート2は範囲外です(joinの入力は2本)',
    ],
    [
      "node 'join-1' has multiple edges on input port 0",
      'ノード「join-1」の入力ポート0に複数の接続があります',
    ],
    [
      "node 'join-1' (type 'join') requires explicit input ports on incoming edges",
      'ノード「join-1」への接続には入力ポートの指定が必要です',
    ],
    ['join: key column(s) not found: id, region', '結合キーの列が見つかりません: id, region。結合(join)ノードのキー列「id, region」を、左右の入力に実際にある列名へ直してください'],
    ['summary-statistics: column(s) must be number: score', '数値列が必要です: score'],
    ['group-by: column(s) not found: region, amount', '列が見つかりません: region, amount。group-byノードで参照している列「region, amount」を上流ノードの出力にある列名へ直すか、上流ノードの設定を見直してください'],
    ['sort: column(s) not found: age', '列が見つかりません: age。sortノードで参照している列「age」を上流ノードの出力にある列名へ直すか、上流ノードの設定を見直してください'],
    ["group-by: column 'active' must be number or date or string", '列「active」の型は 数値 / 日付 / 文字列 が必要です。group-byノードの手前に「型変換」(cast)ノードを挟んで列「active」を変換するか、別の列を選んでください'],
    ["summary-statistics: column 'score' must be number", '列「score」の型は 数値 が必要です。summary-statisticsノードの手前に「型変換」(cast)ノードを挟んで列「score」を変換するか、別の列を選んでください'],
    ['group-by: duplicate aggregate name: total', '集計の出力列名が重複しています: total'],
    ["group-by: aggregate 'total' requires a column for op 'sum'", '集計「total」には sum の対象列が必要です'],
    ["group-by: input column 'region' conflicts with generated column", 'group-by: 入力列「region」が自動生成される列と重複しています'],
    [
      "join: key type mismatch: id ('string') vs id ('number')",
      '結合キーの型が一致しません: id (文字列) と id (数値)',
    ],
  ])('GraphError/SchemaError定型文 %s をETL_GRAPH/ETL_SCHEMAの詳細として日本語化する', (raw, japaneseDetail) => {
    expect(ja(422, 'ETL_GRAPH', raw)).toBe(`ノードの接続を確認してください（${japaneseDetail}）`);
    // 英語UIでは詳細を変換せず原文のまま残す（詳細を握りつぶさない）。
    expect(en(422, 'ETL_GRAPH', raw)).toBe(`Please check the node connections (${raw})`);
  });

  it('実行上限・プレビュー引数・時系列補完上限の新メッセージを次の一手つきで和訳し、英語は原文を保つ', () => {
    const cap = 'group-by: produced 300000 rows, exceeding the execution limit of 250000 rows';
    expect(ja(422, 'ETL_SCHEMA', cap)).toContain('ノード（group-by）の出力が 300,000 行になり、実行上限の 250,000 行を超えました');
    expect(ja(422, 'ETL_SCHEMA', cap)).toContain('行数を減らす');
    expect(en(422, 'ETL_SCHEMA', cap)).toContain('produced 300000 rows, exceeding the execution limit of 250000 rows');
    expect(ja(422, 'ETL_CONFIG', 'preview: rowLimit must be a non-negative integer, received -1')).toContain('0 以上の整数');
    expect(ja(422, 'ETL_CONFIG', 'preview: rowLimit must be a non-negative integer, received -1')).toContain('受け取った値: -1');
    expect(ja(422, 'ETL_CONFIG', 'preview: maxRows must be a positive integer, received 0')).toContain('1 以上の整数');
    // セミコロンを含む1文が分割されずに丸ごと和訳される（"narrow the time range" が原文のまま残らない）。
    const fill = ja(422, 'ETL_SCHEMA', 'time-series-analysis: fill would generate more than 100000 buckets; narrow the time range or choose a coarser interval');
    expect(fill).toContain('100,000 バケットを超えます');
    expect(fill).toContain('interval を粗く');
    expect(fill).not.toContain('narrow the time range');
    // 境界: 1 バケット・桁区切り入りの巨大値でも落ちない。
    expect(ja(422, 'ETL_SCHEMA', 'time-series-analysis: fill would generate more than 1 buckets; narrow the time range or choose a coarser interval')).toContain('1 バケット');
    expect(ja(422, 'ETL_SCHEMA', 'source: produced 1,000,000,000 rows, exceeding the execution limit of 250,000 rows')).toContain('1,000,000,000 行');
    // ノードidつき（診断の detail 形）でも本文が和訳される。
    expect(localizeDiagnosticDetail('aggregate-1: group-by: produced 300000 rows, exceeding the execution limit of 250000 rows', 'ja')).toContain('実行上限');
  });

  it('join: output exceeded 100000 rows 系（セミコロン無し）を10万行超過の案内へ変換する', () => {
    expect(ja(422, 'ETL_SCHEMA', 'join: output exceeded 100000 rows'))
      .toBe('列名または型が一致していません。上流ノードの出力を確認してください（結合結果が10万行を超えました。結合キーが正しいか確認してください）');
    expect(en(422, 'ETL_SCHEMA', 'join: output exceeded 100000 rows'))
      .toBe('The column names or types do not match. Check the upstream node output (join: output exceeded 100000 rows)');
  });

  it('join: output exceeded 100000 rows; check join keys（実際にjoin.tsが投げる形。セミコロンあり）も1つの文として変換する', () => {
    // セミコロンは localizeDetail の `;` 分割対象にもなるため、分割前にETL定型文として
    // 丸ごと判定しないと "check join keys" が原文のまま重複表示される（実際に確認して修正した）。
    expect(ja(422, 'ETL_SCHEMA', 'join: output exceeded 100000 rows; check join keys'))
      .toBe('列名または型が一致していません。上流ノードの出力を確認してください（結合結果が10万行を超えました。結合キーが正しいか確認してください）');
  });

  it('未知のETL定型文はheadingだけ差し替え、詳細は原文のまま残す（握りつぶさない）', () => {
    expect(ja(422, 'ETL_GRAPH', 'cycle detected: a -> b -> a')).toBe('ノードの接続を確認してください（cycle detected: a -> b -> a）');
  });

  it('filter の opBinding 検証（既定演算子が許可リスト外）を日本語化する', () => {
    expect(ja(422, 'ETL_SCHEMA', "filter: default operator 'gt' is not in opBinding.allowed (eq, neq)"))
      .toBe('列名または型が一致していません。上流ノードの出力を確認してください（既定の演算子「gt」がAIに許可する演算子(eq, neq)に含まれていません）');
    expect(en(422, 'ETL_SCHEMA', "filter: default operator 'gt' is not in opBinding.allowed (eq, neq)"))
      .toBe("The column names or types do not match. Check the upstream node output (filter: default operator 'gt' is not in opBinding.allowed (eq, neq))");
  });

  it('filter の opBinding 検証（列型が大小比較を許さない。セミコロンを含む1文）を丸ごと日本語化する', () => {
    const raw = "filter: opBinding on 'region' allows operator(s) gt|gte which require column type number|date, but 'region' is 'string'; restrict opBinding.allowed";
    expect(ja(422, 'ETL_SCHEMA', raw))
      .toBe('列名または型が一致していません。上流ノードの出力を確認してください（列「region」(文字列)では大小比較の演算子(gt|gte)をAIに許可できません。AIに許可する演算子を絞ってください）');
  });
});

describe('localizeSchemaIssueMessage（ノード単位のSchemaIssue/propagation issueの日本語化）', () => {
  it('既存ノードが実際に投げる定型文を日本語化する', () => {
    expect(localizeSchemaIssueMessage("chart-output: mapping 'timeColumn' is required", 'ja'))
      .toBe('chart-output: 「timeColumn」の設定が必要です');
    expect(localizeSchemaIssueMessage('summary-statistics: column(s) must be number: score, age', 'ja'))
      .toBe('数値列が必要です: score, age');
    expect(localizeSchemaIssueMessage("join: key type mismatch: id ('string') vs id ('number')", 'ja'))
      .toBe('結合キーの型が一致しません: id (文字列) と id (数値)');
    expect(localizeSchemaIssueMessage('join: output exceeded 100000 rows; check join keys', 'ja'))
      .toBe('結合結果が10万行を超えました。結合キーが正しいか確認してください');
  });

  it('filter の opBinding 検証issueも同じ関数で日本語化できる（見出しなし）', () => {
    expect(localizeSchemaIssueMessage("filter: default operator 'lt' is not in opBinding.allowed (eq, isNull)", 'ja'))
      .toBe('既定の演算子「lt」がAIに許可する演算子(eq, isNull)に含まれていません');
    expect(localizeSchemaIssueMessage("filter: opBinding on 'region' allows operator(s) lt|lte which require column type number|date, but 'region' is 'string'; restrict opBinding.allowed", 'ja'))
      .toBe('列「region」(文字列)では大小比較の演算子(lt|lte)をAIに許可できません。AIに許可する演算子を絞ってください');
  });

  it('joinのwarning系issue(型不一致の可能性・文字列比較)を日本語化する', () => {
    expect(localizeSchemaIssueMessage("join: key type may mismatch: id ('unknown') vs id ('number')", 'ja'))
      .toBe('結合キーの型が一致しない可能性があります: id (不明) と id (数値)');
    expect(localizeSchemaIssueMessage("join: keys compared as text: id ('string') vs id ('number')", 'ja'))
      .toBe('結合キーを文字列として比較します: id (文字列) と id (数値)');
  });

  it('<node>: invalid config: <zod> はzod部分も再帰的に日本語化する', () => {
    expect(localizeSchemaIssueMessage('join: invalid config: mode: Invalid option: expected one of "inner"|"left"|"right"|"full"', 'ja'))
      .toBe('join: 設定が不正です(モード: 次のいずれかを指定してください: inner / left / right / full)。joinノードの設定パネルで該当項目を直してください');
  });

  it('伝播issue（上流ノード無効・union厳密不一致・生成列との衝突）を日本語化する', () => {
    expect(localizeSchemaIssueMessage("upstream node 'source-1' has invalid config", 'ja'))
      .toBe('上流ノード「source-1」の設定が不正です');
    expect(localizeSchemaIssueMessage('union: strict mode requires identical column sets, mismatched: id, extra', 'ja'))
      .toBe('union: 列構成が一致しません(厳密一致モード): id, extra');
    expect(localizeSchemaIssueMessage("chart-output: input column 'isOutlier' conflicts with generated column", 'ja'))
      .toBe('chart-output: 入力列「isOutlier」が自動生成される列と重複しています');
  });

  it('グラフレベルの定型文（GraphErrorが投げるもの）も同じ関数で日本語化できる', () => {
    expect(localizeSchemaIssueMessage('graph has a cycle', 'ja'))
      .toBe('グラフに循環(ループ)があります。下流から上流へ戻っている接続を1本外してください');
  });

  it('英語UIでは変換せず原文のまま返す', () => {
    expect(localizeSchemaIssueMessage("chart-output: mapping 'timeColumn' is required", 'en'))
      .toBe("chart-output: mapping 'timeColumn' is required");
    expect(localizeSchemaIssueMessage('graph has a cycle', 'en')).toBe('graph has a cycle');
  });

  it('未知パターンは言語によらず原文のまま返す（握りつぶさない）', () => {
    expect(localizeSchemaIssueMessage('totally unrecognized issue text', 'ja')).toBe('totally unrecognized issue text');
    expect(localizeSchemaIssueMessage('totally unrecognized issue text', 'en')).toBe('totally unrecognized issue text');
  });
});

/**
 * エージェント実行の内部エラー。**原因の言い換えだけでなく次の一手**まで出ることを確かめる
 * （このWave以前は英語の原文がそのまま括弧に出ていて、利用者は何をすればよいか分からなかった）。
 */
describe('エージェント実行エラー（AGENT_RUN / TOOL_ARGUMENTS / UNSAFE_TOOL）の日本語化', () => {
  function agentRun(message: string, language: 'en' | 'ja' = 'ja'): string {
    return localizeApiErrorMessage({ status: 422, code: 'AGENT_RUN', serverMessage: message }, language);
  }
  function toolArgs(message: string): string {
    return localizeApiErrorMessage({ status: 422, code: 'TOOL_ARGUMENTS', serverMessage: message }, 'ja');
  }
  function unsafe(message: string): string {
    return localizeApiErrorMessage({ status: 403, code: 'UNSAFE_TOOL', serverMessage: message }, 'ja');
  }

  it('存在しないツール呼び出しは、接続を確認する案内にする', () => {
    expect(agentRun('model requested unknown tool: lookup_sales'))
      .toBe('エージェントの実行に失敗しました（モデルが存在しないツール「lookup_sales」を呼ぼうとしました。エージェントに必要なツールが接続されているか確認してください）');
    // ランタイムツール / MCP の未知ツールも同じ案内へ寄せる。
    expect(agentRun('unknown MCP tool: mcp__files__read')).toContain('mcp__files__read');
    expect(agentRun('unknown runtime harness tool: todos_add')).toContain('todos_add');
  });

  it('MCPサーバーを解決できない場合は接続テストへ誘導する', () => {
    expect(agentRun("MCP tool 'mcp__files__read' is unavailable: its MCP server could not be resolved for this run"))
      .toContain('MCP設定画面で接続をテスト');
  });

  it('ツール呼び出し上限・往復上限は、上限値と広げ方を示す', () => {
    expect(agentRun('tool call limit exceeded: maximum 4'))
      .toBe('エージェントの実行に失敗しました（1回の実行で使えるツール呼び出しの上限（4回）に達しました。目的を分けて質問するか、エージェントのハーネス設定で上限を広げてください）');
    expect(agentRun('model round limit exceeded: maximum 5')).toContain('モデルとの往復回数の上限（5回）');
  });

  it('ツリー共有バジェットの枯渇は、委譲を減らす案内にする', () => {
    expect(agentRun('run budget exhausted: model rounds')).toContain('モデル往復の予算を使い切りました');
    expect(agentRun('run budget exhausted: tool calls')).toContain('ツール呼び出しの予算を使い切りました');
  });

  it('構造化出力の検証失敗は、項目名と次の手を示す', () => {
    expect(agentRun("structured response is missing required field 'answer'"))
      .toBe('エージェントの実行に失敗しました（モデルの応答に必要な項目「answer」がありませんでした。別のモデルを試すか、構造化出力の項目を減らしてください）');
    expect(agentRun("structured response contains unknown field 'extra'")).toContain('定義していない項目「extra」');
    expect(agentRun("structured response field 'score' must be integer")).toContain('項目「score」の型が違います（integer が必要）');
    expect(agentRun('structured response is not valid JSON')).toContain('JSONとして解釈できませんでした');
    expect(agentRun('structured response must be a JSON object')).toContain('JSONとして解釈できませんでした');
  });

  it('モデルの能力不足は、設定画面での切り替えへ誘導する', () => {
    expect(agentRun('configured model provider does not support tool-calling')).toContain('ツール呼び出しに対応したモデルへ切り替え');
    expect(agentRun('configured model provider does not support structured output')).toContain('構造化出力に対応していません');
    expect(agentRun('configured model provider does not support image input')).toContain('画像入力に対応していません');
  });

  it('モデルがツール呼び出しに失敗した場合の案内', () => {
    expect(agentRun('model reported tool_calls without a tool call')).toContain('ツール呼び出しに対応したモデルを選び直して');
    expect(agentRun('model requested a tool call but function invocation is disabled for this agent')).toContain('ハーネス設定でツール実行を有効に');
  });

  it('ツール引数の不備は、引数名と直し方を示す', () => {
    expect(toolArgs('required argument missing: minimumScore'))
      .toBe('エージェントがツールを不正な引数で呼び出しました。ツールのスキーマとプロンプトを見直してください（モデルがツールの必須引数「minimumScore」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください）');
    expect(toolArgs("invalid argument 'score': expected number")).toContain('引数「score」の型が違います（number が必要）');
    // 新形式は「受け取った値」も併記する（旧Runの保存済みメッセージは received 無しのまま上で解釈される）。
    expect(toolArgs('invalid argument \'query\': expected string, received ["wireless headphones"] (array)'))
      .toContain('引数「query」の型が違います（string が必要、受け取った値: ["wireless headphones"] (array)）');
    expect(toolArgs('unknown argument(s): region, month')).toContain('存在しない引数「region, month」');
  });

  it('副作用ガード（UNSAFE_TOOL）は read-only へ寄せる案内にする', () => {
    expect(unsafe("Agent preview refuses write effective side-effect for agent 'sales-agent'"))
      .toBe("このツールは現在のモードでは実行できません（エージェント「sales-agent」は副作用「write」を持つためプレビュー実行できません。読み取り専用（read-only / session-write）のツールだけを接続してください）");
    expect(unsafe("Agent preview refuses external-action effective side-effect for additional sub-agent 'poster'")).toContain('エージェント「poster」');
    expect(unsafe("Agent preview refuses write tool 'crm-writer'")).toContain('ツール「crm-writer」は副作用「write」');
  });

  it('承認・セッション・記憶まわりも次の操作を示す', () => {
    expect(agentRun("run 'run-1' is not waiting for approval")).toContain('画面を開き直して');
    expect(agentRun('approval checkpoint expired at 2026-07-28T00:00:00.000Z')).toContain('ツール承認の期限');
    expect(agentRun("run 'run-1' approval checkpoint expired at 2026-07-28T00:00:00.000Z")).toContain('ツール承認の期限');
    expect(agentRun('agent session belongs to a different Agent version')).toContain('「新しいチャット」を開始');
    expect(agentRun("memory page 'p1' is outside Agent wiki allowlist")).toContain('参照Wiki設定');
    // 汎用の「... not found: id」変換に食われず、専用の案内が出る。
    expect(agentRun('workspace artifact not found: a-1')).toContain('セッション内の成果物「a-1」');
    expect(agentRun('web_search has no configured search provider')).toContain('検索プロバイダを登録');
  });

  it('ツール定義の不整合はツール画面での直し方を示す', () => {
    expect(agentRun("filter node 'f1' references an unavailable Agent input")).toContain('引数（Agent Input）の宣言と接続');
    expect(agentRun("tool inputSchema does not match agent-input node 'in'")).toContain('引数を保存し直して');
    expect(agentRun('tool declares inputSchema but has no agent-input node')).toContain('引数ノードを追加');
    expect(agentRun('saved Agent execution is not configured')).toContain('サーバーの起動設定');
    expect(agentRun('additional sub-agent not found: sub@1.0.0')).toContain('サブエージェント「sub@1.0.0」');
  });

  it('英語UIでも次の一手を示す（原文のままにしない）', () => {
    expect(agentRun('model requested unknown tool: lookup_sales', 'en'))
      .toBe("The agent run failed (the model called a tool named 'lookup_sales' that is not connected. Check the tools attached to this agent)");
    expect(agentRun('tool call limit exceeded: maximum 4', 'en')).toContain('raise the limit in the agent harness settings');
  });

  it('未知の実行エラーは原文を括弧で残す（詳細を握りつぶさない）', () => {
    expect(agentRun('some brand new agent failure')).toBe('エージェントの実行に失敗しました（some brand new agent failure）');
  });

  it('中断されたRunの失敗コードにも見出しがある', () => {
    expect(localizeApiErrorMessage({ status: 499, code: 'RUN_CANCELLED', serverMessage: 'run cancelled by the user' }, 'ja'))
      .toBe('実行を中断しました');
  });
});

/**
 * filter の opBinding（演算子のAI引数化）の保存時検証。`TOOL_VALIDATION` の見出しに続く詳細として、
 * 原因の言い換えと次の一手（Agent Input の型変更 / 許可リストの見直し）を両言語で出す。
 */
describe('SaveTool の opBinding 検証（TOOL_VALIDATION）の日本語化', () => {
  function toolValidation(message: string, language: 'en' | 'ja' = 'ja'): string {
    return localizeApiErrorMessage({ status: 400, code: 'TOOL_VALIDATION', serverMessage: message }, language);
  }

  it('string 以外の引数への演算子束縛は、Agent Input の型変更へ誘導する', () => {
    expect(toolValidation("SaveTool: operator binding for argument 'op' requires a string argument, but it is declared as 'number'"))
      .toBe('ツール定義を確認してください（演算子を受け取る引数「op」は string 型で宣言する必要がありますが、number 型になっています。Agent Inputノードで型を string に変更してください）');
    expect(toolValidation("SaveTool: operator binding for argument 'op' requires a string argument, but it is declared as 'number'", 'en'))
      .toBe("Please check the tool definition (the operator-bound argument 'op' must be a string argument, but it is declared as 'number'. Change its type to string on the Agent Input node)");
  });

  it('共通の許可演算子が無いときは、条件間の許可リストを揃える案内にする', () => {
    expect(toolValidation("SaveTool: operator binding for argument 'op' has no operator that every condition allows"))
      .toBe('ツール定義を確認してください（引数「op」で演算子を受け取る条件の間に、共通して許可された演算子が1つもありません。各条件の「AIに許可する演算子」を見直してください）');
    expect(toolValidation("SaveTool: operator binding for argument 'op' has no operator that every condition allows", 'en'))
      .toContain("no operator is allowed by every condition that binds argument 'op'");
  });

  it('field 未選択の演算子束縛は、フィールド選択へ誘導する', () => {
    expect(toolValidation('SaveTool: operator binding is missing its input field'))
      .toBe('ツール定義を確認してください（演算子をエージェント入力から受け取る設定に、参照する入力フィールドが選ばれていません。フィルタ条件の「エージェント入力フィールド（演算子）」を選択してください）');
    expect(toolValidation('SaveTool: operator binding is missing its input field', 'en'))
      .toContain('no input field selected');
  });

  it('field 未選択の値束縛も、フィールド選択へ誘導する（演算子側と対称）', () => {
    expect(toolValidation('SaveTool: value binding is missing its input field'))
      .toBe('ツール定義を確認してください（条件値をエージェント入力から受け取る設定に、参照する入力フィールドが選ばれていません。フィルタ条件の「エージェント入力フィールド」を選択してください）');
    expect(toolValidation('SaveTool: value binding is missing its input field', 'en'))
      .toContain('no input field selected');
  });

  it('比較値と演算子の二重束縛は、引数を分ける案内にする（セミコロンを含む1文を分割しない）', () => {
    expect(toolValidation("SaveTool: argument 'op' is bound as both a comparison value and an operator; declare two separate arguments"))
      .toBe('ツール定義を確認してください（引数「op」が比較値と演算子の両方に束縛されています。Agent Inputノードで引数を2つに分けて宣言し、それぞれを束縛してください）');
    expect(toolValidation("SaveTool: argument 'op' is bound as both a comparison value and an operator; declare two separate arguments", 'en'))
      .toContain('Declare two separate arguments on the Agent Input node');
  });

  it('isNull/notNull を許可する場合の値引数は、nullable 化へ誘導する', () => {
    expect(toolValidation("SaveTool: operator binding allows isNull/notNull, so the value argument 'minAmount' must be nullable"))
      .toBe('ツール定義を確認してください（AIに許可する演算子に isNull/notNull が含まれるため、値を受け取る引数「minAmount」は任意（nullable）にする必要があります。Agent Inputノードでその引数を任意に変更してください）');
    expect(toolValidation("SaveTool: operator binding allows isNull/notNull, so the value argument 'minAmount' must be nullable", 'en'))
      .toContain('Mark that argument as optional on the Agent Input node');
  });

  it('既定演算子の条件間不一致は、同じ値へ揃える案内にする', () => {
    expect(toolValidation("SaveTool: operator binding for argument 'op' must use the same default operator in every condition"))
      .toBe('ツール定義を確認してください（引数「op」で演算子を受け取る条件の間で「既定の演算子」が一致していません。各条件の既定の演算子を同じ値に揃えてください）');
    expect(toolValidation("SaveTool: operator binding for argument 'op' must use the same default operator in every condition", 'en'))
      .toContain('Set the same default operator on every condition');
  });

  it('SaveTool ラップ（graph validation failed: <nodeId>: <issue>）の単一 issue を丸ごと和訳する', () => {
    // `;` を含む opBinding の1文が `; ` 分割で断片化しない（分割すると "restrict opBinding.allowed" が原文のまま残る）。
    expect(toolValidation("SaveTool: graph validation failed: filter-1: filter: opBinding on 'region' allows operator(s) gt|gte which require column type number|date, but 'region' is 'string'; restrict opBinding.allowed"))
      .toBe('ツール定義を確認してください（filter-1: 列「region」(文字列)では大小比較の演算子(gt|gte)をAIに許可できません。AIに許可する演算子を絞ってください）');
    expect(toolValidation("SaveTool: graph validation failed: filter-1: filter: default operator 'gt' is not in opBinding.allowed (eq, neq)"))
      .toBe('ツール定義を確認してください（filter-1: 既定の演算子「gt」がAIに許可する演算子(eq, neq)に含まれていません）');
  });

  it('SaveTool ラップの複数 issue 連結は丸ごと和訳せず、従来の分割動作へフォールバックする（原文を握りつぶさない）', () => {
    const raw = "SaveTool: graph validation failed: filter-1: filter: default operator 'gt' is not in opBinding.allowed (eq, neq); filter-2: filter: column not found: age";
    const localized = toolValidation(raw);
    expect(localized).toContain("filter-2: filter: column not found: age");
    expect(localized).toContain('graph validation failed');
  });
});

/**
 * 保存時（SaveTool / createTool）・実行時・診断で同文になるツール定義の検査。どれも「どの画面の
 * どこを直すか」まで出ること、`SaveTool: ` 前置詞の有無で結果が変わらないことを確かめる。
 */
describe('ツール定義・関数名・演算子・出力上限のメッセージ', () => {
  function toolValidation(message: string, language: 'en' | 'ja' = 'ja'): string {
    return localizeApiErrorMessage({ status: 400, code: 'TOOL_VALIDATION', serverMessage: message }, language);
  }
  function agentRun(message: string, language: 'en' | 'ja' = 'ja'): string {
    return localizeApiErrorMessage({ status: 422, code: 'AGENT_RUN', serverMessage: message }, language);
  }

  it('ワークスペース出力の副作用不足は、メタデータの副作用変更へ誘導する', () => {
    expect(toolValidation('SaveTool: workspace output requires sideEffect session-write or stronger')).toContain('副作用を session-write に変更');
    expect(toolValidation('SaveTool: workspace output requires sideEffect session-write or stronger', 'en')).toContain('Set the side effect to session-write');
  });

  it('Agent input 束縛と inputSchema の不整合は、Agent Input ノードへ誘導する', () => {
    expect(toolValidation('SaveTool: Agent input bindings require an inputSchema')).toContain('Agent Inputノードを追加して引数を宣言');
    expect(toolValidation("SaveTool: Agent input binding references unknown field 'minAge'")).toContain('引数「minAge」を参照しています。Agent Inputノードに「minAge」を追加');
    expect(toolValidation("SaveTool: Agent input binding references unknown field 'minAge'", 'en')).toContain("Add 'minAge' to the Agent Input node");
  });

  it('出力スキーマの不一致は、保存時・診断の両形を同じ案内にし、不一致の要約も日本語化する', () => {
    expect(toolValidation("SaveTool: declared output schema does not match the graph's inferred output (mismatch at 'total')"))
      .toBe('ツール定義を確認してください（宣言した出力スキーマがグラフから推論した出力と一致しません（列「total」が不一致）。ツール画面で出力スキーマを更新して保存し直してください）');
    // 診断（output-schema 検査）はセミコロンを含む注記付きの1文。分割せず丸ごと変換する。
    expect(localizeDiagnosticDetail("declared output schema does not match the graph's inferred output (column count mismatch: expected 3, received 2) — the run fails after the tool executes; re-save the tool to refresh its output schema", 'ja'))
      .toBe('宣言した出力スキーマがグラフから推論した出力と一致しません（列数の不一致: 宣言 3 列 / 推論 2 列）。ツール画面で出力スキーマを更新して保存し直してください');
    expect(localizeDiagnosticDetail("declared output schema does not match the graph's inferred output (mismatch at 'total')", 'en'))
      .toContain("(mismatch at 'total'). Refresh the output schema in the Tool Builder");
  });

  it('関数名として使えないツール名は、Agent context パネルでの命名規則を示す（保存時・実行時・createTool）', () => {
    expect(toolValidation('createTool: agentTool.name must be a valid function name')).toContain('「エージェント向けコンテキスト」で、英数字・_・- のみ1〜64文字');
    expect(toolValidation('SaveTool: tool name is not a valid function name: 売上 検索')).toContain('ツール名「売上 検索」は関数名として使えません');
    expect(agentRun('tool name is not a valid function name: 売上 検索', 'en')).toContain("the tool name '売上 検索' is not a valid function name. In the Tool Builder \"Agent context\" panel");
    expect(localizeDiagnosticDetail('sub-agent tool name is not a valid function name: ask_営業', 'ja')).toContain('委譲ツール名「ask_営業」は関数名として使えません。サブエージェントの公開名を');
  });

  it('SaveTool 前置詞つきの実行時同形メッセージも前置詞を剥がして変換する', () => {
    expect(toolValidation("SaveTool: tool inputSchema does not match agent-input node 'in'")).toContain('Agent Inputノード「in」の列が一致していません');
    expect(toolValidation('SaveTool: tool declares inputSchema but has no agent-input node')).toContain('引数ノードを追加してください');
  });

  it('許可されていない演算子は、引数名・演算子・許可リストと直し方を示す', () => {
    const raw = "invalid operator 'like' for argument 'op': expected one of eq, neq, gt";
    expect(localizeApiErrorMessage({ status: 422, code: 'TOOL_ARGUMENTS', serverMessage: raw }, 'ja'))
      .toContain('引数「op」に許可されていない演算子「like」を渡しました（許可: eq, neq, gt）。ツールの引数の説明で使える演算子を明示するか、フィルタ条件の「AIに許可する演算子」を広げてください');
    expect(localizeApiErrorMessage({ status: 422, code: 'TOOL_ARGUMENTS', serverMessage: raw }, 'en'))
      .toContain("the operator 'like' for argument 'op', which is not allowed (allowed: eq, neq, gt)");
  });

  it('agent-output の上限超過は 413/SESSION_QUOTA_EXCEEDED でも「成果物を削除」ではなく行数削減・ワークスペース出力へ誘導する', () => {
    const raw = 'agent-output exceeds maxBytes (120000 > 65536); reduce rows or use workspace-output';
    expect(localizeApiErrorMessage({ status: 413, code: 'SESSION_QUOTA_EXCEEDED', serverMessage: raw }, 'ja'))
      .toBe('ツールの出力（120000 バイト）がエージェント出力の上限（65536 バイト）を超えました。ツール画面で「行数制限」ノードなどで行数を減らすか、出力ノードを「ワークスペース出力」に切り替えてください');
    expect(localizeApiErrorMessage({ status: 413, code: 'SESSION_QUOTA_EXCEEDED', serverMessage: raw }, 'en'))
      .toBe('the tool output (120000 bytes) exceeds the agent-output limit (65536 bytes). In the Tool Builder, reduce the rows (for example with a Limit node) or switch the output node to Workspace output');
    // 本来のセッション容量超過（成果物の上限）は従来の見出しのまま。
    expect(localizeApiErrorMessage({ status: 413, code: 'SESSION_QUOTA_EXCEEDED', serverMessage: 'session quota exceeded' }, 'ja')).toContain('不要な成果物を削除');
  });
});

/**
 * プリフライト診断（組み込みチェック / 呼び出し診断 / ツール診断）の detail。実行時と同じ表を通し、
 * 各行が「どの画面で何を直すか」で終わることを確かめる。
 */
describe('localizeDiagnosticDetail（診断 detail の文言）', () => {
  it.each([
    ['referenced tool not found: sales-lookup@1.2.0', '参照しているツール「sales-lookup@1.2.0」が見つかりません。エージェント画面の「ツール」で参照を外すか、存在するバージョンへ付け替えてください', "the referenced tool 'sales-lookup@1.2.0' does not exist. In Agent Builder → Tools, detach it or point the reference at an existing version"],
    ['referenced skill not found: triage@1.0.0', '参照しているスキル「triage@1.0.0」が見つかりません。エージェント画面の「スキル」で参照を外すか、存在するバージョンへ付け替えてください', "the referenced skill 'triage@1.0.0' does not exist. In Agent Builder → Skills, detach it or point the reference at an existing version"],
    ['referenced sub-agent not found: scorer@2.0.0', '参照しているサブエージェント「scorer@2.0.0」が見つかりません。エージェント画面の「サブエージェント」で参照を外すか、存在するバージョンへ付け替えてください', "the referenced sub-agent 'scorer@2.0.0' does not exist. In Agent Builder → Sub-agents, detach it or point the reference at an existing version"],
    ['ambiguous tool versions: sales@1.0.0 and sales@1.1.0', 'ツール「sales」が複数のバージョン（1.0.0 と 1.1.0）で参照されています。エージェント画面で直付けツールとスキル経由のツールを同じバージョンに揃えてください', "the tool 'sales' is referenced at two versions (1.0.0 and 1.1.0). Align the direct tool reference and the skill's tool reference on one version in Agent Builder"],
    ['sub-agent tool name collides with an existing tool or sub-agent: ask_scorer', 'サブエージェントの委譲ツール名「ask_scorer」が既存のツールまたはサブエージェントと重複しています。サブエージェントの公開名を変えるか、重複するツールをエージェントから外してください', "the sub-agent delegation tool name 'ask_scorer' collides with an existing tool or sub-agent. Rename the sub-agent's publish name, or detach the conflicting tool from the agent"],
    ['duplicate function name(s): lookup, ask_scorer — later tools with the same name are unreachable', 'モデルへ公開する関数名「lookup, ask_scorer」が重複しています（後ろのツールはモデルから呼べません）。ツール画面の「エージェント向けコンテキスト」で名前を変えるか、重複するツールをエージェントから外してください', "the function name(s) 'lookup, ask_scorer' are exposed to the model more than once (the later tools are unreachable). Rename them in the Tool Builder \"Agent context\" panel, or detach the duplicates from the agent"],
    ["side effect 'write' pauses the run for approval before this tool executes", '副作用「write」のツールは実行前に承認待ちで停止します。自動で流したい場合はエージェントのハーネス設定でツール承認を無効にするか、read-only のツールへ差し替えてください', "the 'write' side effect pauses the run for approval before this tool executes. To run unattended, turn off tool approval in the agent's harness settings, or switch to a read-only tool"],
    ['referenced MCP server not found: files', '参照しているMCPサーバー「files」が登録されていません。MCP設定画面でサーバーを登録するか、エージェント画面のMCPサーバー一覧から外してください', "the referenced MCP server 'files' is not registered. Register it in MCP settings, or remove it from the agent's MCP server list"],
    ["MCP server 'files' is disabled, so its tools are skipped at run time", 'MCPサーバー「files」は無効化されているため、そのツールは実行時に読み込まれません。MCP設定画面でサーバーを有効化してください', "the MCP server 'files' is disabled, so its tools are skipped at run time. Enable it in MCP settings"],
    ['model settings could not be resolved: main slot is empty', 'モデル設定を解決できませんでした（main slot is empty）。設定画面のモデル設定でメインモデルを保存し、「テスト」で疎通を確認してください', 'the model settings could not be resolved (main slot is empty). Save the main model in model settings and run "Test" to check the connection'],
    ['harness enables web search but no search provider is configured, so the web_search tool is not offered', 'ハーネス設定でWeb検索が有効ですが検索プロバイダが未設定のため、web_search ツールはモデルへ提供されません。サーバーの環境変数で検索プロバイダを設定するか、ハーネス設定のWeb検索を無効にしてください', 'the harness enables web search, but no search provider is configured, so the web_search tool is not offered. Configure a search provider in the server environment, or turn off web search in the harness settings'],
    ['harness enables file memory but the agent references no wiki, so memory tools have nothing to read', 'ハーネス設定でファイル記憶が有効ですがエージェントが参照するWikiが無いため、記憶ツールは何も読めません。エージェント画面で参照Wikiを追加するか、ハーネス設定のファイル記憶を無効にしてください', 'the harness enables file memory, but the agent references no wiki, so the memory tools have nothing to read. Add a wiki reference in Agent Builder, or turn off file memory in the harness settings'],
    ['tool is archived, so it should not be attached to an agent', 'このツールはアーカイブ済みのため、エージェントに接続したままにしないでください。エージェント画面で外すか、後継バージョンへ付け替えてください', 'this tool is archived and should not stay attached to an agent. Detach it in Agent Builder, or point the reference at a successor version'],
    ['tool is deprecated and may be archived later', 'このツールは非推奨で、今後アーカイブされる可能性があります。エージェント画面で後継バージョンへ付け替えることを検討してください', 'this tool is deprecated and may be archived later. Consider moving the reference to a successor version in Agent Builder'],
    ["operator argument 'op' has no operator that every condition allows", '演算子を受け取る引数「op」に、すべての条件が共通して許可する演算子がありません。ツール画面のフィルタ条件で「AIに許可する演算子」を揃えてください', "no operator is allowed by every filter condition that binds argument 'op'. Align the allowed operator lists on those conditions in the Tool Builder"],
    ["operator argument 'op' has conflicting default operators across conditions", '演算子を受け取る引数「op」の既定の演算子が条件間で一致していません。ツール画面のフィルタ条件で既定の演算子を同じ値に揃えてください', "the conditions that bind argument 'op' use different default operators. Set the same default operator on every condition in the Tool Builder"],
    ["operator argument 'op' is not declared in the input schema, so the binding is inactive at run time", '演算子を受け取る引数「op」がツールの引数に宣言されていないため、実行時にこの束縛は無効になります。Agent Inputノードに string 型の引数「op」を追加してください', "the operator argument 'op' is not declared in the tool's arguments, so the binding is inactive at run time. Add a string argument 'op' on the Agent Input node"],
    ["operator argument 'op' must be declared as a string argument, but it is 'number'", '演算子を受け取る引数「op」は string 型で宣言する必要がありますが、number 型になっています。Agent Inputノードで型を string に変更してください', "the operator argument 'op' must be declared as a string argument, but it is 'number'. Change its type to string on the Agent Input node"],
  ])('%s を両言語で次の一手つきに変換する', (raw, japanese, english) => {
    expect(localizeDiagnosticDetail(raw, 'ja')).toBe(japanese);
    expect(localizeDiagnosticDetail(raw, 'en')).toBe(english);
  });

  it('`; ` で連結された複数 detail は1件ずつ変換して連結する', () => {
    const raw = "operator argument 'op' has conflicting default operators across conditions; operator argument 'other' is not declared in the input schema, so the binding is inactive at run time";
    const localized = localizeDiagnosticDetail(raw, 'ja');
    expect(localized).toContain('引数「op」の既定の演算子が条件間で一致していません');
    expect(localized).toContain('引数「other」がツールの引数に宣言されていない');
  });

  /**
   * 検査内部の基盤側の失敗（検査全体を落とさず detail として報告される）。原文の接続エラー等は括弧で残し、
   * 直す画面と「診断をもう一度実行する」までを両言語で出す。
   */
  it('mcp-servers 検査: MCP サーバー設定の解決失敗は原文を残して MCP 設定画面と再実行へ誘導する', () => {
    const raw = "MCP server 'files' could not be resolved: connect ECONNREFUSED 127.0.0.1:3000";
    expect(localizeDiagnosticDetail(raw, 'ja'))
      .toBe('MCPサーバー「files」を解決できませんでした（connect ECONNREFUSED 127.0.0.1:3000）。MCP設定画面でサーバーの登録内容と接続を確認してから、診断をもう一度実行してください');
    expect(localizeDiagnosticDetail(raw, 'en'))
      .toBe("the MCP server 'files' could not be resolved (connect ECONNREFUSED 127.0.0.1:3000). Check the server registration and connection in MCP settings, then re-run the check");
    // 原文に `: ` が含まれていても名前と原文を取り違えない。
    expect(localizeDiagnosticDetail("MCP server 'crm.v2' could not be resolved: secret decrypt failed: key file missing", 'en'))
      .toContain("the MCP server 'crm.v2' could not be resolved (secret decrypt failed: key file missing)");
  });

  it('harness 検査: Web検索プロバイダ設定の解決失敗は原文を残して環境変数の確認と再実行へ誘導する', () => {
    const raw = 'search provider configuration could not be resolved: WEB_SEARCH_API_KEY is set but WEB_SEARCH_PROVIDER is empty';
    expect(localizeDiagnosticDetail(raw, 'ja'))
      .toBe('Web検索プロバイダの設定を解決できませんでした（WEB_SEARCH_API_KEY is set but WEB_SEARCH_PROVIDER is empty）。設定画面または .env の検索プロバイダの環境変数を確認してから、診断をもう一度実行してください');
    expect(localizeDiagnosticDetail(raw, 'en'))
      .toBe('the web search provider configuration could not be resolved (WEB_SEARCH_API_KEY is set but WEB_SEARCH_PROVIDER is empty). Check the search provider environment variables in Settings or .env, then re-run the check');
  });

  it('基盤側の失敗が `; ` 連結の detail 一覧に混ざっていても、それぞれを変換して連結する', () => {
    const raw = "referenced MCP server not found: files; MCP server 'crm' could not be resolved: connect ECONNREFUSED; search provider configuration could not be resolved: provider 'x' is unknown";
    const japanese = localizeDiagnosticDetail(raw, 'ja');
    expect(japanese).toBe([
      '参照しているMCPサーバー「files」が登録されていません。MCP設定画面でサーバーを登録するか、エージェント画面のMCPサーバー一覧から外してください',
      'MCPサーバー「crm」を解決できませんでした（connect ECONNREFUSED）。MCP設定画面でサーバーの登録内容と接続を確認してから、診断をもう一度実行してください',
      "Web検索プロバイダの設定を解決できませんでした（provider 'x' is unknown）。設定画面または .env の検索プロバイダの環境変数を確認してから、診断をもう一度実行してください",
    ].join('、'));
    const english = localizeDiagnosticDetail(raw, 'en');
    expect(english).toContain("the MCP server 'crm' could not be resolved (connect ECONNREFUSED). Check the server registration and connection in MCP settings, then re-run the check, the web search provider configuration could not be resolved (provider 'x' is unknown)");
  });

  it('graph 検査の `<nodeId>: <issue>` 連結はノードIDを残して issue を変換する', () => {
    expect(localizeDiagnosticDetail('filter-1: filter: column(s) not found: age; sort-1: sort: column(s) not found: age', 'ja'))
      .toBe('filter-1: 列が見つかりません: age。filterノードで参照している列「age」を上流ノードの出力にある列名へ直すか、上流ノードの設定を見直してください、sort-1: 列が見つかりません: age。sortノードで参照している列「age」を上流ノードの出力にある列名へ直すか、上流ノードの設定を見直してください');
  });

  it('未知の detail は原文のまま返す（握りつぶさない）', () => {
    expect(localizeDiagnosticDetail('Skill repository is not configured', 'ja')).toBe('Skill repository is not configured');
    expect(localizeDiagnosticDetail('', 'ja')).toBe('');
  });
});

describe('localizeRunTraceError（トレースの error イベント）', () => {
  it('`(retrying n/m)` 接尾辞を剥がして本文を変換し、再試行の注記を付け直す', () => {
    expect(localizeRunTraceError({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 1/1)' }, 'ja'))
      .toBe('モデルがツールの必須引数「month」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）');
    expect(localizeRunTraceError({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 1/1)' }, 'en'))
      .toBe("the model omitted the required tool argument 'month'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)");
  });

  it('接尾辞が無ければ本文だけを変換し、未知の本文は原文を残す', () => {
    expect(localizeRunTraceError({ code: 'AGENT_RUN', message: 'model requested unknown tool: lookup' }, 'ja')).toContain('存在しないツール「lookup」');
    expect(localizeRunTraceError({ code: 'E_X', message: 'bad' }, 'ja')).toBe('bad');
  });
});

describe('localizeRunFailure（保存済み Run の failure）', () => {
  it('code に見出しがあれば見出し（詳細）、モデル失敗はプロバイダ中立の案内にする', () => {
    expect(localizeRunFailure({ code: 'AGENT_RUN', message: 'tool call limit exceeded: maximum 4' }, 'ja'))
      .toBe('エージェントの実行に失敗しました（1回の実行で使えるツール呼び出しの上限（4回）に達しました。目的を分けて質問するか、エージェントのハーネス設定で上限を広げてください）');
    expect(localizeRunFailure({ code: 'MODEL_PROVIDER', message: 'fetch failed' }, 'en')).toContain('Could not reach the model server');
  });

  it('見出しの無い code は汎用見出しを付けず、詳細（変換できれば変換後）だけを出す', () => {
    expect(localizeRunFailure({ code: 'E_X', message: 'bad' }, 'ja')).toBe('bad');
    expect(localizeRunFailure({ code: 'CUSTOM', message: 'model requested unknown tool: lookup' }, 'en')).toContain("the model called a tool named 'lookup'");
  });

  it('agent-output の上限超過は成果物削除の見出しを使わない', () => {
    expect(localizeRunFailure({ code: 'SESSION_QUOTA_EXCEEDED', message: 'agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output' }, 'ja')).not.toContain('成果物');
  });
});

/**
 * RunFailureNotice が「次の一手」を先頭に太字で出すための分割。この層の文言の3つの形
 * （見出し（原因。次の一手）／原因。次の一手／分けられない1文）と、原文の括弧書き補足を確かめる。
 */
describe('splitFailureMessage（原因と次の一手の分割）', () => {
  it('見出し（原因。次の一手）は見出しを原因側へ戻し、次の一手だけを取り出す', () => {
    expect(splitFailureMessage('エージェントの実行に失敗しました（モデルが存在しないツール「x」を呼ぼうとしました。エージェントに必要なツールが接続されているか確認してください）', 'ja'))
      .toEqual({ cause: 'エージェントの実行に失敗しました（モデルが存在しないツール「x」を呼ぼうとしました）', action: 'エージェントに必要なツールが接続されているか確認してください' });
    expect(splitFailureMessage("The agent run failed (the model called a tool named 'x' that is not connected. Check the tools attached to this agent)", 'en'))
      .toEqual({ cause: "The agent run failed (the model called a tool named 'x' that is not connected)", action: 'Check the tools attached to this agent' });
  });

  it('原因の中の括弧書きは分割の妨げにならず、最後の文境界で切る', () => {
    expect(splitFailureMessage('ツール定義を確認してください（宣言した出力スキーマがグラフから推論した出力と一致しません（列「total」が不一致）。ツール画面で出力スキーマを更新して保存し直してください）', 'ja'))
      .toEqual({ cause: 'ツール定義を確認してください（宣言した出力スキーマがグラフから推論した出力と一致しません（列「total」が不一致））', action: 'ツール画面で出力スキーマを更新して保存し直してください' });
    expect(splitFailureMessage("the model passed the operator 'like' for argument 'op', which is not allowed (allowed: eq, neq). Describe the allowed operators in the tool argument", 'en'))
      .toEqual({ cause: "the model passed the operator 'like' for argument 'op', which is not allowed (allowed: eq, neq)", action: 'Describe the allowed operators in the tool argument' });
  });

  it('末尾の括弧書き（原文の補足）は文として扱わず、その前の境界で切る（modelMessage の汎用形）', () => {
    expect(splitFailureMessage('The model run failed. Check the model settings, then retry. (offline)', 'en'))
      .toEqual({ cause: 'The model run failed', action: 'Check the model settings, then retry. (offline)' });
    expect(splitFailureMessage('モデル実行に失敗しました。設定画面のモデル設定を確認して再試行してください。（offline）', 'ja'))
      .toEqual({ cause: 'モデル実行に失敗しました', action: '設定画面のモデル設定を確認して再試行してください。（offline）' });
    expect(splitFailureMessage('モデル実行がタイムアウトしました。モデルサーバーの応答とモデルのロード状況を確認して再試行してください（ローカルLM Studioを使う場合は起動しているか確認）。', 'ja'))
      .toEqual({ cause: 'モデル実行がタイムアウトしました', action: 'モデルサーバーの応答とモデルのロード状況を確認して再試行してください（ローカルLM Studioを使う場合は起動しているか確認）' });
  });

  it('分けられない1文は全文を次の一手として返す（何も落とさない）', () => {
    expect(splitFailureMessage('実行を中断しました', 'ja')).toEqual({ action: '実行を中断しました' });
    expect(splitFailureMessage('エージェントの実行に失敗しました（some brand new agent failure）', 'ja')).toEqual({ action: 'エージェントの実行に失敗しました（some brand new agent failure）' });
    expect(splitFailureMessage('The run was cancelled', 'en')).toEqual({ action: 'The run was cancelled' });
  });
});

describe('describeMcpServerSkipped（mcp-server-skipped イベント）', () => {
  it('理由別に登録・有効化・接続確認へ誘導する', () => {
    expect(describeMcpServerSkipped({ server: 'files', reason: 'not-found' }, 'ja'))
      .toBe('MCPサーバー「files」のツールを読み込めませんでした（未登録）。MCP設定画面でサーバーを登録・有効化し、接続をテストしてください');
    expect(describeMcpServerSkipped({ server: 'files', reason: 'disabled' }, 'ja')).toContain('（無効化中）。MCP設定画面でサーバーを有効化し');
    expect(describeMcpServerSkipped({ server: 'files', reason: 'unreachable', detail: 'ECONNREFUSED' }, 'ja'))
      .toBe('MCPサーバー「files」のツールを読み込めませんでした（接続失敗）。MCP設定画面で接続をテストし、サーバーの起動状態・URL・コマンドを確認してください。詳細: ECONNREFUSED');
  });

  it('英語でも同じ導線を出し、detail は原文で残す', () => {
    expect(describeMcpServerSkipped({ server: 'files', reason: 'not-found' }, 'en'))
      .toBe("The tools of MCP server 'files' were not loaded (server not registered). Register and enable the server in MCP settings, then test the connection");
    expect(describeMcpServerSkipped({ server: 'files', reason: 'unreachable', detail: 'ECONNREFUSED' }, 'en')).toContain('. Detail: ECONNREFUSED');
  });
});

/**
 * 監査で追加: 実行エラーの各定型文が **en / ja の両言語**で「次の一手」まで出ること。
 * 既存テストは ja 中心で en は数件だったため、表で en 側の欠けを埋める
 * （見出しは code 側の責務なので localizeRunFailure(AGENT_RUN) で本文の変換だけを見る）。
 */
describe('エージェント実行エラーの定型文（en / ja 両言語の網羅）', () => {
  const run = (raw: string, language: 'en' | 'ja'): string => localizeRunFailure({ code: 'AGENT_RUN', message: raw }, language);

  it.each([
    ['unknown MCP tool: mcp__files__read', '存在しないツール「mcp__files__read」', "a tool named 'mcp__files__read' that is not connected"],
    ['unknown runtime harness tool: todos_add', '存在しないツール「todos_add」', "a tool named 'todos_add' that is not connected"],
    ["MCP tool 'mcp__files__read' is unavailable: its MCP server could not be resolved for this run", 'MCPツール「mcp__files__read」のMCPサーバーへ接続できませんでした', "the MCP server behind 'mcp__files__read' could not be reached. Test the connection in MCP settings"],
    ['model reported tool_calls without a tool call', 'ツール呼び出しに対応したモデルを選び直してください', 'Pick a model with reliable tool-calling support'],
    ['model requested a tool call but function invocation is disabled for this agent', 'ハーネス設定でツール実行を有効にするか', 'Enable tool execution in the harness settings'],
    ['tool call limit exceeded: maximum 4', 'ツール呼び出しの上限（4回）', 'tool-call limit (4)'],
    ['model round limit exceeded: maximum 5', 'モデルとの往復回数の上限（5回）', 'model round limit (5)'],
    ['run budget exhausted: model rounds', 'モデル往復の予算を使い切りました', 'shared budget for model rounds'],
    ['run budget exhausted: tool calls', 'ツール呼び出しの予算を使い切りました', 'shared budget for tool calls'],
    ["structured response is missing required field 'answer'", '必要な項目「answer」がありませんでした', "missing the required field 'answer'"],
    ["structured response contains unknown field 'extra'", '定義していない項目「extra」', "undeclared field 'extra'"],
    ["structured response field 'score' must be integer", '項目「score」の型が違います（integer が必要）', "wrong type for 'score' (expected integer)"],
    ['structured response is not valid JSON', 'JSONとして解釈できませんでした', 'could not be read as JSON'],
    ['structured response must be a JSON object', 'JSONとして解釈できませんでした', 'could not be read as JSON'],
    ['configured model provider does not support tool-calling', 'ツール呼び出しに対応したモデルへ切り替えてください', 'Switch to a tool-capable model in model settings'],
    ['configured model provider does not support structured output', '構造化出力に対応していません', 'does not support structured output'],
    ['configured model provider does not support image input', '画像入力に対応していません', 'does not accept images'],
    ['required argument missing: month', '必須引数「month」を渡しませんでした', "omitted the required tool argument 'month'"],
    ["invalid argument 'score': expected number", '引数「score」の型が違います（number が必要）', "argument 'score' had the wrong type (expected number)"],
    ["invalid argument 'score': expected number, received \"x\" (string)", '受け取った値: "x" (string)', 'received "x" (string)'],
    ['unknown argument(s): region', '存在しない引数「region」', 'arguments the tool does not accept: region'],
    ["Agent preview refuses write effective side-effect for agent 'sales-agent'", 'エージェント「sales-agent」は副作用「write」', "agent 'sales-agent' has the 'write' side effect"],
    ["Agent preview refuses external-action effective side-effect for additional sub-agent 'poster'", 'エージェント「poster」は副作用「external-action」', "agent 'poster' has the 'external-action' side effect"],
    ["Agent preview refuses write tool 'crm-writer'", 'ツール「crm-writer」は副作用「write」', "tool 'crm-writer' has the 'write' side effect"],
    ["run 'run-1' is not waiting for approval", '実行「run-1」は承認待ちではありません', "run 'run-1' is not waiting for approval. Reopen the screen"],
    ['approval checkpoint expired at 2026-07-28T00:00:00.000Z', 'ツール承認の期限（2026-07-28T00:00:00.000Z）', 'approval expired at 2026-07-28T00:00:00.000Z. Send the same request again'],
    ['agent session belongs to a different Agent version', '「新しいチャット」を開始してください', 'Start a new chat'],
    ["memory page 'p1' is outside Agent wiki allowlist", '記憶ページ「p1」', "memory page 'p1' is outside the wikis this agent may read"],
    ['workspace artifact not found: a-1', 'セッション内の成果物「a-1」', "session artifact 'a-1' no longer exists"],
    ['web_search has no configured search provider', '検索プロバイダを登録してください', 'no search provider is configured for web search'],
    ['saved Agent execution is not configured', 'サーバーの起動設定を確認してください', 'Check the server startup configuration'],
    ['additional sub-agent not found: sub@1.0.0', 'サブエージェント「sub@1.0.0」が見つかりませんでした', "sub-agent 'sub@1.0.0' was not found"],
    ["filter node 'f1' references an unavailable Agent input", 'フィルタ「f1」が受け取れない引数を参照しています', "filter node 'f1' references an argument the tool never receives"],
    ["tool inputSchema does not match agent-input node 'in'", 'Agent Inputノード「in」の列が一致していません', "does not match the Agent Input node 'in'"],
    ['tool declares inputSchema but has no agent-input node', '引数ノードを追加してください', 'Add the argument node in the tool screen'],
    ['SaveTool: Agent input bindings require an inputSchema', 'Agent Inputノードを追加して引数を宣言してください', 'Add an Agent Input node and declare the arguments'],
    ['createTool: agentTool.name must be a valid function name', '英数字・_・- のみ1〜64文字', 'set a name of 1-64 ASCII letters, digits, _ or -'],
    ['sub-agent tool name is not a valid function name: ask_営業', '委譲ツール名「ask_営業」は関数名として使えません', "delegation tool name 'ask_営業' is not a valid function name"],
    ['tool name is not a valid function name: 売上', 'ツール名「売上」は関数名として使えません', "the tool name '売上' is not a valid function name"],
    ["invalid operator 'like' for argument 'op': expected one of eq, neq", '許可されていない演算子「like」を渡しました（許可: eq, neq）', "operator 'like' for argument 'op', which is not allowed (allowed: eq, neq)"],
    ['agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output', 'ツールの出力（9 バイト）がエージェント出力の上限（8 バイト）', 'the tool output (9 bytes) exceeds the agent-output limit (8 bytes)'],
  ])('%s を両言語で次の一手つきに変換する', (raw, japanese, english) => {
    expect(run(raw, 'ja')).toContain(japanese);
    expect(run(raw, 'en')).toContain(english);
  });

  it('キャプチャ値に正規表現の特殊文字（. ( ) + >）や区切り文字があっても壊れない', () => {
    expect(run('model requested unknown tool: sales.lookup (v2)+', 'en')).toContain("a tool named 'sales.lookup (v2)+' that is not connected");
    expect(run("invalid argument 'a.b(c)+': expected number, received \"x\" (string)", 'ja')).toContain('引数「a.b(c)+」の型が違います（number が必要、受け取った値: "x" (string)）');
    expect(run("invalid operator '>=' for argument 'op.x': expected one of eq, neq, gt", 'en')).toContain("the operator '>=' for argument 'op.x', which is not allowed (allowed: eq, neq, gt)");
    expect(run("Agent preview refuses write tool 'crm (v2).writer'", 'ja')).toContain('ツール「crm (v2).writer」は副作用「write」');
  });

  it('ambiguous tool versions はドット入りの名前でも、両側の名前が一致するときだけ変換する', () => {
    expect(localizeDiagnosticDetail('ambiguous tool versions: sales.lookup@1.0.0 and sales.lookup@1.1.0', 'en')).toContain("the tool 'sales.lookup' is referenced at two versions (1.0.0 and 1.1.0)");
    expect(localizeDiagnosticDetail('ambiguous tool versions: a@1.0.0 and b@1.1.0', 'ja')).toBe('ambiguous tool versions: a@1.0.0 and b@1.1.0');
  });

  it('出力スキーマ不一致の要約は、列数（両言語）・列名（入れ子の括弧つき）・未知の要約をそれぞれ扱う', () => {
    const shape = (detail: string): string => `SaveTool: declared output schema does not match the graph's inferred output (${detail})`;
    expect(localizeDiagnosticDetail(shape('column count mismatch: expected 3, received 2'), 'en'))
      .toBe('the declared output schema does not match the output inferred from the graph (column count mismatch: expected 3, received 2). Refresh the output schema in the Tool Builder and save again');
    expect(localizeDiagnosticDetail(shape('column count mismatch: expected 3, received 2'), 'ja')).toContain('（列数の不一致: 宣言 3 列 / 推論 2 列）');
    expect(localizeDiagnosticDetail(shape("mismatch at 'total (sum)'"), 'ja')).toContain('（列「total (sum)」が不一致）');
    expect(localizeDiagnosticDetail(shape("mismatch at 'total'"), 'en')).toContain("(mismatch at 'total'). Refresh");
    expect(localizeDiagnosticDetail(shape('something else'), 'ja')).toContain('（something else）');
  });
});

describe('localizeRunTraceError の境界', () => {
  it('接尾辞の番号が2桁でも、末尾に空白があっても剥がす', () => {
    expect(localizeRunTraceError({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 10/12)' }, 'en'))
      .toBe("the model omitted the required tool argument 'month'. Describe that argument more concretely in the tool, or state its value in your request (retrying 10/12)");
    // 末尾の空白で接尾辞を見失うと、引数名に「month (retrying 1/1)」が取り込まれる（修正前の実挙動）。
    expect(localizeRunTraceError({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 1/1)  ' }, 'ja'))
      .toBe('モデルがツールの必須引数「month」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）');
  });

  it('接尾辞だけのメッセージは再試行の注記だけを返す（先頭に区切りの空白を残さない）', () => {
    expect(localizeRunTraceError({ code: 'X', message: '(retrying 1/1)' }, 'en')).toBe('(retrying 1/1)');
    expect(localizeRunTraceError({ code: 'X', message: '(retrying 1/1)' }, 'ja')).toBe('（再試行 1/1）');
  });

  it('未知の本文は原文を残し、接尾辞は言語に合わせて付け直す', () => {
    expect(localizeRunTraceError({ code: 'X', message: 'weird thing (retrying 2/3)' }, 'en')).toBe('weird thing (retrying 2/3)');
    expect(localizeRunTraceError({ code: 'X', message: 'weird thing (retrying 2/3)' }, 'ja')).toBe('weird thing（再試行 2/3）');
  });

  it('code は文言に影響しない（本文だけで判定する）。空文字は空のまま', () => {
    expect(localizeRunTraceError({ code: 'MODEL_PROVIDER', message: 'fetch failed' }, 'en')).toBe('fetch failed');
    expect(localizeRunTraceError({ code: 'INTERNAL', message: 'required argument missing: x' }, 'en')).toContain("required tool argument 'x'");
    expect(localizeRunTraceError({ code: 'X', message: '' }, 'ja')).toBe('');
  });

  it('構造化出力の修復再試行（AGENT_RUN の retrying）も本文を変換する', () => {
    expect(localizeRunTraceError({ code: 'AGENT_RUN', message: "structured response is missing required field 'answer' (retrying 1/2)" }, 'en'))
      .toBe("the model response was missing the required field 'answer'. Try another model, or reduce the structured output fields (retrying 1/2)");
  });
});

describe('localizeDiagnosticDetail の境界', () => {
  it('空白だけの detail は空扱い（意味のある文字を足さない）', () => {
    expect(localizeDiagnosticDetail('   ', 'ja').trim()).toBe('');
  });

  it('graph 検査の `<nodeId>: <issue>` は en では原文のまま。未知の issue は nodeId ごと原文で残す（`-` をフィールドパスとして壊さない）', () => {
    expect(localizeDiagnosticDetail('filter-1: filter: column(s) not found: age', 'en')).toBe('filter-1: filter: column(s) not found: age');
    expect(localizeDiagnosticDetail('filter-1: totally new issue', 'ja')).toBe('filter-1: totally new issue');
    expect(localizeDiagnosticDetail('filter-1: totally new issue', 'en')).toBe('filter-1: totally new issue');
  });

  it('`; ` 連結の複数 detail は en でも1件ずつ変換して「, 」で連結する', () => {
    const raw = "operator argument 'op' has conflicting default operators across conditions; operator argument 'other' is not declared in the input schema, so the binding is inactive at run time";
    const localized = localizeDiagnosticDetail(raw, 'en');
    expect(localized).toContain("the conditions that bind argument 'op' use different default operators");
    expect(localized).toContain(", the operator argument 'other' is not declared in the tool's arguments");
  });

  it("'internal error' は情報量が無いが、原文以外に出せるものが無いので原文を返す", () => {
    expect(localizeDiagnosticDetail('internal error', 'ja')).toBe('internal error');
  });
});

describe('splitFailureMessage の境界', () => {
  it('ファイル名やURLのドットでは切らない（境界は「. 」だけ）', () => {
    expect(splitFailureMessage('Could not read sample-products.csv. Upload the file again', 'en')).toEqual({ cause: 'Could not read sample-products.csv', action: 'Upload the file again' });
    expect(splitFailureMessage('Could not reach https://example.com/v1. Check the endpoint', 'en')).toEqual({ cause: 'Could not reach https://example.com/v1', action: 'Check the endpoint' });
    expect(splitFailureMessage('Upload sample-products.csv again', 'en')).toEqual({ action: 'Upload sample-products.csv again' });
  });

  it('末尾の句点は落として切り、3文以上は最後の境界で切る', () => {
    expect(splitFailureMessage('Cause. Action.', 'en')).toEqual({ cause: 'Cause', action: 'Action' });
    expect(splitFailureMessage('原因。対処。', 'ja')).toEqual({ cause: '原因', action: '対処' });
    expect(splitFailureMessage('A。B。C', 'ja')).toEqual({ cause: 'A。B', action: 'C' });
  });

  it('ja は「。」、en は「. 」だけを境界にし、互いの区切りや「？」では切らない', () => {
    expect(splitFailureMessage('原因です. 次の一手です', 'ja')).toEqual({ action: '原因です. 次の一手です' });
    expect(splitFailureMessage('Cause。Action', 'en')).toEqual({ action: 'Cause。Action' });
    expect(splitFailureMessage('本当ですか？確認してください', 'ja')).toEqual({ action: '本当ですか？確認してください' });
  });

  it('境界で始まる文では空の原因を返さない', () => {
    expect(splitFailureMessage('。対処', 'ja')).toEqual({ action: '対処' });
  });

  it('空文字・空白だけは空の次の一手として返す', () => {
    expect(splitFailureMessage('', 'en')).toEqual({ action: '' });
    expect(splitFailureMessage('   ', 'ja')).toEqual({ action: '' });
  });

  it('見出し（本文）で本文に境界が無ければ、全文の最後の境界で切る', () => {
    expect(splitFailureMessage('見出し。続き（詳細）', 'ja')).toEqual({ cause: '見出し', action: '続き（詳細）' });
    expect(splitFailureMessage('Sign-in is required. Open Settings → Access and enter your access token (id: x)', 'en'))
      .toEqual({ cause: 'Sign-in is required', action: 'Open Settings → Access and enter your access token (id: x)' });
  });

  it('途中の括弧書きの後にも文が続けば、通常どおり最後の境界で切る', () => {
    expect(splitFailureMessage('A. (note) B. C', 'en')).toEqual({ cause: 'A. (note) B', action: 'C' });
  });

  it('長文でも最後の境界で切る', () => {
    const cause = 'x'.repeat(5000);
    const action = 'y'.repeat(5000);
    expect(splitFailureMessage(`${cause}. ${action}`, 'en')).toEqual({ cause, action });
    expect(splitFailureMessage(`${cause}。${action}`, 'ja')).toEqual({ cause, action });
  });
});

describe('localizeApiErrorMessage / localizeRunFailure の境界', () => {
  it('RUN_CANCELLED は en でも見出しと同文の詳細を重ねない（大小の違いだけの重複）', () => {
    expect(en(499, 'RUN_CANCELLED', 'run cancelled by the user')).toBe('The run was cancelled');
    expect(localizeRunFailure({ code: 'RUN_CANCELLED', message: 'run cancelled by the user' }, 'en')).toBe('The run was cancelled');
    expect(localizeRunFailure({ code: 'RUN_CANCELLED', message: 'run cancelled by the user' }, 'ja')).toBe('実行を中断しました');
  });

  it('SESSION_QUOTA_EXCEEDED は agent-output の文のときだけ見出しを外し、他の文では見出しを保つ（en）', () => {
    expect(en(413, 'SESSION_QUOTA_EXCEEDED', 'session quota exceeded: 10 artifacts'))
      .toBe('The session storage limit was exceeded. Delete unused artifacts, then retry (session quota exceeded: 10 artifacts)');
    expect(localizeRunFailure({ code: 'SESSION_QUOTA_EXCEEDED', message: 'agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output' }, 'en'))
      .toBe('the tool output (9 bytes) exceeds the agent-output limit (8 bytes). In the Tool Builder, reduce the rows (for example with a Limit node) or switch the output node to Workspace output');
  });

  it('agent-output の文は AGENT_RUN など別の code で届いても行数削減の案内になる（見出しは code のもの）', () => {
    expect(localizeRunFailure({ code: 'AGENT_RUN', message: 'agent-output exceeds maxBytes (120000 > 65536); reduce rows or use workspace-output' }, 'ja'))
      .toBe('エージェントの実行に失敗しました（ツールの出力（120000 バイト）がエージェント出力の上限（65536 バイト）を超えました。ツール画面で「行数制限」ノードなどで行数を減らすか、出力ノードを「ワークスペース出力」に切り替えてください）');
  });

  it('詳細が定型文の code（INTERNAL / INVALID_API_RESPONSE）は localizeRunFailure でも詳細を出さない。見出しの無い HTTP_ERROR は原文', () => {
    expect(localizeRunFailure({ code: 'INTERNAL', message: 'stack trace here' }, 'en')).toBe('The server hit an internal error. Wait a moment, then retry');
    expect(localizeRunFailure({ code: 'INVALID_API_RESPONSE', message: '<html>' }, 'ja')).toBe('APIサーバーからJSON以外の応答が返りました。APIサーバーの起動状態と開発プロキシ設定を確認してください');
    expect(localizeRunFailure({ code: 'HTTP_ERROR', message: 'Not Found' }, 'ja')).toBe('Not Found');
  });

  it('SaveTool: 前置詞つきの未知メッセージは前置詞ごと原文を残す（`;` 区切りは分割して連結する）', () => {
    expect(ja(400, 'TOOL_VALIDATION', 'SaveTool: something brand new')).toBe('ツール定義を確認してください（SaveTool: something brand new）');
    expect(en(400, 'TOOL_VALIDATION', 'SaveTool: something brand new')).toBe('Please check the tool definition (SaveTool: something brand new)');
    expect(en(400, 'TOOL_VALIDATION', 'SaveTool: alpha; beta')).toBe('Please check the tool definition (SaveTool: alpha, beta)');
  });

  it('見出しの無い code は空メッセージなら空、LM Studio を含めばモデル失敗の案内。見出しのある code は空メッセージなら見出しだけ', () => {
    expect(localizeRunFailure({ code: 'E_X', message: '' }, 'ja')).toBe('');
    expect(localizeRunFailure({ code: 'E_X', message: 'LM Studio request failed with HTTP 401' }, 'en'))
      .toBe('The model server rejected the credentials (HTTP 401). Check the API key in model settings, then retry.');
    expect(localizeRunFailure({ code: 'AGENT_RUN', message: '   ' }, 'ja')).toBe('エージェントの実行に失敗しました');
  });
});

describe('describeMcpServerSkipped の境界', () => {
  it.each([
    ['not-found', 'ja', '（未登録）。MCP設定画面でサーバーを登録・有効化し、接続をテストしてください'],
    ['not-found', 'en', '(server not registered). Register and enable the server in MCP settings, then test the connection'],
    ['disabled', 'ja', '（無効化中）。MCP設定画面でサーバーを有効化し、接続をテストしてください'],
    ['disabled', 'en', '(server disabled). Enable the server in MCP settings, then test the connection'],
    ['unreachable', 'ja', '（接続失敗）。MCP設定画面で接続をテストし、サーバーの起動状態・URL・コマンドを確認してください'],
    ['unreachable', 'en', '(unreachable). Test the connection in MCP settings and check that the server is running and its URL or command is correct'],
  ] as const)('reason=%s（%s）は detail の有無で末尾だけが変わり、空文字の detail は無い扱い', (reason, language, guidance) => {
    const plain = describeMcpServerSkipped({ server: 'files', reason }, language);
    expect(plain).toContain(language === 'ja' ? 'MCPサーバー「files」' : "MCP server 'files'");
    expect(plain.endsWith(guidance)).toBe(true);
    const withDetail = describeMcpServerSkipped({ server: 'files', reason, detail: 'ECONNREFUSED 127.0.0.1:3000' }, language);
    expect(withDetail).toBe(`${plain}${language === 'ja' ? '。詳細: ' : '. Detail: '}ECONNREFUSED 127.0.0.1:3000`);
    expect(describeMcpServerSkipped({ server: 'files', reason, detail: '' }, language)).toBe(plain);
  });

  it('未知の reason（将来のサーバー）は「接続失敗」と言い切らず、理由をそのまま添えて設定確認へ誘導する', () => {
    const event = { server: 'files', reason: 'auth-failed' as unknown as 'unreachable', detail: 'token rejected' };
    expect(describeMcpServerSkipped(event, 'en'))
      .toBe("The tools of MCP server 'files' were not loaded (auth-failed). Check the server settings and test the connection in MCP settings. Detail: token rejected");
    expect(describeMcpServerSkipped(event, 'ja'))
      .toBe('MCPサーバー「files」のツールを読み込めませんでした（auth-failed）。MCP設定画面でサーバーの設定と接続を確認してください。詳細: token rejected');
  });
});

describe('localizeToolCheckAssertion（ツール検証の期待・実測の定型文）', () => {
  it.each([
    ['row count == 3', '行数 == 3'],
    ['row count >= 3', '行数 >= 3'],
    ['row count <= 3', '行数 <= 3'],
    ['row count 5', '行数 5'],
    ["column 'total' exists", '列「total」がある'],
    ['columns: a, b, c', '列: a, b, c'],
    ['columns: (none)', '列: （なし）'],
    ['some row has total >= 100', 'いずれかの行で total >= 100'],
    ['every row has region == "east"', 'すべての行で region == "east"'],
    ['2 of 5 rows match', '5 行中 2 行が該当'],
    ["column 'total' not in output", '列「total」は出力にない'],
    ['duration <= 500ms', '所要時間 <= 500ms'],
    ['outcome error', '実行が失敗すること'],
    ['outcome success', '実行が成功すること'],
  ])('正常: %s → %s', (input, expected) => {
    expect(localizeToolCheckAssertion(input, 'ja')).toBe(expected);
  });

  it('正常: 実行の結末の実測は role = actual で「〜した」になり、失敗はコードを添える', () => {
    expect(localizeToolCheckAssertion('outcome success', 'ja', 'actual')).toBe('成功した');
    expect(localizeToolCheckAssertion('outcome error', 'ja', 'actual')).toBe('失敗した');
    expect(localizeToolCheckAssertion('outcome error (TOOL_ARGUMENTS)', 'ja', 'actual')).toBe('失敗した（TOOL_ARGUMENTS）');
    expect(localizeToolCheckAssertion('outcome error (TOOL_ARGUMENTS)', 'en', 'actual')).toBe('outcome error (TOOL_ARGUMENTS)');
  });

  it('正常: en は原文をそのまま返す', () => {
    expect(localizeToolCheckAssertion('row count == 3', 'en')).toBe('row count == 3');
    expect(localizeToolCheckAssertion("column 'total' exists", 'en')).toBe("column 'total' exists");
  });

  it('境界: 実測の所要時間（812ms）と未知の文は原文のまま（握りつぶさない）', () => {
    expect(localizeToolCheckAssertion('812ms', 'ja')).toBe('812ms');
    expect(localizeToolCheckAssertion('something new from the server', 'ja')).toBe('something new from the server');
  });

  it('境界: 前後の空白は無視して変換し、0 行・0 件も扱う', () => {
    expect(localizeToolCheckAssertion('  row count == 0 ', 'ja')).toBe('行数 == 0');
    expect(localizeToolCheckAssertion('0 of 0 rows match', 'ja')).toBe('0 行中 0 行が該当');
  });

  it('異常: 似ているが形が違う文（演算子が != など）は変換しない', () => {
    expect(localizeToolCheckAssertion('row count != 3', 'ja')).toBe('row count != 3');
    expect(localizeToolCheckAssertion('duration >= 500ms', 'ja')).toBe('duration >= 500ms');
  });
});

/**
 * 判定（LLM-as-judge）1 件の失敗文言。code ごとに「原因（原文）。次の一手」の固定文にし、
 * 未知の code とプロバイダ失敗は既存の localizeRunFailure に委ねる。
 */
describe('localizeJudgeFailure（判定 1 件の失敗）', () => {
  it('JUDGE_INPUT: 実行履歴の欠落は「ポリシーを任意にするか、ツールを使う事例で実行」（ja / en）', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'rubric requires a trace' }, 'ja'))
      .toBe('ルーブリックが必須にしている実行履歴がこの事例にありません（rubric requires a trace）。ルーブリックの実行履歴ポリシーを「任意」にするか、ツールを使う事例で実行してください');
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'rubric requires a trace' }, 'en'))
      .toBe("The rubric requires a tool trace but this case has none (rubric requires a trace). Set the rubric's trace policy to optional, or run cases that use tools");
  });

  it('JUDGE_INPUT: 原文が参照回答の欠落なら参照ポリシー側の案内にする', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'rubric requires a reference answer' }, 'ja')).toContain('参照ポリシーを「任意」にするか、参照回答つきの事例で実行');
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'rubric requires a reference answer' }, 'en')).toContain('reference policy to optional, or run cases that carry a reference answer');
    // 参照と履歴の両方に触れる原文は履歴側（より一般的な原因）へ寄せる。
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'missing reference and trace' }, 'en')).toContain('trace policy to optional');
  });

  it('JUDGE_UNASSESSABLE: 基準の説明を具体的にする / 参照や履歴を渡す（ja / en）', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_UNASSESSABLE', message: 'no criterion assessed' }, 'ja'))
      .toBe('審査者はどの基準も判定できませんでした（no criterion assessed）。基準の説明を具体的にするか、必要な参照回答や実行履歴を判定者に渡してください');
    expect(localizeJudgeFailure({ code: 'JUDGE_UNASSESSABLE', message: 'no criterion assessed' }, 'en'))
      .toBe('The judge could not assess any criterion (no criterion assessed). Make the criterion descriptions more concrete, or give the judge the reference answer or trace it needs');
  });

  it('JUDGE_SCHEMA: 判定モデルを構造化出力に強いものへ（ja / en）', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_SCHEMA', message: 'invalid after repair' }, 'ja'))
      .toBe('判定結果が期待した形式ではありませんでした（修復を 1 回試みても不正）（invalid after repair）。設定画面の judge スロットで、構造化出力に強い判定モデルへ切り替えてください');
    expect(localizeJudgeFailure({ code: 'JUDGE_SCHEMA', message: 'invalid after repair' }, 'en'))
      .toBe('The judge output did not match the expected shape even after one repair (invalid after repair). In Settings, switch the judge slot to a model that is strong at structured output');
  });

  it('境界: 原文が空（空白のみ）なら括弧の補足を付けない', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_UNASSESSABLE', message: '   ' }, 'en')).toBe('The judge could not assess any criterion. Make the criterion descriptions more concrete, or give the judge the reference answer or trace it needs');
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: '' }, 'ja')).toBe('ルーブリックが必須にしている実行履歴がこの事例にありません。ルーブリックの実行履歴ポリシーを「任意」にするか、ツールを使う事例で実行してください');
  });

  it('JUDGE_PROVIDER はプロバイダ中立のモデル実行文言、未知の code は原文のまま（localizeRunFailure に委ねる）', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_PROVIDER', message: 'fetch failed' }, 'en')).toContain('Could not reach the model server');
    expect(localizeJudgeFailure({ code: 'JUDGE_PROVIDER', message: 'HTTP 401' }, 'ja')).toContain('APIキーを確認');
    expect(localizeJudgeFailure({ code: 'SOMETHING_ELSE', message: 'raw detail' }, 'ja')).toBe('raw detail');
  });

  it('language 省略時は localStorage の言語で判定する（例外: localStorage が使えなければ en）', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('ja') });
    expect(localizeJudgeFailure({ code: 'JUDGE_SCHEMA', message: '' })).toContain('構造化出力に強い判定モデル');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(localizeJudgeFailure({ code: 'JUDGE_SCHEMA', message: '' })).toContain('strong at structured output');
  });

  it('API エラーとしての JUDGE_UNASSESSABLE にも見出しがある', () => {
    expect(localizeApiErrorMessage({ status: 422, code: 'JUDGE_UNASSESSABLE', serverMessage: 'x' }, 'ja')).toBe('審査者はどの基準も判定できませんでした（x）');
  });
});

/**
 * 実験の起票時（POST /experiments・409）の判定まわりのコードと、判定 1 件の「判定モデル未設定」。
 * どちらも次の一手（設定画面の judge スロット / ルーブリックの軌跡ポリシー）まで言う。
 */
describe('仕訳の AI 読取が使えない（JOURNAL_EXTRACTION_UNAVAILABLE）', () => {
  it('正常: 原因（画像読取・構造化出力に非対応）と次の一手（設定で main モデルを変える）を出す', () => {
    const message = ja(409, 'JOURNAL_EXTRACTION_UNAVAILABLE', 'the configured model does not support vision');
    expect(message).toContain('画像読取または構造化出力に対応していません');
    expect(message).toContain('設定画面で main モデル');
  });

  it('境界: 詳細が空でも見出しだけで次の一手が分かる（en も同じ導線）', () => {
    expect(en(409, 'JOURNAL_EXTRACTION_UNAVAILABLE', '')).toContain('Change the main model in Settings');
  });
});

describe('判定モデル未設定・軌跡必須（JUDGE_MODEL_NOT_CONFIGURED / JUDGE_TRACE_UNAVAILABLE）', () => {
  it('JUDGE_MODEL_NOT_CONFIGURED は設定画面の judge スロットへ導く固定文（ja / en）で、原文は括弧で残さない', () => {
    expect(ja(409, 'JUDGE_MODEL_NOT_CONFIGURED', 'judge model is not configured')).toBe('判定モデルが設定されていません。審査ルーブリックを使う実験の前に、設定画面の judge スロットでモデルを設定してください');
    expect(en(409, 'JUDGE_MODEL_NOT_CONFIGURED', 'judge model is not configured')).toBe('The judge model is not configured. Set the judge slot in Settings before running experiments that use a judge rubric');
  });

  it('JUDGE_TRACE_UNAVAILABLE は本文の rubric.id を文中に埋める（ja / en）', () => {
    const payload = { status: 409, code: 'JUDGE_TRACE_UNAVAILABLE', serverMessage: 'rubric requires a trace but the dataset contains scenario cases', rubric: { id: 'quality-rubric', version: '1.2.0' } };
    expect(localizeApiErrorMessage(payload, 'ja')).toBe("ルーブリック 'quality-rubric' はツール呼び出しの軌跡を必須にしていますが、シナリオ事例では軌跡が得られません。軌跡ポリシーを「任意」にするか、ターン事例だけのデータセットを使ってください");
    expect(localizeApiErrorMessage(payload, 'en')).toBe("Rubric 'quality-rubric' requires a tool trace, but scenario cases never produce one. Set its trace policy to optional, or use a dataset with turn cases only");
  });

  it('境界: 本文に rubric が無ければ原文の `rubric \'<id>\'` から ID を拾い、それも無ければ一般形にする', () => {
    expect(en(409, 'JUDGE_TRACE_UNAVAILABLE', "rubric 'legacy-rubric' requires a trace")).toContain("Rubric 'legacy-rubric' requires a tool trace");
    expect(ja(409, 'JUDGE_TRACE_UNAVAILABLE', 'no id here')).toBe('ルーブリックがツール呼び出しの軌跡を必須にしていますが、シナリオ事例では軌跡が得られません。軌跡ポリシーを「任意」にするか、ターン事例だけのデータセットを使ってください');
    expect(en(409, 'JUDGE_TRACE_UNAVAILABLE', '')).toBe('The rubric requires a tool trace, but scenario cases never produce one. Set its trace policy to optional, or use a dataset with turn cases only');
  });

  it('localizeJudgeFailure: JUDGE_PROVIDER で原文が "is not configured" なら判定モデル未設定の文言に寄せる（ja / en）', () => {
    const failure = { code: 'JUDGE_PROVIDER', message: 'Judge model is not configured; set the judge slot in Settings' };
    expect(localizeJudgeFailure(failure, 'ja')).toBe('判定モデルが設定されていません。審査ルーブリックを使う実験の前に、設定画面の judge スロットでモデルを設定してください');
    expect(localizeJudgeFailure(failure, 'en')).toBe('The judge model is not configured. Set the judge slot in Settings before running experiments that use a judge rubric');
    // main スロット向けの LM_STUDIO_MODEL 案内には落ちない。
    expect(localizeJudgeFailure(failure, 'ja')).not.toContain('LM_STUDIO_MODEL');
  });

  it('[回帰固定] JUDGE_PROVIDER でも "not configured" を含まない原文は従来のプロバイダ中立文言のまま', () => {
    expect(localizeJudgeFailure({ code: 'JUDGE_PROVIDER', message: 'fetch failed' }, 'ja')).toContain('モデルサーバーに接続できませんでした');
    expect(localizeJudgeFailure({ code: 'JUDGE_INPUT', message: 'trace not configured' }, 'en')).toContain('trace policy to optional');
  });

  it('isJudgeModelNotConfigured: 起票の 409 と JUDGE_PROVIDER + not configured だけ true（大文字小文字は無視）', () => {
    expect(isJudgeModelNotConfigured({ code: 'JUDGE_MODEL_NOT_CONFIGURED', message: '' })).toBe(true);
    expect(isJudgeModelNotConfigured({ code: 'JUDGE_PROVIDER', message: 'Judge model is NOT CONFIGURED' })).toBe(true);
    expect(isJudgeModelNotConfigured({ code: 'JUDGE_PROVIDER', message: 'HTTP 401' })).toBe(false);
    expect(isJudgeModelNotConfigured({ code: 'MODEL_PROVIDER', message: 'model is not configured' })).toBe(false);
  });
});

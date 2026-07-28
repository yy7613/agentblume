import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectErrorLanguage, localizeApiErrorMessage, localizeSchemaIssueMessage } from './error-messages';

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
      'ノード「join-1」(join)には2本の入力が必要ですが、3本接続されています',
    ],
    [
      'graph must have exactly one terminal node, found 2: a, b',
      'グラフの終端ノードは1つだけにしてください(現在2個: a, b)',
    ],
    ['graph has no terminal node (out-degree 0)', '終端ノード(出力)がありません'],
    ['graph has a cycle', 'グラフに循環(ループ)があります。接続を見直してください'],
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
    ['join: key column(s) not found: id, region', '結合キーの列が見つかりません: id, region'],
    ['summary-statistics: column(s) must be number: score', '数値列が必要です: score'],
    ['group-by: column(s) not found: region, amount', '列が見つかりません: region, amount'],
    ['sort: column(s) not found: age', '列が見つかりません: age'],
    ["group-by: column 'active' must be number or date or string", '列「active」の型は 数値 / 日付 / 文字列 が必要です'],
    ["summary-statistics: column 'score' must be number", '列「score」の型は 数値 が必要です'],
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

  it('joinのwarning系issue(型不一致の可能性・文字列比較)を日本語化する', () => {
    expect(localizeSchemaIssueMessage("join: key type may mismatch: id ('unknown') vs id ('number')", 'ja'))
      .toBe('結合キーの型が一致しない可能性があります: id (不明) と id (数値)');
    expect(localizeSchemaIssueMessage("join: keys compared as text: id ('string') vs id ('number')", 'ja'))
      .toBe('結合キーを文字列として比較します: id (文字列) と id (数値)');
  });

  it('<node>: invalid config: <zod> はzod部分も再帰的に日本語化する', () => {
    expect(localizeSchemaIssueMessage('join: invalid config: mode: Invalid option: expected one of "inner"|"left"|"right"|"full"', 'ja'))
      .toBe('join: 設定が不正です(モード: 次のいずれかを指定してください: inner / left / right / full)');
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
      .toBe('グラフに循環(ループ)があります。接続を見直してください');
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

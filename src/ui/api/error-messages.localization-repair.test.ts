/**
 * エラーメッセージ日本語化の「契約の空洞化」修復の検証。
 *
 * ドメイン層は domain/shared/assert.ts の assertHttpUrl に URL 検証を共通化し、
 * `createModelSettings:` / `createMcpServerConfig:` の2前置詞で同形メッセージを生成するが、
 * UI の受け手が createModelSettings 固定だった。また api/schemas.ts の modelBaseUrlSchema
 * （zod refine）が書き込み経路では先に落ちるため、実際に UI へ届く文言に受け手がなかった。
 * ここでは実際にドメイン / zod が生成する文字列を入力に、追加した受け手と既存訳の回帰なしを固定する。
 * （既存の error-messages.test.ts は変更禁止のため、追加分はこの新規ファイルに置く。）
 */
import { describe, expect, it } from 'vitest';
import { localizeApiErrorMessage } from './error-messages';

function ja(status: number, code: string, serverMessage: string): string {
  return localizeApiErrorMessage({ status, code, serverMessage }, 'ja');
}
function en(status: number, code: string, serverMessage: string): string {
  return localizeApiErrorMessage({ status, code, serverMessage }, 'en');
}

describe('MCP_VALIDATION / MCP_NOT_FOUND の見出し', () => {
  it('MCP_VALIDATION は入力不備の見出しを出し、未知の詳細は原文で残す（握りつぶさない）', () => {
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: props is required'))
      .toBe('MCPサーバー設定の入力内容を確認してください（createMcpServerConfig: props is required）');
    expect(en(400, 'MCP_VALIDATION', 'createMcpServerConfig: props is required'))
      .toBe('Please check the MCP server settings (createMcpServerConfig: props is required)');
  });

  it('MCP_NOT_FOUND はドメイン定型文（MCP server not found: name）から ID だけを取り出す', () => {
    // src/application/mcp/manage-mcp-servers.ts / test-mcp-server.ts が投げる実形。
    expect(ja(404, 'MCP_NOT_FOUND', 'MCP server not found: files'))
      .toBe('MCPサーバーが見つかりませんでした（ID: files）');
    expect(en(404, 'MCP_NOT_FOUND', 'MCP server not found: files'))
      .toBe('The MCP server was not found (id: files)');
  });
});

describe('createMcpServerConfig の URL 検証（assertHttpUrl の第2前置詞）の日本語化', () => {
  it('URL 形式不正を日本語化する', () => {
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must be a valid URL: not a url'))
      .toBe('MCPサーバー設定の入力内容を確認してください（URLの形式が正しくありません: not a url）');
    expect(en(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must be a valid URL: not a url'))
      .toBe('Please check the MCP server settings (the URL is not a valid URL: not a url)');
  });

  it('http(s) 以外のスキームを日本語化する', () => {
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must use http(s): ftp://files.example.com'))
      .toBe('MCPサーバー設定の入力内容を確認してください（URLは http または https を指定してください: ftp://files.example.com）');
    expect(en(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must use http(s): ftp://files.example.com'))
      .toBe('Please check the MCP server settings (the URL must use http(s): ftp://files.example.com)');
  });

  it('資格情報の埋め込み禁止を日本語化する（メッセージに URL は載らない）', () => {
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must not embed credentials (user:password@host)'))
      .toBe('MCPサーバー設定の入力内容を確認してください（URLに認証情報（user:password@host）を含めないでください）');
    expect(en(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.url must not embed credentials (user:password@host)'))
      .toBe('Please check the MCP server settings (the URL must not embed credentials (user:password@host))');
  });

  it('非空検証（assertNonEmpty）も MCP 前置詞で拾い、フィールドパスを訳す', () => {
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: name must be a non-empty string'))
      .toBe('MCPサーバー設定の入力内容を確認してください（名前: 必須です）');
    // 辞書に無いフィールドパスは原文のまま残す。
    expect(ja(400, 'MCP_VALIDATION', 'createMcpServerConfig: transport.command must be a non-empty string'))
      .toBe('MCPサーバー設定の入力内容を確認してください（transport.command: 必須です）');
    expect(en(400, 'MCP_VALIDATION', 'createMcpServerConfig: name must be a non-empty string'))
      .toBe('Please check the MCP server settings (Name: is required)');
  });

  it('name の長さ上限（末尾に入力値が付く独自形）を日本語化する', () => {
    const name = 'a-very-long-mcp-server-name-that-exceeds-the-sixty-four-character-limit';
    expect(ja(400, 'MCP_VALIDATION', `createMcpServerConfig: name must be at most 64 characters: ${name}`))
      .toBe(`MCPサーバー設定の入力内容を確認してください（名前: 64文字以内で入力してください（入力値: ${name}））`);
    expect(en(400, 'MCP_VALIDATION', `createMcpServerConfig: name must be at most 64 characters: ${name}`))
      .toBe(`Please check the MCP server settings (Name: must be at most 64 characters (received '${name}'))`);
  });
});

describe('zod refine（modelBaseUrlSchema）の受け手', () => {
  // api/schemas.ts の modelBaseUrlSchema は refine メッセージ
  // 'must be an http(s) URL without embedded credentials' を出す。書き込み経路では
  // parseWith(label='invalid body') が `<フィールドパス>: <メッセージ>` を '; ' 連結するため、
  // 実際に UI へ届く形は BAD_REQUEST +
  //   'invalid body: main.baseUrl: must be an http(s) URL without embedded credentials'
  // （PUT /model-settings。judge スロットは judge.baseUrl、テスト実行は candidate.baseUrl、
  //   POST /model-catalog/openai-compatible-models はトップレベルの baseUrl）。
  const refine = 'must be an http(s) URL without embedded credentials';

  it('PUT /model-settings（main.baseUrl / judge.baseUrl）の形を日本語化する', () => {
    expect(ja(400, 'BAD_REQUEST', `invalid body: main.baseUrl: ${refine}`))
      .toBe('入力内容を確認してください（main.baseUrl: http(s) のURLを指定してください。URLに認証情報（user:password@）は埋め込めません）');
    expect(ja(400, 'BAD_REQUEST', `invalid body: judge.baseUrl: ${refine}`))
      .toBe('入力内容を確認してください（judge.baseUrl: http(s) のURLを指定してください。URLに認証情報（user:password@）は埋め込めません）');
  });

  it('POST /model-catalog/openai-compatible-models（トップレベル baseUrl）の形も日本語化する', () => {
    expect(ja(400, 'BAD_REQUEST', `invalid body: baseUrl: ${refine}`))
      .toBe('入力内容を確認してください（baseUrl: http(s) のURLを指定してください。URLに認証情報（user:password@）は埋め込めません）');
  });

  it('英語UIでは zod 定型文の原文をそのまま残す（詳細を握りつぶさない）', () => {
    expect(en(400, 'BAD_REQUEST', `invalid body: main.baseUrl: ${refine}`))
      .toBe(`Please check your input (main.baseUrl: ${refine})`);
  });
});

describe('link-local 拒否（SSRF 対策）の受け手', () => {
  const raw = 'createModelSettings: main.baseUrl must not target a link-local address (cloud metadata endpoints are never reachable from here)';

  it('拒否の理由（SSRF 対策）が利用者に伝わる訳にする', () => {
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', raw))
      .toBe('モデル設定の入力内容を確認してください（ベースURLにリンクローカルアドレス（169.254.x.x / fe80::）は指定できません。クラウドメタデータの窃取（SSRF）を防ぐため、この宛先は常に拒否しています）');
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', raw))
      .toBe('Please check the model settings (the base URL must not target a link-local address (169.254.x.x / fe80::). These destinations are always rejected to prevent SSRF against cloud metadata endpoints)');
  });
});

describe('ドメイン形式の長さ上限（must be at most N characters）の受け手', () => {
  it('model-settings の bounded / assertHttpUrl の maxLength が生成する形を日本語化する', () => {
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must be at most 512 characters'))
      .toBe('モデル設定の入力内容を確認してください（main.baseUrl: 512文字以内で入力してください）');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.model must be at most 256 characters'))
      .toBe('モデル設定の入力内容を確認してください（main.model: 256文字以内で入力してください）');
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.model must be at most 256 characters'))
      .toBe('Please check the model settings (main.model: must be at most 256 characters)');
  });
});

/**
 * 既存パターンの回帰なし: createModelSettings 側の出力文言は前置詞の汎用化前と
 * バイト単位で一致すること（既存 error-messages.test.ts は contains 判定のため、
 * ここで完全一致を固定する）。
 */
describe('既存 createModelSettings 訳の回帰なし（完全一致で固定）', () => {
  it('URL 系3メッセージは従来どおり「ベースURL」の呼び名で訳される', () => {
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must be a valid URL: not a url'))
      .toBe('モデル設定の入力内容を確認してください（ベースURLの形式が正しくありません: not a url）');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must use http(s): ftp://x'))
      .toBe('モデル設定の入力内容を確認してください（ベースURLは http または https を指定してください: ftp://x）');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must not embed credentials (user:password@host)'))
      .toBe('モデル設定の入力内容を確認してください（ベースURLに認証情報（user:password@host）を含めないでください）');
  });

  it('英語UIの URL 系3メッセージも従来どおり', () => {
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must be a valid URL: not a url'))
      .toBe('Please check the model settings (the base URL is not a valid URL: not a url)');
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must use http(s): ftp://x'))
      .toBe('Please check the model settings (the base URL must use http(s): ftp://x)');
    expect(en(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.baseUrl must not embed credentials (user:password@host)'))
      .toBe('Please check the model settings (the base URL must not embed credentials (user:password@host))');
  });

  it('provider/model 形式・非空検証・未知文言のフォールバックも従来どおり', () => {
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', "createModelSettings: main.model must be in 'provider/model' form, but got 'gpt-4o'"))
      .toBe('モデル設定の入力内容を確認してください（モデルは provider/model 形式で入力してください（例: openai/gpt-4o、入力値: gpt-4o））');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: main.model must be a non-empty string'))
      .toBe('モデル設定の入力内容を確認してください（main.model: 必須です）');
    expect(ja(400, 'MODEL_SETTINGS_VALIDATION', 'createModelSettings: props is required'))
      .toBe('モデル設定の入力内容を確認してください（createModelSettings: props is required）');
  });
});

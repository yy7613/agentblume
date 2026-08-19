/**
 * 起動時の環境変数検証（fail-fast）。
 *
 * ## なぜ必要か
 *
 * 以前は env を読む場所が散らばっていて、しかも読み方が場所ごとに違っていた。
 *
 * - `AGENTCONTEXT_PORT` は `Number(...)` するだけで、`"abc"` は `NaN` のまま `listen()` へ渡っていた。
 * - `AGENTCONTEXT_DB_CONNECTIONS` は JSON パース失敗を握り潰して `{}` を返していたため、
 *   カンマ1つの打ち間違いで **DB接続が画面から静かに消える**（原因の手掛かりはどこにも出ない）。
 * - `LM_STUDIO_TIMEOUT_MS` などは実際にモデルを呼ぶまで検証されなかった。
 *
 * このモジュールは**プロセス起動の最初に全部まとめて検証**し、1件でも不正なら
 * 「どの変数の、どの値が、何を期待されているのか」を並べて起動を止める。
 * 値の解釈（既定値の適用）は従来どおり各所が担当する。ここは**門番**であって設定の配布元ではない。
 *
 * ## 依存の向き
 *
 * ここは leaf モジュールで、zod 以外の src を import しない（domain/application/adapters/composition の
 * どこからでも安全に読めるようにするため）。`Profile` 型を composition から import せず再定義しているのも同じ理由。
 */
import { z } from 'zod';

/** 実行プロファイル（`composition/root.ts` の `Profile` と同じ値域）。 */
export const PROFILES = ['local', 'test'] as const;
/** 真偽値として読む env の受理値。`'true'` 以外は false 扱い、という曖昧さを排除する。 */
export const FLAGS = ['true', 'false'] as const;
/**
 * ログレベルの値域（pino のレベル名）。`silent` は「1行も出さない」。
 *
 * pino は未知のレベル名を渡すと**起動時に throw する**ため、ここで先に弾いて
 * 「env の打ち間違いでサーバーが不可解に死ぬ」状態を作らない。
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** `LOG_LEVELS` の要素。 */
export type LogLevel = (typeof LOG_LEVELS)[number];
/**
 * 認可ロールの値域（`src/domain/security/authorization.ts` の `AUTHORIZATION_ROLES` と同じ）。
 *
 * ここは leaf モジュールなので domain を import せず**書き写す**（`PROFILES` と同じ方針）。
 * 2つがずれないことは `environment.test.ts` が検査する。
 * env の時点で弾くのは、`roles: ["admin"]` のような綴り違いが
 * 「権限を付けたつもりで実際は read しかできないトークン」として静かに配られるのを防ぐため。
 */
export const AUTH_ROLES = ['viewer', 'editor', 'publisher', 'operator', 'workspace-admin'] as const;

/** listen ポートの既定（`src/server.ts`）。 */
export const DEFAULT_PORT = 3030;
/** listen ホストの既定。ローカルIDEなのでループバックに閉じる。 */
export const DEFAULT_HOST = '127.0.0.1';
/** 認証方式の値域（`application/security/authentication.ts` の `AuthenticationMode` と同じ値）。 */
export const AUTH_MODES = ['single-user', 'token'] as const;
/** `AUTH_MODES` の要素。 */
export type AuthMode = (typeof AUTH_MODES)[number];
/**
 * 共有トークンの最小長（`adapters/security/token-authentication.ts` と同じ値）。
 * 起動時に弾くためここでも持つ（adapters を import しない leaf モジュールなので値を写す）。
 */
export const MINIMUM_AUTH_TOKEN_LENGTH = 32;
/**
 * shutdown で実行中ジョブの完了を待つ既定の猶予（ミリ秒）。
 *
 * Agent実行は分単位かかることもあるが、`Ctrl+C` が10秒以上戻ってこないのは操作として耐えがたい。
 * 「短いジョブなら待ちきれる」ところに置き、長いジョブは従来どおり abort する。
 * 猶予を過ぎて中断されたジョブは、次の起動で `RecoverInterruptedRunsUseCase` が終端状態へ確定させる
 * （Factory Runは `failed` → retry、実験は `interrupted` → resume）。取り残しは残らないが、
 * **途中経過は失われる**ので、待てるものは待つ価値がある。
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/**
 * retention（保持期限にもとづく削除・伏せ字化）を自動実行する間隔（ミリ秒）。既定は24時間。
 *
 * 保持期限は日単位の設定なので、これ以上細かく回しても削除対象は増えない。
 * `0` を指定すると自動実行を無効にする（掃除は `POST /operations/retention/apply` の手動実行だけになる）。
 * 初回は起動直後ではなく1インターバル後に走る（理由は `RetentionScheduler` のコメント）。
 */
export const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * `AGENTCONTEXT_LOG_LEVEL` 未設定時のログレベル。
 *
 * `local`（＝実運用）は `info`。`test` プロファイルは `silent`。
 * テストプロファイルでサーバーを起こすのは E2E とテスト用の手動起動だけで、そこでは
 * Fastify の「incoming request / request completed」が毎リクエスト2行流れるとテスト出力が読めなくなる。
 * 調べたいときは `AGENTCONTEXT_LOG_LEVEL=info` を足せば戻せる（既定を変えるだけで、封じてはいない）。
 */
export const DEFAULT_LOG_LEVELS: Readonly<Record<(typeof PROFILES)[number], LogLevel>> = {
  local: 'info',
  test: 'silent',
};

/** `public.sales_daily` のような識別子だけを許す（adapters/database/environment-postgres と同じ規則）。 */
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * 空文字・空白だけの値を「未設定」と同じに扱う。
 *
 * `.env` に `AGENTCONTEXT_DB_PATH=` とだけ書かれている行を「不正な値」として弾くのではなく
 * 「書いていない」として既定値に倒す（`resolveDatabasePath` の既存挙動と揃える）。
 */
function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/** 空文字を未設定へ寄せたうえで任意項目にする。 */
function optional<T extends z.ZodType>(schema: T): z.ZodType<z.infer<T> | undefined, unknown> {
  return z.preprocess(blankToUndefined, z.optional(schema)) as z.ZodType<z.infer<T> | undefined, unknown>;
}

/** JSON文字列としてパースし、中身を `inner` で検証する。構文エラーと構造エラーを区別して報告する。 */
function json<T extends z.ZodType>(inner: T): z.ZodType<z.infer<T>, string> {
  return z.string().transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: `JSONとして解釈できない: ${error instanceof Error ? error.message : String(error)}` });
      return z.NEVER;
    }
    const result = inner.safeParse(parsed);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      const at = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
      ctx.addIssue({ code: 'custom', message: `${at}${issue.message}` });
    }
    return z.NEVER;
  }) as unknown as z.ZodType<z.infer<T>, string>;
}

const nonEmpty = z.string().min(1);
/**
 * APIキー類。空白・改行を含まないことまで見る。
 *
 * `.env` からのコピー&ペーストで末尾に空白や改行が混ざるのは定番の事故で、そのまま
 * `Authorization` ヘッダへ載ると「認証エラー」や不可解なHTTPエラーになって原因が掴めない。
 * ここで弾く（値そのものはエラーメッセージに出さない）。
 */
const secretToken = z.string().min(1).refine((value) => !/\s/.test(value), '空白・改行を含まない文字列');
const flag = z.enum(FLAGS);
const tcpPort = z.coerce.number().int().min(1).max(65_535);
const positiveInteger = z.coerce.number().int().positive();
/** 0 を「待たない」の意味で受け付けたい猶予時間用（負値と小数は弾く）。 */
const nonNegativeInteger = z.coerce.number().int().min(0);
/**
 * http(s) のURL。`z.url()` は `new URL()` が通るものを全部許すため、
 * `localhost:1234`（protocol が `localhost:` の相対省略形）のような書き間違いを取り逃がす。
 *
 * ドメイン層の `shared/assert.ts` `assertHttpUrl` と規則が重なるが、config は他層に
 * 依存しない leaf として値を書き写す方針のため、意図的な境界の重複である（ADR-0035）。
 */
const httpUrl = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'http:// または https:// で始まるURL');

/** `AGENTCONTEXT_DB_CONNECTIONS` の1エントリ。adapters 側の受理条件と同じにする。 */
const databaseConnectionSchema = z.object({
  driver: z.literal('postgresql'),
  host: nonEmpty,
  port: z.number().int().min(1).max(65_535).optional(),
  database: nonEmpty,
  username: nonEmpty,
  passwordEnv: nonEmpty,
  ssl: z.boolean().optional(),
  allowedTables: z.array(z.string().regex(TABLE_NAME_PATTERN)).optional(),
});

/** 接続ID → 接続定義。 */
export const databaseConnectionsSchema = z.record(nonEmpty, databaseConnectionSchema);

/**
 * `AGENTCONTEXT_AUTH_TOKENS` の1エントリ。
 *
 * **人ごとに1本**にしておくと、誰の操作かを監査に残せ、1人分だけ失効させられる。
 * `tenantId` / `workspaceId` を省略すると `AGENTCONTEXT_TENANT_ID` / `_WORKSPACE_ID`（既定 local/default）。
 * トークンの値そのものはエラーメッセージへ出さない（`isSecretName` が `TOKENS` を拾う）。
 */
const authTokenSchema = z.object({
  subject: nonEmpty,
  token: z.string()
    .min(MINIMUM_AUTH_TOKEN_LENGTH, `token は${MINIMUM_AUTH_TOKEN_LENGTH}文字以上`)
    .refine((value) => !/\s/.test(value), 'token に空白・改行を含めない'),
  tenantId: optional(nonEmpty),
  workspaceId: optional(nonEmpty),
  displayName: optional(nonEmpty),
  /**
   * 空配列は**受け付けない**。「何もさせないつもり」で `roles: []` と書いた設定が
   * 「未指定」と同一視されて既定（editor）へ落ち、**全権に近いトークン**になっていた。
   * 意図を書き分けられるようにする: 権限を絞るなら `["viewer"]`、
   * 既定でよければキーごと書かない。どちらとも読めない空配列は起動時に落とす。
   */
  roles: z.array(z.enum(AUTH_ROLES)).min(1, 'roles を空配列にしない（読み取りだけなら ["viewer"]、既定でよければ roles を書かない）').optional(),
});

/** `AGENTCONTEXT_AUTH_TOKENS`（1本以上のトークン）。 */
export const authTokensSchema = z.array(authTokenSchema).min(1);

/** `AGENTCONTEXT_MODEL_PRICING_JSON` の1エントリ（`composition/root.ts` の受理条件と同じ）。 */
const pricingEntrySchema = z.object({
  provider: nonEmpty,
  model: nonEmpty,
  inputPerMillionTokens: z.number().min(0),
  outputPerMillionTokens: z.number().min(0),
  effectiveAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), 'Date として解釈できる日時文字列'),
});

/**
 * 実際にコードから読まれている env の全量。
 *
 * ここに無い env は「読まれていない」ことを意味する（`.env.example` はこの表と一致させる）。
 * 未知のキーは zod の既定どおり黙って落とす（`process.env` にはOS由来の変数が数百個ある）。
 */
export const environmentSchema = z.object({
  // 実行プロファイルと保存先
  AGENTCONTEXT_PROFILE: optional(z.enum(PROFILES)),
  AGENTCONTEXT_DB_PATH: optional(nonEmpty),
  AGENTCONTEXT_PORT: optional(tcpPort),
  AGENTCONTEXT_HOST: optional(nonEmpty),
  AGENTCONTEXT_ALLOWED_HOSTS: optional(nonEmpty),
  AGENTCONTEXT_SAMPLE_DATA: optional(flag),
  AGENTCONTEXT_TENANT_ID: optional(nonEmpty),
  AGENTCONTEXT_WORKSPACE_ID: optional(nonEmpty),
  AGENTCONTEXT_SOURCE_REVISION: optional(nonEmpty),
  AGENTCONTEXT_SECRET_KEY_PATH: optional(nonEmpty),
  AGENTCONTEXT_BACKUP_DIR: optional(nonEmpty),
  AGENTCONTEXT_UI_ROOT: optional(nonEmpty),
  AGENTCONTEXT_SHUTDOWN_GRACE_MS: optional(nonNegativeInteger),
  AGENTCONTEXT_RETENTION_INTERVAL_MS: optional(nonNegativeInteger),
  AGENTCONTEXT_LOG_LEVEL: optional(z.enum(LOG_LEVELS)),
  // 認証（未設定なら単一ユーザーモード。ただし非ループバックへのバインドでは設定必須）
  AGENTCONTEXT_AUTH_MODE: optional(z.enum(AUTH_MODES)),
  AGENTCONTEXT_AUTH_TOKENS: optional(json(authTokensSchema)),
  // モデル（main / judge スロットの env 既定）
  LM_STUDIO_BASE_URL: optional(httpUrl),
  LM_STUDIO_MODEL: optional(nonEmpty),
  LM_STUDIO_API_KEY: optional(secretToken),
  LM_STUDIO_TIMEOUT_MS: optional(positiveInteger),
  LM_STUDIO_IDLE_TIMEOUT_MS: optional(positiveInteger),
  LM_STUDIO_MAX_TOKENS: optional(positiveInteger),
  JUDGE_LM_STUDIO_BASE_URL: optional(httpUrl),
  JUDGE_LM_STUDIO_MODEL: optional(nonEmpty),
  JUDGE_LM_STUDIO_API_KEY: optional(secretToken),
  ANALYSIS_ASSISTANT_ENABLED: optional(flag),
  MASTRA_TELEMETRY_DISABLED: optional(nonEmpty),
  MASTRA_OFFLINE: optional(nonEmpty),
  // MCPクライアント（外部MCPサーバー接続）の安全策
  AGENTCONTEXT_MCP_ALLOWED_COMMANDS: optional(nonEmpty),
  AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK: optional(flag),
  // データソース
  AGENTCONTEXT_DB_CONNECTIONS: optional(json(databaseConnectionsSchema)),
  // Web検索provider（任意）
  TAVILY_API_KEY: optional(secretToken),
  TINYFISH_API_KEY: optional(secretToken),
  GOOGLE_CUSTOM_SEARCH_API_KEY: optional(secretToken),
  GOOGLE_CUSTOM_SEARCH_ENGINE_ID: optional(nonEmpty),
  // 観測・運用
  AGENTCONTEXT_OTEL_ENABLED: optional(flag),
  // OTel の標準env。値を解釈するのは OpenTelemetry SDK であってこのアプリではないが、
  // **打ち間違えても静かにspanが消えるだけ**（exporterは送信失敗をログにしか出さない）なので、
  // 起動時に形だけ見ておく。ここに無い `OTEL_*` は SDK がそのまま読む（検証しない）。
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(httpUrl),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optional(httpUrl),
  AGENTCONTEXT_MODEL_PRICING_JSON: optional(json(z.array(pricingEntrySchema))),
  // UI / E2E（開発用）
  AGENTCONTEXT_API_URL: optional(httpUrl),
  AGENTCONTEXT_MANUAL_LIVE: optional(flag),
});

/** 検証済みの env。未設定の項目は `undefined`。 */
export type ValidatedEnvironment = z.infer<typeof environmentSchema>;

/** 期待値の説明。zod の英語メッセージだけでは「何を書けばよいか」が伝わらないため人間向けに添える。 */
const EXPECTATIONS: Readonly<Record<string, string>> = {
  AGENTCONTEXT_PROFILE: `'local' または 'test'`,
  AGENTCONTEXT_DB_PATH: 'SQLiteファイルのパス、または :memory:',
  AGENTCONTEXT_PORT: '1〜65535 の整数',
  AGENTCONTEXT_HOST: 'listen するホスト名／IP',
  AGENTCONTEXT_ALLOWED_HOSTS: '受け入れる Host ヘッダのカンマ区切り（例 app.example.com,127.0.0.1。未設定なら単一ユーザーモードのときだけループバック名を検査する）',
  AGENTCONTEXT_SAMPLE_DATA: `'true' または 'false'`,
  AGENTCONTEXT_TENANT_ID: '空でない文字列',
  AGENTCONTEXT_WORKSPACE_ID: '空でない文字列',
  AGENTCONTEXT_SOURCE_REVISION: '空でない文字列（commit hash 等）',
  AGENTCONTEXT_SECRET_KEY_PATH: '鍵ファイルのパス',
  AGENTCONTEXT_BACKUP_DIR: 'バックアップの出力先ディレクトリ（既定はDBの隣の `<db>.backups`）',
  AGENTCONTEXT_UI_ROOT: 'ビルド済みUI（index.html を含むディレクトリ）のパス',
  AGENTCONTEXT_SHUTDOWN_GRACE_MS: '0以上の整数（ミリ秒・0 は「待たずに中断」）',
  AGENTCONTEXT_RETENTION_INTERVAL_MS: '0以上の整数（ミリ秒・既定 86400000＝24時間・0 は自動実行を無効化）',
  AGENTCONTEXT_LOG_LEVEL: `${LOG_LEVELS.join(' / ')} のいずれか（既定は local=info・test=silent）`,
  AGENTCONTEXT_AUTH_MODE: `${AUTH_MODES.join(' / ')} のいずれか（既定: AGENTCONTEXT_AUTH_TOKENS があれば token、無ければ single-user）`,
  AGENTCONTEXT_AUTH_TOKENS: `[{subject, token, tenantId?, workspaceId?, displayName?, roles?}] のJSON配列（token は${MINIMUM_AUTH_TOKEN_LENGTH}文字以上・空白を含まない / roles は ${AUTH_ROLES.join(' / ')} から選ぶ・既定は editor）`,
  LM_STUDIO_BASE_URL: 'URL（例 http://127.0.0.1:1234/v1）',
  LM_STUDIO_MODEL: '空でない文字列',
  LM_STUDIO_API_KEY: '空でない・空白や改行を含まない文字列',
  LM_STUDIO_TIMEOUT_MS: '正の整数（ミリ秒）',
  LM_STUDIO_IDLE_TIMEOUT_MS: '正の整数（ミリ秒）',
  LM_STUDIO_MAX_TOKENS: '正の整数',
  JUDGE_LM_STUDIO_BASE_URL: 'URL（例 http://127.0.0.1:1234/v1）',
  JUDGE_LM_STUDIO_MODEL: '空でない文字列',
  JUDGE_LM_STUDIO_API_KEY: '空でない・空白や改行を含まない文字列',
  ANALYSIS_ASSISTANT_ENABLED: `'true' または 'false'`,
  MASTRA_TELEMETRY_DISABLED: '空でない文字列（既定 true）',
  MASTRA_OFFLINE: '空でない文字列（既定 1）',
  AGENTCONTEXT_MCP_ALLOWED_COMMANDS: `stdio MCPサーバーとして起動を許すコマンド名のカンマ区切り（未設定なら既定の許可リスト。'*' で無制限）`,
  AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK: `'true' または 'false'（既定 false。true でも 169.254.0.0/16 等のリンクローカルは常に拒否）`,
  AGENTCONTEXT_DB_CONNECTIONS: '接続ID → {driver:"postgresql", host, database, username, passwordEnv, port?, ssl?, allowedTables?} のJSONオブジェクト',
  TAVILY_API_KEY: '空でない・空白や改行を含まない文字列',
  TINYFISH_API_KEY: '空でない・空白や改行を含まない文字列',
  GOOGLE_CUSTOM_SEARCH_API_KEY: '空でない・空白や改行を含まない文字列',
  GOOGLE_CUSTOM_SEARCH_ENGINE_ID: '空でない文字列',
  AGENTCONTEXT_OTEL_ENABLED: `'true' または 'false'`,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'URL（例 http://127.0.0.1:4318）',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'URL（例 http://127.0.0.1:4318/v1/traces）',
  AGENTCONTEXT_MODEL_PRICING_JSON: '{provider, model, inputPerMillionTokens, outputPerMillionTokens, effectiveAt} のJSON配列',
  AGENTCONTEXT_API_URL: 'URL（例 http://127.0.0.1:3030）',
  AGENTCONTEXT_MANUAL_LIVE: `'true' または 'false'`,
};

/** 値をそのままエラーメッセージへ出してよいか。APIキーやパスワードは伏せる。 */
function isSecretName(name: string): boolean {
  return /API_KEY|TOKEN|PASSWORD|SECRET/.test(name);
}

/** エラーメッセージへ載せる「受け取った値」。秘密値は伏せ、長い値は切り詰める。 */
function describeReceived(name: string, raw: string | undefined): string {
  if (raw === undefined) return '(未設定)';
  if (isSecretName(name)) return '(値は伏せる)';
  return JSON.stringify(raw.length > 120 ? `${raw.slice(0, 120)}…` : raw);
}

/** env 検証の失敗。`issues` に1変数1行の説明が入る。 */
export class EnvironmentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`環境変数の検証に失敗しました（${issues.length}件）:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

/**
 * 全 env を検証する。1件でも不正なら `EnvironmentValidationError` を投げる（起動を止める前提）。
 *
 * 戻り値は「書かれていた値」であって既定値の適用後ではない。既定値は従来どおり各読み手が持つ。
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): ValidatedEnvironment {
  const result = environmentSchema.safeParse(env);
  if (result.success) return result.data;

  const issues: string[] = [];
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '');
    const expectation = EXPECTATIONS[name] ?? '有効な値';
    // custom は json() が付けた構文／構造の詳細。zod 既定の英語メッセージは冗長なので custom のときだけ添える。
    const detail = issue.code === 'custom' ? ` [${issue.message}]` : '';
    const line = `${name}: ${expectation} を期待${detail}（受け取った値: ${describeReceived(name, env[name])}）`;
    if (!issues.includes(line)) issues.push(line);
  }
  throw new EnvironmentValidationError(issues);
}

/** 認証トークン1本ぶんの解決済み設定（`adapters/security/token-authentication.ts` の `TokenCredential` と同形）。 */
export interface AuthTokenSettings {
  readonly subject: string;
  readonly token: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
}

/** 認証の起動設定。`mode === 'single-user'` なら `tokens` は空。 */
export interface AuthSettings {
  readonly mode: AuthMode;
  readonly tokens: readonly AuthTokenSettings[];
}

/**
 * ループバック（＝このマシンからしか届かない）アドレスか。
 *
 * `127.0.0.0/8` 全体・`::1`・`localhost` を認める。`0.0.0.0` / `::` / LAN のIPは**含まない**
 * （そこへ bind した瞬間、同じネットワークの誰でもAPIへ到達できる）。
 * ホスト名は解決しない。解決結果に依存すると、DNSの都合で認証の要否が変わってしまう。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * MCPクライアント（外部MCPサーバー接続）の安全策の設定。
 *
 * `composition/root.ts` がこれを `domain/mcp/transport-policy.ts` の `McpPolicy` へ組み立てる。
 * ここは leaf モジュールなので domain を import せず、**素の値**だけを返す
 * （既定の許可リストそのものは domain が持つ。`allowedCommands: undefined` は
 * 「呼び出し側の既定に従う」であって「無制限」ではない — 無制限は `unrestrictedCommands`）。
 */
export interface McpSettings {
  /** 明示指定された許可コマンド。未設定なら `undefined`（＝既定の許可リストを使う）。 */
  readonly allowedCommands: readonly string[] | undefined;
  /** `AGENTCONTEXT_MCP_ALLOWED_COMMANDS=*` が指定されたか（＝コマンドを制限しない）。 */
  readonly unrestrictedCommands: boolean;
  /** 私設ネットワーク宛のMCP接続を許すか。リンクローカルはこれと無関係に常に拒否。 */
  readonly allowPrivateNetwork: boolean;
}

/** コマンド許可リストを「制限しない」と宣言する値。 */
export const MCP_UNRESTRICTED_COMMANDS = '*';

/**
 * MCPの安全策設定を解決する。
 *
 * `AGENTCONTEXT_MCP_ALLOWED_COMMANDS` はカンマ区切り。空要素は落とす。
 * 全体が `*` のときだけ「制限しない」と解釈する（`npx,*` のような部分指定は認めない —
 * リストの一部にワイルドカードが混ざると、読んだ人が制限が効いていると誤解する）。
 */
export function mcpSettings(env: NodeJS.ProcessEnv = process.env): McpSettings {
  const raw = env['AGENTCONTEXT_MCP_ALLOWED_COMMANDS']?.trim();
  const entries = raw === undefined || raw === '' ? undefined : raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const unrestricted = entries !== undefined && entries.length === 1 && entries[0] === MCP_UNRESTRICTED_COMMANDS;
  return {
    allowedCommands: unrestricted ? undefined : entries,
    unrestrictedCommands: unrestricted,
    allowPrivateNetwork: env['AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK']?.trim() === 'true',
  };
}

/** エントリポイントが listen までに必要とする設定。 */
export interface ServerSettings {
  readonly profile: (typeof PROFILES)[number];
  readonly port: number;
  readonly host: string;
  readonly sampleData: boolean;
  /** `AGENTCONTEXT_UI_ROOT` の明示指定（未設定なら実行位置から探す）。 */
  readonly uiRootOverride: string | undefined;
  /** `/health` `/ready` が返すソース版（未設定なら返さない）。 */
  readonly revision: string | undefined;
  /** shutdown時に実行中ジョブの完了を待つ上限（ミリ秒）。 */
  readonly shutdownGraceMs: number;
  /** retentionの自動実行間隔（ミリ秒）。`0` は自動実行を行わない。 */
  readonly retentionIntervalMs: number;
  /** Fastify（pino）のログレベル。`silent` は1行も出さない。 */
  readonly logLevel: LogLevel;
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  /** 認証方式と登録済みトークン。`single-user` は「認証しない」を意味する。 */
  readonly authentication: AuthSettings;
  /** `AGENTCONTEXT_ALLOWED_HOSTS` の明示指定（未設定なら `undefined`）。 */
  readonly allowedHosts: readonly string[] | undefined;
}

/**
 * `Host` ヘッダ検査で受け入れるホスト名。`undefined` は「検査しない」。
 *
 * ## なぜ「ループバックへバインドしているか」だけでは決められないか
 *
 * 以前は `isLoopbackHost(host)` だけで判定していた。しかし
 * **`127.0.0.1` へバインドしてリバースプロキシを前に置く**のは本番の一般形で、
 * その構成ではブラウザが送る `Host` は `app.example.com` になる。
 * 結果として、認証を有効にした真っ当な運用が**全リクエスト403**になっていた。
 *
 * 検査の目的はDNSリバインディング対策であり、それが要るのは
 * **認証が無い（＝`Host` が唯一の識別子になる）単一ユーザーモード**である。
 * トークン認証を有効にしている構成では識別はトークンが担うので、既定では検査しない。
 * プロキシ配下でも縛りたい／単一ユーザーモードで別名を使いたい場合のために
 * `AGENTCONTEXT_ALLOWED_HOSTS` で明示的に上書きできる（指定した場合はモードを問わず検査する）。
 *
 * `loopbackDefaults` を引数で受けるのは、ここが leaf モジュールで api層を import しないため。
 */
export function allowedHostNames(settings: ServerSettings, loopbackDefaults: readonly string[]): readonly string[] | undefined {
  if (settings.allowedHosts !== undefined) return settings.allowedHosts;
  if (settings.authentication.mode !== 'single-user') return undefined;
  return isLoopbackHost(settings.host) ? loopbackDefaults : undefined;
}

/**
 * 認証設定を解決する。矛盾した組み合わせはここで落とす。
 *
 * - `AGENTCONTEXT_AUTH_TOKENS` があれば既定で `token` モード（モード指定の書き忘れで
 *   トークンを用意したのに無認証で起動する、という事故を防ぐ）。
 * - `AGENTCONTEXT_AUTH_MODE=token` なのにトークンが無い → 起動しない。
 * - `AGENTCONTEXT_AUTH_MODE=single-user` なのにトークンがある → どちらの意図か決められないので起動しない。
 */
function resolveAuthentication(env: ValidatedEnvironment, scope: { tenantId: string; workspaceId: string }): AuthSettings {
  const declared = env.AGENTCONTEXT_AUTH_MODE;
  const rawTokens = env.AGENTCONTEXT_AUTH_TOKENS;
  const mode: AuthMode = declared ?? (rawTokens === undefined ? 'single-user' : 'token');
  if (mode === 'token' && rawTokens === undefined) {
    throw new EnvironmentValidationError([
      'AGENTCONTEXT_AUTH_TOKENS: AGENTCONTEXT_AUTH_MODE=token では1本以上のトークンが必要（受け取った値: (未設定)）',
    ]);
  }
  if (mode === 'single-user' && rawTokens !== undefined) {
    throw new EnvironmentValidationError([
      'AGENTCONTEXT_AUTH_MODE: トークンを設定したまま single-user は指定できない（token にするか AGENTCONTEXT_AUTH_TOKENS を消す）',
    ]);
  }
  const tokens = (rawTokens ?? []).map((entry) => ({
    subject: entry.subject,
    token: entry.token,
    tenantId: entry.tenantId ?? scope.tenantId,
    workspaceId: entry.workspaceId ?? scope.workspaceId,
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    ...(entry.roles === undefined ? {} : { roles: entry.roles }),
  }));
  return { mode, tokens };
}

/** 検証済み env に既定値を当てて、起動に必要な設定へまとめる。 */
export function serverSettings(env: ValidatedEnvironment): ServerSettings {
  const profile = env.AGENTCONTEXT_PROFILE ?? 'local';
  const scope = {
    tenantId: env.AGENTCONTEXT_TENANT_ID ?? 'local',
    workspaceId: env.AGENTCONTEXT_WORKSPACE_ID ?? 'default',
  };
  const host = env.AGENTCONTEXT_HOST ?? DEFAULT_HOST;
  const authentication = resolveAuthentication(env, scope);

  /**
   * 「ローカルだから無認証でよい」という前提は、公開した瞬間に破綻する。
   *
   * 単一ユーザーモードは**誰でも既定テナントの全データを読み書きできる**構成なので、
   * ループバック以外へ bind するなら認証を必須にする。ここで落とさないと、
   * `AGENTCONTEXT_HOST=0.0.0.0` を足しただけでLAN全体へ無防備に公開される。
   */
  if (!isLoopbackHost(host) && authentication.mode === 'single-user') {
    throw new EnvironmentValidationError([
      `AGENTCONTEXT_HOST: ${JSON.stringify(host)} は 127.0.0.1 以外へのバインドなので認証が必須。`
      + ' AGENTCONTEXT_AUTH_TOKENS を設定するか、AGENTCONTEXT_HOST=127.0.0.1 に戻すこと'
      + '（単一ユーザーモードは資格情報を一切求めない）',
    ]);
  }

  return {
    profile,
    port: env.AGENTCONTEXT_PORT ?? DEFAULT_PORT,
    host,
    sampleData: env.AGENTCONTEXT_SAMPLE_DATA === 'true',
    uiRootOverride: env.AGENTCONTEXT_UI_ROOT,
    revision: env.AGENTCONTEXT_SOURCE_REVISION,
    shutdownGraceMs: env.AGENTCONTEXT_SHUTDOWN_GRACE_MS ?? DEFAULT_SHUTDOWN_GRACE_MS,
    retentionIntervalMs: env.AGENTCONTEXT_RETENTION_INTERVAL_MS ?? DEFAULT_RETENTION_INTERVAL_MS,
    logLevel: env.AGENTCONTEXT_LOG_LEVEL ?? DEFAULT_LOG_LEVELS[profile],
    scope,
    authentication,
    allowedHosts: splitList(env.AGENTCONTEXT_ALLOWED_HOSTS),
  };
}

/** カンマ区切りを配列へ。空要素は落とし、1件も残らなければ「未設定」と同じ `undefined`。 */
function splitList(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  return entries.length === 0 ? undefined : entries;
}

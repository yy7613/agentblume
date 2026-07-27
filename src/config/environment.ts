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

/** listen ポートの既定（`src/server.ts`）。 */
export const DEFAULT_PORT = 3030;
/** listen ホストの既定。ローカルIDEなのでループバックに閉じる。 */
export const DEFAULT_HOST = '127.0.0.1';
/**
 * shutdown で実行中ジョブの完了を待つ既定の猶予（ミリ秒）。
 *
 * Agent実行は分単位かかることもあるが、`Ctrl+C` が10秒以上戻ってこないのは操作として耐えがたい。
 * 「短いジョブなら待ちきれる」ところに置き、長いジョブは従来どおり abort する。
 * ジョブの永続化・再起動復旧が入れば、この猶予は短くできる。
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

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
  AGENTCONTEXT_SAMPLE_DATA: optional(flag),
  AGENTCONTEXT_TENANT_ID: optional(nonEmpty),
  AGENTCONTEXT_WORKSPACE_ID: optional(nonEmpty),
  AGENTCONTEXT_SOURCE_REVISION: optional(nonEmpty),
  AGENTCONTEXT_SECRET_KEY_PATH: optional(nonEmpty),
  AGENTCONTEXT_UI_ROOT: optional(nonEmpty),
  AGENTCONTEXT_SHUTDOWN_GRACE_MS: optional(nonNegativeInteger),
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
  // データソース
  AGENTCONTEXT_DB_CONNECTIONS: optional(json(databaseConnectionsSchema)),
  // Web検索provider（任意）
  TAVILY_API_KEY: optional(secretToken),
  TINYFISH_API_KEY: optional(secretToken),
  GOOGLE_CUSTOM_SEARCH_API_KEY: optional(secretToken),
  GOOGLE_CUSTOM_SEARCH_ENGINE_ID: optional(nonEmpty),
  // 観測・運用
  AGENTCONTEXT_OTEL_ENABLED: optional(flag),
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
  AGENTCONTEXT_SAMPLE_DATA: `'true' または 'false'`,
  AGENTCONTEXT_TENANT_ID: '空でない文字列',
  AGENTCONTEXT_WORKSPACE_ID: '空でない文字列',
  AGENTCONTEXT_SOURCE_REVISION: '空でない文字列（commit hash 等）',
  AGENTCONTEXT_SECRET_KEY_PATH: '鍵ファイルのパス',
  AGENTCONTEXT_UI_ROOT: 'ビルド済みUI（index.html を含むディレクトリ）のパス',
  AGENTCONTEXT_SHUTDOWN_GRACE_MS: '0以上の整数（ミリ秒・0 は「待たずに中断」）',
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
  AGENTCONTEXT_DB_CONNECTIONS: '接続ID → {driver:"postgresql", host, database, username, passwordEnv, port?, ssl?, allowedTables?} のJSONオブジェクト',
  TAVILY_API_KEY: '空でない・空白や改行を含まない文字列',
  TINYFISH_API_KEY: '空でない・空白や改行を含まない文字列',
  GOOGLE_CUSTOM_SEARCH_API_KEY: '空でない・空白や改行を含まない文字列',
  GOOGLE_CUSTOM_SEARCH_ENGINE_ID: '空でない文字列',
  AGENTCONTEXT_OTEL_ENABLED: `'true' または 'false'`,
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
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
}

/** 検証済み env に既定値を当てて、起動に必要な設定へまとめる。 */
export function serverSettings(env: ValidatedEnvironment): ServerSettings {
  return {
    profile: env.AGENTCONTEXT_PROFILE ?? 'local',
    port: env.AGENTCONTEXT_PORT ?? DEFAULT_PORT,
    host: env.AGENTCONTEXT_HOST ?? DEFAULT_HOST,
    sampleData: env.AGENTCONTEXT_SAMPLE_DATA === 'true',
    uiRootOverride: env.AGENTCONTEXT_UI_ROOT,
    revision: env.AGENTCONTEXT_SOURCE_REVISION,
    shutdownGraceMs: env.AGENTCONTEXT_SHUTDOWN_GRACE_MS ?? DEFAULT_SHUTDOWN_GRACE_MS,
    scope: {
      tenantId: env.AGENTCONTEXT_TENANT_ID ?? 'local',
      workspaceId: env.AGENTCONTEXT_WORKSPACE_ID ?? 'default',
    },
  };
}

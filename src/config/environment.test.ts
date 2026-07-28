/**
 * env 一括検証のテスト。
 *
 * 「不正な値で黙って起動してしまう」ことを防ぐのが目的なので、
 * 通す条件よりも**弾く条件と、そのときのメッセージ**を厚く確認する。
 */
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_ROLES } from '../domain/security/authorization';
import {
  AUTH_ROLES,
  DEFAULT_HOST,
  DEFAULT_LOG_LEVELS,
  DEFAULT_PORT,
  DEFAULT_RETENTION_INTERVAL_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  EnvironmentValidationError,
  LOG_LEVELS,
  allowedHostNames,
  databaseConnectionsSchema,
  environmentSchema,
  isLoopbackHost,
  mcpSettings,
  serverSettings,
  validateEnvironment,
} from './environment';

/** 検証を走らせ、失敗したら issue 行の配列を返す。 */
function issuesOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    validateEnvironment(env);
    return [];
  } catch (error) {
    if (error instanceof EnvironmentValidationError) return error.issues;
    throw error;
  }
}

describe('validateEnvironment', () => {
  it('未設定だけの env は通る（既定値は各読み手が持つ）', () => {
    expect(validateEnvironment({})).toEqual({});
  });

  it('OS由来の未知の変数は無視する', () => {
    expect(validateEnvironment({ PATH: '/usr/bin', HOME: '/home/x' })).toEqual({});
  });

  it('.env に `KEY=` とだけ書かれた行は未設定として扱う', () => {
    const validated = validateEnvironment({ AGENTCONTEXT_DB_PATH: '', AGENTCONTEXT_PORT: '  ', LM_STUDIO_MODEL: '' });
    expect(validated.AGENTCONTEXT_DB_PATH).toBeUndefined();
    expect(validated.AGENTCONTEXT_PORT).toBeUndefined();
    expect(validated.LM_STUDIO_MODEL).toBeUndefined();
  });

  it('.env.example と同じ内容は通る', () => {
    const validated = validateEnvironment({
      AGENTCONTEXT_PROFILE: 'local',
      AGENTCONTEXT_PORT: '3030',
      LM_STUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
      ANALYSIS_ASSISTANT_ENABLED: 'true',
      AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({
        reporting: { driver: 'postgresql', host: '127.0.0.1', port: 5432, database: 'reporting', username: 'agentcontext_reader', passwordEnv: 'REPORTING_DB_PASSWORD', ssl: false, allowedTables: ['public.sales_daily'] },
      }),
      AGENTCONTEXT_MODEL_PRICING_JSON: '[{"provider":"lm-studio","model":"local","inputPerMillionTokens":0,"outputPerMillionTokens":0,"effectiveAt":"2026-01-01T00:00:00.000Z"}]',
    });
    expect(validated.AGENTCONTEXT_PORT).toBe(3030);
    expect(validated.AGENTCONTEXT_DB_CONNECTIONS?.['reporting']?.database).toBe('reporting');
    expect(validated.AGENTCONTEXT_MODEL_PRICING_JSON?.[0]?.provider).toBe('lm-studio');
  });

  it('AGENTCONTEXT_PORT は 1..65535 の整数だけを受ける', () => {
    expect(validateEnvironment({ AGENTCONTEXT_PORT: '3030' }).AGENTCONTEXT_PORT).toBe(3030);
    for (const bad of ['abc', '0', '65536', '3030.5', '-1']) {
      expect(issuesOf({ AGENTCONTEXT_PORT: bad })[0]).toContain('AGENTCONTEXT_PORT: 1〜65535 の整数');
    }
  });

  it('プロファイル・真偽値は列挙で弾く', () => {
    expect(issuesOf({ AGENTCONTEXT_PROFILE: 'production' })[0]).toContain(`'local' または 'test'`);
    expect(issuesOf({ AGENTCONTEXT_SAMPLE_DATA: 'yes' })[0]).toContain(`'true' または 'false'`);
    expect(issuesOf({ AGENTCONTEXT_OTEL_ENABLED: '1' })[0]).toContain(`'true' または 'false'`);
    expect(issuesOf({ ANALYSIS_ASSISTANT_ENABLED: 'off' })).toHaveLength(1);
    expect(issuesOf({ AGENTCONTEXT_MANUAL_LIVE: 'maybe' })).toHaveLength(1);
  });

  it('AGENTCONTEXT_LOG_LEVEL は pino のレベル名だけを受ける', () => {
    for (const level of LOG_LEVELS) {
      expect(validateEnvironment({ AGENTCONTEXT_LOG_LEVEL: level }).AGENTCONTEXT_LOG_LEVEL).toBe(level);
    }
    // pino は未知のレベル名で throw するので、env の段階で弾いて起動失敗の理由を読めるようにする。
    for (const bad of ['verbose', 'INFO', 'quiet']) {
      expect(issuesOf({ AGENTCONTEXT_LOG_LEVEL: bad })[0]).toContain('AGENTCONTEXT_LOG_LEVEL');
    }
    expect(issuesOf({ AGENTCONTEXT_LOG_LEVEL: 'verbose' })[0]).toContain('silent');
  });

  it('OTel の exporter エンドポイントは http(s) のURLだけを受ける', () => {
    const validated = validateEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' });
    expect(validated.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318');
    expect(validated.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://127.0.0.1:4318/v1/traces');
    // 綴りを間違えても exporter は黙って送信に失敗するだけなので、起動時に弾く。
    expect(issuesOf({ OTEL_EXPORTER_OTLP_ENDPOINT: '127.0.0.1:4318' })[0]).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(issuesOf({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'grpc://127.0.0.1:4317' })).toHaveLength(1);
  });

  it('検証していない OTEL_* は素通しする（SDKがそのまま読む）', () => {
    expect(validateEnvironment({ OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x', OTEL_TRACES_SAMPLER: 'always_on' })).toEqual({});
  });

  it('タイムアウト・トークン上限は正の整数だけを受ける', () => {
    for (const name of ['LM_STUDIO_TIMEOUT_MS', 'LM_STUDIO_IDLE_TIMEOUT_MS', 'LM_STUDIO_MAX_TOKENS'] as const) {
      expect(issuesOf({ [name]: '0' })[0]).toContain(name);
      expect(issuesOf({ [name]: '-5' })).toHaveLength(1);
      expect(issuesOf({ [name]: '1.5' })).toHaveLength(1);
      expect(issuesOf({ [name]: 'soon' })).toHaveLength(1);
    }
    expect(validateEnvironment({ LM_STUDIO_TIMEOUT_MS: '600000' }).LM_STUDIO_TIMEOUT_MS).toBe(600_000);
  });

  it('AGENTCONTEXT_SHUTDOWN_GRACE_MS は 0 以上の整数だけを受ける（0 = 待たない）', () => {
    expect(validateEnvironment({ AGENTCONTEXT_SHUTDOWN_GRACE_MS: '0' }).AGENTCONTEXT_SHUTDOWN_GRACE_MS).toBe(0);
    expect(validateEnvironment({ AGENTCONTEXT_SHUTDOWN_GRACE_MS: '30000' }).AGENTCONTEXT_SHUTDOWN_GRACE_MS).toBe(30_000);
    for (const bad of ['-1', '2.5', 'soon']) {
      expect(issuesOf({ AGENTCONTEXT_SHUTDOWN_GRACE_MS: bad })[0]).toContain('AGENTCONTEXT_SHUTDOWN_GRACE_MS: 0以上の整数');
    }
  });

  it('URL 形式の env は URL として検証する', () => {
    expect(issuesOf({ LM_STUDIO_BASE_URL: 'localhost:1234' })[0]).toContain('URL');
    expect(issuesOf({ JUDGE_LM_STUDIO_BASE_URL: 'nope' })).toHaveLength(1);
    expect(issuesOf({ AGENTCONTEXT_API_URL: '///' })).toHaveLength(1);
  });

  it('AGENTCONTEXT_DB_CONNECTIONS は構文エラーも構造エラーも起動失敗にする', () => {
    // 以前は catch で {} を返していたため、この打ち間違いは「接続が消える」だけで理由が出なかった。
    const syntax = issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: '{"reporting":{"driver":"postgresql",}}' });
    expect(syntax[0]).toContain('AGENTCONTEXT_DB_CONNECTIONS');
    expect(syntax[0]).toContain('JSONとして解釈できない');

    const typo = issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({ reporting: { driver: 'postgresql', host: 'h', database: 'd', username: 'u', passwordENV: 'P' } }) });
    expect(typo[0]).toContain('reporting.passwordEnv');

    expect(issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: '[]' })).toHaveLength(1);
    expect(issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({ x: { driver: 'mysql', host: 'h', database: 'd', username: 'u', passwordEnv: 'P' } }) })[0]).toContain('x.driver');
    expect(issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({ x: { driver: 'postgresql', host: 'h', database: 'd', username: 'u', passwordEnv: 'P', allowedTables: ['drop table; --'] } }) })[0]).toContain('allowedTables');
  });

  it('AGENTCONTEXT_MODEL_PRICING_JSON は配列と各エントリを検証する', () => {
    expect(issuesOf({ AGENTCONTEXT_MODEL_PRICING_JSON: 'not json' })[0]).toContain('JSONとして解釈できない');
    expect(issuesOf({ AGENTCONTEXT_MODEL_PRICING_JSON: '{}' })).toHaveLength(1);
    expect(issuesOf({ AGENTCONTEXT_MODEL_PRICING_JSON: '[{"provider":"p","model":"m","inputPerMillionTokens":-1,"outputPerMillionTokens":0,"effectiveAt":"2026-01-01T00:00:00.000Z"}]' })[0]).toContain('0.inputPerMillionTokens');
    expect(issuesOf({ AGENTCONTEXT_MODEL_PRICING_JSON: '[{"provider":"p","model":"m","inputPerMillionTokens":1,"outputPerMillionTokens":2,"effectiveAt":"yesterday"}]' })[0]).toContain('effectiveAt');
  });

  it('不正が複数あればまとめて報告する', () => {
    const issues = issuesOf({ AGENTCONTEXT_PORT: 'abc', AGENTCONTEXT_PROFILE: 'prod', LM_STUDIO_TIMEOUT_MS: '-1' });
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('AGENTCONTEXT_PORT');
    expect(issues.join('\n')).toContain('AGENTCONTEXT_PROFILE');
    expect(issues.join('\n')).toContain('LM_STUDIO_TIMEOUT_MS');
  });

  it('APIキーは空白・改行の混入を弾く（コピー&ペースト事故）', () => {
    expect(validateEnvironment({ LM_STUDIO_API_KEY: 'sk-abcdef' }).LM_STUDIO_API_KEY).toBe('sk-abcdef');
    for (const name of ['LM_STUDIO_API_KEY', 'JUDGE_LM_STUDIO_API_KEY', 'TAVILY_API_KEY', 'TINYFISH_API_KEY', 'GOOGLE_CUSTOM_SEARCH_API_KEY'] as const) {
      expect(issuesOf({ [name]: 'sk-abc def' })[0]).toContain(name);
      expect(issuesOf({ [name]: 'sk-abc\n' })).toHaveLength(1);
    }
  });

  it('メッセージに受け取った値を載せるが、秘密値は伏せる', () => {
    expect(issuesOf({ AGENTCONTEXT_PORT: 'abc' })[0]).toContain('"abc"');
    // 値そのものはログにもエラーにも出さない。
    const redacted = issuesOf({ LM_STUDIO_API_KEY: 'sk-do-not-log me' })[0] ?? '';
    expect(redacted).toContain('(値は伏せる)');
    expect(redacted).not.toContain('sk-do-not-log');
    expect(issuesOf({ LM_STUDIO_API_KEY: '   ' })).toEqual([]); // 空白のみは未設定扱い
    const secret = issuesOf({ AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({ x: 1 }) });
    expect(secret[0]).toContain('AGENTCONTEXT_DB_CONNECTIONS');
    // 長い値は切り詰める。
    const long = issuesOf({ AGENTCONTEXT_MODEL_PRICING_JSON: `[${'"x",'.repeat(80)}"x"]` });
    expect(long[0]).toContain('…');
  });

  it('EnvironmentValidationError は件数と全行をメッセージに含む', () => {
    const error = new EnvironmentValidationError(['A: 1', 'B: 2']);
    expect(error.name).toBe('EnvironmentValidationError');
    expect(error.message).toContain('2件');
    expect(error.message).toContain('A: 1');
    expect(error.message).toContain('B: 2');
  });

  it('未知の env 名の issue でも汎用メッセージで落ちない', () => {
    // environmentSchema を直接使う経路（将来キーを足して EXPECTATIONS を書き忘れた場合の保険）。
    expect(environmentSchema.safeParse({ AGENTCONTEXT_PORT: 'abc' }).success).toBe(false);
    expect(databaseConnectionsSchema.safeParse({}).success).toBe(true);
  });
});

describe('serverSettings', () => {
  it('未設定なら既定値を当てる', () => {
    expect(serverSettings(validateEnvironment({}))).toEqual({
      profile: 'local',
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      sampleData: false,
      uiRootOverride: undefined,
      revision: undefined,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      retentionIntervalMs: DEFAULT_RETENTION_INTERVAL_MS,
      logLevel: 'info',
      scope: { tenantId: 'local', workspaceId: 'default' },
      authentication: { mode: 'single-user', tokens: [] },
      allowedHosts: undefined,
    });
  });

  it('AGENTCONTEXT_RETENTION_INTERVAL_MS=0 は既定値に落ちず「自動実行しない」として通る', () => {
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_RETENTION_INTERVAL_MS: '0' })).retentionIntervalMs).toBe(0);
  });

  it('AGENTCONTEXT_SHUTDOWN_GRACE_MS=0 は既定値に落ちず「待たない」として通る', () => {
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_SHUTDOWN_GRACE_MS: '0' })).shutdownGraceMs).toBe(0);
  });

  it('設定済みの値を反映する', () => {
    const settings = serverSettings(validateEnvironment({
      AGENTCONTEXT_PROFILE: 'test',
      AGENTCONTEXT_PORT: '4000',
      AGENTCONTEXT_HOST: '0.0.0.0',
      AGENTCONTEXT_SAMPLE_DATA: 'true',
      AGENTCONTEXT_UI_ROOT: '/srv/ui',
      AGENTCONTEXT_SOURCE_REVISION: 'deadbeef',
      AGENTCONTEXT_TENANT_ID: 'acme',
      AGENTCONTEXT_WORKSPACE_ID: 'ops',
      AGENTCONTEXT_SHUTDOWN_GRACE_MS: '25000',
      AGENTCONTEXT_RETENTION_INTERVAL_MS: '3600000',
      // 0.0.0.0 へバインドするので認証が要る（下の「バインドアドレスと認証」を参照）。
      AGENTCONTEXT_AUTH_TOKENS: JSON.stringify([{ subject: 'alice', token: 'a'.repeat(40) }]),
    }));
    expect(settings).toEqual({
      profile: 'test',
      port: 4000,
      host: '0.0.0.0',
      sampleData: true,
      uiRootOverride: '/srv/ui',
      revision: 'deadbeef',
      shutdownGraceMs: 25_000,
      retentionIntervalMs: 3_600_000,
      logLevel: 'silent',
      scope: { tenantId: 'acme', workspaceId: 'ops' },
      authentication: {
        mode: 'token',
        // トークンにテナントを書かなければ、既定スコープ（AGENTCONTEXT_TENANT_ID/_WORKSPACE_ID）を引き継ぐ。
        tokens: [{ subject: 'alice', token: 'a'.repeat(40), tenantId: 'acme', workspaceId: 'ops' }],
      },
      allowedHosts: undefined,
    });
  });

  it('AGENTCONTEXT_SAMPLE_DATA=false はサンプル投入しない', () => {
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_SAMPLE_DATA: 'false' })).sampleData).toBe(false);
  });

  it('ログレベルの既定はプロファイルで変える（local=info / test=silent）', () => {
    expect(DEFAULT_LOG_LEVELS).toEqual({ local: 'info', test: 'silent' });
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_PROFILE: 'local' })).logLevel).toBe('info');
    // テスト用の起動（E2Eなど）で毎リクエスト2行流れるとテスト出力が読めなくなる。
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_PROFILE: 'test' })).logLevel).toBe('silent');
  });

  it('AGENTCONTEXT_LOG_LEVEL はプロファイル既定より優先する（test でも見たいときに戻せる）', () => {
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_PROFILE: 'test', AGENTCONTEXT_LOG_LEVEL: 'debug' })).logLevel).toBe('debug');
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_LOG_LEVEL: 'silent' })).logLevel).toBe('silent');
  });

  it('AGENTCONTEXT_ALLOWED_HOSTS はカンマ区切りで読み、空要素は落とす', () => {
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_ALLOWED_HOSTS: 'app.example.com, 127.0.0.1 ,,' })).allowedHosts)
      .toEqual(['app.example.com', '127.0.0.1']);
    expect(serverSettings(validateEnvironment({ AGENTCONTEXT_ALLOWED_HOSTS: ' , ' })).allowedHosts).toBeUndefined();
  });
});

/**
 * `Host` 検査の適用範囲。
 *
 * 以前は「ループバックへバインドしているか」だけで決めていた。しかし `127.0.0.1` へ
 * バインドしてリバースプロキシを前に置くのは本番の一般形で、そこでは `Host: app.example.com`
 * が飛んでくる。バインド先だけを見て縛ると**認証込みの真っ当な構成が全リクエスト403**になる。
 */
describe('allowedHostNames', () => {
  const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
  const settingsOf = (env: NodeJS.ProcessEnv) => serverSettings(validateEnvironment(env));
  const tokens = JSON.stringify([{ subject: 'alice', token: 'a'.repeat(40) }]);

  it('単一ユーザーモード（ループバック）では検査する — 認証が無くHostが唯一の識別子', () => {
    expect(allowedHostNames(settingsOf({}), LOOPBACK)).toEqual(LOOPBACK);
    expect(allowedHostNames(settingsOf({ AGENTCONTEXT_HOST: 'localhost' }), LOOPBACK)).toEqual(LOOPBACK);
  });

  it('トークン認証なら検査しない（127.0.0.1 バインド + リバースプロキシで403にしない）', () => {
    expect(allowedHostNames(settingsOf({ AGENTCONTEXT_AUTH_TOKENS: tokens }), LOOPBACK)).toBeUndefined();
    expect(allowedHostNames(settingsOf({ AGENTCONTEXT_HOST: '0.0.0.0', AGENTCONTEXT_AUTH_TOKENS: tokens }), LOOPBACK)).toBeUndefined();
  });

  it('AGENTCONTEXT_ALLOWED_HOSTS を書けばモードを問わず、書いた名前だけを受け付ける', () => {
    expect(allowedHostNames(settingsOf({ AGENTCONTEXT_ALLOWED_HOSTS: 'app.example.com', AGENTCONTEXT_AUTH_TOKENS: tokens }), LOOPBACK))
      .toEqual(['app.example.com']);
    // 単一ユーザーモードでも上書きできる（ループバック名の既定より優先する）。
    expect(allowedHostNames(settingsOf({ AGENTCONTEXT_ALLOWED_HOSTS: 'blume.local' }), LOOPBACK)).toEqual(['blume.local']);
  });
});

/**
 * バインドアドレスと認証の組み合わせ。
 *
 * 「ローカルだから無認証でよい」という前提は、`AGENTCONTEXT_HOST` を変えた瞬間に破綻する。
 * ここで落とさないと、`0.0.0.0` を1行足しただけで同じネットワークの誰でも全データを
 * 読み書き・削除できる状態になる。
 */
describe('serverSettings 認証', () => {
  const TOKEN = 'x'.repeat(40);
  const tokensEnv = (entries: unknown) => JSON.stringify(entries);

  it('ループバックなら認証未設定でも起動できる（単一ユーザーモード）', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      const settings = serverSettings(validateEnvironment({ AGENTCONTEXT_HOST: host }));
      expect(settings.authentication).toEqual({ mode: 'single-user', tokens: [] });
    }
  });

  it('ループバック以外へバインドするなら認証必須（未設定は起動拒否）', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'api.example.com']) {
      expect(() => serverSettings(validateEnvironment({ AGENTCONTEXT_HOST: host })))
        .toThrow(EnvironmentValidationError);
    }
    // メッセージは「何をすればよいか」を含む。
    try {
      serverSettings(validateEnvironment({ AGENTCONTEXT_HOST: '0.0.0.0' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvironmentValidationError).issues[0]).toContain('AGENTCONTEXT_AUTH_TOKENS');
    }
  });

  it('ループバック以外でもトークンがあれば起動できる', () => {
    const settings = serverSettings(validateEnvironment({
      AGENTCONTEXT_HOST: '0.0.0.0',
      AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN }]),
    }));
    expect(settings.authentication.mode).toBe('token');
    expect(settings.authentication.tokens).toHaveLength(1);
  });

  it('トークンを設定すれば AGENTCONTEXT_AUTH_MODE 未指定でも token モードになる', () => {
    // モード指定の書き忘れで「トークンを用意したのに無認証」になる事故を防ぐ。
    expect(serverSettings(validateEnvironment({
      AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN }]),
    })).authentication.mode).toBe('token');
  });

  it('トークンごとにテナントを分けられる（省略時は既定スコープ）', () => {
    const settings = serverSettings(validateEnvironment({
      AGENTCONTEXT_TENANT_ID: 'acme',
      AGENTCONTEXT_WORKSPACE_ID: 'ops',
      AGENTCONTEXT_AUTH_TOKENS: tokensEnv([
        { subject: 'alice', token: TOKEN },
        { subject: 'bob', token: 'y'.repeat(40), tenantId: 'globex', workspaceId: 'main', displayName: 'Bob', roles: ['viewer'] },
      ]),
    }));
    expect(settings.authentication.tokens).toEqual([
      { subject: 'alice', token: TOKEN, tenantId: 'acme', workspaceId: 'ops' },
      { subject: 'bob', token: 'y'.repeat(40), tenantId: 'globex', workspaceId: 'main', displayName: 'Bob', roles: ['viewer'] },
    ]);
  });

  it('token モードなのにトークンが無ければ起動しない', () => {
    expect(() => serverSettings(validateEnvironment({ AGENTCONTEXT_AUTH_MODE: 'token' })))
      .toThrow(EnvironmentValidationError);
  });

  it('single-user とトークンの併記は矛盾なので起動しない', () => {
    expect(() => serverSettings(validateEnvironment({
      AGENTCONTEXT_AUTH_MODE: 'single-user',
      AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN }]),
    }))).toThrow(EnvironmentValidationError);
  });

  it('短すぎる／空白を含むトークン、空の配列、壊れたJSONは検証で落ちる', () => {
    const invalid = [
      tokensEnv([{ subject: 'alice', token: 'short' }]),
      tokensEnv([{ subject: 'alice', token: `${'x'.repeat(40)} ` }]),
      tokensEnv([{ token: TOKEN }]),
      tokensEnv([]),
      '{ not json',
    ];
    for (const value of invalid) {
      expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: value })).toThrow(EnvironmentValidationError);
    }
  });

  it('未知のロール名は起動時に落ちる（AUTH_ROLES は domain の値域と一致する）', () => {
    // leaf モジュールなので domain を import せず書き写している。ずれたらここで気づく。
    expect([...AUTH_ROLES]).toEqual([...AUTHORIZATION_ROLES]);
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: ['admin'] }]) }))
      .toThrow(EnvironmentValidationError);
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: ['Operator'] }]) }))
      .toThrow(EnvironmentValidationError);
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: ['workspace-admin', 'operator'] }]) }))
      .not.toThrow();
  });

  /**
   * `roles: []` は「何もさせない」の意図で書かれる。ところが空配列を「未指定」と同一視して
   * 既定（editor）を付けていたため、**権限を与えないつもりの設定が全権に近いトークン**になっていた。
   * 間違え方として最悪の向きなので、どちらとも読める書き方を起動時に落とす。
   */
  it('roles の空配列は起動時に落ちる（黙って editor にしない）', () => {
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: [] }]) }))
      .toThrow(EnvironmentValidationError);
    // 直し方が伝わる文言になっている。
    try {
      validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: [] }]) });
    } catch (error) {
      expect((error as EnvironmentValidationError).message).toContain('viewer');
    }
    // 「読み取りだけ」は明示すれば通る。キーを書かなければ既定（editor）のまま。
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN, roles: ['viewer'] }]) })).not.toThrow();
    expect(() => validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: TOKEN }]) })).not.toThrow();
  });

  it('トークンの値はエラーメッセージへ出さない', () => {
    try {
      validateEnvironment({ AGENTCONTEXT_AUTH_TOKENS: tokensEnv([{ subject: 'alice', token: 'short' }]) });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as EnvironmentValidationError).message;
      expect(message).toContain('(値は伏せる)');
      expect(message).not.toContain('short');
    }
  });

  it('isLoopbackHost は 127.0.0.0/8・::1・localhost だけを認める', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
    expect(isLoopbackHost(' ::1 ')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    // 先頭一致だけを見て通してしまわないこと（127 で始まる公開アドレスは実在する）。
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
  });
});

describe('mcpSettings', () => {
  it('未設定なら「呼び出し側の既定に従う」（無制限ではない）', () => {
    expect(mcpSettings({})).toEqual({ allowedCommands: undefined, unrestrictedCommands: false, allowPrivateNetwork: false });
  });

  it('カンマ区切りを許可リストとして読む（空要素と前後空白は落とす）', () => {
    expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOWED_COMMANDS: ' npx , node ,, uvx ' }))
      .toMatchObject({ allowedCommands: ['npx', 'node', 'uvx'], unrestrictedCommands: false });
  });

  it('`*` 単独のときだけ制限しない', () => {
    expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOWED_COMMANDS: '*' })).toMatchObject({ unrestrictedCommands: true, allowedCommands: undefined });
    // 部分的なワイルドカードは「制限が効いている」と誤読されるので、ただの許可リストとして扱う。
    expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOWED_COMMANDS: 'npx,*' })).toMatchObject({ unrestrictedCommands: false, allowedCommands: ['npx', '*'] });
  });

  it('空文字は未設定と同じ（.env に `KEY=` とだけ書かれた行）', () => {
    expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOWED_COMMANDS: '   ' }).allowedCommands).toBeUndefined();
  });

  it("私設ネットワークの許可は 'true' のときだけ", () => {
    expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK: 'true' }).allowPrivateNetwork).toBe(true);
    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      expect(mcpSettings({ AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK: value }).allowPrivateNetwork).toBe(false);
    }
  });

  it('環境変数の形式は起動時検証の対象になっている', () => {
    expect(issuesOf({ AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK: 'maybe' })[0]).toContain('AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK');
    expect(validateEnvironment({ AGENTCONTEXT_MCP_ALLOWED_COMMANDS: 'npx,node' }).AGENTCONTEXT_MCP_ALLOWED_COMMANDS).toBe('npx,node');
  });
});

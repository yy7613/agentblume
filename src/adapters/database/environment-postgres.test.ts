import { describe, expect, it } from 'vitest';
import { EnvironmentPostgresConnectionCatalog, testEnvironmentPostgresConnection } from './environment-postgres';

const configured = JSON.stringify({ sales: { driver: 'postgresql', host: 'localhost', port: 5432, database: 'sales', username: 'reader', passwordEnv: 'SALES_PASSWORD' } });

describe('EnvironmentPostgresConnectionCatalog', () => {
  it('環境変数から安全な接続IDとdriverだけを公開する', () => {
    const catalog = new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: JSON.stringify({ ...JSON.parse(configured), invalid: { driver: 'mysql' } }) });
    expect(catalog.list()).toEqual([{ id: 'sales', driver: 'postgresql' }]);
  });

  it('未構成・パスワード未設定を接続せず利用不可として返す', async () => {
    await expect(testEnvironmentPostgresConnection('missing', { AGENTCONTEXT_DB_CONNECTIONS: configured })).resolves.toMatchObject({ driver: 'postgresql', available: false, error: 'connection is not configured' });
    await expect(testEnvironmentPostgresConnection('sales', { AGENTCONTEXT_DB_CONNECTIONS: configured })).resolves.toMatchObject({ driver: 'postgresql', available: false, error: 'password environment variable is not configured' });
  });

  it('未設定・空文字は接続なしとして扱う', () => {
    expect(new EnvironmentPostgresConnectionCatalog({}).list()).toEqual([]);
    expect(new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: '   ' }).list()).toEqual([]);
  });

  // 以前は catch で {} を返していたため、カンマ1つの打ち間違いで全接続が画面から静かに消えた。
  it('JSONとして壊れた設定は握り潰さず失敗させる', async () => {
    expect(() => new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: 'not-json' }).list()).toThrow(/not valid JSON/);
    expect(() => new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: '[]' }).list()).toThrow(/JSON object/);
    await expect(testEnvironmentPostgresConnection('sales', { AGENTCONTEXT_DB_CONNECTIONS: '{oops' })).rejects.toThrow(/not valid JSON/);
    await expect(new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: 'null' }).readTable('sales', 'public.x', 1)).rejects.toThrow(/JSON object/);
  });

  it('不正な接続設定を除外し、接続失敗時も詳細を漏らさない', async () => {
    const noPort = JSON.stringify({ noport: { driver: 'postgresql', host: '127.0.0.1', database: 'db', username: 'reader', passwordEnv: 'PASSWORD', ssl: true }, badPort: { driver: 'postgresql', host: 'x', port: 0, database: 'db', username: 'reader', passwordEnv: 'PASSWORD' } });
    expect(new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: noPort }).list()).toEqual([{ id: 'noport', driver: 'postgresql' }]);
    await expect(testEnvironmentPostgresConnection('noport', { AGENTCONTEXT_DB_CONNECTIONS: noPort, PASSWORD: 'not-used' })).resolves.toEqual({ id: 'noport', driver: 'postgresql', available: false, error: 'connection test failed' });
  });

  it('DB読取はallowlist、資格情報、接続設定の順にfail closedにする', async () => {
    const config = JSON.stringify({ reporting: { driver: 'postgresql', host: '127.0.0.1', port: 1, database: 'db', username: 'reader', passwordEnv: 'PASSWORD', ssl: false, allowedTables: ['public.sales_daily'] } });
    const withoutPassword = new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: config });
    await expect(withoutPassword.readTable('missing', 'public.sales_daily', 1)).rejects.toThrow('not allowed');
    await expect(withoutPassword.readTable('reporting', 'public.other', 1)).rejects.toThrow('not allowed');
    await expect(withoutPassword.readTable('reporting', 'public.sales_daily', 1)).rejects.toThrow('password');
    const refused = new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: config, PASSWORD: 'test' });
    await expect(refused.readTable('reporting', 'public.sales_daily', 0)).rejects.toBeInstanceOf(Error);
    await expect(refused.readTable('reporting', 'public.sales_daily', 20_000)).rejects.toBeInstanceOf(Error);
  });

  it('allowlist形式が不正な接続設定を公開しない', () => {
    const malformed = JSON.stringify({ bad: { driver: 'postgresql', host: 'db', database: 'db', username: 'reader', passwordEnv: 'PASSWORD', allowedTables: ['public.valid', 'invalid-name!'] }, nonarray: { driver: 'postgresql', host: 'db', database: 'db', username: 'reader', passwordEnv: 'PASSWORD', allowedTables: 'public.valid' } });
    expect(new EnvironmentPostgresConnectionCatalog({ AGENTCONTEXT_DB_CONNECTIONS: malformed }).list()).toEqual([]);
  });
});

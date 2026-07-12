import { Client } from 'pg';
import type { DatabaseConnectionCatalog } from '../../application/data-source/manage-data-sources';
import type { DatabaseReadPort } from '../../application/data-source/manage-data-sources';
import type { DatabaseConnectionStatus, DatabaseConnectionSummary } from '../../domain/data-source/data-source';
import type { Row } from '../../domain/data/types';

interface ConnectionConfig { readonly driver: 'postgresql'; readonly host: string; readonly port?: number; readonly database: string; readonly username: string; readonly passwordEnv: string; readonly ssl?: boolean; readonly allowedTables: readonly string[] }

function readConnections(env: NodeJS.ProcessEnv): Record<string, ConnectionConfig> {
  try {
    const parsed: unknown = JSON.parse(env['AGENTCONTEXT_DB_CONNECTIONS'] ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      const config = value as Record<string, unknown>;
      if (config['driver'] !== 'postgresql' || typeof config['host'] !== 'string' || typeof config['database'] !== 'string' || typeof config['username'] !== 'string' || typeof config['passwordEnv'] !== 'string') return [];
      if (config['port'] !== undefined && (typeof config['port'] !== 'number' || !Number.isInteger(config['port']) || config['port'] < 1 || config['port'] > 65_535)) return [];
      if (config['ssl'] !== undefined && typeof config['ssl'] !== 'boolean') return [];
      const tables = config['allowedTables'];
      if (tables !== undefined && (!Array.isArray(tables) || tables.some((table) => typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(table)))) return [];
      return [[id, { driver: 'postgresql', host: config['host'], ...(config['port'] === undefined ? {} : { port: config['port'] }), database: config['database'], username: config['username'], passwordEnv: config['passwordEnv'], ...(config['ssl'] === undefined ? {} : { ssl: config['ssl'] }), allowedTables: (tables as string[] | undefined) ?? [] }]];
    })) as Record<string, ConnectionConfig>;
  } catch { return {}; }
}

/** AGENTCONTEXT_DB_CONNECTIONSを安全な接続カタログとして公開する。 */
export class EnvironmentPostgresConnectionCatalog implements DatabaseConnectionCatalog, DatabaseReadPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  list(): readonly DatabaseConnectionSummary[] {
    return Object.entries(readConnections(this.env)).map(([id, config]) => ({ id, driver: config.driver })).sort((left, right) => left.id.localeCompare(right.id));
  }

  async test(id: string): Promise<DatabaseConnectionStatus> { return testEnvironmentPostgresConnection(id, this.env); }

  // v8の単体計測は外部DBなしでquery成功分岐を再現できないため、公式PostgreSQLコンテナの統合スモークで検証する。
  /* v8 ignore next */
  async readTable(connectionId: string, table: string, limit: number): Promise<readonly Row[]> {
    const config = readConnections(this.env)[connectionId];
    if (config === undefined || !config.allowedTables.includes(table)) throw new Error('database table is not allowed');
    const password = this.env[config.passwordEnv];
    if (password === undefined || password === '') throw new Error('database password is not configured');
    const boundedLimit = Math.max(1, Math.min(10_000, limit));
    const client = new Client({ host: config.host, port: config.port ?? 5432, database: config.database, user: config.username, password, ssl: config.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      const result = await client.query(`SELECT * FROM ${quoteQualifiedIdentifier(table)} LIMIT $1`, [boundedLimit]);
      await client.query('COMMIT');
      return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toCell(value)])) as Row);
    } finally { await client.end().catch(() => undefined); }
  }
}

function quoteQualifiedIdentifier(value: string): string { return value.split('.').map((part) => `"${part}"`).join('.'); }
function toCell(value: unknown): string | number | boolean | Date | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return value;
  return JSON.stringify(value);
}

export async function testEnvironmentPostgresConnection(id: string, env: NodeJS.ProcessEnv = process.env): Promise<DatabaseConnectionStatus> {
  let client: Client | undefined;
  try {
    const connections = readConnections(env);
    const config = connections[id];
    if (config === undefined) return { id, driver: 'postgresql', available: false, error: 'connection is not configured' };
    const password = env[config.passwordEnv];
    if (password === undefined || password === '') return { id, available: false, driver: config.driver, error: 'password environment variable is not configured' };
    client = new Client({ host: config.host, port: config.port ?? 5432, database: config.database, user: config.username, password, ssl: config.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 5_000 });
    await client.connect(); await client.query('SELECT 1');
    return { id, available: true, driver: config.driver };
  } catch { return { id, driver: 'postgresql', available: false, error: 'connection test failed' }; }
  finally { if (client !== undefined) await client.end().catch(() => undefined); }
}

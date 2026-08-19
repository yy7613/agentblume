/**
 * adapters層: MCPサーバー設定のSQLite永続化。設定は版を持たず (scope, name) で upsert する。
 *
 * ## 秘密値の暗号化（保存時封緘 / 読み出し時開封）
 *
 * `env` / `headers` の値は資格情報なので、`config_json` へ**平文で書かない**。
 * ここが「保管時の境界」であり、上位（use case・MCPクライアント）は従来どおり平文の
 * `McpServerConfig` を扱う。子プロセスの起動やHTTPヘッダの付与には実値が要るので、
 * モデル設定のようにドメインへ `SealedSecret` を持ち上げる形は取らず、
 * **入出力の境界で封緘・開封する**（＝ `McpServerRepository` の契約は変わらない）。
 *
 * ## 既存の平文データの移行
 *
 * v35〜v36 に平文で保存された行がそのまま残っている。読み出しでは平文（文字列）を
 * そのまま受け入れ、**次に保存されたときに封緘し直す**。DBスキーマは変わらないので
 * マイグレーションは不要で、行は触られた順に直っていく。
 */
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { SecretCipherPort } from '../../application/model-settings/secret-cipher';
import type { SealedSecret } from '../../domain/model-settings/sealed-secret';
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import {
  isStoredSealed, parseStoredMcpServerConfig, storedSecrets, toMcpServerConfig, toStoredMcpServerConfig,
  type StoredMcpServerConfig,
} from '../../domain/mcp/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** `resealLegacySecrets()` の結果。`failed > 0` は「次の保存に委ねた行がある」を意味する。 */
export interface ResealResult {
  /** 平文から封緘し直せた行数。 */
  readonly resealed: number;
  /** 壊れている・開封できない等で処理できなかった行数（起動は止めない）。 */
  readonly failed: number;
}

export class SqliteMcpServerRepository extends SqliteRepositoryBase implements McpServerRepository {
  /**
   * `cipher` は必須。省略可能にすると、配線を1箇所忘れただけで**黙って平文保存に戻る**。
   * テストは `AesGcmSecretCipher.ephemeral()`（鍵ファイルを作らない）を渡す。
   */
  constructor(source: SqliteDatabaseSource = ':memory:', private readonly cipher: SecretCipherPort) {
    super(source);
  }

  async save(config: McpServerConfig): Promise<void> {
    this.insert(await this.seal(config));
  }

  async find(scope: TenantScope, name: string): Promise<McpServerConfig | null> {
    const row = this.db.prepare(`SELECT config_json FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).get(scope.tenantId, scope.workspaceId, name);
    return row === undefined ? null : this.open(parse(row['config_json']));
  }

  async list(scope: TenantScope): Promise<readonly McpServerConfig[]> {
    const rows = this.db.prepare(`SELECT config_json FROM mcp_servers WHERE tenant_id=? AND workspace_id=? ORDER BY name`)
      .all(scope.tenantId, scope.workspaceId)
      .map((row) => parse(row['config_json']));
    return Promise.all(rows.map((stored) => this.open(stored)));
  }

  async delete(scope: TenantScope, name: string): Promise<boolean> {
    const existing = this.db.prepare(`SELECT 1 FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).get(scope.tenantId, scope.workspaceId, name);
    if (existing === undefined) return false;
    this.db.prepare(`DELETE FROM mcp_servers WHERE tenant_id=? AND workspace_id=? AND name=?`).run(scope.tenantId, scope.workspaceId, name);
    return true;
  }

  /**
   * スコープ内を原子的に置き換える。途中で失敗しても設定が半端に消えないようトランザクションで囲う。
   * 接続は共有なので、外側にトランザクションがあればSAVEPOINTとして合流する（BEGINの入れ子を避ける）。
   *
   * 封緘は**トランザクションの外**で先に済ませる（`transaction()` は同期コールバックを取るため、
   * 中で await できない。鍵の読み込みで失敗した場合も、DBを触る前に止まるほうが安全）。
   */
  async replaceAll(scope: TenantScope, configs: readonly McpServerConfig[]): Promise<void> {
    const sealed = await Promise.all(configs.map((config) => this.seal(config)));
    this.database.transaction(() => {
      this.db.prepare(`DELETE FROM mcp_servers WHERE tenant_id=? AND workspace_id=?`).run(scope.tenantId, scope.workspaceId);
      for (const stored of sealed) this.insert(stored);
    });
  }

  /**
   * v36以前に平文で保存された行を封緘し直す（起動時に1回だけ呼ぶ想定）。
   *
   * 「読み出しで平文を許し、次の保存で封緘する」だけだと、**誰も編集しないサーバーの資格情報は
   * ディスク上に平文で残り続ける**。それでは対策として不十分なので、起動時に一掃する。
   * スコープ横断で全行を見る必要があるためリポジトリの契約（`McpServerRepository`）には載せず、
   * SQLite実装固有の運用操作としてここに置く。
   *
   * **べき等**。封緘済みの行は読み書きしない。
   *
   * ## 1行の失敗で起動を落とさない
   *
   * 以前はJSONパースだけを `try/catch` していて、`cipher.open` / `cipher.seal` は無保護だった。
   * 鍵を差し替えた環境（開封できない封緘済みの行が混ざる）では例外がそのまま起動処理へ抜け、
   * **`listen()` へ到達せずプロセスが落ちる**。しかも画面が上がらないので、原因の設定を
   * 消して復旧することもできない（デッドロック）。掃除の失敗は掃除の失敗であって
   * 起動の失敗ではないので、行ごとに握って件数として返す。
   * サーバー名も値もログへ出さないのは呼び出し側の責任。
   */
  async resealLegacySecrets(): Promise<ResealResult> {
    const rows = this.db.prepare(`SELECT tenant_id, workspace_id, name, config_json FROM mcp_servers`).all();
    let resealed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const stored = parseStoredMcpServerConfig(JSON.parse(String(row['config_json'])));
        if (!Object.values(storedSecrets(stored)).some((value) => !isStoredSealed(value))) continue;
        this.insert(await this.seal(await this.open(stored)));
        resealed += 1;
      } catch {
        // 壊れた行・開封できない行は次の保存に委ねる。ここで止めると起動できなくなる。
        failed += 1;
      }
    }
    return { resealed, failed };
  }

  private async seal(config: McpServerConfig): Promise<StoredMcpServerConfig> {
    const plain = config.transport.kind === 'stdio' ? config.transport.env : config.transport.headers;
    const sealed: Record<string, SealedSecret> = {};
    for (const [key, value] of Object.entries(plain)) sealed[key] = await this.cipher.seal(value);
    return toStoredMcpServerConfig(config, sealed);
  }

  private async open(stored: StoredMcpServerConfig): Promise<McpServerConfig> {
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(storedSecrets(stored))) {
      // 平文（文字列）は v36 以前に保存された行。そのまま使い、次の保存で封緘され直す。
      secrets[key] = isStoredSealed(value) ? await this.cipher.open(value) : value;
    }
    return toMcpServerConfig(stored, secrets);
  }

  private insert(stored: StoredMcpServerConfig): void {
    this.db.prepare(
      `INSERT INTO mcp_servers (tenant_id, workspace_id, name, updated_at, config_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, name) DO UPDATE SET updated_at=excluded.updated_at, config_json=excluded.config_json`,
    ).run(stored.scope.tenantId, stored.scope.workspaceId, stored.name, stored.updatedAt, JSON.stringify(stored));
  }
}

function parse(value: unknown): StoredMcpServerConfig {
  return parseStoredMcpServerConfig(JSON.parse(String(value)));
}

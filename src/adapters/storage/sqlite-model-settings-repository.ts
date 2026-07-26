import { DatabaseSync } from 'node:sqlite';
import type { ModelSettings } from '../../domain/model-settings/model-settings';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import { deserializeModelSettings, serializeModelSettings } from '../../domain/model-settings/serialization';
import type { TenantScope } from '../../domain/tool/ids';

const SQL = `
CREATE TABLE IF NOT EXISTS model_settings (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  updated_at TEXT NOT NULL, settings_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id)
);
`;

/**
 * モデル設定のSQLite永続化。設定は版を持たず (tenant_id, workspace_id) で upsert する。
 *
 * settings_json に入るAPIキーは封緘済み（SealedSecret）だけである。
 * 鍵はDBの外（鍵ファイル）にあるため、このファイル単体からは平文を復元できない。
 */
export class SqliteModelSettingsRepository implements ModelSettingsRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(SQL); }
  close(): void { this.db.close(); }

  async find(scope: TenantScope): Promise<ModelSettings | null> {
    const row = this.db.prepare(`SELECT settings_json FROM model_settings WHERE tenant_id=? AND workspace_id=?`).get(scope.tenantId, scope.workspaceId);
    return row === undefined ? null : deserializeModelSettings(JSON.parse(String(row['settings_json'])));
  }

  async save(settings: ModelSettings): Promise<void> {
    this.db.prepare(
      `INSERT INTO model_settings (tenant_id, workspace_id, updated_at, settings_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET updated_at=excluded.updated_at, settings_json=excluded.settings_json`,
    ).run(settings.scope.tenantId, settings.scope.workspaceId, settings.updatedAt, JSON.stringify(serializeModelSettings(settings)));
  }
}

/**
 * ドメイン: モデル設定のリポジトリ境界。
 *
 * 設定は版を持たず、スコープごとに1件だけ存在する（save は (tenantId, workspaceId) で upsert）。
 * 封緘済みAPIキーを含むため、実装は**平文の秘密値を決して保存しない**（SealedSecret のまま保存する）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { ModelSettings } from './model-settings';

export interface ModelSettingsRepository {
  find(scope: TenantScope): Promise<ModelSettings | null>;
  save(settings: ModelSettings): Promise<void>;
}

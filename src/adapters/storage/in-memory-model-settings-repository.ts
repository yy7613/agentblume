import type { ModelSettings } from '../../domain/model-settings/model-settings';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';

/** モデル設定のインメモリ永続化（testプロファイル・契約テスト用）。 */
export class InMemoryModelSettingsRepository implements ModelSettingsRepository {
  private readonly store = new Map<string, ModelSettings>();

  async find(scope: TenantScope): Promise<ModelSettings | null> {
    const settings = this.store.get(tenantKey(scope));
    return settings === undefined ? null : structuredClone(settings);
  }

  async save(settings: ModelSettings): Promise<void> {
    this.store.set(tenantKey(settings.scope), structuredClone(settings));
  }
}

/**
 * application層: 入金消込の設定（docs/22 §2.1）の取得と保存。
 *
 * 保存したことが無いワークスペースは初期値を返すが**保存しない**（仕訳の科目マスタ ADR-0038 決定 2 と同じ理由:
 * 参照が書き込みを起こすと参照権限の利用者が落ち、初期値を後から改善しても一度開いたワークスペースに古い値が焼き付く）。
 */
import { createReceivablesSettings, defaultReceivablesSettings, type ReceivablesSettings } from '../../domain/receivables/settings';
import type { ReceivablesSettingsRepository } from '../../domain/receivables/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { settingsOrDefault } from './ports';

export interface ReceivablesSettingsResult {
  readonly settings: ReceivablesSettings;
  readonly saved: boolean;
}

export class GetReceivablesSettingsUseCase {
  constructor(private readonly settings: ReceivablesSettingsRepository) {}
  async execute(scope: TenantScope): Promise<ReceivablesSettingsResult> {
    return settingsOrDefault(this.settings, scope, () => defaultReceivablesSettings());
  }
}

export class SaveReceivablesSettingsUseCase {
  constructor(private readonly settings: ReceivablesSettingsRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(input: { readonly scope: TenantScope; readonly settings: Omit<ReceivablesSettings, 'updatedAt'> }): Promise<ReceivablesSettings> {
    const settings = createReceivablesSettings({ ...input.settings, updatedAt: this.now().toISOString() });
    await this.settings.save(input.scope, settings);
    return settings;
  }
}

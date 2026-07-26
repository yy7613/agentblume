/**
 * application層: モデル選択肢の照会。
 *
 * providers() はオフラインの登録簿から即答する。OpenAI互換エンドポイントのモデル一覧だけは
 * 実際に問い合わせる必要があるため、**キーはAPIのクエリで受け取らず**（URLに秘密値を残さない）、
 * 保存済みスロットのキーを開封して使う。
 */
import { modelSlot, type ModelSlotName } from '../../domain/model-settings/model-settings';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { ModelCatalogPort, ModelCatalogProvider } from './model-catalog';
import type { SecretCipherPort } from './secret-cipher';

export interface ListOpenAiCompatibleModelsInput {
  readonly scope: TenantScope;
  readonly baseUrl: string;
  /** 指定時は、そのスロットに保存済みのAPIキーを使って問い合わせる。 */
  readonly slot?: ModelSlotName;
}

export class QueryModelCatalogUseCase {
  constructor(
    private readonly catalog: ModelCatalogPort,
    private readonly repo: ModelSettingsRepository,
    private readonly cipher: SecretCipherPort,
  ) {}

  providers(): readonly ModelCatalogProvider[] {
    return this.catalog.providers();
  }

  async openAiCompatibleModels(input: ListOpenAiCompatibleModelsInput, signal?: AbortSignal): Promise<readonly string[]> {
    const apiKey = input.slot === undefined ? undefined : await this.storedKey(input.scope, input.slot);
    return this.catalog.listOpenAiCompatibleModels(input.baseUrl, apiKey, signal);
  }

  private async storedKey(scope: TenantScope, slot: ModelSlotName): Promise<string | undefined> {
    const settings = modelSlot(await this.repo.find(scope), slot);
    return settings?.apiKey === undefined ? undefined : this.cipher.open(settings.apiKey);
  }
}

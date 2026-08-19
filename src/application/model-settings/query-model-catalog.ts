/**
 * application層: モデル選択肢の照会。
 *
 * providers() は接続先の見出しだけをオフラインで即答する（モデル名は配らない）。
 * OpenAI互換エンドポイントのモデル一覧だけは実際に問い合わせる必要があるため、
 * **キーはAPIのクエリで受け取らず**（URLに秘密値を残さない）、保存済みスロットのキーを開封して使う。
 *
 * 保存済みキーの流用は **宛先が一致するときだけ**である。
 * `baseUrl` を任意に指定できる以上、宛先を見ずにキーを付けると
 * 「攻撃者のURL宛に保存済みキーを Bearer で送らせる」経路になる（CSRF成立）。
 * 一致しないときはエラーにせず**キー無しで問い合わせる**（キー不要なローカルサーバーが主用途のため）。
 */
import { modelSlot, sameBaseUrl, type ModelSlotName } from '../../domain/model-settings/model-settings';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ModelCatalogPort, ModelCatalogProvider } from './model-catalog';
import type { SecretCipherPort } from './secret-cipher';

export interface ListOpenAiCompatibleModelsInput {
  readonly scope: TenantScope;
  readonly baseUrl: string;
  /** 指定時は、そのスロットに保存済みのAPIキーを（宛先が一致する場合だけ）使って問い合わせる。 */
  readonly slot?: ModelSlotName;
}

export interface OpenAiCompatibleModelsResult {
  readonly models: readonly string[];
  /** 保存済みキーを実際に使ったか（宛先不一致で使わなかったことをUIへ伝える）。 */
  readonly usedStoredKey: boolean;
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

  async openAiCompatibleModels(input: ListOpenAiCompatibleModelsInput, signal?: AbortSignal): Promise<OpenAiCompatibleModelsResult> {
    const apiKey = input.slot === undefined ? undefined : await this.storedKeyFor(input.scope, input.slot, input.baseUrl);
    const models = await this.catalog.listOpenAiCompatibleModels(input.baseUrl, apiKey, signal);
    return { models, usedStoredKey: apiKey !== undefined };
  }

  /** 保存済みスロットが同じ OpenAI互換エンドポイント宛のときだけキーを開封する。 */
  private async storedKeyFor(scope: TenantScope, slot: ModelSlotName, baseUrl: string): Promise<string | undefined> {
    const settings = modelSlot(await this.repo.find(scope), slot);
    if (settings === undefined || settings.source !== 'openai-compatible' || settings.apiKey === undefined) return undefined;
    if (!sameBaseUrl(settings.baseUrl, baseUrl)) return undefined;
    return this.cipher.open(settings.apiKey);
  }
}

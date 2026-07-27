/**
 * application層: モデル設定（main / judge）の参照・保存。
 *
 * **秘密の扱いが本ユースケースの主題**である。
 * - 参照（Get）は必ずマスク済みDTOを返す。SealedSecret そのものも返さない
 *   （`{ configured, hint }` だけ。hint は平文末尾4文字で、復号せずに出せる）。
 * - 保存（Save）の apiKey は write-only の平文入力:
 *     文字列 → 封緘して保存 / undefined → 既存のキーを維持 / 空文字（または null）→ クリア。
 *   平文は seal() へ渡す一時変数としてのみ存在し、戻り値にも記録にも現れない。
 */
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import {
  createModelSettings,
  createModelSlotSettings,
  sameModelDestination,
  type ModelSettings,
  type ModelSettingsSource,
  type ModelSlotSettings,
} from '../../domain/model-settings/model-settings';
import type { SealedSecret } from '../../domain/model-settings/sealed-secret';
import type { TenantScope } from '../../domain/tool/ids';
import type { SecretCipherPort } from './secret-cipher';

/** APIキーのマスク表現。平文も封緘済みデータもUIへは渡さない。 */
export interface MaskedApiKeyView {
  readonly configured: boolean;
  /** 平文末尾4文字（設定済みのときだけ）。 */
  readonly hint?: string;
}

export type ModelSlotSettingsView =
  | { readonly source: 'registry'; readonly model: string; readonly apiKey: MaskedApiKeyView }
  | { readonly source: 'openai-compatible'; readonly baseUrl: string; readonly model: string; readonly apiKey: MaskedApiKeyView };

/**
 * 設定の保存先が永続か揮発か。
 * `ephemeral` は `AGENTCONTEXT_DB_PATH` 未指定（= `:memory:`）の運用で、
 * プロセスを落とすと設定が消える。UIが警告を出せるように返す。
 */
export type ModelSettingsStorageKind = 'persistent' | 'ephemeral';

export interface ModelSettingsView {
  readonly scope: TenantScope;
  /** 未設定のスロットは省略される（= env 既定を使う）。 */
  readonly main?: ModelSlotSettingsView;
  readonly judge?: ModelSlotSettingsView;
  readonly updatedAt?: string;
  /** 参照（Get）時のみ付く。 */
  readonly storage?: ModelSettingsStorageKind;
}

/** 保存入力。apiKey は write-only の平文。 */
export interface ModelSlotSettingsInput {
  readonly source: ModelSettingsSource;
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey?: string | null;
}

export interface SaveModelSettingsInput {
  readonly scope: TenantScope;
  /** undefined = 変更しない / null = 設定を消して env 既定へ戻す。 */
  readonly main?: ModelSlotSettingsInput | null;
  readonly judge?: ModelSlotSettingsInput | null;
}

function maskedKey(apiKey: SealedSecret | undefined): MaskedApiKeyView {
  if (apiKey === undefined) return { configured: false };
  return { configured: true, ...(apiKey.hint === '' ? {} : { hint: apiKey.hint }) };
}

function toSlotView(slot: ModelSlotSettings): ModelSlotSettingsView {
  return slot.source === 'registry'
    ? { source: 'registry', model: slot.model, apiKey: maskedKey(slot.apiKey) }
    : { source: 'openai-compatible', baseUrl: slot.baseUrl, model: slot.model, apiKey: maskedKey(slot.apiKey) };
}

/** 保存済み設定をマスク済みDTOへ写す。未保存（null）はスコープだけを返す。 */
export function toModelSettingsView(scope: TenantScope, settings: ModelSettings | null): ModelSettingsView {
  if (settings === null) return { scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId } };
  return {
    scope: { tenantId: settings.scope.tenantId, workspaceId: settings.scope.workspaceId },
    ...(settings.main === undefined ? {} : { main: toSlotView(settings.main) }),
    ...(settings.judge === undefined ? {} : { judge: toSlotView(settings.judge) }),
    updatedAt: settings.updatedAt,
  };
}

export class GetModelSettingsUseCase {
  constructor(
    private readonly repo: ModelSettingsRepository,
    /** 配線側（composition root）が決める保存先の性質。 */
    private readonly storage: ModelSettingsStorageKind = 'persistent',
  ) {}

  async execute(scope: TenantScope): Promise<ModelSettingsView> {
    return { ...toModelSettingsView(scope, await this.repo.find(scope)), storage: this.storage };
  }
}

export class SaveModelSettingsUseCase {
  constructor(
    private readonly repo: ModelSettingsRepository,
    private readonly cipher: SecretCipherPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveModelSettingsInput): Promise<ModelSettingsView> {
    const existing = await this.repo.find(input.scope);
    // 両スロット未指定は no-op。保存すると updatedAt だけが進み、未保存なら空行が生まれる。
    if (input.main === undefined && input.judge === undefined) return toModelSettingsView(input.scope, existing);
    const main = await this.resolveSlot(input.main, existing?.main);
    const judge = await this.resolveSlot(input.judge, existing?.judge);
    const settings = createModelSettings({
      scope: input.scope,
      ...(main === undefined ? {} : { main }),
      ...(judge === undefined ? {} : { judge }),
      updatedAt: this.now().toISOString(),
    });
    await this.repo.save(settings);
    return toModelSettingsView(input.scope, settings);
  }

  private async resolveSlot(
    input: ModelSlotSettingsInput | null | undefined,
    existing: ModelSlotSettings | undefined,
  ): Promise<ModelSlotSettings | undefined> {
    if (input === undefined) return existing;
    if (input === null) return undefined;
    // 宛先（provider / エンドポイント）が変わったなら既存キーは継承しない。
    // 継承すると LM Studio 用のダミーキーが OpenAI へ送られる等、キーが意図しない宛先へ渡る。
    const inheritable = existing !== undefined && sameModelDestination(existing, input);
    const apiKey = await this.resolveKey(input.apiKey, inheritable ? existing.apiKey : undefined);
    const base = input.source === 'registry'
      ? { source: 'registry', model: input.model }
      : { source: 'openai-compatible', baseUrl: input.baseUrl, model: input.model };
    return createModelSlotSettings({ ...base, ...(apiKey === undefined ? {} : { apiKey }) });
  }

  /** 文字列 → 封緘 / undefined → 既存維持（同一宛先のときだけ） / 空・null → クリア。 */
  private async resolveKey(value: string | null | undefined, existing: SealedSecret | undefined): Promise<SealedSecret | undefined> {
    if (value === undefined) return existing;
    if (value === null || value.trim() === '') return undefined;
    return this.cipher.seal(value);
  }
}

/**
 * application層: リクエスト毎に保存済みモデル設定を反映する ModelProviderPort。
 *
 * 起動時にenvで固定していたモデル配線を「呼び出しのたびに設定を見る」形へ置き換える。
 * 設定が保存されていないスロットは env 既定（envDefault）にフォールバックするため、
 * 一度も保存していない環境では従来と等価に動く。
 *
 * 解決フロー（complete 毎）:
 *   repo.find(scope) → 該当スロット設定（無ければ envDefault）→ 平文キーを開封 →
 *   ResolvedSlotOptions を作り sha256 でハッシュ → 前回と同じなら生成済みアダプタを再利用 →
 *   異なれば factory.create で作り直す。
 *
 * 秘密の扱い: 平文APIキーは「開封 → 工場へ渡す」までの一時変数としてのみ存在する。
 * 設定の同一性判定には平文込みのハッシュを使うが、**残るのはハッシュ値だけ**である
 * （キー差し替えを検知するために必要で、ハッシュから平文は復元できない）。
 */
import { createHash } from 'node:crypto';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import { modelSlot, type ModelSlotName, type ModelSlotSettings } from '../../domain/model-settings/model-settings';
import type { TenantScope } from '../../domain/tool/ids';
import { ModelProviderError, type ModelCapability, type ModelCompletion, type ModelCompletionRequest, type ModelProviderPort } from '../model/model-provider';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from './model-provider-factory';
import { SecretCipherError, type SecretCipherPort } from './secret-cipher';

/** 実験・Run記録へ残すモデル指紋。apiKey はハッシュにのみ寄与する。 */
export interface ModelSlotSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly modelConfigHash: string;
  readonly sourceRevision?: string;
}

export interface SwitchableModelProviderOptions {
  /** 記録に残すソース版（env AGENTCONTEXT_SOURCE_REVISION 相当）。 */
  readonly sourceRevision?: string;
}

interface ResolvedAdapter {
  readonly hash: string;
  readonly provider: ModelProviderPort;
  readonly snapshot: ModelSlotSnapshot;
}

/** 設定→工場入力の写像。`local/` 等のベンダー規約は工場（adapters）側の責務。 */
export function toResolvedSlotOptions(slot: ModelSlotSettings, apiKey: string | undefined): ResolvedSlotOptions {
  if (slot.source === 'registry') {
    return { model: apiKey === undefined ? slot.model : { id: slot.model, apiKey } };
  }
  return { model: { id: slot.model, url: slot.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) } };
}

function snapshotOf(options: ResolvedSlotOptions, hash: string, sourceRevision: string | undefined): ModelSlotSnapshot {
  const revision = sourceRevision === undefined ? {} : { sourceRevision };
  if (typeof options.model === 'string') {
    const slash = options.model.indexOf('/');
    const provider = slash > 0 ? options.model.slice(0, slash) : 'unknown';
    return { provider, model: slash > 0 ? options.model.slice(slash + 1) : options.model, modelConfigHash: hash, ...revision };
  }
  // カスタムエンドポイントは登録簿の外なので、プロバイダ名は接続方式そのものを表す。
  if (options.model.url !== undefined) return { provider: 'openai-compatible', model: options.model.id, modelConfigHash: hash, ...revision };
  const slash = options.model.id.indexOf('/');
  const provider = slash > 0 ? options.model.id.slice(0, slash) : 'unknown';
  return { provider, model: slash > 0 ? options.model.id.slice(slash + 1) : options.model.id, modelConfigHash: hash, ...revision };
}

/** 設定の同一性を表すハッシュ。平文キーも入力に含める（差し替えを検知するため）。 */
function hashOptions(options: ResolvedSlotOptions): string {
  const model = typeof options.model === 'string'
    ? { id: options.model }
    : { id: options.model.id, url: options.model.url ?? null, apiKey: options.model.apiKey ?? null };
  return createHash('sha256').update(JSON.stringify({
    model,
    capabilities: options.capabilities ?? null,
    timeoutMs: options.timeoutMs ?? null,
    idleTimeoutMs: options.idleTimeoutMs ?? null,
    maxTokens: options.maxTokens ?? null,
  })).digest('hex');
}

export class SwitchableModelProvider implements ModelProviderPort {
  /**
   * 直近に解決したアダプタ。初期値は envDefault から作る。
   * capabilities() は同期契約のため、この「最後に解決したアダプタ（初回は envDefault 由来）」の
   * 能力を返す。設定を保存した直後の1回だけ、次の complete() までは旧設定の能力が見える。
   */
  private current: ResolvedAdapter;

  constructor(
    private readonly repo: ModelSettingsRepository,
    private readonly cipher: SecretCipherPort,
    private readonly factory: ModelProviderFactoryPort,
    private readonly slot: ModelSlotName,
    private readonly envDefault: ResolvedSlotOptions,
    private readonly scope: TenantScope,
    private readonly options: SwitchableModelProviderOptions = {},
  ) {
    this.current = this.build(envDefault);
  }

  async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    const resolved = await this.resolve();
    return resolved.provider.complete(request, signal);
  }

  capabilities(): readonly ModelCapability[] {
    return this.current.provider.capabilities();
  }

  /** 実行時点の設定で解決した指紋。観測・実験の再現性記録に使う。 */
  async currentSnapshot(): Promise<ModelSlotSnapshot> {
    return (await this.resolve()).snapshot;
  }

  /**
   * 直近に解決済みの指紋（同期）。complete() 直後に呼べば「その呼び出しで使った設定」を指す。
   * まだ一度も complete() していない場合は envDefault の指紋。
   */
  lastSnapshot(): ModelSlotSnapshot {
    return this.current.snapshot;
  }

  private async resolve(): Promise<ResolvedAdapter> {
    const options = await this.resolveOptions();
    const hash = hashOptions(options);
    if (hash === this.current.hash) return this.current;
    this.current = this.build(options, hash);
    return this.current;
  }

  private async resolveOptions(): Promise<ResolvedSlotOptions> {
    let slot: ModelSlotSettings | undefined;
    try {
      slot = modelSlot(await this.repo.find(this.scope), this.slot);
    } catch (error) {
      throw new ModelProviderError(`Failed to load model settings for slot '${this.slot}'`, error);
    }
    if (slot === undefined) return this.envDefault;
    // 開封失敗（鍵ファイル差し替え等）は握りつぶさない。env既定へ黙って落ちると
    // 「保存したはずの設定と違うモデルが動く」ことになるため、再入力を促して失敗させる。
    const apiKey = slot.apiKey === undefined ? undefined : await this.openKey(slot.apiKey);
    return toResolvedSlotOptions(slot, apiKey);
  }

  private async openKey(sealed: NonNullable<ModelSlotSettings['apiKey']>): Promise<string> {
    try { return await this.cipher.open(sealed); }
    catch (error) {
      if (error instanceof SecretCipherError) throw error;
      throw new SecretCipherError(`Stored API key for model slot '${this.slot}' could not be decrypted. Save the API key again.`, error);
    }
  }

  private build(options: ResolvedSlotOptions, hash = hashOptions(options)): ResolvedAdapter {
    return { hash, provider: this.factory.create(options), snapshot: snapshotOf(options, hash, this.options.sourceRevision) };
  }
}

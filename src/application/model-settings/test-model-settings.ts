/**
 * application層: モデル設定の疎通テスト（候補設定 or 保存済み設定）。
 *
 * 「設定が正しいか」をUIから確かめるための機能なので、**失敗は例外にせず結果として返す**
 * （TestMcpServerUseCase と同じ流儀）。応答は短時間・小トークンに固定し、
 * 誤ってUIから長い推論を走らせない。
 *
 * 秘密の扱い: 候補にキーが無ければ保存済みキーを開封して使う（UIでキーを再入力させない）。
 * ただし**流用するのは宛先が一致するときだけ**である。candidate は baseUrl / provider を自由に
 * 指定できるため、宛先を見ずに流用すると「保存済みキーを任意の宛先へ送らせる」経路になる。
 * 不一致ならキー無しで試し、`usedStoredKey: false` で「保存済みキーは使っていない」と伝える。
 * 平文は工場へ渡す一時変数としてのみ存在し、**エラー文言へ混ざり込まないよう伏せ字化する**。
 *
 * 入力そのものが不正（http以外のURL等）なら**例外のまま投げる**（api で 400）。
 * `ok:false` は「設定は形として妥当だが繋がらなかった」だけを意味する。
 */
import { createModelSlotSettings, modelSlot, sameModelDestination, type ModelSlotName, type ModelSlotSettings } from '../../domain/model-settings/model-settings';
import { ModelSettingsValidationError } from '../../domain/model-settings/errors';
import type { ModelSettingsRepository } from '../../domain/model-settings/model-settings-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from './model-provider-factory';
import type { ModelSlotSettingsInput } from './manage-model-settings';
import type { SecretCipherPort } from './secret-cipher';
import { toResolvedSlotOptions } from './switchable-model-provider';

/** ヘルスチェックの上限。UIの待ち時間として許容できる範囲に固定する。 */
export const MODEL_TEST_TIMEOUT_MS = 15_000;
/** 応答は「ok」だけを期待するので出力上限も小さくする。 */
export const MODEL_TEST_MAX_TOKENS = 32;
const MAX_REPLY_CHARS = 64;
const MAX_ERROR_CHARS = 300;

export interface TestModelSettingsInput {
  readonly scope: TenantScope;
  readonly slot: ModelSlotName;
  /** 未保存の候補設定。省略時は保存済み設定（無ければ env 既定）を使う。 */
  readonly candidate?: ModelSlotSettingsInput;
}

export type ModelSettingsTestResult =
  | { readonly ok: true; readonly latencyMs: number; readonly reply: string; readonly usedStoredKey: boolean }
  | { readonly ok: false; readonly error: string; readonly usedStoredKey: boolean };

/** 解決済みの試行設定と「保存済みキーを流用したか」。 */
interface ResolvedProbe {
  readonly options: ResolvedSlotOptions;
  readonly usedStoredKey: boolean;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 第一防御は「秘密をメッセージに入れないこと」。これは取りこぼした場合の第二防御。 */
function redact(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('***');
  }
  return redacted;
}

export class TestModelSettingsUseCase {
  constructor(
    private readonly repo: ModelSettingsRepository,
    private readonly cipher: SecretCipherPort,
    private readonly factory: ModelProviderFactoryPort,
    /** env 既定（設定未保存のスロットで使う配線と同じもの）。 */
    private readonly envDefault?: (slot: ModelSlotName) => ResolvedSlotOptions | undefined,
    private readonly monotonicNow: () => number = () => Date.now(),
  ) {}

  async execute(input: TestModelSettingsInput, signal?: AbortSignal): Promise<ModelSettingsTestResult> {
    let plaintextKey: string | undefined;
    let usedStoredKey = false;
    try {
      const resolved = await this.resolveOptions(input);
      usedStoredKey = resolved.usedStoredKey;
      plaintextKey = typeof resolved.options.model === 'string' ? undefined : resolved.options.model.apiKey;
      return { ...await this.probe(resolved.options, signal), usedStoredKey };
    } catch (error) {
      // 入力の不変条件違反は疎通の失敗ではないので、そのまま api へ返して 400 にする。
      if (error instanceof ModelSettingsValidationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: redact(clip(message === '' ? 'model test failed' : message, MAX_ERROR_CHARS), plaintextKey === undefined ? [] : [plaintextKey]), usedStoredKey };
    }
  }

  private async resolveOptions(input: TestModelSettingsInput): Promise<ResolvedProbe> {
    const stored = modelSlot(await this.repo.find(input.scope), input.slot);
    if (input.candidate === undefined) {
      if (stored === undefined) {
        const fallback = this.envDefault?.(input.slot);
        if (fallback === undefined) throw new Error(`Model settings are not configured for slot '${input.slot}'`);
        return { options: fallback, usedStoredKey: false };
      }
      return {
        options: toResolvedSlotOptions(stored, stored.apiKey === undefined ? undefined : await this.cipher.open(stored.apiKey)),
        usedStoredKey: stored.apiKey !== undefined,
      };
    }
    // 候補のキーは write-only 入力と同じ規約: 未指定なら保存済みキーを流用、空文字ならキー無し。
    // ただし流用は宛先一致時に限る（不一致ならキー無しで試す）。
    const candidate = this.toSlot(input.candidate);
    const key = input.candidate.apiKey;
    if (key !== undefined) {
      return { options: toResolvedSlotOptions(candidate, key === null || key.trim() === '' ? undefined : key), usedStoredKey: false };
    }
    const inheritable = stored !== undefined && stored.apiKey !== undefined && sameModelDestination(stored, input.candidate);
    const plaintext = inheritable && stored.apiKey !== undefined ? await this.cipher.open(stored.apiKey) : undefined;
    return { options: toResolvedSlotOptions(candidate, plaintext), usedStoredKey: plaintext !== undefined };
  }

  /** 候補設定はドメイン検証を通す（キーは含めない。ここでは形だけを見る）。 */
  private toSlot(candidate: ModelSlotSettingsInput): ModelSlotSettings {
    return createModelSlotSettings(
      candidate.source === 'registry'
        ? { source: 'registry', model: candidate.model }
        : { source: 'openai-compatible', baseUrl: candidate.baseUrl, model: candidate.model },
      'candidate',
    );
  }

  private async probe(options: ResolvedSlotOptions, signal?: AbortSignal): Promise<{ readonly ok: true; readonly latencyMs: number; readonly reply: string }> {
    const provider = this.factory.create({
      ...options,
      timeoutMs: MODEL_TEST_TIMEOUT_MS,
      idleTimeoutMs: MODEL_TEST_TIMEOUT_MS,
      maxTokens: MODEL_TEST_MAX_TOKENS,
    });
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MODEL_TEST_TIMEOUT_MS);
    const started = this.monotonicNow();
    try {
      const completion = await provider.complete({
        messages: [
          { role: 'system', content: 'Health check' },
          { role: 'user', content: 'Reply with exactly: ok' },
        ],
        temperature: 0,
      }, controller.signal);
      return { ok: true, latencyMs: Math.max(0, this.monotonicNow() - started), reply: clip(completion.message.content ?? '', MAX_REPLY_CHARS) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

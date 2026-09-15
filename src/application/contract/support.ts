/**
 * application層: 契約のユースケースが共有する小道具（時計・id・モデルの可否）。
 *
 * - 「今日」はサーバーのローカル日付（`current_datetime` ツールと同じ基準。docs/23 §5.1）。
 * - モデルの可否は仕訳と同じく「main スロットが設定済みか」+「能力」で見る。設定は UI から変わるので毎回尋ねる。
 */
import type { ModelProviderPort } from '../model/model-provider';
import { ContractExtractionUnavailableError } from './errors';

export type Clock = () => Date;
export type IdGenerator = () => string;

export const systemClock: Clock = () => new Date();
export const randomId: IdGenerator = () => globalThis.crypto.randomUUID();

/** ローカル日付の `YYYY-MM-DD`。 */
export function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export type ModelSnapshotReader = () => Promise<{ readonly provider: string; readonly model: string } | undefined>;

/** LLM を回してよいか（設定の有無と能力）。 */
export class ContractModelGate {
  constructor(
    readonly model: ModelProviderPort,
    private readonly enabled: () => boolean | Promise<boolean>,
    private readonly snapshotReader?: ModelSnapshotReader,
  ) {}

  async structuredAvailable(): Promise<boolean> {
    return await this.enabled() && this.model.capabilities().includes('structured-output');
  }

  /** 条項抽出・LLM 基準の前提。足りなければ何が足りず設定のどこで直すかを書いた 409。 */
  async assertStructured(feature: string): Promise<void> {
    if (!await this.enabled()) throw new ContractExtractionUnavailableError(`${feature} needs a model: set the main model slot in Settings > Models, then reload the page`);
    if (!this.model.capabilities().includes('structured-output')) throw new ContractExtractionUnavailableError(`${feature} needs a model with structured output; the model in the main slot does not support it (Settings > Models)`);
  }

  /** 文字起こしの前提（vision だけでよい。応答は素のテキストで受ける）。 */
  async assertVision(): Promise<void> {
    if (!await this.enabled()) throw new ContractExtractionUnavailableError('transcribing contract pages needs a model: set the main model slot in Settings > Models, then reload the page');
    if (!this.model.capabilities().includes('vision')) throw new ContractExtractionUnavailableError('transcribing contract pages needs a vision model; the model in the main slot cannot read images (Settings > Models). Paste the text of the contract instead, or switch the main model slot to one that supports vision');
  }

  /** 表示と LLM 回答の再利用キーに使う指紋。取れなければ undefined（抽出は続ける）。 */
  async snapshot(): Promise<{ readonly provider: string; readonly model: string } | undefined> {
    if (this.snapshotReader === undefined) return undefined;
    try {
      const snapshot = await this.snapshotReader();
      return snapshot === undefined ? undefined : { provider: snapshot.provider, model: snapshot.model };
    } catch {
      return undefined;
    }
  }
}

/** 中断か（中断は束の失敗として握り潰さずに投げ直す）。 */
export function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)));
}

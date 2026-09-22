/**
 * LM Studio が載せているモデルの文脈の長さを問い合わせる（v49 §4）。
 *
 * OpenAI 互換の `/v1` には無い情報なので、LM Studio 固有の `/api/v0/models/<id>` を best-effort で読む。
 * `LmStudioModelProvider` と、実運用の経路である Mastra の OpenAI 互換プロバイダ（`baseUrl` が LM Studio を
 * 指しているとき）の両方が同じ問い合わせを使う。取れないこと自体は**正常系**（LM Studio 以外・古い版・停止中）
 * なので、例外にも警告にもしない。使い道は画面の消費比率だけで、取れなければトークン数だけを出す。
 */
import { z } from 'zod';

/** 未知のキーは無視する（LM Studio の REST API は版ごとに項目が増える）。 */
const modelInfoSchema = z.object({
  loaded_context_length: z.unknown().optional(),
  max_context_length: z.unknown().optional(),
});

/** 文脈の長さを問い合わせる上限（ms）。設計アシスタントの 1 ターンを待たせるための値ではない。 */
export const CONTEXT_WINDOW_TIMEOUT_MS = 3_000;
/** 同じ答えを何度も取りに行かないための保持時間（ms）。モデルの載せ替えは秒単位では起きない。 */
export const CONTEXT_WINDOW_TTL_MS = 60_000;

/** 正の整数だけを文脈の長さとして採る（0・負・小数・非数は「取れなかった」と同じ）。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * `…/v1` で終わる baseUrl から LM Studio のモデル情報の URL を組む。`/v1` で終わらなければ LM Studio ではない
 * （または経路が違う）ので undefined。モデル id は `google/gemma-4-12b` のように `/` を含むので 1 つのパス要素へ符号化する。
 */
export function lmStudioModelInfoEndpoint(baseUrl: string, model: string): string | undefined {
  const base = baseUrl.replace(/\/$/, '');
  if (!base.endsWith('/v1') || model.trim() === '') return undefined;
  return `${base.slice(0, -'/v1'.length)}/api/v0/models/${encodeURIComponent(model)}`;
}

export interface ContextWindowProbeOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/** 1 回分の問い合わせ。3 秒で諦める（比率の表示のために 1 ターンを待たせない）。 */
export async function readLmStudioContextWindow(options: ContextWindowProbeOptions): Promise<number | undefined> {
  const endpoint = lmStudioModelInfoEndpoint(options.baseUrl, options.model);
  if (endpoint === undefined) return undefined;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_WINDOW_TIMEOUT_MS);
  try {
    const response = await fetcher(endpoint, {
      method: 'GET',
      headers: { ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const info = modelInfoSchema.safeParse(await response.json());
    if (!info.success) return undefined;
    // 載せたときの実際の長さ（`loaded_context_length`）が正。無い・非数なら宣言上の上限で代える。
    return positiveInteger(info.data.loaded_context_length) ?? positiveInteger(info.data.max_context_length);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 成否とも 60 秒保持する問い合わせ（プロバイダのインスタンスごとに 1 つ持つ）。 */
export class ContextWindowProbe {
  private cached: { readonly at: number; readonly value: number | undefined } | undefined;

  constructor(private readonly options: ContextWindowProbeOptions) {}

  async read(): Promise<number | undefined> {
    const now = this.options.now ?? Date.now;
    if (this.cached !== undefined && now() - this.cached.at < CONTEXT_WINDOW_TTL_MS) return this.cached.value;
    const value = await readLmStudioContextWindow(this.options);
    this.cached = { at: now(), value };
    return value;
  }
}
